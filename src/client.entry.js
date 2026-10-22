// Bundled by scripts/build-client.js into the single-file client.js.
import { remoteContribution } from '../remote.js';
import { createClientController } from './client-controller.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import styles from './client.css';

const dictionaries = { en, zh };
const namespace = 'dsh.sessionEdit';

function prepareContent(content, data = {}) {
  const texts = [];
  const attachments = [];
  const extraBlocks = [];
  for (const block of content || []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'image' && block.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: block.attachment } });
    } else if (block.type === 'file' && block.attachment !== undefined) {
      attachments.push({ type: 'file', file: block.attachment });
    } else {
      extraBlocks.push(block);
    }
  }
  return {
    text: texts.join(''),
    attachments,
    extraBlocks,
    ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
  };
}

function editIcon(h) {
  return h(
    'svg',
    {
      width: 15,
      height: 15,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.25,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', { d: 'M3 11.5V14h2.5L14 5.5 10.5 2 3 9.5M9.5 3l3.5 3.5' }),
  );
}

function clock(time) {
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mountUI(ctx, React) {
  const h = React.createElement;
  ctx.effect(() => ctx.locale.register(namespace, dictionaries));
  const translate = ctx.locale.bind(namespace);
  const controller = createClientController({
    rpc: ctx.remote.sessionEdit,
    navigate: id => ctx.uiWorkspace.openSession(id),
    getLocale: () => ctx.locale.getSnapshot(),
  });
  ctx.effect(() => () => controller.dispose());

  function useTranslation() {
    React.useSyncExternalStore(
      listener => ctx.locale.subscribe(listener),
      () => ctx.locale.getSnapshot(),
    );
    return translate;
  }

  function useState(selector) {
    return React.useSyncExternalStore(
      controller.subscribe,
      selector ? () => selector(controller.getSnapshot()) : controller.getSnapshot,
    );
  }

  function explain(error, t) {
    const code = String(error?.code || error || '').split('/').at(-1);
    const key = `error.${code}`;
    return Object.hasOwn(dictionaries.en, key)
      ? t(key)
      : typeof error === 'string'
        ? error
        : error?.message || t('error.generic');
  }

  function button(label, onClick, options = {}) {
    return h(
      'button',
      {
        type: 'button',
        className: `dsh-se-button${options.primary ? ' dsh-se-primary' : ''}`,
        disabled: options.disabled,
        onClick,
        ...(options.testId ? { 'data-testid': options.testId } : {}),
      },
      label,
    );
  }

  function canExecute(props) {
    return typeof props.useRemoteAccess === 'function'
      ? props.useRemoteAccess('sessionEdit/execute')
      : false;
  }

  function MenuItem(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const [, setOpen] = props.useMenuOpenState();
    if (!allowed) return null;
    return h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-se-menu',
        'data-testid': 'session-edit-menu',
        onClick: event => {
          event.stopPropagation();
          setOpen(false);
          void controller.openHistory(props.sessionId, props.displayTitle || t('untitled'));
        },
      },
      editIcon(h),
      t('menu'),
    );
  }

  function UserMessage(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const data = props.node.data;
    const textOnly =
      Array.isArray(data.content) &&
      data.content.length > 0 &&
      data.content.every(block => block.type === 'text');
    const busyEdit = useState(() =>
      controller.isBusy(props.sessionId, 'edit-fork', data.seq) ? 1 : 0,
    );
    const busyRetry = useState(() =>
      controller.isBusy(props.sessionId, 'retry-fork', data.seq) ? 1 : 0,
    );
    const ordinary = useState(state => state.sessions[props.sessionId]?.value?.ordinary);
    const messageLimit = useState(state => state.sessions[props.sessionId]?.value?.maxTextChars);
    const [copyState, setCopyState] = React.useState(null);
    const copyTimer = React.useRef(null);
    React.useEffect(() => () => clearTimeout(copyTimer.current), []);
    const prepared = React.useMemo(
      () => prepareContent(data.content, data),
      [data.content, data.referenceLabels],
    );
    const facts = React.useMemo(
      () => ({
        ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
        ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
      }),
      [data.referenceLabels, data.skillNames],
    );
    const owned = ordinary === false;
    const tooLong =
      textOnly && typeof messageLimit === 'number' && prepared.text.length > messageLimit;
    const editable =
      data.source?.kind === 'user' &&
      Number.isSafeInteger(data.seq) &&
      data.seq >= 0 &&
      textOnly &&
      !owned &&
      !tooLong;
    const disabledReason = owned
      ? t('error.owned-session')
      : tooLong
        ? t('error.message-too-large')
        : !textOnly
          ? t('plainTextOnly')
          : null;
    const target = {
      sessionId: props.sessionId,
      eventSeq: data.seq,
      messageId: data.messageId,
      text: prepared.text,
    };
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(prepared.text);
        setCopyState('copied');
      } catch {
        setCopyState('copyFailed');
      }
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState(null), 1500);
    };

    return h(
      'div',
      { className: 'dsh-se-row', 'data-session-edit-message': data.seq },
      props.renderFactorySlot('conversation.chat.user.content', {
        content: prepared,
        loadImage: props.loadImage,
        facts,
        interactive: true,
      }),
      h(
        'div',
        { className: 'dsh-se-row-actions' },
        Number.isFinite(data.time) &&
          h('time', { dateTime: new Date(data.time).toISOString() }, clock(data.time)),
        h(
          'button',
          { type: 'button', className: 'dsh-se-action', 'aria-label': t('copy'), onClick: copy },
          t(copyState || 'copy'),
        ),
        allowed &&
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-se-action',
              disabled: !editable || busyEdit,
              title: !editable ? disabledReason : t('editTitle'),
              'aria-label': t('editTitle'),
              onClick: () => void controller.openEdit(target),
            },
            t('edit'),
          ),
        allowed &&
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-se-action',
              disabled: !editable || busyRetry,
              title: !editable ? disabledReason : t('retryTitle'),
              'aria-label': t('retryTitle'),
              onClick: () => void controller.retryMessage(target),
            },
            t('retry'),
          ),
      ),
    );
  }

  function ContinueDock(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const running = props.useSession(snapshot => snapshot.running);
    const openState = props.useSession(snapshot => snapshot.openState);
    const entry = useState(state => state.sessions[props.sessionId]);
    React.useEffect(() => {
      if (allowed && props.sessionId && !running) {
        void controller.loadSession(props.sessionId, true).catch(() => {});
      }
    }, [props.sessionId, allowed, running, openState]);

    if (!allowed || running) return null;
    const facts = entry?.value;
    if (!facts?.ordinary || facts.archived || facts.status === 'running') return null;
    if (!facts.continuation.available && !facts.continuation.canSendPrompt) return null;

    const direct = facts.continuation.available;
    const busy = controller.isBusy(props.sessionId, 'continue');
    return h(
      'div',
      { className: 'dsh-se-dock', 'data-testid': 'session-edit-continue' },
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-se-action',
          disabled: !direct || entry.loading || busy,
          title: direct
            ? t('noMessageDescription')
            : explain(facts.continuation.reason || 'continuation-unsupported', t),
          onClick: () => void controller.continueSession(props.sessionId),
        },
        t('confirmContinue'),
      ),
      facts.continuation.canSendPrompt &&
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-se-action',
            disabled: entry.loading || busy,
            title: t('promptDescription'),
            onClick: () => void controller.continueSession(props.sessionId, 'prompt'),
          },
          t('confirmPrompt'),
        ),
    );
  }

  function History({ current, t }) {
    return h(
      React.Fragment,
      null,
      current.nextBeforeSeq !== null &&
        button(
          t(current.loading ? 'loading' : 'loadOlder'),
          () => void controller.loadOlder(),
          { disabled: current.loading, testId: 'load-older' },
        ),
      !current.loading &&
        !current.messages.length &&
        h('p', { className: 'dsh-se-subtitle' }, t('emptyHistory')),
      h(
        'ol',
        { className: 'dsh-se-message-list' },
        ...current.messages.map(message =>
          h(
            'li',
            {
              key: message.messageId || message.eventSeq,
              className: 'dsh-se-message',
              'data-event-seq': message.eventSeq,
            },
            h(
              'div',
              { className: 'dsh-se-message-meta' },
              h(
                'time',
                { dateTime: new Date(message.time).toISOString() },
                new Date(message.time).toLocaleString(),
              ),
            ),
            h('p', { className: 'dsh-se-message-text' }, message.text),
            !message.editable &&
              h(
                'p',
                { className: 'dsh-se-muted' },
                message.reason ? explain(message.reason, t) : t('plainTextOnly'),
              ),
            h(
              'div',
              { className: 'dsh-se-message-actions' },
              button(
                t('edit'),
                () =>
                  void controller.openEdit({
                    ...message,
                    sessionId: current.sessionId,
                    title: current.title,
                  }),
                {
                  disabled:
                    !message.editable ||
                    controller.isBusy(current.sessionId, 'edit-fork', message.eventSeq),
                },
              ),
              button(
                t('retry'),
                () =>
                  void controller.retryMessage({
                    ...message,
                    sessionId: current.sessionId,
                    title: current.title,
                  }),
                {
                  disabled:
                    !message.editable ||
                    controller.isBusy(current.sessionId, 'retry-fork', message.eventSeq),
                },
              ),
            ),
          ),
        ),
      ),
    );
  }

  function Editor({ current, t }) {
    return h(
      React.Fragment,
      null,
      h('p', { className: 'dsh-se-muted' }, t('branchExplanation')),
      h('textarea', {
        className: 'dsh-se-textarea',
        'aria-label': t('textLabel'),
        value: current.text,
        autoFocus: true,
        readOnly: current.busy || current.loading,
        spellCheck: false,
        'data-testid': 'edit-text',
        onChange: event => controller.setText(event.target.value),
      }),
    );
  }

  function Overlay() {
    const t = useTranslation();
    const state = useState();
    const current = state.panel;
    const dialog = React.useRef(null);

    React.useEffect(() => {
      const element = dialog.current;
      if (current && element && !element.open) element.showModal();
    }, [Boolean(current)]);

    const dismiss = () => {
      dialog.current?.close();
      controller.close();
    };
    const title = current?.view === 'editor' ? 'editTitle' : 'historyTitle';

    return h(
      React.Fragment,
      null,
      h('style', { 'data-session-edit-styles': true }, styles),
      state.notice &&
        h(
          'div',
          { className: 'dsh-se-notice', role: 'alert' },
          h(
            'p',
            null,
            state.notice.code === 'session-edit/navigation-failed'
              ? t('navigationFailed')
              : explain(state.notice, t),
          ),
          state.notice.sessionId &&
            button(t('openConversation'), () => {
              const id = state.notice.sessionId;
              controller.clearNotice();
              void controller.openResult({ sourceSessionId: id });
            }),
          button(t('close'), () => controller.clearNotice()),
        ),
      current &&
        h(
          'dialog',
          {
            ref: dialog,
            className: 'dsh-se-dialog',
            'aria-modal': true,
            'aria-labelledby': 'dsh-se-title',
            'data-testid': 'session-edit-dialog',
            onCancel: event => {
              event.preventDefault();
              dismiss();
            },
            onClick: event => {
              if (event.target !== event.currentTarget) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom
              ) {
                dismiss();
              }
            },
          },
          h(
            'header',
            { className: 'dsh-se-header' },
            h('h2', { id: 'dsh-se-title', className: 'dsh-se-title' }, t(title)),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-se-action dsh-se-close',
                'aria-label': t('close'),
                onClick: dismiss,
              },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'dsh-se-content' },
            h('p', { className: 'dsh-se-subtitle' }, current.title || t('untitled')),
            current.error &&
              h('p', { className: 'dsh-se-error', role: 'alert' }, explain(current.error, t)),
            current.loading && h('p', { role: 'status' }, t('loading')),
            current.view === 'history' && h(History, { current, t }),
            current.view === 'editor' && h(Editor, { current, t }),
          ),
          h(
            'footer',
            { className: 'dsh-se-footer' },
            current.view === 'editor' &&
              current.historyState &&
              button(t('backToHistory'), () => controller.backToHistory()),
            button(t(current.view === 'editor' ? 'cancel' : 'close'), dismiss),
            current.view === 'editor' &&
              button(t('confirmEdit'), () => void controller.submitEdit(), {
                primary: true,
                disabled:
                  current.busy ||
                  current.loading ||
                  !current.messageId ||
                  !current.text?.trim() ||
                  controller.isBusy(current.sessionId, 'edit-fork', current.eventSeq),
                testId: 'execute-action',
              }),
          ),
        ),
    );
  }

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dsh-session-edit.history',
        order: 450,
        label: () => translate('menu'),
      },
      MenuItem,
    ),
  );
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-session-edit.dialog', order: 120 },
      Overlay,
    ),
  );
  for (const key of ['user', 'steering']) {
    ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register({ name: 'conversation.chat.node', key, priority: -100 }, UserMessage),
    );
  }
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'dsh-session-edit.continue', order: 10 },
      ContinueDock,
    ),
  );
}

window.__ModuleLoader__.load({
  id: 'dsh-session-edit',
  factory(require) {
    return {
      inject: ['remote'],
      async apply(ctx) {
        await ctx.remote.$mount(remoteContribution());
        ctx.inject(
          ['slots', 'locale', 'remote', 'remote.sessionEdit', 'uiWorkspace'],
          uiCtx => mountUI(uiCtx, require('react')),
        );
      },
    };
  },
});
