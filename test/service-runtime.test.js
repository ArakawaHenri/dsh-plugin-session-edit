import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createRuntime, chunks, code, human, text, userEvents } from './helpers/runtime.js';
import { continuePromptText } from '../lib/plan.js';

const options = { timeout: 15_000 };

const forkCommand = (agent, target, action = 'retry-fork', replacementText) => ({
  sessionId: agent.id,
  action,
  eventSeq: target.seq,
  messageId: target.data.id,
  ...(action === 'edit-fork' ? { replacementText } : {}),
});

for (const action of ['edit-fork', 'retry-fork']) {
  test(
    `real ${action} preserves source events, input blocks and the selected response boundary`,
    options,
    async t => {
      const f = await createRuntime(t);
      const source = await f.createSource();
      await f.send(source.agent, 'Earlier input.');
      const original = human('Original input.');
      const targetInput = {
        ...original,
        content: [
          { type: 'text', text: 'Original first block.' },
          { type: 'text', text: 'Original second block.' },
        ],
      };
      await f.send(source.agent, targetInput);
      await f.send(source.agent, 'Later input.');
      const before = await f.readStored(source.agent.id);
      const target = userEvents(before)[1];
      const { result } = await f.submit(
        forkCommand(source.agent, target, action, 'Edited input.'),
      );
      assert.ok(result.childSessionId.startsWith('session-'));
      const child = f.ctx.agents.get(result.childSessionId);
      await child.whenIdle();
      await f.ctx.sessions.flush(child.session);
      assert.deepEqual(await f.readStored(source.agent.id), before);
      const childEvents = await f.readStored(child.id);
      assert.equal(child.session.header.parentSession, source.agent.id);
      assert.equal(child.session.inheritedEventCount, target.seq);
      assert.deepEqual(childEvents.slice(0, target.seq), before.slice(0, target.seq));
      const sent = userEvents(child.session.snapshotEvents()).filter(
        event => event.seq >= target.seq,
      );
      assert.equal(sent.length, 1);
      assert.notEqual(sent[0].data.id, target.data.id);
      assert.deepEqual(
        sent[0].data.content,
        action === 'edit-fork' ? [{ type: 'text', text: 'Edited input.' }] : target.data.content,
      );
      const seen = f.requests.find(request => request.sessionId === child.id).messages;
      assert.equal(seen.some(message => text(message) === 'Later input.'), false);
      assert.equal(
        seen.some(message => message.role === 'assistant' && text(message).includes('Original first block.')),
        false,
      );
      assert.ok(
        seen.some(message => message.role === 'assistant' && text(message).includes('Earlier input.')),
      );
      assert.ok(f.workspace.sessionIds.includes(child.id));
    },
  );
}

test('fork initialization durably clears inherited pending inputs before native activation', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  source.agent.inbox.append('next-turn', human('First queued target.'));
  source.agent.inbox.append('next-turn', human('Old pending input.'));
  await f.send(source.agent, 'Wake the queued inputs.');
  const before = source.agent.session.snapshotEvents();
  const target = userEvents(before)[0];
  const { result } = await f.submit(
    forkCommand(source.agent, target, 'edit-fork', 'Replacement only.'),
  );
  const child = f.ctx.agents.get(result.childSessionId);
  await child.whenIdle();
  const childRequests = f.requests.filter(request => request.sessionId === child.id);
  assert.equal(childRequests.length, 1);
  assert.equal(
    childRequests[0].messages
      .filter(message => message.role === 'user')
      .map(text)
      .join('|'),
    'Replacement only.',
  );
  assert.ok(
    child.session
      .snapshotEvents()
      .some(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'),
  );
  assert.deepEqual(source.agent.session.snapshotEvents(), before);
});

test('a seq-zero historical user input resolves exactly and creates a persisted empty-prefix child', options, async t => {
  const f = await createRuntime(t);
  const original = human('Imported first input.');
  const target = { type: 'user/message', seq: 0, time: 1, data: original, surfaceOp: 'append' };
  const source = await f.createSource({ seed: [target] });
  await f.ctx.sessions.flush(source.agent.session);
  const selected = await f.engine.inspect({ sessionId: source.agent.id, eventSeq: 0 });
  assert.equal(selected.messages.length, 1);
  assert.equal(selected.messages[0].messageId, original.id);
  const { result } = await f.submit(
    forkCommand(source.agent, target, 'edit-fork', 'Changed first input.'),
  );
  const child = f.ctx.agents.get(result.childSessionId);
  await child.whenIdle();
  assert.equal(child.session.inheritedEventCount, 0);
  assert.equal(child.session.header.parentSession, source.agent.id);
  assert.deepEqual(
    userEvents(child.session.snapshotEvents()).map(event => text(event.data)),
    ['Changed first input.'],
  );
  assert.equal(child.session.snapshotEvents()[0].data.inherited, true);
});

