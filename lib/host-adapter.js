import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { forkSeed } from './plan.js';
import { fail } from './errors.js';

export function assertRuntime() {
  if (SESSION_FORMAT_VERSION !== 4) {
    fail('unsupported-runtime', 'This plugin requires DSH session format v4.');
  }
}

export class HostAdapter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  defaultModel() {
    return this.ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
  }

  async snapshot(sessionId) {
    const observation = await this.ctx.sessionQuery.observeSession(sessionId);
    try {
      const { events, header } = observation;
      const agent = this.ctx.agents.get(sessionId);
      const liveRoot = !agent || this.ctx.agents.roots().some(root => root.id === agent.id);
      const ownDelegation = events.some(
        event => event.type === 'subagent/descriptor' && event.seq >= observation.inheritedEventCount,
      );
      const ordinary = header.origin !== 'subagent' && liveRoot && !ownDelegation;
      const workspaces = this.ctx.workspaceRegistry.list();
      const workspace =
        workspaces.find(item => item.sessionIds.includes(sessionId)) ??
        workspaces.find(item => item.path === header.cwd);

      return {
        header,
        events,
        inheritedEventCount: observation.inheritedEventCount,
        cursor: observation.cursor ?? events.at(-1)?.seq ?? -1,
        status: agent?.status ?? 'cold',
        ordinary,
        archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
        ...(workspace ? { workspaceId: workspace.id } : {}),
      };
    } finally {
      observation[Symbol.dispose]();
    }
  }

  async requireCurrentFormat(sessionId) {
    const stat = await this.ctx.sessionPersistence.stat(sessionId);
    if (stat?.formatStatus === 'migration-required') {
      fail('migration-required', 'Open the source session in DSH to complete migration first.');
    }
    if (stat?.formatStatus && stat.formatStatus !== 'current') {
      fail('unsupported-format', 'This session format is not supported.');
    }
  }

  async resolve(sessionId) {
    const result = await this.ctx.sessionController.resolveAgent(sessionId);
    if (result?.error) throw result.error;
    if (!result?.agent) fail('host-error', 'The host could not activate this session.');
    return result.agent;
  }

  async createFork(snapshot, plan, childSessionId, now) {
    if (!snapshot.header.cwd) {
      fail('workspace-required', 'The source session must have a recorded working directory.');
    }
    const workspace = plan.workspaceId ? this.ctx.workspaceRegistry.get(plan.workspaceId) : undefined;
    if (plan.workspaceId && !workspace) {
      fail('workspace-missing', 'The target workspace is no longer available.');
    }
    const seed = forkSeed(snapshot.events, plan.eventSeq, now);
    if (plan.modelSelection) {
      seed.push({
        type: 'model/selection',
        seq: seed.length,
        time: now,
        data: plan.modelSelection,
      });
    }
    const meta = {
      cwd: snapshot.header.cwd,
      createdAt: now,
      parentSession: snapshot.header.id,
      isSeeded: true,
      delegationDepth: 0,
      ...(snapshot.header.agentPreset === undefined ? {} : { agentPreset: snapshot.header.agentPreset }),
    };
    const prepared = this.ctx.sessions.prepare(childSessionId, {
      seed,
      inheritedEventCount: plan.eventSeq,
      meta,
    });

    let handle;
    try {
      handle = await this.ctx.sessionPersistence.create(prepared.header, {
        inheritedEventCount: plan.eventSeq,
      });
      await handle.append(seed);
      await handle.flush();
    } finally {
      if (handle) await handle.close();
    }

    if (workspace && !workspace.sessionIds.includes(childSessionId)) {
      await workspace.attachSession(childSessionId);
    }
  }

  submitPrompt(agent, content, rpcId) {
    this.assertIdle(agent);
    const message = createUserMessage({
      content,
      source: { kind: 'user', rpcId },
    });
    agent.followup(message);
  }

  continueFromHistory(agent, expectedSeq) {
    this.assertIdle(agent);
    if (expectedSeq !== undefined && agent.session.seq - 1 !== expectedSeq) {
      fail('session-changed', 'The session changed before continuation.');
    }
    if (typeof agent.wakeDriver !== 'function' || typeof agent.ctx?.on !== 'function') {
      fail('host-error', 'The active agent runtime does not support history continuation.');
    }
    const expectedTurn = (agent.phase?.lastTurn ?? 0) + 1;
    const wakeMarker = createUserMessage({
      content: [],
      source: { kind: 'runtime-context' },
    });
    const dispose = agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent && payload.agent !== agent) return next();
      dispose();
      const decision = await next();
      if (
        payload.turn === expectedTurn &&
        payload.step === 1 &&
        decision.kind === 'enter' &&
        decision.messages.length === 0
      ) {
        return { ...decision, messages: [wakeMarker] };
      }
      return decision;
    });
    try {
      agent.wakeDriver(false);
    } finally {
      agent.whenIdle?.().then(dispose, dispose);
    }
  }

  assertIdle(agent) {
    if (
      this.ctx.agents.get(agent.id) !== agent ||
      agent.status !== 'idle' ||
      (agent.phase && agent.phase.kind !== 'idle')
    ) {
      fail('source-running', 'The session started other work before submission.');
    }
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      fail('queue-pending', 'Handle the pending queue before submitting this operation.');
    }
  }

  flush(agent) {
    return this.ctx.sessions.flush(agent.session);
  }
}
