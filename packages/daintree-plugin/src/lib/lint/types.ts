import type { PreparedSource } from "./source.js";

export type LintSeverity = "warn" | "error";

/**
 * Where a file runs. `view` is renderer code, `worker` the plugin's utility
 * process, `shared` code that could be imported by either, `style` a stylesheet.
 */
export type LintFileKind = "view" | "worker" | "shared" | "style";

/**
 * `source` is what the author wrote. `build` is generated output: only rules
 * about what a build produced (a bundled React) read it, so findings are never
 * reported twice — once in the source and again in its bundle.
 */
export type LintFileRole = "source" | "build";

export interface ClassToken {
  token: string;
  offset: number;
}

export interface JsxElement {
  /** `button`, `svg`, or a component identifier such as `Button`. */
  tag: string;
  intrinsic: boolean;
  offset: number;
  /** Props-object range in `code`/`masked`, when the second argument is an object literal. */
  props: [number, number] | null;
}

export interface LintFile extends PreparedSource {
  /** Absolute path. */
  path: string;
  /** Path relative to the plugin directory, forward slashes. */
  rel: string;
  kind: LintFileKind;
  role: LintFileRole;
  /** The file as the author wrote it. */
  raw: string;
  /** One entry per class-string context (a `className`, a `cn()` call, a `*Class` constant). */
  classContexts: ClassToken[][];
  elements: JsxElement[];
}

export interface RuleHit {
  offset?: number;
  line?: number;
  /** Replaces the rule's default message for this hit. */
  message?: string;
}

export interface LintRule {
  id: string;
  severity: LintSeverity;
  appliesTo: "view" | "worker" | "any";
  /** `script` (default) reads source scripts, `style` stylesheets, `build` generated view bundles. */
  target?: "script" | "style" | "build";
  message: string;
  hint: string;
  check(file: LintFile): RuleHit[];
}

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  file: string;
  line: number;
  message: string;
  hint: string;
}
