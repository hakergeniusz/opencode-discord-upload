/**
 * opencode-discord-upload — native OpenCode V2 plugin.
 *
 * Rewritten from the pi extension `pi-discord-upload`. It formats OpenCode
 * session transcripts into Markdown and posts them to a Discord webhook:
 *
 * - `/discord-upload [sessionID]` uploads the current (or a given) session.
 * - `/discord-webhook set|clear|status|toggle|config` manages configuration.
 * - `/discord-history [N]` backfills the N most recent unuploaded sessions.
 * - `/discord-test` sends a test message.
 * - Auto-upload on configurable session lifecycle events.
 * - A `discord_upload` tool lets the model trigger an upload as well.
 *
 * Feedback is delivered as synthetic session messages (the OpenCode server
 * plugin API has no `ui.notify` / TUI toast surface). See README for the
 * mapping from the pi original and the known gaps.
 */

import { Plugin } from "@opencode/plugin"
import {
  isUploaded,
  loadConfig,
  loadState,
  markUploaded,
  saveConfig,
  webhookFromEnv,
  webhookSource,
} from "./config"
import { uploadToDiscord } from "./discord"
import { collectSessionInfo, formatChatlog } from "./format"
import type {
  CommandInvocation,
  DiscordConfig,
  DiscordUploadResult,
  PluginEnv,
} from "./types"

const RATE_LIMIT_DELAY_MS = 1_500

/** Map pi shutdown reasons to the closest OpenCode V2 event names. */
const TRIGGER_EVENTS: Record<string, string[]> = {
  quit: ["location.shutdown", "session.deleted"],
  new: ["session.idle"],
  reload: ["location.shutdown"],
  resume: ["session.idle"],
  fork: ["session.forked"],
  // OpenCode-native aliases accepted directly in `autoUploadTriggers`:
  idle: ["session.idle"],
  deleted: ["session.deleted"],
  shutdown: ["location.shutdown"],
}

const ALL_EVENTS = Array.from(
  new Set([
    ...Object.values(TRIGGER_EVENTS).flat(),
    "session.created",
    "session.deleted",
    "session.idle",
    "session.forked",
    "location.shutdown",
  ]),
)

function asEnv(ctx: any): PluginEnv {
  return ctx as PluginEnv
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function toFormatOptions(config: DiscordConfig) {
  return {
    includeThinking: config.includeThinking ?? false,
    includeSystemPrompt: config.includeSystemPrompt ?? true,
    includeToolCalls: config.includeToolCalls ?? true,
  }
}

function activeWebhook(config: DiscordConfig): string | undefined {
  return webhookFromEnv() ?? config.webhookUrl
}

/** Post a short user-visible status line into the session. */
async function notify(env: PluginEnv, sessionID: string | undefined, text: string): Promise<void> {
  if (!sessionID || !text) return
  try {
    await env.session.synthetic({ sessionID, text })
  } catch (err) {
    console.error("[opencode-discord-upload] notify failed:", err)
  }
}

function summarizeResults(results: DiscordUploadResult[]): { ok: boolean; text: string } {
  if (results.length === 0) {
    return { ok: false, text: "Upload produced no results." }
  }
  const ok = results.every((r) => r.success)
  if (ok) {
    const urls = results.map((r) => r.messageUrl).filter(Boolean) as string[]
    const suffix = urls.length ? `\n${urls[0]}` : ""
    return {
      ok: true,
      text: `Chatlog uploaded to Discord ✓${suffix}`,
    }
  }
  const errors = results
    .filter((r) => !r.success)
    .map((r) => r.error)
    .filter(Boolean)
    .join("; ")
  return { ok: false, text: `Upload failed: ${errors || "unknown error"}` }
}

interface UploadOutcome {
  ok: boolean
  results: DiscordUploadResult[]
  error?: string
}

/** Format, upload and (on success) record a single session. */
async function uploadSession(
  env: PluginEnv,
  sessionID: string,
  config: DiscordConfig,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const webhook = activeWebhook(config)
  if (!webhook) {
    return { ok: false, results: [], error: "webhook not configured" }
  }

  let session: Record<string, any>
  let messages: readonly any[]
  try {
    session = ((await env.session.get({ sessionID })) ?? {}) as Record<string, any>
    messages = await env.session.context({ sessionID })
  } catch (err) {
    return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) }
  }

  if (!messages || messages.length === 0) {
    return { ok: false, results: [], error: "session has no entries to upload" }
  }

  const cwd = env.location.directory ?? ""
  const content = formatChatlog(messages, session, toFormatOptions(config), cwd)
  const info = collectSessionInfo(messages, session, cwd)
  info.sessionId = sessionID

  const results = await uploadToDiscord(content, info, config, webhook, signal)
  const ok = results.length > 0 && results.every((r) => r.success)
  if (ok) {
    await markUploaded(env, sessionID, {
      timestamp: new Date().toISOString(),
      filename: results.map((r) => r.filename).filter(Boolean).join(", "),
      messageUrl: (results.map((r) => r.messageUrl).filter(Boolean) as string[]).join(", "),
      fileSize: results.reduce((sum, r) => sum + r.fileSize, 0),
    })
  }
  return { ok, results }
}

