import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import {
  MAIN_DISPATCH_DEADLINE_MS,
  requestMcpConfirmation,
  useMcpConfirmStore,
  type McpConfirmResolution,
  type McpConfirmSelectableTarget,
} from "@/store/mcpConfirmStore";
import { usePanelStore } from "@/store/panelStore";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { runWithMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import {
  buildWorktreeDeletePreview,
  formatWorktreeDeletePreviewLines,
  settleWorktreeDeleteOutcome,
  worktreeDeleteBlockedBy,
  worktreeDeleteContentRisk,
  type WorktreeDeletePreviewOutcome,
} from "@/components/Worktree/worktreeDeletePreview";
import { deriveEffectiveTier } from "@/services/actions/deriveEffectiveTier";
import { isProtectedBranch as isProtectedBranchName } from "@shared/utils/gitConstants";
import {
  buildGitRemoteOperationPreview,
  formatGitRemoteOperationPreviewLines,
} from "@/components/Git/gitRemoteOperationPreview";
import { formatRecipePreviewLines } from "@/components/TerminalRecipe/recipeConfirmPreview";
import { readDispatchRecipeId } from "@/services/actions/effectiveDanger";
import { MAX_AGENT_RECIPE_TERMINALS, useRecipeStore } from "@/store/recipeStore";
import {
  resolveWorktreeLocation,
  type WorktreeLocationArgs,
} from "@/services/actions/definitions/locationArgs";
import type {
  ActionContext,
  ActionDispatchResult,
  ActionId,
  HostApprovedTarget,
} from "@shared/types/actions";
import type { McpConfirmationDecision, McpSessionOrigin } from "@shared/types/ipc/mcpServer";
import type { TerminalSpawnSource } from "@shared/types/panel";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { summarizeMcpArgs } from "@shared/utils/mcpArgsSummary";
import { getCurrentViewStore } from "@/store/createWorktreeStore";

const REJECTION_RESULT: ActionDispatchResult = {
  ok: false,
  error: {
    code: "USER_REJECTED",
    message: "User rejected the confirmation request.",
  },
};

/**
 * The approval arrived, but main had already given up on the request.
 *
 * Distinct from {@link TIMEOUT_RESULT}, which means nobody answered: here a
 * human DID approve, and the point is that we must not act on it. Main dropped
 * the pending dispatch at its deadline and told the agent the call timed out,
 * so starting an irreversible delete now would destroy a worktree on the
 * strength of a result the caller was told never happened. The response itself
 * is very likely discarded; refusing is about not doing the work.
 */
const EXPIRED_APPROVAL_RESULT: ActionDispatchResult = {
  ok: false,
  error: {
    code: "CONFIRMATION_TIMEOUT",
    message:
      "Force delete refused: the request passed its dispatch deadline before the approval could be re-checked, so nothing was deleted.",
  },
};

const TIMEOUT_RESULT: ActionDispatchResult = {
  ok: false,
  error: {
    code: "CONFIRMATION_TIMEOUT",
    message: "Confirmation request timed out before the user responded.",
  },
};

/**
 * Of the gated actions that carry a `recipeId`, the ones that actually START
 * the recipe's terminals. Purely a wording concern for the confirm preview:
 * `recipe.delete` and `recipe.saveToRepo` are also gated and preview the same
 * content, but telling the approver those terminals are about to run would be
 * false. Getting this list wrong understates a dispatch's framing; it can never
 * skip a gate, which `resolveEffectiveActionDanger` owns from the args alone.
 */
const RECIPE_SPAWNING_ACTIONS = new Set([
  "recipe.run",
  "worktree.createWithRecipe",
  "workflow.startWorkOnIssue",
]);

const MCP_SPAWN_TAGGED_ACTIONS = new Set([
  "recipe.run",
  "terminal.duplicate",
  "terminal.new",
  "workflow.startWorkOnIssue",
  "worktree.createWithRecipe",
  "worktree.resource.connect",
]);

function shouldTagMcpSpawn(actionId: string): boolean {
  return actionId.startsWith("agent.") || MCP_SPAWN_TAGGED_ACTIONS.has(actionId);
}

/**
 * What a confirm modal should preview, resolved once per dispatch. Raw args
 * ({worktreeId, force} / {cwd, setUpstream}) tell an approver nothing about
 * what the dispatch would actually affect, so each kind names a live fetch to
 * run instead. Actions with no meaningful preview resolve to `undefined` and
 * the modal just shows args as before.
 */
export type McpConfirmPreviewTarget =
  /**
   * `force` is read here, once, from the dispatch args, and carried so the
   * preview fetch, the typed-name gate and the pre-dispatch re-check all read
   * the same flag (#12115). It decides whether a gate is possible at all — a
   * non-force delete cannot destroy anything the host does not first refuse —
   * and that is the ONLY influence a caller's arguments have over the gate.
   */
  | { kind: "worktreeDelete"; worktreeId: string; force: boolean }
  | { kind: "gitPush"; cwd: string }
  | { kind: "gitPullRebase"; cwd: string }
  /**
   * `recipeId` is the id the CALLER named; the preview resolves it through
   * `getRecipeById` and `resolvedRecipeId` records the winner that resolution
   * picked, so the approved dispatch can be pinned to the recipe actually shown
   * (#11860). `spawns` says whether this dispatch will actually START those
   * terminals — `recipe.delete` and `recipe.saveToRepo` are gated and preview
   * the same content, but describing it as "starts" would be a lie.
   */
  | { kind: "recipe"; recipeId: string; resolvedRecipeId: string; spawns: boolean }
  /**
   * A batch kill's explicit target list (#12123). Unlike every kind above, this
   * one previews no async fetch: the rows come straight out of the renderer's
   * own panel store, synchronously, at request time. That is the requirement,
   * not a shortcut — the list must be complete and frozen before the dialog is
   * interactive, and a late-arriving row is a row that appears under a cursor
   * already moving toward the confirm button.
   */
  | { kind: "terminalKillBatch"; terminalIds: readonly string[] };

/** Section heading rendered above each kind's preview lines. */
const PREVIEW_TITLES: Record<McpConfirmPreviewTarget["kind"], string> = {
  worktreeDelete: "Working tree changes",
  gitPush: "Branch and local commits",
  gitPullRebase: "Branch and local commits",
  recipe: "Recipe contents",
  // Unused: this kind renders a selectable checklist with its own heading
  // rather than the preview card. Present so the map stays exhaustive.
  terminalKillBatch: "Terminals",
};

export function mcpConfirmPreviewTitle(target: McpConfirmPreviewTarget): string {
  return PREVIEW_TITLES[target.kind];
}

/**
 * The worktree id a `worktree.delete` targets, or undefined when it carries no
 * usable id (#11343).
 */
function worktreeIdArg(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || !("worktreeId" in args)) return undefined;
  // `in` narrows the property to `unknown` — no cast needed (and no
  // no-unsafe-type-assertion warning).
  const worktreeId = args.worktreeId;
  return typeof worktreeId === "string" && worktreeId.length > 0 ? worktreeId : undefined;
}

