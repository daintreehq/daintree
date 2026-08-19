import { useCallback, useRef, type RefObject } from "react";
import { isPtyPanel, type PanelWorktreeMoveNotice } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { actionService } from "@/services/ActionService";
import { buildWorktreeMoveInstruction } from "@/services/terminal/worktreeMoveInstruction";
import type { HybridInputBarHandle } from "./HybridInputBar";

/**
 * How this pane can put the instruction in front of its agent right now.
 *
 * `blocked` is not the same as `direct`. The bar being absent is a setting; the
 * bar being unusable is a backend that is disconnected, recovering, restarting,
 * or an input lock — and submitting behind any of those is the silent loss this
 * exists to end. Collapsing the two would route around every one of them.
 */
export type WorktreeMoveDeliveryRoute = "hybrid" | "direct" | "blocked";

export interface WorktreeMoveBanner {
  /** True while this pane has an unanswered cross-worktree move prompt. */
  visible: boolean;
  /**
   * Destination path as it resolves right now, or `undefined` when the
   * worktree has since gone. `undefined` drops the tell affordance entirely —
   * there is no fallback path, because guessing one is how a destructive
   * default gets shipped (#7880).
   */
  destinationPath: string | undefined;
  /** True once a tell has been tried and the terminal did not take it. */
  deliveryFailed: boolean;
  /** Send the instruction, and hide the bar only if the terminal took it. */
  tell: () => Promise<void>;
  /** Hide the bar. Nothing is sent and nothing is recorded. */
  dismiss: () => void;
}

/** The destination's path as it is *now* — never as it was when rendered. */
function readWorktreePath(worktreeId: string): string | undefined {
  const path = getCurrentViewStoreOrNull()?.getState().worktrees.get(worktreeId)?.path;
  return path?.trim() ? path : undefined;
}

function readNotice(panelId: string): PanelWorktreeMoveNotice | undefined {
  const panel = usePanelStore.getState().panelsById[panelId];
  return panel && isPtyPanel(panel) ? panel.worktreeMoveNotice : undefined;
}

/**
 * Owns the "agent may still be in the original worktree" banner for one pane
 * (#11853).
 *
 * Reads and writes the panel store rather than component state for the same
 * reason `useSessionLostBanner` does: the grid renders only the active
 * worktree's panels, so switching worktrees unmounts this pane outright and a
 * local answer would be lost on the way back — and this bar exists precisely to
 * be found later, on a pane the user was not looking at when they dropped it.
 *
 * Both outcomes clear the same field. There is deliberately no "was it told"
 * flag: compliance is undetectable, `panel.cwd` still names the source worktree
 * even after the agent moves over completely, and any marker that outlives the
 * click would sit lit forever on total success. `deliveryFailed` is a different
 * claim — not "did the agent comply" but "did the terminal accept the text",
 * which is the one thing the submit layer can actually answer (#11867).
 */
export function useWorktreeMoveBanner(
  panelId: string,
  options: {
    route: WorktreeMoveDeliveryRoute;
    inputBarRef: RefObject<HybridInputBarHandle | null>;
  }
): WorktreeMoveBanner {
  const { route, inputBarRef } = options;

  // The whole notice, not just its id: its object identity is the attempt
  // generation. `setWorktreeMoveNotice` only replaces it when something
  // actually changed, so the reference is stable enough to select directly.
  const notice = usePanelStore((state) => {
    const panel = state.panelsById[panelId];
    return panel && isPtyPanel(panel) ? panel.worktreeMoveNotice : undefined;
  });

  const destinationPath = useWorktreeStore((state) =>
    notice ? state.worktrees.get(notice.destinationWorktreeId)?.path : undefined
  );

  const setWorktreeMoveNotice = usePanelStore((state) => state.setWorktreeMoveNotice);
  const inFlightRef = useRef(false);

  const dismiss = useCallback(
    () => setWorktreeMoveNotice(panelId, undefined),
    [setWorktreeMoveNotice, panelId]
  );

  const tell = useCallback(async () => {
    if (inFlightRef.current) return;

    // Read through, not off the render: a second move can land between the
    // paint and the click, and the notice captured here is the one this
    // attempt is allowed to answer.
    const attempt = readNotice(panelId);
    if (!attempt) return;
    const path = readWorktreePath(attempt.destinationWorktreeId);
    if (!path) return;

    /**
     * The one delivery path, shared by both routes (#11867) — the same action
     * the MCP surface uses, with no agent-state gate in front of it.
     *
     * Re-checks identity immediately before dispatching as well as after.
     * Resolving `@diff` in the user's draft is a round trip to git, so the
     * destination can move, or the notice be answered, between the click and
     * the moment there is actually something to send.
     */
    const submit = async (command: string): Promise<boolean> => {
      if (readNotice(panelId) !== attempt) return false;
      if (readWorktreePath(attempt.destinationWorktreeId) !== path) return false;
      const result = await actionService.dispatch(
        "terminal.sendCommand",
        { terminalId: panelId, command },
        { source: "user" }
      );
      return result.ok;
    };

    inFlightRef.current = true;
    let delivered = false;
    try {
      if (route === "hybrid") {
        const instruction = buildWorktreeMoveInstruction(path);
        // No fall-through to the direct route on a `false`. A bar that refused
        // may still have got as far as the terminal, and a second send would
        // put the sentence in twice; leaving the bar up costs one more click
        // and cannot duplicate anything.
        delivered =
          (await inputBarRef.current?.submitWithInstruction(instruction, submit)) ?? false;
      } else if (route === "direct") {
        delivered = await submit(buildWorktreeMoveInstruction(path));
      }
    } finally {
      inFlightRef.current = false;
    }

    // A move, a dismiss, or another pane's answer while this was in flight owns
    // the field now. Late results do not get to overwrite them.
    if (readNotice(panelId) !== attempt) return;
    setWorktreeMoveNotice(panelId, delivered ? undefined : { ...attempt, deliveryFailed: true });
  }, [panelId, route, inputBarRef, setWorktreeMoveNotice]);

  return {
    visible: notice !== undefined,
    destinationPath: destinationPath?.trim() ? destinationPath : undefined,
    deliveryFailed: notice?.deliveryFailed === true,
    tell,
    dismiss,
  };
}
