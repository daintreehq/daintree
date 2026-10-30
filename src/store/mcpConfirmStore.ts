import { create } from "zustand";
import type { ActionDanger } from "@shared/types/actions";
import type {
  McpApprovalReason,
  McpApprovalScope,
  McpBearerIdentity,
  McpConfirmationDecision,
  McpRequester,
  McpSessionOrigin,
} from "@shared/types/ipc/mcpServer";
import { MCP_CONFIRM_DECISION_MS, MCP_DISPATCH_TIMEOUT_MS } from "@shared/config/mcpConfirmWindow";

/**
 * Main's deadline for a dispatch before its view has asked for longer: what a
 * confirmation can count on from the moment the bridge receives it, until main
 * grants a hold (#14989). Past main's deadline main has already failed the
 * dispatch and told the agent it timed out, so nothing on the confirm path may
 * offer approval beyond what main has granted.
 */
export const MAIN_DISPATCH_DEADLINE_MS = MCP_DISPATCH_TIMEOUT_MS;

/**
 * How long before main's deadline the dialog stops offering approval, so an
 * answer given at the last moment still reaches main while it holds the call.
 */
const MAIN_DEADLINE_MARGIN_MS = 2_000;

/**
 * Ask main to hold the dispatch behind a confirmation open for the next phase
 * (#14989). Resolves with the time main granted, measured from when it
 * answered, or null once main no longer holds the call.
 */
export type McpConfirmHold = (phase: "queued" | "shown") => Promise<number | null>;

/** What a confirmation knows about the dispatch deadline it answers to. */
export interface McpConfirmDeadline {
  /** Main's deadline as of the request, on this renderer's clock. */
  deadlineAt: number;
  hold?: McpConfirmHold;
}

/**
 * One pending confirmation surfaced for a `danger: "confirm"` MCP dispatch.
 * Stored in a FIFO queue; only the first item drives the visible modal so
 * concurrent agent calls never stack overlapping dialogs.
 */
