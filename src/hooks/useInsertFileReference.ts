import { useCallback } from "react";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { usePanelStore } from "@/store";
import type { BackendStatus } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore, type LastTypedAgentTarget } from "@/store/terminalInputStore";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { resolveRescueTarget } from "@/lib/typeAnywhere";
import { appendFileReference } from "@/panels/file-browser/fileReference";

interface TargetInputs {
  panelsById: Record<string, PanelInstance>;
  panelIds: string[];
  backendStatus: BackendStatus;
  hybridInputEnabled: boolean;
  voiceSubmittingIds: ReadonlySet<string>;
  lastTypedAgentTarget: LastTypedAgentTarget | null;
  armedCount: number;
}

/**
 * The agent this view may insert a reference into, or `null` to refuse.
 *
 * Reuses `resolveRescueTarget` verbatim rather than deriving a second, weaker
 * heuristic: the "recorded target wins, otherwise the sole eligible agent,
 * otherwise refuse" contract (#11147) is exactly right here, and its
 * hybrid-only gate is a feature — this feature writes a hybrid draft and
 * nothing else, so a disabled hybrid bar genuinely has nowhere to put the
 * token.
 *
 * The two guards `useTypeAnywhere` keeps outside the resolver are repeated for
 * the same reasons: a target recorded by a sibling view belongs to that view,
 * and a live fleet broadcast would fan one reference out to every armed agent.
 */
export function resolveInsertTargetId(inputs: TargetInputs): string | null {
  const workspaceId = getViewWorkspaceId();
  if (workspaceId === null) return null;

  // Two armed ids means a real broadcast rather than a preview — the same
  // threshold `tryFleetBroadcastFromEditor` uses.
  if (inputs.armedCount >= 2) return null;

  const recorded = inputs.lastTypedAgentTarget;
  const lastTypedTerminalId =
    recorded !== null && recorded.workspaceId === workspaceId ? recorded.terminalId : null;

  const targetId = resolveRescueTarget({
    panelsById: inputs.panelsById,
    panelIds: inputs.panelIds,
    lastTypedTerminalId,
    voiceSubmittingIds: inputs.voiceSubmittingIds,
    hybridInputEnabled: inputs.hybridInputEnabled,
    isBackendReady: inputs.backendStatus === "connected",
  });
  if (targetId === null) return null;

  const target = inputs.panelsById[targetId];
  return target !== undefined && isPtyPanel(target) ? targetId : null;
}

/**
 * Both receipts go through the same pair: the pill for sighted users, a polite
 * announcement because the pill is `aria-hidden`.
 */
function report(message: string): void {
  useTypingLocatorStore.getState().showLocator(message);
  useAnnouncerStore.getState().announce(message, "polite");
}

function reportRefused(): void {
  report("No agent is available for a file reference");
}

export interface InsertFileReference {
  /** False when nothing resolves — the menu item disables and the shortcut no-ops. */
  canInsert: boolean;
  /** Returns whether the reference was actually written. */
  insert: (absolutePath: string) => boolean;
}

/**
 * Send an `@file` reference to the agent the user was last talking to (#11577).
 *
 * Every file surface that offers this (the file browser, the worktree card's
 * changed-files list, the Review Hub, the diff sidebar) is a sibling of the
 * terminal with no handle on its editor, so the token goes through the draft
 * store — the sanctioned outside-write path that voice transcription and the
 * type-anywhere rescue already use — and `HybridInputBar`'s
 * `externalDraftRevision` effect syncs the mounted document.
 *
 * Deliberately does NOT move focus. The user is mid-flow in the tree and
 * likely to reference several files; pulling focus (or the grid viewport) to
 * the agent would break the run they are in the middle of. The locator pill
 * names the destination instead, which is what makes the write observable.
 */
export function useInsertFileReference(): InsertFileReference {
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const voiceSubmittingPanels = useTerminalInputStore((s) => s.voiceSubmittingPanels);
  const lastTypedAgentTarget = useTerminalInputStore((s) => s.lastTypedAgentTarget);
  const armedCount = useFleetArmingStore((s) => s.armedIds.size);

  // Derived inside the selector so the pane subscribes to one string, not the
  // whole panel map: a live `panelsById` selector here would re-render the file
  // browser on every agent-state flip and status flush.
  const targetId = usePanelStore(
    useCallback(
      (state) =>
        resolveInsertTargetId({
          panelsById: state.panelsById,
          panelIds: state.panelIds,
          backendStatus: state.backendStatus,
          hybridInputEnabled,
          voiceSubmittingIds: voiceSubmittingPanels,
          lastTypedAgentTarget,
          armedCount,
        }),
      [hybridInputEnabled, voiceSubmittingPanels, lastTypedAgentTarget, armedCount]
    )
  );

  const insert = useCallback((absolutePath: string): boolean => {
    if (absolutePath === "") return false;

    // Re-resolved from live state rather than trusting the rendered `targetId`:
    // the menu can sit open while the agent it named exits or locks.
    const panelState = usePanelStore.getState();
    const inputStore = useTerminalInputStore.getState();
    const resolvedId = resolveInsertTargetId({
      panelsById: panelState.panelsById,
      panelIds: panelState.panelIds,
      backendStatus: panelState.backendStatus,
      hybridInputEnabled: inputStore.hybridInputEnabled,
      voiceSubmittingIds: inputStore.voiceSubmittingPanels,
      lastTypedAgentTarget: inputStore.lastTypedAgentTarget,
      armedCount: useFleetArmingStore.getState().armedIds.size,
    });
    const target = resolvedId === null ? undefined : panelState.panelsById[resolvedId];
    if (resolvedId === null || target === undefined) {
      // Only reachable in the race the re-resolve exists for — the rendered
      // gate disables the affordance otherwise. Announcing it beats a dead
      // click, which is by definition something the user cannot observe.
      reportRefused();
      return false;
    }

    // Commit the reference BEFORE any feedback. Everything below is polish —
    // if it throws, the token is already durably in the draft rather than lost
    // (#11147).
    const projectId = useProjectStore.getState().currentProject?.id;
    const draft = inputStore.getDraftInput(resolvedId, projectId);
    // The token is relativized against the TARGET's cwd, not the browser's
    // base path: that is what a drop into this agent would produce, and it is
    // what makes a reference to another worktree stay absolute. `resolveInsertTargetId`
    // already guarantees a pty panel; the narrow is for the type, not a case.
    const targetCwd = isPtyPanel(target) ? (target.cwd ?? "") : "";
    inputStore.setDraftInput(
      resolvedId,
      appendFileReference(draft, absolutePath, targetCwd),
      projectId
    );
    inputStore.bumpExternalDraftRevision();
    // Deliberately not `recordLastTypedAgentTarget`: this is not the user
    // typing into that agent, and recording it would let the file browser
    // silently claim the routing target on the sole-agent fallback path.

    panelState.pingTerminal(resolvedId);
    report(`File reference added to ${getTerminalDisplayTitle(target, "compact")}`);
    return true;
  }, []);

  return { canInsert: targetId !== null, insert };
}
