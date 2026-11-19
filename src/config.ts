/**
 * Configuration and persisted-state management.
 *
 * In the pi original these lived in JSON files under the agent directory.
 * OpenCode V2 plugins get durable, plugin-scoped JSON storage through
 * `ctx.storage`, and static configuration through `ctx.options` (the object
 * form of a `plugins` entry in opencode.json(c)). An environment variable
 * still overrides the saved webhook URL.
 */

import { DEFAULT_CONFIG } from "./types"
import type { DiscordConfig, DiscordState, PluginEnv } from "./types"

const CONFIG_KEY = "config"
const STATE_KEY = "state"

/** Env override for the webhook, matching the pi original plus an OpenCode-native name. */
const WEBHOOK_ENV_VARS = ["OPENCODE_DISCORD_WEBHOOK", "PI_DISCORD_WEBHOOK"]

export function webhookFromEnv(): string | undefined {
  for (const name of WEBHOOK_ENV_VARS) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

/**
 * Merge, in increasing priority: defaults < ctx.options < saved config < env.
 * Only known keys are copied so stray option keys cannot leak into storage.
 */
export async function loadConfig(env: PluginEnv): Promise<DiscordConfig> {
  const saved = ((await env.storage.get(CONFIG_KEY)) ?? {}) as Partial<DiscordConfig>
  const options = (env.options ?? {}) as Record<string, unknown>

  const merged: DiscordConfig = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof DiscordConfig)[]) {
    const fromOptions = options[key]
    const fromSaved = saved[key]
    if (fromOptions !== undefined) (merged as any)[key] = fromOptions
    if (fromSaved !== undefined) (merged as any)[key] = fromSaved
  }

  const envWebhook = webhookFromEnv()
  if (envWebhook) merged.webhookUrl = envWebhook

  return merged
}

/** Persist runtime changes (webhook set/clear, auto-upload toggle). */
export async function saveConfig(
  env: PluginEnv,
  changes: Partial<DiscordConfig>,
): Promise<DiscordConfig> {
  const saved = ((await env.storage.get(CONFIG_KEY)) ?? {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete saved[key]
    else saved[key] = value
  }
  await env.storage.set(CONFIG_KEY, saved)
  return loadConfig(env)
}

export function webhookSource(env: PluginEnv): "env var" | "config" | "none" {
  const name = WEBHOOK_ENV_VARS.find((n) => !!process.env[n])
  if (name) return "env var"
  // Saved config or plugin options both count as configured "config" source.
  if (env.options?.webhookUrl) return "config"
  return "none"
}

export async function loadState(env: PluginEnv): Promise<DiscordState> {
  const state = await env.storage.get(STATE_KEY)
  if (state && typeof state === "object" && "uploadedSessions" in state) {
    return state as DiscordState
  }
  return { uploadedSessions: {} }
}

export async function isUploaded(
  env: PluginEnv,
  sessionId: string,
): Promise<boolean> {
  const state = await loadState(env)
  return !!state.uploadedSessions[sessionId]
}

export async function markUploaded(
  env: PluginEnv,
  sessionId: string,
  record: {
    timestamp: string
    filename: string
    messageUrl?: string
    fileSize: number
  },
): Promise<void> {
  const state = await loadState(env)
  state.uploadedSessions[sessionId] = record
  await env.storage.set(STATE_KEY, state)
}
