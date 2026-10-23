import { randomUUID } from 'node:crypto';
import { parseRequest } from '../remote.js';
import { fail } from './errors.js';
import { HostAdapter } from './host-adapter.js';
import { historyUpdatedFailure } from './rewrite.js';
import {
  attachmentsOf,
  continuationPolicy,
  isHuman,
  isSupportedContent,
  planOperation,
  textOf,
  titleOf,
} from './plan.js';

const SETUP_EVENTS = new Set([
  'session/end-seed',
  'session/title',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent-preset/selected',
  'working-directory/change',
  'plan/mode',
  'model/selection',
]);

class SerialQueue {
  #tails = new Map();
  #closed = false;

  run(key, work) {
    if (this.#closed) return Promise.reject(new Error('Session Edit is closing.'));
    const result = (this.#tails.get(key) ?? Promise.resolve()).then(work);
    const tail = result.then(() => {}, () => {});
    this.#tails.set(key, tail);
    tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  async close() {
    this.#closed = true;
    await Promise.all([...this.#tails.values()]);
  }
}

function selectMessagePage(events, { eventSeq, beforeSeq, limit = 40 }) {
  if (eventSeq !== undefined) {
    const target = events[eventSeq];
    if (!target || target.seq !== eventSeq || !isHuman(target)) {
      fail('message-not-editable', 'Select a recorded human input message.');
    }
    return { page: [target], nextBeforeSeq: null };
  }
  const collected = [];
  const startIndex =
    beforeSeq === undefined ? events.length - 1 : Math.min(events.length - 1, beforeSeq - 1);
  let hasOlder = false;
  for (let i = startIndex; i >= 0; i--) {
    const event = events[i];
    if (event.seq >= (beforeSeq ?? Infinity) || !isHuman(event)) continue;
    if (collected.length === limit) {
      hasOlder = true;
      break;
    }
    collected.push(event);
  }
  const page = collected.reverse();
  return {
    page,
    nextBeforeSeq: hasOlder && page.length > 0 ? page[0].seq : null,
  };
}

export class SessionEditEngine {
  constructor(ctx, config = {}, dependencies = {}) {
    this.ctx = ctx;
    this.config = { maxTextChars: 131072, continuationRules: [], ...config };
    this.host = dependencies.host ?? new HostAdapter(ctx);
    this.now = dependencies.now ?? Date.now;
    this.newId = dependencies.newId ?? randomUUID;
    this.sessions = new SerialQueue();
    this.closed = false;
  }

  options() {
    return {
      rules: this.config.continuationRules,
      maxTextChars: this.config.maxTextChars,
      defaultModel: this.host.defaultModel(),
      projections: this.ctx.sessions?.messageProjections ?? [],
    };
  }

  assertOpen() {
    if (this.closed) fail('closing', 'Session Edit is being unloaded.');
  }

  async inspect(input) {
    this.assertOpen();
    const request = parseRequest('inspect', input);
    const snapshot = await this.host.snapshot(request.sessionId);
    const { page, nextBeforeSeq } = selectMessagePage(snapshot.events, request);

    const continuation =
      !snapshot.ordinary || snapshot.archived || snapshot.status === 'running'
        ? {
            available: false,
            canSendPrompt: false,
            reason: !snapshot.ordinary
              ? 'owned-session'
              : snapshot.archived
                ? 'archived'
                : 'source-running',
          }
        : continuationPolicy(snapshot.events, this.options());

    return {
      sessionId: snapshot.header.id,
      title: titleOf(snapshot.events),
      status: snapshot.status,
      archived: snapshot.archived,
      ordinary: snapshot.ordinary,
      headSeq: snapshot.cursor,
      maxTextChars: this.config.maxTextChars,
      messages: page.map(event => {
        const text = textOf(event.data);
        const supported = isSupportedContent(event.data);
        const attachments = attachmentsOf(event.data);
        const editable =
          supported &&
          (Boolean(text.trim()) || attachments.length > 0) &&
          text.length <= this.config.maxTextChars &&
          snapshot.ordinary &&
          !snapshot.archived;
        return {
          eventSeq: event.seq,
          messageId: event.data.id,
          text,
          time: event.time,
          editable,
          ...(attachments.length ? { attachments } : {}),
          ...(editable
            ? {}
            : {
                reason: !snapshot.ordinary
                  ? 'owned-session'
                  : snapshot.archived
                    ? 'archived'
                    : !supported
                      ? 'message-not-editable'
                      : 'message-too-large',
              }),
        };
      }),
      nextBeforeSeq,
      continuation,
    };
  }

  async execute(input) {
    this.assertOpen();
    const command = parseRequest('execute', input);
    const options = {
      ...this.options(),
      ...(command.promptLocale ? { locale: command.promptLocale } : {}),
    };
    return this.sessions.run(command.sessionId, async () => {
      await this.host.requireCurrentFormat(command.sessionId);
      const snapshot = await this.host.snapshot(command.sessionId);
      const plan = planOperation(command, snapshot, options);

      if (command.action === 'continue') {
        const agent = await this.host.resolve(plan.sessionId);
        const activated = await this.host.snapshot(plan.sessionId);
        if (
          activated.events
            .slice(plan.headSeq + 1)
            .some(event => !SETUP_EVENTS.has(event.type))
        ) {
          fail('session-changed', 'The session changed during activation.');
        }
        planOperation(command, activated, options);
        if (plan.continuationMode === 'prompt') {
          this.host.submitPrompt(agent, plan.content, `session-edit-${this.newId()}`);
        } else {
          this.host.continueFromHistory(agent, agent.session.seq - 1);
        }
        await this.host.flush(agent);
        return { sourceSessionId: plan.sessionId };
      }

      const rewritten = await this.host.rewrite(snapshot, plan, this.now());
      try {
        const agent = await this.host.resolve(plan.sessionId);
        this.host.continueFromHistory(agent, agent.session.seq - 1);
        await this.host.syncTitle?.(agent, rewritten?.editedSeq);
        await this.host.flush(agent);
      } catch (error) {
        throw historyUpdatedFailure(error);
      }
      return { sourceSessionId: plan.sessionId, historyUpdated: true };
    });
  }

  async close() {
    this.closed = true;
    await this.sessions.close();
  }
}
