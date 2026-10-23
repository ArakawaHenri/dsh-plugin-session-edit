// DSH 0.2.1-rc.2 treats an ordinary Session removal as permanent and merges
// projections with higher-seq-wins. A same-ID history rewrite needs a new
// baseline while keeping the retained binding, editor draft and UI subscriptions.
export function createSessionReloader(sessions) {
  const pending = new Map();
  return function reload(sessionId, summary) {
    const existing = pending.get(sessionId);
    if (existing) {
      // A second lifecycle can finish while the first baseline is loading.
      if (summary) { existing.summary = summary; existing.changed = true; }
      return existing.promise;
    }
    const entry = { summary, changed: false };
    entry.promise = Promise.resolve().then(async () => {
      do {
        entry.changed = false;
        const session = sessions.binding(sessionId)?.session;
        if (!session) break;
        const manager = sessions.manager;
        if (typeof session.resync !== 'function' || typeof session.projections?.clear !== 'function' ||
          !manager?.projectionStores) {
          throw new Error('This DSH client cannot reload edited session history.');
        }
        manager.projectionInflight.get(sessionId)?.controller.abort();
        manager.projectionInflight.delete(sessionId);
        manager.projectionLoads.delete(sessionId);
        session.projections.clear();
        // Native removal can drop the manager's store; retain the faces to which
        // this Session and the conversation's hooks already subscribe.
        manager.projectionStores.set(sessionId, session.projections);
        session.removed = false;
        session.promptError = null;
        session.lastAgentError = null;
        if (entry.summary) manager.handleSessionAdded(entry.summary);
        await session.resync();
        if (session.getSnapshot().openState === 'error') throw session.getSnapshot().openError;
      } while (entry.changed);
      await sessions.refresh();
    }).finally(() => pending.delete(sessionId));
    pending.set(sessionId, entry);
    return entry.promise;
  };
}
