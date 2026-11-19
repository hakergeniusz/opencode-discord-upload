# opencode-discord-upload

A native **OpenCode V2** plugin that formats session chatlogs into Markdown and
uploads them to a Discord webhook. Rewritten from the Pi extension
[`pi-discord-upload`](https://github.com/hakergeniusz/pi-discord-upload).

When a session goes idle / ends (or on demand), the plugin renders the full
transcript — user and assistant messages, reasoning, tool calls and results,
model/agent changes and compaction summaries — and posts it to Discord as a
Markdown file attachment (or an inline message for short logs). Logs larger
than Discord's 8 MB file limit are split into multiple parts. Uploaded sessions
are recorded so they are not sent twice.

## What it does

- **`/discord-upload [sessionID]`** — upload the current session, or a session
  ID passed as the argument.
- **`/discord-webhook set|clear|status|toggle|config`** — manage the webhook URL
  and auto-upload setting.
- **`/discord-history [N]`** — backfill the `N` most recent unuploaded sessions
  (default 5).
- **`/discord-test`** — send a fixed test message to verify the webhook.
- **`discord_upload` tool** — lets the model trigger an upload and receive the
  result as tool output (an OpenCode-native addition; the Pi original had no
  tools).
- **Auto-upload** on configurable session lifecycle events.

## Install / load

This package is a single npm package with a server part (`.` →
`src/index.ts`). It uses only `@opencode/plugin` as a runtime dependency.

Published package — add it to `opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-discord-upload"]
}
```

Options use the object form:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-discord-upload",
      "options": {
        "username": "My Bot",
        "includeThinking": false,
        "autoUpload": true,
        "autoUploadTriggers": ["new", "quit"]
      }
    }
  ]
}
```

A local checkout can be loaded by path, e.g.
`"plugins": ["./projects/opencode-discord-upload"]`, or dropped into
`.opencode/plugins/`.

## Configuration

Precedence: **environment variable > saved config > `ctx.options` > defaults.**

| Key | Default | Description |
|---|---|---|
| `webhookUrl` | unset | Discord webhook URL (or `OPENCODE_DISCORD_WEBHOOK` / `PI_DISCORD_WEBHOOK`) |
| `autoUpload` | `true` | Auto-upload when a lifecycle trigger fires |
| `autoUploadTriggers` | `["quit", "new"]` | Lifecycle triggers that cause an auto-upload (see below) |
| `includeThinking` | `false` | Include model reasoning/thinking blocks |
| `includeSystemPrompt` | `true` | Include system/synthetic messages |
| `includeToolCalls` | `true` | Include tool calls and results |
| `username` | `"OpenCode Chatlog"` | Webhook display name |
| `avatarUrl` | unset | Optional webhook avatar URL |

Set the webhook through `/discord-webhook set <url>` or an environment
variable. Runtime changes made by commands are persisted in plugin-scoped
storage (`ctx.storage`), not in a JSON file.

### Auto-upload triggers

OpenCode V2 has no `session_shutdown` event, so the Pi shutdown reasons are
mapped to the closest OpenCode events:

| Pi reason | OpenCode event(s) |
|---|---|
| `quit` | `location.shutdown`, `session.deleted` |
| `new` | `session.idle` (a session that just finished a turn) |
| `reload` | `location.shutdown` |
| `resume` | `session.idle` |
| `fork` | `session.forked` |

You may also use the OpenCode-native aliases directly in `autoUploadTriggers`:
`idle`, `deleted`, `shutdown`, or a raw event name such as `session.idle`.
Uploads are deduplicated by session ID.

## Mapping from the Pi original

| Pi concept | OpenCode V2 equivalent used here |
|---|---|
| `pi.registerCommand(...)` | `ctx.command.transform((editor) => editor.add(...))` |
| `pi.on("session_shutdown", ...)` | `ctx.event.subscribe({ types, signal })` + cleanup function returned from `setup` |
| config/state JSON files | `ctx.storage.get/set` and `ctx.options` |
| `ctx.ui.notify(...)` | `ctx.session.synthetic({ sessionID, text })` (no server-side UI notify exists) |
| `ctx.sessionManager.getEntries()/getHeader()` | `ctx.session.context({ sessionID })` / `ctx.session.get({ sessionID })` |
| history over `sessions/*.jsonl` | `ctx.session.list({ directory, limit })` |
| argument completions | not available for commands (see gaps) |
| tool registration | added a `discord_upload` tool via `ctx.tool.transform` |

The Discord upload logic (inline threshold, file attachment, chunking,
timeouts, rate-limit delay, duplicate prevention, webhook masking) was ported
directly.

## Known gaps / differences

- **No `session_shutdown` event.** Auto-upload fires on the mapped lifecycle
  events above. Because each session is only uploaded once, a session that
  keeps being used after its first `session.idle` will not be re-uploaded with
  later messages; clear plugin state to force a refresh.
- **Feedback is a synthetic session message**, not a TUI toast/status widget,
  because the server plugin API has no `ui.notify`. Synthetic messages are
  posted to the session and may appear in its later transcript.
- **Command arguments:** `set|clear|status|toggle|config` and session IDs are
  read from `prompt.text`. Pi-style argument completions
  (`getArgumentCompletions`) have no OpenCode command equivalent and were
  dropped.
- **Session-file path argument:** the Pi `/discord-upload [file]` accepted a
  JSONL file path. OpenCode sessions are not files, so the argument is now a
  **session ID**. Arbitrary `.jsonl` parsing was intentionally not recreated.
- **Message formatting is duck-typed.** OpenCode's message/part schema differs
  from Pi's `SessionEntry`; the formatter reads common fields (`parts`, `text`,
  `reasoning`, tool `state`, `model.providerID/modelID`, epoch `time.created`)
  defensively. Unrecognised roles fall back to a labelled code block.
- **No TUI part** was added (the plugin is not TUI-focused).

## Tests

The Pi original included `bun:test` tests that drove a fake `ExtensionAPI`
(`registerCommand`, `on`, `ui.notify`, `sessionManager`). Those tests depend on
Pi's API and cannot be ported without reintroducing a Pi dependency, so they
were **not** ported. See the report for details.

## License

MIT — Copyright (c) 2026 hakergeniusz.
