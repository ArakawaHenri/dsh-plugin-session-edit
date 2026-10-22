# dsh-session-edit

Edit and retry past messages in DeepSeek Harness sessions, and pick stopped
sessions back up where they left off. Built against DSH `0.2.1-rc.2`.

## What it does

- **Edit and branch** — keep the history before a chosen user message, then
  send a corrected version in a new branch session.
- **Retry** — same idea, resending the original message as-is.
- **Continue** — for sessions stopped by hand, cut short by an error, or hit
  with a token limit: either resume the model directly from existing history
  (no new message), or send a continuation prompt. The prompt wording follows
  the interface language and the reason the session stopped.

Message bubbles get edit/retry buttons; the session menu in the sidebar gets
a paginated history browser.

## Install

Add the repository in the DSH plugin manager and enable it:

```
https://github.com/ArakawaHenri/dsh-plugin-session-edit
```

Refresh the page afterwards.

## Configuration

Both settings are optional.

```yaml
- id: session-edit
  name: 'dsh-session-edit'
  config:
    maxTextChars: 131072
    continuationRules:
      - provider: your-provider-id
        model: your-model-id
        allow: false
```

`maxTextChars` caps the length of an edited message. `continuationRules`
turns off no-message continuation for specific models (`model: '*'` works as
a per-provider wildcard); sending a continuation prompt stays available
either way.

## Development

```
npm install
npm run build
npm run check
npm test
```

Browser tests need a local Chromium or Chrome.

## License

MIT
