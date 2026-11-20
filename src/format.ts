/**
 * Chatlog formatting.
 *
 * OpenCode stores sessions as messages exposed through
 * `ctx.session.context({ sessionID })`, with messages carrying `parts`, tool
 * parts carrying `state`, model info as `{ providerID, modelID }`, and
 * timestamps as epoch milliseconds.
 *
 * Formatting duck-types the message/part shapes defensively so it tolerates
 * field variations between OpenCode releases. Output includes a header,
 * chronological entries, and a footer.
 */

import { shortId } from "./discord"
import type {
  DiscordMessageInfo,
  FormatOptions,
} from "./types"

interface ContentPart {
  type?: string
  text?: string
  reasoning?: string
  name?: string
  tool?: string
  callID?: string
  input?: unknown
  output?: unknown
  error?: unknown
  mimeType?: string
  mime?: string
  filename?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    error?: unknown
    time?: { started?: number; completed?: number }
  }
  [key: string]: unknown
}

interface NormalizedMessage {
  role: string
  parts: ContentPart[]
  model?: { providerID?: string; modelID?: string; id?: string } | string
  agent?: string
  time: { created?: number | string; completed?: number | string }
  text?: string
  summary?: string
  raw: Record<string, any>
}

export function formatTimestamp(ts: string | number | undefined): string {
  if (ts === undefined || ts === null || ts === "") return "(unknown time)"
  try {
    const date = typeof ts === "number" ? new Date(ts) : new Date(ts)
    if (Number.isNaN(date.getTime())) return String(ts)
    return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")
  } catch {
    return String(ts)
  }
}

