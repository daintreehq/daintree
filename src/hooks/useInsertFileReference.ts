import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { usePanelStore } from "@/store";
import type { BackendStatus, PanelGridState } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore, type LastTypedAgentTarget } from "@/store/terminalInputStore";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { isRescueTargetRoutable } from "@/lib/typeAnywhere";
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
 * Why this view cannot insert a reference right now.
 *
 * One code per gate rather than a single "refused": the same greyed item used
 * to mean "you haven't typed to an agent yet", "your fleet is armed" and "your
 * agent is docked", and the menu could say none of it (#12207). Codes, not
 * copy — the wording belongs to the surface that renders it.
 */
export type InsertFileReferenceRefusalReason =
  | "workspace-unavailable"
  | "fleet-broadcast-armed"
  | "hybrid-input-disabled"
  | "backend-unavailable"
  | "recorded-target-unavailable"
  | "no-eligible-agent"
  | "multiple-eligible-agents";

/** A resolved agent, or the reason there isn't one. Never both, never neither. */
export type InsertTargetResolution =
  { targetId: string; reason: null } | { targetId: null; reason: InsertFileReferenceRefusalReason };

function refuse(reason: InsertFileReferenceRefusalReason): InsertTargetResolution {
  return { targetId: null, reason };
}

/**
 * The agent this view may insert a reference into, or the reason it may not.
 *
 * Applies `resolveRescueTarget`'s contract rather than deriving a second,
 * weaker heuristic: "recorded target wins, otherwise the sole eligible agent,
 * otherwise refuse" (#11147) is exactly right here, and its hybrid-only gate is
 * a feature — this feature writes a hybrid draft and nothing else, so a
 * disabled hybrid bar genuinely has nowhere to put the token. The per-panel
 * half is literally shared, via `isRescueTargetRoutable`, so the two paths
 * cannot drift on what counts as an available agent.
 *
 * It walks the gates itself rather than calling `resolveRescueTarget` and
 * classifying its `null` afterwards: one walk cannot disagree with itself,
 * whereas a second pass looking for a reason could name a gate the first pass
 * never reached.
 *
 * The two guards `useTypeAnywhere` keeps outside the resolver are repeated for
 * the same reasons: a target recorded by a sibling view belongs to that view,
 * and a live fleet broadcast would fan one reference out to every armed agent.
 */
export function resolveInsertTarget(inputs: TargetInputs): InsertTargetResolution {
  const workspaceId = getViewWorkspaceId();
  if (workspaceId === null) return refuse("workspace-unavailable");

  // Two armed ids means a real broadcast rather than a preview — the same
  // threshold `tryFleetBroadcastFromEditor` uses.
  if (inputs.armedCount >= 2) return refuse("fleet-broadcast-armed");

  // Both of these disable every agent's editor at once, so there is no target
  // worth resolving — the same pair, in the same order, `resolveRescueTarget`
  // opens with.
  if (!inputs.hybridInputEnabled) return refuse("hybrid-input-disabled");
  if (inputs.backendStatus !== "connected") return refuse("backend-unavailable");

  const recorded = inputs.lastTypedAgentTarget;
  const lastTypedTerminalId =
    recorded !== null && recorded.workspaceId === workspaceId ? recorded.terminalId : null;

  if (lastTypedTerminalId !== null) {
    // Refuse rather than fall through: routing to a different agent would send
    // the reference somewhere the user never chose.
    return isRescueTargetRoutable(inputs, lastTypedTerminalId)
      ? { targetId: lastTypedTerminalId, reason: null }
      : refuse("recorded-target-unavailable");
  }

  // Stops at the second candidate — by then the answer is "ambiguous"
  // regardless of what follows.
  let sole: string | null = null;
  for (const id of inputs.panelIds) {
    if (!isRescueTargetRoutable(inputs, id)) continue;
    if (sole !== null) return refuse("multiple-eligible-agents");
    sole = id;
  }
  // `isRescueTargetRoutable` already requires a live agent PTY panel in the
  // grid, so a docked-only workspace lands here too.
  return sole === null ? refuse("no-eligible-agent") : { targetId: sole, reason: null };
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

/**
 * Discriminated on `canInsert` so "disabled with no reason" — the very state
 * #12207 is about — cannot be constructed. Consumers that only ever wanted the
 * boolean (`FileTreeView`'s Cmd+I gate) keep destructuring it and ignoring the
 * rest.
 */
export type InsertFileReference = {
  /** Returns whether the reference was actually written. */
  insert: (absolutePath: string) => boolean;
} & (
  | { canInsert: true; refusalReason: null }
  /** Nothing resolves: the menu item disables, the shortcut no-ops, and the
   * reason is what the row shows instead. */
  | { canInsert: false; refusalReason: InsertFileReferenceRefusalReason }
);

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

  // Derived inside the selector so the pane subscribes to the verdict, not the
  // whole panel map: a live `panelsById` selector here would re-render the file
  // browser on every agent-state flip and status flush. `useShallow` is what
  // keeps that true now the verdict is a pair — both halves are primitives, so
  // an unchanged verdict keeps its object identity and re-renders nothing.
  const selectResolution = useCallback(
    (state: PanelGridState): InsertTargetResolution =>
      resolveInsertTarget({
        panelsById: state.panelsById,
        panelIds: state.panelIds,
        backendStatus: state.backendStatus,
        hybridInputEnabled,
        voiceSubmittingIds: voiceSubmittingPanels,
        lastTypedAgentTarget,
        armedCount,
      }),
    [hybridInputEnabled, voiceSubmittingPanels, lastTypedAgentTarget, armedCount]
  );
  const resolution = usePanelStore(useShallow(selectResolution));

  const insert = useCallback((absolutePath: string): boolean => {
    if (absolutePath === "") return false;

    // Re-resolved from live state rather than trusting the rendered `targetId`:
    // the menu can sit open while the agent it named exits or locks.
    const panelState = usePanelStore.getState();
    const inputStore = useTerminalInputStore.getState();
    const { targetId: resolvedId } = resolveInsertTarget({
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
    // what makes a reference to another worktree stay absolute. `resolveInsertTarget`
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

  // Rebuilt as the discriminated pair rather than spread: `targetId !== null`
  // and `reason === null` are the same fact, and TypeScript will not infer that
  // from the resolution object alone.
  return resolution.reason === null
    ? { canInsert: true, refusalReason: null, insert }
    : { canInsert: false, refusalReason: resolution.reason, insert };
}
