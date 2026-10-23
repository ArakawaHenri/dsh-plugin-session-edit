// Shared with the browser build (bundled by esbuild; no self-containment constraint).
export function remoteContribution() {
  const packageName = 'dsh-session-edit';

  const expectObject = (value, allowed) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Expected an object.');
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) throw new TypeError(`Unexpected field: ${key}`);
    }
    return value;
  };

  const expectString = (value, name, max = 512) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
      throw new TypeError(`Invalid ${name}.`);
    }
    return value;
  };

  const expectSeq = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError(`Invalid ${name}.`);
    }
    return value;
  };

  const parse = (method, input) => {
    if (method === 'inspect') {
      const value = expectObject(input, ['sessionId', 'eventSeq', 'beforeSeq', 'limit']);
      const output = { sessionId: expectString(value.sessionId, 'sessionId') };
      if (value.eventSeq !== undefined) output.eventSeq = expectSeq(value.eventSeq, 'eventSeq');
      if (value.beforeSeq !== undefined) output.beforeSeq = expectSeq(value.beforeSeq, 'beforeSeq');
      if (value.eventSeq !== undefined && value.beforeSeq !== undefined) {
        throw new TypeError('Cannot specify both eventSeq and beforeSeq.');
      }
      if (value.limit !== undefined) {
        if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100) {
          throw new TypeError('limit must be between 1 and 100.');
        }
        output.limit = value.limit;
      }
      return output;
    }

    const value = expectObject(input, [
      'sessionId',
      'action',
      'eventSeq',
      'messageId',
      'replacementText',
      'continuationMode',
      'promptLocale',
    ]);
    const output = {
      sessionId: expectString(value.sessionId, 'sessionId'),
      action: value.action,
    };
    if (!['edit', 'retry', 'continue'].includes(value.action)) {
      throw new TypeError('Invalid action.');
    }
    if (value.action === 'continue') {
      if (value.eventSeq !== undefined || value.messageId !== undefined || value.replacementText !== undefined) {
        throw new TypeError('Continuation does not accept message target fields.');
      }
      output.continuationMode = value.continuationMode ?? 'no-message';
      if (!['no-message', 'prompt'].includes(output.continuationMode)) {
        throw new TypeError('Invalid continuationMode.');
      }
      if (value.promptLocale !== undefined) {
        if (output.continuationMode !== 'prompt') {
          throw new TypeError('promptLocale requires continuationMode "prompt".');
        }
        if (!['en', 'zh'].includes(value.promptLocale)) {
          throw new TypeError('Invalid promptLocale.');
        }
        output.promptLocale = value.promptLocale;
      }
    } else {
      if (value.continuationMode !== undefined || value.promptLocale !== undefined) {
        throw new TypeError('Only continuation accepts continuationMode or promptLocale.');
      }
      output.eventSeq = expectSeq(value.eventSeq, 'eventSeq');
      output.messageId = expectString(value.messageId, 'messageId');
      if (value.action === 'edit') {
        output.replacementText = expectString(value.replacementText, 'replacementText', 131072);
      } else if (value.replacementText !== undefined) {
        throw new TypeError('Retry uses the original message content.');
      }
    }
    return output;
  };

  const idSchema = { type: 'string', minLength: 1, maxLength: 512 };
  const seqSchema = { type: 'integer', minimum: 0 };
  const shapes = {
    inspect: {
      properties: {
        sessionId: idSchema,
        eventSeq: seqSchema,
        beforeSeq: seqSchema,
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['sessionId'],
    },
    execute: {
      properties: {
        sessionId: idSchema,
        action: { enum: ['edit', 'retry', 'continue'] },
        eventSeq: seqSchema,
        messageId: idSchema,
        replacementText: { type: 'string', minLength: 1, maxLength: 131072 },
        continuationMode: { enum: ['no-message', 'prompt'] },
        promptLocale: { enum: ['en', 'zh'] },
      },
      required: ['sessionId', 'action'],
    },
  };

  return {
    package: packageName,
    descriptors: Object.entries(shapes).map(([method, schema]) => ({
      id: `${packageName}#sessionEdit/${method}`,
      service: 'sessionEdit',
      namespace: 'sessionEdit',
      method,
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${packageName}#${method}Request`,
            create: () => ({ parse: input => parse(method, input) }),
            jsonSchema: {
              type: 'object',
              additionalProperties: false,
              properties: schema.properties,
              required: schema.required,
            },
          },
        },
      ],
      result: { mode: 'src-json' },
    })),
  };
}

const PARSERS = new Map(
  remoteContribution().descriptors.map(item => [item.method, item.parameters[0].codec.create().parse]),
);

export function parseRequest(method, request) {
  const parse = PARSERS.get(method);
  if (!parse) throw new TypeError('Unknown session-edit method.');
  return parse(request);
}
