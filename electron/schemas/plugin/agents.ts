// Agent-facing contributions: MCP servers, agent MCP endpoints, process tools and agent CLIs.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_MAX_GROUPS_PER_ENDPOINT,
  AGENT_MCP_MAX_TOOLS_PER_ENDPOINT,
  AGENT_MCP_SERVER_TOOL_NAME_PATTERN,
  AGENT_MCP_TOOL_NAME_PATTERN,
} from "../../../shared/types/plugin.js";
import { LAUNCH_MCP_FORMATS } from "../../../shared/config/launchMcp.js";
import {
  BINARY_EXEC_SUBCOMMANDS,
  stripCommandExecutableExtension,
} from "../../services/ProcessDetector/commandParser.js";
import { isSafeShellOption } from "../../../shared/utils/shellEscape.js";
import { utf8Length } from "./common.js";

/**
 * Stdio-only MCP server contribution. Shape mirrors the Claude Desktop /
 * Cursor MCP server config. `url` is absent by design — HTTP/SSE transport
 * is rejected at the schema boundary. The MCP Authorization spec carves
 * stdio out of OAuth, and the official SDKs' HTTP transports have a
 * documented history of DNS-rebinding flaws (CVE-2025-66414,
 * CVE-2025-66416, CVE-2026-34742). Strict so unknown fields from plugin
 * authors are rejected loudly rather than silently dropped.
 */
export const McpServerContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * One `contributes.agentMcp[].groups` entry: a set of the plugin's tools the
 * user allows on its own. `access` is the plugin's description of the group,
 * shown as such; it never allows anything by itself.
 */
export const AgentMcpToolGroupSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400).optional(),
    access: z.enum(["read", "write"]),
  })
  .strict();

/** One tool an `agentMcp` endpoint serves from its source server, under an agent-facing name. */
export const AgentMcpServerSourceToolSchema = z
  .object({
    name: z.string().regex(AGENT_MCP_TOOL_NAME_PATTERN, {
      message:
        "name must be lowercase letters, digits and underscores, starting with a letter, at most 32 characters",
    }),
    serverTool: z.string().regex(AGENT_MCP_SERVER_TOOL_NAME_PATTERN, {
      message: "serverTool must be 1-128 characters of letters, digits, '_', '-' or '.'",
    }),
    group: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    description: z
      .string()
      .refine((value) => value.trim().length > 0, { message: "description must not be blank" })
      .refine((value) => utf8Length(value) <= AGENT_MCP_MAX_DESCRIPTION_BYTES, {
        message: `description must be at most ${AGENT_MCP_MAX_DESCRIPTION_BYTES} UTF-8 bytes`,
      })
      .optional(),
  })
  .strict();

/**
 * `contributes.agentMcp[].source` — the endpoint's tools come from one of the
 * plugin's own `mcpServers`, chosen one by one. Never a wildcard: a server that
 * later lists more tools must not hand agents anything the manifest didn't name.
 */
export const AgentMcpServerSourceSchema = z
  .object({
    mcpServer: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    tools: z.array(AgentMcpServerSourceToolSchema).min(1).max(AGENT_MCP_MAX_TOOLS_PER_ENDPOINT),
  })
  .strict();

/**
 * `contributes.agentMcp` manifest entry — an MCP tools endpoint the plugin
 * serves to terminal agents. Declarative only: the tool roster arrives at
 * activation through `host.mcp.registerTools`, or from the contributed server
 * `source` names, so the manifest carries nothing an agent sees beyond the
 * names. Strict so a stray field (a `url`, a `command`) is rejected rather
 * than read as a transport the host will not honour.
 */
