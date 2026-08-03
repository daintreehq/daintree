import type { PanelInstance, PtyPanelData, TerminalInstance } from "@shared/types/panel";
import { isPtyPanel } from "@shared/types/panel";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { cleanTaskTitle, stripIdentityAffixes } from "@shared/utils/taskTitle";

/**
 * How much room the rendering surface has for a terminal's display title.
 *
 * - `"full"` — grid panel headers, tooltips, aria labels: `"Claude: fix auth
 *   tests"`.
 * - `"compact"` — narrow tab strips (~100px): the task alone; the agent icon
 *   already carries identity, and an identity prefix would push the task out
 *   of the truncation window entirely.
 * - `"base"` — dock rows and other identity-dense chrome: the identity title
 *   only, no task.
 */
export type TerminalTitleVariant = "full" | "compact" | "base";

/**
 * The minimum a surface must know to compose a title.
 *
 * Exported because not every caller holds a panel: the fleet overview renders
 * runs from other projects, whose panels live in V8 contexts this one cannot
 * reach, so it reconstructs this shape from the main-process snapshot.
 */
export type TitledPanel = Pick<
  PtyPanelData,
  "title" | "titleMode" | "lastObservedTitle" | "detectedAgentId" | "agentState"
> &
  Partial<Pick<PtyPanelData, "cwd">>;

// Words that agents pad their non-task titles with: product-name filler
// ("Claude Code", "Gemini CLI") and idle-status words ("Ready"). Only
// relevant when every other token already matches the agent's identity —
// a real task containing one of these still composes.
const GENERIC_TITLE_WORDS = new Set([
  "code",
  "cli",
  "agent",
  "assistant",
  "terminal",
  "ready",
  "idle",
  "working",
]);

function titleTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function normalizeLabel(value: string | undefined): string {
  return titleTokens(value).join(" ");
}

// "OC" for "OpenCode", "QC" for "Qwen Code" — agents abbreviate themselves
// in title affixes. Initials count as filler, never as identity: "OC" alone
// must fall back to the identity title, not display as an echo.
function nameInitials(name: string | undefined): string[] {
  if (!name) return [];
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap((w) => w.split(/(?<=\p{Ll})(?=\p{Lu})/u));
  if (words.length < 2) return [];
  return [
    words
      .map((w) => w[0])
      .join("")
      .toLowerCase(),
  ];
}

function cwdBasename(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
}

interface ObservedTask {
  task: string;
  /**
   * The observed title names the agent rather than a task ("Claude Code"
   * from identity "Claude"): every token matches the identity (panel title,
   * registry name, binary) or generic product filler, with at least one
   * genuine identity token.
   */
  isIdentityEcho: boolean;
}

// Bounded memo over the exact fields `computeObservedTask` reads. Title
// surfaces (tab strips, headers, dock rows) re-derive titles on every
// panel-store flush — per animation frame during agent output — while the
// inputs only change on real title/identity transitions. AGENT_REGISTRY is
// static, so the six fields fully determine the result. FIFO eviction: the
// live working set is panels × recent titles, far below the cap.
const OBSERVED_TASK_CACHE_MAX = 500;
const observedTaskCache = new Map<string, ObservedTask | null>();

function getObservedTask(panel: TitledPanel): ObservedTask | null {
  // JSON-encoded tuple: field values are OSC/terminal-controlled strings, so
  // a delimiter-join could collide across positions; JSON escaping cannot.
  // null stands in for undefined to keep it distinct from an empty string.
  const key = JSON.stringify([
    panel.titleMode ?? "default",
    panel.detectedAgentId ?? null,
    panel.agentState === "exited",
    panel.lastObservedTitle ?? null,
    panel.title,
    panel.cwd ?? null,
  ]);
  const cached = observedTaskCache.get(key);
  if (cached !== undefined || observedTaskCache.has(key)) return cached ?? null;
  const value = computeObservedTask(panel);
  if (observedTaskCache.size >= OBSERVED_TASK_CACHE_MAX) {
    const oldest = observedTaskCache.keys().next().value;
    if (oldest !== undefined) observedTaskCache.delete(oldest);
  }
  observedTaskCache.set(key, value);
  return value;
}