/**
 * Whether a `worktree.delete` dispatch asked to force past the host's refusal.
 *
 * Strict identity, never truthiness: `argsSchema` types this as an optional
 * boolean, and coercing `"false"` or `0` here would let a caller reach the
 * destructive path through a value the schema would have rejected — or, worse,
 * duck the gate with one the schema accepts as true. Anything that is not
 * literally `true` is a non-force delete, which is what `run()` passes through
 * to `worktreeClient.delete` anyway.
 */
function forceArg(args: unknown): boolean {
  if (args === null || typeof args !== "object" || !("force" in args)) return false;
  return args.force === true;
}

/**
 * How a git dispatch NAMED its target worktree, which is NOT the same question
 * as "which worktree is it".
 *
 * `"omitted"` means the caller named no selector at all and deferred to context
 * — the action itself falls back to `ctx.activeWorktreePath`, so previewing and
 * pinning that path is faithful. `"named"` means the caller did name one.
 * `"invalid"` means it named one but not a usable one (`""`, `null`, a number).
 * Those must never be silently replaced with the active worktree: the dispatch
 * would stop failing validation and start pushing a repository the caller never
 * asked for — precisely the #7880 no-silent-fallback rule for destructive
 * submissions.
 *
 * All three spellings are read, not just `cwd`: since #11543 the git actions
 * accept `worktreeId` and `worktreePath` as well, and previewing the active
 * worktree while `run()` resolved a `worktreeId` to a different one would attest
 * to a repository the approver never saw.
 */
type GitLocationArg =
  { state: "omitted" } | { state: "invalid" } | { state: "named"; location: WorktreeLocationArgs };

const GIT_LOCATION_KEYS = ["worktreeId", "worktreePath", "cwd"] as const;

function readGitLocationArg(args: unknown): GitLocationArg {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return { state: "omitted" };
  const record = args as Record<string, unknown>;
  const named = GIT_LOCATION_KEYS.filter((key) => record[key] !== undefined);
  if (named.length === 0) return { state: "omitted" };
  if (named.some((key) => typeof record[key] !== "string" || record[key] === "")) {
    return { state: "invalid" };
  }
  return {
    state: "named",
    location: Object.fromEntries(named.map((key) => [key, record[key]])) as WorktreeLocationArgs,
  };
}

/**
 * The terminal ids a `terminal.killBatch` names, or undefined when the args
 * carry no usable list (#12123).
 *
 * Deliberately strict and deliberately silent on failure: a malformed list gets
 * no checklist and falls through to `argsSchema` validation, which rejects it.
 * Repairing it here into something dispatchable would put a target list in front
 * of an approver that the action would never have accepted.
 */
function terminalIdsArg(args: unknown): readonly string[] | undefined {
  if (args === null || typeof args !== "object" || !("terminalIds" in args)) return undefined;
  const terminalIds = args.terminalIds;
  if (!Array.isArray(terminalIds) || terminalIds.length === 0) return undefined;
  if (!terminalIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
    return undefined;
  }
  return terminalIds;
}