export const AgentMcpContributionSchema = z
  .object({
    // `.` and `..` pass the id grammar but are dot-segments in the endpoint's
    // URL path, which URL parsing removes — the endpoint would be unreachable.
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => id !== "." && id !== "..", {
        message: 'agentMcp id cannot be "." or ".."',
      }),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400).optional(),
    mode: z.literal("tools"),
    groups: z
      .array(AgentMcpToolGroupSchema)
      .min(1)
      .max(AGENT_MCP_MAX_GROUPS_PER_ENDPOINT)
      .refine((groups) => new Set(groups.map((group) => group.id)).size === groups.length, {
        message: "agentMcp group ids must be unique",
      })
      .optional(),
    source: AgentMcpServerSourceSchema.optional(),
  })
  .strict();

/**
 * Bare executable name a plugin process-tool detection matches, in the same key
 * space as the built-in `PROCESS_TOOL_REGISTRY` commands (`vite`, `redis-cli`,
 * `python3`, `gradlew`). Lowercase is enforced rather than normalized:
 * `ProcessDetector` lower-cases every candidate before lookup, so a mixed-case
 * key would silently never match — failing loudly at parse time beats a
 * detection that quietly does nothing.
 */
const PROCESS_TOOL_COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Command names that would index an inherited member on any prototype-bearing
 * lookup table. The registries this feeds are all null-prototype, so these are
 * inert in practice — rejected anyway so a manifest never advertises a command
 * whose detection depends on that invariant holding everywhere forever.
 * Mirrors {@link RESERVED_CREDENTIAL_FIELD_IDS}. (`__proto__` is already
 * excluded by the leading-alphanumeric rule above; listed for completeness.)
 */
const RESERVED_PROCESS_TOOL_COMMANDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Shells and launcher wrappers — names that identify the process *running* a
 * tool rather than a tool. None of them appear in `PROCESS_TOOL_ICON_BY_COMMAND`
 * or `AGENT_CLI_NAMES`, so the manifest-level built-in collision checks never
 * see them, yet claiming one is a wider version of the `exec`/`dlx`/`x` hole
 * {@link BINARY_EXEC_SUBCOMMANDS} already closes:
 *
 *   - `sudo vite` yields candidates `[sudo, vite]`, both at tool tier (an
 *     unregistered plugin icon id ranks there), and the leftmost wins the tie —
 *     the plugin reports itself instead of Vite.
 *   - `bash -c "vite build"` is worse: the quoted string never resolves to a
 *     registry key, so `bash` is the only match there is.
 *   - The process-tree walk turns every subshell node into a candidate, so a
 *     plugin owning `bash` tags nearly every pane and outranks the
 *     package-manager tier wherever it appears.
 *
 * Deliberately limited to shells and prefix runners. Tool-shaped launchers a
 * plugin could plausibly want to brand (`mise`, `direnv`, `npx`) stay claimable;
 * `exec`/`dlx`/`x` are handled by the neighbouring refinement.
 */
const RESERVED_PROCESS_TOOL_LAUNCHERS = new Set([
  // Shells. The process-tree walk sees these as the parent of everything a
  // user types, and `-c` hides the real command inside a quoted string.
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ash",
  "ksh",
  "csh",
  "tcsh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
  // Prefix runners: argv[0] is the wrapper, the tool sits somewhere right of it.
  "env",
  "sudo",
  "doas",
  "su",
  "command",
  "nohup",
  "setsid",
  "xargs",
  "time",
  "timeout",
  "nice",
  "stdbuf",
]);

/**
 * `contributes.processTools` manifest entry (#11613). One command name mapped
 * to the icon a terminal tab shows while that command runs. `iconId` is a
 * generic plugin icon id (`shared/config/pluginIconIds.ts`) — advisory, matching
 * `contributes.panels[].iconId`, so an unrecognized id renders a fallback glyph
 * rather than failing the load and a manifest written for a newer host degrades
 * safely. Inert declarative data, so no capability is required. Strict so
 * unknown fields (a `label` or `tier` the host would ignore) are rejected
 * loudly instead of reading as accepted.
 */