export interface PendingMcpConfirm {
  requestId: string;
  actionId: string;
  actionTitle: string;
  actionDescription: string;
  /**
   * The action's `dangerRationale` — the "why this is gated" reasoning the
   * model sees. Surfaced in the confirm dialog so the human approving a
   * destructive MCP call sees the same justification (#11342). Optional: only
   * `danger !== "safe"` actions carry a rationale.
   */
  dangerRationale?: string;
  /**
   * Human-readable name of the thing this dispatch acts on — the worktree's
   * branch or folder name, the recipe's name. Resolved from the renderer's own
   * stores at request time, NEVER by reparsing {@link argsSummary}: that value
   * is already redacted for display and widening it here would leak past the
   * boundary main drew.
   *
   * Absent when no subject can be resolved synchronously. The git actions are
   * the notable case — their branch and destination only exist on the async
   * preview, and a title that changes after the dialog opens is worse than a
   * stable generic one, because a dialog's accessible name is not re-announced.
   */
  subject?: string;
  argsSummary: string;
  /**
   * The dispatched action's registry `danger` classification. Drives the
   * confirm dialog's visual severity — only `"confirm"` renders destructive
   * (red) styling; read-only/safe dispatches must not borrow that weight.
   */
  danger: ActionDanger;
  /**
   * Display-only identity of the external client behind this dispatch (#9157).
   * Present only for unpinned external/api-key dispatch; absent for pinned
   * help-session dispatch (the assistant's own panel is its own context), so
   * the dialog shows a "Requested by" row only for genuine external clients.
   */
  callerInfo?: McpBearerIdentity;
  /**
   * Which class of surface the dispatching session is (#9157 companion).
   * Distinct from {@link callerInfo}, which names *which external client* is
   * asking: an assistant session has no meaningful `callerInfo` and still has
   * an origin.
   *
   * Load-bearing for the requester row. Absent `callerInfo` does NOT imply the
   * in-app assistant — `getBearerInfoForSession` also returns null for a
   * session whose token hash was never registered, so a generic pane token
   * dispatches unpinned with no `callerInfo` and `sessionOrigin: "external"`.
   * Without this field the dialog cannot tell the trusted assistant apart from
   * a caller it failed to identify, and must never label the second as the
   * first.
   */
  sessionOrigin?: McpSessionOrigin;
  /**
   * The pane or Assistant tab that asked (#14992), as main identified it and as
   * this view named it when the request arrived. Absent for every caller main
   * did not identify as one of this machine's own surfaces.
   */
  requester?: McpConfirmRequester;
  /**
   * Fresh, human-readable preview lines describing the ACTUAL content this
   * dispatch would affect — e.g. the changed-file list a `worktree.delete`
   * would discard (#11343). The bridge computes these from a live fetch that
   * runs off the critical path (so the modal opens immediately); the lines are
   * patched in via `setPreview` when the fetch lands. Absent for dispatches
   * with no meaningful preview.
   */
  preview?: string[];
  /**
   * Section heading for {@link preview}. Different dispatches preview different
   * things — a `worktree.delete` shows working-tree changes, a `git.push` shows
   * the target branch and local commits (#11538) — so the heading travels with
   * the lines instead of being hardcoded in the dialog. Absent when there is no
   * preview; the dialog falls back to its original working-tree wording.
   */
  previewTitle?: string;
  /**
   * True while the fresh preview fetch is still in flight (#11343). The modal
   * opens immediately but keeps its approve button disabled until the preview
   * (or a verification-failure note) arrives, so an approver can't confirm a
   * destructive dispatch before seeing what it affects. Cleared by `setPreview`.
   */
  previewPending?: boolean;
  /**
   * The name the approver must type before this dispatch can be approved — the
   * D3 typed-name gate (#12115). Set only for a `force` worktree delete whose
   * effective tier came back D3, and only ever from the renderer's OWN stores:
   * the typed string is a human attestation, so nothing an MCP caller can put
   * in `args` may name it or clear it.
   *
   * Patched in by `setPreview` alongside the lines, because the tier depends on
   * the same fresh fetch. Absent means no gate, which is why the bridge
   * re-derives it immediately before dispatch rather than trusting this value
   * to still be true when the human finally clicks.
   */
  typedNameTarget?: string;
  /**
   * The individually-deselectable targets this dispatch acts on (#12123), for a
   * batch whose approval is per-target rather than all-or-nothing.
   *
   * Resolved once, synchronously, from the renderer's own stores at request
   * time — never patched in later the way {@link preview} is. The list must be
   * frozen before the dialog becomes interactive: a row appearing under a
   * cursor that is already moving toward the confirm button is a click the
   * approver never aimed at that target. Absent for every dispatch whose
   * approval is a single yes/no.
   */
  selectableTargets?: readonly McpConfirmSelectableTarget[];
  /**
   * How the confirm button should name the current selection (#12123). A
   * destructive button that says only "Kill terminals" while three of five rows
   * are unchecked describes a different act from the one about to happen, so the
   * count travels with the list.
   *
   * Three parts rather than a formatted string: the count is not known when the
   * request is enqueued, and it changes on every toggle. Read only when
   * {@link selectableTargets} is present.
   */
  selectionConfirmLabel?: { verb: string; one: string; many: string };
  /**
   * Offer "Allow for this session" beside the ordinary approval (#12692). Set
   * only by main, and only for an agent pane — the one session that can hold
   * the per-tool grant the choice mints.
   */
  offerSessionApproval?: boolean;
  /**
   * Why this dialog is asking (#12692). `above-tier` is an agent pane calling
   * something its project's MCP tier does not cover on its own, which the
   * dialog says in so many words — the action may well be harmless, and the
   * approver needs to know the question is about reach, not danger.
   * `protected-close` is Daintree's own assistant closing panels it did not
   * open or whose agent is mid-task (#12881); the checklist names them.
   */
  approvalReason?: McpApprovalReason;
  /**
   * The worktree a `worktree.delete` would remove, for plugin notes (#13805).
   * Set only for a preview this view builds itself: another machine's call
   * arrives with that machine's lines, notes included. The dialog asks the
   * plugins on its own; nothing here touches `previewPending` or the gate.
   */
  worktreeDeleteNotesTargetId?: string;
  enqueuedAt: number;
  /**
   * Main's deadline for the dispatch, as last granted, on this renderer's clock
   * (#14989). Each grant is anchored to when it was asked for, so this is never
   * later than main's own. Absent for a confirmation nothing in main is timing.
   */
  deadlineAt?: number;
  /**
   * When the request was first current with its view visible: the moment it
   * was on screen to be answered. Unset means nobody could have seen it, which
   * is what makes a timeout `unseen`.
   */
  shownAt?: number;
  /**
   * The end of the decision window, a whole window from {@link shownAt}. Never
   * renewed: time spent queued before it was shown is not charged to it, and a
   * preview landing afterwards does not extend it.
   */
  decisionEndsAt?: number;
  /**
   * The request timed out while it was on screen. It stays up, inert, until
   * dismissed, so a question someone was partway through answering says it
   * expired rather than vanishing; the caller was already told it timed out.
   */
  expired?: true;
}