async function autoUpload(
  env: PluginEnv,
  sessionID: string,
  config: DiscordConfig,
  signal?: AbortSignal,
): Promise<void> {
  if (!config.autoUpload) return
  if (!activeWebhook(config)) return
  if (await isUploaded(env, sessionID)) return

  try {
    const outcome = await uploadSession(env, sessionID, config, signal)
    if (outcome.error === "session has no entries to upload") return
    const summary = outcome.results.length
      ? summarizeResults(outcome.results)
      : { ok: false, text: `Chatlog upload failed: ${outcome.error ?? "unknown"}` }
    await notify(env, sessionID, summary.text)
  } catch (err) {
    console.error("[opencode-discord-upload] auto-upload failed:", err)
  }
}

function enabledEvents(config: DiscordConfig): Set<string> {
  const events = new Set<string>()
  for (const trigger of config.autoUploadTriggers ?? []) {
    for (const event of TRIGGER_EVENTS[trigger] ?? (trigger.startsWith("session.") || trigger === "location.shutdown" ? [trigger] : [])) {
      events.add(event)
    }
  }
  return events
}

function extractSessionID(event: any): string | undefined {
  const p = event?.properties ?? event?.payload ?? event
  const id = p?.sessionID ?? p?.newSessionID ?? p?.session?.id ?? p?.id
  return typeof id === "string" && id ? id : undefined
}

// ─── Command handlers ───────────────────────────────────────────────────────

async function handleUpload(
  env: PluginEnv,
  inv: CommandInvocation,
  args: string,
  signal?: AbortSignal,
): Promise<void> {
  const config = await loadConfig(env)
  if (!activeWebhook(config)) {
    await notify(
      env,
      inv.sessionID,
      "Discord webhook not configured. Set OPENCODE_DISCORD_WEBHOOK (or PI_DISCORD_WEBHOOK) or use `/discord-webhook set <url>`.",
    )
    return
  }

  let sessionID = inv.sessionID
  const arg = args.trim()
  if (arg) {
    try {
      const target = await env.session.get({ sessionID: arg })
      if (target?.id) sessionID = arg
      else {
        await notify(env, inv.sessionID, `Session not found: ${arg}`)
        return
      }
    } catch {
      await notify(env, inv.sessionID, `Session not found: ${arg}`)
      return
    }
  }

  if (await isUploaded(env, sessionID)) {
    await notify(
      env,
      inv.sessionID,
      "Session already uploaded. Clear plugin state or upload a different session.",
    )
    return
  }

  const outcome = await uploadSession(env, sessionID, config, signal)
  if (outcome.error === "session has no entries to upload") {
    await notify(env, inv.sessionID, "Session has no entries to upload")
    return
  }
  await notify(env, inv.sessionID, summarizeResults(outcome.results).text)
}

function maskWebhook(url: string): string {
  if (!url.startsWith("https://")) return url
  return url.replace(/^(\S+\/webhooks\/\d+\/).+$/, "$1****************")
}

