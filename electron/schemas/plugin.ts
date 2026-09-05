import path from "node:path";
import * as semver from "semver";
import { z } from "zod";
import {
  SAFE_ID_PATTERN,
  SCOPED_PLUGIN_NAME_PATTERN,
  isPrivateOrLoopbackHostname,
} from "./pluginIdentifiers.js";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  PLUGIN_CATEGORY_IDS,
  PLUGIN_PANEL_BADGE_LABEL_MAX,
} from "../../shared/types/plugin.js";
import { isBuiltInAgentId } from "../../shared/config/agentIds.js";
import { MAX_TERMINALS_PER_RECIPE } from "../../shared/utils/recipeSanitizer.js";
import { PROCESS_TOOL_ICON_BY_COMMAND } from "../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES } from "../services/ProcessDetector/registries.js";
import {
  BINARY_EXEC_SUBCOMMANDS,
  stripCommandExecutableExtension,
} from "../services/ProcessDetector/commandParser.js";
import {
  BUILT_IN_ACTION_IDS,
  DENY_PLUGIN_DISPATCH_ACTION_IDS,
} from "../../shared/config/actionIds.js";
import { KEY_ACTION_VALUES } from "../../shared/types/keymap.js";
import type {
  PluginManifest,
  PluginOrigin,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  SkillContribution,
  PluginCapability,
} from "../../shared/types/plugin.js";
import type {
  FileDecorationContribution,
  ForgeProviderContribution,
} from "../../shared/types/forge.js";

// Identifier patterns + hostname classification live in the dependency-light
// `./pluginIdentifiers.ts` so boot-path modules can use them without pulling
// this file's zod schema construction into the eager graph. Re-exported here
// because the install/validate consumers of the schemas below use them too.
export { SAFE_ID_PATTERN, SCOPED_PLUGIN_NAME_PATTERN, isPrivateOrLoopbackHostname };

// The full set of built-in action ids a plugin contribution may reference:
// `BuiltInActionId = BuiltInKeyAction | BuiltInRuntimeActionId`
// (shared/types/actions.ts). `BUILT_IN_ACTION_IDS` covers only the runtime
// half — keybinding-driven ids (nav.*, tab.*, app.settings, layout.undo, …)
// live in `KEY_ACTION_VALUES` and are equally valid dispatch targets, so both
// must seed the allowlist or a legitimate keybinding contribution is rejected.
const BUILT_IN_ACTION_ID_SET: ReadonlySet<string> = new Set([
  ...BUILT_IN_ACTION_IDS,
  ...KEY_ACTION_VALUES,
]);

// Built-in actions a plugin contribution may never dispatch (terminal input
// injection, fleet command relays). The host refuses these at runtime, so a
// contribution wired to one is a dead button — reject it at parse time (#10580).
const DENY_PLUGIN_DISPATCH_SET: ReadonlySet<string> = new Set(DENY_PLUGIN_DISPATCH_ACTION_IDS);

/**
 * The unrefined object base — exported so the field-consumer contract test
 * (`manifestContributionConsumers.test.ts`) can enumerate `.shape` without
 * reaching through the `.superRefine` wrapper, mirroring
 * {@link SettingDefinitionObjectSchema}. Runtime validation goes through
 * {@link PanelContributionSchema} below.
 */
export const PanelContributionObjectSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    iconId: z.string().min(1),
    color: z.string().min(1),
    hasPty: z.boolean().default(false),
    canRestart: z.boolean().default(false),
    canConvert: z.boolean().default(false),
    showInPalette: z.boolean().default(true),
    // Dockable by default (undefined). Declare `false` to opt a panel kind out
    // of the dock — no default so absence flows through as `undefined` and
    // `panelKindIsDockable` treats it as dockable.
    dockable: z.boolean().optional(),
  })
  .strict();

/**
 * The validated `contributes.panels` entry: the object base plus a cross-field
 * rule. `hasPty: true` with an explicit `dockable: false` is rejected — a
 * PTY-backed plugin kind renders through `TerminalPane` and its kind collapses
 * to the built-in dockable `terminal` at creation (`addPanel.ts`), so the
 * opt-out could never be honored and would silently vanish. Plugin PTY kinds
 * are unsupported in v1 anyway; surface the conflict to the author at
 * manifest-write time instead of swallowing it at runtime (#11375). `hasPty`
 * has already defaulted to `false` here, so an omitted `hasPty` never trips it.
 */
export const PanelContributionSchema = PanelContributionObjectSchema.superRefine((panel, ctx) => {
  if (panel.hasPty === true && panel.dockable === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dockable"],
      message:
        "A PTY-backed panel (hasPty: true) cannot opt out of the dock with dockable: false — plugin PTY panels render as terminals, which are always dockable. Remove the dockable flag.",
      params: { errorCode: "pty_panel_dock_opt_out_unsupported" },
    });
  }
});

export const ToolbarButtonContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    label: z.string().min(1),
    iconId: z.string().min(1),
    actionId: z.string().min(1),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
  })
  .strict();

export const MenuItemContributionSchema = z
  .object({
    label: z.string().min(1),
    actionId: z.string().min(1),
    location: z.enum(["terminal", "file", "view", "help"]),
    accelerator: z.string().optional(),
    when: z.string().min(1).optional(),
  })
  .strict();

export const KeybindingContributionSchema = z
  .object({
    actionId: z.string().min(1),
    combo: z.string().min(1),
    // Closed to the renderer's KeyScope union (src/services/keybindingUtils.ts).
    // An unknown scope would never match the active scope and silently produce an
    // inert binding, so reject it at the manifest gate instead. Defaults to
    // "global" in the renderer hook when omitted. The former "terminal",
    // "modal", and "worktreeList" scopes were removed — they were never
    // activated, so bindings declared under them could not fire.
    scope: z
      .enum(["global", "portal", "worktreeGrid", "dev-preview"], {
        error: (issue) => {
          switch (issue.input) {
            case "terminal":
              return 'keybinding scope "terminal" was removed — use scope "global" with when: "terminalFocused"';
            case "modal":
              return 'keybinding scope "modal" was removed — use scope "global" with when: "modalOpen"';
            case "worktreeList":
              return 'keybinding scope "worktreeList" was removed — worktree-list navigation keys are fixed and not bindable';
            default:
              return undefined;
          }
        },
      })
      .optional(),
    description: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
  })
  .strict();

export const ContextMenuContributionSchema = z
  .object({
    actionId: z.string().min(1),
    // `"panel"` removed (#10512) — no renderer surface consumed it, so a
    // contributed panel context-menu item was dead. Reject it at the manifest
    // gate so authors get a clear error instead of a silently-ignored item.
    location: z.enum(["worktree", "terminal", "file"]),
    label: z.string().min(1),
    when: z.string().min(1).optional(),
  })
  .strict();

/**
 * Declared here rather than beside the other manifest-level schemas because
 * {@link CommandContributionSchema} below references it for `requires`, and a
 * `const` referenced above its declaration is a TDZ error at module init.
 */
export const PluginCapabilitySchema = z.enum(BUILT_IN_PLUGIN_CAPABILITIES);

/**
 * `contributes.commands` manifest entry. The bare command `id` is namespaced
 * by `PluginService` at load time as `{pluginId}.{id}` so the descriptor key
 * matches the {@link PluginActionDescriptor.id} format used by the imperative
 * `host.registerAction` path. `danger: "restricted"` is rejected — plugins
 * may only contribute `"safe"` or `"confirm"` commands. Strict so an
 * unrecognised field surfaces as a manifest error instead of silently dropping
 * (e.g. a typo on `keywords` would otherwise vanish on a permissive schema).
 */
