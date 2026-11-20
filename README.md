# opencode-discord-upload

A native **OpenCode V2** plugin that formats session chatlogs into Markdown and
uploads them to a Discord webhook.

When a session goes idle or ends (or on demand), the plugin renders the full
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
  result as tool output.
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
| `webhookUrl` | unset | Discord webhook URL (or `OPENCODE_DISCORD_WEBHOOK`) |
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

Auto-upload triggers are mapped to OpenCode lifecycle events:

| Trigger | OpenCode event(s) |
|---|---|
| `quit` | `location.shutdown`, `session.deleted` |
| `new` | `session.idle` (a session that just finished a turn) |
| `reload` | `location.shutdown` |
| `resume` | `session.idle` |
| `fork` | `session.forked` |

You may also use direct aliases in `autoUploadTriggers`: `idle`, `deleted`,
`shutdown`, or a raw event name such as `session.idle`. Uploads are
deduplicated by session ID.

## Implementation notes

- **Commands and tools:** commands are registered via `ctx.command.transform`,
  and a `discord_upload` tool is provided via `ctx.tool.transform`.
- **Lifecycle events:** auto-upload is driven by `ctx.event.subscribe` and
  cleaned up when the plugin unloads.
- **Storage:** configuration and uploaded-session state use `ctx.storage`.
- **Feedback:** status is reported with `ctx.session.synthetic` (there is no
  server-side TUI notify surface).

## Known gaps / differences

- **Trigger timing:** auto-upload fires on the mapped lifecycle events above.
  Because each session is only uploaded once, a session that keeps being used
  after its first `session.idle` will not be re-uploaded with later messages;
  clear plugin state to force a refresh.
- **Feedback is a synthetic session message**, not a TUI toast/status widget.
  Synthetic messages are posted to the session and may appear in its later
  transcript.
- **Command arguments:** `set|clear|status|toggle|config` and session IDs are
  read from `prompt.text`. Argument completion is not available.
- **Session-file path argument:** upload targets are **session IDs** (not JSONL
  file paths).
- **Message formatting is duck-typed.** The formatter reads common OpenCode
  message/part fields defensively; unrecognised roles fall back to a labelled
  code block.

## License

MIT — Copyright (c) 2026 hakergeniusz.