async function handleWebhook(
  env: PluginEnv,
  inv: CommandInvocation,
  args: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0]?.toLowerCase() ?? "status"
  const config = await loadConfig(env)

  switch (sub) {
    case "set": {
      const url = parts.slice(1).join(" ")
      if (!url) {
        await notify(env, inv.sessionID, "Usage: `/discord-webhook set <url>`")
        return
      }
      if (!/^https:\/\/discord\.com\/api\/webhooks\/\d+\/.+/.test(url)) {
        await notify(
          env,
          inv.sessionID,
          "Invalid Discord webhook URL. Expected: `https://discord.com/api/webhooks/...`",
        )
        return
      }
      await saveConfig(env, { webhookUrl: url })
      await notify(env, inv.sessionID, "Discord webhook URL saved ✓")
      return
    }
    case "clear": {
      await saveConfig(env, { webhookUrl: undefined })
      await notify(env, inv.sessionID, "Webhook URL cleared")
      return
    }
    case "toggle": {
      const next = !(await loadConfig(env)).autoUpload
      await saveConfig(env, { autoUpload: next })
      await notify(env, inv.sessionID, `Auto-upload: ${next ? "enabled ✓" : "disabled"}`)
      return
    }
    case "config": {
      await notify(env, inv.sessionID, `\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``)
      return
    }
    case "status":
    default: {
      if (sub !== "status") {
        await notify(
          env,
          inv.sessionID,
          "Usage: `/discord-webhook set <url> | clear | status | toggle | config`",
        )
        return
      }
      const webhook = activeWebhook(config)
      if (!webhook) {
        await notify(
          env,
          inv.sessionID,
          "Webhook URL not configured. Set `OPENCODE_DISCORD_WEBHOOK` or use `/discord-webhook set <url>`.",
        )
        return
      }
      await notify(
        env,
        inv.sessionID,
        `Webhook: ${maskWebhook(webhook)}\nSource: ${webhookSource(env)}\nAuto-upload: ${config.autoUpload ? "enabled" : "disabled"}`,
      )
    }
  }
}

function extractSessions(page: any): any[] {
  if (Array.isArray(page)) return page
  if (Array.isArray(page?.sessions)) return page.sessions
  if (Array.isArray(page?.data)) return page.data
  return []
}

async function handleHistory(
  env: PluginEnv,
  inv: CommandInvocation,
  args: string,
  signal?: AbortSignal,
): Promise<void> {
  const config = await loadConfig(env)
  if (!activeWebhook(config)) {
    await notify(env, inv.sessionID, "Discord webhook not configured. Use `/discord-webhook set <url>`.")
    return
  }

  const limit = parseInt(args.trim().split(/\s+/)[0] || "5", 10) || 5
  let page: any
  try {
    page = await env.session.list({ directory: env.location.directory, limit: limit * 5 })
  } catch (err) {
    await notify(env, inv.sessionID, `Could not list sessions: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const state = await loadState(env)
  const unuploaded = extractSessions(page)
    .map((s) => (typeof s?.id === "string" ? s.id : undefined))
    .filter((id): id is string => !!id && !state.uploadedSessions[id])
    .slice(0, limit)

  if (unuploaded.length === 0) {
    await notify(env, inv.sessionID, "No unuploaded session logs found")
    return
  }

  let successCount = 0
  let failCount = 0
  for (let i = 0; i < unuploaded.length; i++) {
    if (signal?.aborted) break
    try {
      const outcome = await uploadSession(env, unuploaded[i], config, signal)
      if (outcome.ok) successCount++
      else failCount++
    } catch {
      failCount++
    }
    if (i < unuploaded.length - 1) await sleep(RATE_LIMIT_DELAY_MS, signal)
  }

  await notify(
    env,
    inv.sessionID,
    `Uploaded ${successCount}/${unuploaded.length} sessions to Discord (${failCount} failed)`,
  )
}

async function handleTest(env: PluginEnv, inv: CommandInvocation): Promise<void> {
  const config = await loadConfig(env)
  const webhook = activeWebhook(config)
  if (!webhook) {
    await notify(env, inv.sessionID, "Discord webhook not configured. Use `/discord-webhook set <url>`.")
    return
  }
  const payload = {
    content: "**opencode-discord-upload test**\nWebhook is working ✓",
    username: config.username || "OpenCode Chatlog",
    ...(config.avatarUrl ? { avatar_url: config.avatarUrl } : {}),
  }
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    })
    if (response.ok) {
      const data = await response.json().catch(() => ({}))
      await notify(
        env,
        inv.sessionID,
        `Discord webhook test successful! ✓${data.url ? `\n${data.url}` : ""}`,
      )
    } else {
      await notify(
        env,
        inv.sessionID,
        `Webhook test failed: HTTP ${response.status}: ${await response.text()}`,
      )
    }
  } catch (err) {
    await notify(env, inv.sessionID, `Webhook test error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── Plugin definition ───────────────────────────────────────────────────────

export default Plugin.define({
  id: "opencode-discord-upload",
  async setup(ctx) {
    const env = asEnv(ctx)
    const activeSessions = new Set<string>()

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "discord-upload",
        description: "Upload an OpenCode chatlog to Discord via webhook",
        execute: async ({ sessionID, prompt }: CommandInvocation) => {
          await handleUpload(env, { sessionID, prompt, delivery: "steer" }, prompt.text ?? "")
        },
      })
      editor.add({
        name: "discord-webhook",
        description: "Configure the Discord webhook URL for opencode-discord-upload",
        execute: async ({ sessionID, prompt }: CommandInvocation) => {
          await handleWebhook(env, { sessionID, prompt, delivery: "steer" }, prompt.text ?? "")
        },
      })
      editor.add({
        name: "discord-history",
        description: "Upload unuploaded OpenCode sessions to Discord (default: 5 most recent)",
        execute: async ({ sessionID, prompt }: CommandInvocation) => {
          await handleHistory(env, { sessionID, prompt, delivery: "steer" }, prompt.text ?? "")
        },
      })
      editor.add({
        name: "discord-test",
        description: "Send a test message to verify the Discord webhook is working",
        execute: async ({ sessionID }: CommandInvocation) => {
          await handleTest(env, { sessionID, prompt: { text: "" }, delivery: "steer" })
        },
      })
    })

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "discord_upload",
        description:
          "Upload the current OpenCode session (or a given session ID) as a Markdown chatlog to the configured Discord webhook.",
        input: {
          type: "object",
          properties: {
            sessionID: {
              type: "string",
              description: "Optional session ID. Defaults to the current session.",
            },
          },
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input: { sessionID?: string }, context: { sessionID: string; signal: AbortSignal }) => {
          const config = await loadConfig(env)
          if (!activeWebhook(config)) return { content: "Discord webhook not configured." }
          const target = input?.sessionID || context.sessionID
          if (await isUploaded(env, target)) return { content: "Session already uploaded." }
          const outcome = await uploadSession(env, target, config, context.signal)
          if (outcome.error === "session has no entries to upload") {
            return { content: "Session has no entries to upload." }
          }
          return { content: summarizeResults(outcome.results).text }
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of env.event.subscribe({
        types: ALL_EVENTS,
        signal: controller.signal,
      })) {
        try {
          const config = await loadConfig(env)
          const sid = extractSessionID(event)
          if (sid) activeSessions.add(sid)

          if (event.type === "location.shutdown") {
            if (!config.autoUpload) continue
            for (const sessionID of activeSessions) {
              if (controller.signal.aborted) break
              await autoUpload(env, sessionID, config, controller.signal)
            }
            continue
          }

          if (!config.autoUpload) continue
          if (!enabledEvents(config).has(event.type)) continue
          if (sid) await autoUpload(env, sid, config, controller.signal)
        } catch (err) {
          console.error("[opencode-discord-upload] event handler failed:", err)
        }
      }
    })()

    // Cleanup on plugin unload: stop the event stream.
    return () => controller.abort()
  },
})