test('later title, messages and a still-running parent do not invalidate the selected fork prefix', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const target = userEvents(await f.send(source.agent, 'Selected input.'))[0];
  const running = Promise.withResolvers();
  const release = Promise.withResolvers();
  source.agent.session.append('session/title', { title: 'Changed after initial turn' });
  await f.send(source.agent, 'Later completed input.');
  f.setResponse(async function* (request) {
    if (request.sessionId === source.agent.id) {
      running.resolve();
      await release.promise;
    }
    yield* chunks('Independent answer.');
  });
  source.agent.followup(human('Parent still running.'));
  await running.promise;
  try {
    const { result } = await f.submit(forkCommand(source.agent, target));
    assert.equal(source.agent.status, 'running');
    const child = f.ctx.agents.get(result.childSessionId);
    await child.whenIdle();
    assert.deepEqual(
      f.requests
        .find(request => request.sessionId === child.id)
        .messages.filter(message => message.role === 'user')
        .map(text),
      ['Selected input.'],
    );
    assert.equal(source.agent.status, 'running');
  } finally {
    release.resolve();
    await source.agent.whenIdle();
  }
});

test('runtime-owned Agents cannot be edited even when their durable header has no parent lineage', options, async t => {
  const f = await createRuntime(t);
  const owner = await f.createSource();
  const child = await f.createSource({ parentAgent: owner.agent });
  const events = await f.send(child.agent, 'Managed agent input.');
  assert.equal(child.agent.session.header.parentSession, undefined);
  assert.equal(child.agent.session.header.origin, undefined);
  assert.equal(f.ctx.agents.isOwnedBy(child.agent.id, owner.agent), true);
  const inspection = await f.engine.inspect({ sessionId: child.agent.id });
  assert.equal(inspection.ordinary, false);
  await assert.rejects(f.submit(forkCommand(child.agent, userEvents(events)[0])), code('owned-session'));
});

test('inspection pages are ascending and exact message resolution stays read-only for a cold session', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  for (const value of ['one', 'two', 'three']) await f.send(source.agent, value);
  const before = await f.readStored(source.agent.id);
  await source.dispose();
  const latest = await f.engine.inspect({ sessionId: source.agent.id, limit: 2 });
  assert.deepEqual(
    latest.messages.map(message => message.text),
    ['two', 'three'],
  );
  const older = await f.engine.inspect({
    sessionId: source.agent.id,
    beforeSeq: latest.nextBeforeSeq,
    limit: 2,
  });
  assert.deepEqual(
    older.messages.map(message => message.text),
    ['one'],
  );
  assert.equal(older.nextBeforeSeq, null);
  assert.ok(older.messages[0].eventSeq < latest.messages[0].eventSeq);
  const selected = await f.engine.inspect({
    sessionId: source.agent.id,
    eventSeq: userEvents(before)[1].seq,
  });
  assert.deepEqual(selected.messages, [latest.messages[0]]);
  assert.equal(selected.nextBeforeSeq, null);
  await assert.rejects(
    f.engine.inspect({
      sessionId: source.agent.id,
      eventSeq: before.find(event => event.type === 'assistant/message').seq,
    }),
    code('message-not-editable'),
  );
  assert.equal(f.ctx.agents.get(source.agent.id), undefined);
  assert.deepEqual(await f.readStored(source.agent.id), before);
  assert.equal(f.requests.length, 3);
});

test('a cold stopped Session continues directly on stock AgentLoop without adding user text', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const stopped = await f.stop(source.agent);
  const count = userEvents(stopped).length;
  const id = source.agent.id;
  await source.dispose();
  const inspection = await f.engine.inspect({ sessionId: id });
  assert.equal(inspection.status, 'cold');
  assert.equal(inspection.continuation.available, true);
  const { result } = await f.submit({ sessionId: id, action: 'continue' });
  assert.equal(result.sourceSessionId, id);
  assert.equal(result.childSessionId, undefined);
  const resumed = f.ctx.agents.get(id);
  await resumed.whenIdle();
  await f.ctx.sessions.flush(resumed.session);
  const stored = await f.readStored(id);
  assert.equal(userEvents(stored).length, count);
  assert.equal(
    stored.slice(stopped.length).filter(e => e.type === 'agent/inbox/spliced').length,
    0,
  );
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].messages.at(-1).role, 'assistant');
  assert.equal(text(f.requests[1].messages.at(-1)), 'Partial response before user stop.');
});