export const CommandContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    kind: z.enum(["command", "query"]),
    danger: z.enum(["safe", "confirm"]),
    keywords: z.array(z.string().min(1)).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    // Per-action capability intent (#11299). Deliberately NOT `.min(1)`: an
    // empty array is the meaningful "this command exercises no capability"
    // declaration that keeps it one-click in an otherwise high-authority
    // plugin. Omitting the field keeps whole-manifest danger derivation.
    // PluginService re-checks the subset against manifest.capabilities.
    requires: z.array(PluginCapabilitySchema).optional(),
  })
  .strict();

/**
 * Validate a plugin-relative asset path (a view's `componentPath` #9229, or a
 * skill's markdown `path` #10892) at the manifest gate. Realpath containment at
 * read/request time is the security boundary (the `plugin://` protocol handler
 * for views; `resolveContainedPath` for skills); this check rejects an absolute
 * path, a Windows separator, an embedded URL scheme/query/fragment, a NUL, or a
 * `..` segment at parse time so the failure is a loud manifest-validation error,
 * not a silent 404 / read failure later. Accepts relative POSIX paths only — a
 * leading `./` is preserved.
 */
function isSafePluginAssetPath(componentPath: string): boolean {
  if (componentPath.startsWith("/")) return false;
  if (componentPath.includes("\\")) return false;
  if (componentPath.includes("\0")) return false;
  // Reject embedded URL structure markers — `https://...` (`:`), `?query`, or
  // `#fragment` — to catch typos early and avoid polluting the V8 module cache
  // with duplicate query-string variants.
  if (componentPath.includes(":")) return false;
  if (componentPath.includes("?")) return false;
  if (componentPath.includes("#")) return false;
  // A bare current-dir / root path (`.`, `./`) resolves to no module file — a
  // 404 from the protocol handler — so reject it at the manifest gate.
  const normalized = componentPath.startsWith("./") ? componentPath.slice(2) : componentPath;
  if (normalized === "" || normalized === ".") return false;
  return !componentPath.split("/").includes("..");
}

/**
 * View contribution. A view renders into a `contributes.panels` entry with a
 * matching `id`; at plugin load (`PluginService.loadPlugin`) the panels loop
 * attaches the view's `componentPath` to that panel kind. A view whose `id`
 * matches no panel is rejected by the manifest-level `superRefine` (#10620) —
 * it would otherwise silently never render. Only `location: "panel"` is supported — it
 * sets `showInPalette: true` so the view is spawnable from the panel palette.
 * `"sidebar"` is rejected at the schema boundary: the sidebar host does not
 * exist yet, so accepting it would validate a manifest the runtime cannot
 * honor. Contributed via the stable `contributes.views` key (the pre-1.0
 * `experimental_views` name is still accepted as a deprecated alias). See
 * `docs/plugins/architecture.md`.
 */
export const ViewContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    componentPath: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "componentPath must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    location: z.literal("panel"),
    // `iconId` is advisory only — the SDK `validate` command flags an
    // unrenderable id, but at runtime the matching `contributes.panels` entry
    // owns the rendered icon (the panels loop reads `panel.iconId`, never the
    // view's). No `name`/`description` here: the matching panel is the single
    // source of truth for a view's display metadata, so those fields had no
    // runtime consumer and were removed (#10888) rather than validate a value
    // the runtime silently ignores.
    iconId: z.string().min(1).optional(),
  })
  .strict();

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
 * `contributes.skills` manifest entry (#10892). A skill is a plugin-shipped
 * markdown file surfaced to agents via the built-in MCP server's
 * `skills.search` / `skills.load` tools. `path` reuses the shared asset-path
 * grammar guard ({@link isSafePluginAssetPath}) — the file is realpath-contained
 * to the plugin dir at read time (`resolveContainedPath` in the skill registry),
 * so this parse-time check only rejects the obviously-malformed shapes. Skills
 * are inert declarative content and carry no capability requirement. Strict so
 * unknown fields from plugin authors are rejected loudly.
 */
export const SkillContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    path: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "path must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    triggers: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

/**
 * One terminal inside a `contributes.recipes` entry (#11860). Only the
 * authorable fields — the transient per-launch overrides (`agentModelId`,
 * `agentLaunchFlags`, `location`) are session state that the recipe editor
 * already strips on persist, so a manifest declaring them is rejected loudly
 * rather than having them silently dropped.
 *
 * This validates SHAPE only. Content (control characters, an unknown `type`,
 * a non-string env value) is the sanitizer's job — `sanitizeRecipeTerminals`
 * runs over every contributed terminal at registration, which is also where a
 * `type` naming the same plugin's contributed agent is admitted.
 */
export const RecipeContributionTerminalSchema = z
  .object({
    type: z.string().min(1).max(64),
    title: z.string().max(200).optional(),
    command: z.string().max(4096).optional(),
    env: z.record(z.string(), z.string()).optional(),
    initialPrompt: z.string().max(8192).optional(),
    args: z.string().max(4096).optional(),
    devCommand: z.string().max(4096).optional(),
    exitBehavior: z.enum(["keep", "trash", "remove"]).optional(),
  })
  .strict();

/**
 * `contributes.recipes` manifest entry (#11860). A recipe is a named
 * multi-terminal launch layout registered under `{pluginId}.{id}` and merged
 * into the recipe list as a plugin-owned tier available in every project.
 *
 * Terminals are inline rather than a path to a shipped JSON file: the
 * install-time confirmation reads the manifest WITHOUT extracting the archive,
 * so an out-of-line file could never be disclosed before the user approves.
 *
 * Like {@link SkillContributionSchema}, recipes carry no capability
 * requirement. `showInEmptyState` / `autoAssign` are defaults the user's
 * sidecar overrides. Strict so unknown fields fail loudly.
 */
export const RecipeContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1).max(200),
    terminals: z.array(RecipeContributionTerminalSchema).min(1).max(MAX_TERMINALS_PER_RECIPE),
    showInEmptyState: z.boolean().optional(),
    autoAssign: z.enum(["always", "never", "prompt"]).optional(),
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
 * One credential input rendered into the provider's settings form. `type` is a
 * free string (`"password"` masks the input; anything else renders plain
 * text). A provider may declare several fields, but only the primary value
 * reaches `validateToken` — see `ForgeProviderContribution.credentialFields`
 * in `shared/types/forge.ts` for the single-primary contract.
 */
const RESERVED_CREDENTIAL_FIELD_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const CredentialFieldSchema = z
  .object({
    // A field id keys the entered value into a plain record at save time; a
    // reserved key (`__proto__` etc.) would resolve to the object prototype
    // rather than a stored string and crash the primary-value pick. Reject up
    // front, mirroring AgentContributionSchema.
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => !RESERVED_CREDENTIAL_FIELD_IDS.has(id), {
        message: "Credential field id cannot be a reserved key (__proto__, constructor, prototype)",
      }),
    label: z.string().min(1),
    type: z.string().min(1),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
  })
  .strict();

/**
 * `forgeProviders` manifest entry — wired: the registry populates Preferences
 * and remote-routing before any plugin code runs. See
 * `docs/architecture/forge-provider-abstraction.md`. `settingsScopeRef` and
 * `viewRefs` are cross-validated against `contributes.settings`/`contributes.views`
 * by the manifest-level `superRefine` (#10620) — a dangling ref is a parse
 * error. Two fields are validated for SHAPE only and carry no runtime authority
 * (frozen at 1.0):
 *   - `capabilities` is informational; the host gates behavior on the runtime
 *     `ForgeProviderImpl` field presence, never on these strings.
 *   - `slots` values are opaque renderer view-ids checked for non-emptiness
 *     only; the main process can't verify them against the renderer registry,
 *     and an unresolved ref renders a neutral fallback (not a parse error).
 */
