import { Plugin } from "@opencode/plugin"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { CONNECTORS } from "./connectors.ts"
import { LITERATURE_TOOLS } from "./literature/tools.ts"
import { LITERATURE_WORKFLOW_TOOLS } from "./literature/workflow-tools.ts"
import { loadSkills, renderAlwaysOnCatalogue, type SkillInfo } from "./skills.ts"
import { createNotebookRunner, readRunHistory, NOTEBOOK_RUN_INPUT } from "./notebook.ts"
import { runProcess } from "./process.ts"
import { PUBLISH_ARTIFACT_INPUT, listArtifacts, publishArtifact, readProvenance, renderProvenance } from "./provenance.ts"
import { render } from "./http.ts"
import { REVIEWER_RUBRIC } from "./reviewer-rubric.ts"
import { createReviewerTools } from "./reviewer-tools.ts"
import { TurnRecorder, outputText, MAX_OUTPUT } from "./turn-recorder.ts"
import { installSpecialistAgents } from "./specialist-agents.ts"
import type { Skill } from "@opencode/schema/skill"
import type { ToolContext } from "./types.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(HERE, "..", "vendor")
/**
 * Where OpenCode discovers subagent Markdown files.
 *
 * V2 exposes no config path on the plugin Context (App is only
 * {name, version, channel}), so it is derived from this plugin's own
 * installed location: <config>/plugins/opencode-science. Three levels up
 * from vendor/ is <config>.
 */
function agentDir(): string {
  return join(dirname(dirname(dirname(VENDOR_ROOT))), "agent")
}

/** Specialist definitions are original to this plugin, not vendored. */
// loadSpecialists() appends "resources/specialists" itself, so this is the
// plugin root, matching the upstream layout.
// The specialist directory itself, not a repository root: loadSpecialists
// reads one <id>/specialist.json per entry and does no joining of its own.
const SPECIALIST_ROOT = join(HERE, "..", "specialists")
/** Agent id that receives the reviewer rubric; must match the rendered agent file. */
const REVIEWER_AGENT_ID = "science-evidence-reviewer"

/** Resolved plugin options, with defaults applied. */
type Options = {
  skills: boolean
  connectors: boolean
  notebook: boolean
  provenance: boolean
  /** Registers the literature library tools. */
  literature: boolean
  /** Writes the plugin's specialists out as OpenCode agent files. */
  specialists: boolean
  /** Registers the reviewer tools and the audit agent. */
  reviewer: boolean
  python?: string
  rscript?: string
  timeoutMs: number
  openAlexApiKey?: string
  ncbiApiKey?: string
  ncbiEmail?: string
}

function readOptions(raw: unknown): Options {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    skills: o.skills !== false,
    connectors: o.connectors !== false,
    notebook: o.notebook !== false,
    provenance: o.provenance !== false,
    literature: o.literature !== false,
    specialists: o.specialists !== false,
    reviewer: o.reviewer !== false,
    python: typeof o.python === "string" ? o.python : undefined,
    rscript: typeof o.rscript === "string" ? o.rscript : undefined,
    timeoutMs: typeof o.timeoutMs === "number" ? o.timeoutMs : 300_000,
    openAlexApiKey: typeof o.openAlexApiKey === "string" ? o.openAlexApiKey : undefined,
    ncbiApiKey: typeof o.ncbiApiKey === "string" ? o.ncbiApiKey : undefined,
    ncbiEmail: typeof o.ncbiEmail === "string" ? o.ncbiEmail : undefined,
  }
}

/**
 * A scientific research workbench for OpenCode: vendored skills, read-only
 * database connectors, notebook execution against the user's own interpreter,
 * and immutable artifact versions with provenance records.
 */
