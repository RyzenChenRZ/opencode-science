/**
 * Shared types for the science plugin.
 *
 * The plugin re-implements the capability layer of an open-source scientific
 * research workbench. Upstream is Apache-2.0; this module is original work that
 * depends only on upstream's public connector catalogue and API shapes.
 */

/** JSON Schema for a tool input, as accepted by the OpenCode tool editor. */
export type JsonSchema = {
  type: "object"
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

/** Result of running an external interpreter. */
export type RunResult = {
  code: number
  stdout: string
  stderr: string
  /** Files created or modified under the working directory, relative paths. */
  changedFiles: string[]
}

export type RunRequest = {
  command: string
  args?: string[]
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
  signal?: AbortSignal
  /** Written to the process's stdin and then closed. */
  input?: string
}

export type RunFn = (request: RunRequest) => Promise<RunResult>

/** Per-call context handed to every tool. */
export type ToolContext = {
  /** Aborted when the session is interrupted. */
  signal?: AbortSignal
  /** Session that issued the call, recorded in provenance. */
  sessionID: string
  /** Absolute path of the session working directory. */
  workspace: string
  /** Credentials resolved from plugin options and the environment. */
  credentials: Record<string, string>
  run: RunFn
}

/** One callable tool contributed by a connector. */
export type ConnectorTool = {
  name: string
  description: string
  input: JsonSchema
  execute: (input: Record<string, any>, ctx: ToolContext) => Promise<unknown>
}

/** A scientific data source, derived from one upstream catalogue entry. */
export type Connector = {
  /** Stable id matching the upstream catalogue. */
  id: string
  displayName: string
  /** Human summary of the source. */
  description: string
  /** Upstream `useWhen` text; this is what drives agent tool discovery. */
  useWhen: string
  /** Upstream data sources, preserved so results stay attributable. */
  sources: string[]
  termsUrl?: string
  /** Credential ids the connector may read. */
  credentialKeys: string[]
  tools: ConnectorTool[]
}