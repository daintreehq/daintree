import bundledTailwindPackage from "tailwindcss/package.json" with { type: "json" };
import { majorVersion } from "../project/versions.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { SUPPORTED_BASELINE } from "../model.js";

/**
 * The only place in the plugin that touches Tailwind's internals.
 *
 * Tailwind v4 has no public API for "what does this class mean in this
 * project". The compiler exposes `__unstable__loadDesignSystem`, which is the
 * same entry point the official IntelliSense extension uses — but the name says
 * what it is, and nothing about it is covered by semver. Every use of it is
 * therefore funnelled through the narrow facade below: a future Tailwind that
 * renames or reshapes it is a change to this file and nothing else.
 *
 * It is also deliberately loaded from the *project's* `node_modules`, not from
 * this repo's. Modelling the user's utilities with our copy of Tailwind would
 * silently answer questions about the wrong theme.
 */

type ProjectRequire = ReturnType<typeof createRequire>;

export interface Declaration {
  property: string;
  value: string;
}

/**
 * Where a declaration lands: the at-rule conditions wrapping it and the
 * selector shape with the candidate's own class removed. Two candidates only
 * compete when both are identical — `hover:p-4` and `p-4` are not rivals, and
 * neither are `space-x-4` (which targets children) and `mx-4`.
 */
export interface DeclarationScope {
  /** Sorted, so `md:max-lg:` and `max-lg:md:` — the same interval — agree. */
  conditions: string[];
  /** `""` for a bare utility, `:hover` for a hover variant, and so on. */
  selector: string;
}

export interface CompiledDeclaration extends Declaration {
  scope: DeclarationScope;
}

export interface CompiledCandidate {
  declarations: CompiledDeclaration[];
  /**
   * Custom properties this candidate registers with `@property`, mapped to the
   * `initial-value` it registered them with. Tailwind emits these for the
   * `--tw-*` slots a composing utility family shares, so they are the honest
   * marker of machinery — a name test cannot be, since a project prefixed with
   * `tw` emits its theme variables under `--tw-` too. The initial value matters
   * as well: `space-x-4` writing `--tw-space-x-reverse: 0` is initialising the
   * register, not authoring a value `space-x-reverse` would fight with.
   */
  registers: Record<string, string>;
}

export interface ThemeEntry {
  /** Name without the namespace prefix, e.g. `md` for `--breakpoint-md`. */
  name: string;
  value: string;
}

/** What the rest of the plugin is allowed to know about Tailwind. */
export interface TailwindDesignSystem {
  readonly version: string;
  /** Project-wide utility prefix (`tw` for `tw:p-4`), or null when unset. */
  readonly prefix: string | null;
  /** Generated CSS, or null when the candidate produces no rule in this project. */
  cssFor(candidate: string): string | null;
  /** What the candidate contributes, or null when it is not a valid candidate. */
  compile(candidate: string): CompiledCandidate | null;
  /** Every utility name this project can generate. */
  classNames(): string[];
  /** Theme variables in one namespace, e.g. `--breakpoint-`. */
  themeNamespace(namespace: string): ThemeEntry[];
  /**
   * Whether a custom property *as it appears in generated CSS* is a theme
   * variable. Under a project prefix Tailwind emits `--tw-color-brand` for the
   * theme's `--color-brand`, which is indistinguishable by name from its own
   * `--tw-shadow` registers — only the theme can tell them apart.
   */
  isThemeVariable(name: string): boolean;
}

export interface TailwindProjectRef {
  /** Absolute path to the app whose `node_modules` provides Tailwind. */
  appRoot: string;
  /** Absolute path to the CSS entry that imports Tailwind. */
  cssEntry: string;
}

export type TailwindLoadResult =
  | {
      status: "ok";
      system: TailwindDesignSystem;
      /**
       * `@plugin` / `@config` modules the project's CSS names that were not
       * loaded, because loading them would run project code in Electron main.
       * Utilities they add are absent from this system.
       */
      skippedModules: string[];
    }
  | { status: "unavailable"; reason: string };

interface RawDesignSystem {
  theme: { values: Map<string, { value: string } | string>; prefix: string | null };
  candidatesToCss(candidates: string[]): (string | null)[];
  candidatesToAst(candidates: string[]): (unknown[] | null)[];
  getClassList(): [string, unknown][];
}

interface AstNode {
  kind: string;
  name?: string;
  params?: string;
  selector?: string;
  property?: string;
  value?: string;
  nodes?: AstNode[];
}

