// GENERATED FILE — do not edit by hand.
//
// The tool surface served to a workspace-bound external MCP session whose
// workspace has no single live view — none open, or more than one (#12082).
// Regenerate with:
//
//   UPDATE_MCP_BASE_MANIFEST=1 npx vitest run src/services/actions/__tests__/mcpExternalBaseManifest.test.ts
//
// The generator drives the real `ActionService` over the real action registry,
// so this is a projection of production code rather than a second source of
// truth. The same test fails when this file drifts from it.

import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

export const MCP_EXTERNAL_BASE_MANIFEST: readonly ActionManifestEntry[] = [
  {
    band: "reversible",
    category: "introspection",
    danger: "safe",
    description:
      "Snapshot what the user currently has open — active project, worktree, focused terminal, and panel state. Call this first to resolve an implicit 'current' target before an action that needs an explicit id. Anything not focused or active is simply absent, so treat a missing field as nothing being selected. It can fail early in a session, before the worktree view store has initialised.",
    enabled: true,
    id: "actions.getContext",
    kind: "query",
    mcpVisibility: "core",
    name: "actions.getContext",
    requiresArgs: false,
    title: "Get Action Context",
  },
  {
    band: "reversible",
    category: "introspection",
    danger: "safe",
    description:
      "Fetch one action's full manifest entry — the exact arguments it accepts, the shape it returns, and a policy record saying whether this session can call it, at which tier, and whether confirmation applies. Use it after finding a candidate by search or listing, before dispatching. An unknown, hidden or restricted id comes back as a structured failure rather than a thrown error.",
    enabled: true,
    examples: [
      {
        args: {
          actionId: "terminal.getStatus",
        },
        description:
          "Inspect the input and output schema of a terminal status tool before calling it",
      },
    ],
    id: "actions.getSchema",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        actionId: {
          type: "string",
          minLength: 1,
          description:
            "Identifies the action to inspect, using an id from a registry search or listing. This is a Daintree action id passed as a value, not the name of a tool to call.",
        },
      },
      required: ["actionId"],
    },
    kind: "query",
    mcpVisibility: "core",
    name: "actions.getSchema",
    requiresArgs: true,
    title: "Get Action Schema",
  },
  {
    band: "reversible",
    category: "introspection",
    danger: "safe",
    description:
      "Enumerate the available actions as lightweight entries, filtered by domain or substring and returned a page at a time. Use ranked search instead when looking for a capability by intent; use this when walking a domain systematically. Entries omit argument and result schemas to stay small, so fetch one action's schema before dispatching. Ordering is stable, so paging cannot skip or repeat entries.",
    enabled: true,
    id: "actions.list",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        category: {
          description: "Filter by exact category (e.g. terminal, worktree, forge, git, portal)",
          type: "string",
        },
        search: {
          description: "Search in action id, title, or description",
          type: "string",
        },
        enabledOnly: {
          description: "Only return enabled actions (default: false)",
          type: "boolean",
        },
        limit: {
          default: 50,
          description: "Max actions to return (1-100, default 50)",
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        offset: {
          default: 0,
          description: "Number of matching actions to skip (default: 0)",
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
        },
      },
    },
    kind: "query",
    mcpVisibility: "core",
    name: "actions.list",
    requiresArgs: false,
    title: "List Actions",
  },
  {
    band: "reversible",
    category: "introspection",
    danger: "safe",
    description:
      "Find actions by describing what you want to do, ranked by how well each matches. This is the discovery path: start here, then fetch the chosen action's schema before dispatching it. Use the plain listing when walking a domain systematically rather than searching by intent. Results omit argument and result schemas to stay small, and matching nothing returns an empty list rather than failing.",
    enabled: true,
    examples: [
      {
        args: {
          query: "terminal output",
        },
        description: "Find actions related to reading terminal output",
      },
      {
        args: {
          query: "list worktrees",
          limit: 5,
        },
        description: "Find the top 5 worktree-listing actions",
      },
    ],
    id: "actions.search",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Natural-language query or keywords to search for",
        },
        limit: {
          default: 20,
          description: "Max results (1-100, default 20)",
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["query"],
    },
    kind: "query",
    mcpVisibility: "core",
    name: "actions.search",
    requiresArgs: true,
    title: "Search Actions",
  },
  {
    band: "reversible",
    category: "agent",
    danger: "safe",
    description:
      "Start an AI agent in a new terminal and report where it landed, so parallel launches can be told apart without re-resolving the target. Success means the panel was created and its process is starting, not that the agent is ready; poll its state or a terminal status snapshot for that. A missing CLI opens a setup diagnostic panel instead. Keep concurrent launches modest.",
    enabled: true,
    id: "agent.launch",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        agentId: {
          anyOf: [
            {
              type: "string",
              enum: [
                "claude",
                "opencode",
                "aider",
                "gemini",
                "antigravity",
                "codex",
                "grok",
                "cursor",
                "copilot",
                "goose",
                "amp",
                "crush",
                "qwen",
                "kimi",
                "interpreter",
                "mistral",
                "kiro",
                "daintree-assistant",
                "terminal",
                "browser",
                "dev-preview",
              ],
            },
            {
              type: "string",
              minLength: 1,
            },
          ],
          description:
            "Which agent CLI to run, from the agent-listing capability. Enumerated ids are built-ins; any other non-empty string is accepted, so a bad id fails at launch, not validation.",
        },
        location: {
          type: "string",
          enum: ["grid", "dock", "overlay"],
          description:
            'Where to place the panel: "grid" the main panel grid (default), "dock" the sidebar dock, "overlay" a floating overlay outside both.',
        },
        cwd: {
          description:
            "Absolute directory to start the agent process in. This is the launch directory, not a worktree selector — name the worktree separately. Defaults to the resolved worktree root.",
          type: "string",
        },
        worktreeId: {
          description:
            "Identifies the worktree to launch in, using an id from the worktree-listing capability. Defaults to the active worktree.",
          type: "string",
        },
        prompt: {
          description:
            "Initial text submitted to the agent once it starts, as its first turn. Omit to leave the agent waiting for input.",
          type: "string",
        },
        interactive: {
          description:
            "Whether the agent runs as a conversation the user can continue, rather than a single non-interactive pass.",
          type: "boolean",
        },
        model: {
          description:
            "Overrides the model the agent CLI would otherwise pick. Accepted values are the agent's own model names, so an unrecognised one fails when the CLI starts rather than here.",
          type: "string",
        },
        presetId: {
          description:
            "Applies one of the user's saved launch presets for this agent. Pass an explicit null to ignore the configured default preset rather than inherit it.",
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
        },
        activateDockOnCreate: {
          description:
            "Whether to open the sidebar dock when the agent is placed there. Only meaningful for a dock placement; it changes what the user sees.",
          type: "boolean",
        },
        env: {
          description:
            "Extra environment variables for the agent process, merged over the inherited environment. These reach a real subprocess, so never put credentials here that the user has not already agreed to expose.",
          type: "object",
          propertyNames: {
            type: "string",
          },
          additionalProperties: {
            type: "string",
          },
        },
        excludeFromPersistence: {
          description:
            "Keeps the terminal out of the saved session, so it does not return after a restart. It also hides the panel from listings, status snapshots and agent-state reads, and spares it from bulk close and kill, so the caller cannot find or poll it afterwards. Use for throwaway work.",
          type: "boolean",
        },
        removeOnExit: {
          description:
            "Closes the panel automatically once the agent process ends, discarding its output. Leave off when the output still needs reading.",
          type: "boolean",
        },
        agentLaunchFlags: {
          description:
            "Extra command-line flags passed through to the agent CLI verbatim. Unrecognised flags fail when the CLI starts, not here.",
          type: "array",
          items: {
            type: "string",
          },
        },
        spawnedBy: {
          type: "string",
          enum: ["quickrun", "recipe", "agent", "palette", "mcp", "assistant"],
          description:
            "Provenance for run history only; never changes what is launched. Leave unset over MCP, where the bridge stamps its own origin.",
        },
        focusPolicy: {
          type: "string",
          enum: ["auto", "preserve", "take"],
          description:
            'Whether the new panel takes keyboard focus: "auto" (default) takes it unless the assistant owns input, "preserve" never takes it, "take" always does. Prefer preserve for background spawns so the user is not interrupted.',
        },
        requestedId: {
          description:
            "Asks for a specific panel id when the terminal is created, so a caller can correlate the launch it requested with the terminal it got.",
          type: "string",
        },
        force: {
          description:
            "Skips the check that the agent's CLI can actually run. Without it an unlaunchable CLI opens a setup diagnostic instead of failing; with it the process is started anyway and simply fails. Leave it off unless the check itself is known to be wrong.",
          type: "boolean",
        },
        name: {
          description:
            'Always provide a short, task-descriptive name for the terminal tab, at most 200 characters (e.g. "Claude: auth refactor"), so the user can tell parallel agents apart. Pins the title so agent detection cannot overwrite it. Empty/whitespace falls back to the default title.',
          type: "string",
          maxLength: 200,
        },
      },
      required: ["agentId"],
    },
    kind: "command",
    name: "agent.launch",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        launched: {
          type: "boolean",
        },
        terminalId: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
        },
        location: {
          anyOf: [
            {
              type: "string",
              enum: ["grid", "dock"],
            },
            {
              type: "null",
            },
          ],
        },
        spawnStatus: {
          anyOf: [
            {
              type: "string",
              const: "missing-cli",
            },
            {
              type: "null",
            },
          ],
        },
        worktreeId: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
        },
        worktreePath: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
        },
        branch: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
        },
        cwd: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
        },
      },
      required: [
        "launched",
        "terminalId",
        "location",
        "spawnStatus",
        "worktreeId",
        "worktreePath",
        "branch",
        "cwd",
      ],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "Launch Agent",
  },
  {
    band: "reversible",
    category: "agent",
    danger: "safe",
    description:
      "List every registered agent, built-in, user-defined and plugin-contributed, from the authoritative registry, including ones not currently launchable. Use this before launching so an id is known to exist, and read each entry's launchability rather than assuming membership implies it. Those fields appear only once a live probe of each CLI finishes, and the result says so while that is incomplete.",
    enabled: true,
    id: "agent.listAvailable",
    kind: "query",
    name: "agent.listAvailable",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        complete: {
          type: "boolean",
          const: true,
        },
        availabilityComplete: {
          type: "boolean",
        },
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              displayName: {
                type: "string",
              },
              source: {
                type: "string",
                enum: ["built-in", "user", "plugin"],
              },
              launchable: {
                type: "boolean",
              },
              availability: {
                type: "string",
                enum: ["missing", "installed", "ready", "blocked", "unauthenticated"],
              },
              installed: {
                type: "boolean",
              },
              pinned: {
                type: "boolean",
              },
              toolbarVisible: {
                type: "boolean",
              },
            },
            required: ["id", "displayName", "source"],
            additionalProperties: false,
          },
        },
      },
      required: ["complete", "availabilityComplete", "agents"],
      additionalProperties: false,
    },
    requiresArgs: false,
    title: "List Available Agents",
  },
  {
    band: "reversible",
    category: "agent",
    danger: "safe",
    description:
      "List the launch presets for one agent, merged across user settings, repository preset files and CCR discovery in the precedence the launcher applies, so every id returned is one a launch will accept. Identity only: no environment values or flags. While the completeness flag is false a source is still loading.",
    enabled: true,
    examples: [
      {
        args: {
          agentId: "claude",
        },
        description: "Discover the preset ids available for Claude Code",
      },
    ],
    id: "agent.listPresets",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        agentId: {
          anyOf: [
            {
              type: "string",
              enum: [
                "claude",
                "opencode",
                "aider",
                "gemini",
                "antigravity",
                "codex",
                "grok",
                "cursor",
                "copilot",
                "goose",
                "amp",
                "crush",
                "qwen",
                "kimi",
                "interpreter",
                "mistral",
                "kiro",
                "daintree-assistant",
                "terminal",
                "browser",
                "dev-preview",
              ],
            },
            {
              type: "string",
              minLength: 1,
            },
          ],
          description:
            "Which agent CLI to run, from the agent-listing capability. Enumerated ids are built-ins; any other non-empty string is accepted, so a bad id fails at launch, not validation.",
        },
        projectId: {
          description:
            "Which project's repository presets to include. Defaults to the project this call is dispatched in. Naming one that is not the loaded project returns the other layers and reports the result as incomplete rather than answering for the wrong project.",
          type: "string",
          minLength: 1,
        },
      },
      required: ["agentId"],
    },
    kind: "query",
    name: "agent.listPresets",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        presetsComplete: {
          type: "boolean",
        },
        presets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              name: {
                type: "string",
              },
              source: {
                type: "string",
                enum: ["custom", "project", "ccr", "registry"],
              },
              description: {
                type: "string",
              },
            },
            required: ["id", "name", "source"],
            additionalProperties: false,
          },
        },
      },
      required: ["presetsComplete", "presets"],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "List Agent Presets",
  },
  {
    band: "destructive-local",
    category: "copyTree",
    danger: "safe",
    description:
      "Bundle a worktree's context to a file and onto the system clipboard, replacing what the user had copied. Selection mixes exact files with globs, so this assembles a curated bundle rather than the whole worktree. Agent and MCP callers must name the worktree, not rely on the active one. macOS and Linux copy the file, Windows its path. Never returned inline; check the budget flags for completeness.",
    enabled: true,
    id: "copyTree.generateAndCopyFile",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        worktreeId: {
          description:
            "The worktree to act on, by id from the worktree-listing capability. Omit this and the path to target the active worktree, which fails when none is active.",
          type: "string",
          minLength: 1,
        },
        worktreePath: {
          description:
            "The worktree to act on, by absolute root path, as an alternative to its id. The id wins when both are given; the path is never swapped for the active one.",
          type: "string",
          minLength: 1,
        },
        options: {
          description: "Selection, exclusion, formatting, and size-budget settings for the bundle.",
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["xml", "json", "markdown", "tree", "ndjson", "sarif"],
            },
            filter: {
              description:
                "Selects which files to include, as worktree-relative exact file paths or glob patterns. Patterns match file paths, so a folder needs a glob: pass 'src/panels/**', not 'src/panels'; prefer `scopePaths` when selecting a folder. Combined with `includePaths` when both are given; omit both to include the whole worktree. An empty list or blank entry is rejected rather than read as no filter.",
              anyOf: [
                {
                  type: "string",
                  minLength: 1,
                },
                {
                  minItems: 1,
                  type: "array",
                  items: {
                    type: "string",
                    minLength: 1,
                  },
                },
              ],
            },
            exclude: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
              ],
            },
            always: {
              description:
                "Force-includes matching files, overriding several exclusion layers at once: ignore files, project and config exclusions, your own `exclude`, the `modified`/`changed` git filters, and `maxFileSize`. It is the blunt option: a broad pattern can pull in `node_modules`, and a `../` pattern reaches outside the worktree entirely. What it does not override: `.git`, CopyTree's internal 10MB memory ceiling, and the `maxFileCount`/`maxTotalSize`/`charLimit` budgets, which still drop force-included files. Prefer `scopePaths` with `scopeIgnoresIgnoreFiles` when you only need past an ignore rule.",
              type: "array",
              items: {
                type: "string",
              },
            },
            includePaths: {
              description:
                "Selects which files to include, as worktree-relative exact file paths or glob patterns. Patterns match file paths, so a folder needs a glob: pass 'src/panels/**', not 'src/panels'; prefer `scopePaths` when selecting a folder. Use this to assemble a curated bundle of scattered files — sources, their supporting code, and their tests — in one call. Combined with `filter` when both are given. Unlike `scopePaths` this does not restrict traversal, so patterns may match anywhere in the worktree.",
              minItems: 1,
              type: "array",
              items: {
                type: "string",
                minLength: 1,
              },
            },
            scopePaths: {
              description:
                "Restricts the copy to these subtrees, as worktree-relative literal file or directory paths to walk — not glob patterns, so pass 'src/panels', not 'src/panels/**'. Prefer this over `filter` or `includePaths` when selecting a folder. Omit to include the whole worktree; supplying an empty list is rejected rather than treated as no scoping, since that would silently copy everything. This restricts traversal, so `filter` and `includePaths` can only narrow within these paths and never add a file outside them.",
              minItems: 1,
              type: "array",
              items: {
                type: "string",
                minLength: 1,
              },
            },
            scopeIgnoresIgnoreFiles: {
              description:
                "Lets `scopePaths` into subtrees an ignore file would have pruned (default false — a scoped copy returns what a whole-worktree copy would have returned). Requires `scopePaths` and is rejected without it. Set true when a path you named is being dropped by a `.copytreeignore` or `.gitignore` rule: only the rules blocking entry into each scoped path are removed, from those two ignore files. Unrelated rules in the same files, negations, and ignore files at or below the selection all still apply — as do project and config exclusions such as node_modules, your own `exclude`, `.git`, the `modified`/`changed` filters, `maxFileSize` and every budget. To get past a rule declared inside a selected folder, scope the exact file instead of that folder: a scoped directory subsumes any of its children you also list, so naming both changes nothing.",
              type: "boolean",
            },
            modified: {
              type: "boolean",
            },
            changed: {
              type: "string",
            },
            maxFileSize: {
              description:
                "Per-file size cap in bytes; must be positive. Omit for no per-file cap.",
              type: "integer",
              exclusiveMinimum: 0,
              maximum: 9007199254740991,
            },
            maxTotalSize: {
              description:
                "Total bundle size cap in bytes; must be positive. Omit for no total cap.",
              type: "integer",
              exclusiveMinimum: 0,
              maximum: 9007199254740991,
            },
            maxFileCount: {
              description:
                "Maximum number of files to include; must be positive. Omit for no file-count cap.",
              type: "integer",
              exclusiveMinimum: 0,
              maximum: 9007199254740991,
            },
            withLineNumbers: {
              type: "boolean",
            },
            charLimit: {
              description:
                "Character cap on the rendered bundle; must be positive. Omit for no cap.",
              type: "integer",
              exclusiveMinimum: 0,
              maximum: 9007199254740991,
            },
            sort: {
              type: "string",
              enum: ["path", "size", "modified", "name", "extension", "depth"],
            },
          },
        },
        name: {
          description:
            "Short human-readable label for this copy tree, shown in the user's copy-tree history and in the completion notification. Use 2 to 4 words, for example 'auth flow context'. Omitted, the notification is unlabelled and the history entry keeps or derives its own label.",
          type: "string",
        },
      },
    },
    kind: "command",
    mcpAnnotations: {
      destructiveHint: true,
      idempotentHint: false,
    },
    name: "copyTree.generateAndCopyFile",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        filePath: {
          type: "string",
        },
        fileCount: {
          type: "number",
        },
        outputBytes: {
          type: "number",
        },
        stats: {
          type: "object",
          properties: {
            totalSize: {
              type: "number",
            },
            duration: {
              type: "number",
            },
            estimatedTokens: {
              description: "Rough token count, accurate to about ±20%",
              type: "number",
            },
            noFilesMatched: {
              description: "Nothing matched — a valid outcome, not error",
              type: "boolean",
            },
            unmatchedSelector: {
              description:
                "Which supplied selector matched no files. For a folder, add '/**' to the pattern or use scopePaths instead.",
              type: "string",
              enum: ["filter", "includePaths", "filterAndIncludePaths"],
            },
            truncated: {
              description: "A budget dropped or cut short some files",
              type: "boolean",
            },
            truncatedCount: {
              type: "number",
            },
            truncatedBy: {
              description: "Which budget bit first: maxFileCount, maxTotalSize or charLimit",
              type: "string",
            },
            budgetExceeded: {
              description:
                "The retained set is larger than maxTotalSize — can be true without truncation",
              type: "boolean",
            },
          },
          required: ["totalSize", "duration"],
          additionalProperties: false,
        },
      },
      required: ["filePath", "fileCount", "outputBytes"],
      additionalProperties: false,
    },
    requiresArgs: false,
    title: "Generate And Copy Context",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Read a snapshot of the in-app fleet broadcast the user is currently running, including per-terminal delivery and liveness. This only observes and dispatches nothing, so drive a fan-out by sending to each terminal yourself and watching with a status snapshot or batched wait. Agent state here is a passive heuristic and a parsed check result is not an exit code; confirm both before acting.",
    enabled: true,
    id: "fleet.getRunStatus",
    kind: "query",
    mcpAnnotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
    name: "fleet.getRunStatus",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        run: {
          anyOf: [
            {
              type: "object",
              properties: {
                runId: {
                  type: "string",
                },
                status: {
                  type: "string",
                  enum: [
                    "submitting",
                    "watching",
                    "completed",
                    "cancelled",
                    "failed",
                    "superseded",
                  ],
                },
                isRetry: {
                  type: "boolean",
                },
                draftPreview: {
                  type: "string",
                },
                startedAt: {
                  type: "number",
                },
                endedAt: {
                  type: "number",
                },
                counts: {
                  type: "object",
                  properties: {
                    total: {
                      type: "integer",
                      minimum: -9007199254740991,
                      maximum: 9007199254740991,
                    },
                    sent: {
                      type: "integer",
                      minimum: -9007199254740991,
                      maximum: 9007199254740991,
                    },
                    sendFailed: {
                      type: "integer",
                      minimum: -9007199254740991,
                      maximum: 9007199254740991,
                    },
                    skipped: {
                      type: "integer",
                      minimum: -9007199254740991,
                      maximum: 9007199254740991,
                    },
                    working: {
                      type: "integer",
                      minimum: -9007199254740991,
                      maximum: 9007199254740991,
                    },
                    waiting: {
                      type: "integer",
                      minimum: -9007199254740991,
                      maximum: 9007199254740991,
                    },
                    done: {
                      type: "integer",
                      minimum: -9007199254740991,
                      maximum: 9007199254740991,
                    },
                  },
                  required: [
                    "total",
                    "sent",
                    "sendFailed",
                    "skipped",
                    "working",
                    "waiting",
                    "done",
                  ],
                  additionalProperties: false,
                },
                targets: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      terminalId: {
                        type: "string",
                      },
                      title: {
                        type: "string",
                      },
                      worktreeId: {
                        anyOf: [
                          {
                            type: "string",
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      submission: {
                        type: "string",
                        enum: ["pending", "sent", "failed", "skipped"],
                      },
                      failureKind: {
                        type: "string",
                        enum: ["permanent", "transient"],
                      },
                      failureReason: {
                        type: "string",
                      },
                      agentState: {
                        anyOf: [
                          {
                            type: "string",
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      waitingReason: {
                        type: "string",
                      },
                      exitCode: {
                        anyOf: [
                          {
                            type: "integer",
                            minimum: -9007199254740991,
                            maximum: 9007199254740991,
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      settled: {
                        type: "boolean",
                      },
                      gone: {
                        type: "boolean",
                      },
                      lastCheckResult: {
                        type: "object",
                        properties: {
                          command: {
                            anyOf: [
                              {
                                type: "string",
                              },
                              {
                                type: "null",
                              },
                            ],
                          },
                          passed: {
                            type: "boolean",
                          },
                          ranAt: {
                            type: "number",
                          },
                          failureSummary: {
                            anyOf: [
                              {
                                type: "string",
                              },
                              {
                                type: "null",
                              },
                            ],
                          },
                          truncated: {
                            type: "boolean",
                          },
                        },
                        required: ["command", "passed", "ranAt", "failureSummary", "truncated"],
                        additionalProperties: false,
                      },
                    },
                    required: [
                      "terminalId",
                      "title",
                      "worktreeId",
                      "submission",
                      "agentState",
                      "settled",
                      "gone",
                    ],
                    additionalProperties: false,
                  },
                },
              },
              required: [
                "runId",
                "status",
                "isRetry",
                "draftPreview",
                "startedAt",
                "counts",
                "targets",
              ],
              additionalProperties: false,
            },
            {
              type: "null",
            },
          ],
        },
        armedCount: {
          type: "integer",
          minimum: -9007199254740991,
          maximum: 9007199254740991,
        },
      },
      required: ["run", "armedCount"],
      additionalProperties: false,
    },
    requiresArgs: false,
    title: "Fleet: Get run status",
  },
  {
    band: "reversible",
    category: "introspection",
    danger: "safe",
    description:
      "Report this session's tool surface as data: its authorization tier, a stable hash, and per-tool tier, kind, read-only and idempotency hints, and deprecation. Call it once at startup to check the surface matches what this client was built against, then re-read the hash to detect drift without diffing everything. It describes exactly what tools/list returns for this session.",
    enabled: true,
    id: "mcp.surface",
    kind: "query",
    mcpVisibility: "core",
    name: "mcp.surface",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        manifestVersion: {
          type: "integer",
          exclusiveMinimum: 0,
          maximum: 9007199254740991,
          description: "Shape version of this payload, bumped when its fields change meaning",
        },
        appVersion: {
          type: "string",
          description: "The running Daintree build",
        },
        tier: {
          type: "string",
          enum: ["workbench", "action", "system", "external"],
          description: "The authorization tier this call was admitted at",
        },
        hash: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description:
            "Hex SHA-256 of the surface; compare it later to detect drift without diffing",
        },
        tools: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              tier: {
                type: "string",
                enum: ["workbench", "action", "system", "external"],
                description: "Lowest tier on this caller's ladder that permits the tool",
              },
              kind: {
                type: "string",
                enum: ["command", "query"],
              },
              readOnlyHint: {
                type: "boolean",
                description: "The tool does not modify state, so a retry is safe",
              },
              idempotentHint: {
                type: "boolean",
                description: "Repeating the call with the same arguments has no additional effect",
              },
              deprecated: {
                description: "Present only when the tool is on its way out",
                type: "object",
                properties: {
                  reason: {
                    type: "string",
                  },
                  replacedBy: {
                    type: "string",
                  },
                },
                required: ["reason"],
                additionalProperties: false,
              },
            },
            required: ["id", "tier", "kind", "readOnlyHint", "idempotentHint"],
            additionalProperties: false,
          },
          description: "Every tool `tools/list` advertises to this session, sorted by id",
        },
      },
      required: ["manifestVersion", "appVersion", "tier", "hash", "tools"],
      additionalProperties: false,
    },
    requiresArgs: false,
    title: "Get MCP Surface",
  },
  {
    band: "reversible",
    category: "recipes",
    danger: "safe",
    description:
      "List the saved recipes for the current project — named multi-terminal setups the user has configured, plus any a plugin contributes. Use this to discover recipe ids before running one; each entry reports its origin. It never fails, and it reports whether recipes are still loading: an empty list while loading means not read yet, not that the project has none.",
    enabled: true,
    id: "recipe.list",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        worktreeId: {
          description:
            "Restricts the listing to recipes available in one worktree, using an id from the worktree-listing capability. Omit it to list every recipe in the project rather than the active worktree's.",
          type: "string",
        },
      },
    },
    kind: "query",
    name: "recipe.list",
    requiresArgs: false,
    title: "List Recipes",
  },
  {
    band: "destructive-local",
    category: "recipes",
    danger: "confirm",
    dangerRationale:
      "Spawns the recipe's terminals, each running shell commands or launching agents. Agent-initiated runs are confirmation-gated so a single dispatch can't open many terminals unprompted.",
    description:
      "Launch the terminals a saved recipe defines, in one worktree, as a repeatable multi-pane setup. Launch a single agent or a plain terminal instead when only one pane is wanted. This creates several panels at once and starts their configured commands or agents. An automated caller gets at most the first three of them; the rest come back as failures, so check what actually started.",
    enabled: true,
    id: "recipe.run",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        recipeId: {
          type: "string",
          description:
            "Identifies which saved recipe to run, using an id from the recipe-listing capability. An unknown id fails before any terminal is created.",
        },
        worktreeId: {
          description:
            "Identifies the worktree to launch the recipe terminals in, using an id from the worktree-listing capability. Defaults to the active worktree.",
          type: "string",
        },
        spawnedBy: {
          type: "string",
          enum: ["quickrun", "recipe", "agent", "palette", "mcp", "assistant"],
          description:
            "Provenance for run history only; never changes what is launched. Leave unset over MCP, where the bridge stamps its own origin.",
        },
        focusPolicy: {
          type: "string",
          enum: ["auto", "preserve", "take"],
          description:
            'Whether the new panel takes keyboard focus: "auto" (default) takes it unless the assistant owns input, "preserve" never takes it, "take" always does. Prefer preserve for background spawns so the user is not interrupted.',
        },
      },
      required: ["recipeId"],
    },
    kind: "command",
    name: "recipe.run",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        spawnedCount: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
        },
        failedCount: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
        },
        spawnedTerminalIds: {
          type: "array",
          items: {
            type: "string",
          },
          description:
            "The panels this run actually started, in spawn order. Use these ids to read output from or close the terminals; the count alone identifies nothing.",
        },
        failedTerminals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: {
                type: "integer",
                minimum: 0,
                maximum: 9007199254740991,
              },
              reason: {
                type: "string",
              },
            },
            required: ["index", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["spawnedCount", "failedCount", "spawnedTerminalIds", "failedTerminals"],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "Run Recipe",
  },
  {
    band: "reversible",
    category: "agent",
    danger: "safe",
    description:
      "Read the full instructions of one plugin-contributed skill, so they can be followed as part of the current task. Find the id with a skills search first — ids are namespaced by plugin and cannot be guessed reliably. An id that matches nothing fails rather than returning empty.",
    enabled: true,
    id: "skills.load",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        id: {
          type: "string",
          minLength: 1,
          description:
            "Identifies the skill to load, using an id from a skills search. Ids are namespaced by the contributing plugin and cannot be guessed reliably.",
        },
      },
      required: ["id"],
    },
    kind: "query",
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    },
    name: "skills.load",
    requiresArgs: true,
    title: "Load skill",
  },
  {
    band: "reversible",
    category: "agent",
    danger: "safe",
    description:
      "Find plugin-contributed skills: reusable written instructions and workflows, such as a review rubric or a test-driven-development procedure, that plugins ship for an agent to follow. This returns names and summaries only, so load a skill by id to read its instructions. Omitting a query lists available skills, but only to the capped limit, and the result never says whether more were left out.",
    enabled: true,
    id: "skills.search",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: {
          description:
            "Keywords to match. Omit or pass an empty string to list skills unfiltered, still bounded by the result limit.",
          type: "string",
        },
        limit: {
          description: "Maximum number of matches to return (default 20, max 50).",
          type: "integer",
          minimum: 1,
          maximum: 50,
        },
      },
    },
    kind: "query",
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    },
    name: "skills.search",
    requiresArgs: false,
    title: "Search skills",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Close a panel this session itself created, usually to the trash, where it is briefly recoverable before its process is killed. Only panels created by this connection can be closed: a panel opened by the user, another client, or a plugin is refused outright, as is an id that never existed. The result names what closed, already gone from the listing by then.",
    enabled: true,
    id: "terminal.closeOwned",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalId: {
          type: "string",
          minLength: 1,
          description:
            "The panel to close, as an `id` this session received when it created the panel. Required — there is no focused-panel fallback, because the focused panel is rarely one this session owns.",
        },
      },
      required: ["terminalId"],
    },
    keywords: ["trash", "dismiss", "cleanup", "owned"],
    kind: "command",
    name: "terminal.closeOwned",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        closedIds: {
          type: "array",
          items: {
            type: "string",
          },
          description:
            "The panels this call closed. Empty means nothing closed: there was no panel to act on, the one named was already in the trash, or its teardown did not complete. Treat an empty array as a failed close rather than a quiet success.",
        },
      },
      required: ["closedIds"],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "Close Owned Terminal",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Read the trailing scrollback of one terminal, to inspect what an agent or command printed. Use the status snapshot when watching several terminals: it fetches tails for a whole fleet in one call, and reading one at a time is the common mistake. ANSI codes are stripped by default; output may be truncated to the requested tail, and a missing terminal returns an error field, not a failed call.",
    enabled: true,
    examples: [
      {
        args: {
          terminalId: "term-abc123",
        },
        description: "Get last 100 lines from a terminal with ANSI stripped",
      },
      {
        args: {
          terminalId: "term-abc123",
          maxLines: 500,
          stripAnsi: false,
        },
        description: "Get last 500 lines with ANSI codes preserved",
      },
    ],
    id: "terminal.getOutput",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalId: {
          type: "string",
          minLength: 1,
          description:
            "Identifies the terminal to act on, using a panel id from the terminal-listing capability. An id no longer tracked comes back as an error field in the result rather than failing the call.",
        },
        maxLines: {
          default: 100,
          description: "Maximum lines to return (default: 100, max: 1000)",
          type: "integer",
          minimum: 1,
          maximum: 1000,
        },
        stripAnsi: {
          default: true,
          description: "Remove ANSI escape codes from output (default: true)",
          type: "boolean",
        },
      },
      required: ["terminalId"],
    },
    kind: "query",
    name: "terminal.getOutput",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalId: {
          type: "string",
        },
        content: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
        },
        lineCount: {
          type: "number",
        },
        truncated: {
          type: "boolean",
        },
        error: {
          type: "string",
        },
      },
      required: ["terminalId", "content", "lineCount", "truncated"],
      additionalProperties: false,
    },
    requiresArgs: true,
    title: "Get Terminal Output",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Snapshot agent and process state across many terminals, with optional output tails. This is the batched polling path: prefer it over listing terminals for agent state, or reading each terminal's output in turn. It never blocks or fails as a whole; an entry's error can mean that terminal was missing or the shared fetch failed. Use the blocking wait to proceed the moment an agent finishes.",
    enabled: true,
    id: "terminal.getStatus",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalIds: {
          description:
            "Explicit terminal IDs to query (1-256). When set, `worktreeId`/`location` filters are ignored. Unknown IDs return per-entry `error` rather than aborting the call.",
          minItems: 1,
          maxItems: 256,
          type: "array",
          items: {
            type: "string",
          },
        },
        worktreeId: {
          description: "Filter by worktree (ignored when `terminalIds` is provided).",
          type: "string",
        },
        location: {
          description:
            "Filter by panel location (ignored when `terminalIds` is provided). Defaults to all locations except trash and background.",
          type: "string",
          enum: ["grid", "dock", "trash", "background"],
        },
        includeOutput: {
          description:
            "Opt-in. When set, each entry includes `recentOutput` with the last N lines of scrollback. Off by default to keep responses small.",
          type: "object",
          properties: {
            lines: {
              default: 20,
              description:
                "Number of trailing scrollback lines to include per terminal (max 50, default 20).",
              type: "integer",
              minimum: 1,
              maximum: 50,
            },
            stripAnsi: {
              default: true,
              description: "Remove ANSI escape codes from `recentOutput` (default: true).",
              type: "boolean",
            },
          },
        },
      },
    },
    kind: "query",
    name: "terminal.getStatus",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              terminalId: {
                type: "string",
              },
              agentId: {
                anyOf: [
                  {
                    type: "string",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              agentState: {
                anyOf: [
                  {
                    type: "string",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              waitingReason: {
                type: "string",
              },
              lastTransitionAt: {
                type: "number",
              },
              exitCode: {
                description:
                  "Present once the process has exited, so its absence means still running. Null means the process was terminated by a signal and produced no numeric code — tell a clean finish from a failure with this rather than by scraping output.",
                anyOf: [
                  {
                    type: "integer",
                    minimum: -9007199254740991,
                    maximum: 9007199254740991,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              spawnedAt: {
                description:
                  "Wall-clock spawn time in epoch milliseconds, for run-duration and staleness checks.",
                type: "number",
              },
              lastCheckResult: {
                description:
                  "A best-effort reading of the agent's most recent test, lint, or build summary, parsed from its output rather than from a process exit code — the check runs inside the terminal, so its real exit status is unobservable. Absence means no recognized summary was seen, which is not the same as no check running and not the same as passing. Check the run time for freshness before trusting it.",
                type: "object",
                properties: {
                  command: {
                    anyOf: [
                      {
                        type: "string",
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  passed: {
                    type: "boolean",
                  },
                  ranAt: {
                    type: "number",
                  },
                  failureSummary: {
                    anyOf: [
                      {
                        type: "string",
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  truncated: {
                    type: "boolean",
                  },
                },
                required: ["command", "passed", "ranAt", "failureSummary", "truncated"],
                additionalProperties: false,
              },
              recentOutput: {
                anyOf: [
                  {
                    type: "string",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              armed: {
                description:
                  "Whether fleet broadcast input is routed to this terminal. Populated for every terminal that was found; absent only when the terminal itself could not be resolved.",
                type: "boolean",
              },
              error: {
                description:
                  "Set when the terminal was not found, and also stamped on every resolved entry when the batched output fetch fails — in that case the status fields are still populated and only the recent output is missing. Its presence therefore does not by itself mean this terminal was unreadable, and it never fails the call as a whole.",
                type: "string",
              },
            },
            required: ["terminalId", "agentId", "agentState"],
            additionalProperties: false,
          },
        },
      },
      required: ["terminals"],
      additionalProperties: false,
    },
    requiresArgs: false,
    title: "Get Terminal Status",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Write the active worktree's prepared context into a terminal, which is how an agent is handed a large codebase context. Name the target terminal explicitly — focus can drift between the call and its execution, and a mistarget types a multi-kilobyte dump into whatever pane happened to be focused. Target an idle terminal.",
    enabled: true,
    id: "terminal.inject",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalId: {
          description:
            "Identifies the terminal to inject into, using a panel id from the terminal-listing capability. An automated caller must name it: focus can drift between the call and its execution, so relying on the focused terminal can land a large context dump in the wrong pane.",
          type: "string",
          minLength: 1,
        },
      },
    },
    kind: "command",
    name: "terminal.inject",
    requiresArgs: false,
    title: "Inject Context",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Enumerate the open terminals and panels, with just enough metadata to pick one. Start here to discover terminal ids, then read status or output for the ones that matter: this is a cheap inventory, not a polling path; the status snapshot carries richer agent state for a fleet in one call. Ephemeral and internal panels are left out; an empty result means none are open, not a failure.",
    enabled: true,
    id: "terminal.list",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        worktreeId: {
          description:
            "Restricts the listing to one worktree, using an id from the worktree-listing capability. Omit to list across every worktree in the project.",
          type: "string",
        },
        location: {
          description:
            "Restricts the listing to terminals in one place: the main grid, the sidebar dock, the trash, or the background. Omitted, trashed and backgrounded terminals are left out, so ask for those explicitly to see them.",
          type: "string",
          enum: ["grid", "dock", "trash", "background"],
        },
      },
    },
    kind: "query",
    name: "terminal.list",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              kind: {
                type: "string",
              },
              type: {
                anyOf: [
                  {},
                  {
                    type: "null",
                  },
                ],
              },
              worktreeId: {
                anyOf: [
                  {
                    type: "string",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              title: {
                anyOf: [
                  {
                    type: "string",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              location: {
                type: "string",
                enum: ["grid", "dock", "overlay", "trash", "background", "dialog"],
              },
              agentId: {
                anyOf: [
                  {
                    type: "string",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              agentState: {
                anyOf: [
                  {
                    type: "string",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              isInputLocked: {
                type: "boolean",
              },
              isFocused: {
                type: "boolean",
              },
            },
            required: [
              "id",
              "kind",
              "worktreeId",
              "title",
              "location",
              "agentId",
              "agentState",
              "isInputLocked",
              "isFocused",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["terminals"],
      additionalProperties: false,
    },
    requiresArgs: false,
    title: "List Terminals",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Open a new terminal in the active worktree, ready for commands. This creates a visible panel and starts a shell process that consumes resources until it is closed. Launch an agent instead when the intent is to start an AI CLI rather than a plain shell.",
    enabled: true,
    id: "terminal.new",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        spawnedBy: {
          type: "string",
          enum: ["quickrun", "recipe", "agent", "palette", "mcp", "assistant"],
          description:
            "Provenance for run history only; never changes what is launched. Leave unset over MCP, where the bridge stamps its own origin.",
        },
        focusPolicy: {
          type: "string",
          enum: ["auto", "preserve", "take"],
          description:
            'Whether the new panel takes keyboard focus: "auto" (default) takes it unless the assistant owns input, "preserve" never takes it, "take" always does. Prefer preserve for background spawns so the user is not interrupted.',
        },
      },
    },
    kind: "command",
    name: "terminal.new",
    requiresArgs: false,
    title: "New Terminal",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Queue text as one submission to a terminal: a shell runs it as a command, an agent pane receives it as the next prompt. Embedded newlines become line breaks rather than firing off a partial message. This returns once the submission is queued, not once it has been delivered or run, so inspect the terminal afterwards to see what happened. It runs with the terminal's own privileges.",
    enabled: true,
    id: "terminal.sendCommand",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalId: {
          type: "string",
          minLength: 1,
          description:
            "Identifies the terminal to submit to, using a panel id from the terminal-listing capability.",
        },
        command: {
          type: "string",
          minLength: 1,
          description:
            "Text to submit. Runs as a shell command in a plain terminal, or is submitted as the next prompt/turn in an agent pane. Multi-line is delivered atomically and submitted with a single Enter, so interior newlines never prematurely submit.",
        },
      },
      required: ["terminalId", "command"],
    },
    kind: "command",
    name: "terminal.sendCommand",
    requiresArgs: true,
    title: "Submit text to terminal",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Block until the agent in one terminal stops working, so the next step sees finished output. Use the batched wait for several terminals, or a status snapshot to poll without blocking. It can hold open for a minute interactively, far longer headless. Timing out is normal and means still working; an exit code appears only once the process ends, so confirm success there before acting irreversibly.",
    enabled: true,
    id: "terminal.waitUntilIdle",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalId: {
          type: "string",
          minLength: 1,
          description:
            "Identifies the terminal to act on, using a panel id from the terminal-listing capability. An id no longer tracked resolves as idle rather than failing.",
        },
        timeoutMs: {
          description:
            "Pass 0 for an immediate non-blocking snapshot — the recommended mode. Otherwise, the maximum time to long-poll in milliseconds; defaults to 60s. Interactive sessions are capped at 60s server-side; headless sessions may block up to 2 hours.",
          type: "integer",
          minimum: 0,
          maximum: 7200000,
        },
      },
      required: ["terminalId"],
    },
    kind: "query",
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: false,
      destructiveHint: false,
    },
    name: "terminal.waitUntilIdle",
    requiresArgs: true,
    title: "Wait until terminal idle",
  },
  {
    band: "reversible",
    category: "terminal",
    danger: "safe",
    description:
      "Block until the first of several agents stops working, or until all of them do; the fan-out primitive when agents finish at different speeds. Use this rather than waiting on each terminal in turn, or a status snapshot to poll without blocking. It can hold the call open for a minute interactively, far longer headless. Timing out means not met yet; untracked terminals count as finished.",
    enabled: true,
    id: "terminal.waitUntilIdleBatch",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        terminalIds: {
          minItems: 1,
          maxItems: 256,
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
          description:
            "Identifies the terminals to watch (1-256), using panel ids from the terminal-listing capability. Ids no longer tracked count as already finished rather than failing the batch.",
        },
        mode: {
          description:
            "Whether to return as soon as any one terminal stops working (the default, for dispatching follow-up work as each agent frees up) or only once every terminal has stopped (a join barrier).",
          type: "string",
          enum: ["first", "all"],
        },
        timeoutMs: {
          description:
            "Pass 0 for an immediate non-blocking snapshot. Otherwise the maximum time to long-poll in milliseconds; defaults to 60s. Interactive sessions are capped at 60s server-side; headless sessions may block up to 2 hours.",
          type: "integer",
          minimum: 0,
          maximum: 7200000,
        },
      },
      required: ["terminalIds"],
    },
    kind: "query",
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: false,
      destructiveHint: false,
    },
    name: "terminal.waitUntilIdleBatch",
    requiresArgs: true,
    title: "Wait until terminals idle (batch)",
  },
  {
    band: "reversible",
    category: "worktree",
    danger: "safe",
    description:
      "Create a git worktree with its branch, optionally tracking a pull request, and optionally launch a recipe's terminals in it. This is the heavy composite path: it writes to disk, may check out a remote branch, and may start several processes. Create the worktree alone when neither is wanted. Partial failure is possible: the worktree can exist while its recipe did not fully start.",
    enabled: true,
    id: "worktree.createWithRecipe",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        branchName: {
          description:
            "Name for the new branch (will be sanitized for git compatibility). Required unless pullRequestNumber is provided — the PR's head branch is used in that case.",
          type: "string",
          minLength: 1,
        },
        baseBranch: {
          description: "Branch to base the worktree on (defaults to main worktree's branch)",
          type: "string",
          minLength: 1,
        },
        recipeId: {
          description: "Recipe ID to run after creation",
          type: "string",
        },
        fromRemote: {
          description: "Set true if baseBranch is a remote branch",
          type: "boolean",
        },
        useExistingBranch: {
          description: "Use an existing branch instead of creating a new one",
          type: "boolean",
        },
        issueNumber: {
          description:
            "Issue number to link with the worktree. Mutually exclusive with pullRequestNumber.",
          type: "integer",
          exclusiveMinimum: 0,
          maximum: 9007199254740991,
        },
        pullRequestNumber: {
          description:
            "Pull request number to check out. Resolves the PR's head branch automatically and creates the worktree on it. Mutually exclusive with issueNumber.",
          type: "integer",
          exclusiveMinimum: 0,
          maximum: 9007199254740991,
        },
        assignToSelf: {
          description:
            "Assign the linked issue to the current user. Omit to use the user's persisted 'Assign issue to me' preference (mirrors the new-worktree dialog checkbox).",
          type: "boolean",
        },
        spawnedBy: {
          type: "string",
          enum: ["quickrun", "recipe", "agent", "palette", "mcp", "assistant"],
          description:
            "Provenance for run history only; never changes what is launched. Leave unset over MCP, where the bridge stamps its own origin.",
        },
        focusPolicy: {
          type: "string",
          enum: ["auto", "preserve", "take"],
          description:
            'Whether the new panel takes keyboard focus: "auto" (default) takes it unless the assistant owns input, "preserve" never takes it, "take" always does. Prefer preserve for background spawns so the user is not interrupted.',
        },
      },
    },
    kind: "command",
    name: "worktree.createWithRecipe",
    requiresArgs: false,
    title: "Create Worktree with Recipe",
  },
  {
    band: "destructive-local",
    category: "worktree",
    danger: "confirm",
    dangerRationale:
      "Deletes the working tree from disk. Recovery requires re-creating the worktree, so the session's own ownership record is a precondition rather than the approval.",
    description:
      "Delete a worktree this session itself created, removing its directory from disk after the user confirms. Only worktrees created by this connection can be deleted; anything else is refused. It will not force past uncommitted or untracked changes, delete the branch, or close terminals it does not own — commit or close those first.",
    enabled: true,
    id: "worktree.deleteOwned",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        worktreeId: {
          type: "string",
          minLength: 1,
          description:
            "The worktree to delete, as the `worktreeId` this session received when it created the worktree.",
        },
      },
      required: ["worktreeId"],
    },
    kind: "command",
    name: "worktree.deleteOwned",
    requiresArgs: true,
    title: "Delete Owned Worktree",
  },
  {
    band: "reversible",
    category: "worktree",
    danger: "safe",
    description:
      "Get the worktree currently in use, which is what most work should be scoped to. Use the full worktree listing only when you genuinely need the others. An empty result means no worktree is active, or the active one can no longer be found — either way, handle it before acting.",
    enabled: true,
    id: "worktree.getCurrent",
    kind: "query",
    name: "worktree.getCurrent",
    requiresArgs: false,
    title: "Get Current Worktree",
  },
  {
    band: "reversible",
    category: "worktree",
    danger: "safe",
    description:
      "List every worktree in the active project with its branch, status and any linked issue or pull request. Use this to discover worktree ids; ask for the current worktree instead when all you need is the one in use. It never fails — an empty list means the project has no worktrees.",
    enabled: true,
    id: "worktree.list",
    kind: "query",
    name: "worktree.list",
    requiresArgs: false,
    title: "List Worktrees",
  },
  {
    band: "reversible",
    category: "worktree",
    danger: "safe",
    description:
      "Switch which worktree is the active one, changing the default target for everything scoped to 'the current worktree' and moving what the user sees. Call this deliberately — subsequent actions that omit a worktree will follow it, so switching mid-task can silently retarget later work.",
    enabled: true,
    id: "worktree.setActive",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        worktreeId: {
          type: "string",
          description:
            "Identifies the worktree to make active, using an id from the worktree-listing capability. Everything later scoped to the current worktree follows this.",
        },
      },
      required: ["worktreeId"],
    },
    kind: "command",
    name: "worktree.setActive",
    requiresArgs: true,
    title: "Set Active Worktree",
  },
];