/**
 * Who asked, for the requester row (#14992).
 *
 * The names are taken once, when the request arrives, so a queued request
 * doesn't change who it says asked while it waits; `identity` is what the
 * dialog re-finds to show the requester. Every name is optional: a pane this
 * view can't find is still a pane main identified, and says so.
 */
export interface McpConfirmRequester {
  identity: McpRequester;
  /** The pane's title as its header shows it, or the Assistant tab's name. */
  name?: string;
  /** The pane's agent or kind ("Claude", "Terminal"), when its title doesn't already say it. */
  kindLabel?: string;
  worktreeId?: string;
  worktreeName?: string;
}

/**
 * One row in a selectable confirmation (#12123).
 *
 * Everything the approver needs to tell one target from another and judge what
 * losing it costs: what it is called, where it lives, what kind of panel it is,
 * and whether something is running in it right now. `agentRunning` is also the
 * state the approval gets bound to — the action re-reads it live before it
 * commits, so a target that was idle here and is working by then is skipped
 * rather than swept into an approval that never described it.
 */
export interface McpConfirmSelectableTarget {
  id: string;
  /** The panel's own title, as the grid and sidebar show it. */
  name: string;
  /** The worktree the panel belongs to, or undefined when it has none. */
  worktree?: string;
  /** Display label for the panel's kind — "Terminal", "Browser", the agent's name. */
  kindLabel: string;
  /** Whether an agent session is mid-work in this panel right now. */
  agentRunning: boolean;
}

/**
 * How a confirmation settled.
 *
 * Deliberately NOT a widening of {@link McpConfirmationDecision}: that type
 * crosses IPC — it is zod-validated in `electron/schemas/ipc.ts` and read by
 * the audit log and the session server — so the selection rides alongside it in
 * a renderer-internal shape instead, and the scalar the wire already carries
 * stays exactly what it was.
 *
 * `selectedTargetIds` is present only for an approved selectable confirmation.
 * The dialog keeps approval disabled while nothing is checked — unchecking
 * every row is Cancel with an extra click — so an empty array here means a
 * caller resolved one directly, and it is carried through as "kept nothing"
 * rather than collapsed into an absent selection.
 */
export interface McpConfirmResolution {
  decision: McpConfirmationDecision;
  selectedTargetIds?: readonly string[];
  /**
   * Present only on an approval of a dialog that offered the session scope
   * (#12692), and `session` only when the user chose it.
   */
  scope?: McpApprovalScope; /**
   * Present only on a timeout of a request whose window was never on screen
   * while it asked: nobody could have answered it, so nothing was declined.
   */
  unseen?: true;
}

interface McpConfirmState {
  queue: PendingMcpConfirm[];
  current: PendingMcpConfirm | null;
}

interface McpConfirmActions {
  enqueue: (item: PendingMcpConfirm) => void;
  setPreview: (requestId: string, preview: string[], typedNameTarget?: string) => void;
  resolveCurrent: (
    decision: McpConfirmationDecision,
    selectedTargetIds?: readonly string[],
    scope?: McpApprovalScope,
    unseen?: boolean
  ) => void;
  /** The current request is on screen: start its decision window (#14989). */
  markShown: (requestId: string) => void;
  /** Main granted a hold: record its deadline (#14989). */
  applyHold: (
    requestId: string,
    phase: "queued" | "shown",
    askedAt: number,
    remainingMs: number | null
  ) => void;
  /**
   * The request's time ran out: tell the caller it timed out. A request that
   * was on screen stays up as expired; one nobody saw just goes.
   */
  expire: (requestId: string) => void;
  /** Close an expired request and move on to the next. */
  dismiss: (requestId: string) => void;
  drop: (requestId: string) => void;
  reset: () => void;
}

/**
 * Module-level resolver map. Promises returned from `requestMcpConfirmation`
 * are keyed by `requestId` UUID — never by `actionId`, since two concurrent
 * confirmations for the same action would otherwise collide and the second
 * would silently overwrite the first.
 *
 * The map lives outside React state because resolvers are functions and
 * Zustand state changes are async-batched; storing them in state would
 * defeat the deterministic enqueue/resolve order.
 */
const resolvers = new Map<string, (resolution: McpConfirmResolution) => void>();

/** Each request's way of asking main for more time, beside its resolver. */
const holds = new Map<string, McpConfirmHold>();

/**
 * Requests whose on-screen grant has landed. Main's grant for being on screen
 * replaces its grant for waiting, so only once it has landed is a waiting
 * reply stale; until then the waiting grant is the best deadline there is.
 */