export const ProcessToolContributionSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(64)
      .regex(PROCESS_TOOL_COMMAND_PATTERN, {
        message:
          "command must be a bare lowercase executable name (letters, digits, dot, dash, underscore)",
      })
      .refine((command) => !RESERVED_PROCESS_TOOL_COMMANDS.has(command), {
        message: "command cannot be a reserved key (__proto__, constructor, prototype)",
      })
      // The detector strips launcher/script extensions off a process name before
      // looking it up, so `acme.exe` or `serve.py` would register under a key
      // nothing is ever looked up by — a detection that validates and then
      // silently never fires. Reject the non-canonical form and name the one
      // that works, rather than rewriting the author's value behind their back.
      .refine((command) => stripCommandExecutableExtension(command) === command, {
        message:
          'command must omit the executable/script extension (write "acme", not "acme.exe" or "acme.py") — detection strips it before matching',
      })
      // `npm exec vite` puts the launcher subcommand at argv[1] and the real
      // binary at argv[2]. A plugin owning `exec` would match first and win the
      // equal-tier tie by being leftmost, reporting itself for a process it
      // never launched.
      .refine((command) => !BINARY_EXEC_SUBCOMMANDS.has(command), {
        message:
          "command cannot be a package-manager exec subcommand (exec, dlx, x) — those name the launcher, not a tool",
      })
      // Same failure, wider blast radius: a shell or prefix runner sits to the
      // left of the real binary in argv and above it in the process tree, so a
      // plugin owning one wins the equal-tier tie for commands it never
      // launched — every pane, in the `bash` case.
      .refine((command) => !RESERVED_PROCESS_TOOL_LAUNCHERS.has(command), {
        message:
          "command cannot be a shell or launcher wrapper (sh, bash, zsh, cmd, env, sudo, xargs, …) — those name the process that runs a tool, not the tool",
      }),
    iconId: z.string().min(1).max(64),
  })
  .strict();

/**
 * One `contributes.agents` entry (#9560). `id` and `command` use the shared
 * safe-id pattern (no shell metacharacters); a contribution whose `id` collides
 * with a built-in agent is rejected by the manifest-level `superRefine`. Strict
 * so unknown fields are rejected loudly. The `agent:register` capability is
 * required — also enforced at the manifest level so the message can reference
 * the whole contribution set.
 */
const RESERVED_AGENT_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate a `contributes.agents` `command` before it is registered and later
 * spawned by node-pty. Two shapes are allowed: a bare PATH-resolvable binary
 * name (no path separators — the original `SAFE_ID_PATTERN` behavior), or an
 * explicit plugin-relative POSIX path prefixed with `./` that resolves against
 * the plugin's install dir at registration time (`pluginAgentRegistry`). The
 * `./` prefix is required for relative paths so intent is unambiguous — a bare
 * `bin/agent.mjs` would be ambiguous with a PATH name. Rejects absolute paths,
 * Windows separators, NUL, and any `..` traversal segment so the failure is a
 * loud manifest error rather than a spawn-time ENOENT or an escape from the
 * plugin dir. node-pty resolves the command before switching cwd, so the
 * relative form is resolved to an absolute path at registration, not spawn.
 */
