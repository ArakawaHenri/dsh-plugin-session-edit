import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import Query from '@deepseek-ai/dsh-session-query';
import { SessionEditEngine } from '../../lib/service.js';
import { HostAdapter } from '../../lib/host-adapter.js';

export const code = suffix => error => error?.code === `session-edit/${suffix}`;
export const human = text =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
export const userEvents = events =>
  events.filter(
    event =>
      event.type === 'user/message' &&
      event.surfaceOp === 'append' &&
      event.data.source.kind === 'user',
  );
export const text = message =>
  message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
export const chunks = (value, reason = { kind: 'stop' }) => [
  { type: 'block-start', blockType: 'text', index: 0 },
  { type: 'text-delta', text: value, index: 0 },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason },
];

export async function createRuntime(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-service-runtime-'));
  const ctx = new Context();
  const requests = [];
  const handles = [];
  let response = request =>
    chunks(
      `answer: ${text(request.messages.findLast(message => message.role === 'user') ?? { content: [] })}`,
    );
  let sequence = 0;

  async function mount(plugin, options) {
    const fiber = ctx.plugin(plugin, options);
    await fiber.await();
    assert.equal(fiber.state, 2);
    return fiber;
  }

  new SessionStore(ctx);
  new Projections(ctx);
  new Agents(ctx);
  await mount(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount(Tools, {});

  class OfflineLlm extends Service {
    constructor() {
      super(ctx, 'llm');
    }
    async prepareCall(call) {
      return { config: call, adapterDefaults: {}, stream: request => this.stream(request) };
    }
    async *stream(request) {
      requests.push(request);
      if (requests.length > 50) throw new Error('Unexpected runaway fixture');
      yield* response(request, requests.length);
    }
  }
  new OfflineLlm();

  await mount(Jsonl, { root: join(root, 'sessions'), compression: 'none' });
  await mount(Query, {});
  const loopFiber = await mount(AgentLoop, { maxParallelToolCalls: 2 });

  const workspace = {
    id: 'fixture-workspace',
    path: root,
    sessionIds: [],
    async attachSession(id) {
      if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
    },
  };
  const workspaceRegistry = {
    archivedSessionIds: [],
    list: () => [workspace],
    get: id => (id === workspace.id ? workspace : undefined),
  };
  ctx.provide('workspaceRegistry', workspaceRegistry);
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'offline', model: 'stub' }),
  });
  ctx.provide('sessionController', {
    async resolveAgent(id) {
      const existing = ctx.agents.get(id);
      if (existing) return { agent: existing };
      const handle = await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: 'offline', model: 'stub' },
      });
      handles.push(handle);
      return { agent: handle.agent };
    },
  });

  const host = new HostAdapter(ctx);
  const engine = new SessionEditEngine(ctx, config, { host });

  t.after(async () => {
    await engine.close();
    for (const handle of handles) await handle.dispose();
    await loopFiber.dispose();
    await ctx.fiber.dispose();
  });

  return {
    ctx,
    root,
    workspace,
    workspaceRegistry,
    requests,
    handles,
    engine,
    host,
    setResponse(fn) {
      const previous = response;
      response = fn;
      return previous;
    },
    async createSource(options = {}) {
      const id = options.id ?? `fixture-source-${++sequence}`;
      const handle = await ctx.agents.create({
        sessionId: id,
        meta: { cwd: root, ...options.meta },
        ...(options.seed ? { seed: options.seed } : {}),
        ...(options.parentAgent ? { parentAgent: options.parentAgent } : {}),
        agentOptions: { provider: 'offline', model: 'stub' },
      });
      handles.push(handle);
      await workspace.attachSession(id);
      return handle;
    },
    async send(agent, value) {
      agent.followup(typeof value === 'string' ? human(value) : value);
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      return agent.session.snapshotEvents();
    },
    async stop(agent, value = 'Work that will be stopped.') {
      const started = Promise.withResolvers();
      const previous = response;
      response = async function* (request) {
        yield { type: 'block-start', blockType: 'text', index: 0 };
        yield { type: 'text-delta', text: 'Partial response before user stop.', index: 0 };
        started.resolve();
        await new Promise(resolve => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener('abort', resolve, { once: true });
        });
        request.signal.throwIfAborted();
      };
      agent.followup(human(value));
      await started.promise;
      agent.cancel({ kind: 'user' }, { keepInbox: true });
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      response = previous;
      return agent.session.snapshotEvents();
    },
    async readStored(id) {
      const handle = await ctx.sessionPersistence.open(id, 'read');
      try {
        return (await handle.read()).events;
      } finally {
        await handle.close();
      }
    },
    async submit(request) {
      const result = await engine.execute(request);
      return { result, command: request };
    },
  };
}