/** Wrap text in a fenced code block, choosing a fence long enough to avoid clashes. */
export function codeBlock(text: string): string {
  if (!text) return "```\n```"
  if (!text.includes("```")) return `\`\`\`\n${text}\n\`\`\``
  return text.includes("````") ? `\`\`\`\n${text}\n\`\`\`` : `\`\`\`\`\n${text}\n\`\`\`\``
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function normalize(raw: Record<string, any>): NormalizedMessage {
  const info = (raw.info && typeof raw.info === "object" ? raw.info : {}) as Record<string, any>
  const role = str(raw.role ?? info.role ?? (typeof raw.type === "string" ? raw.type : "")) || "unknown"
  const partsSource = Array.isArray(raw.parts) ? raw.parts : Array.isArray(raw.content) ? raw.content : []
  return {
    role,
    parts: partsSource as ContentPart[],
    model: raw.model ?? info.model,
    agent: str(raw.agent ?? info.agent),
    time: (raw.time ?? info.time ?? {}) as NormalizedMessage["time"],
    text: str(raw.text ?? info.text),
    summary: str(raw.summary ?? info.summary) || undefined,
    raw,
  }
}

function partText(part: ContentPart): string {
  if (part.type === "text") return str(part.text)
  if (part.type === "reasoning") return str(part.reasoning ?? part.text)
  return str(part.text)
}

function allText(msg: NormalizedMessage): string {
  const chunks: string[] = []
  if (msg.text) chunks.push(msg.text)
  for (const part of msg.parts) {
    const t = partText(part)
    if (t) chunks.push(t)
  }
  return chunks.join("\n").trim()
}

function modelLabel(model: NormalizedMessage["model"]): string {
  if (!model) return ""
  if (typeof model === "string") return `\`${model}\``
  const provider = model.providerID ?? ""
  const id = model.modelID ?? model.id ?? ""
  if (provider && id) return `\`${provider}/${id}\``
  return `\`${provider || id}\``
}

function toolName(part: ContentPart): string {
  return str(part.tool ?? part.name) || "tool"
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatToolCall(part: ContentPart, ts: string): string {
  const lines: string[] = []
  lines.push(`### Tool Call: \`${toolName(part)}\` _(at ${ts})_`)
  const state = part.state
  const input = part.input ?? state?.input
  if (input !== undefined) {
    lines.push("```json")
    lines.push(stringify(input))
    lines.push("```")
  }
  lines.push("")
  return lines.join("\n")
}

function formatToolResult(part: ContentPart, ts: string): string {
  const lines: string[] = []
  const state = part.state
  const isError = !!state?.error || !!part.error
  const duration = state?.time?.completed && state?.time?.started
    ? ` _(${((state.time.completed - state.time.started) / 1000).toFixed(1)}s)_`
    : ""
  lines.push(`## [tool: ${toolName(part)}] (${ts})${duration}${isError ? " ⚠️" : ""}`)
  lines.push("")
  const output = state?.output ?? part.output ?? state?.error ?? part.error
  lines.push("```")
  lines.push(stringify(output) || "*(no output)*")
  lines.push("```")
  lines.push("")
  lines.push("---")
  lines.push("")
  return lines.join("\n")
}

function formatAssistant(msg: NormalizedMessage, ts: string, opts: FormatOptions): string {
  const lines: string[] = []
  const metaParts: string[] = []
  const model = modelLabel(msg.model)
  if (model) metaParts.push(model)
  if (msg.agent) metaParts.push(`_agent: ${msg.agent}_`)
  const meta = metaParts.length ? ` — ${metaParts.join(" · ")}` : ""

  lines.push(`## [assistant] (${ts})${meta}`)
  lines.push("")

  if (!msg.parts.length) {
    const text = allText(msg)
    if (text) {
      lines.push(text)
      lines.push("")
    }
  } else {
    for (const part of msg.parts) {
      switch (part.type) {
        case "reasoning":
        case "thinking": {
          if (opts.includeThinking) {
            const reasoning = str(part.reasoning ?? part.text)
            if (reasoning) {
              lines.push("> **Thinking:**")
              lines.push("> ```")
              for (const line of reasoning.split("\n")) lines.push(`> ${line}`)
              lines.push("> ```")
              lines.push("")
            }
          }
          break
        }
        case "text": {
          const text = str(part.text)
          if (text) {
            lines.push(text)
            lines.push("")
          }
          break
        }
        case "tool": {
          if (opts.includeToolCalls) lines.push(formatToolCall(part, ts))
          break
        }
        case "file":
        case "image": {
          lines.push(`*[attachment: ${part.mimeType ?? part.mime ?? "file"}${part.filename ? ` ${part.filename}` : ""}]*`)
          lines.push("")
          break
        }
        default: {
          const text = partText(part)
          if (text) {
            lines.push(text)
            lines.push("")
          }
        }
      }
    }
  }

  lines.push("---")
  lines.push("")
  return lines.join("\n")
}

function formatUser(msg: NormalizedMessage, ts: string): string {
  const lines: string[] = []
  lines.push(`## [user] (${ts})`)
  lines.push("")
  const text = allText(msg)
  if (text) {
    lines.push(text)
  } else if (msg.parts.some((p) => p.type === "file" || p.type === "image")) {
    lines.push("*[attachment]*")
  } else {
    lines.push("*(empty message)*")
  }
  lines.push("")
  lines.push("---")
  lines.push("")
  return lines.join("\n")
}

function formatSystem(msg: NormalizedMessage, ts: string): string {
  const lines: string[] = []
  lines.push(`## [system] (${ts})`)
  lines.push("")
  const text = allText(msg)
  if (text) {
    lines.push(codeBlock(text))
    lines.push("")
  }
  lines.push("---")
  lines.push("")
  return lines.join("\n")
}

function formatCompaction(msg: NormalizedMessage, ts: string): string {
  const summary = msg.summary || allText(msg) || "*(no summary)*"
  return `## [compaction] (${ts})\n\n${summary}\n\n---\n`
}

function formatEntry(msg: NormalizedMessage, opts: FormatOptions): string {
  const ts = formatTimestamp(msg.time.created ?? msg.time.completed)
  const role = msg.role

  switch (role) {
    case "user":
      return formatUser(msg, ts)
    case "assistant":
      return formatAssistant(msg, ts, opts)
    case "system":
      return opts.includeSystemPrompt ? formatSystem(msg, ts) : ""
    case "synthetic":
      return opts.includeSystemPrompt ? `## [synthetic] (${ts})\n\n${codeBlock(allText(msg))}\n\n---\n` : ""
    case "toolResult":
    case "tool":
      return opts.includeToolCalls
        ? msg.parts.length
          ? msg.parts.map((p) => (p.type === "tool" ? formatToolResult(p, ts) : "")).join("")
          : `## [tool: ${str(msg.raw.toolName) || "unknown"}] (${ts})\n\n\`\`\`\n${allText(msg)}\n\`\`\`\n\n---\n`
        : ""
    case "compaction":
    case "compaction.completed":
      return formatCompaction(msg, ts)
    case "model_selected":
    case "model":
      return `**[model]** switched to ${modelLabel(msg.model) || "unknown"} _(at ${ts})_\n\n`
    case "agent_selected":
    case "agent":
      return `**[agent]** selected \`${msg.agent || "unknown"}\` _(at ${ts})_\n\n`
    case "step.started":
    case "step.ended":
    case "usage.recorded":
      return ""
    default:
      if (msg.summary || String(role).includes("compaction")) return formatCompaction(msg, ts)
      return `## [${role}] (${ts})\n\n${codeBlock(allText(msg))}\n\n---\n`
  }
}

export function formatChatlog(
  messages: readonly any[],
  session: Record<string, any>,
  opts: FormatOptions,
  cwd: string,
): string {
  const lines: string[] = []
  lines.push("# OpenCode Chat Log")
  lines.push("")
  if (session) {
    if (session.id) lines.push(`**Session ID:** \`${session.id}\``)
    if (session.title) lines.push(`**Title:** ${session.title}`)
    if (cwd) lines.push(`**Working Directory:** \`${cwd}\``)
    const created = session.time?.created
    if (created !== undefined) lines.push(`**Started:** ${formatTimestamp(created)}`)
    if (session.parentID) lines.push(`**Parent Session:** \`${shortId(session.parentID)}\``)
  } else {
    lines.push("*(No session metadata found)*")
  }
  lines.push("")
  lines.push("---")
  lines.push("")

  for (const raw of messages) {
    const formatted = formatEntry(normalize(raw ?? {}), opts)
    if (formatted) lines.push(formatted)
  }

  lines.push("---")
  lines.push("")
  lines.push(
    `*End of chat log*  |  ${messages.length} entries  |  generated ${formatTimestamp(Date.now())}`,
  )

  return lines.join("\n")
}

export function collectSessionInfo(
  messages: readonly any[],
  session: Record<string, any>,
  cwd: string,
): DiscordMessageInfo {
  const modelsUsed = new Set<string>()
  for (const raw of messages) {
    const msg = normalize(raw ?? {})
    const model = msg.model
    if (model && typeof model !== "string") {
      const provider = model.providerID
      const id = model.modelID ?? model.id
      if (provider && id) modelsUsed.add(`${provider}/${id}`)
    }
  }

  return {
    sessionId: str(session?.id) || "unknown",
    cwd,
    title: str(session?.title),
    modelsUsed: Array.from(modelsUsed),
    entryCount: messages.length,
  }
}