/**
 * The checklist rows for a batch kill, read synchronously from the renderer's
 * own stores (#12123).
 *
 * Every requested id gets a row, including one that names no live panel: the
 * approver decides about the list the caller actually sent, and silently
 * dropping an unknown id would show a shorter batch than the one requested.
 *
 * `agentRunning` is the state this row is frozen at. `run()` re-reads it live
 * immediately before it destroys anything and skips a target that has escalated
 * past what the row said, so this value is what binds the approval to what was
 * on screen.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export function buildTerminalKillBatchTargets(
  terminalIds: readonly string[]
): McpConfirmSelectableTarget[] {
  const { panelsById } = usePanelStore.getState();
  // Fails soft: `getCurrentViewStore()` throws when no worktree view store is
  // mounted, and a missing worktree name costs a row a subtitle, never the
  // dialog. Same trade `resolveMcpConfirmSubject` makes.
  let worktrees: ReadonlyMap<string, { branch?: string; name?: string }> | undefined;
  try {
    worktrees = getCurrentViewStore().getState().worktrees;
  } catch {
    worktrees = undefined;
  }

  return terminalIds.map((id) => {
    // `Object.hasOwn`: `panelsById` is a plain object, so an id like
    // "constructor" would otherwise resolve off the prototype and describe a
    // function as if it were a panel.
    const panel = Object.hasOwn(panelsById, id) ? panelsById[id] : undefined;
    if (panel === undefined) {
      return { id, name: id, kindLabel: "No longer open", agentRunning: false };
    }
    const chrome = deriveTerminalChrome(panel);
    const worktree = panel.worktreeId === undefined ? undefined : worktrees?.get(panel.worktreeId);
    const worktreeName = worktree?.branch || worktree?.name;
    return {
      id,
      // The panel's own title, matching what the grid and sidebar show — the
      // derived chrome label is the panel's kind, not its name.
      name: panel.title !== undefined && panel.title.length > 0 ? panel.title : id,
      ...(worktreeName ? { worktree: worktreeName } : {}),
      kindLabel: chrome.label,
      agentRunning: terminalHasRunningAgentSession(panel),
    };
  });
}

/**
 * Resolve what this dispatch should preview, or `undefined` when it has no
 * preview. Called ONCE per dispatch: the result drives `previewPending`, the
 * fetch, the modal heading, and — for git — the cwd the approved dispatch is
 * pinned to, so all four can never disagree.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export function resolveMcpConfirmPreviewTarget(
  actionId: string,
  args: unknown,
  context: ActionContext | undefined
): McpConfirmPreviewTarget | undefined {
  if (actionId === "terminal.killBatch") {
    const terminalIds = terminalIdsArg(args);
    return terminalIds === undefined ? undefined : { kind: "terminalKillBatch", terminalIds };
  }
  if (actionId === "worktree.delete") {
    const worktreeId = worktreeIdArg(args);
    return worktreeId === undefined
      ? undefined
      : { kind: "worktreeDelete", worktreeId, force: forceArg(args) };
  }
  if (actionId === "git.push" || actionId === "git.pullRebase") {
    const named = readGitLocationArg(args);
    // A named-but-unusable selector gets no preview and no pinning — it falls
    // through to schema/`run()` validation and fails, as it did before #11538.
    if (named.state === "invalid") return undefined;
    // Run the action's OWN resolver (`worktreeId` wins, then a path spelling,
    // then the active worktree) so the previewed repository is byte-for-byte the
    // one `run()` will push. And mirror ActionService's WHOLE-OBJECT
    // `contextOverride ?? live` precedence (ActionService.ts:349): a per-field
    // fallback would diverge, because a pinned context that carries no worktree
    // path must NOT borrow the live one.
    const effectiveContext = context ?? actionService.getContext();
    let cwd: string | undefined;
    try {
      cwd = resolveWorktreeLocation(
        named.state === "named" ? named.location : undefined,
        effectiveContext
      ).worktreePath;
    } catch {
      // Contradictory path spellings, which `argsSchema` rejects anyway.
      // Previewing either one would attest to a dispatch that never runs.
      return undefined;
    }
    if (cwd === undefined || cwd.length === 0) return undefined;
    return actionId === "git.push" ? { kind: "gitPush", cwd } : { kind: "gitPullRebase", cwd };
  }
  // Any dispatch carrying a recipe id — `recipe.run` and the two composites that
  // reach the same effect — previews the terminals it would start. Keyed on the
  // argument rather than an action allowlist so it can't drift out of step with
  // `resolveEffectiveActionDanger`, which decides whether the modal opens at all.
  const recipeId = readDispatchRecipeId(args);
  if (recipeId !== undefined) {
    // Resolve now, at request time: `getRecipeById` follows shadowing to the
    // winner, and that winner is what `runRecipeWithResults` will run (#8725).
    const resolved = useRecipeStore.getState().getRecipeById(recipeId);
    return {
      kind: "recipe",
      recipeId,
      resolvedRecipeId: resolved?.id ?? recipeId,
      spawns: RECIPE_SPAWNING_ACTIONS.has(actionId),
    };
  }
  return undefined;
}

/**
 * A display-safe name for what a confirm target acts on, for the dialog title.
 *
 * Read from the renderer's own stores, never from the dispatch arguments: the
 * `argsSummary` the modal shows is already redacted, and deriving a title by
 * reparsing it would widen what main chose to expose.
 *
 * Deliberately synchronous and deliberately partial. `git.push` /
 * `git.pullRebase` resolve their branch and destination only on the async
 * preview, so they get no subject and keep a stable generic title — the preview
 * card names the branch and destination as its first two lines anyway, and
 * approval is gated until those land. A title that mutated after open would be
 * worse than a generic one: the dialog's accessible name would change without
 * being re-announced.
 */
