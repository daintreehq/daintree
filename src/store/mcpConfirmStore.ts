import { create } from "zustand";
import type { ActionDanger } from "@shared/types/actions";
import type {
  McpBearerIdentity,
  McpConfirmationDecision,
  McpSessionOrigin,
} from "@shared/types/ipc/mcpServer";

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
  enqueuedAt: number;
}

interface McpConfirmState {
  queue: PendingMcpConfirm[];
  current: PendingMcpConfirm | null;
}

interface McpConfirmActions {
  enqueue: (item: PendingMcpConfirm) => void;
  setPreview: (requestId: string, preview: string[], typedNameTarget?: string) => void;
  resolveCurrent: (decision: McpConfirmationDecision) => void;
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
const resolvers = new Map<string, (decision: McpConfirmationDecision) => void>();

function advance(set: (partial: Partial<McpConfirmState>) => void, queue: PendingMcpConfirm[]) {
  if (queue.length === 0) {
    set({ current: null, queue: [] });
    return;
  }
  const [next, ...rest] = queue;
  set({ current: next, queue: rest });
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
    const { current, queue } = get();
    // Spread the optional field rather than assigning it unconditionally: a
    // patch that carries no gate must leave the item without one, not stamp an
    // explicit `undefined` that reads the same but serialises differently.
    const patch = {
      preview,
      previewPending: false,
      ...(typedNameTarget === undefined ? {} : { typedNameTarget }),
    };
    if (current !== null && current.requestId === requestId) {
      set({ current: { ...current, ...patch } });
      return;
    }
    const idx = queue.findIndex((item) => item.requestId === requestId);
    const target = queue[idx];
    if (target === undefined) return;
    const next = [...queue];
    next[idx] = { ...target, ...patch };
    set({ queue: next });
  },

  resolveCurrent: (decision) => {
    const { current, queue } = get();
    if (current === null) return;
    const resolve = resolvers.get(current.requestId);
    resolvers.delete(current.requestId);
    resolve?.(decision);
    advance(set, queue);
  },

  drop: (requestId) => {
    const { current, queue } = get();
    resolvers.delete(requestId);
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
    set({ queue: [], current: null });
  },
}));

/**
 * Push a confirmation request into the queue and return a Promise that
 * resolves with the user's decision. The returned Promise never rejects —
 * the renderer's auto-timeout (mirroring main's hard timer) resolves with
 * `"timeout"` so callers can branch on a single discriminated value.
 */
export function requestMcpConfirmation(
  item: Omit<PendingMcpConfirm, "enqueuedAt">
): Promise<McpConfirmationDecision> {
  return new Promise((resolve) => {
    if (resolvers.has(item.requestId)) {
      // Replacing a live resolver would orphan the original promise. UUID
      // collisions are vanishingly unlikely in practice, so log and refuse
      // rather than silently drop work; this also lets tests catch misuse.
      console.warn(`[McpConfirmStore] duplicate requestId rejected: ${item.requestId}`);
      resolve("rejected");
      return;
    }
    resolvers.set(item.requestId, resolve);
    useMcpConfirmStore.getState().enqueue({ ...item, enqueuedAt: Date.now() });
  });
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetMcpConfirmStoreForTesting(): void {
  useMcpConfirmStore.getState().reset();
}
