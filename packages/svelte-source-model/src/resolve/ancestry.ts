import type { DevLocation } from "../types.js";
import { isGeneratedSourceFile } from "./generated.js";

/**
 * The ancestry chain as Svelte's dev runtime writes it onto
 * `__svelte_meta.parent`, read verbatim. The runtime is the untrusted side of
 * this boundary: a page can put anything on that object, so every field is
 * treated as a claim about the project's own source and nothing more.
 */
export interface RawAncestryFrame {
  type: string;
  file: string;
  line: number;
  column: number;
  componentTag?: string;
}

/**
 * Frame kinds `add_svelte_meta` pushes. `unknown` is deliberate: a future
 * compiler release adding a kind must degrade the breadcrumb, never invalidate
 * a selection that resolved correctly.
 */
export type AncestryKind =
  "component" | "each" | "if" | "await" | "key" | "render" | "snippet" | "unknown";

export interface AncestryEntry {
  kind: AncestryKind;
  location: DevLocation;
  /** Present on `component` entries: the tag as written at the call site. */
  componentTag?: string;
  generated: boolean;
}

export interface InterpretedAncestry {
  /** Innermost first, generated frames kept but flagged. */
  entries: AncestryEntry[];
  /**
   * Nearest non-generated `component` entry — the call site that rendered this
   * particular copy. Null when the only component frames are generated ones,
   * which is what a node rendered directly by the route shell looks like.
   */
  invocation: AncestryEntry | null;
  /** Outermost-first human trail, generated frames omitted. */
  breadcrumb: string;
}

const KINDS: ReadonlySet<string> = new Set([
  "component",
  "each",
  "if",
  "await",
  "key",
  "render",
  "snippet",
]);

const BLOCK_LABELS: Record<string, string> = {
  each: "{#each}",
  if: "{#if}",
  await: "{#await}",
  key: "{#key}",
  render: "{@render}",
  snippet: "{#snippet}",
};

function toKind(type: string): AncestryKind {
  return KINDS.has(type) ? (type as AncestryKind) : "unknown";
}

function label(entry: AncestryEntry): string {
  if (entry.kind === "component") return entry.componentTag ?? "component";
  return BLOCK_LABELS[entry.kind] ?? "block";
}

/**
 * Turns the raw parent chain into the three things a selection needs: which
 * frames are the user's, which call site produced this copy, and a trail a
 * person can read.
 *
 * The invocation is the load-bearing one. It is what separates "this markup,
 * wherever it renders" from "this one use of it" — collapsing the two is how a
 * visual editor changes every pricing card while claiming to change one. A
 * generated frame can never be an invocation: SvelteKit's `root.svelte` really
 * is an ancestor of every node on the page, and offering it as an edit target
 * would point the user at a file the framework rewrites.
 */
export function interpretAncestry(frames: readonly RawAncestryFrame[]): InterpretedAncestry {
  const entries: AncestryEntry[] = frames.map((frame) => {
    const entry: AncestryEntry = {
      kind: toKind(frame.type),
      location: { file: frame.file, line: frame.line, column: frame.column },
      generated: isGeneratedSourceFile(frame.file),
    };
    if (frame.componentTag !== undefined) entry.componentTag = frame.componentTag;
    return entry;
  });

  // The *nearest* component frame is the call site. If that frame is generated
  // or dependency-owned there is no user-editable invocation, and the next
  // authored component frame up the chain is a different call — reporting it
  // would offer an edit at a site that did not render this node.
  const nearestComponent = entries.find((entry) => entry.kind === "component") ?? null;
  const invocation = nearestComponent?.generated === false ? nearestComponent : null;

  const breadcrumb = entries
    .filter((entry) => !entry.generated)
    .reverse()
    .map(label)
    .join(" › ");

  return { entries, invocation, breadcrumb };
}
