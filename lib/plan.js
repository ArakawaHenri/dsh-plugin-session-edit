import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { fail } from './errors.js';

export const CONTINUE_TEXT = '继续完成刚才被我中断的任务。';

const CONTINUE_PROMPTS = {
  zh: {
    aborted: CONTINUE_TEXT,
    'max-tokens': '输出似乎被截断了，请继续完成剩余内容。',
    error: '刚才的请求失败了，请从当前状态继续完成任务。',
  },
  en: {
    aborted: 'Continue the task I interrupted.',
    'max-tokens': 'The previous output was cut off; continue and complete the remaining work.',
    error: 'The previous request failed; continue the task from the current state.',
  },
};

export function stopCauseOf(events) {
  const reason = events.findLast(event => event.type === 'turn/end')?.data.reason;
  if (reason?.kind === 'max-tokens') return 'max-tokens';
  if (reason?.kind === 'error') return 'error';
  return 'aborted';
}

export function continuePromptText(locale, cause) {
  return (CONTINUE_PROMPTS[locale] ?? CONTINUE_PROMPTS.zh)[cause];
}

export const isHuman = event =>
  event.type === 'user/message' &&
  event.surfaceOp === 'append' &&
  event.data?.role === 'user' &&
  event.data.source?.kind === 'user';

export const textOf = message =>
  message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

export const isTextOnly = message =>
  Array.isArray(message?.content) &&
  message.content.length > 0 &&
  message.content.every(block => block.type === 'text' && typeof block.text === 'string');

export function titleOf(events) {
  const title = events.findLast(event => event.type === 'session/title')?.data?.title;
  if (typeof title === 'string' && title.trim()) return title;
  const first = events.find(isHuman);
  return first ? textOf(first.data).slice(0, 80) || 'Session' : 'Session';
}

export function foldInbox(events) {
  const queues = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const { target, start, removedCount = 0, inserted = [] } = event.data;
    const queue = queues[target];
    if (
      !queue ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > queue.length ||
      !Number.isSafeInteger(removedCount) ||
      removedCount < 0 ||
      start + removedCount > queue.length ||
      !Array.isArray(inserted)
    ) {
      fail('invalid-history', 'The session contains an invalid inbox history.');
    }
    queues[target] = queue.toSpliced(start, removedCount, ...inserted);
  }
  return queues;
}

export function messageOf(event) {
  return event?.type === 'user/message' ? event.data : event?.data?.message;
}

export function surfaceEvents(events, projections = []) {
  let nodes;
  try {
    ({ nodes } = foldSurface(events, projections));
  } catch (error) {
    fail('invalid-history', error?.message || 'The session history could not be validated.');
  }
  return nodes
    .map(seq => events[seq])
    .filter(event => messageOf(event)?.content?.length > 0);
}

export function modelOf(events, fallback = {}) {
  let selected = fallback;
  for (const event of events) {
    if (event.type === 'request/header') selected = event.data.header.config;
    if (event.type === 'model/selection') selected = event.data;
  }
  return selected ?? {};
}

export function continuationPolicy(events, { rules = [], model, defaultModel, projections } = {}) {
  const base = { available: false, canSendPrompt: false };
  const lastEnd = events.findLast(event => event.type === 'turn/end');
  const lastStart = events.findLast(event => event.type === 'turn/start');
  const reason = lastEnd?.data.reason;
  const unfinished =
    reason?.kind === 'error' ||
    reason?.kind === 'max-tokens' ||
    (reason?.kind === 'aborted' && reason.reason?.kind === 'user');
  if (!unfinished || (lastStart && lastStart.seq > lastEnd.seq)) {
    return { ...base, reason: 'not-resumable' };
  }

  const queues = foldInbox(events);
  if (queues['next-turn'].length || queues['next-step'].length) {
    return { ...base, reason: 'queue-pending' };
  }

  const surface = surfaceEvents(events, projections);
  const conversationSurface = surface.filter(event => {
    const role = messageOf(event)?.role;
    return role !== 'system' && role !== 'developer';
  });
  const tail = messageOf(conversationSurface.at(-1));
  if (!tail) return { ...base, reason: 'no-context' };
  base.tailRole = tail.role;

  const turnStartSeq = lastStart?.seq ?? -1;
  const lastClaim = events.findLast(
    event =>
      event.seq > turnStartSeq &&
      event.type === 'agent/inbox/spliced' &&
      event.data.removedCount > 0 &&
      event.data.outcome !== 'canceled',
  );
  const unadmittedClaim =
    lastClaim !== undefined &&
    !events.some(
      event =>
        event.seq > lastClaim.seq &&
        ['user/message', 'assistant/message', 'assistant/attempt'].includes(event.type),
    );
  if (unadmittedClaim) return { ...base, reason: 'input-not-admitted' };
  base.canSendPrompt = true;

  const pendingTools = new Set();
  for (const event of surface) {
    const message = messageOf(event);
    if (message?.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') pendingTools.add(block.id);
      }
    }
    if (message?.role === 'tool') {
      pendingTools.delete(message.toolCallId ?? message.source?.callId);
    }
  }
  if (pendingTools.size) return { ...base, reason: 'unresolved-tools' };
  if (!['user', 'tool', 'assistant'].includes(tail.role)) {
    return { ...base, reason: 'unsupported-tail' };
  }
  if (
    tail.source?.replayState?.response?.kind === 'pi-ai' &&
    ['aborted', 'error'].includes(tail.source.replayState.response.stopReason)
  ) {
    return { ...base, reason: 'partial-replay-unavailable' };
  }

  const route = model ?? modelOf(events, defaultModel);
  const rule =
    rules.find(item => item.provider === route.provider && item.model === route.model) ??
    rules.find(item => item.provider === route.provider && item.model === '*');
  if (rule?.allow === false) return { ...base, reason: 'model-disabled' };

  return { ...base, available: true };
}

