# dsh-session-edit

Edit and regenerate past messages in DeepSeek Harness sessions, and pick stopped
sessions back up where they left off. Tested against DSH `0.2.1-rc.2`.

## What it does

- **Edit and regenerate** — update a chosen user message in the same session,
  remove the conversation after it, then regenerate from the corrected history.
  The session ID, workspace, name, existing image/file attachments, and current
  model selection stay in place.
- **Retry** — regenerate from the selected message without changing its text,
  also in the same session.
- **Continue** — for sessions stopped by hand, cut short by an error, or hit
  with a token limit, resume the model directly from existing history without
  adding a new user message.

Message actions use DSH's native icons and tooltips. Editing opens the native
inline editor at the selected message, with **Cancel** and **Regenerate**.

After a resumable stop, the empty composer's primary button becomes **Continue**.
Typing text or adding attachments restores the native send action; running
sessions retain DSH's stop, queue, and steering behavior.

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

## Compatibility

The DSH engine and peer requirements are `>=0.2.1-rc.2`, with no upper version
limit. DSH includes prereleases in its engine check, so later RCs are also
admitted. Newer releases can run while the host interfaces used here remain
compatible; they are not automatically considered tested.

Checks happen when an operation needs them. Editing and retrying require session
format v4, the JSONL writer/encoder, and ordered agent teardown. These requirements
do not block plugin startup, inspection, or native continuation. Continuation
checks the agent's wake and lifecycle hooks; the UI checks its native projection
reload interfaces. A missing capability reports an error for that operation.

## Development

```
npm ci
npm run build
npm run check
npm test
```

DSH development dependencies stay pinned to `0.2.1-rc.2`; the lockfile fixes the
test environment independently of the runtime version ranges. `npm run check`
also checks that those ranges admit later stable and RC versions using DSH's
prerelease policy. Browser tests need a local Chromium or Chrome.

## License

MIT
