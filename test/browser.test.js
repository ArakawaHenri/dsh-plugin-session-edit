import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { buildClientSource } from '../scripts/build-client.js';

const require = createRequire(import.meta.url);
const client = await buildClientSource();
const react = await readFile(
  join(dirname(require.resolve('react/package.json')), 'umd/react.development.js'),
);
const reactDom = await readFile(
  join(dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'),
);

let browser;
before(async () => {
  const candidates = [
    process.env.DSH_SESSION_EDIT_BROWSER,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  const executablePath = candidates.find(path => existsSync(path));
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
});
after(async () => {
  await browser?.close();
});

function bootFixture() {
  const React = window.React;
  const h = React.createElement;
  const fixture = (window.fixture = {
    slots: new Map(),
    navigation: [],
    factories: [],
    rpcCalls: [],
    disposers: [],
    session: { running: false, openState: 'ready' },
    listeners: new Set(),
  });
  window.__ModuleLoader__ = {
    load: entry => {
      fixture.entry = entry;
    },
  };
  fixture.start = async () => {
    let dictionaries;
    const services = new Map();
    const rpc = Object.fromEntries(
      ['inspect', 'execute'].map(method => [
        method,
        async request => {
          fixture.rpcCalls.push({ method, request });
          const response = await fetch(`/fixture/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          return response.json();
        },
      ]),
    );
    services.set('slots', {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        const key = `${options.name}:${options.key || options.id || ''}`;
        fixture.slots.set(key, { options, component });
        return () => fixture.slots.delete(key);
      },
    });
    services.set('locale', {
      register: (_namespace, values) => {
        dictionaries = values;
        return () => {};
      },
      bind: () => key => dictionaries.en[key],
      subscribe: () => () => {},
      getSnapshot: () => 'en',
    });
    services.set('remote', { $mount: async () => {} });
    services.set('remote.sessionEdit', rpc);
    services.set('uiWorkspace', {
      openSession: id => {
        fixture.navigation.push(id);
      },
    });
    services.set('uiSession', {});
    services.set('sessions', {});

    function context(names) {
      const ctx = {
        effect(callback) {
          const cleanup = callback();
          if (typeof cleanup === 'function') fixture.disposers.push(cleanup);
          return cleanup;
        },
        inject(dependencies, callback) {
          if (dependencies.every(name => services.has(name))) {
            return callback(context(dependencies));
          }
        },
      };
      for (const name of names) {
        if (!name.includes('.')) {
          Object.defineProperty(ctx, name, {
            get: () =>
              name === 'remote'
                ? { ...services.get('remote'), sessionEdit: services.get('remote.sessionEdit') }
                : services.get(name),
          });
        }
      }
      return ctx;
    }

    const plugin = fixture.entry.factory(name => {
      if (name === 'react') return React;
      throw new Error(`Unexpected module: ${name}`);
    });
    await plugin.apply(context(plugin.inject));

    const get = key => fixture.slots.get(key).component;
    const Menu = get('sidebar.workspaces.session.menu.item:dsh-session-edit.history');
    const User = get('conversation.chat.node:user');
    const Dock = get('conversation.composer.dock:dsh-session-edit.continue');
    const Overlay = get('shell.overlay:dsh-session-edit.dialog');
    const useSession = selector =>
      React.useSyncExternalStore(
        listener => {
          fixture.listeners.add(listener);
          return () => fixture.listeners.delete(listener);
        },
        () => selector(fixture.session),
      );
    const useRemoteAccess = () => true;
    const message = {
      kind: 'user',
      data: {
        seq: 7,
        time: 1760000000000,
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Original selected input' }],
        referenceLabels: ['Source A'],
        skillNames: ['sample'],
      },
    };
    function factory(name, props) {
      fixture.factories.push({
        name,
        content: props.content,
        facts: props.facts,
        interactive: props.interactive,
      });
      return h(
        'section',
        { 'data-testid': 'native-user-factory' },
        props.content.text,
        ...props.content.attachments.map((attachment, index) =>
          h('span', { key: index, 'data-attachment-type': attachment.type }, attachment.type),
        ),
        ...props.content.extraBlocks.map((block, index) =>
          h('code', { key: index }, JSON.stringify(block)),
        ),
      );
    }
    function App() {
      return h(
        'main',
        null,
        h(Menu, {
          sessionId: 'source',
          displayTitle: 'Source',
          useRemoteAccess,
          useMenuOpenState: () => React.useState(false),
        }),
        h(User, {
          sessionId: 'source',
          node: message,
          useSession,
          useRemoteAccess,
          renderFactorySlot: factory,
          loadImage: async () => null,
        }),
        h(Dock, { sessionId: 'source', useSession, useRemoteAccess }),
        h(Overlay),
      );
    }
    fixture.root = window.ReactDOM.createRoot(document.getElementById('root'));
    fixture.root.render(h(App));
    fixture.setContent = content => {
      message.data = { ...message.data, content };
      fixture.root.render(h(App));
    };
    fixture.setRunning = running => {
      fixture.session = { ...fixture.session, running };
      for (const listener of fixture.listeners) listener();
    };
    fixture.ready = true;
  };
}

async function fixture(t, options = {}) {
  const state = {
    calls: [],
    continuationAvailable: true,
    reason: undefined,
    ...options,
  };
  const facts = {
    sessionId: 'source',
    title: 'Source conversation',
    status: 'idle',
    archived: false,
    ordinary: true,
    headSeq: 80,
    messages: [
      {
        eventSeq: 40,
        messageId: 'message-40',
        text: 'Newest user input',
        time: 1760000000000,
        editable: true,
      },
    ],
    nextBeforeSeq: 40,
    continuation: {
      available: state.continuationAvailable,
      canSendPrompt: true,
      tailRole: 'assistant',
      reason: state.reason,
    },
  };
  const selected = {
    eventSeq: 7,
    messageId: 'message-7',
    text: 'Original selected input',
    time: 1750000000000,
    editable: true,
  };
  const assets = {
    '/react.js': react,
    '/react-dom.js': reactDom,
    '/client.js': client,
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (assets[url.pathname]) {
        response.setHeader('content-type', 'text/javascript');
        response.end(assets[url.pathname]);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname === '/') {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px sans-serif;padding:20px}main{max-width:900px;margin:auto}</style></head><body><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>(${bootFixture.toString()})();</script><script src="/client.js"></script><script>fixture.start();</script></body></html>`,
        );
        return;
      }
      const method = url.pathname.slice('/fixture/'.length);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      state.calls.push({ method, input });
      let value;
      if (method === 'inspect') {
        value =
          input.eventSeq !== undefined || input.beforeSeq !== undefined
            ? { ...facts, nextBeforeSeq: null, messages: [selected] }
            : facts;
      }
      if (method === 'execute') {
        if (state.rejectExecute) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: false, error: state.rejectExecute }));
          return;
        }
        if (state.executeGate) await state.executeGate.promise;
        value = { sourceSessionId: 'source', childSessionId: 'fixture-child' };
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, value }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    state.executeGate?.resolve();
    await context.close();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.fixture?.ready);
  await page.getByTestId('native-user-factory').waitFor();
  return { page, state, facts, origin };
}

test('browser: editing uses one dialog and one submit while retaining the native body', async t => {
  const { page, state } = await fixture(t);
  const body = await page.evaluate(() => fixture.factories.at(-1));
  assert.equal(body.name, 'conversation.chat.user.content');
  assert.deepEqual(body.facts, { sessionLabels: ['Source A'], skillNames: ['sample'] });
  await page.getByRole('button', { name: 'Edit and branch', exact: true }).click();
  await page.getByTestId('execute-action').waitFor();
  await page.getByTestId('edit-text').fill('Changed message\nwith two lines');
  await page.getByTestId('execute-action').evaluate(button => {
    button.click();
    button.click();
  });
  await page.waitForFunction(() => fixture.navigation.length === 1);
  const writes = state.calls.filter(call => call.method === 'execute');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].input, {
    sessionId: 'source',
    action: 'edit-fork',
    eventSeq: 7,
    messageId: 'message-7',
    replacementText: 'Changed message\nwith two lines',
  });
  assert.ok(state.calls.some(call => call.method === 'inspect' && call.input.eventSeq === 7));
  assert.equal(await page.getByTestId('session-edit-dialog').count(), 0);
  assert.equal(await page.getByTestId('native-user-factory').textContent(), 'Original selected input');
});