test('direct continuation retains native tool execution and subsequent model step', options, async t => {
  const f = await createRuntime(t);
  let executed = 0;
  f.ctx.tools.register(
    defineTool({
      name: 'local_probe',
      description: 'Pure offline fixture tool.',
      parameters: { value: { type: 'number', required: true } },
      output: {
        schema: { type: 'number' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        assert.equal(exec.agent.id, source.agent.id);
        executed++;
        return args.value * 2;
      },
    }),
  );
  const source = await f.createSource();
  await f.stop(source.agent);
  f.setResponse((_request, number) =>
    number === 2
      ? [
          { type: 'block-start', blockType: 'tool-call', index: 0 },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'call-1',
            name: 'local_probe',
            argumentsDelta: '{"value":7}',
          },
          {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'call-1',
              name: 'local_probe',
              arguments: '{"value":7}',
            },
          },
          { type: 'finish', reason: { kind: 'tool-use' } },
        ]
      : chunks('Tool result consumed.'),
  );
  await f.submit({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(executed, 1);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].messages.at(-1).role, 'tool');
  assert.equal(f.requests[2].messages.at(-1).content[0].text, '14');
});

test('a failed direct continuation attempt leaves manual prompt continuation available', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const before = await f.stop(source.agent);
  const normalResponse = f.setResponse(async function* () {
    throw new Error('Offline provider refuses assistant-tail continuation');
  });
  await f.submit({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(f.requests.length, 2);
  assert.equal(userEvents(source.agent.session.snapshotEvents()).length, userEvents(before).length);
  assert.equal(
    source.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason
      .kind,
    'error',
  );
  const inspection = await f.engine.inspect({ sessionId: source.agent.id });
  assert.equal(inspection.continuation.available, true);
  assert.equal(inspection.continuation.canSendPrompt, true);
  f.setResponse(normalResponse);
  await f.submit({ sessionId: source.agent.id, action: 'continue', continuationMode: 'prompt' });
  await source.agent.whenIdle();
  assert.equal(
    text(userEvents(source.agent.session.snapshotEvents()).at(-1).data),
    continuePromptText('zh', 'error'),
  );
  assert.equal(f.requests.length, 3);
});

test('explicit model denial blocks no-message admission but leaves prompt mode available', options, async t => {
  const f = await createRuntime(t, {
    continuationRules: [{ provider: 'offline', model: 'stub', allow: false }],
  });
  const source = await f.createSource();
  await f.stop(source.agent);
  const inspection = await f.engine.inspect({ sessionId: source.agent.id });
  assert.equal(inspection.continuation.available, false);
  assert.equal(inspection.continuation.reason, 'model-disabled');
  assert.equal(inspection.continuation.canSendPrompt, true);
  await assert.rejects(
    f.submit({ sessionId: source.agent.id, action: 'continue' }),
    code('continuation-unsupported'),
  );
  assert.equal(f.requests.length, 1);
  await f.submit({ sessionId: source.agent.id, action: 'continue', continuationMode: 'prompt' });
  await source.agent.whenIdle();
  assert.equal(
    text(userEvents(source.agent.session.snapshotEvents()).at(-1).data),
    continuePromptText('zh', 'aborted'),
  );
  assert.equal(f.requests.length, 2);
});

test('a max-tokens turn can be explicitly continued without another user input', options, async t => {
  const f = await createRuntime(t);
  const source = await f.createSource();
  const normalResponse = f.setResponse(() => chunks('Incomplete answer.', { kind: 'max-tokens' }));
  const before = await f.send(source.agent, 'Long task.');
  assert.equal(before.findLast(event => event.type === 'turn/end').data.reason.kind, 'max-tokens');
  assert.equal((await f.engine.inspect({ sessionId: source.agent.id })).continuation.available, true);
  f.setResponse(normalResponse);
  await f.submit({ sessionId: source.agent.id, action: 'continue' });
  await source.agent.whenIdle();
  assert.equal(userEvents(source.agent.session.snapshotEvents()).length, userEvents(before).length);
  assert.equal(f.requests.length, 2);
});