function isSafePluginAgentCommand(command: string): boolean {
  // Bare PATH-resolvable binary name (e.g. "claude", "node") — original behavior.
  if (SAFE_ID_PATTERN.test(command)) return true;
  // Otherwise only an explicit plugin-relative POSIX path is allowed.
  if (!command.startsWith("./")) return false;
  if (command.includes("\\")) return false;
  if (command.includes("\0")) return false;
  const normalized = command.slice(2);
  if (normalized === "" || normalized === ".") return false;
  // Reject empty (`//`), current-dir (`.`), and traversal (`..`) segments so the
  // registration-time resolve cannot escape the plugin dir or normalize oddly.
  return normalized
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A single output-detection regex pattern (#10587). Compiled with `new RegExp`
 * by the pty-host activity monitor, so it must be a valid JS regex. Bounded to
 * 256 chars — the patterns run in the pty-host (a stall is observable, not a
 * web-server DoS vector), and the length cap plus the activity monitor's
 * bounded scan window keep catastrophic backtracking a contained risk without
 * pulling in a new linear-time regex dependency.
 */
const PluginDetectionPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (pattern) => {
      try {
        // Call form (not `new`) compiles and validates the pattern without a
        // constructed-but-unused instance — throws on a malformed regex.
        RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Detection pattern must be a valid regular expression" }
  );

/** A bounded array of detection regex patterns. Capped to keep a manifest from declaring an unbounded matcher set. */
const PluginDetectionPatternArraySchema = z.array(PluginDetectionPatternSchema).max(50);

/** Confidence weight in [0, 1] for a matched detection tier. */
const PluginDetectionConfidenceSchema = z.number().min(0).max(1);

/**
 * Optional output-pattern detection for a contributed agent (#10587). Mirrors
 * the host-internal `AgentDetectionConfig` (shared/config/agentRegistry.ts) so
 * a plugin agent can describe its working/waiting/completed states and join the
 * agent-state UI. Strict so a typo'd field is a loud manifest error. All
 * pattern arrays validate each entry as a compilable regex; numeric tuning
 * fields are bounded.
 */
export const AgentDetectionConfigSchema = z
  .object({
    // Required and non-empty, mirroring the host-internal `AgentDetectionConfig`
    // type (where `primaryPatterns` is non-optional): a detection block exists to
    // describe the working state, and an empty `primaryPatterns` makes
    // `buildPatternConfig` return undefined anyway. A "prompt/completion only"
    // agent without a working pattern is out of scope for the declared schema.
    primaryPatterns: PluginDetectionPatternArraySchema.min(1),
    fallbackPatterns: PluginDetectionPatternArraySchema.optional(),
    bootCompletePatterns: PluginDetectionPatternArraySchema.optional(),
    promptPatterns: PluginDetectionPatternArraySchema.optional(),
    promptHintPatterns: PluginDetectionPatternArraySchema.optional(),
    completionPatterns: PluginDetectionPatternArraySchema.optional(),
    scanLineCount: z.number().int().min(1).max(1000).optional(),
    promptScanLineCount: z.number().int().min(1).max(1000).optional(),
    debounceMs: z.number().int().min(0).max(600_000).optional(),
    promptFastPathMinQuietMs: z.number().int().min(0).max(600_000).optional(),
    primaryConfidence: PluginDetectionConfidenceSchema.optional(),
    fallbackConfidence: PluginDetectionConfidenceSchema.optional(),
    promptConfidence: PluginDetectionConfidenceSchema.optional(),
    completionConfidence: PluginDetectionConfidenceSchema.optional(),
    titleStatePatterns: z
      .object({
        working: z.array(z.string().min(1).max(256)).max(50),
        waiting: z.array(z.string().min(1).max(256)).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One CLI argument a manifest hands to the agent: bounded, no line breaks or NUL. */
const PluginAgentArgSchema = z
  .string()
  .max(256)
  .refine((arg) => !/[\r\n\0]/.test(arg), {
    message: "Args cannot contain control characters (\\r, \\n, \\0)",
  });

const PluginAgentArgArraySchema = z.array(PluginAgentArgSchema).max(20);

/** The placeholder a `session-id` resume template expands to the captured id. */
const SESSION_ID_TOKEN = "{sessionId}";

const PluginAgentQuitCommandSchema = PluginAgentArgSchema.min(1).refine(
  (command) => !command.includes(SESSION_ID_TOKEN),
  { message: `A quit command can't carry ${SESSION_ID_TOKEN}` }
);

const PluginAgentStaticArgArraySchema = PluginAgentArgArraySchema.refine(
  (args) => args.every((arg) => !arg.includes(SESSION_ID_TOKEN)),
  { message: `Only a session-id resume's args can carry ${SESSION_ID_TOKEN}` }
);

function holdsSessionIdTokenOnce(args: readonly string[]): boolean {
  return args.join("\0").split(SESSION_ID_TOKEN).length === 2;
}

/**
 * An entry of the flag that assigns a CLI its session id at launch (#16470). A
 * launch writes an option bare on every shell and quotes anything else, and a
 * copied or replayed pane loses the flag by matching those bare words, so only
 * these three forms can always come back off again. A placeholder with no flag
 * to anchor it would match any word of a stored command, the binary included.
 */
const PluginAgentAssignSessionIdArgsSchema = PluginAgentArgArraySchema.min(1)
  .refine(holdsSessionIdTokenOnce, {
    message: `assignSessionIdArgs must contain ${SESSION_ID_TOKEN} exactly once`,
  })
  .refine(
    (args) =>
      args.every(
        (arg) =>
          arg === SESSION_ID_TOKEN ||
          (arg.endsWith(`=${SESSION_ID_TOKEN}`) &&
            isSafeShellOption(arg.slice(0, -SESSION_ID_TOKEN.length))) ||
          isSafeShellOption(arg)
      ),
    {
      message: `Each assignSessionIdArgs entry must be an option, --option=${SESSION_ID_TOKEN}, or ${SESSION_ID_TOKEN} on its own`,
    }
  )
  .refine((args) => args[0] !== SESSION_ID_TOKEN, {
    message: `assignSessionIdArgs needs an option before ${SESSION_ID_TOKEN}`,
  });

/**
 * One token of the flag a CLI takes to skip its permission prompts (#16374).
 * Launches carry it as the agent setting's space-separated bypass string, so a
 * token holding whitespace would come back as two; and it is a fixed flag, so
 * no template a launch would expand.
 */
const PluginAgentBypassArgSchema = PluginAgentArgSchema.min(1)
  .refine((arg) => !/\s/.test(arg), { message: "A permission-bypass arg can't contain whitespace" })
  .refine((arg) => !arg.includes(SESSION_ID_TOKEN) && !arg.includes("${"), {
    message: `A permission-bypass arg can't carry ${SESSION_ID_TOKEN} or a \${settings:…} template`,
  });

/** Count the capture groups in a regex source, or `null` when it doesn't compile. */
function countCaptureGroups(source: string): number | null {
  try {
    // `|` makes the empty string match, and the match array then has one slot
    // per capture group — named, nested and escaped forms all counted by the
    // engine itself rather than by re-parsing the source here.
    return (new RegExp(`${source}|`).exec("")?.length ?? 1) - 1;
  } catch {
    return null;
  }
}

/**
 * Optional session resume for a contributed agent (#13687). Data only: the
 * `{sessionId}` template stays a string all the way into every process that
 * mirrors the plugin agent snapshot, and is expanded where a resume command is
 * built (`getEffectiveRegistry`). Only the two kinds a plugin CLI has needed are
 * exposed; `named-target` waits for a real case.
 */
export const AgentResumeConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session-id"),
      // One occurrence across the whole template, so the id is substituted
      // exactly once whether the token is a whole arg or part of one.
      args: PluginAgentArgArraySchema.min(1).refine(holdsSessionIdTokenOnce, {
        message: `A session-id resume's args must contain ${SESSION_ID_TOKEN} exactly once`,
      }),
      assignSessionIdArgs: PluginAgentAssignSessionIdArgsSchema.optional(),
      // Same bounds as a detection pattern, plus the single capture group the
      // teardown scrape reads the id from.
      sessionIdPattern: PluginDetectionPatternSchema.refine(
        (pattern) => countCaptureGroups(pattern) === 1,
        { message: "sessionIdPattern must have exactly one capture group" }
      )
        .refine((pattern) => !pattern.includes(SESSION_ID_TOKEN), {
          message: `sessionIdPattern can't carry ${SESSION_ID_TOKEN}`,
        })
        .optional(),
      quitCommand: PluginAgentQuitCommandSchema.optional(),
      resumeLatestArgs: PluginAgentStaticArgArraySchema.min(1).optional(),
    })
    .strict()
    // The pattern is read from what the agent prints after the quit command,
    // so a pattern with nothing to provoke it would report an exact-id capture
    // path that teardown can never run — and a bookmark would kill the pane
    // for an id it was never going to get.
    .refine((resume) => !resume.sessionIdPattern || resume.quitCommand !== undefined, {
      message: "sessionIdPattern needs a quitCommand to trigger the agent's resume hint",
      path: ["quitCommand"],
    }),
  z
    .object({
      kind: z.literal("project-scoped"),
      args: PluginAgentStaticArgArraySchema.min(1),
      quitCommand: PluginAgentQuitCommandSchema.optional(),
    })
    .strict(),
]);

/**
 * The Windows roots a declared native path may start from (#16468), lowercase
 * because Windows reads variable names without regard to case. Each is set by
 * the system to a fully qualified location. Any other variable could hold
 * nothing, a drive-relative path (`%HOMEPATH%`) or a network share
 * (`%LOGONSERVER%`), and discovery checks known locations.
 */
const NATIVE_PATH_ENV_ROOTS = new Set([
  "userprofile",
  "appdata",
  "localappdata",
  "programfiles",
  "programfiles(x86)",
  "programdata",
]);

/**
 * One directory or file name in a declared native path. The closed set leaves
 * out separators, so a path can't mix them, and every character a shell, a
 * `%VAR%` or `${settings:…}` expansion or an NTFS stream would read. The last
 * character can't be a dot or a space because Win32 strips those, which would
 * turn `.. ` back into `..`; that also refuses `.`, `..` and an empty name.
 */
const NATIVE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9 ._+@()-]*[A-Za-z0-9_+@()-]$/;

/**
 * Whether a declared native path is rooted at `~/`, `/` or an allowed `%VAR%\`,
 * so nothing is ever probed relative to the working directory. Drive letters
 * and UNC paths aren't among the roots, and `//server` fails on its empty name:
 * a probe of a share would reach for the network, and a hit would launch from it.
 */
function isRootedNativePath(entry: string): boolean {
  const envRoot = /^%([^%\\/]+)%\\/.exec(entry);
  if (envRoot) {
    if (!NATIVE_PATH_ENV_ROOTS.has((envRoot[1] as string).toLowerCase())) return false;
    return hasOnlySafeSegments(entry.slice(envRoot[0].length), "\\");
  }
  if (entry.startsWith("~/")) return hasOnlySafeSegments(entry.slice(2), "/");
  if (entry.startsWith("/")) return hasOnlySafeSegments(entry.slice(1), "/");
  return false;
}

function hasOnlySafeSegments(rest: string, separator: string): boolean {
  return rest.split(separator).every((segment) => NATIVE_PATH_SEGMENT_PATTERN.test(segment));
}

const PluginAgentNativePathSchema = z.string().min(1).max(256).refine(isRootedNativePath, {
  message:
    "A native path must start at ~/, / or %USERPROFILE%\\, %APPDATA%\\, %LOCALAPPDATA%\\, %ProgramFiles%\\, %ProgramFiles(x86)%\\ or %ProgramData%\\, use one kind of separator, and name only letters, digits, spaces and . _ + @ ( ) -, with no . or .. segment and no name ending in a dot or a space",
});

/**
 * `contributes.agents[].packages` (#16468): the two ecosystems discovery can
 * find an install from, and nothing else. The npm name only switches the
 * npm-global probe on, and is checked so an author's tag, version or URL fails
 * loudly instead of reading as accepted. The PyPI name goes into the uv and
 * pipx paths, so it can't hold a separator, and it must be the normalized form
 * those tools name their directories by: `Foo_Bar` would validate and then
 * quietly never be found. Strict so other install metadata stays out, and
 * neither name ever reaches an install command.
 */
export const AgentPackagesContributionSchema = z
  .object({
    npm: z
      .string()
      .max(214)
      .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, {
        message: "packages.npm must be a bare npm package name, optionally scoped",
      })
      .optional(),
    pypi: z
      .string()
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message:
          "packages.pypi must be the normalized PyPI name: lowercase letters and digits joined by single hyphens",
      })
      .optional(),
  })
  .strict()
  .refine((packages) => packages.npm !== undefined || packages.pypi !== undefined, {
    message: "packages must name an npm or a pypi package",
  });