export default Plugin.define({
  id: "opencode-science",
  setup(ctx) {
    const options = readOptions(ctx.options)
    const log = (message: string) => console.log(`[opencode-science] ${message}`)

    // Credentials come from plugin options with an environment fallback, so no
    // secret is ever written into an OpenCode configuration file.
    const credentials: Record<string, string> = {}
    for (const key of ["openAlexApiKey", "ncbiApiKey", "ncbiEmail"] as const) {
      const envName = { openAlexApiKey: "OPENALEX_API_KEY", ncbiApiKey: "NCBI_API_KEY", ncbiEmail: "NCBI_EMAIL" }[key]
      const value = options[key] ?? process.env[envName]
      if (value) credentials[key] = value
    }
    const configuredKeys = (["openAlexApiKey", "ncbiApiKey", "ncbiEmail"] as const).filter(
      (key) => credentials[key],
    )

    const makeContext = (sessionID: string, signal?: AbortSignal): ToolContext => ({
      sessionID,
      signal,
      workspace: ctx.location.directory,
      credentials,
      run: runProcess,
    })

    void (async () => {
      if (options.skills) {
        const { skills, skipped } = await loadSkills(VENDOR_ROOT)
        for (const skill of skills) {
          registerSkill(skill)
        }
        log(`registered ${skills.length} skills${skipped.length ? `, skipped ${skipped.length}` : ""}`)
      }

      if (options.connectors) {
        const tools = CONNECTORS.flatMap((c) => c.tools)
        await ctx.tool.transform((editor) => {
          editor.namespace({ name: "os", description: "Scientific data sources and analysis." })
          for (const t of tools) {
            editor.add({
              name: t.name,
              description: t.description,
              input: t.input,
              execute: async (input: any, context: any) => {
                try {
                  const result = await t.run(input, makeContext(context.sessionID ?? "unknown", context.signal))
                  return { content: render(result) }
                } catch (error) {
                  // A connector failure is reported to the model so it can
                  // adjust the query rather than retrying blindly.
                  return { content: `Connector error: ${(error as Error).message}` }
                }
              },
            })
          }
        })
        log(`registered ${tools.length} connector tools from ${CONNECTORS.length} sources`)
      }

      if (options.literature) {
        // The library and screening workflow sits on top of the connectors: it
        // stores what they return, deduplicates it across sources, and applies
        // a collection rule to it. Same namespace, because they answer the same
        // question at different scopes. Registered independently of the
        // connectors, so turning the connectors off does not silently take the
        // library with them.
        //
        // The workflow tools are the ones that act on the library rather than
        // view it: fetching the papers themselves, walking their citation
        // neighbourhood, and writing the result out as a bibliography.
        const literatureTools = [...LITERATURE_TOOLS, ...LITERATURE_WORKFLOW_TOOLS]
        await ctx.tool.transform((editor) => {
          for (const tool of literatureTools) {
            editor.add({
              name: tool.name,
              description: tool.description,
              input: tool.input,
              execute: async (input: any, context: any) => {
                try {
                  const result = await tool.run(input, makeContext(context.sessionID ?? "unknown", context.signal))
                  return { content: render(result) }
                } catch (error) {
                  return { content: `Literature tool error: ${(error as Error).message}` }
                }
              },
            })
          }
        })
        log(`registered ${literatureTools.length} literature tools`)
      }

      if (options.notebook) {
        const runner = createNotebookRunner({
          python: options.python,
          rscript: options.rscript,
          timeoutMs: options.timeoutMs,
          // The vendored skills read their configuration from the environment,
          // so a key configured here has to reach the interpreter or their own
          // API helpers refuse to run.
          credentialKeys: configuredKeys,
        })
        // Reads back what notebook_run actually executed. Without this the run
        // log is write-only, and a claim in a later turn cannot be checked
        // against the code and exit status that produced it.
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "notebook_run_history",
            description:
              "List previous notebook runs in this workspace with their interpreter, exit code, duration, and output files. " +
              "Use it to check what was actually executed before citing a result; a run that is not listed did not produce it.",
            input: {
              type: "object",
              properties: {
                limit: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  description: "Max runs to return (default 20).",
                },
              },
              additionalProperties: false,
            },
            execute: async (input: any) => {
              const limit = typeof input.limit === "number" ? input.limit : 20
              const runs = await readRunHistory(ctx.location.directory, limit)
              if (!runs.length) {
                return { content: "No notebook runs have been recorded in this workspace yet." }
              }
              return {
                content: [
                  "Most recent first.",
                  "",
                  ...runs.map((run) =>
                    [
                      `${run.runId}  ${run.language}  exit ${run.code}  ${run.durationMs} ms  ${run.capturedAt}`,
                      `  interpreter: ${run.interpreter}`,
                      ...(run.changedFiles.length ? [`  files: ${run.changedFiles.join(", ")}`] : []),
                    ].join("\n"),
                  ),
                ].join("\n"),
              }
            },
          })
        })
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "notebook_run",
            description:
              "Run a self-contained Python or R script in the user's own interpreter and return stdout, stderr, and the files it wrote. " +
              "There is no persistent kernel: variables do not survive between runs, so each script must define everything it needs.",
            input: NOTEBOOK_RUN_INPUT as any,
            execute: async (input: any, context: any) => {
              try {
                const sessionID = context.sessionID ?? "unknown"
                const output = await runner.run(
                  { code: String(input.code), language: input.language, timeoutMs: input.timeoutMs },
                  makeContext(sessionID, context.signal),
                )
                return { content: output }
              } catch (error) {
                return { content: `Notebook error: ${(error as Error).message}` }
              }
            },
          })
        })
                log("registered notebook_run and notebook_run_history")
      }

      if (options.provenance) {
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "publish_artifact",
            description:
              "Register an immutable, checksummed version of a result file with a provenance record naming the producing code, " +
              "its input files, and the environment. Use this for any figure, table, or report the user will cite later.",
            input: PUBLISH_ARTIFACT_INPUT as any,
            execute: async (input: any, context: any) => {
              try {
                const record = await publishArtifact(ctx.location.directory, context.sessionID ?? "unknown", {
                  path: String(input.path),
                  note: input.note ? String(input.note) : undefined,
                  producerCode: input.producerCode ? String(input.producerCode) : undefined,
                  runId: input.runId ? String(input.runId) : undefined,
                  inputs: Array.isArray(input.inputs) ? input.inputs.map(String) : undefined,
                  environmentSummary: input.environmentSummary ? String(input.environmentSummary) : undefined,
                })
                // The line states the grade, not merely that something was
                // stored. "producer code recorded" used to be printed for an
                // abridged snippet too, which asserted a reproducibility the
                // record did not have.
                const producerLine =
                  record.producer.state === "available"
                    ? "producer code recorded (complete)"
                    : record.producer.state === "partial"
                      ? `producer code PARTIAL: ${record.producer.reason}`
                      : `producer code unavailable: ${record.producer.reason}`
                const same = record.unchanged
                  ? `\nNo new version: the bytes are identical to ${record.versionId}. ` +
                    "That earlier record stands unchanged, including the run it names below — " +
                    "this call added nothing, so the run id you supplied is not attached to it."
                  : ""
                return {
                  content: `Published ${record.filename} as ${record.versionId}\nchecksum ${record.checksum}${same}\n${producerLine}\n${
                    record.runId ? `producing run: ${record.runId}\n` : ""
                  }${
                    record.inputs.state === "available"
                      ? `inputs recorded: ${record.inputs.files?.length ?? 0}`
                      : record.inputs.state === "partial"
                        ? `inputs PARTIAL (${record.inputs.files?.length ?? 0} recorded): ${record.inputs.reason}`
                        : `inputs unavailable: ${record.inputs.reason}`
                  }\n${
                    record.environment.state === "available"
                      ? "environment recorded"
                      : `environment unavailable: ${record.environment.reason}`
                  }`,
                }
              } catch (error) {
                return { content: `Publish failed: ${(error as Error).message}` }
              }
            },
          })

          editor.add({
            name: "list_provenance",
            description: "List published artifact versions with their checksums and creation time.",
            input: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              const artifacts = await listArtifacts(ctx.location.directory)
              if (!artifacts.length) {
                return { content: "No artifacts have been published in this workspace yet." }
              }
              return {
                content: artifacts
                  .map((a) => `${a.versionId}  ${a.filename}  ${a.sizeBytes} bytes  sha256:${a.checksum.slice(0, 16)}  ${a.createdAt}`)
                  .join("\n"),
              }
            },
          })
        })
        log("registered publish_artifact and list_provenance")
      }

      if (options.reviewer) {
        // The rubric has to reach the reviewer's own context. `agent.transform`
        // can update an existing agent but cannot create one, so it is injected
        // for the reviewer agent only. Keyed by agent id so the working context
        // of the agent doing the science is not polluted with audit criteria.
        await ctx.session.hook("context", (event) => {
          if (event.agent === REVIEWER_AGENT_ID) {
            event.system.push({ type: "text", text: REVIEWER_RUBRIC })
          }
        })

        // A turn cannot be fetched: V2 gives a plugin no HTTP client. It is
        // recorded instead, from the two streams the API does expose. The
        // message list supplies prose and call order; this hook supplies each
        // call's real input and output, which is what a claim is checked
        // against.
        const recorder = new TurnRecorder()
        ctx.tool.hook("execute.after", (event) => {
          if (event.status === "completed") {
            recorder.add({
              sessionID: event.sessionID,
              callID: event.id,
              tool: event.tool,
              agent: event.agent,
              status: "completed",
              input: event.input,
              output: outputText((event.result as any)?.content).slice(0, MAX_OUTPUT),
              at: Date.now(),
            })
          } else {
            recorder.add({
              sessionID: event.sessionID,
              callID: event.id,
              tool: event.tool,
              agent: event.agent,
              status: "error",
              input: event.input,
              output: String((event.error as any)?.message ?? "tool failed"),
              at: Date.now(),
            })
          }
        })

        const tools = createReviewerTools(recorder, ctx.session as any, ctx.location.directory)
        await ctx.tool.transform((editor) => {
          for (const tool of tools) {
            editor.add(tool as any)
          }
        })
        log(`registered ${tools.length} reviewer tools and the reviewer rubric`)
      }

      if (options.specialists) {
        // OpenCode has no plugin API for creating an agent, so the specialist
        // definitions are rendered to <config>/agent/*.md. Writing them here
        // rather than at install time keeps them correct when the plugin is
        // reloaded, and prunes any specialist that no longer exists.
        try {
          const { registered, skipped } = await installSpecialistAgents(SPECIALIST_ROOT, agentDir())
          log(`registered ${registered.length} specialist agents${skipped.length ? `, skipped ${skipped.length}` : ""}`)
          for (const item of skipped) log(`  skipped ${item.name}: ${item.reason}`)
        } catch (error) {
          // A specialist that will not render must not take the rest of the
          // plugin down with it.
          log(`specialist agents unavailable: ${(error as Error).message}`)
        }
      }
    })()

    function registerSkill(skill: SkillInfo) {
      void ctx.skill.transform((editor) => {
        editor.add({
          // The vendored catalogue yields plain strings; the editor wants
          // branded ids, which are the same strings at runtime.
          id: skill.id as Skill.ID,
          name: skill.name as Skill.Name,
          description: skill.description,
          path: skill.path as Skill.Info["path"],
          content: skill.content,
          // Upstream marks internal skills as not-advertised; the same applies
          // so the model's skill list stays short.
          autoinvoke: !skill.hidden,
        })
      })
    }

    if (options.skills) {
      // Upstream keeps a few skills always-on. OpenCode has no equivalent flag,
      // so their catalogue is injected into the request context instead.
      void (async () => {
        const { skills } = await loadSkills(VENDOR_ROOT)
        const catalogue = renderAlwaysOnCatalogue(skills)
        if (!catalogue) return
        await ctx.session.hook("context", (event) => {
          event.system.push({ type: "text", text: catalogue })
        })
      })()
    }

    void ctx.command.transform((editor) => {
      editor.add({
        name: "os-provenance",
        description: "Show the provenance record for a published artifact.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const target = prompt.text.trim().split(/\s+/)[0]
          const result = target
            ? await readProvenance(ctx.location.directory, target)
            : { error: "Usage: /os-provenance <artifact-id or version-id>" }
          const text = "error" in result ? result.error : renderProvenance(result)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text,
            delivery,
          })
        },
      })

      editor.add({
        name: "os-status",
        description: "Report which science capabilities are active and how results can be verified.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const { skills } = await loadSkills(VENDOR_ROOT)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: [
              "OpenCode science capabilities",
              "",
              `skills          ${options.skills ? `${skills.length} registered` : "disabled"}`,
              `connectors      ${options.connectors ? `${CONNECTORS.length} sources, ${CONNECTORS.flatMap((c) => c.tools).length} tools` : "disabled"}`,
              `literature      ${options.literature ? `${LITERATURE_TOOLS.length + LITERATURE_WORKFLOW_TOOLS.length} tools` : "disabled"}`,
              `notebook        ${options.notebook ? "enabled" : "disabled"}`,
              `provenance      ${options.provenance ? "enabled" : "disabled"}`,
              `reviewer        ${options.reviewer ? "enabled" : "disabled"}`,
              `specialists     ${options.specialists ? "enabled" : "disabled"}`,
              "",
              "Credentials in use:",
              configuredKeys.length
                ? configuredKeys
                    .map((key) => {
                      const envName = { openAlexApiKey: "OPENALEX_API_KEY", ncbiApiKey: "NCBI_API_KEY", ncbiEmail: "NCBI_EMAIL" }[key]
                      return `  ${key}  (from ${options[key] ? "plugin options" : envName}, forwarded to notebook runs as ${key === "ncbiEmail" ? "NCBI_EMAIL + CONTACT_EMAIL" : envName})`
                    })
                    .join("\n")
                : "  none configured. An NCBI key raises the PubMed rate limit from 3 to 10 requests a",
              `  second, and an OpenAlex key is what the literature-review helpers require before they run.`,
              "",
              "Results published with publish_artifact carry a checksum, the producing code,",
              "its input files, and the environment. Evidence that could not be recorded is",
              "marked unavailable with a reason rather than inferred.",
            ].join("\n"),
            delivery,
          })
        },
      })
    })

    return () => {
      log("unloaded")
    }
  },
})