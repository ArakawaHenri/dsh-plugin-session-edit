// Self-contained so the ModuleLoader build can inline it without Node modules.
export function createClientController(options) {
  const { rpc, navigate, getLocale } = options;
  const listeners = new Set();
  const drafts = new Map();
  const reads = new Map();
  const inFlight = new Map();
  let disposed = false;
  let revision = 0;
  let sequence = 0;
  let panelEpoch = 0;
  let snapshot = { revision, panel: null, sessions: {}, notice: null };

  function publish(patch) {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch, revision: ++revision };
    for (const listener of listeners) listener();
  }

  function updatePanel(patch, epoch = panelEpoch) {
    if (!disposed && epoch === panelEpoch && snapshot.panel) {
      publish({ panel: { ...snapshot.panel, ...patch } });
    }
  }

  const errorOf = error => ({
    code: typeof error?.code === 'string' ? error.code : 'session-edit/transport',
    message: typeof error?.message === 'string' ? error.message : String(error || 'Request failed'),
  });

  async function call(method, request) {
    let reply;
    try {
      reply = await rpc[method](request);
    } catch (error) {
      if (error?.name === 'RemoteError' || error?.rpcError) {
        throw errorOf(error.rpcError || error);
      }
      throw errorOf(error);
    }
    if (!reply || typeof reply.ok !== 'boolean') {
      throw { code: 'session-edit/transport', message: 'Invalid RPC response' };
    }
    if (!reply.ok) throw errorOf(reply.error);
    return reply.value;
  }

  const actionKey = (sessionId, action, target) =>
    JSON.stringify([sessionId, action, action === 'continue' ? null : target]);
  const draftKey = (sessionId, eventSeq) => JSON.stringify([sessionId, eventSeq]);

  function oneShot(key, work) {
    if (inFlight.has(key)) return inFlight.get(key);
    const task = Promise.resolve()
      .then(work)
      .finally(() => {
        inFlight.delete(key);
        publish({});
      });
    inFlight.set(key, task);
    publish({});
    return task;
  }

  function newPanel(sessionId, properties) {
    ++panelEpoch;
    publish({
      panel: {
        sessionId,
        title: '',
        view: 'history',
        busy: false,
        loading: false,
        error: null,
        messages: [],
        nextBeforeSeq: null,
        ...properties,
      },
    });
    return panelEpoch;
  }

  function close() {
    ++panelEpoch;
    publish({ panel: null });
  }

  async function openResult(result, guardEpoch = panelEpoch) {
    const id = result?.childSessionId || result?.sourceSessionId;
    if (!id) return;
    if (guardEpoch !== panelEpoch) {
      // Panel churn since this action started. A foreign panel must never be
      // closed or navigated under; a user-closed panel means lost interest.
      if (snapshot.panel) {
        publish({
          notice: {
            code: 'session-edit/navigation-failed',
            message: 'A dialog is open',
            sessionId: id,
          },
        });
      }
      return;
    }
    if (snapshot.panel) close();
    try {
      await navigate(id);
    } catch (error) {
      publish({
        notice: {
          code: 'session-edit/navigation-failed',
          message: errorOf(error).message,
          sessionId: id,
        },
      });
    }
  }

  const MAX_CACHED_SESSIONS = 32;

  function setSessionEntry(sessionId, entry) {
    const next = { ...snapshot.sessions, [sessionId]: entry };
    const keys = Object.keys(next);
    if (keys.length > MAX_CACHED_SESSIONS) {
      for (const key of keys) {
        if (key !== sessionId && !next[key]?.loading) {
          delete next[key];
          if (Object.keys(next).length <= MAX_CACHED_SESSIONS) break;
        }
      }
    }
    publish({ sessions: next });
  }

  async function loadSession(sessionId, force = false) {
    if (disposed) return;
    if (!force && reads.has(sessionId)) return reads.get(sessionId);
    const loadId = ++sequence;
    const current = snapshot.sessions[sessionId];
    setSessionEntry(sessionId, { ...current, loading: true, loadId, error: null });
    const task = (async () => {
      try {
        const value = await call('inspect', { sessionId, limit: 30 });
        if (!disposed && snapshot.sessions[sessionId]?.loadId === loadId) {
          setSessionEntry(sessionId, { value, loading: false, error: null, loadId });
        }
        return value;
      } catch (error) {
        if (!disposed && snapshot.sessions[sessionId]?.loadId === loadId) {
          setSessionEntry(sessionId, { ...current, loading: false, loadId, error: errorOf(error) });
        }
        throw error;
      } finally {
        if (reads.get(sessionId) === task) reads.delete(sessionId);
      }
    })();
    reads.set(sessionId, task);
    return task;
  }

  async function openHistory(sessionId, title = '') {
    const epoch = newPanel(sessionId, { title, loading: true });
    try {
      const value = await loadSession(sessionId, true);
      if (value) {
        updatePanel(
          {
            loading: false,
            title: value.title || title,
            messages: value.messages,
            nextBeforeSeq: value.nextBeforeSeq,
          },
          epoch,
        );
      }
    } catch (error) {
      updatePanel({ loading: false, error: errorOf(error) }, epoch);
    }
  }

  async function loadOlder() {
    const current = snapshot.panel;
    if (!current || current.loading || current.nextBeforeSeq === null) return;
    const epoch = panelEpoch;
    updatePanel({ loading: true, error: null });
    try {
      const value = await call('inspect', {
        sessionId: current.sessionId,
        beforeSeq: current.nextBeforeSeq,
        limit: 30,
      });
      const map = new Map(
        [...value.messages, ...current.messages].map(message => [message.eventSeq, message]),
      );
      updatePanel(
        {
          loading: false,
          messages: [...map.values()].sort((a, b) => a.eventSeq - b.eventSeq),
          nextBeforeSeq: value.nextBeforeSeq,
        },
        epoch,
      );
    } catch (error) {
      updatePanel({ loading: false, error: errorOf(error) }, epoch);
    }
  }

  async function resolveTarget(target) {
    if (target.messageId && target.editable !== false) return target;
    const value = await call('inspect', {
      sessionId: target.sessionId,
      eventSeq: target.eventSeq,
    });
    const message = value.messages.find(item => item.eventSeq === target.eventSeq);
    if (!message?.messageId || !message.editable) {
      throw {
        code: `session-edit/${message?.reason || 'message-not-editable'}`,
        message: message?.reason || 'Select an editable user message',
      };
    }
    return { ...target, ...message, title: value.title || target.title };
  }

  async function openEdit(target) {
    const key = draftKey(target.sessionId, target.eventSeq);
    const prior = snapshot.panel;
    const historyState =
      prior?.view === 'history' && prior.sessionId === target.sessionId
        ? {
            title: prior.title,
            messages: prior.messages,
            nextBeforeSeq: prior.nextBeforeSeq,
          }
        : null;
    const epoch = newPanel(target.sessionId, {
      title: target.title || prior?.title || '',
      view: 'editor',
      eventSeq: target.eventSeq,
      text: drafts.get(key) ?? target.text ?? '',
      loading: true,
      historyState,
    });
    try {
      const message = await resolveTarget(target);
      updatePanel(
        {
          messageId: message.messageId,
          text: drafts.get(key) ?? message.text,
          loading: false,
          title: message.title || target.title || '',
        },
        epoch,
      );
    } catch (error) {
      updatePanel({ loading: false, error: errorOf(error) }, epoch);
    }
  }

  function backToHistory() {
    const current = snapshot.panel;
    if (!current || current.busy || current.view !== 'editor' || !current.historyState) return;
    newPanel(current.sessionId, {
      title: current.historyState.title || current.title,
      view: 'history',
      messages: current.historyState.messages,
      nextBeforeSeq: current.historyState.nextBeforeSeq,
      loading: false,
    });
  }

  function setText(text) {
    const current = snapshot.panel;
    if (!current || current.busy || current.view !== 'editor') return;
    drafts.set(draftKey(current.sessionId, current.eventSeq), text);
    updatePanel({ text, error: null });
  }

  function submitEdit() {
    const current = snapshot.panel;
    if (
      !current ||
      current.view !== 'editor' ||
      current.busy ||
      current.loading ||
      !current.messageId ||
      !current.text?.trim()
    ) {
      return;
    }
    const key = actionKey(current.sessionId, 'edit-fork', current.eventSeq);
    if (inFlight.has(key)) return inFlight.get(key);
    const epoch = panelEpoch;
    updatePanel({ busy: true, error: null });
    return oneShot(key, async () => {
      try {
        const result = await call('execute', {
          sessionId: current.sessionId,
          action: 'edit-fork',
          eventSeq: current.eventSeq,
          messageId: current.messageId,
          replacementText: current.text,
        });
        drafts.delete(draftKey(current.sessionId, current.eventSeq));
        if (disposed) return;
        await openResult(result, epoch);
      } catch (error) {
        updatePanel({ busy: false, error: errorOf(error) }, epoch);
      }
    });
  }

  function reportActionError(sessionId, epoch, error) {
    const normalized = errorOf(error);
    if (!disposed && epoch === panelEpoch && snapshot.panel?.sessionId === sessionId) {
      updatePanel({ busy: false, loading: false, error: normalized }, epoch);
    } else if (!disposed) {
      publish({ notice: normalized });
    }
  }

  function retryMessage(target) {
    return oneShot(actionKey(target.sessionId, 'retry-fork', target.eventSeq), async () => {
      const epoch = panelEpoch;
      const inPanel = snapshot.panel?.sessionId === target.sessionId;
      if (inPanel) updatePanel({ busy: true, error: null }, epoch);
      try {
        const message = await resolveTarget(target);
        const result = await call('execute', {
          sessionId: target.sessionId,
          action: 'retry-fork',
          eventSeq: message.eventSeq,
          messageId: message.messageId,
        });
        if (disposed) return;
        await openResult(result, epoch);
      } catch (error) {
        reportActionError(target.sessionId, epoch, error);
      }
    });
  }

  function continueSession(sessionId, mode = 'no-message') {
    return oneShot(actionKey(sessionId, 'continue', mode), async () => {
      const epoch = panelEpoch;
      try {
        const cached = snapshot.sessions[sessionId]?.value;
        const facts = cached ?? (await loadSession(sessionId, true));
        if (!facts) return;
        const allowed =
          mode === 'prompt' ? facts.continuation.canSendPrompt : facts.continuation.available;
        if (!allowed) {
          throw {
            code: `session-edit/${facts.continuation.reason || 'not-resumable'}`,
            message: facts.continuation.reason || 'Continuation unavailable',
          };
        }
        const result = await call('execute', {
          sessionId,
          action: 'continue',
          continuationMode: mode,
          ...(mode === 'prompt' && getLocale
            ? { promptLocale: ['en', 'zh'].includes(getLocale()) ? getLocale() : 'zh' }
            : {}),
        });
        if (disposed) return;
        await openResult(result, epoch);
      } catch (error) {
        reportActionError(sessionId, epoch, error);
      }
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadSession,
    openHistory,
    loadOlder,
    openEdit,
    backToHistory,
    retryMessage,
    continueSession,
    setText,
    submitEdit,
    openResult,
    close,
    isBusy: (sessionId, action, target) => inFlight.has(actionKey(sessionId, action, target)),
    clearNotice() {
      publish({ notice: null });
    },
    dispose() {
      disposed = true;
      ++panelEpoch;
      listeners.clear();
      reads.clear();
      drafts.clear();
    },
  };
}