/** The element of a prompt form's args a launch replaces with the prompt. */
const PROMPT_TOKEN = "{prompt}";

/**
 * One fixed word of a prompt form. `TerminalSpawnOptionsSchema` refuses a
 * command holding any control character, so one here is caught at the manifest
 * rather than on every launch; the form describes argv's shape, so `{prompt}`
 * is the only thing in it a launch fills in.
 */
const PluginAgentPromptFormArgSchema = z
  .string()
  .min(1)
  .max(256)
  // eslint-disable-next-line no-control-regex
  .refine((arg) => !/[\x00-\x1F\x7F-\x9F]/.test(arg), {
    message: "A prompt form's args can't contain control characters",
  })
  .refine((arg) => !arg.includes(SESSION_ID_TOKEN) && !arg.includes("${"), {
    message: `A prompt form's args can't carry ${SESSION_ID_TOKEN} or a \${settings:…} template`,
  });

/** A subcommand word: a launch swaps it in as is, so it can't be an option or a template. */
const PluginAgentSubcommandWordSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
    message:
      "A prompt form's subcommand must be one word of letters, digits, '.', '_' or '-', starting with a letter or digit",
  });

/**
 * One launch mode's first-prompt form (#16404), the data a built-in agent
 * declares in its config. Only a whole `{prompt}` element is replaced, so one
 * embedded in a longer arg would reach the CLI as literal text.
 */