export const ForgeProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    matches: z.array(z.string().min(1)).min(1),
    kind: z.enum(["local", "network"]).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    credentialFields: z.array(CredentialFieldSchema).optional(),
    settingsScopeRef: z.string().min(1).optional(),
    viewRefs: z.array(z.string().min(1)).optional(),
    slots: z
      .object({
        settingsTab: z.string().min(1).optional(),
        icon: z.string().min(1).optional(),
        statsDropdown: z.string().min(1).optional(),
        bulkCreateWorktreeDialog: z.string().min(1).optional(),
        issueSelector: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * `fileDecorationProviders` manifest entry. Declares which scopes a plugin's
 * decoration provider handles so the host can route renderer pulls without
 * the plugin's code having run yet. Strict so unknown fields from plugin
 * authors are rejected loudly rather than silently ignored.
 */
export const FileDecorationContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    scopes: z.array(z.string().min(1)).min(1),
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
    args: z
      .array(
        z
          .string()
          .max(256)
          .refine((arg) => !/[\r\n\0]/.test(arg), {
            message: "Args cannot contain control characters (\\r, \\n, \\0)",
          })
      )
      .max(20)
      .optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    iconId: z.string().min(1).max(64),
    supportsContextInjection: z.boolean().default(false),
    detection: AgentDetectionConfigSchema.optional(),
  })
  .strict();

/**
 * Shared per-entry validator body for manifest URL fields. Each entry must:
 *
 * - Parse as a `https:` URL (no `http:`, `file:`, custom schemes).
 * - Contain no `*` substring (wildcards are rejected so a tightly-bound
 *   declaration cannot smuggle a permissive value past the manifest gate).
 * - Carry no embedded credentials (no `https://user:pass@host`).
 * - Target a multi-label hostname (at least one `.` after parse). Single-label
 *   intranet hosts are rejected to keep URLs auditable from the manifest.
 * - Not target a private/loopback/link-local address (SSRF mitigation).
 *
 * `fieldLabel` names the offending field in error messages so the same
 * discipline can back both `scopes.network.allowedUrls` and `authors[].url`
 * without leaking a misleading field name into the other's validation errors.
 */
function refinePluginHttpsUrl(value: string, ctx: z.RefinementCtx, fieldLabel: string): void {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in ${fieldLabel}: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entry is not a valid URL: "${value}"`,
      params: { errorCode: "scope_url_invalid" },
    });
    return;
  }
  if (parsed.protocol !== "https:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must use https:// — got "${parsed.protocol}" in "${value}"`,
      params: { errorCode: "scope_url_not_https" },
    });
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must not embed credentials: "${value}"`,
      params: { errorCode: "scope_url_has_credentials" },
    });
    return;
  }
  const hostname = parsed.hostname;
  if (isPrivateOrLoopbackHostname(hostname)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entry targets a private or loopback address: "${value}"`,
      params: { errorCode: "scope_url_private_target" },
    });
    return;
  }
  if (hostname === "" || !hostname.includes(".")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} hostnames must be multi-label (got "${hostname}" in "${value}")`,
      params: { errorCode: "scope_url_hostname_unqualified" },
    });
    return;
  }
}

/**
 * Per-entry validator for `scopes.network.allowedUrls`. See
 * {@link refinePluginHttpsUrl} for the enforced discipline.
 */
const PluginAllowedUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "scopes.network.allowedUrls");
});

/**
 * Per-entry validator for `authors[].url`. Author homepage links surface as
 * user-clickable buttons in the plugin detail pane, so they carry the same
 * https-only, no-credentials, no-private-host discipline as network scopes
 * (anti-phishing / SSRF) — only the error-message field name differs.
 */
const PluginAuthorUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "authors[].url");
});

/**
 * A single attribution entry in the plugin manifest's `authors` array. `name`
 * is required; `url`, `email`, and `role` are optional. `strictObject` rejects
 * unknown keys so manifest typos surface loudly.
 */
export const PluginAuthorSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: PluginAuthorUrlSchema.optional(),
  email: z.email().optional(),
  role: z.string().trim().min(1).max(50).optional(),
});

/**
 * Matches a dynamic scope token (`${project}` / `${worktree}`) at the start of
 * an `allowedPaths` entry, with an optional `/sub/path` suffix. These expand at
 * call time against the live active project / worktree root (PluginService),
 * letting a plugin scope to "the active worktree" without a hardcoded path.
 */
const ALLOWED_PATH_TOKEN_RE = /^\$\{(?:project|worktree)\}(?:\/.*)?$/;

/**
 * Per-entry validator for `scopes.fs.allowedPaths`. Each entry must be either a
 * literal absolute path or a dynamic scope token (`${project}` / `${worktree}`,
 * optionally with a `/sub/path` suffix), with no `..` segment and no `*` glob —
 * the schema boundary is the load-bearing gate (#4593, #4702), so substring
 * `..` checks are insufficient (segment-by-segment rejection).
 */
const PluginAllowedPathSchema = z.string().superRefine((value, ctx) => {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in scopes.fs.allowedPaths: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  const isToken = ALLOWED_PATH_TOKEN_RE.test(value);
  if (!isToken && !path.isAbsolute(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must be absolute paths or a "\${project}"/"\${worktree}" token: "${value}"`,
      params: { errorCode: "scope_path_relative" },
    });
    return;
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((seg) => seg === "..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must not contain ".." segments: "${value}"`,
      params: { errorCode: "scope_path_traversal" },
    });
    return;
  }
});

export const PluginNetworkScopeSchema = z
  .object({
    allowedUrls: z.array(PluginAllowedUrlSchema).min(1),
  })
  .strict();

/**
 * `scopes.fs.allowedPaths` is enforced at runtime: the host-mediated
 * `host.fs` / `host.git` surface realpath-contains every path argument to these
 * roots (PluginService), rejecting traversal and symlink escapes. Entries may be
 * literal absolute paths or `${project}` / `${worktree}` tokens that expand at
 * call time against the live active project / worktree. Independently, every
 * plugin is always granted an implicit per-plugin data root
 * (`~/.daintree/plugin-data/{pluginId}/`) so `allowedPaths` is optional.
 */
export const PluginFsScopeSchema = z
  .object({
    allowedPaths: z.array(PluginAllowedPathSchema).min(1),
  })
  .strict();

/**
 * A declared local socket endpoint: a Unix-domain socket path or a Windows
 * named pipe (`\\.\pipe\name`).
 *
 * Deliberately does NOT reuse {@link PluginAllowedPathSchema}: that validator
 * leans on `path.isAbsolute`, which is platform-dependent, so a manifest
 * declaring `\\.\pipe\docker_engine` would fail to parse on macOS and a
 * manifest declaring `/var/run/docker.sock` would fail on Windows. A manifest
 * must validate identically everywhere it's read — including when a Linux CI
 * box parses a plugin authored for Windows — so both forms are accepted on
 * every platform and the shape is checked explicitly.
 *
 * This is disclosure metadata, not an enforcement boundary (nothing intercepts
 * `node:net`), so the checks target author mistakes and misleading UI rather
 * than containment: no globs (a wildcard would render as a specific endpoint
 * while meaning any), no traversal segments, no NUL, no relative paths.
 */
