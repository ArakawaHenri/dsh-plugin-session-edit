import z from '@deepseek-ai/schemastery';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { remoteContribution } from './remote.js';
import { SessionEditEngine } from './lib/service.js';
import { assertRuntime } from './lib/host-adapter.js';
import { SessionEditError, publicFailure } from './lib/errors.js';

export const name = 'dsh-session-edit';
export const inject = [
  'typert',
  'sessionController',
  'sessionQuery',
  'sessions',
  'agents',
  'sessionPersistence',
  'workspaceRegistry',
];

export const Config = z.object({
  maxTextChars: z.natural().min(1).max(131072).default(131072),
});

export class SessionEditService extends TypertRemoteService {
  constructor(ctx, engine) {
    super(ctx, 'sessionEdit');
    this.engine = engine;
  }

  async invoke(method, request) {
    const invocation = this.ctx.invocation;
    if (invocation && invocation.peer.principal.kind !== 'owner') {
      throw new RemoteError(
        'session-edit/forbidden',
        'Only the host owner may inspect or change session history.',
        {},
      );
    }
    try {
      return await this.engine[method](request);
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      if (error instanceof TypeError) throw new RemoteError('gateway/bad-request', error.message, {});
      const failure = publicFailure(error);
      throw new RemoteError(
        failure.code,
        failure.message,
        error instanceof SessionEditError ? error.data : {},
      );
    }
  }

  inspect(request) {
    return this.invoke('inspect', request);
  }

  execute(request) {
    return this.invoke('execute', request);
  }
}

export async function apply(ctx, config = Config({})) {
  assertRuntime();
  const engine = new SessionEditEngine(ctx, config);
  try {
    ctx.effect(() => () => engine.close(), 'sessionEdit.lifecycle');
    new SessionEditService(ctx, engine);
    const contribution = remoteContribution();
    ctx.typert.register({
      package: contribution.package,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: contribution.descriptors,
    });
  } catch (error) {
    await engine.close();
    throw error;
  }
}
