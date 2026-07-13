import type { SlashCommandScope } from "./slashCommands.js";

/**
 * Declarative, serializable description of where an agent's input-bar
 * completions come from. Each `AgentConfig` supplies a list of
 * {@link CompletionSourceConfig}; a Main-process engine
 * (`electron/services/completions/`) resolves the path templates, scans the
 * directories with a named parser, derives labels/ids, and merges/dedupes —
 * instead of the service branching on `agentId`.
 *
 * This file lives in `shared/` and MUST stay pure data: literal unions,
 * strings, numbers, arrays, and plain objects only. No `fs`/`path`, no
 * regexes, no functions. Anything that touches the filesystem or interprets a
 * parser name is implemented in `electron/` and referenced here by string.
 */

/** The prefix character that opens a completion menu. */
export type CompletionTrigger = "/" | "$" | "@";

/**
 * Semantic category of a completion. `command`, `skill`, and `plugin` are
 * produced today — `plugin` covers Codex Plugins surfaced from the local plugin
 * registry (see the `registry` discovery + `codex-plugin-registry` parser).
 * `app` is modelled ahead of its discovery backend: Codex Apps/connectors are
 * resolved server-side (chatgpt.com/backend-api/wham/apps) with no local
 * manifest to discover, so the item model, badges, and ranking can carry the
 * kind the moment a source populates it — see #11049 / #11043.
 */
export type CompletionKind = "command" | "skill" | "app" | "plugin";

/**
 * Closed allow-list of directory parsers implemented in `electron/`. The
 * engine owns traversal/scope/precedence/derivation/dedupe; a parser only
 * turns a directory into raw `{ nameParts, relativeSourcePath, description }`
 * entries. Each name also fixes the traversal shape:
 *  - `markdown-frontmatter`: recursive `.md`, name from the colon-joined
 *    relative path stem, description from YAML frontmatter (bounded read).
 *  - `toml`: recursive `.toml`, name from the relative path stem, description
 *    from the TOML `description` key (bounded read).
 *  - `skill-dir`: immediate child directories containing `SKILL.md`, name from
 *    the child directory name, description from the `SKILL.md` frontmatter.
 *  - `codex-plugin-registry`: a `registry` parser (not a plain directory scan)
 *    handed `$CODEX_HOME`. It intersects the enabled `[plugins."name@market"]`
 *    tables in `config.toml` with the manifests under `plugins/cache/*`, picks
 *    each plugin's active version, and reads `.codex-plugin/plugin.json`
 *    (fallback `.claude-plugin/plugin.json`) for the name/description.
 */
export type CompletionParserName =
  | "markdown-frontmatter"
  | "toml"
  | "skill-dir"
  | "codex-plugin-registry";

/** Platforms a location applies to. Matches `process.platform` values. */
export type CompletionPlatform = "darwin" | "win32" | "linux";

/**
 * Environment variables a location may read for its base directory. Closed set
 * so the schema stays inspectable and Main never reads an arbitrary env name.
 */
export type CompletionEnvName =
  | "CLAUDE_CONFIG_DIR"
  | "GEMINI_CONFIG_DIR"
  | "CODEX_HOME"
  | "XDG_CONFIG_HOME"
  | "ProgramData";

/** A base directory with no environment indirection. */
export type CompletionConcreteBase =
  | { type: "projectRoot" }
  | { type: "absolute"; path: string }
  | { type: "homeRelative"; segments: readonly string[] };

/**
 * The base directory a location's `segments` are appended to. An `env` base
 * uses the environment value when set (resolved to absolute), otherwise its
 * concrete `fallback` — this expresses `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/XDG
 * overrides with their home-relative fallbacks declaratively.
 */
export type CompletionBaseDir =
  | CompletionConcreteBase
  | { type: "env"; name: CompletionEnvName; fallback: CompletionConcreteBase };

/**
 * A single directory to scan for one source. `scope` drives merge precedence
 * (`built-in` < `global` < `user` < `project`, later wins). `locationPrecedence`
 * breaks ties within the same scope+source (higher wins). `platforms`, when
 * present, gates the location to those platforms.
 */
export interface CompletionLocation {
  id: string;
  scope: SlashCommandScope;
  base: CompletionBaseDir;
  segments: readonly string[];
  platforms?: readonly CompletionPlatform[];
  locationPrecedence: number;
}

/**
 * How a directory entry's name/label/id/kind are derived. `labelPrefix` is the
 * displayed token prefix (`/`, `$`, or a legacy `/prompts:`); it is kept
 * distinct from `trigger` so a legacy prompt source can share the `/` trigger
 * while prefixing labels. `idNamespace`, when set, is inserted between scope and
 * name (`scope:skill:name`).
 */
export interface CompletionDerivation {
  labelPrefix: string;
  kind: CompletionKind;
  fallbackDescription: string;
  idNamespace?: string;
  /** Joins multi-part names (nested dirs). Defaults to `":"`. */
  nestingJoiner?: string;
}

/** Built-ins fold in via the existing `getBuiltinSlashCommands` catalog. */
export interface CompletionStaticDiscovery {
  method: "static";
  catalog: "builtin-slash-commands";
}

export interface CompletionDirectoryDiscovery {
  method: "directory";
  parser: CompletionParserName;
  derive: CompletionDerivation;
  locations: readonly CompletionLocation[];
}

/**
 * A registry-backed source: structurally identical to `directory`, but the
 * `method` distinguishes a parser that does more than turn one directory into
 * entries (it cross-references sibling manifests/config and resolves versions —
 * e.g. `codex-plugin-registry` reads `config.toml` + walks `plugins/cache/*`).
 * The engine treats it exactly like `directory` (same parser/locations/derive
 * fields), so no engine branch is needed — the distinct `method` only keeps the
 * schema honest about what the parser does.
 */
export interface CompletionRegistryDiscovery {
  method: "registry";
  parser: CompletionParserName;
  derive: CompletionDerivation;
  locations: readonly CompletionLocation[];
}

export type CompletionDiscovery =
  | CompletionStaticDiscovery
  | CompletionDirectoryDiscovery
  | CompletionRegistryDiscovery;

/**
 * One completion source an agent declares. `sourcePrecedence` orders
 * contributions from different sources at the same scope (higher wins) — e.g.
 * skills beat same-scope commands.
 */
export interface CompletionSourceConfig {
  id: string;
  trigger: CompletionTrigger;
  sourcePrecedence: number;
  discovery: CompletionDiscovery;
}