function unavailable(reason: string): TailwindLoadResult {
  return { status: "unavailable", reason };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Supplies the Tailwind engine and the version it is. Injectable so the shape
 * guards can be tested; always Daintree's own bundled copy in production.
 */
export type TailwindEngineLoader = () => Promise<{
  version: string;
  exports: Record<string, unknown>;
}>;

const bundledEngine: TailwindEngineLoader = async () => ({
  version: bundledTailwindPackage.version,
  exports: (await import("tailwindcss")) as Record<string, unknown>,
});

export async function loadTailwindDesignSystem(
  ref: TailwindProjectRef,
  loadEngine: TailwindEngineLoader = bundledEngine
): Promise<TailwindLoadResult> {
  if (!path.isAbsolute(ref.appRoot) || !path.isAbsolute(ref.cssEntry)) {
    return unavailable("appRoot and cssEntry must be absolute paths");
  }

  let require: ProjectRequire;
  try {
    require = createRequire(path.join(ref.appRoot, "package.json"));
  } catch (error) {
    return unavailable(`could not resolve from ${ref.appRoot}: ${messageOf(error)}`);
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("tailwindcss/package.json");
  } catch (error) {
    return unavailable(`tailwindcss is not installed in ${ref.appRoot}: ${messageOf(error)}`);
  }

  let manifest: { version?: string; exports?: Record<string, unknown> };
  try {
    manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as typeof manifest;
  } catch (error) {
    return unavailable(`could not read ${packageJsonPath}: ${messageOf(error)}`);
  }

  const version = typeof manifest.version === "string" ? manifest.version : "";
  // One version parser across the plugin. Reading the major with a bare
  // `split(".")` accepted `4.garbage` and rejected `v4.1.2`, which disagreed
  // with the project model's verdict on the very same installed package.
  const major = majorVersion(version);
  if (major === null) {
    return unavailable(`tailwindcss reports an unreadable version ${JSON.stringify(version)}`);
  }
  if (major !== SUPPORTED_BASELINE.tailwindMajor) {
    return unavailable(
      `tailwindcss ${version} is outside the supported major (${SUPPORTED_BASELINE.tailwindMajor}); the design-system API this relies on exists only in v${SUPPORTED_BASELINE.tailwindMajor}`
    );
  }

  // The engine is Daintree's own bundled Tailwind, never the project's copy.
  // This code runs inside Electron main, and importing a package from the
  // project's `node_modules` would execute whatever that repository ships there
  // in the trusted process. The project's package is still read — as data — for
  // its version above and for its stylesheets below.
  let moduleExports: Record<string, unknown>;
  let engineVersion: string;
  try {
    ({ exports: moduleExports, version: engineVersion } = await loadEngine());
  } catch (error) {
    return unavailable(`could not load the bundled tailwindcss engine: ${messageOf(error)}`);
  }

  // The engine supplies the utility implementations and reading the project's
  // CSS supplies only its theme, so an engine one minor ahead would call a
  // utility that minor added valid in a project that cannot generate it. Refuse
  // rather than answer confidently for a compiler we are not running.
  if (minorOf(engineVersion) !== minorOf(version)) {
    return unavailable(
      `class awareness is built on tailwindcss ${engineVersion}, and this project uses ${version}; its utilities could differ, so completion is off rather than misleading`
    );
  }

  const loadDesignSystem = pickLoader(moduleExports);
  if (!loadDesignSystem) {
    return unavailable(
      "the bundled tailwindcss does not expose __unstable__loadDesignSystem; class awareness is off"
    );
  }

  const skipped: string[] = [];
  let raw: RawDesignSystem;
  try {
    const css = await fs.readFile(ref.cssEntry, "utf8");
    raw = (await loadDesignSystem(css, {
      base: path.dirname(ref.cssEntry),
      loadStylesheet: (id: string, base: string) => resolveStylesheet(require, id, base),
      loadModule: (id: string, base: string, hint?: string) => inertModule(id, base, hint, skipped),
    })) as RawDesignSystem;
  } catch (error) {
    return unavailable(`could not compile ${ref.cssEntry}: ${messageOf(error)}`);
  }

  if (
    typeof raw?.candidatesToCss !== "function" ||
    typeof raw?.candidatesToAst !== "function" ||
    typeof raw?.getClassList !== "function" ||
    !(raw?.theme?.values instanceof Map)
  ) {
    return unavailable(
      `tailwindcss ${version} returned a design system with an unrecognised shape; class awareness is off`
    );
  }

  const system = createFacade(raw, version);

  // A build that keeps every method name but changes what they return would
  // otherwise answer "valid, and conflicts with nothing" — an unavailable
  // analysis wearing the clothes of a successful one. Prove the AST path end to
  // end before claiming the system is usable.
  const probe = CAPABILITY_PROBES.map((utility) =>
    system.prefix ? `${system.prefix}:${utility}` : utility
  ).find((candidate) => system.cssFor(candidate) !== null);
  if (!probe || (system.compile(probe)?.declarations.length ?? 0) === 0) {
    return unavailable(
      `tailwindcss ${version} compiles utilities but exposes no readable declarations; class awareness is off`
    );
  }

  return { status: "ok", system, skippedModules: skipped };
}

/**
 * Conditional exports nest arbitrarily (`{".": {"node": {"import": …}}}`), so
 * the root entry is walked rather than probed one level deep. The fallback is
 * Tailwind 4's published path, which is what every 4.x has shipped so far.
 */
/** Utilities every Tailwind 4 theme generates, used to prove the AST path. */
const CAPABILITY_PROBES = ["block", "flex", "underline", "italic"];

const IMPORT_CONDITIONS = ["node", "import", "module", "default", "require"];

function pickCondition(
  entry: unknown,
  depth: number,
  conditions: string[] = IMPORT_CONDITIONS
): string | null {
  if (typeof entry === "string") return entry;
  if (depth > 8 || typeof entry !== "object" || entry === null) return null;
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const found = pickCondition(item, depth + 1, conditions);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(entry as Record<string, unknown>)) {
    if (!conditions.includes(key)) continue;
    const found = pickCondition((entry as Record<string, unknown>)[key], depth + 1, conditions);
    if (found) return found;
  }
  return null;
}