const AgentPromptFormSchema = z
  .object({
    args: z
      .array(PluginAgentPromptFormArgSchema)
      .min(1)
      .max(20)
      .refine(
        (args) =>
          args.filter((arg) => arg === PROMPT_TOKEN).length === 1 &&
          args.every((arg) => arg === PROMPT_TOKEN || !arg.includes(PROMPT_TOKEN)),
        {
          message: `A prompt form's args must contain ${PROMPT_TOKEN} exactly once, as a whole arg`,
        }
      ),
    subcommand: z
      .object({
        name: PluginAgentSubcommandWordSchema,
        replaces: PluginAgentSubcommandWordSchema,
      })
      .strict()
      .optional(),
    caveat: z.enum(["may-be-ignored", "exits-after-reply"]).optional(),
  })
  .strict();

export const AgentContributionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => !RESERVED_AGENT_IDS.has(id), {
        message: "Agent id cannot be a reserved key (__proto__, constructor, prototype)",
      }),
    name: z.string().min(1).max(100),
    command: z.string().min(1).max(256).refine(isSafePluginAgentCommand, {
      message:
        "command must be a bare PATH binary name or a plugin-relative path starting with ./ (no absolute path, backslash, NUL, or .. segments)",
    }),
    args: PluginAgentArgArraySchema.optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    iconId: z.string().min(1).max(64),
    supportsContextInjection: z.boolean().default(false),
    nativePaths: z.array(PluginAgentNativePathSchema).min(1).max(16).optional(),
    packages: AgentPackagesContributionSchema.optional(),
    detection: AgentDetectionConfigSchema.optional(),
    resume: AgentResumeConfigSchema.optional(),
    // Both modes, as a built-in agent declares them: a launch reads its own.
    initialPromptForm: z
      .object({ interactive: AgentPromptFormSchema, headless: AgentPromptFormSchema })
      .strict()
      .optional(),
    launchMcp: z
      .object({ format: z.enum(LAUNCH_MCP_FORMATS) })
      .strict()
      .optional(),
    // Options only, each with at most one value after it: a bare token can't be
    // told from another option's value, so it would be stripped out of one.
    permissionBypassArgs: z
      .array(PluginAgentBypassArgSchema)
      .min(1)
      .max(20)
      .refine(
        (args) =>
          args.every(
            (arg, index) => arg.startsWith("-") || args[index - 1]?.startsWith("-") === true
          ),
        { message: "permissionBypassArgs must be options, each followed by at most one value" }
      )
      .optional(),
  })
  .strict();