const LOCAL_SOCKET_PATH_MAX = 512;
export const PluginAllowedSocketPathSchema = z
  .string()
  .min(1)
  .max(LOCAL_SOCKET_PATH_MAX)
  .superRefine((value, ctx) => {
    const addIssue = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (value.trim() !== value) {
      addIssue("Socket path must not have leading or trailing whitespace");
      return;
    }
    if (value.includes("\0")) {
      addIssue("Socket path must not contain a NUL character");
      return;
    }
    if (value.includes("*")) {
      addIssue("Socket path must not contain a wildcard — declare each endpoint literally");
      return;
    }
    const isWindowsPipe = /^\\\\[.?]\\pipe\\/i.test(value);
    if (isWindowsPipe) {
      if (value.length <= "\\\\.\\pipe\\".length) {
        addIssue("Windows named pipe must include a pipe name");
        return;
      }
    } else if (!value.startsWith("/")) {
      addIssue(
        "Socket path must be an absolute Unix-domain path (/var/run/docker.sock) or a Windows named pipe (\\\\.\\pipe\\name)"
      );
      return;
    }
    // Traversal is rejected for both forms. Splitting on either separator
    // matters because the check has to hold for a Windows pipe name parsed on
    // a POSIX host, where `path` would never treat `\` as a separator.
    if (value.split(/[/\\]/).includes("..")) {
      addIssue("Socket path must not contain a '..' segment");
    }
  });

/**
 * `scopes.socket.allowedPaths` — optional path intent for `socket:connect`
 * (#11299). Unlike `scopes.fs`, nothing enforces this: a plugin's `main` calls
 * `node:net` directly with no host interception point. It exists so the
 * Permissions tab can render "connects to /var/run/docker.sock" instead of the
 * bare capability, which is the whole value of the disclosure.
 */
export const PluginLocalSocketScopeSchema = z
  .object({
    allowedPaths: z.array(PluginAllowedSocketPathSchema).min(1),
  })
  .strict();

/**
 * Top-level `scopes` field on `PluginManifest`. Strict so a misspelled scope
 * bucket (e.g. `networking` instead of `network`) surfaces as a manifest error
 * rather than silently failing to attenuate the compound-capability lattice.
 */
export const PluginManifestScopesSchema = z
  .object({
    network: PluginNetworkScopeSchema.optional(),
    fs: PluginFsScopeSchema.optional(),
    socket: PluginLocalSocketScopeSchema.optional(),
  })
  .strict();

/**
 * Validates the options passed to `host.showToast`. Both the main-process path
 * (plugin `activate` code) and any future renderer path (SDK React hooks over
 * IPC) converge on this schema. `priority` and `action` are intentionally
 * absent — plugins cannot set them, so the banned `priority:"low"` +
 * `type:"error"` combo is structurally impossible. Strict so unknown fields
 * from plugin authors are rejected loudly rather than silently dropped.
 */
export const PluginToastOptionsSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    type: z.enum(["info", "success", "warning", "error"]).default("info"),
    durationMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

const PluginPanelBadgeColorSchema = z.enum(["default", "success", "warning", "error"]);
const PluginPanelBadgeTooltipSchema = z.string().trim().min(1).max(200).optional();

/**
 * Validates a `host.setPanelBadge` badge at the host boundary. Discriminated on
 * `kind`; the `label` text is rejected (not truncated) past
 * {@link PLUGIN_PANEL_BADGE_LABEL_MAX} characters so it can't overflow the
 * panel header — consistent with the reject-on-overflow convention of the other
 * length-capped strings in this file. `null` (clear) is handled at the call
 * site, not here.
 */
export const PluginPanelBadgeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("dot"),
      color: PluginPanelBadgeColorSchema.optional(),
      tooltip: PluginPanelBadgeTooltipSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("label"),
      text: z.string().trim().min(1).max(PLUGIN_PANEL_BADGE_LABEL_MAX),
      color: PluginPanelBadgeColorSchema.optional(),
      tooltip: PluginPanelBadgeTooltipSchema,
    })
    .strict(),
]);

/**
 * One `contributes.settings` field declaration (#9301). `type` is optional
 * (renders as a text field when omitted); the legacy `secret: true` flag is
 * normalized to `type: "secret"` by the transform so downstream consumers only
 * switch on `type`. A plain object (not `discriminatedUnion`) is used because
 * `type` is optional on the string/number/boolean branch. Strict so a misspelled
 * field key surfaces as a manifest error rather than silently dropping.
 */
export const SettingDefinitionObjectSchema = z
  .object({
    // Constrained to the shared safe-id grammar so a declared setting id can
    // always be referenced by a `${settings:id}` token — the MCP supervisor's
    // substitution gate (`SETTINGS_TEMPLATE_RE` in PluginMcpSupervisor.ts) only
    // matches `[a-zA-Z0-9._-]+`, so an id outside that grammar could be declared
    // but never resolved at runtime.
    id: z.string().min(1).regex(SAFE_ID_PATTERN),
    type: z
      .enum(["string", "number", "boolean", "enum", "json", "secret", "path", "directory", "file"])
      .optional(),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    default: z.unknown().optional(),
    scope: z.enum(["user", "project", "local"]).default("user"),
    options: z.array(z.string().min(1)).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    // Advisory existence check for path/directory/file fields — the form flags a
    // stored path that no longer resolves; it does not gate saving.
    mustExist: z.boolean().optional(),
    // File-extension filter for type: "file" (no leading dot). Non-empty when present.
    extensions: z.array(z.string().min(1)).min(1).optional(),
    secret: z.boolean().optional(),
  })
  .strict();

/**
 * The validated `contributes.settings` entry: the object base plus the
 * cross-field refinement and the `secret → type: "secret"` normalization.
 * The unrefined {@link SettingDefinitionObjectSchema} is exported separately so
 * the field-consumer contract test can enumerate `.shape` without reaching
 * through the transform wrapper.
 */
export const SettingDefinitionSchema = SettingDefinitionObjectSchema.superRefine((val, ctx) => {
  const effectiveType = val.secret === true ? "secret" : (val.type ?? "string");
  if (effectiveType === "enum" && (!val.options || val.options.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Settings of type "enum" require a non-empty options array',
      path: ["options"],
    });
  }
  if (val.min !== undefined && val.max !== undefined && val.min > val.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Setting min cannot be greater than max",
      path: ["min"],
    });
  }
  // `extensions` narrows the native file chooser — it is only meaningful for
  // `type: "file"`. Reject it on every other type at the manifest gate so a
  // misplaced filter surfaces loudly instead of silently doing nothing.
  if (val.extensions !== undefined && effectiveType !== "file") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Setting "extensions" is only valid for type "file"',
      path: ["extensions"],
    });
  }
}).transform((val) => {
  if (val.secret === true && val.type !== "secret") {
    return { ...val, type: "secret" as const };
  }
  return val;
});

/**
 * A surface slot that renders a plugin view: `viewId` names an entry in this
 * manifest's own `contributes.views`, cross-checked in `superRefine` exactly
 * like `forgeProviders.viewRefs` (#10620) — a dangling id would mount nothing
 * and leave the slot blank with no diagnostic.
 */
export const SurfaceViewSlotSchema = z
  .object({
    viewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  })
  .strict();

/**
 * `contributes.surfaces` (§7.8) — the project surfaces a project-local plugin
 * may own, so a project can present as a purpose-built application rather than
 * as a host with one extra panel.
 *
 * Additive and slot-replacing only. Nothing here removes host chrome: the
 * project switcher, the worktree dashboard and the stock launcher stay
 * reachable in every case, which is the boundary that keeps a broken plugin
 * from stranding the user with no way back. Available to `scope: "project"`
 * plugins alone — an installed plugin claiming a project's surfaces is exactly
 * what locality is supposed to rule out — and at most one plugin may claim each
 * slot per project, enforced at load, where both claimants are known.
 *
 * `emptyCanvas` is the only slot accepted today. The spec also describes
 * `projectHome` (a persistent home surface in the project's primary
 * navigation) and `defaultLayout` (the arrangement opened on a cold first open
 * with no restorable session). Neither is declared here, because neither has a
 * consumer: this renderer has no per-project routing a persistent home surface
 * could live at — the sidebar lists worktrees, not views — and a recipe is
 * launched against a worktree, not against a project cold open. Accepting
 * either now would put a field in a frozen public contract that nothing reads,
 * which is the drift `manifestContributionConsumers.test.ts` exists to stop.
 * They land with the routing they need, not before it.
 */
