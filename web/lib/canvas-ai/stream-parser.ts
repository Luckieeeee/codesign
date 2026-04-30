import type { AgentOp } from "./types"

/**
 * Incrementally parses a JSON object of the shape:
 *   { "reply": "…", "ops": [ { ... }, { ... }, … ] }
 *
 * As tokens stream in, this extractor surfaces:
 *   - Any newly-extended substring of the top-level `reply` string, so the
 *     UI can render the model's chat response live.
 *   - Each fully-completed operation object inside the `ops` array, so the
 *     canvas can apply edits as soon as the model finishes describing them
 *     instead of waiting for the entire response.
 *
 * The implementation is character-by-character with a hand-rolled brace /
 * string state machine. It's robust against the model emitting newlines,
 * escaped quotes, and trailing whitespace inside string values.
 */

type StringState = {
  inString: boolean
  escape: boolean
}

export type StreamPartial = {
  /** Newly-emitted suffix of the `reply` field (may be empty). */
  replyDelta: string
  /** Fully-parsed ops appended since the last call. */
  ops: AgentOp[]
}

const EMPTY_PARTIAL: StreamPartial = { replyDelta: "", ops: [] }

export class CanvasStreamExtractor {
  private buffer = ""
  private replyEmitted = ""
  private opsEmittedCount = 0

  push(chunk: string): StreamPartial {
    if (!chunk) return EMPTY_PARTIAL
    this.buffer += chunk

    const replyDelta = this.extractReplyDelta()
    const ops = this.extractCompletedOps()

    if (!replyDelta && ops.length === 0) return EMPTY_PARTIAL
    return { replyDelta, ops }
  }

  /**
   * Called after the stream completes — returns the final reply string and
   * any ops we may have missed (defensive: the streaming parser should have
   * picked up everything already).
   */
  final(): { reply: string; ops: AgentOp[] } {
    // Try a final full parse on whatever we accumulated. If the model
    // produced clean JSON this gives us the canonical answer.
    const text = stripCodeFence(this.buffer.trim())
    try {
      const parsed = JSON.parse(text) as { reply?: string; ops?: AgentOp[] }
      return {
        reply: typeof parsed.reply === "string" ? parsed.reply : this.replyEmitted,
        ops: Array.isArray(parsed.ops) ? parsed.ops : [],
      }
    } catch {
      // Streaming parse already gave us best-effort ops; reuse them. The
      // reply may be incomplete but that's better than throwing.
      return {
        reply: this.replyEmitted,
        ops: [],
      }
    }
  }

  private extractReplyDelta(): string {
    const start = findUnquotedKey(this.buffer, "reply")
    if (start < 0) return ""
    const colon = this.buffer.indexOf(":", start)
    if (colon < 0) return ""
    const quoteStart = findNextNonWhitespace(this.buffer, colon + 1)
    if (quoteStart < 0 || this.buffer[quoteStart] !== '"') return ""

    // Walk characters after the opening quote, decoding JSON string escapes
    // until we either hit the closing quote or run out of buffer.
    let i = quoteStart + 1
    let out = ""
    let closed = false
    while (i < this.buffer.length) {
      const c = this.buffer[i]
      if (c === "\\") {
        // Need at least one more char to decode the escape; otherwise wait
        // for the next chunk.
        if (i + 1 >= this.buffer.length) break
        const next = this.buffer[i + 1]
        switch (next) {
          case '"':
            out += '"'
            break
          case "\\":
            out += "\\"
            break
          case "/":
            out += "/"
            break
          case "n":
            out += "\n"
            break
          case "t":
            out += "\t"
            break
          case "r":
            out += "\r"
            break
          case "b":
            out += "\b"
            break
          case "f":
            out += "\f"
            break
          case "u": {
            if (i + 5 >= this.buffer.length) {
              // Wait for the rest of the unicode escape — bail without
              // emitting any new characters this round.
              return ""
            }
            const hex = this.buffer.slice(i + 2, i + 6)
            const code = parseInt(hex, 16)
            if (!Number.isNaN(code)) out += String.fromCharCode(code)
            i += 4
            break
          }
          default:
            out += next
        }
        i += 2
        continue
      }
      if (c === '"') {
        closed = true
        break
      }
      out += c
      i += 1
    }

    // Be conservative: if the string is still open, only emit up to the
    // last fully-decoded character (we already did that). If it's closed,
    // we have the final reply string.
    void closed
    if (out.length <= this.replyEmitted.length) return ""
    const delta = out.slice(this.replyEmitted.length)
    this.replyEmitted = out
    return delta
  }