function pickLoader(
  moduleExports: Record<string, unknown>
): ((css: string, options: unknown) => Promise<unknown>) | null {
  const candidates = [moduleExports, moduleExports.default as Record<string, unknown> | undefined];
  for (const source of candidates) {
    const loader = source?.__unstable__loadDesignSystem;
    if (typeof loader === "function") {
      return loader as (css: string, options: unknown) => Promise<unknown>;
    }
  }
  return null;
}

/**
 * `@import "tailwindcss"` has to resolve through the *project's* resolver, and
 * the package's CSS is not reachable through its `require`/`import` conditions
 * — those point at the compiler. Hence the explicit `.css` subpaths.
 */
async function resolveStylesheet(
  require: ProjectRequire,
  id: string,
  base: string
): Promise<{ base: string; content: string; path: string }> {
  const file =
    id.startsWith(".") || path.isAbsolute(id)
      ? resolveRelativeCss(path.resolve(base, id))
      : resolveCssSubpath(require, id, base);
  return { base: path.dirname(file), content: await fs.readFile(file, "utf8"), path: file };
}

function resolveRelativeCss(file: string): string {
  if (fsSync.existsSync(file)) return file;
  // `@import "./theme"` is legal CSS; the file on disk is `theme.css`.
  if (fsSync.existsSync(`${file}.css`)) return `${file}.css`;
  return file;
}

/**
 * A CSS package advertises its stylesheet through the `style` export condition
 * or a top-level `style` field, neither of which `require.resolve` will pick —
 * it resolves for JavaScript. Getting this wrong is not a degraded import: a
 * single unresolvable `@import` takes the whole design system down, and
 * `tw-animate-css` alone is common enough to matter.
 */