export const SurfaceContributionsSchema = z
  .object({
    emptyCanvas: SurfaceViewSlotSchema.optional(),
  })
  .strict();

/**
 * Per-array upper bounds for `contributes.*`. A crafted manifest with tens of
 * thousands of entries would otherwise exhaust the registration loops in
 * `PluginService.loadPlugin`. These caps are generous relative to any plausible
 * real plugin — they exist to reject pathological/adversarial manifests, not to
 * constrain legitimate authors. Exported so tests reference the values without
 * magic numbers. Keyed by the stable (canonical) contribution names — the
 * deprecated `experimental_*` aliases are normalized to these before the cap
 * check runs (see `normalizeDeprecatedContributionAliases`).
 */
export const MANIFEST_CONTRIBUTION_CAPS = {
  panels: 50,
  toolbarButtons: 100,
  menuItems: 200,
  keybindings: 200,
  contextMenus: 200,
  commands: 200,
  views: 50,
  mcpServers: 20,
  skills: 50,
  forgeProviders: 20,
  fileDecorationProviders: 50,
  agents: 50,
  processTools: 100,
  settings: 200,
  recipes: 50,
} as const;

/**
 * Upper bound on the top-level `authors` array. Attribution is metadata, not a
 * registration loop, so the cap is small — generous for any real plugin's
 * credits list while rejecting pathological manifests. Exported so tests
 * reference it without a magic number.
 */
export const MANIFEST_AUTHORS_CAP = 10;

/**
 * Deprecated `contributes` keys promoted to stable names in the 1.0 freeze.
 * Old manifests are still accepted (the value is migrated to the canonical key);
 * `PluginService` surfaces a deprecation warning when an alias is encountered.
 */
export const DEPRECATED_CONTRIBUTION_ALIASES = {
  experimental_views: "views",
  experimental_mcpServers: "mcpServers",
} as const;

/**
 * Normalizes deprecated `contributes` aliases to their canonical names before
 * strict validation, so the frozen schema never carries an `experimental_*`
 * field while old manifests keep parsing. The canonical key wins when both are
 * present; the deprecated key is always stripped so `strictObject` accepts it.
 */
function normalizeDeprecatedContributionAliases(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const [deprecated, canonical] of Object.entries(DEPRECATED_CONTRIBUTION_ALIASES)) {
    if (!(deprecated in obj)) {
      continue;
    }
    next ??= { ...obj };
    // Canonical wins when present — an explicit `views: []` is canonical and is
    // NOT overwritten by a deprecated value. Only fall back to the deprecated
    // value when the canonical key is missing (`undefined`/`null`), so a manifest
    // mixing `views: null` with `experimental_views: [...]` recovers gracefully
    // instead of failing on the null.
    if (next[canonical] == null) {
      next[canonical] = next[deprecated];
    }
    delete next[deprecated];
  }
  return next ?? obj;
}

/**
 * `contributes.*` groups a `scope: "project"` plugin may not declare, each with
 * the structural reason it cannot yet be narrowed to one project.
 *
 * The dividing line is {@link
 * ../services/plugin/PluginContributionBroadcaster.js}: the groups it filters by
 * owning plugin id (panels, commands/actions, toolbarButtons, keybindings,
 * contextMenus) reach only the owning project's views, and `settings` resolves
 * through the bound instance handle. Everything here registers into a registry
 * with no project axis — a single app menu, one agent roster mirrored into the
 * shared pty-host, one skill index behind the MCP server — so the contribution
 * is published app-wide no matter which project loaded it.
 *
 * Exported so tests enumerate the set instead of restating it, and so a group
 * that later grows a project axis is removed in exactly one place.
 */
