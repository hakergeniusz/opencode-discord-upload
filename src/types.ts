/**
 * Shared types for opencode-discord-upload.
 *
 * The plugin deliberately keeps its own structural types instead of importing
 * SDK-internal types. Only `@opencode/plugin` is used as a dependency, and the
 * runtime objects handed to the helpers are duck-typed through these small
 * interfaces.
 */

/** Configuration, mirroring the original pi-discord-upload config keys. */
export interface DiscordConfig {
  /** Discord webhook URL (env var takes precedence). */
  webhookUrl?: string
  /** Auto-upload a chatlog when a lifecycle trigger fires. */
  autoUpload: boolean
  /** Lifecycle triggers that cause an auto-upload. */
  autoUploadTriggers: string[]
  /** Include model reasoning / thinking blocks. */
  includeThinking: boolean
  /** Include system / instruction sections. */
  includeSystemPrompt: boolean
  /** Include tool calls and their results. */
  includeToolCalls: boolean
  /** Discord webhook display username. */
  username: string
  /** Optional Discord webhook avatar URL. */
  avatarUrl?: string
}

export const DEFAULT_CONFIG: DiscordConfig = {
  autoUpload: true,
  includeThinking: false,
  includeSystemPrompt: true,
  includeToolCalls: true,
  autoUploadTriggers: ["quit", "new"],
  username: "OpenCode Chatlog",
}

export interface UploadedSessionRecord {
  timestamp: string
  filename: string
  messageUrl?: string
  fileSize: number
}

export interface DiscordState {
  uploadedSessions: Record<string, UploadedSessionRecord>
}

export interface FormatOptions {
  includeThinking: boolean
  includeSystemPrompt: boolean
  includeToolCalls: boolean
}

export interface DiscordUploadResult {
  success: boolean
  messageUrl?: string
  fileSize: number
  filename: string
  error?: string
}

export interface DiscordMessageInfo {
  sessionId: string
  cwd: string
  title: string
  modelsUsed: string[]
  entryCount: number
}

/**
 * Minimal structural view of the plugin context used by the helper modules.
 * `any` is intentional for SDK method parameters/results so the real context
 * is assignable without coupling to version-specific type details.
 */
export interface PluginEnv {
  storage: {
    get(key: string): Promise<any>
    set(key: string, value: any): Promise<void>
    remove(key: string): Promise<void>
  }
  options: Record<string, any>
  location: { directory: string }
  event: {
    subscribe(options: { types?: string[]; signal?: AbortSignal }): AsyncIterable<any>
  }
  session: {
    context(input: { sessionID: string }): Promise<readonly any[]>
    get(input: { sessionID: string }): Promise<any>
    list(input: any): Promise<any>
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>
  }
}

/** A slash-command invocation, as delivered by OpenCode V2. */
export interface CommandInvocation {
  sessionID: string
  prompt: { text: string; [key: string]: unknown }
  delivery: "steer" | "queue"
}