function findManifest(require: ProjectRequire, packageName: string, base: string): string | null {
  for (const dir of [
    ...(require.resolve.paths(packageName) ?? []),
    path.join(base, "node_modules"),
  ]) {
    const candidate = path.join(dir, packageName, "package.json");
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveCssSubpath(require: ProjectRequire, id: string, base: string): string {
  const paths = [base];
  const [scope, rest] = id.startsWith("@")
    ? [id.split("/").slice(0, 2).join("/"), id.split("/").slice(2).join("/")]
    : [id.split("/")[0] ?? id, id.split("/").slice(1).join("/")];

  // Not `require.resolve("<pkg>/package.json")`: a CSS-only package such as
  // `tw-animate-css` publishes an `exports` map with no `./package.json` entry,
  // and Node refuses the subpath outright. The manifest still has to be read to
  // find the `style` condition, so it is located on disk instead.
  const manifestPath = findManifest(require, scope, base);
  let packageDir: string | null = null;
  let manifest: Record<string, unknown> = {};
  if (manifestPath) {
    try {
      packageDir = path.dirname(manifestPath);
      manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    } catch {
      packageDir = null;
    }
  }

  if (packageDir) {
    const exports = manifest.exports as Record<string, unknown> | undefined;
    const entry = exports?.[rest === "" ? "." : `./${rest}`];
    const declared = pickCondition(entry, 0, ["style", "default"]);
    const styleField = typeof manifest.style === "string" ? manifest.style : null;
    const mainField =
      typeof manifest.main === "string" && manifest.main.endsWith(".css") ? manifest.main : null;
    const fallback = rest === "" ? (styleField ?? mainField) : null;
    for (const candidate of [declared, fallback, rest === "" ? "./index.css" : `./${rest}`]) {
      if (!candidate) continue;
      const resolved = resolveRelativeCss(path.resolve(packageDir, candidate));
      if (fsSync.existsSync(resolved)) return resolved;
    }
  }

  for (const attempt of id.endsWith(".css") ? [id] : [`${id}/index.css`, `${id}/index`, id]) {
    try {
      return require.resolve(attempt, { paths });
    } catch {
      continue;
    }
  }
  throw new Error(`cannot resolve stylesheet ${JSON.stringify(id)} from ${base}`);
}

/**
 * Stands in for a module named by `@plugin` or `@config`. Loading it would mean
 * running the project's JavaScript inside Electron main, so it is never loaded:
 * a plugin becomes a plugin that registers nothing, and a config becomes an
 * empty one. The design system still compiles; it simply lacks what those
 * modules would have added, and `skipped` records which ones.
 */
async function inertModule(
  id: string,
  base: string,
  hint: string | undefined,
  skipped: string[]
): Promise<{ base: string; module: unknown; path: string }> {
  skipped.push(id);
  return { base, module: hint === "config" ? {} : inertPlugin(), path: path.resolve(base, id) };
}

/**
 * A plugin that registers nothing, in the `plugin.withOptions` shape. A bare
 * function works for `@plugin "x";` but Tailwind throws "does not accept
 * options" for `@plugin "x" { … }`, which would take the whole design system
 * down for a project that merely configures a plugin.
 */
function inertPlugin(): unknown {
  return Object.assign(() => ({ handler: () => {}, config: {} }), { __isOptionsFunction: true });
}

function minorOf(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return match ? `${match[1]}.${match[2]}` : null;
}

function createFacade(raw: RawDesignSystem, version: string): TailwindDesignSystem {
  const cssCache = new Map<string, string | null>();
  const compileCache = new Map<string, CompiledCandidate | null>();

  const cssFor = (candidate: string): string | null => {
    const cached = cssCache.get(candidate);
    if (cached !== undefined) return cached;
    let css: string | null;
    try {
      css = raw.candidatesToCss([candidate])[0] ?? null;
    } catch {
      css = null;
    }
    cssCache.set(candidate, css);
    return css;
  };

  return {
    version,
    prefix: typeof raw.theme.prefix === "string" ? raw.theme.prefix : null,

    cssFor,

    compile(candidate) {
      const cached = compileCache.get(candidate);
      if (cached !== undefined) return cached;
      // `candidatesToAst` answers `[]` for an unknown candidate, so it cannot
      // distinguish "invalid" from "generated nothing". `candidatesToCss`
      // answering null is the only oracle for validity.
      const compiled = cssFor(candidate) === null ? null : collectDeclarations(raw, candidate);
      compileCache.set(candidate, compiled);
      return compiled;
    },

    classNames() {
      // Every one of these is an unstable-API surface: a shape change must
      // degrade the completion list, not take the inspector down with it.
      try {
        const list = raw.getClassList();
        if (!Array.isArray(list)) return [];
        return list
          .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
          .filter((name): name is string => typeof name === "string");
      } catch {
        return [];
      }
    },

    isThemeVariable(name) {
      const prefix = typeof raw.theme.prefix === "string" ? raw.theme.prefix : null;
      const unprefixed =
        prefix && name.startsWith(`--${prefix}-`) ? `--${name.slice(prefix.length + 3)}` : name;
      return raw.theme.values.has(unprefixed);
    },

    themeNamespace(namespace) {
      const entries: ThemeEntry[] = [];
      for (const [key, stored] of raw.theme.values) {
        if (!key.startsWith(namespace) || key.length === namespace.length) continue;
        const value = typeof stored === "string" ? stored : stored?.value;
        if (typeof value !== "string") continue;
        entries.push({ name: key.slice(namespace.length), value });
      }
      return entries;
    },
  };
}

function collectDeclarations(raw: RawDesignSystem, candidate: string): CompiledCandidate {
  let ast: unknown[] | null;
  try {
    ast = raw.candidatesToAst([candidate])[0] ?? null;
  } catch {
    return { declarations: [], registers: {} };
  }
  if (!Array.isArray(ast)) return { declarations: [], registers: {} };

  const className = `.${escapeClassName(candidate)}`;
  const out: CompiledDeclaration[] = [];
  const registers: Record<string, string> = {};

  const walk = (node: AstNode, conditions: string[], selectors: string[]): void => {
    if (typeof node !== "object" || node === null) return;
    switch (node.kind) {
      case "at-rule": {
        // `@property` blocks register the `--tw-*` registers a utility relies
        // on. They are shared machinery, not this utility's own output.
        if (node.name === "@property") {
          if (node.params) registers[node.params.trim()] = initialValueOf(node);
          return;
        }
        const next =
          node.name === "@media" || node.name === "@container" || node.name === "@supports"
            ? [...conditions, `${node.name} ${node.params ?? ""}`.trim()]
            : conditions;
        for (const child of node.nodes ?? []) walk(child, next, selectors);
        return;
      }
      case "rule": {
        if (typeof node !== "object" || node === null) return;
        const selector = node.selector ?? "";
        // Only the first occurrence: `.a .ab` and `.b b` both collapse to the
        // same shape under a global replace, which would pit two utilities
        // targeting different descendants against each other.
        const at = selector.indexOf(className);
        const stripped =
          at === -1 ? selector : selector.slice(0, at) + selector.slice(at + className.length);
        const next = [...selectors, normaliseSelector(stripped)];
        for (const child of node.nodes ?? []) walk(child, conditions, next);
        return;
      }
      case "declaration": {
        if (typeof node.property !== "string") return;
        out.push({
          property: node.property,
          value: node.value ?? "",
          scope: { conditions: [...conditions].sort(), selector: selectors.join(" ").trim() },
        });
        return;
      }
      default: {
        for (const child of node.nodes ?? []) walk(child, conditions, selectors);
      }
    }
  };

  try {
    for (const node of ast) walk(node as AstNode, [], []);
  } catch {
    return { declarations: [], registers: {} };
  }
  return { declarations: out, registers };
}

function initialValueOf(node: AstNode): string {
  for (const child of node.nodes ?? []) {
    if (child.kind === "declaration" && child.property === "initial-value") {
      return (child.value ?? "").trim();
    }
  }
  return "";
}

/**
 * Variant order is not selector semantics: `hover:focus:p-4` and
 * `focus:hover:p-4` match the same elements but print their pseudo-classes in
 * opposite orders. A selector that is nothing but appended pseudo-classes is
 * therefore compared as a set.
 */
const PSEUDO_ONLY = /^(?::{1,2}[a-zA-Z-]+(?:\([^()]*\))?)+$/;

function normaliseSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!PSEUDO_ONLY.test(trimmed)) return trimmed;
  return (trimmed.match(/:{1,2}[a-zA-Z-]+(?:\([^()]*\))?/g) ?? []).sort().join("");
}

/**
 * CSSOM `CSS.escape` for the identifier case — Tailwind writes selectors with
 * it, and there is no `CSS` global in the main process. A leading digit becomes
 * a hex escape plus a space, which is why `2xl:p-4` is `.\32 xl\:p-4`.
 */
export function escapeClassName(candidate: string): string {
  let out = "";
  for (let index = 0; index < candidate.length; index++) {
    const char = candidate[index] as string;
    const code = candidate.charCodeAt(index);
    if (code === 0) {
      out += "\uFFFD";
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (code >= 0x80 || char === "-" || char === "_" || /[a-zA-Z0-9]/.test(char)) {
      const leadingDigit = index === 0 && code >= 0x30 && code <= 0x39;
      const leadingDashDigit = index === 1 && candidate[0] === "-" && code >= 0x30 && code <= 0x39;
      out += leadingDigit || leadingDashDigit ? `\\${code.toString(16)} ` : char;
      continue;
    }
    out += `\\${char}`;
  }
  return out;
}