export const PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS = [
  [
    "menuItems",
    "the application menu is one OS-level menu shared by every window, with no per-project projection — the item would stay on the menu bar while a different project is focused and dispatch into it.",
  ],
  [
    "agents",
    "the plugin agent roster is a single app-wide registry mirrored into the shared pty-host, and an agent's launch identity is persisted into terminals and sessions that outlive the project binding — the agent would be launchable from every project.",
  ],
  [
    "skills",
    "contributed skills land in one app-wide index behind the built-in MCP server's skills.search/skills.load, which external agent sessions query with no project context to filter on.",
  ],
  [
    "recipes",
    "the plugin recipe registry is broadcast to every renderer unfiltered, so the recipe would appear in every project's launcher and empty state.",
  ],
  [
    "fileDecorationProviders",
    "decoration requests carry a resource path with no owning-project routing, so the provider would be consulted for files in every project the app has open.",
  ],
  [
    "processTools",
    "process-tool detections are mirrored into the shared pty-host as one detection table for every terminal in the app, so the icon mapping would apply to every project's processes.",
  ],
  [
    "mcpServers",
    "contributed MCP servers are reachable through the app-global plugin-MCP surface, where an external agent session carries no project binding to check the contribution against.",
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

/** The schema {@link getPluginManifestSchema} hands back, for the overloads. */
type PluginManifestSchema = ReturnType<typeof buildPluginManifestSchema>;

/**
 * Builds the manifest schema for a given discovery root.
 *
 * `origin` is what the three-way rules key off: the reserved `daintree.*`
 * namespace (builtin only), and the `scope: "project"` gate in both directions
 * (required under `"project"`, rejected under the other two).
 */
export function getPluginManifestSchema(origin: PluginOrigin): PluginManifestSchema;
/**
 * @deprecated Pass a {@link PluginOrigin}. Transitional bridge for call sites
 * still on the old two-valued flag — `true` maps to `"builtin"`, `false` to
 * `"user"`, which is exactly what the boolean meant. It cannot express
 * `"project"`, so every caller that needs to must move to the string form; the
 * overload goes away once the last boolean caller does.
 */
export function getPluginManifestSchema(isBuiltin: boolean): PluginManifestSchema;
export function getPluginManifestSchema(origin: PluginOrigin | boolean): PluginManifestSchema {
  return buildPluginManifestSchema(
    typeof origin === "boolean" ? (origin ? "builtin" : "user") : origin
  );
}

/**
 * Edit distance, capped: anything past `max` is "not a near miss" and the walk
 * can stop. Only ever run against the handful of manifest field names, so the
 * quadratic table is a few dozen cells.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The manifest field `key` was probably meant to be, or undefined when nothing
 * is close enough to be worth guessing at. A singular/plural slip counts
 * whatever its edit distance — `author` for `authors` is the one this was
 * written for (#12212) — and otherwise a short field name gets one edit of
 * latitude and a longer one gets two.
 */
export function suggestManifestKey(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  // Every candidate is scored before one is chosen. Returning on the first
  // acceptable match let a plural shortcut win over an exact one that came
  // later in the shape — `"Scopes"` matched `scope` and never reached `scopes`.
  let best: string | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const candidateLower = candidate.toLowerCase();
    // Rank, not distance: an exact match beats a plural slip beats an edit.
    const rank =
      candidateLower === lower
        ? 0
        : candidateLower === `${lower}s` || `${candidateLower}s` === lower
          ? 1
          : (() => {
              const budget = Math.min(candidate.length, key.length) >= 5 ? 2 : 1;
              const distance = editDistance(lower, candidateLower, budget);
              return distance <= budget ? 1 + distance : Number.POSITIVE_INFINITY;
            })();
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best;
}

/**
 * Turn a rejected manifest into the one line a plugin author can act on.
 *
 * An unrecognized key wins over whatever Zod reported first, because a key the
 * schema has never heard of is almost always a typo, and a typo is the single
 * most fixable thing in the list — `"author"` for `authors` cost a real
 * debugging session with no signal anywhere but a red row in the plugin
 * manager (#12212). Everything else keeps the existing `path: message` shape.
 *
 * Pure formatting over data the parse already produced: it reads nothing from
 * disk and executes nothing, so it is safe on the pre-trust discovery path.
 */
export function describeManifestIssues(
  issues: readonly z.core.$ZodIssue[],
  schema: PluginManifestSchema
): string {
  // Only a ROOT unrecognized key can be scored against the manifest's own
  // shape. A stray key nested under `contributes` is a different vocabulary
  // entirely, and matching it against the root would suggest a field that is
  // invalid exactly where the author put it — `version` inside `contributes`
  // "did you mean version?" being the absurd case.
  // An explicit type predicate: narrowing on `code` alone would be inferred,
  // but adding the path test to the same expression loses it.
  const unrecognized = issues.find(
    (issue): issue is Extract<z.core.$ZodIssue, { code: "unrecognized_keys" }> =>
      issue.code === "unrecognized_keys" && issue.path.length === 0
  );
  if (unrecognized) {
    const suggestions = unrecognized.keys
      .map((key) => {
        const suggestion = suggestManifestKey(key, Object.keys(schema.shape));
        return suggestion ? `did you mean "${suggestion}" instead of "${key}"?` : null;
      })
      .filter((hint): hint is string => hint !== null);
    // A key nothing resembles is not more actionable than whatever Zod
    // reported first, so it does not get to displace it.
    if (suggestions.length > 0) {
      return `${unrecognized.message} — ${suggestions.join(" ")}`;
    }
  }

  const first = issues[0];
  const where = first?.path.length ? `${first.path.join(".")}: ` : "";
  return `${where}${first?.message ?? "manifest failed validation"}`;
}

function buildPluginManifestSchema(origin: PluginOrigin) {
  return z
    .strictObject({
      // Editors and agents key completion and inline validation off `$schema`,
      // and the object is strict, so without an explicit slot a manifest that
      // names its own contract is refused for naming it. Accepted, never read:
      // the host's authority is this schema, not whatever the URL resolves to.
      $schema: z.string().optional(),
      name: z.string().min(1).max(64).regex(SCOPED_PLUGIN_NAME_PATTERN, {
        error: 'Plugin name must be in publisher.name format (e.g. "acme.linear-context")',
      }),
      version: z
        .string()
        .trim()
        .min(1)
        .refine((val) => semver.valid(val) !== null, {
          message: "version must be a valid semver (e.g. 1.2.3)",
        }),
      displayName: z.string().optional(),
      description: z.string().optional(),
      tagline: z.string().trim().min(1).max(120).optional(),
      authors: z.array(PluginAuthorSchema).max(MANIFEST_AUTHORS_CAP).optional(),
      category: z.enum(PLUGIN_CATEGORY_IDS).optional(),
      main: z.string().optional(),
      engines: z
        .object({
          daintree: z
            .string()
            .trim()
            .min(1)
            .refine((val) => semver.validRange(val) !== null, {
              message: "engines.daintree must be a valid semver range",
            })
            .optional(),
        })
        .optional(),
      // Declares the plugin is only ever loaded project-locally. Shape only
      // here — whether it is required, optional-but-rejected, or absent is a
      // function of the discovering `origin`, enforced in `superRefine`.
      scope: z.literal("project").optional(),
      capabilities: z.array(PluginCapabilitySchema).default([]),
      scopes: PluginManifestScopesSchema.optional(),
      activationEvents: z.array(z.literal("onStartupFinished")).default([]),
      contributes: z.preprocess(
        normalizeDeprecatedContributionAliases,
        z
          .strictObject({
            panels: z
              .array(PanelContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.panels)
              .default([]),
            toolbarButtons: z
              .array(ToolbarButtonContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.toolbarButtons)
              .default([]),
            menuItems: z
              .array(MenuItemContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.menuItems)
              .default([]),
            keybindings: z
              .array(KeybindingContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.keybindings)
              .default([]),
            contextMenus: z
              .array(ContextMenuContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.contextMenus)
              .default([]),
            commands: z
              .array(CommandContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.commands)
              .default([]),
            views: z
              .array(ViewContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.views)
              .default([]),
            mcpServers: z
              .array(McpServerContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.mcpServers)
              .default([]),
            skills: z
              .array(SkillContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.skills)
              .default([]),
            forgeProviders: z
              .array(ForgeProviderContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.forgeProviders)
              .default([]),
            fileDecorationProviders: z
              .array(FileDecorationContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.fileDecorationProviders)
              .default([]),
            agents: z
              .array(AgentContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.agents)
              .default([]),
            processTools: z
              .array(ProcessToolContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.processTools)
              .default([]),
            settings: z
              .array(SettingDefinitionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.settings)
              .default([]),
            recipes: z
              .array(RecipeContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.recipes)
              .default([]),
            // Not an array, so it carries no MANIFEST_CONTRIBUTION_CAPS entry —
            // three optional fixed slots are structurally bounded already.
            surfaces: SurfaceContributionsSchema.default({}),
          })
          .default({
            panels: [],
            toolbarButtons: [],
            menuItems: [],
            keybindings: [],
            contextMenus: [],
            commands: [],
            views: [],
            mcpServers: [],
            skills: [],
            forgeProviders: [],
            fileDecorationProviders: [],
            agents: [],
            processTools: [],
            settings: [],
            recipes: [],
            surfaces: {},
          })
      ),
    })
    .superRefine((manifest, ctx) => {
      // `scope: "project"` and the discovering root must agree, in BOTH
      // directions. A project plugin copied into the user directory would
      // otherwise load app-globally with project-shaped assumptions (its fs
      // containment root, its per-project settings tier), and a user plugin
      // dropped into `.daintree/plugins/` would load with none of the
      // project-local guarantees its author never opted into. Neither failure
      // is visible at runtime, so both are rejected at the gate.
      if (origin === "project" && manifest.scope !== "project") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message:
            'A plugin discovered under a project\'s .daintree/plugins/ must declare "scope": "project" — the host will not load a project-local plugin that has not opted in.',
          params: { errorCode: "project_scope_required" },
        });
      } else if (origin !== "project" && manifest.scope === "project") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message: `"scope": "project" declares a plugin that is only ever loaded from a project's .daintree/plugins/, but this manifest was discovered under the ${origin} plugins root.`,
          params: { errorCode: "project_scope_not_allowed" },
        });
      }

      // A project-local plugin runs out-of-process in the plugin worker, and
      // `host.registerForgeProvider` is unavailable there: forge providers
      // require synchronous host methods (`parseRemote`, the URL builders) that
      // cannot cross the worker's async message port — see the same refusal in
      // `pluginDevWorkerHostProxy.registerForgeProvider`. The contribution
      // would register a descriptor that can never be given an implementation,
      // so the provider would sit in Preferences permanently unbacked. Reject
      // the declaration rather than ship a forge provider that cannot work.
      //
      // Deliberately scoped to `scope: "project"` and not to every non-builtin
      // origin, even though `PluginService.activatePlugin` routes user plugins
      // through the same worker and so leaves their forge providers equally
      // unbacked. That is a pre-existing gap with shipped manifests behind it;
      // widening the rule would reject plugins that install today, which is its
      // own decision with its own migration. Project scope is new surface, so
      // it starts closed.
      if (manifest.scope === "project" && manifest.contributes.forgeProviders.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "forgeProviders"],
          message:
            'contributes.forgeProviders is not available to a "scope": "project" plugin — forge providers need synchronous host methods (parseRemote, URL builders) that cannot cross the plugin worker\'s async message port, so host.registerForgeProvider would refuse the implementation and the provider could never resolve.',
          params: { errorCode: "forge_provider_project_scope_forbidden" },
        });
      }

      // The contribution groups that are still STRUCTURALLY GLOBAL. Contribution
      // scoping (`PluginContributionBroadcaster`) narrows panels, actions,
      // toolbar buttons, keybindings and context menus to the owning project's
      // views; every group below is registered into an app-wide registry that
      // has no project axis at all, so a project plugin declaring one publishes
      // it to every project in the app — the exact locality violation project
      // scope exists to prevent. That was harmless while nothing could be
      // project-scoped; it is a live leak now, so the declaration is rejected at
      // the gate rather than accepted and silently over-published.
      //
      // Each of these is deferred, not forbidden forever: the reason names the
      // structural obstacle so a later phase knows what it has to build first.
      // Installed and builtin plugins are unaffected — they ARE app-wide, which
      // is what the absent `scope` means.
      if (manifest.scope === "project") {
        for (const [group, reason] of PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS) {
          if (manifest.contributes[group].length === 0) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", group],
            message: `contributes.${group} is not available to a "scope": "project" plugin — ${reason}`,
            params: { errorCode: `${group}_project_scope_forbidden` },
          });
        }
      }

      // The inverse asymmetry: `contributes.surfaces` is available to project
      // plugins ALONE. An installed plugin taking over a project's empty canvas,
      // its home nav entry or its cold-open layout would be reshaping a project
      // it was never bound to, from a decision the user made globally — and
      // there would be no project whose slot registry could arbitrate the
      // claim. Locality is the whole point of the slot, so a manifest without
      // `scope: "project"` may not declare one.
      if (manifest.scope !== "project" && manifest.contributes.surfaces !== undefined) {
        const claimed = Object.entries(manifest.contributes.surfaces).filter(
          ([, value]) => value !== undefined
        );
        if (claimed.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces"],
            message:
              'contributes.surfaces is available only to a "scope": "project" plugin — a surface claim replaces one project\'s own chrome, and an installed plugin is bound to no project, so there is nothing to scope the claim to or to arbitrate a second claimant against.',
            params: { errorCode: "surfaces_project_scope_only" },
          });
        }
      }

      if (origin !== "builtin" && manifest.name.startsWith("daintree.")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["name"],
          message: `Plugin name "${manifest.name}" uses the reserved "daintree.*" namespace, which is restricted to first-party plugins.`,
          params: { errorCode: "namespace_reserved" },
        });
      }

      // `contributes.agents` registers a launchable agent CLI — gate it behind
      // the explicit `agent:register` capability so the contribution is
      // surfaced to the user at install time (#9560).
      const agents = manifest.contributes.agents;
      if (agents.length > 0 && !manifest.capabilities.includes("agent:register")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "agents"],
          message:
            'contributes.agents requires the "agent:register" capability to be declared in capabilities.',
          params: { errorCode: "agent_register_capability_required" },
        });
      }

      // Plugin agent IDs are additive for new IDs only — they may never shadow
      // or patch a built-in agent.
      agents.forEach((agent, index) => {
        if (isBuiltInAgentId(agent.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "agents", index, "id"],
            message: `Plugin agent id "${agent.id}" collides with a built-in agent — plugin agents must use new IDs.`,
            params: { errorCode: "agent_id_reserved" },
          });
        }
      });

      // Plugin process-tool commands are additive for new commands only (#11613).
      // A command already claimed by a built-in tool or by a built-in agent's CLI
      // would never win at runtime — the detector merges built-ins over the plugin
      // snapshot — so accepting it would register a detection that silently never
      // fires. Reject at parse time, mirroring the agent-id reservation above.
      // Cross-plugin collisions are deliberately NOT checked here: they resolve
      // first-registered-wins at runtime, and a manifest cannot know what else is
      // installed.
      const processTools = manifest.contributes.processTools;
      const seenProcessToolCommands = new Set<string>();
      processTools.forEach((tool, index) => {
        if (Object.hasOwn(PROCESS_TOOL_ICON_BY_COMMAND, tool.command)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "processTools", index, "command"],
            message: `Process-tool command "${tool.command}" collides with a built-in tool — plugin process tools must use new commands.`,
            params: { errorCode: "process_tool_command_reserved" },
          });
        } else if (Object.hasOwn(AGENT_CLI_NAMES, tool.command)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "processTools", index, "command"],
            message: `Process-tool command "${tool.command}" collides with a built-in agent CLI — plugin process tools must use new commands.`,
            params: { errorCode: "process_tool_command_reserved" },
          });
        }
        // A manifest declaring the same command twice is a typo, not a
        // precedence question — the registry's per-plugin map is last-wins, so
        // one of the two icons would silently disappear. Reject rather than
        // pick.
        if (seenProcessToolCommands.has(tool.command)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "processTools", index, "command"],
            message: `Duplicate process-tool command "${tool.command}" in this manifest.`,
            params: { errorCode: "process_tool_command_duplicate" },
          });
        }
        seenProcessToolCommands.add(tool.command);
      });

      // Every contributed `actionId` (toolbar buttons, menu items, keybindings,
      // context menus) must resolve to a real, dispatchable action at runtime,
      // else the contribution paints an inert button/binding that silently does
      // nothing when invoked (#10565, #10580). The resolution rules, in order:
      //
      //  1. A built-in flagged `denyPluginDispatch: true` is rejected outright —
      //     the host refuses plugin dispatch for it, so the button is dead even
      //     though the id exists (#10580). This precedes the allowlist check
      //     because these ids ARE in `BUILT_IN_ACTION_ID_SET`.
      //  2. Any other built-in action id resolves.
      //  3. An id in the plugin's own namespace is cross-checked against the
      //     declared `contributes.commands` (namespaced `{name}.{id}` at load).
      //     If commands are declared, an own-namespace id that matches none of
      //     them is a typo for a command that will never exist, so it is rejected
      //     (#10580). If NO commands are declared, the plugin registers actions
      //     imperatively via `host.registerAction` (invisible at parse time), so
      //     any own-namespace id is allowed — the imperative escape hatch.
      //  4. A reference into a foreign namespace can never resolve and is rejected.
      const ownNamespacePrefix = `${manifest.name}.`;
      const declaredCommandActionIds = new Set(
        manifest.contributes.commands.map((cmd) => `${manifest.name}.${cmd.id}`)
      );
      const actionIdContributions = [
        ["toolbarButtons", manifest.contributes.toolbarButtons],
        ["menuItems", manifest.contributes.menuItems],
        ["keybindings", manifest.contributes.keybindings],
        ["contextMenus", manifest.contributes.contextMenus],
      ] as const;
      for (const [arrayName, entries] of actionIdContributions) {
        entries.forEach((entry, index) => {
          const { actionId } = entry;
          const issuePath = ["contributes", arrayName, index, "actionId"] as const;

          if (DENY_PLUGIN_DISPATCH_SET.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...issuePath],
              message: `Contributed actionId "${actionId}" is a built-in action closed to plugin dispatch — the host refuses it at runtime, so the contribution can never fire.`,
              params: { errorCode: "action_id_plugin_dispatch_denied" },
            });
            return;
          }

          if (BUILT_IN_ACTION_ID_SET.has(actionId)) {
            return;
          }

          if (actionId.startsWith(ownNamespacePrefix)) {
            // Cross-check own-namespace ids against declared commands only when
            // commands exist; an empty set means the plugin is fully imperative.
            if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...issuePath],
                message: `Contributed actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
                params: { errorCode: "action_id_undeclared_command" },
              });
            }
            return;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...issuePath],
            message: `Contributed actionId "${actionId}" does not reference a built-in action or an action in this plugin's "${manifest.name}" namespace — it can never resolve.`,
            params: { errorCode: "action_id_unknown_namespace" },
          });
        });
      }

      // Duplicate contribution ids — within each contribution array, the bare
      // `id` is the lookup key the runtime keys its registries on (panel kind,
      // command descriptor, MCP server, agent, view, setting, forge provider,
      // file-decoration provider). A duplicate silently first-wins at load, so
      // the second contribution vanishes with no diagnostic. Reject it at the
      // manifest gate instead. The check is per-array (ids in different arrays
      // are namespaced independently and never collide).
      const reportDuplicateIds = (arrayName: string, entries: ReadonlyArray<{ id: string }>) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          if (seen.has(entry.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", arrayName, index, "id"],
              message: `Duplicate id "${entry.id}" in contributes.${arrayName} — each contribution id must be unique within its array.`,
              params: { errorCode: "duplicate_contribution_id" },
            });
          } else {
            seen.add(entry.id);
          }
        });
      };
      reportDuplicateIds("panels", manifest.contributes.panels);
      reportDuplicateIds("toolbarButtons", manifest.contributes.toolbarButtons);
      reportDuplicateIds("commands", manifest.contributes.commands);
      reportDuplicateIds("views", manifest.contributes.views);
      reportDuplicateIds("mcpServers", manifest.contributes.mcpServers);
      reportDuplicateIds("skills", manifest.contributes.skills);
      reportDuplicateIds("forgeProviders", manifest.contributes.forgeProviders);
      reportDuplicateIds("fileDecorationProviders", manifest.contributes.fileDecorationProviders);
      reportDuplicateIds("agents", manifest.contributes.agents);
      reportDuplicateIds("settings", manifest.contributes.settings);
      reportDuplicateIds("recipes", manifest.contributes.recipes);

      // Cross-reference integrity — a contribution that names another by id must
      // point at one that exists in the same manifest, else the reference dangles
      // and the wiring silently no-ops at runtime.
      const settingIds = new Set(manifest.contributes.settings.map((setting) => setting.id));
      const viewIds = new Set(manifest.contributes.views.map((view) => view.id));
      const panelIds = new Set(manifest.contributes.panels.map((panel) => panel.id));

      // `forgeProvider.settingsScopeRef` → a declared setting; `viewRefs[]` →
      // declared views. Both were validated for shape only before (#10620).
      manifest.contributes.forgeProviders.forEach((provider, index) => {
        if (provider.settingsScopeRef !== undefined && !settingIds.has(provider.settingsScopeRef)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "forgeProviders", index, "settingsScopeRef"],
            message: `forgeProvider settingsScopeRef "${provider.settingsScopeRef}" matches no contributes.settings[].id.`,
            params: { errorCode: "forge_settings_scope_ref_unknown" },
          });
        }
        provider.viewRefs?.forEach((ref, refIndex) => {
          if (!viewIds.has(ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "forgeProviders", index, "viewRefs", refIndex],
              message: `forgeProvider viewRef "${ref}" matches no contributes.views[].id.`,
              params: { errorCode: "forge_view_ref_unknown" },
            });
          }
        });
      });

      // `surfaces.*.viewId` → a declared view, the same dangling-reference
      // treatment `forgeProviders.viewRefs` gets above: an id matching no
      // contributed view mounts nothing, so the slot the plugin claimed renders
      // blank with no diagnostic.
      const ptyPanelIds = new Set(
        manifest.contributes.panels.filter((p) => p.hasPty === true).map((p) => p.id)
      );
      for (const slot of ["emptyCanvas"] as const) {
        const claim = manifest.contributes.surfaces[slot];
        if (claim === undefined) continue;
        if (!viewIds.has(claim.viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces", slot, "viewId"],
            message: `surfaces.${slot}.viewId "${claim.viewId}" matches no contributes.views[].id.`,
            params: { errorCode: "surface_view_ref_unknown" },
          });
          continue;
        }
        // A PTY panel is rendered by TerminalPane, so its matching view is
        // ignored at load and no component path is ever attached. The claim
        // would then hold the project's slot against every other plugin while
        // rendering nothing — worse than not claiming it at all.
        if (ptyPanelIds.has(claim.viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces", slot, "viewId"],
            message: `surfaces.${slot}.viewId "${claim.viewId}" names a panel with hasPty: true — PTY panels are rendered by the terminal host and never load the view module, so the surface would hold the slot and draw nothing.`,
            params: { errorCode: "surface_view_ref_pty" },
          });
        }
      }

      // A view renders into a `contributes.panels` entry with a matching id; a
      // view whose id matches no panel can never be shown (#10620). This is a
      // hard error now — it previously silently no-op'd at load.
      manifest.contributes.views.forEach((view, index) => {
        if (!panelIds.has(view.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "views", index, "id"],
            message: `View "${view.id}" has no matching contributes.panels[].id — a view renders into a panel of the same id, so it would never be shown.`,
            params: { errorCode: "view_panel_ref_unknown" },
          });
        }
      });

      // Every `${settings:<id>}` token in an MCP server's command/args/env must
      // name a declared setting — the supervisor substitutes only declared ids
      // (`SETTINGS_TEMPLATE_RE` in PluginMcpSupervisor.ts) and an unknown id
      // resolves to the empty string, silently dropping the value. Agent
      // command/args also resolve `${settings:*}` at spawn (via
      // `resolveSettingTemplate` in terminal/lifecycle.ts), but are deliberately
      // NOT validated here — that path tolerates an unset id at launch, so this
      // parse-time check stays scoped to MCP contributions. The
      // scan matches any `${settings:...}` shape (broad inner pattern), then
      // classifies: a key outside the `${SAFE_ID_PATTERN}` grammar is malformed
      // (the supervisor's stricter regex would skip it, passing the literal
      // token to exec); a well-formed key naming no setting is unknown.
      const settingsTokenRe = /\$\{settings:([^}]*)\}/g;
      const reportUnknownSettingsTokens = (text: string, path: (string | number)[]) => {
        for (const match of text.matchAll(settingsTokenRe)) {
          const key = match[1]!;
          if (!SAFE_ID_PATTERN.test(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `Malformed settings token "${match[0]}" — the setting id must match ${SAFE_ID_PATTERN.source}.`,
              params: { errorCode: "settings_token_malformed" },
            });
            continue;
          }
          if (!settingIds.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `Reference to undeclared setting "\${settings:${key}}" — no contributes.settings[].id matches "${key}".`,
              params: { errorCode: "settings_token_unknown" },
            });
          }
        }
      };
      manifest.contributes.mcpServers.forEach((server, index) => {
        reportUnknownSettingsTokens(server.command, [
          "contributes",
          "mcpServers",
          index,
          "command",
        ]);
        server.args?.forEach((arg, argIndex) =>
          reportUnknownSettingsTokens(arg, ["contributes", "mcpServers", index, "args", argIndex])
        );
        for (const [envKey, envValue] of Object.entries(server.env ?? {})) {
          reportUnknownSettingsTokens(envValue, [
            "contributes",
            "mcpServers",
            index,
            "env",
            envKey,
          ]);
        }
      });
    });
}

export type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  SkillContribution,
  PluginCapability,
};
export type { ForgeProviderContribution, FileDecorationContribution };