function computeObservedTask(panel: TitledPanel): ObservedTask | null {
  if ((panel.titleMode ?? "default") === "user") return null;
  if (panel.detectedAgentId === undefined || panel.agentState === "exited") return null;
  const cleaned = cleanTaskTitle(panel.lastObservedTitle);
  if (!cleaned || isUselessTitle(cleaned)) return null;
  const agent = AGENT_REGISTRY[panel.detectedAgentId];
  const identity = new Set([
    ...titleTokens(panel.title),
    ...titleTokens(agent?.name),
    ...titleTokens(agent?.command),
  ]);
  const filler = new Set([...GENERIC_TITLE_WORDS, ...nameInitials(agent?.name)]);
  // Affix noise must be a WHOLE identity label — name, binary, initials, or
  // the panel title — never token overlap or filler. Anything looser eats
  // real tasks: "Terminal: preserve OSC title" (filler token), "Open: file
  // picker" under Open Interpreter (one token of a multi-word name).
  const noiseLabels = new Set(
    [
      normalizeLabel(panel.title),
      normalizeLabel(agent?.name),
      normalizeLabel(agent?.command),
      ...nameInitials(agent?.name),
    ].filter(Boolean)
  );
  const isNoiseSegment = (segment: string) => noiseLabels.has(normalizeLabel(segment));
  // Grok's " - grok" suffix, OpenCode's "OC | " prefix: identity decoration
  // around a real task, stripped segment-wise from the ends.
  const task = stripIdentityAffixes(cleaned, isNoiseSegment);
  if (!task || isUselessTitle(task)) return null;
  // Workspace echo (Codex idle titles itself with the cwd folder name):
  // where the agent is, not what it's doing — the pane already shows that.
  const folder = cwdBasename(panel.cwd);
  if (folder && task.toLowerCase() === folder.toLowerCase()) return null;
  const tokens = titleTokens(task);
  if (tokens.length === 0) return null;
  if (tokens.some((t) => !identity.has(t) && !filler.has(t))) {
    return { task, isIdentityEcho: false };
  }
  // All tokens are identity/filler. An echo needs at least one identity
  // token that isn't itself filler — "Qwen Code" makes "code" an identity
  // token, but "Code CLI" is still pure filler ("Ready"), useless, not
  // an echo.
  if (!tokens.some((t) => identity.has(t) && !filler.has(t))) return null;
  return { task, isIdentityEcho: true };
}

/**
 * The agent's current task, or `null` when nothing should compose: no live
 * detected agent (stale tasks must not survive agent exit into plain-shell
 * display), a user-locked title, an identity echo ("Claude Code"), or a task
 * that fails the usefulness filter.
 */
export function getTerminalTaskTitle(panel: TitledPanel): string | null {
  const observed = getObservedTask(panel);
  return observed && !observed.isIdentityEcho ? observed.task : null;
}

/**
 * Single source of truth for a terminal's human-facing title. Every surface
 * (tab, header, dock, palette, tooltip) renders through this — components
 * must not concatenate title strings themselves.
 */
export function getTerminalDisplayTitle(
  panel: PanelInstance | TerminalInstance,
  variant: TerminalTitleVariant,
  opts?: { showTask?: boolean }
): string {
  if (variant !== "base" && opts?.showTask !== false && !isPtyPanel(panel)) return panel.title;
  return composeTitledPanel(panel, variant, opts);
}

/**
 * The same composition for a caller that has the fields but not a panel.
 *
 * Split out rather than duplicated because the rules here are the product
 * decision — identity-echo suppression, affix stripping, the user-title veto —
 * and a second surface re-deriving them is how "Claude Code" ends up rendered
 * as a task in one list and not another.
 */
export function composeTitledPanel(
  panel: TitledPanel,
  variant: TerminalTitleVariant,
  opts?: { showTask?: boolean }
): string {
  const base = panel.title;
  if (variant === "base" || opts?.showTask === false) return base;
  const observed = getObservedTask(panel);
  if (!observed) return base;
  if (observed.isIdentityEcho) {
    // "Claude: Claude Code" is noise. A default identity yields to the
    // agent's richer self-description ("Claude Code"); an explicit preset
    // identity ("Claude [Z.ai]") outranks the echo and stays as-is.
    return (panel.titleMode ?? "default") === "default" ? observed.task : base;
  }
  return variant === "compact" ? observed.task : `${base}: ${observed.task}`;
}