const shownGrants = new Set<string>();

function forget(requestId: string): void {
  resolvers.delete(requestId);
  holds.delete(requestId);
  shownGrants.delete(requestId);
}

/**
 * The moment a request stops offering approval (#14989): the end of its
 * decision window once it is on screen, and never later than shortly before
 * main's deadline. Undefined while nothing bounds it.
 */
export function confirmationEndsAt(item: PendingMcpConfirm): number | undefined {
  const mainEndsAt =
    item.deadlineAt === undefined ? undefined : item.deadlineAt - MAIN_DEADLINE_MARGIN_MS;
  if (item.decisionEndsAt === undefined) return mainEndsAt;
  return mainEndsAt === undefined ? item.decisionEndsAt : Math.min(item.decisionEndsAt, mainEndsAt);
}

function settle(requestId: string, resolution: McpConfirmResolution): void {
  const resolve = resolvers.get(requestId);
  forget(requestId);
  resolve?.(resolution);
}

function requestHold(requestId: string, phase: "queued" | "shown"): void {
  const hold = holds.get(requestId);
  if (hold === undefined) return;
  const askedAt = Date.now();
  // A failed ask keeps the deadline the request already had, which main is
  // still enforcing; nothing here guesses at a longer one.
  void hold(phase).then(
    (remainingMs) =>
      useMcpConfirmStore.getState().applyHold(requestId, phase, askedAt, remainingMs),
    () => {}
  );
}

function advance(set: (partial: Partial<McpConfirmState>) => void, queue: PendingMcpConfirm[]) {
  // A request whose time ran out while it waited was never on screen. Main has
  // let it go, so it goes unseen rather than opening only to close again.
  const now = Date.now();
  let start = 0;
  for (const item of queue) {
    const endsAt = confirmationEndsAt(item);
    if (endsAt === undefined || endsAt > now) break;
    settle(item.requestId, { decision: "timeout", unseen: true });
    start += 1;
  }
  const [next, ...rest] = queue.slice(start);
  set(next === undefined ? { current: null, queue: [] } : { current: next, queue: rest });
}

export const useMcpConfirmStore = create<McpConfirmState & McpConfirmActions>((set, get) => ({
  queue: [],
  current: null,

  enqueue: (item) => {
    const { current, queue } = get();
    if (current === null) {
      set({ current: item });
    } else {
      set({ queue: [...queue, item] });
    }
  },

  // Attach a late-arriving preview — and the typed-name gate the same fetch
  // decided (#12115) — to an already-enqueued item, clearing its pending flag
  // (#11343). The fresh changed-file fetch runs off the critical
  // path so the modal appears immediately; when it lands we patch the matching
  // item (current or queued) in place and re-enable approval. A no-op if the
  // request already resolved/dropped — the fetch is best-effort and must never
  // resurrect a settled confirmation.
  setPreview: (requestId, preview, typedNameTarget) => {
    // Spread the optional field rather than assigning it unconditionally: a
    // patch that carries no gate must leave the item without one, not stamp an
    // explicit `undefined` that reads the same but serialises differently.
    patchItem(requestId, {
      preview,
      previewPending: false,
      ...(typedNameTarget === undefined ? {} : { typedNameTarget }),
    });
  },

  markShown: (requestId) => {
    const { current } = get();
    if (current?.requestId !== requestId || current.shownAt !== undefined || current.expired) {
      return;
    }
    const shownAt = Date.now();
    // A view coming back after its time ran out (a laptop waking, say) must
    // not count the request as seen before its timeout gets to say otherwise.
    const endsAt = confirmationEndsAt(current);
    if (endsAt !== undefined && endsAt <= shownAt) {
      get().expire(requestId);
      return;
    }
    set({ current: { ...current, shownAt, decisionEndsAt: shownAt + MCP_CONFIRM_DECISION_MS } });
    requestHold(requestId, "shown");
  },

  applyHold: (requestId, phase, askedAt, remainingMs) => {
    if (!resolvers.has(requestId)) return;
    if (remainingMs === null) {
      // Main no longer holds the call, so it can no longer be approved.
      get().expire(requestId);
      return;
    }
    if (phase === "queued" && shownGrants.has(requestId)) return;
    if (phase === "shown") shownGrants.add(requestId);
    patchItem(requestId, { deadlineAt: askedAt + remainingMs });
  },

  expire: (requestId) => {
    const item = findItem(requestId);
    if (item === undefined || !resolvers.has(requestId)) return;
    const unseen = item.shownAt === undefined;
    settle(requestId, { decision: "timeout", ...(unseen ? { unseen: true as const } : {}) });
    const { current, queue } = get();
    if (current?.requestId !== requestId) {
      set({ queue: queue.filter((queued) => queued.requestId !== requestId) });
      return;
    }
    if (unseen) {
      advance(set, queue);
      return;
    }
    set({ current: { ...current, expired: true } });
  },

  dismiss: (requestId) => {
    const { current, queue } = get();
    if (current?.requestId !== requestId || current.expired !== true) return;
    advance(set, queue);
  },

  resolveCurrent: (decision, selectedTargetIds, scope, unseen) => {
    const { current, queue } = get();
    // An expired request was already answered as a timeout; only dismissing it
    // moves the queue on.
    if (current === null || current.expired) return;
    const resolve = resolvers.get(current.requestId);
    forget(current.requestId);
    // Only an approval carries a selection. A rejection or timeout resolved
    // nothing about individual targets, and handing back a stale checkbox state
    // there would let the bridge stamp per-target approvals nobody gave. The
    // session scope is held to the same rule, and additionally to the item
    // having offered it: a caller cannot widen an approval the dialog never
    // put to the user.
    const approved = decision === "approved";
    resolve?.({
      decision,
      ...(approved && selectedTargetIds !== undefined ? { selectedTargetIds } : {}),
      ...(approved && current.offerSessionApproval === true && scope === "session"
        ? { scope: "session" as const }
        : {}),
      ...(decision === "timeout" && unseen === true ? { unseen: true as const } : {}),
    });
    advance(set, queue);
  },

  drop: (requestId) => {
    const { current, queue } = get();
    forget(requestId);
    if (current?.requestId === requestId) {
      advance(set, queue);
      return;
    }
    const filtered = queue.filter((item) => item.requestId !== requestId);
    if (filtered.length !== queue.length) {
      set({ queue: filtered });
    }
  },

  reset: () => {
    resolvers.clear();
    holds.clear();
    shownGrants.clear();
    set({ queue: [], current: null });
  },
}));