export function resolveMcpConfirmSubject(
  target: McpConfirmPreviewTarget | undefined
): string | undefined {
  if (target === undefined) return undefined;
  // Fails soft, and that is load-bearing. This only sharpens a title;
  // `getCurrentViewStore()` throws when no worktree view store is mounted, and
  // letting that escape would turn a destructive confirmation into an
  // EXECUTION_ERROR — the dispatch would fail instead of asking the user. A
  // missing subject costs the generic title and nothing else.
  try {
    if (target.kind === "worktreeDelete") {
      const worktree = getCurrentViewStore().getState().worktrees.get(target.worktreeId);
      const name = worktree?.branch ?? worktree?.name;
      return name !== undefined && name.length > 0 ? name : undefined;
    }
    if (target.kind === "recipe") {
      const recipe = useRecipeStore.getState().getRecipeById(target.resolvedRecipeId);
      return recipe?.name !== undefined && recipe.name.length > 0 ? recipe.name : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A `worktree.delete` target, narrowed. */
type WorktreeDeleteTarget = Extract<McpConfirmPreviewTarget, { kind: "worktreeDelete" }>;

/**
 * Whether this dispatch needs the D3 typed-name gate, and what the human must
 * type (#12115).
 *
 * `"unresolvable"` is a third state on purpose. A force delete whose worktree
 * this view cannot see has an UNKNOWABLE tier — the protected-branch and
 * main-worktree inputs live on that record — so it is neither "no gate needed"
 * nor a gate we can put up, and collapsing it into either direction is
 * fail-open. The bridge refuses those rather than approving them on a D2 gate.
 */
export type McpWorktreeDeleteGate =
  { state: "none" } | { state: "required"; typedNameTarget: string } | { state: "unresolvable" };

/**
 * Derive the typed-name gate for a force worktree delete from a fresh fetch.
 *
 * The tier inputs come from two places and neither is the caller's arguments:
 * the content half from `outcome` (the same fetch whose lines the approver is
 * reading), the identity half from the renderer's own worktree record. That is
 * the whole point — the typed string is a human attestation about a specific
 * worktree, so an MCP caller must not be able to name it, and `force` is the
 * only argument that reaches this decision at all.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export function resolveWorktreeDeleteGate(
  target: WorktreeDeleteTarget,
  outcome: WorktreeDeletePreviewOutcome
): McpWorktreeDeleteGate {
  // A plain delete cannot destroy anything the host does not first refuse, so
  // there is nothing for the most emphatic consent in the app to be about.
  if (!target.force) return { state: "none" };
  // Never gate a delete that cannot proceed: the host throws on these before it
  // reads `force`, so a typed-name gate here asks for everything and then hands
  // back a toast. Same rule, same predicates as `WorktreeDeleteDialog`.
  if (worktreeDeleteBlockedBy(outcome) !== null) return { state: "none" };
  let worktree;
  try {
    worktree = getCurrentViewStore().getState().worktrees.get(target.worktreeId);
  } catch {
    // No worktree view store mounted — same unknowable tier as a missing row.
    worktree = undefined;
  }
  if (worktree === undefined) return { state: "unresolvable" };
  // No seed to fall back on the way the local dialog has one: a `"gone"`
  // outcome means the worktree is already removed, so `false` is the honest
  // tracked-changes answer rather than a stale guess.
  const risk = worktreeDeleteContentRisk(outcome, { hasTrackedChanges: false });
  const tier = deriveEffectiveTier("worktree.delete", {
    force: true,
    isProtectedBranch: isProtectedBranchName(worktree.branch?.toLowerCase()),
    isMainWorktree: worktree.isMainWorktree === true,
    hasTrackedChanges: risk.hasTrackedChanges,
    submoduleFilesAtRisk: risk.submoduleFilesAtRisk,
  });
  if (tier !== "D3") return { state: "none" };
  // `||`, not `??`. A detached worktree carries `branch: ""` as readily as
  // `undefined`, and `??` keeps the empty string — which `ConfirmDialog` reads
  // as "no gate" and silently approves. That exact substitution is #7493.
  const typedNameTarget = worktree.branch || worktree.name;
  // Nothing to attest to. Refuse rather than substituting some other identity:
  // asking the human to type a string the local dialog would never ask for is a
  // silent swap of the thing being consented to.
  return typedNameTarget ? { state: "required", typedNameTarget } : { state: "unresolvable" };
}

/** Fresh lines for the modal, plus the gate the same fetch decided. */
export interface McpConfirmPreviewResult {
  lines: string[];
  /** Present only when the fetch put a D3 typed-name gate up (#12115). */
  typedNameTarget?: string;
}

/**
 * Build fresh preview lines for a resolved target (#11343, #11538), and the
 * typed-name gate a force worktree delete earns from the same fetch (#12115).
 *
 * One fetch answers both: the tier and the lines describe the same snapshot, so
 * a gate can never be decided from content the approver was not shown.
 *
 * Never rejects: a fetch failure yields the kind's "couldn't verify" note
 * rather than an empty preview that would imply a clean tree / nothing to push.
 * That keeps approval available with the human explicitly warned — blocking it
 * instead would strand the dispatch until the modal's 28s timeout.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export async function buildMcpConfirmPreview(
  target: McpConfirmPreviewTarget
): Promise<McpConfirmPreviewResult> {
  // The checklist IS this kind's preview, and it is already on the item before
  // the modal opens. There is nothing to fetch and nothing to patch in later.
  if (target.kind === "terminalKillBatch") return { lines: [] };
  if (target.kind === "recipe") {
    // Renderer state, so no fetch — but re-read here rather than closing over
    // the resolve-time recipe so the lines reflect the store at modal-open.
    const recipe = useRecipeStore.getState().getRecipeById(target.resolvedRecipeId) ?? null;
    return {
      lines: formatRecipePreviewLines(recipe, {
        agentTerminalCap: MAX_AGENT_RECIPE_TERMINALS,
        spawns: target.spawns,
      }),
    };
  }
  if (target.kind === "worktreeDelete") {
    const outcome = await settleWorktreeDeleteOutcome(
      buildWorktreeDeletePreview(target.worktreeId)
    );
    // Deliberately the SAME formatter the local dialog's data comes from,
    // submodule half included: this surface is the one an agent-driven force
    // delete gates on, and a preview that listed only what the parent's status
    // can see would leave the approver consenting to nested files and
    // unrecoverable submodule commits they were never shown.
    const lines =
      outcome.state === "verified"
        ? formatWorktreeDeletePreviewLines(outcome.preview)
        : outcome.state === "failed"
          ? formatWorktreeDeletePreviewLines(null)
          : // Monitor gone / already removed → nothing meaningful to preview.
            [];
    const gate = resolveWorktreeDeleteGate(target, outcome);
    return gate.state === "required" ? { lines, typedNameTarget: gate.typedNameTarget } : { lines };
  }
  const operation = target.kind === "gitPush" ? "push" : "pull-rebase";
  try {
    const preview = await buildGitRemoteOperationPreview(target.cwd, operation);
    return {
      lines: formatGitRemoteOperationPreviewLines(
        preview,
        target.kind === "gitPush"
          ? "Nothing to publish — the destination already has everything on this branch."
          : "No local commits to replay.",
        operation
      ),
    };
  } catch {
    return { lines: formatGitRemoteOperationPreviewLines(null, "", operation) };
  }
}

/**
 * How long the pre-dispatch re-check may spend re-reading the worktree.
 *
 * Deliberately far below main's 30s dispatch deadline. The re-check runs AFTER
 * the human has clicked, so every millisecond it takes is spent against a
 * budget the approval already consumed most of — and the port client's own
 * deadline is generous enough that an unbounded wait could return after main
 * had already failed the call, starting a delete on the strength of an
 * approval the caller was told never landed. An expired re-check is treated as
 * an unread status, which fails closed exactly like a fetch that errored.
 */
const GATE_RECHECK_BUDGET_MS = 5_000;

/**
 * How long after RECEIVING a dispatch the bridge may still start a force
 * delete on the strength of its approval.
 *
 * Not main's deadline itself, and short of it by exactly the re-check budget.
 * Two clocks are involved and the renderer holds the later one: main starts its
 * 30s timer when it queues the dispatch, before a routed send that may first
 * have to thaw an evicted view, so `Date.now() - receivedAt` UNDERSTATES how
 * long main has been waiting by however long that took. Reserving the re-check
 * budget means even a delete that spends its full allowance re-reading the
 * worktree cannot begin later than main's deadline measured from receipt — the
 * unseen send latency is what the remaining margin is for.
 *
 * Refusing early is the safe direction: nothing is deleted, and the caller can
 * ask again. Dispatching late is not — the worktree would be destroyed after
 * the caller was told the call timed out.
 */
const APPROVAL_ACTION_DEADLINE_MS = MAIN_DISPATCH_DEADLINE_MS - GATE_RECHECK_BUDGET_MS;

/**
 * The pre-dispatch re-check, bounded. Resolves to an unverified outcome rather
 * than rejecting or hanging, so the gate below fails closed on a slow read the
 * same way it does on a failed one.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export function recheckWorktreeDeleteOutcome(
  worktreeId: string,
  budgetMs: number = GATE_RECHECK_BUDGET_MS
): Promise<WorktreeDeletePreviewOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<WorktreeDeletePreviewOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ state: "failed", submodules: null }), budgetMs);
  });
  // Clear on the winner either way: the loser of a race stays pending, and a
  // live timer holding the renderer awake for the rest of the budget after the
  // fetch already answered is a handle nobody asked for.
  return Promise.race([
    settleWorktreeDeleteOutcome(buildWorktreeDeletePreview(worktreeId)),
    expired,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Re-derive the gate immediately before an approved force delete executes, and
 * refuse the dispatch when the approval no longer covers it (#12115).
 *
 * The approval a human gave is bound to a snapshot: the tier the fetch found,
 * and the worktree identity they typed. Both can move while the modal is open —
 * an agent writing tracked files turns a D2 delete into a D3 one, and a branch
 * rename moves the attestation target — and `ActionService.dispatch` would
 * otherwise run against whatever is true afterwards. So the gate is re-derived
 * here and compared against what was actually shown and typed.
 *
 * Refusing, rather than re-arming the modal: the confirmation promise has
 * already resolved and its resolver is keyed by `requestId`, so re-prompting
 * means either a second modal for a settled request or a second gate stacked on
 * the bridge's own — the hang that #11909 avoided. A refused call is
 * self-healing instead: the caller re-issues, a fresh modal opens, and this
 * time the fetch puts the typed-name gate up before anyone can approve.
 *
 * Returns `undefined` when the dispatch may proceed. A downgrade never refuses:
 * an approval gated on MORE than the current tier requires is still consent.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export function worktreeDeleteGateRefusal(
  gate: McpWorktreeDeleteGate,
  approvedTypedNameTarget: string | undefined
): ActionDispatchResult | undefined {
  if (gate.state === "unresolvable") {
    return {
      ok: false,
      error: {
        code: "CONFIRMATION_REQUIRED",
        message:
          "Force delete refused: this window cannot resolve the worktree named, so the tier this delete would run at is unknowable and no approval can cover it. Nothing was deleted.",
      },
    };
  }
  if (gate.state === "none") return undefined;
  if (approvedTypedNameTarget === gate.typedNameTarget) return undefined;
  return {
    ok: false,
    error: {
      code: "CONFIRMATION_REQUIRED",
      message: `Force delete refused: the worktree changed while the request was awaiting approval, and deleting it now requires the approver to type '${gate.typedNameTarget}'. Nothing was deleted. The change of state is itself the changed context a fresh call would be retried against, and that call raises the confirmation with the gate.`,
    },
  };
}

/**
 * Pin an approved git dispatch to the cwd the human actually previewed.
 *
 * The preview resolves cwd when the modal opens; `ActionService.dispatch` would
 * otherwise re-resolve live context AFTER the wait, so switching worktrees
 * mid-modal could push a different repository than the one just approved
 * (#8725). Non-git targets are untouched — only these two carry a cwd.
 *
 * A target only exists when the caller named no worktree or named a resolvable
 * one, and `target.cwd` is what that action's own resolver returned — so writing
 * it back can never point the dispatch somewhere the approver did not see.
 * Where the caller named a `worktreeId`, that id still wins in `run()` and
 * resolves to this same path; where it named a path, this is that path. Malformed
 * args produce no target and pass through untouched, for validation to reject
 * rather than being repaired into a valid push.
 */
function withPreviewedGitCwd(args: unknown, target: McpConfirmPreviewTarget | undefined): unknown {
  if (target === undefined || target.kind === "worktreeDelete") return args;
  // The batch kill pins its approval through the dispatch options rather than
  // through args, so there is nothing to rewrite here — and rewriting the id
  // list would hide the excluded targets the action has to report on.
  if (target.kind === "terminalKillBatch") return args;
  if (target.kind === "recipe") {
    // Same rationale as the git cwd pin: the dispatch must act on the recipe the
    // human saw. `getRecipeById` resolves a shadowed id to a different winner,
    // and re-resolving after the modal could land on a different one.
    if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
    return { ...args, recipeId: target.resolvedRecipeId };
  }
  if (args === undefined) return { cwd: target.cwd };
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return { ...args, cwd: target.cwd };
}

/**
 * Which spawn source a dispatch from this session should be stamped with
 * (#11808).
 *
 * `help` and `assistant-pane` are both Daintree's own assistant surfaces — one
 * is the assistant panel, the other a `daintree-assistant` CLI pane — so both
 * read as `"assistant"`. Splitting them apart in the terminal's provenance
 * would classify the implementation surface rather than the actor, and the user
 * question this answers is "did I ask for this run, or did the assistant start
 * it on its own?".
 *
 * Anything else, including an absent origin, is `"mcp"`. That mirrors
 * `SessionStore.getOrigin`'s own fail-closed default: an unknown or torn-down
 * session must never be promoted into one of Daintree's own surfaces, and the
 * safe direction here is to under-claim assistant provenance rather than label
 * an external client's spawn as ours.
 */
function spawnSourceForOrigin(sessionOrigin: McpSessionOrigin | undefined): TerminalSpawnSource {
  return sessionOrigin === "help" || sessionOrigin === "assistant-pane" ? "assistant" : "mcp";
}

/**
 * Stamp the dispatching session's spawn source and `focusPolicy: "preserve"`
 * onto actions that can create panels. `spawnedBy` records provenance — which
 * surface asked for this spawn; `focusPolicy` declares the caller's intent to
 * keep focus where it is (#6959). We override any caller-supplied values
 * because the dispatch source is authoritative — an MCP client cannot claim a
 * different origin or focus policy, and in particular cannot claim to be the
 * assistant.
 *
 * Exported for unit tests; importing modules should not call this directly —
 * the bridge is the only authoritative caller.
 */
export function tagMcpSpawnSource(
  actionId: string,
  args: unknown,
  sessionOrigin?: McpSessionOrigin
): unknown {
  if (!shouldTagMcpSpawn(actionId)) return args;
  const spawnedBy = spawnSourceForOrigin(sessionOrigin);
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return { ...(args as Record<string, unknown>), spawnedBy, focusPolicy: "preserve" };
  }
  if (args === undefined || args === null) {
    return { spawnedBy, focusPolicy: "preserve" };
  }
  return args;
}

/**
 * Sets up the renderer-side MCP bridge.
 *
 * Listens for requests from the main process MCP server and responds
 * with the action manifest or action dispatch results. For actions
 * declared `danger: "confirm"`, intercepts the dispatch to surface a
 * native confirmation modal — only forwards to `actionService.dispatch`
 * after explicit user approval. Rejection or timeout returns a structured
 * error to main without ever invoking the action.
 */
export function useMcpBridge(): void {
  useEffect(() => {
    if (!window.electron?.mcpBridge) return;

    let disposed = false;
    const inFlightConfirms = new Set<string>();

    const cleanupManifest = window.electron.mcpBridge.onGetManifestRequest((requestId) => {
      try {
        const manifest = actionService.list();
        window.electron.mcpBridge.sendGetManifestResponse(requestId, manifest);
      } catch (err) {
        logError("[MCP Bridge] Failed to build manifest", err);
        window.electron.mcpBridge.sendGetManifestResponse(requestId, []);
      }
    });

    const cleanupDispatch = window.electron.mcpBridge.onDispatchActionRequest(
      async ({ requestId, actionId, args, confirmed, context, callerInfo, sessionOrigin }) => {
        // Main started its 30s clock when it sent this; ours starts a beat
        // later, which is the safe direction to be wrong in only for reporting
        // — for the destructive re-check below we compare against it directly.
        const receivedAt = Date.now();
        let confirmationDecision: McpConfirmationDecision | undefined;
        // Declared outside the confirm block so the approved dispatch can pin
        // itself to the previewed cwd. Stays undefined for pre-granted
        // dispatches, which show no modal and so previewed nothing to pin to.
        let previewTarget: McpConfirmPreviewTarget | undefined;
        // What the approver was actually asked to type, if anything (#12115).
        // Set by the same patch that renders the gate, so it is necessarily
        // settled before approval is possible — the modal keeps its confirm
        // button disabled until `setPreview` lands. Compared against a freshly
        // re-derived gate below, which is what binds the approval to the target
        // and the content the human saw rather than to whatever is true after.
        let approvedTypedNameTarget: string | undefined;
        // The per-target half of the same attestation, for a confirmation that
        // offered per-row deselection (#12123). Stays undefined for every other
        // dispatch — including a pre-granted one, which shows no modal and so
        // selected nothing — and an action that needs it refuses on its absence
        // rather than reading "approved" as "approved all of these".
        let hostApprovedTargets: HostApprovedTarget[] | undefined;
        try {
          let effectiveConfirmed = confirmed;

          // A native automation grant pre-authorises the `danger: "confirm"`
          // modal — which is the D2 gate, and only that. It cannot stand in for
          // a D3 one: the grant names a TOOL, issued in Settings ahead of time,
          // with no target, no arguments and no preview in front of the person
          // who issued it. The typed-name gate exists precisely because that
          // class of consent is not enough to discard tracked work or delete a
          // protected worktree irreversibly. So a granted force delete whose
          // LIVE tier comes back D3 gives up its pre-authorisation and asks for
          // the attestation on its own account (#12115).
          if (effectiveConfirmed === true && actionId === "worktree.delete" && forceArg(args)) {
            const grantedTarget = resolveMcpConfirmPreviewTarget(actionId, args, context);
            if (grantedTarget?.kind === "worktreeDelete") {
              const gate = resolveWorktreeDeleteGate(
                grantedTarget,
                await recheckWorktreeDeleteOutcome(grantedTarget.worktreeId)
              );
              if (disposed) return;
              if (gate.state === "required") {
                // Fall through to the modal, which re-derives the same gate
                // from its own fresh fetch and raises the typed-name input.
                effectiveConfirmed = false;
              } else if (gate.state === "unresolvable") {
                // Demoting would only strand the approver: the modal would
                // reach the same unresolvable answer and refuse after the
                // click. Refuse now, while nothing has been asked of anyone.
                const refusal = worktreeDeleteGateRefusal(gate, undefined);
                window.electron.mcpBridge.sendDispatchActionResponse({
                  requestId,
                  result: refusal ?? REJECTION_RESULT,
                  confirmationDecision,
                });
                return;
              }
            }
          }

          if (effectiveConfirmed !== true) {
            // Args-aware: a statically-safe composite carrying a recipeId has
            // an EFFECTIVE confirm tier that `ActionService.dispatch` will
            // enforce. Reading the static danger here would skip the modal,
            // dispatch unconfirmed, and hand the agent a CONFIRMATION_REQUIRED
            // it has no way to satisfy (#11860).
            const definition = actionService.getDispatchMeta(actionId as ActionId, {
              source: "agent",
              args,
            });
            if (definition?.danger === "confirm") {
              inFlightConfirms.add(requestId);
              // Fetch the fresh preview OFF the critical path so the modal
              // appears immediately (never blocked on a git read) and the
              // confirm queue isn't reordered by fetch latency (#11343). While
              // it's in flight the modal keeps approval disabled
              // (previewPending) so the approver can't confirm a destructive
              // dispatch before seeing what it affects. `setPreview` patches the
              // item and re-enables approval when the fetch lands (empty lines
              // when there's nothing to show); a no-op if already resolved.
              previewTarget = resolveMcpConfirmPreviewTarget(actionId, args, context);
              // The checklist kind resolves synchronously below and has no
              // lines to fetch, so it must not arm the pending-preview gate —
              // that would leave its approve button disabled with nothing in
              // flight to ever re-enable it.
              const hasAsyncPreview =
                previewTarget !== undefined && previewTarget.kind !== "terminalKillBatch";
              const previewPending = hasAsyncPreview;
              if (hasAsyncPreview && previewTarget !== undefined) {
                void buildMcpConfirmPreview(previewTarget)
                  .then(({ lines, typedNameTarget }) => {
                    if (disposed) return;
                    approvedTypedNameTarget = typedNameTarget;
                    useMcpConfirmStore.getState().setPreview(requestId, lines, typedNameTarget);
                  })
                  // The builder already fails soft, but a rejection escaping it
                  // would leave previewPending stuck true and the modal
                  // unapprovable — the exact stall class #11538 removes. Clear
                  // it unconditionally.
                  .catch(() => {
                    if (disposed) return;
                    useMcpConfirmStore.getState().setPreview(requestId, []);
                  });
              }
              // Frozen HERE, once, before the modal exists — not rebuilt on
              // render and never appended to. The list the approver reads is
              // the list their approval covers.
              const selectableTargets =
                previewTarget?.kind === "terminalKillBatch"
                  ? buildTerminalKillBatchTargets(previewTarget.terminalIds)
                  : undefined;
              let resolution: McpConfirmResolution;
              try {
                resolution = await requestMcpConfirmation({
                  requestId,
                  actionId,
                  actionTitle: definition.title,
                  actionDescription: definition.description,
                  // Carry the "why this is gated" rationale into the host
                  // confirm dialog so the human sees the same justification the
                  // model does — parity with the removed elicitation prompt,
                  // which used to be the only surface that showed it (#11342).
                  ...(definition.dangerRationale
                    ? { dangerRationale: definition.dangerRationale }
                    : {}),
                  argsSummary: summarizeMcpArgs(args),
                  // Names WHICH worktree/recipe in the title. Resolved from the
                  // renderer's stores, not from the redacted args summary.
                  ...(previewTarget
                    ? (() => {
                        const subject = resolveMcpConfirmSubject(previewTarget);
                        return subject ? { subject } : {};
                      })()
                    : {}),
                  danger: definition.danger,
                  // Display-only requesting-bearer identity (#9157). Present
                  // only for unpinned external dispatch; the dialog renders a
                  // "Requested by" row when set, stays provenance-free when not.
                  callerInfo,
                  // Origin travels with the identity so the dialog can name the
                  // requester positively instead of inferring one from an
                  // absence that has two very different causes.
                  sessionOrigin,
                  previewPending,
                  ...(hasAsyncPreview && previewTarget
                    ? { previewTitle: mcpConfirmPreviewTitle(previewTarget) }
                    : {}),
                  ...(selectableTargets
                    ? {
                        selectableTargets,
                        selectionConfirmLabel: {
                          verb: "Kill",
                          one: "terminal",
                          many: "terminals",
                        },
                      }
                    : {}),
                });
              } finally {
                inFlightConfirms.delete(requestId);
              }
              if (disposed) return;
              const decision = resolution.decision;
              if (decision === "rejected") {
                window.electron.mcpBridge.sendDispatchActionResponse({
                  requestId,
                  result: REJECTION_RESULT,
                  confirmationDecision: "rejected",
                });
                return;
              }
              if (decision === "timeout") {
                window.electron.mcpBridge.sendDispatchActionResponse({
                  requestId,
                  result: TIMEOUT_RESULT,
                  confirmationDecision: "timeout",
                });
                return;
              }
              confirmationDecision = "approved";
              effectiveConfirmed = true;
              if (selectableTargets !== undefined) {
                // Only the rows still checked, each carrying the agent state its
                // row was SHOWING. `run()` re-reads that state live before it
                // destroys anything, so an approval can only ever cover the
                // consequence the approver was actually shown (#12123).
                const approved = new Set(resolution.selectedTargetIds ?? []);
                hostApprovedTargets = selectableTargets
                  .filter((target) => approved.has(target.id))
                  .map((target) => ({ id: target.id, observedAgentRunning: target.agentRunning }));
              }

              // Re-check the gate against LIVE state, immediately before the
              // dispatch runs. The modal's fetch is minutes old by human
              // standards and an agent can write tracked files into the
              // worktree the whole time it is open; without this, a delete that
              // looked D2 when it was previewed executes on the D2 approval it
              // was given. Deliberately a separate step from resolving the
              // modal — the promise is already settled, and folding a live
              // re-fetch into its resolution would make the decision depend on
              // the order two async paths happen to land in.
              if (previewTarget?.kind === "worktreeDelete" && previewTarget.force) {
                const outcome = await recheckWorktreeDeleteOutcome(previewTarget.worktreeId);
                if (disposed) return;
                // Approval near the modal's 28s timeout plus a slow re-read can
                // land after main's 30s deadline, where the agent has already
                // been told the call timed out. Deleting the worktree at that
                // point destroys it behind a reported failure, so the deadline
                // wins over the approval.
                const refusal =
                  Date.now() - receivedAt >= APPROVAL_ACTION_DEADLINE_MS
                    ? EXPIRED_APPROVAL_RESULT
                    : worktreeDeleteGateRefusal(
                        resolveWorktreeDeleteGate(previewTarget, outcome),
                        approvedTypedNameTarget
                      );
                if (refusal !== undefined) {
                  window.electron.mcpBridge.sendDispatchActionResponse({
                    requestId,
                    result: refusal,
                    confirmationDecision,
                  });
                  return;
                }
              }
            }
          }

          const dispatchArgs = tagMcpSpawnSource(
            actionId,
            withPreviewedGitCwd(args, previewTarget),
            sessionOrigin
          );
          const result = await runWithMcpSpawnFocusSuppressed(
            () =>
              actionService.dispatch(actionId as ActionId, dispatchArgs, {
                source: "agent",
                confirmed: effectiveConfirmed,
                // Pinned help-session dispatch carries the provision-time
                // context snapshot; replay it so the action targets the
                // worktree/terminal focused at launch, not wherever focus
                // drifted during the model's turn (#8317). Undefined for
                // unpinned external dispatch — ActionService then falls
                // back to live renderer context, unchanged behaviour.
                contextOverride: context,
                ...(hostApprovedTargets ? { hostApprovedTargets } : {}),
              }),
            actionId
          );
          if (disposed) return;
          window.electron.mcpBridge.sendDispatchActionResponse({
            requestId,
            result,
            confirmationDecision,
          });
        } catch (err) {
          if (disposed) return;
          window.electron.mcpBridge.sendDispatchActionResponse({
            requestId,
            result: {
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: formatErrorMessage(err, "Action dispatch failed"),
              },
            },
            confirmationDecision,
          });
        }
      }
    );

    return () => {
      disposed = true;
      // Drop any modals queued by this bridge so the singleton store doesn't
      // surface dialogs that no listener is left to respond to. Main's 30s
      // dispatch timer still rejects with a generic error — acceptable since
      // unmount only happens at app teardown or HMR.
      const dropFromStore = useMcpConfirmStore.getState().drop;
      for (const requestId of inFlightConfirms) {
        dropFromStore(requestId);
      }
      inFlightConfirms.clear();
      cleanupManifest();
      cleanupDispatch();
    };
  }, []);
}