test('browser: history fallback pages then retries in one click even while the parent is running', async t => {
  const { page, state, facts } = await fixture(t);
  facts.status = 'running';
  await page.evaluate(() => fixture.setRunning(true));
  await page.getByTestId('session-edit-menu').click();
  await page.getByTestId('load-older').click();
  const item = page.locator('[data-event-seq="7"]');
  await item.waitFor();
  await item.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => fixture.navigation.length === 1);
  const command = state.calls.find(call => call.method === 'execute').input;
  assert.deepEqual(command, {
    sessionId: 'source',
    action: 'retry-fork',
    eventSeq: 7,
    messageId: 'message-7',
  });
  assert.equal(
    state.calls.some(call => call.method === 'inspect' && call.input.eventSeq !== undefined),
    false,
  );
  assert.equal(await page.getByTestId('session-edit-dialog').count(), 0);
});

test('browser: available continuation is one click and never adds prompt text', async t => {
  const { page, state } = await fixture(t);
  await page
    .getByTestId('session-edit-continue')
    .getByRole('button', { name: 'Continue task', exact: true })
    .click();
  await page.waitForFunction(() => fixture.navigation.length === 1);
  const command = state.calls.find(call => call.method === 'execute').input;
  assert.deepEqual(command, {
    sessionId: 'source',
    action: 'continue',
    continuationMode: 'no-message',
  });
  assert.equal(await page.getByTestId('session-edit-dialog').count(), 0);
});

