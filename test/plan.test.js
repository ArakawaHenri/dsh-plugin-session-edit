import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTINUE_TEXT,
  continuePromptText,
  continuationPolicy,
  foldInbox,
  forkSeed,
  planOperation,
  surfaceEvents,
} from '../lib/plan.js';

const human = (text, id = 'u') => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
});

function log() {
  const events = [];
  const push = (type, data, surfaceOp) => {
    const e = {
      type,
      data,
      seq: events.length,
      time: 1,
      ...(surfaceOp ? { surfaceOp } : {}),
    };
    events.push(e);
    return e;
  };
  return { events, push };
}

function fixture() {
  const { events, push } = log();
  const message = human('original');
  push('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [message, human('queued', 'q')],
  });
  push('turn/start', { turn: 1 });
  push('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  push('step/start', { turn: 1, step: 1 });
  const target = push('user/message', message, 'append');
  push('request/header', {
    header: { config: { provider: 'fixture', model: 'm' } },
    reason: 'initial',
  });
  push(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'a',
        role: 'assistant',
        source: {
          kind: 'model',
          provider: 'fixture',
          model: 'm',
          replayState: {
            response: { kind: 'pi-ai', api: 'openai-responses', stopReason: 'stop' },
          },
        },
        content: [{ type: 'text', text: 'partial' }],
      },
    },
    'append',
  );
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const snapshot = {
    events,
    header: { id: 'source', version: 4, cwd: '/fixture', isSeeded: false, createdAt: 1 },
    workspaceId: 'workspace',
    ordinary: true,
    archived: false,
    status: 'idle',
  };
  const request = {
    sessionId: 'source',
    action: 'retry-fork',
    eventSeq: target.seq,
    messageId: target.data.id,
  };
  const clearQueue = () =>
    push('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
      outcome: 'canceled',
    });
  return { events, push, target, snapshot, request, clearQueue };
}

test('edited branch excludes target and subsequent assistant, preserves parent, and cancels inherited queue', () => {
  const { events, target } = fixture();
  const before = JSON.stringify(events);
  const seed = forkSeed(events, target.seq, 10);
  assert.deepEqual(seed.slice(0, target.seq), events.slice(0, target.seq));
  assert.ok(seed.some(e => e.type === 'turn/end' && e.data.reason.kind === 'forked'));
  assert.equal(seed.some(e => e.type === 'user/message'), false);
  assert.deepEqual(foldInbox(seed), { 'next-turn': [], 'next-step': [] });
  assert.equal(seed.at(-1).data.outcome, 'canceled');
  assert.equal(JSON.stringify(events), before);
});

test('empty prefix is explicit, inherited, and contiguous', () => {
  const seed = forkSeed(
    [{ type: 'user/message', seq: 0, time: 1, data: human('first'), surfaceOp: 'append' }],
    0,
    10,
  );
  assert.deepEqual(seed, [{ type: 'session/end-seed', seq: 0, time: 10, data: { inherited: true } }]);
});

test('plan verifies message identity, rejects automatic context and attachments, and retains retry blocks', () => {
  const { snapshot, target, request } = fixture();
  target.data.content.push({ type: 'text', text: 'second block' });
  const plan = planOperation(request, snapshot);
  assert.deepEqual(plan.content, target.data.content);
  assert.notEqual(plan.content, target.data.content);
  assert.throws(
    () => planOperation({ ...request, messageId: 'another-message' }, snapshot),
    error => error.code === 'session-edit/session-changed',
  );
  assert.throws(
    () => planOperation({ ...request, messageId: undefined }, snapshot),
    error => error.code === 'session-edit/session-changed',
  );
  target.data.source.kind = 'runtime-context';
  assert.throws(() => planOperation(request, snapshot), /human input/);
  target.data.source.kind = 'user';
  target.data.content.push({ type: 'image', image: 'fixture' });
  assert.throws(() => planOperation(request, snapshot), /text-only/);
});

test('continuation requires an unfinished turn and no pending queue', () => {
  const { events, clearQueue } = fixture();
  assert.equal(continuationPolicy(events).reason, 'queue-pending');
  clearQueue();
  assert.equal(continuationPolicy(events).available, true);
  assert.equal(continuationPolicy(events).canSendPrompt, true);
  events.findLast(e => e.type === 'turn/end').data.reason.reason.kind = 'disposed';
  assert.equal(continuationPolicy(events).canSendPrompt, false);
});

test('unknown assistant-tail models allow a no-message attempt and explicit deny rules still apply', () => {
  const { events, snapshot, clearQueue } = fixture();
  clearQueue();
  delete events.find(e => e.type === 'assistant/message').data.message.source.replayState;
  const policy = continuationPolicy(events);
  assert.equal(policy.available, true);
  assert.equal(policy.canSendPrompt, true);
  assert.equal(policy.tailRole, 'assistant');
  const plan = planOperation({ action: 'continue' }, snapshot);
  assert.equal(plan.continuationMode, 'no-message');
  assert.equal(plan.content, undefined);
  assert.deepEqual(planOperation({ action: 'continue', continuationMode: 'prompt' }, snapshot).content, [
    { type: 'text', text: CONTINUE_TEXT },
  ]);
  assert.equal(
    continuationPolicy(events, { rules: [{ provider: 'fixture', model: '*', allow: false }] }).reason,
    'model-disabled',
  );
  assert.equal(
    continuationPolicy(events, {
      rules: [
        { provider: 'fixture', model: '*', allow: true },
        { provider: 'fixture', model: 'm', allow: false },
      ],
    }).reason,
    'model-disabled',
  );
});

