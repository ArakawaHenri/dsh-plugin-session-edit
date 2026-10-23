// Bundled into client.js. React and UI primitives are provided by DSH's loader.
import { remoteContribution } from '../remote.js';
import { createClientController } from './client-controller.js';
import { useNativePrimary, usePrimaryReplacement } from './native-composer.js';
import { createSessionReloader } from './native-session.js';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import styles from './client.css';

const dictionaries = { en, zh };
const namespace = 'dsh.sessionEdit';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function prepareContent(content, data = {}) {
  const texts = [];
  const attachments = [];
  const extraBlocks = [];
  for (const block of content || []) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && isObject(block.attachment)) {
      attachments.push({ type: 'image', image: { attachment: block.attachment } });
    } else if (block.type === 'file' && isObject(block.attachment)) {
      attachments.push({ type: 'file', file: block.attachment });
    } else extraBlocks.push(block);
  }
  return {
    text: texts.join(''), attachments, extraBlocks,
    ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
  };
}

function clock(time) {
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function mountUI(ctx, React, { createPortal }, ui) {
  const h = React.createElement;
  const {
    Button, InlineEditor, Menu, MenuItemButton, Modal, Toast, Tooltip, writeClipboard,
    IconEditOutlineRegular: EditIcon, IconRefreshOutlineRegular: RetryIcon,
    IconCopyOutlineRegular: CopyIcon, IconCheckOutlineRegular: CheckIcon,
    IconTriangleRightFillRegular: PlayIcon,
    IconEllipsisOutlineRegular: MoreIcon, IconWarningOutlineRegular: WarningIcon,
  } = ui;
  ctx.effect(() => ctx.locale.register(namespace, dictionaries));
  const translate = ctx.locale.bind(namespace);
  const reloadSession = createSessionReloader(ctx.sessions);
  const controller = createClientController({
    rpc: ctx.remote.sessionEdit,
    navigate: id => ctx.uiWorkspace.openSession(id),
    getLocale: () => ctx.locale.getSnapshot(),
    reloadSession,
  });
  ctx.effect(() => () => controller.dispose());
  // Native lifecycle edges also reach windows that did not initiate the edit.
  ctx.effect(() => ctx.remote.$on('api-session/added', summary => {
    const session = ctx.sessions.binding(summary.sessionId)?.session;
    if (session?.getSnapshot().removed) {
      void reloadSession(summary.sessionId, summary)
        .then(() => {
          if (controller.getSnapshot().sessions[summary.sessionId]) {
            return controller.loadSession(summary.sessionId, true).catch(() => {});
          }
        })
        .catch(error => controller.reportRefreshError(summary.sessionId, error));
    }
  }));

  function useTranslation() {
    React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
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
    const key = 'error.' + code;
    return Object.hasOwn(dictionaries.en, key)
      ? t(key)
      : typeof error === 'string' ? error : error?.message || t('error.generic');
  }

  function canExecute(props) {
    return typeof props.useRemoteAccess === 'function' && props.useRemoteAccess('sessionEdit/execute');
  }

  function action(label, Icon, onClick, { unavailable = false, busy = false, hint = label } = {}) {
    return h(Tooltip, { label: hint, side: 'bottom', portal: true },
      h('button', {
        type: 'button', className: 'dsh-se-action', 'aria-label': label,
        'aria-disabled': unavailable || busy || undefined, disabled: busy,
        onClick: unavailable || busy ? undefined : onClick,
      }, h(Icon, { size: 16 })),
    );
  }

  function HistoryMenu(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const [, setOpen] = props.useMenuOpenState();
    if (!allowed) return null;
    return h(MenuItemButton, {
      icon: h(EditIcon),
      onSelect: () => {
        setOpen(false);
        void controller.openHistory(props.sessionId, props.displayTitle || t('untitled'));
      },
    }, t('menu'));
  }

  function MessageEditor({ current }) {
    const t = useTranslation();
    const ref = React.useRef(null);
    React.useEffect(() => {
      if (!current.loading) ref.current?.querySelector('textarea')?.focus();
    }, [current.eventSeq, current.loading]);
    const cancel = () => current.placement === 'history' && !current.busy
      ? controller.backToHistory() : controller.close();
    return h('div', {
      className: 'dsh-se-editor', ref, 'data-testid': 'session-edit-inline',
      onKeyDown: event => {
        // Escape belongs to the inline editor before the enclosing history modal.
        if (event.key === 'Escape') event.stopPropagation();
      },
    },
      current.error && h('p', { className: 'dsh-se-error', role: 'alert' }, explain(current.error, t)),
      current.loading && h('p', { className: 'dsh-se-muted', role: 'status' }, t('loading')),
      h('fieldset', { className: 'dsh-se-editor-field', disabled: current.busy || current.loading },
        h(InlineEditor, {
          value: current.text, label: t('textLabel'), className: 'dsh-se-editor-input',
          onChange: controller.setText, onSave: () => void controller.submitEdit(), onCancel: cancel,
        }),
      ),
      h('div', { className: 'dsh-se-editor-actions' },
        h('span', { className: 'dsh-se-muted' }, t('regenerateHint')),
        h(Button, { size: 'sm', onClick: cancel }, t(current.busy ? 'close' : 'cancel')),
        h(Button, {
          size: 'sm', variant: 'primary', icon: h(RetryIcon),
          disabled: current.busy || current.loading || !current.messageId || !current.text?.trim(),
          onClick: () => void controller.submitEdit(), 'data-testid': 'execute-action',
        }, t(current.busy ? 'sending' : 'confirmEdit')),
      ),
    );
  }

  function UserMessage(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const data = props.node.data;
    const state = useState();
    const current = state.panel;
    const editing = current?.view === 'editor' && current.placement === 'message' &&
      current.sessionId === props.sessionId && current.eventSeq === data.seq;
    React.useEffect(() => () => {
      const panel = controller.getSnapshot().panel;
      if (panel?.placement === 'message' && panel.sessionId === props.sessionId && panel.eventSeq === data.seq) {
        controller.close();
      }
    }, [props.sessionId, data.seq]);
    const [copyState, setCopyState] = React.useState(null);
    const copyTimer = React.useRef(null);
    React.useEffect(() => () => clearTimeout(copyTimer.current), []);
    const prepared = React.useMemo(() => prepareContent(data.content, data), [data.content, data.referenceLabels]);
    const facts = React.useMemo(() => ({
      ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
      ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
    }), [data.referenceLabels, data.skillNames]);
    const supported = Array.isArray(data.content) && data.content.length > 0 &&
      prepared.extraBlocks.length === 0 &&
      (Boolean(prepared.text.trim()) || prepared.attachments.length > 0);
    const session = state.sessions[props.sessionId]?.value;
    const owned = session?.ordinary === false;
    const archived = session?.archived === true;
    const tooLong = supported && prepared.text.length > (session?.maxTextChars ?? 131072);
    const editable = data.source?.kind === 'user' && Number.isSafeInteger(data.seq) &&
      data.seq >= 0 && supported && !owned && !archived && !tooLong;
    const reason = owned ? t('error.owned-session') : archived ? t('error.archived') : tooLong ? t('error.message-too-large') : t('plainTextOnly');
    const target = {
      sessionId: props.sessionId, eventSeq: data.seq, messageId: data.messageId, text: prepared.text, time: data.time,
    };
    const copy = async () => {
      const copied = await writeClipboard(prepared.text).catch(() => false);
      setCopyState(copied ? 'copied' : 'copyFailed');
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState(null), 1500);
    };
    return h('div', { className: 'dsh-se-row', 'data-session-edit-message': data.seq },
      editing
        ? h(React.Fragment, null,
            prepared.attachments.length > 0 && props.renderFactorySlot('conversation.chat.user.content', {
              content: { ...prepared, text: '' }, loadImage: props.loadImage, facts, interactive: false,
            }),
            h(MessageEditor, { current }),
          )
        : props.renderFactorySlot('conversation.chat.user.content', {
            content: prepared, loadImage: props.loadImage, facts, interactive: true,
          }),
      !editing && h('div', { className: 'dsh-se-row-actions' },
        Number.isFinite(data.time) && h('time', { dateTime: new Date(data.time).toISOString() }, clock(data.time)),
        action(t(copyState || 'copy'), copyState === 'copied' ? CheckIcon : CopyIcon, () => void copy()),
        allowed && action(t('editTitle'), EditIcon, () => void controller.openEdit(target), {
          unavailable: !editable, hint: editable ? t('editTitle') : reason,
          busy: controller.isBusy(props.sessionId, 'edit', data.seq),
        }),
        allowed && action(t('retryTitle'), RetryIcon, () => void controller.retryMessage(target), {
          unavailable: !editable, hint: editable ? t('retryTitle') : reason,
          busy: controller.isBusy(props.sessionId, 'retry', data.seq),
        }),
      ),
    );
  }

  function ComposerContinue(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const running = props.useSession(s => s.running);
    const openState = props.useSession(s => s.openState);
    const removed = props.useSession(s => s.removed);
    const input = props.useInput(s => s);
    const entry = useState(s => s.sessions[props.sessionId]);
    const busy = useState(() => controller.isBusy(props.sessionId, 'continue'));
    const marker = React.useRef(null);
    const anchor = useNativePrimary(React, marker, props.sessionId);
    React.useEffect(() => {
      if (allowed && props.sessionId && !running) void controller.loadSession(props.sessionId, true).catch(() => {});
    }, [props.sessionId, allowed, running, openState]);
    const facts = entry?.value;
    const available = allowed && !removed && !running && input?.phase === 'plain' &&
      !input.draft.trim() && input.attachmentIds.length === 0 && input.queue.length === 0 &&
      facts?.ordinary && !facts.archived && facts.status !== 'running' && facts.continuation.available;
    const replace = Boolean(available && anchor?.editable && anchor.disabled);
    usePrimaryReplacement(React, anchor, replace);
    const button = h(Tooltip, { label: t('noMessageDescription'), side: 'top', portal: true },
      h('button', {
        type: 'button', className: anchor?.className || 'dsh-se-primary',
        'aria-label': t('confirmContinue'), 'data-testid': 'session-edit-resume',
        disabled: busy || entry?.loading,
        onMouseDown: event => event.preventDefault(),
        onClick: () => void controller.continueSession(props.sessionId),
      }, h(PlayIcon, { size: 20 })),
    );
    return h(React.Fragment, null,
      h('span', { ref: marker, hidden: true, 'data-session-edit-control': true }),
      replace && createPortal(h('span', { className: 'dsh-se-primary-seat', 'data-session-edit-control': true }, button), anchor.parent),
      available && !anchor && h('span', { 'data-session-edit-control': true }, button),
    );
  }

  function ContinueStatus(props) {
    const t = useTranslation();
    const allowed = canExecute(props);
    const running = props.useSession(s => s.running);
    const entry = useState(s => s.sessions[props.sessionId]);
    const busy = useState(() => controller.isBusy(props.sessionId, 'continue'));
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => setOpen(false), [props.sessionId, running]);
    const facts = entry?.value;
    if (!allowed || running || !facts?.ordinary || facts.archived || facts.status === 'running' ||
      (!facts.continuation.available && !facts.continuation.canSendPrompt)) return null;
    return h('div', { className: 'dsh-se-status', 'data-testid': 'session-edit-continue' },
      h('span', null, t('stopped')),
      h(Menu, {
        open, onClose: () => setOpen(false), portal: true, side: 'top', align: 'end', compact: true,
        anchor: h(Tooltip, { label: t('continueOptions'), side: 'top' },
          h('button', {
            type: 'button', className: 'dsh-se-action', 'aria-label': t('continueOptions'),
            'aria-expanded': open, 'aria-haspopup': 'menu', disabled: busy || entry.loading,
            onClick: () => setOpen(value => !value),
          }, h(MoreIcon)),
        ),
        items: [
          ...(!facts.continuation.available ? [{ type: 'label', id: 'reason', text: explain(facts.continuation.reason, t) }] : []),
          { id: 'prompt', label: t('confirmPrompt'), disabled: !facts.continuation.canSendPrompt },
        ],
        onSelect: () => {
          setOpen(false);
          void controller.continueSession(props.sessionId, 'prompt');
        },
      }),
    );
  }

  function ComposerNotice(props) {
    const t = useTranslation();
    const state = useState();
    const entry = state.sessions[props.sessionId];
    const notice = state.notice?.action === 'continue' && state.notice.sessionId === props.sessionId ? state.notice : null;
    const error = notice || entry?.error;
    if (!error) return null;
    return h('div', { className: 'dsh-se-composer-notice', role: 'alert' },
      h(WarningIcon), h('span', null, explain(error, t)),
      notice
        ? h(Button, { size: 'sm', onClick: controller.clearNotice }, t('close'))
        : h(Button, { size: 'sm', disabled: entry.loading,
          onClick: () => void controller.loadSession(props.sessionId, true).catch(() => {}),
        }, t('refresh')),
    );
  }

  function History({ current }) {
    const t = useTranslation();
    const history = current.view === 'editor' ? current.historyState : current;
    return h(React.Fragment, null,
      current.error && current.view === 'history' && h('p', { className: 'dsh-se-error', role: 'alert' }, explain(current.error, t)),
      current.loading && !history.messages.length && h('p', { className: 'dsh-se-muted', role: 'status' }, t('loading')),
      history.nextBeforeSeq !== null && h(Button, {
        size: 'sm', disabled: current.loading || current.view === 'editor',
        onClick: () => void controller.loadOlder(), 'data-testid': 'load-older',
      }, t(current.loading ? 'loading' : 'loadOlder')),
      !current.loading && !history.messages.length && h('p', { className: 'dsh-se-muted' }, t('emptyHistory')),
      h('ol', { className: 'dsh-se-message-list' }, ...history.messages.map(message =>
        h('li', { key: message.messageId || message.eventSeq, className: 'dsh-se-message', 'data-event-seq': message.eventSeq },
          current.view === 'editor' && current.eventSeq === message.eventSeq
            ? h(MessageEditor, { current })
            : h(React.Fragment, null,
              h('p', { className: 'dsh-se-message-text' },
                [
                  ...(message.attachments || []).map(item => `[${item.name || item.type}]`),
                  ...(message.text ? [message.text] : []),
                ].join(' '),
              ),
              !message.editable && h('p', { className: 'dsh-se-muted' }, explain(message.reason || 'message-not-editable', t)),
              h('div', { className: 'dsh-se-row-actions' },
                h('time', { dateTime: new Date(message.time).toISOString() }, clock(message.time)),
                action(t('editTitle'), EditIcon, () => void controller.openEdit({ ...message, sessionId: current.sessionId, title: current.title }), {
                  unavailable: !message.editable, busy: controller.isBusy(current.sessionId, 'edit', message.eventSeq),
                }),
                action(t('retryTitle'), RetryIcon, () => void controller.retryMessage({ ...message, sessionId: current.sessionId }), {
                  unavailable: !message.editable, busy: controller.isBusy(current.sessionId, 'retry', message.eventSeq),
                }),
              ),
            ),
        ),
      )),
    );
  }

  function Overlay() {
    const t = useTranslation();
    const state = useState();
    const current = state.panel;
    const historyOpen = current && (current.view === 'history' || current.placement === 'history');
    const notice = state.notice?.action !== 'continue' ? state.notice : null;
    return h(React.Fragment, null,
      h('style', { 'data-session-edit-styles': true }, styles),
      notice && h(Toast, {
        key: state.revision, text: notice.code === 'session-edit/navigation-failed' ? t('navigationFailed') : explain(notice, t),
        icon: h(WarningIcon), holdMs: 8000, onDone: controller.clearNotice,
        actions: notice.sessionId ? [{ label: t('openConversation'), onClick: () => {
          controller.clearNotice(); void controller.openResult({ sourceSessionId: notice.sessionId, historyUpdated: notice.historyUpdated });
        } }] : undefined,
      }),
      h(Modal, {
        open: Boolean(historyOpen), onClose: controller.close, title: t('historyTitle'), closeLabel: t('close'),
        description: current?.title || t('untitled'), className: 'dsh-se-history-modal',
        footer: h(Button, { size: 'sm', onClick: controller.close }, t('close')),
      }, historyOpen && h('div', { 'data-testid': 'session-edit-dialog' }, h(History, { current }))),
    );
  }

  const register = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));
  register('sidebar.workspaces.session.menu.item', { id: 'dsh-session-edit.history', order: 450, label: () => translate('menu') }, HistoryMenu);
  register('shell.overlay', { id: 'dsh-session-edit.dialog', order: 120 }, Overlay);
  for (const key of ['user', 'steering']) register('conversation.chat.node', { key, priority: -100 }, UserMessage);
  register('conversation.input.right', { id: 'dsh-session-edit.primary', order: 100 }, ComposerContinue);
  register('conversation.composer.dock', { id: 'dsh-session-edit.continue', order: 10 }, ContinueStatus);
  register('conversation.input.dock', { id: 'dsh-session-edit.notice', order: 10 }, ComposerNotice);
}

window.__ModuleLoader__.load({
  id: 'dsh-session-edit',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const ui = require('@deepseek-ai/dsh-client-ui-primitives');
    return {
      inject: ['remote'],
      async apply(ctx) {
        await ctx.remote.$mount(remoteContribution());
        ctx.inject(['slots', 'locale', 'remote', 'remote.sessionEdit', 'sessions', 'uiWorkspace'], uiCtx => mountUI(uiCtx, React, ReactDOM, ui));
      },
    };
  },
});
