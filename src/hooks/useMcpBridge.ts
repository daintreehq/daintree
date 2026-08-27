import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { requestMcpConfirmation, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { runWithMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import {
  buildWorktreeDeletePreview,
  formatWorktreeDeletePreviewLines,
} from "@/components/Worktree/worktreeDeletePreview";
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
import type { ActionContext, ActionDispatchResult, ActionId } from "@shared/types/actions";
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
  | { kind: "worktreeDelete"; worktreeId: string }
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
  | { kind: "recipe"; recipeId: string; resolvedRecipeId: string; spawns: boolean };

/** Section heading rendered above each kind's preview lines. */
const PREVIEW_TITLES: Record<McpConfirmPreviewTarget["kind"], string> = {
  worktreeDelete: "Working tree changes",
  gitPush: "Branch and local commits",
  gitPullRebase: "Branch and local commits",
  recipe: "Recipe contents",
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
  if (actionId === "worktree.delete") {
    const worktreeId = worktreeIdArg(args);
    return worktreeId === undefined ? undefined : { kind: "worktreeDelete", worktreeId };
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

/**
 * Build fresh preview lines for a resolved target (#11343, #11538).
 *
 * Never rejects: a fetch failure yields the kind's "couldn't verify" note
 * rather than an empty preview that would imply a clean tree / nothing to push.
 * That keeps approval available with the human explicitly warned — blocking it
 * instead would strand the dispatch until the modal's 28s timeout.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export async function buildMcpConfirmPreview(target: McpConfirmPreviewTarget): Promise<string[]> {
  if (target.kind === "recipe") {
    // Renderer state, so no fetch — but re-read here rather than closing over
    // the resolve-time recipe so the lines reflect the store at modal-open.
    const recipe = useRecipeStore.getState().getRecipeById(target.resolvedRecipeId) ?? null;
    return formatRecipePreviewLines(recipe, {
      agentTerminalCap: MAX_AGENT_RECIPE_TERMINALS,
      spawns: target.spawns,
    });
  }
  if (target.kind === "worktreeDelete") {
    try {
      const preview = await buildWorktreeDeletePreview(target.worktreeId);
      // Monitor gone / already removed → nothing meaningful to preview.
      if (!preview) return [];
      return formatWorktreeDeletePreviewLines(preview);
    } catch {
      return formatWorktreeDeletePreviewLines(null);
    }
  }
  const operation = target.kind === "gitPush" ? "push" : "pull-rebase";
  try {
    const preview = await buildGitRemoteOperationPreview(target.cwd, operation);
    return formatGitRemoteOperationPreviewLines(
      preview,
      target.kind === "gitPush"
        ? "Nothing to publish — the destination already has everything on this branch."
        : "No local commits to replay.",
      operation
    );
  } catch {
    return formatGitRemoteOperationPreviewLines(null, "", operation);
  }
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
        let confirmationDecision: McpConfirmationDecision | undefined;
        // Declared outside the confirm block so the approved dispatch can pin
        // itself to the previewed cwd. Stays undefined for pre-granted
        // dispatches, which show no modal and so previewed nothing to pin to.
        let previewTarget: McpConfirmPreviewTarget | undefined;
        try {
          let effectiveConfirmed = confirmed;

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
              const previewPending = previewTarget !== undefined;
              if (previewTarget !== undefined) {
                void buildMcpConfirmPreview(previewTarget)
                  .then((preview) => {
                    if (disposed) return;
                    useMcpConfirmStore.getState().setPreview(requestId, preview);
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
              let decision: McpConfirmationDecision;
              try {
                decision = await requestMcpConfirmation({
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
                  ...(previewTarget ? { previewTitle: mcpConfirmPreviewTitle(previewTarget) } : {}),
                });
              } finally {
                inFlightConfirms.delete(requestId);
              }
              if (disposed) return;
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