for (const reason of [{ kind: 'error', error: 'offline rejection' }, { kind: 'max-tokens' }]) {
  test(`a ${reason.kind} turn remains eligible for an explicit continuation`, () => {
    const { events, snapshot, clearQueue } = fixture();
    clearQueue();
    events.findLast(e => e.type === 'turn/end').data.reason = reason;
    assert.equal(continuationPolicy(events).available, true);
    assert.equal(planOperation({ action: 'continue' }, snapshot).continuationMode, 'no-message');
    assert.equal(
      planOperation({ action: 'continue', continuationMode: 'prompt' }, snapshot).content[0].text,
      continuePromptText('zh', reason.kind),
    );
    assert.equal(
      planOperation(
        { action: 'continue', continuationMode: 'prompt' },
        snapshot,
        { locale: 'en' },
      ).content[0].text,
      continuePromptText('en', reason.kind),
    );
  });
}

for (const stopReason of ['aborted', 'error']) {
  test(`known ${stopReason} replay metadata discarded by the adapter blocks no-message continuation`, () => {
    const { events, snapshot, clearQueue } = fixture();
    clearQueue();
    events.find(e => e.type === 'assistant/message').data.message.source.replayState.response.stopReason =
      stopReason;
    const policy = continuationPolicy(events);
    assert.equal(policy.available, false);
    assert.equal(policy.reason, 'partial-replay-unavailable');
    assert.equal(policy.canSendPrompt, true);
    assert.throws(
      () => planOperation({ action: 'continue' }, snapshot),
      error => error.code === 'session-edit/continuation-unsupported',
    );
  });
}

test('an unpaired tool call blocks no-message continuation even for an allowed model', () => {
  const { events, clearQueue } = fixture();
  clearQueue();
  events
    .find(e => e.type === 'assistant/message')
    .data.message.content.push({ type: 'tool-call', id: 'call-1', name: 'fixture', input: {} });
  const policy = continuationPolicy(events, {
    rules: [{ provider: 'fixture', model: 'm', allow: true }],
  });
  assert.equal(policy.available, false);
  assert.equal(policy.reason, 'unresolved-tools');
  assert.equal(policy.canSendPrompt, true);
});

test('surface replacement position does not make an older replacement the conversation tail', () => {
  const { events, push } = log();
  push('user/message', human('first', 'u1'), 'append');
  push('user/message', human('last', 'u2'), 'append');
  push('user/message', human('replace-first', 'u3'), {
    op: 'replace',
    startSeq: 0,
    endSeq: 0,
  });
  events.at(-1).sourceEventSeqs = [0];
  assert.equal(surfaceEvents(events).at(-1).data.content[0].text, 'last');
});

test('branch plan uses the selected prefix route, not a model chosen later in the source', () => {
  const { events, push } = log();
  push('request/header', { header: { config: { provider: 'first', model: 'old' } } });
  push('model/selection', { provider: 'selected', model: 'at-cut', reasoningEffort: 'high' });
  const target = push('user/message', human('retry me'), 'append');
  push('request/header', { header: { config: { provider: 'selected', model: 'at-cut' } } });
  push('model/selection', { provider: 'later', model: 'not-in-branch' });
  const snapshot = {
    events,
    header: { id: 'source' },
    ordinary: true,
    archived: false,
    status: 'idle',
  };
  const plan = planOperation(
    { action: 'retry-fork', eventSeq: target.seq, messageId: target.data.id },
    snapshot,
    { defaultModel: { provider: 'default', model: 'fallback' } },
  );
  assert.deepEqual(plan.modelSelection, {
    provider: 'selected',
    model: 'at-cut',
    reasoningEffort: 'high',
  });
});

test('invalid inbox splices fail closed', () => {
  assert.throws(
    () =>
      foldInbox([
        { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 10, inserted: [] } },
      ]),
    /invalid inbox/,
  );
});

test('trailing developer or system messages on the surface do not obscure the conversation tail', () => {
  const { events, push, clearQueue } = fixture();
  clearQueue();
  events.findLast(event => event.type === 'turn/end').data.reason = {
    kind: 'error',
    error: 'network failure',
  };
  push(
    'developer/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'dev-1',
        role: 'developer',
        source: { kind: 'tool-registry' },
        content: [{ type: 'text', text: 'context notice' }],
      },
    },
    'append',
  );
  const policy = continuationPolicy(events);
  assert.equal(policy.available, true);
  assert.equal(policy.canSendPrompt, true);
  assert.equal(policy.tailRole, 'assistant');
});

test('a second-step inbox claim aborted before message admission is detected as input-not-admitted', () => {
  const { events, push, clearQueue } = fixture();
  clearQueue();
  push('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [human('steering input', 's1')],
  });
  push('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  const policy = continuationPolicy(events);
  assert.equal(policy.available, false);
  assert.equal(policy.canSendPrompt, false);
  assert.equal(policy.reason, 'input-not-admitted');
});
