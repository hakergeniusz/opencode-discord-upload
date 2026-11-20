/** Discord webhook upload logic. */

import type {
  DiscordConfig,
  DiscordMessageInfo,
  DiscordUploadResult,
} from "./types"

/** Discord non-Nitro file upload limit. */
export const MAX_FILE_SIZE = 8 * 1024 * 1024
/** Chunk size for splitting large logs (under 8 MB for multipart overhead). */
export const CHUNK_SIZE = 7.5 * 1024 * 1024
/** Discord message content length limit. */
export const MAX_MESSAGE_LENGTH = 1900
/** Upload timeout in milliseconds. */
export const UPLOAD_TIMEOUT_MS = 60_000

export function byteLength(str: string): number {
  return Buffer.byteLength(str, "utf-8")
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function buildDiscordMessage(
  info: DiscordMessageInfo,
  config: DiscordConfig,
): string {
  const cwdShort = info.cwd ? (info.cwd.split(/[\\/]/).pop() || info.cwd) : "(unknown)"
  const modelStr = info.modelsUsed.length > 0 ? ` | Model: ${info.modelsUsed.join(", ")}` : ""
  return (
    `**OpenCode Chatlog Uploaded**\n` +
    `**Session:** \`${shortId(info.sessionId)}\` | ` +
    `**CWD:** \`${cwdShort}\` | ` +
    `**Messages:** ${info.entryCount}${modelStr}`
  )
}

/** Split content into chunks no larger than `maxChunkSize` bytes, on line boundaries. */
export function chunkContent(content: string, maxChunkSize: number): string[] {
  if (byteLength(content) <= maxChunkSize) return [content]

  const chunks: string[] = []
  let current = ""
  for (const line of content.split("\n")) {
    const withNL = line + "\n"
    if (byteLength(current + withNL) > maxChunkSize && current) {
      chunks.push(current)
      current = ""
    }
    current += withNL
  }
  if (current) chunks.push(current)
  return chunks
}

function webhookFields(config: DiscordConfig): Record<string, string> {
  return {
    username: config.username || "OpenCode Chatlog",
    ...(config.avatarUrl ? { avatar_url: config.avatarUrl } : {}),
  }
}

/**
 * Upload formatted chatlog content to Discord via webhook.
 *
 * - Small logs (< ~1.9 KB) are sent as an inline message.
 * - Larger logs are uploaded as a file attachment.
 * - Very large logs (> 8 MB) are split into multiple chunks.
 */
function uploadSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function uploadToDiscord(
  content: string,
  info: DiscordMessageInfo,
  config: DiscordConfig,
  webhookUrl: string,
  signal?: AbortSignal,
): Promise<DiscordUploadResult[]> {
  const baseMessage = buildDiscordMessage(info, config)
  const sessionId = shortId(info.sessionId)
  const inlineContent = `${baseMessage}\n\`\`\`\n${content}\n\`\`\``

  if (byteLength(inlineContent) < MAX_MESSAGE_LENGTH) {
    const payload = { content: inlineContent, ...webhookFields(config) }
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: uploadSignal(signal),
      })
      if (!response.ok) {
        const errorText = await response.text()
        return [{
          success: false,
          fileSize: content.length,
          filename: "",
          error: `HTTP ${response.status}: ${errorText}`,
        }]
      }
      const data = await response.json().catch(() => ({}))
      return [{
        success: true,
        messageUrl: data.url,
        fileSize: content.length,
        filename: "",
      }]
    } catch (err) {
      return [{
        success: false,
        fileSize: content.length,
        filename: "",
        error: err instanceof Error ? err.message : String(err),
      }]
    }
  }

  const chunks = chunkContent(content, CHUNK_SIZE)
  const totalParts = chunks.length
  const results: DiscordUploadResult[] = []

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const partNum = totalParts > 1 ? `-p${i + 1}of${totalParts}` : ""
    const fileName = `opencode-chatlog-${sessionId}${partNum}.md`

    const formData = new FormData()
    formData.append("file", new Blob([chunk], { type: "text/markdown" }), fileName)
    formData.append(
      "payload_json",
      JSON.stringify({
        content: totalParts > 1
          ? `${baseMessage} _(part ${i + 1}/${totalParts})_`
          : baseMessage,
        ...webhookFields(config),
      }),
    )

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        body: formData,
        signal: uploadSignal(signal),
      })
      if (!response.ok) {
        const errorText = await response.text()
        results.push({
          success: false,
          fileSize: chunk.length,
          filename: fileName,
          error: `HTTP ${response.status}: ${errorText}`,
        })
      } else {
        const data = await response.json().catch(() => ({}))
        results.push({
          success: true,
          messageUrl: data.url,
          fileSize: chunk.length,
          filename: fileName,
        })
      }
    } catch (err) {
      results.push({
        success: false,
        fileSize: chunk.length,
        filename: fileName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}