export function planOperation(request, snapshot, options = {}) {
  const { events, header } = snapshot;
  if (!snapshot.ordinary) {
    fail('owned-session', 'This session is controlled by another agent.');
  }
  const common = {
    sessionId: header.id,
    action: request.action,
    headSeq: events.at(-1)?.seq ?? -1,
    ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
  };

  if (request.action === 'continue') {
    if (snapshot.status === 'running') {
      fail('source-running', 'Wait for this session to finish, or stop it first.');
    }
    if (snapshot.archived) {
      fail('archived', 'Restore this session to its workspace before continuing it.');
    }
    const policy = continuationPolicy(events, {
      ...options,
      model: modelOf(events, options.defaultModel),
    });
    const mode = request.continuationMode ?? 'no-message';
    if (mode === 'no-message' ? !policy.available : !policy.canSendPrompt) {
      fail(
        mode === 'no-message' ? 'continuation-unsupported' : 'not-resumable',
        'This session cannot continue in the selected mode.',
        { reason: policy.reason },
      );
    }
    return {
      ...common,
      continuationMode: mode,
      ...(mode === 'prompt'
        ? {
            content: [
              {
                type: 'text',
                text: continuePromptText(options.locale ?? 'zh', stopCauseOf(events)),
              },
            ],
          }
        : {}),
    };
  }

  const event = events[request.eventSeq];
  if (!event || event.seq !== request.eventSeq || !isHuman(event)) {
    fail('message-not-editable', 'Select a recorded human input message.');
  }
  if (event.data.id !== request.messageId) {
    fail('session-changed', 'The selected message changed. Reopen it and try again.');
  }
  if (!isTextOnly(event.data)) {
    fail('message-not-editable', 'Editing and retrying currently support text-only messages.');
  }
  const text = request.action === 'edit-fork' ? request.replacementText : textOf(event.data);
  if (typeof text !== 'string' || !text.trim()) {
    fail('empty-message', 'The new message must contain text.');
  }
  if (text.length > (options.maxTextChars ?? 131072)) {
    fail('message-too-large', 'The new message is too large.');
  }

  const branchModel = modelOf(events.slice(0, event.seq), options.defaultModel);
  const modelSelection =
    typeof branchModel.provider === 'string' &&
    branchModel.provider &&
    typeof branchModel.model === 'string' &&
    branchModel.model
      ? {
          provider: branchModel.provider,
          model: branchModel.model,
          ...(typeof branchModel.reasoningEffort === 'string'
            ? { reasoningEffort: branchModel.reasoningEffort }
            : {}),
        }
      : undefined;

  return {
    ...common,
    eventSeq: event.seq,
    messageId: event.data.id,
    ...(modelSelection ? { modelSelection } : {}),
    content: request.action === 'retry-fork' ? structuredClone(event.data.content) : [{ type: 'text', text }],
  };
}

export function forkSeed(events, eventSeq, now = Date.now()) {
  const seed =
    eventSeq === 0
      ? [{ type: 'session/end-seed', seq: 0, time: now, data: { inherited: true } }]
      : buildForkSeed(events, eventSeq - 1);
  const queues = foldInbox(seed);
  for (const target of ['next-turn', 'next-step']) {
    if (!queues[target].length) continue;
    seed.push({
      type: 'agent/inbox/spliced',
      seq: seed.length,
      time: now,
      data: {
        target,
        start: 0,
        removedCount: queues[target].length,
        inserted: [],
        outcome: 'canceled',
      },
    });
  }
  return seed;
}
