# dsh-session-edit

Edit and regenerate past messages in DeepSeek Harness sessions, and pick stopped
sessions back up where they left off. Built against DSH `0.2.1-rc.2`.

## What it does

- **Edit and regenerate** — update a chosen user message in the same session,
  remove the conversation after it, then regenerate from the corrected history.
  The session ID, workspace, name, existing image/file attachments, and current
  model selection stay in place.
- **Retry** — regenerate from the selected message without changing its text,
  also in the same session.
- **Continue** — for sessions stopped by hand, cut short by an error, or hit
  with a token limit: either resume the model directly from existing history
  (no new message), or send a continuation prompt (`继续` / `continue`).

Message actions use DSH's native icons and tooltips. Editing opens the native
inline editor at the selected message, with **Cancel** and **Save and regenerate**.
The session menu also has a paginated history browser with inline editing.

After a resumable stop, the empty composer's primary button becomes **Continue**.
Typing text or adding attachments restores the native send action; running
sessions retain DSH's stop, queue, and steering behavior. **Send continuation
message** is available in the continuation options menu below the composer.

History editing currently uses DSH's local JSONL storage, including compressed
logs. The replacement is validated and written atomically under the session's
write lock. Previously executed tool actions and filesystem changes are not
rolled back; this operation replaces conversation history.

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