test('browser: disabled direct continuation keeps an explicit one-click prompt action', async t => {
  const { page, state } = await fixture(t, {
    continuationAvailable: false,
    reason: 'model-disabled',
  });
  const dock = page.getByTestId('session-edit-continue');
  await dock.waitFor();
  assert.equal(await dock.getByRole('button', { name: 'Continue task', exact: true }).isDisabled(), true);
  await dock.getByRole('button', { name: 'Send continuation message', exact: true }).click();
  await page.waitForFunction(() => fixture.navigation.length === 1);
  assert.equal(state.calls.find(call => call.method === 'execute').input.continuationMode, 'prompt');
  assert.equal(state.calls.filter(call => call.method === 'execute').length, 1);
});

test('browser: a forbidden response shows an alert banner', async t => {
  const { page } = await fixture(t, {
    rejectExecute: { code: 'session-edit/forbidden', message: 'Only owner' },
  });
  await page.getByRole('button', { name: 'Retry this message', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Only the host owner' }).waitFor();
});

test('browser: unsupported message content is preserved by the native Factory', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() =>
    fixture.setContent([
      { type: 'text', text: 'With attachment' },
      { type: 'image', attachment: { id: 'image-1', name: 'image.png' } },
      { type: 'file', attachment: { id: 'file-1', name: 'file.txt', bytes: 12 } },
    ]),
  );
  await page.locator('[data-attachment-type="image"]').waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Edit and branch', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Retry this message', exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual(await page.evaluate(() => fixture.factories.at(-1).content.attachments), [
    { type: 'image', image: { attachment: { id: 'image-1', name: 'image.png' } } },
    { type: 'file', file: { id: 'file-1', name: 'file.txt', bytes: 12 } },
  ]);
});
