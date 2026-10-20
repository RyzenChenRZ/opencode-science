/**
 * Turn recorder.
 *
 * OpenCode V2 hands a plugin no HTTP client, so a turn cannot be fetched the
 * way it would be in V1. What it does offer is `ctx.session.context({sessionID})`,
 * which returns `SessionMessage.Info[]`, and `ctx.tool.hook("execute.after")`,
 * which reports each tool call as it lands.
 *
 * Both streams are used. The session context gives the assistant's prose and
 * the call sequence; the tool hook gives each call's input and output, which is
 * what the rubric's method actually needs — a claim is checked against the
 * value the tool produced, and that value is not in the message list.
 *
 * Records are per session and bounded, so a long session cannot grow without
 * limit.
 */

export type RecordedBlock = {
  index: number
  kind: "text" | "tool"
  text?: string
  tool?: string
  callID?: string
  status?: string
  /** Whether the execution log has the full input and output for this call. */
  hasExecution: boolean
}

export type RecordedExecution = {
  callID: string
  sessionID: string
  tool: string
  agent: string
  status: string
  input: unknown
  output: string
  at: number
}

/** Executions kept per session; older entries fall off the front. */
const MAX_EXECUTIONS = 400
/** Output characters kept per execution. */
const MAX_OUTPUT = 20_000
/** Text characters kept per block; the reviewer reads, it does not re-ingest. */
const MAX_TEXT = 8_000

/**
 * Flattens `SessionMessage.Info[]` into the ordered block list the rubric uses.
 *
 * The shape is the one the session API returns: a message carries `role` and
 * `content[]`, where a content item is one of `{type:"text", text}` or
 * `{type:"tool", tool, callID, state:{status,...}}`.
 *
 * Only assistant messages are included. A user turn is the request under
 * review, not a claim by the agent, and mixing it into the ordered blocks would
 * let the reviewer fault the agent for text it did not write.
 */
export function blocksFromMessages(messages: unknown): RecordedBlock[] {
  const list = Array.isArray(messages)
    ? messages
    : ((messages as { data?: unknown[] })?.data ?? [])

  const blocks: RecordedBlock[] = []
  for (const message of list as any[]) {
    if (message?.role !== "assistant" && message?.type !== "assistant") continue
    const parts: any[] = Array.isArray(message?.content) ? message.content : []
    for (const part of parts) {
      if (!part || typeof part !== "object") continue

      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        const text = part.text.trim()
        blocks.push({
          index: blocks.length,
          kind: "text",
          text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... (truncated)` : text,
          hasExecution: false,
        })
        continue
      }

      if (part.type === "tool") {
        blocks.push({
          index: blocks.length,
          kind: "tool",
          tool: part.tool ?? part.name,
          callID: part.callID ?? part.id,
          status: part.state?.status,
          hasExecution: false,
        })
      }
    }
  }
  return blocks
}

/** Tool results arrive as a content array; flatten it to readable text. */
export function outputText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text as string)
    .join("\n")
}

type SessionRecord = {
  executions: Map<string, RecordedExecution>
  order: string[]
}

export class TurnRecorder {
  #sessions = new Map<string, SessionRecord>()

  #record(sessionID: string): SessionRecord {
    let entry = this.#sessions.get(sessionID)
    if (!entry) {
      entry = { executions: new Map(), order: [] }
      this.#sessions.set(sessionID, entry)
    }
    return entry
  }

  /** Records one completed tool call, keeping the newest MAX_EXECUTIONS. */
  add(execution: RecordedExecution): void {
    const entry = this.#record(execution.sessionID)
    if (!entry.executions.has(execution.callID)) entry.order.push(execution.callID)
    entry.executions.set(execution.callID, execution)
    while (entry.order.length > MAX_EXECUTIONS) {
      const oldest = entry.order.shift()
      if (oldest !== undefined) entry.executions.delete(oldest)
    }
  }

  /** Marks which blocks have a recorded execution, for the reviewer to see. */
  annotate(blocks: RecordedBlock[], sessionID: string): RecordedBlock[] {
    const entry = this.#sessions.get(sessionID)
    if (!entry) return blocks
    return blocks.map((block) =>
      block.kind === "tool" && block.callID && entry.executions.has(block.callID)
        ? { ...block, hasExecution: true }
        : block,
    )
  }

  executions(sessionID: string): RecordedExecution[] {
    const entry = this.#sessions.get(sessionID)
    if (!entry) return []
    return entry.order
      .map((id) => entry.executions.get(id))
      .filter((value): value is RecordedExecution => value !== undefined)
  }

  execution(sessionID: string, callID: string): RecordedExecution | undefined {
    return this.#sessions.get(sessionID)?.executions.get(callID)
  }

  clear(): void {
    this.#sessions.clear()
  }
}

export { MAX_OUTPUT }