function findItem(requestId: string): PendingMcpConfirm | undefined {
  const { current, queue } = useMcpConfirmStore.getState();
  if (current?.requestId === requestId) return current;
  return queue.find((item) => item.requestId === requestId);
}

/** Patch one request in place, current or queued; a no-op once it has gone. */
function patchItem(requestId: string, patch: Partial<PendingMcpConfirm>): void {
  const { current, queue } = useMcpConfirmStore.getState();
  if (current !== null && current.requestId === requestId) {
    useMcpConfirmStore.setState({ current: { ...current, ...patch } });
    return;
  }
  const idx = queue.findIndex((item) => item.requestId === requestId);
  const target = queue[idx];
  if (target === undefined) return;
  const next = [...queue];
  next[idx] = { ...target, ...patch };
  useMcpConfirmStore.setState({ queue: next });
}

/**
 * Push a confirmation request into the queue and return a Promise that
 * resolves with the user's decision, and — for a selectable confirmation — the
 * targets they left checked. The returned Promise never rejects — the
 * renderer's auto-timeout (mirroring main's hard timer) resolves with
 * `"timeout"` so callers can branch on a single discriminated value.
 */
export function requestMcpConfirmation(
  item: Omit<
    PendingMcpConfirm,
    "enqueuedAt" | "deadlineAt" | "shownAt" | "decisionEndsAt" | "expired"
  >,
  deadline?: McpConfirmDeadline
): Promise<McpConfirmResolution> {
  return new Promise((resolve) => {
    if (resolvers.has(item.requestId)) {
      // Replacing a live resolver would orphan the original promise. UUID
      // collisions are vanishingly unlikely in practice, so log and refuse
      // rather than silently drop work; this also lets tests catch misuse.
      console.warn(`[McpConfirmStore] duplicate requestId rejected: ${item.requestId}`);
      resolve({ decision: "rejected" });
      return;
    }
    resolvers.set(item.requestId, resolve);
    if (deadline?.hold) holds.set(item.requestId, deadline.hold);
    useMcpConfirmStore.getState().enqueue({
      ...item,
      enqueuedAt: Date.now(),
      ...(deadline ? { deadlineAt: deadline.deadlineAt } : {}),
    });
    // Held while it waits, whether behind another prompt or in a hidden view:
    // its decision window only starts once it is on screen.
    requestHold(item.requestId, "queued");
  });
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetMcpConfirmStoreForTesting(): void {
  useMcpConfirmStore.getState().reset();
}