  private extractCompletedOps(): AgentOp[] {
    const opsKey = findUnquotedKey(this.buffer, "ops")
    if (opsKey < 0) return []
    const colon = this.buffer.indexOf(":", opsKey)
    if (colon < 0) return []
    const arrayStart = findNextNonWhitespace(this.buffer, colon + 1)
    if (arrayStart < 0 || this.buffer[arrayStart] !== "[") return []

    const collected: AgentOp[] = []
    const state: StringState = { inString: false, escape: false }
    let depth = 0
    let objectStart = -1
    let scannedCount = 0

    for (let i = arrayStart + 1; i < this.buffer.length; i += 1) {
      const c = this.buffer[i]

      if (state.inString) {
        if (state.escape) {
          state.escape = false
        } else if (c === "\\") {
          state.escape = true
        } else if (c === '"') {
          state.inString = false
        }
        continue
      }
      if (c === '"') {
        state.inString = true
        continue
      }
      if (c === "{") {
        if (depth === 0) objectStart = i
        depth += 1
        continue
      }
      if (c === "}") {
        depth -= 1
        if (depth === 0 && objectStart >= 0) {
          scannedCount += 1
          if (scannedCount > this.opsEmittedCount) {
            const slice = this.buffer.slice(objectStart, i + 1)
            try {
              const parsed = JSON.parse(slice) as AgentOp
              collected.push(parsed)
            } catch {
              // Malformed object — skip rather than crash the stream.
            }
            this.opsEmittedCount = scannedCount
          }
          objectStart = -1
        }
        continue
      }
      if (c === "]" && depth === 0) {
        // Reached the end of the ops array.
        break
      }
    }
    return collected
  }
}

function stripCodeFence(text: string): string {
  if (text.startsWith("```")) {
    // Drop the first line (``` or ```json) and the trailing fence.
    const firstNewline = text.indexOf("\n")
    const trimmed = firstNewline >= 0 ? text.slice(firstNewline + 1) : text
    return trimmed.replace(/```\s*$/m, "").trim()
  }
  return text
}

/**
 * Find the position of an UNQUOTED key occurrence at the top level —
 * i.e. `"<key>"` immediately followed (after whitespace) by a colon, with
 * the surrounding context not inside a string literal.
 *
 * For our schema the key only appears once at the top level so a naive
 * left-to-right search works, but we still skip occurrences inside string
 * values to avoid false positives if the model echoes the key in `reply`.
 */
function findUnquotedKey(buffer: string, key: string): number {
  const target = `"${key}"`
  let inString = false
  let escape = false
  for (let i = 0; i < buffer.length; i += 1) {
    const c = buffer[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (c === "\\") {
        escape = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      // Could this be the start of our key?
      if (buffer.startsWith(target, i)) {
        // Confirm a colon follows (skipping whitespace) — otherwise it's
        // a string value, not a key.
        const after = i + target.length
        const colonIdx = findNextNonWhitespace(buffer, after)
        if (colonIdx >= 0 && buffer[colonIdx] === ":") {
          return i
        }
      }
      inString = true
    }
  }
  return -1
}

function findNextNonWhitespace(buffer: string, from: number): number {
  for (let i = from; i < buffer.length; i += 1) {
    const c = buffer[i]
    if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") return i
  }
  return -1
}
