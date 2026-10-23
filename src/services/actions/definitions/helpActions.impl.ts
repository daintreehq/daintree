// The help actions' run bodies, loaded on first dispatch by `runHelpAction` in
// helpActions.ts, which keeps the metadata every view registers at boot (#14271).
// Nothing here may import helpActions.ts at runtime.
import type { ActionCallbacks } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { notify } from "@/lib/notify";
import { currentHostId, getHostPlatformInfo, isRemoteWindow } from "@/hooks/useHostPlatform";
import { actionService } from "@/services/ActionService";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useFocusStore } from "@/store/focusStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import {
  notifyLaunchFailed,
  LAUNCH_BLOCKED_LOADING,
  LAUNCH_BLOCKED_NO_WORKSPACE,
} from "@/controllers/LaunchNotifications";
import { logError } from "@/utils/logger";
import { extractHelpSessionErrorCode } from "@/utils/clientHelpSessionError";
import { getDefaultAgentId } from "@/lib/resolveAgentId";
import { loadCustomLaunchFlags } from "@/lib/assistantLaunchFlags";
import { ensureHelpPanelRuntime } from "@/lib/helpPanelRuntimeGate";
import { requestTour } from "@/components/Tour/tourRequests";
import { readTourStatus, tourCandidates } from "@/components/Tour/tourStatus";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import {
  ASSISTANT_SLOTS,
  MAX_ASSISTANT_SLOTS,
  assistantSlotKey,
  isValidAssistantSlot,
  projectIdFromSlotKey,
} from "@shared/config/assistantSlots";
import {
  getAssistantSupportedAgentIds,
  getAssistantWiredAgentIds,
} from "@shared/config/agentRegistry";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import {
  HELP_ASSISTANT_GREETING,
  HUB_STARTED_ASSISTANT_GREETING,
} from "@shared/config/helpAssistantGreeting";
import { buildResumeCommand } from "@shared/types";
import { isPtyPanel } from "@shared/types/panel";
import { usePaletteStore } from "@/store/paletteStore";
import type { HelpSessionController } from "@/controllers/HelpSessionController";
import type { HelpLaunchSnapshot } from "./helpLaunchSnapshot";

type HelpPanelState = ReturnType<typeof useHelpPanelStore.getState>;

// Slots an in-flight help launch has chosen but not yet bound. Provisioning a
// slot displaces whatever holds it, so a second launch picking the same slot
// before the first binds would kill the first. Module state is per V8 context,
// i.e. per project view — the same scope as the store these slots index.
const claimedHelpLaneKeys = new Set<string>();

function isHeldHelpSlot(state: HelpPanelState, workspaceId: string, slot: number): boolean {
  const key = assistantSlotKey(workspaceId, slot);
  return key in state.hibernateSessions || claimedHelpLaneKeys.has(key);
}

// A lane is free only when nothing could be lost by launching into it: no
// terminal (live or reserved), no provisioned session, no hibernated
// conversation waiting to resume there, and no other help launch heading for
// it. A live lane mirrors its resume token into `hibernateSessions` too, so the
// hibernation check also covers it.
function isFreeHelpLane(state: HelpPanelState, workspaceId: string, slot: number): boolean {
  const lane = state.sessions[slot];
  return (
    !!lane &&
    lane.terminalId === null &&
    lane.sessionId === null &&
    !isHeldHelpSlot(state, workspaceId, slot)
  );
}

/**
 * The lane `help.launchAgent` may launch into without displacing anything
 * (#13192): the active tab if it is free, else another free tab, else a slot
 * no tab occupies yet (`isNew`). Null when every slot holds a session.
 * `isKept` marks further slots as taken — ones main still keeps a conversation
 * for that this view's store doesn't know about yet.
 */
function pickHelpLaunchLane(
  state: HelpPanelState,
  workspaceId: string,
  isKept: (slot: number) => boolean = () => false
): { slot: number; isNew: boolean } | null {
  const isFree = (slot: number) => isFreeHelpLane(state, workspaceId, slot) && !isKept(slot);
  if (isFree(state.activeSlot)) {
    return { slot: state.activeSlot, isNew: false };
  }
  for (const slot of ASSISTANT_SLOTS) {
    if (isFree(slot)) return { slot, isNew: false };
  }
  for (const slot of ASSISTANT_SLOTS) {
    if (!state.sessions[slot] && !isHeldHelpSlot(state, workspaceId, slot) && !isKept(slot)) {
      return { slot, isNew: true };
    }
  }
  return null;
}

/**
 * Exactly `slot`, when launching there displaces nothing (#13392): a caller
 * that picked the slot against the host's own list of running assistants, which
 * this view's tabs may not show, names it rather than letting the view choose.
 */
function exactHelpLaunchLane(
  state: HelpPanelState,
  workspaceId: string,
  slot: number
): { slot: number; isNew: boolean } | null {
  if (isFreeHelpLane(state, workspaceId, slot)) return { slot, isNew: false };
  if (!state.sessions[slot] && !isHeldHelpSlot(state, workspaceId, slot)) {
    return { slot, isNew: true };
  }
  return null;
}

/**
 * A lane this view still shows bound to an assistant, for a caller that
 * refuses to displace one (#13392). After its host restarted with the link
 * down, the exit never arrived and the lane stays taken by a terminal that is
 * gone; only main can say so. It provisions the lane only when the host runs
 * no assistant there, and refuses otherwise, so the binding is let go only on
 * that answer.
 */
function staleHelpLaunchLane(
  state: HelpPanelState,
  workspaceId: string,
  slot: number
): {
  slot: number;
  isNew: false;
  stale: { terminalId: string | null; sessionId: string | null };
} | null {
  const lane = state.sessions[slot];
  if (!lane || (lane.terminalId === null && lane.sessionId === null)) return null;
  // Another launch heading for it owns it.
  if (claimedHelpLaneKeys.has(assistantSlotKey(workspaceId, slot))) return null;
  return {
    slot,
    isNew: false,
    stale: { terminalId: lane.terminalId, sessionId: lane.sessionId },
  };
}

/**
 * Let go of a stale lane's binding once main has provisioned the lane, which it
 * does only when the host runs no assistant there: what the view still shows
 * went with its host. Done in the same step as the new terminal binds, so the
 * lane is never empty for its own controller to launch into meanwhile, and only
 * while the lane still holds what was found: anything that bound it since owns
 * it, and the launch gives way. The pane goes without a kill being sent; the
 * view drops its copy of the old resume token, as a view loaded afresh would
 * never have had it.
 */
function releaseStaleHelpLane(
  workspaceId: string,
  slot: number,
  stale: { terminalId: string | null; sessionId: string | null }
): void {
  const state = useHelpPanelStore.getState();
  const current = state.sessions[slot];
  if (
    !current ||
    current.terminalId !== stale.terminalId ||
    current.sessionId !== stale.sessionId
  ) {
    return;
  }
  if (stale.sessionId) {
    window.electron.help.revokeSession(stale.sessionId).catch((err) => {
      logError("Failed to revoke a help session its host had already ended", err);
    });
  }
  if (stale.terminalId) {
    usePanelStore.getState().removePanel(stale.terminalId, { backendAlreadyClosed: true });
  }
  state.clearTerminal(slot);
  state.clearHibernateSession(workspaceId, slot);
}

/**
 * The agent another lane of this workspace is running or will resume with —
 * evidence that this machine runs it, for a help launch whose default can't be
 * resolved yet (a host's cold view before CLI availability arrives). Lanes on
 * different agents run in directories of their own, so a resolved default
 * always wins over it. A live lane proves its agent launches; a hibernated one
 * only counts while the assistant can still run it, since a missing CLI or a
 * retired agent wouldn't.
 */
function siblingLaneAgentId(
  state: HelpPanelState,
  workspaceId: string,
  slot: number,
  canLaunch: (agentId: string) => boolean
): string | null {
  const liveSlots = [state.activeSlot, ...ASSISTANT_SLOTS].filter((n) => n !== slot);
  for (const n of liveSlots) {
    const lane = state.sessions[n];
    if (lane?.terminalId && lane.agentId) return lane.agentId;
  }
  const ownKey = assistantSlotKey(workspaceId, slot);
  for (const [key, entry] of Object.entries(state.hibernateSessions)) {
    if (
      key !== ownKey &&
      projectIdFromSlotKey(key) === workspaceId &&
      entry.agentId &&
      canLaunch(entry.agentId)
    ) {
      return entry.agentId;
    }
  }
  return null;
}

/**
 * The agents main kept to resume this workspace's lanes, by slot. A view that
 * came up cold has none of them in its store (a host's background view after
 * the host restarted), and its default can be a CLI that machine never runs,
 * started in the very folder the project's assistant used.
 */
async function readKeptLaneAgents(workspaceId: string): Promise<Map<number, string>> {
  const kept = new Map<number, string>();
  const help = window.electron.help;
  try {
    for (const slot of (await help.listPendingHibernationSlots?.(workspaceId)) ?? []) {
      const entry = await help.peekPendingHibernation?.(workspaceId, slot);
      if (entry?.agentId) kept.set(slot, entry.agentId);
    }
  } catch (err) {
    logError("Couldn't read the agents kept for this project's assistant lanes", err);
  }
  return kept;
}

/** The lane's own kept agent, else another lane's: like a hibernated sibling's, only one the assistant can still run. */
function keptLaneAgentId(
  kept: ReadonlyMap<number, string>,
  slot: number,
  canLaunch: (agentId: string) => boolean
): string | null {
  const own = kept.get(slot);
  if (own && canLaunch(own)) return own;
  for (const [other, agentId] of kept) {
    if (other !== slot && canLaunch(agentId)) return agentId;
  }
  return null;
}

/**
 * Backstop for a picked resume's lane claim when its launch never settles —
 * longer than the controller's own launch watchdog, which reaps a hung launch
 * first, so the claim never lapses under a launch that is still running.
 */
const LANE_CLAIM_MAX_HOLD_MS = 120_000;

/** How the past-session picker's pick went — the picker acts on `lanes-full`. */
export type HelpPastSessionPickOutcome = "focused" | "resumed" | "lanes-full" | "unavailable";

/**
 * The lane already holding this conversation: a live lane whose terminal was
 * launched with or resumed into it, or a lane whose captured resume entry is
 * it. Resuming it a second time would put one transcript behind two tabs.
 */
function laneHoldingSession(
  state: HelpPanelState,
  workspaceId: string,
  sessionId: string
): { slot: number; live: boolean } | null {
  const wanted = sessionId.toLowerCase();
  const panels = usePanelStore.getState().panelsById;
  for (const slot of ASSISTANT_SLOTS) {
    const terminalId = state.sessions[slot]?.terminalId;
    const panel = terminalId ? panels[terminalId] : undefined;
    const held = panel && isPtyPanel(panel) ? panel.agentSessionId : undefined;
    if (held && held.toLowerCase() === wanted) return { slot, live: true };
  }
  for (const slot of ASSISTANT_SLOTS) {
    if (state.sessions[slot]?.terminalId) continue;
    const entry = state.hibernateSessions[assistantSlotKey(workspaceId, slot)];
    if (entry?.sessionId && entry.sessionId.toLowerCase() === wanted) {
      return { slot, live: false };
    }
  }
  return null;
}

/**
 * Hold a lane's claim until the launch aimed at it has settled — bound, failed
 * or abandoned — so no other help launch picks the same lane in between and
 * displaces it. Bounded: a launch that never starts can't hold it forever.
 */
function holdLaneClaimUntilSettled(
  controller: Pick<HelpSessionController, "getSnapshot" | "subscribe">,
  claimKey: string
): void {
  let started = false;
  let unsubscribe: (() => void) | null = null;
  const release = () => {
    clearTimeout(timer);
    unsubscribe?.();
    claimedHelpLaneKeys.delete(claimKey);
  };
  const timer = setTimeout(release, LANE_CLAIM_MAX_HOLD_MS);
  const check = () => {
    const phase = controller.getSnapshot().phase;
    if (phase !== "idle" && phase !== "live") {
      started = true;
      return;
    }
    if (started) release();
  };
  unsubscribe = controller.subscribe(check);
  check();
}

function revealHelpLane(slot: number): void {
  const store = useHelpPanelStore.getState();
  useFocusStore.getState().clearAssistantGesture();
  store.setActiveSlot(slot);
  if (!store.isOpen) {
    suppressSidebarResizes();
    store.setOpen(true);
  }
  store.requestFocus();
}

async function resumeHelpPastSession(args: {
  agentId: string;
  sessionId: string;
  slot?: number;
}): Promise<{ outcome: HelpPastSessionPickOutcome }> {
  const projectState = useProjectStore.getState();
  const workspace = projectState.currentProject ?? useScratchStore.getState().currentScratch;
  if (!workspace) {
    notifyLaunchFailed(
      args.agentId,
      projectState.isBootstrapped ? LAUNCH_BLOCKED_NO_WORKSPACE : LAUNCH_BLOCKED_LOADING
    );
    return { outcome: "unavailable" };
  }
  // Exact id or nothing (#11052): the picker must never open "the latest
  // conversation in this folder" in place of the one the user chose.
  if (!buildResumeCommand(args.agentId, args.sessionId)) {
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Couldn't resume session",
      message: `${args.agentId} can't reopen a conversation by its id.`,
    });
    return { outcome: "unavailable" };
  }
  await ensureHelpPanelRuntime();
  const state = useHelpPanelStore.getState();

  const holding = laneHoldingSession(state, workspace.id, args.sessionId);
  if (holding?.live) {
    revealHelpLane(holding.slot);
    return { outcome: "focused" };
  }

  let target: { slot: number; isNew: boolean } | null;
  if (args.slot !== undefined) {
    // The user named the lane to replace, so it is the target even though it
    // is busy. It must still exist: a lane closed while the chooser was open
    // is not one they agreed to give up.
    if (!isValidAssistantSlot(args.slot) || !state.sessions[args.slot]) {
      return { outcome: "lanes-full" };
    }
    target = { slot: args.slot, isNew: false };
  } else if (holding) {
    // The conversation's own captured lane: resuming it there is what that
    // lane was waiting to do anyway.
    target = { slot: holding.slot, isNew: !state.sessions[holding.slot] };
  } else {
    target = pickHelpLaunchLane(state, workspace.id);
  }
  if (!target) return { outcome: "lanes-full" };

  const claimKey = assistantSlotKey(workspace.id, target.slot);
  if (claimedHelpLaneKeys.has(claimKey)) return { outcome: "lanes-full" };

  claimedHelpLaneKeys.add(claimKey);
  let controller: HelpSessionController;
  try {
    // The controller lives in the panel's lazy chunk; HelpPanel is normally
    // mounted by now, so this resolves from cache.
    const { acquireHelpSessionController } =
      await import("@/controllers/helpSessionControllerRegistry");
    controller = acquireHelpSessionController(target.slot);
  } catch (err) {
    claimedHelpLaneKeys.delete(claimKey);
    logError("Failed to load the assistant to resume a past session", err);
    return { outcome: "unavailable" };
  }
  // A tab still starting its own session would drop this launch on its
  // re-entrancy guard; say so rather than report a resume that never happens.
  const phase = controller.getSnapshot().phase;
  if (phase !== "idle" && phase !== "live") {
    claimedHelpLaneKeys.delete(claimKey);
    notify({
      type: "warning",
      title: "Assistant tab is busy",
      message: "That tab is still starting a session. Try again once it's ready.",
      priority: "high",
      context: { eventKind: "uiFeedback" },
    });
    return { outcome: "unavailable" };
  }
  // Resuming a conversation is its own choice of agent: a Settings pick still
  // waiting for a session must not replace this one once it binds (#13345).
  const pendingSwitch = useHelpPanelStore.getState().agentSwitchRequest;
  if (pendingSwitch) useHelpPanelStore.getState().clearAgentSwitchRequest(pendingSwitch.id);
  // Queued before the lane appears: a brand-new lane's first input sync would
  // otherwise auto-launch a blank session into it.
  controller.launchWhenReady({
    agentId: args.agentId,
    replaceExisting: true,
    resumeTarget: { sessionId: args.sessionId },
  });
  if (target.isNew) useHelpPanelStore.getState().ensureSlot(target.slot);
  revealHelpLane(target.slot);
  holdLaneClaimUntilSettled(controller, claimKey);
  return { outcome: "resumed" };
}

/** How a "New session with…" pick went. */
export type HelpNewSessionOutcome = "started" | "lanes-full" | "unavailable";

/**
 * Start one session on `agentId` (#13442) without touching the assistant's
 * default, which later sessions keep starting on. It lands where a help launch
 * would — the active tab when it is empty, else another free one, else a new
 * tab — so it never displaces a conversation, including one main still keeps
 * for a tab this view hasn't restored yet.
 */
async function startHelpSessionWithAgent(
  agentId: string
): Promise<{ outcome: HelpNewSessionOutcome }> {
  const projectState = useProjectStore.getState();
  const workspace = projectState.currentProject ?? useScratchStore.getState().currentScratch;
  if (!workspace) {
    notifyLaunchFailed(
      agentId,
      projectState.isBootstrapped ? LAUNCH_BLOCKED_NO_WORKSPACE : LAUNCH_BLOCKED_LOADING
    );
    return { outcome: "unavailable" };
  }
  await ensureHelpPanelRuntime();
  // A read that fails can't prove a lane vacant, and a fresh session in a lane
  // main still keeps would take that conversation's place, so it stops here.
  let kept: ReadonlySet<number>;
  let acquireController: (slot: number) => HelpSessionController;
  try {
    kept = new Set((await window.electron.help.listPendingHibernationSlots?.(workspace.id)) ?? []);
    ({ acquireHelpSessionController: acquireController } =
      await import("@/controllers/helpSessionControllerRegistry"));
  } catch (err) {
    logError("Couldn't prepare a tab to start an assistant session in", err);
    notify({
      type: "warning",
      title: "Assistant couldn't start",
      message: "Daintree couldn't check this project's assistant tabs. Try again.",
      priority: "high",
      context: { eventKind: "uiFeedback" },
    });
    return { outcome: "unavailable" };
  }

  // Nothing is awaited from here to the launch, so the tab chosen is still
  // free when it is claimed. An empty tab can still be starting the default's
  // session, which would drop this launch on its re-entrancy guard, so a busy
  // one is passed over for the next free tab.
  const state = useHelpPanelStore.getState();
  const busy = new Set<number>();
  for (;;) {
    const target = pickHelpLaunchLane(
      state,
      workspace.id,
      (slot) => kept.has(slot) || busy.has(slot)
    );
    if (!target) {
      notify(
        busy.size > 0
          ? {
              type: "warning",
              title: "Assistant tab is busy",
              message: "That tab is still starting a session. Try again once it's ready.",
              priority: "high",
              context: { eventKind: "uiFeedback" },
            }
          : {
              type: "warning",
              title: "Assistant tabs full",
              message: `All ${MAX_ASSISTANT_SLOTS} assistant tabs are in use. Close one to start another session.`,
              priority: "high",
              context: { eventKind: "uiFeedback" },
            }
      );
      return { outcome: busy.size > 0 ? "unavailable" : "lanes-full" };
    }
    const controller = acquireController(target.slot);
    const phase = controller.getSnapshot().phase;
    if (phase !== "idle" && phase !== "live") {
      busy.add(target.slot);
      continue;
    }

    const claimKey = assistantSlotKey(workspace.id, target.slot);
    claimedHelpLaneKeys.add(claimKey);
    // A Settings pick still waiting for a session would switch this one to the
    // default the moment it binds (#13345), undoing the choice just made.
    const pendingSwitch = state.agentSwitchRequest;
    if (pendingSwitch) useHelpPanelStore.getState().clearAgentSwitchRequest(pendingSwitch.id);
    // Queued before a new tab appears, or its first input sync would auto-launch
    // the default into it. Pinned so a failed launch waits on Retry for this
    // agent rather than being replaced by the default's.
    controller.launchWhenReady({ agentId, replaceExisting: true, pinAgent: true });
    if (target.isNew) useHelpPanelStore.getState().ensureSlot(target.slot);
    revealHelpLane(target.slot);
    holdLaneClaimUntilSettled(controller, claimKey);
    return { outcome: "started" };
  }
}

interface HelpLaunchArgs {
  agentId?: string;
  slot?: number;
  vacantOnly?: boolean;
  greeting?: "hub";
}

async function launchHelpAgent(
  parsed: HelpLaunchArgs | undefined,
  { context: capturedContext, workspace, isProjectStateSettled }: HelpLaunchSnapshot
) {
  // Started before the first await so the panel's lazy chunk loads in
  // parallel with the folder lookup; awaited before the session is bound.
  const helpPanelRuntimeReady = ensureHelpPanelRuntime();
  const folderPath = await window.electron.help.getFolderPath();
  if (!folderPath) {
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Help agent",
      message: "Help folder not available. Please ensure the help workspace is configured.",
    });
    return;
  }

  let agentId: string;
  // The default as resolved against what this machine can run; null until
  // CLI availability is known, when `agentId` below is only a guess.
  let resolvedDefault: string | null = null;
  if (parsed?.agentId) {
    agentId = parsed.agentId;
  } else {
    const { defaultAgent } = useAgentPreferencesStore.getState();
    const { availability, isInitialized } = useCliAvailabilityStore.getState();
    // Constrain the implicit default to agents the assistant gate will
    // actually admit — `getDefaultAgentId` otherwise answers with general
    // launch eligibility and can name one `provisionSession` refuses (a
    // deprecated tier, or an unimplemented injection mode). An explicit
    // `args.agentId` still goes straight to that gate, so an experimental
    // agent stays launchable by name.
    resolvedDefault = isInitialized
      ? getDefaultAgentId(
          defaultAgent,
          undefined,
          availability,
          new Set(getAssistantSupportedAgentIds())
        )
      : null;
    agentId = resolvedDefault ?? "claude";
  }

  let session: Awaited<ReturnType<typeof window.electron.help.provisionSession>> | null = null;
  if (!workspace) {
    // Shares the panel controller's copy so both launch entry points fail
    // identically, and only claims "loading" when state really is still
    // hydrating — the old message said so unconditionally (#11068).
    notifyLaunchFailed(
      agentId,
      isProjectStateSettled ? LAUNCH_BLOCKED_NO_WORKSPACE : LAUNCH_BLOCKED_LOADING
    );
    return;
  }

  // Name the lane explicitly (#12108) rather than letting main default it.
  // Chosen once, before the provision, so the lane this session is minted
  // for is the same one the terminal binds into below even if the user
  // switches tabs while the await is outstanding. Provisioning revokes and
  // kills whatever a lane was running, so a busy tab is never a target: the
  // help agent opens beside it instead (#13192).
  await helpPanelRuntimeReady;
  // Read before a lane is chosen and claimed: nothing is awaited between the
  // claim and the provision, so no other launch can take the lane meanwhile.
  const keptAgents = parsed?.agentId
    ? new Map<number, string>()
    : await readKeptLaneAgents(workspace.id);
  const panelState = useHelpPanelStore.getState();
  const lane: {
    slot: number;
    isNew: boolean;
    stale?: { terminalId: string | null; sessionId: string | null };
  } | null =
    parsed?.slot === undefined
      ? pickHelpLaunchLane(panelState, workspace.id)
      : (exactHelpLaunchLane(panelState, workspace.id, parsed.slot) ??
        (parsed.vacantOnly ? staleHelpLaunchLane(panelState, workspace.id, parsed.slot) : null));
  // A caller that named the lane is told by the missing result, with no
  // tab opened or toast shown in a view nobody may be looking at.
  if (!lane && parsed?.slot !== undefined) return undefined;
  if (!lane) {
    useFocusStore.getState().clearAssistantGesture();
    if (!panelState.isOpen) {
      suppressSidebarResizes();
      panelState.setOpen(true);
    }
    notify({
      type: "warning",
      title: "Assistant tabs full",
      message: `All ${MAX_ASSISTANT_SLOTS} assistant tabs are in use. Close one to launch the help agent.`,
      priority: "high",
      context: { eventKind: "uiFeedback" },
    });
    return;
  }
  const targetSlot = lane.slot;
  const claimKey = assistantSlotKey(workspace.id, targetSlot);
  claimedHelpLaneKeys.add(claimKey);
  try {
    if (!parsed?.agentId) {
      const { availability, isInitialized } = useCliAvailabilityStore.getState();
      const wired = getAssistantWiredAgentIds();
      const canLaunch = (id: string) =>
        wired.includes(id) &&
        (!isInitialized || !isBuiltInAgentId(id) || isAgentLaunchable(availability[id]));
      // The lane's own kept conversation first: its agent is what resumes
      // there. Then the default — a sibling tab on another agent is no
      // reason to leave it, since lanes on different agents run in
      // directories of their own. A sibling's agent only stands in for a
      // default that couldn't be resolved.
      const ownKept = keptAgents.get(targetSlot);
      // The assistant's own default, once this machine's CLIs are known —
      // the general agent default only stands in when the assistant has
      // none it can run here.
      const assistantDefault = panelState.preferredAgentId;
      agentId =
        (ownKept && canLaunch(ownKept) ? ownKept : null) ??
        (isInitialized && assistantDefault && canLaunch(assistantDefault)
          ? assistantDefault
          : null) ??
        resolvedDefault ??
        siblingLaneAgentId(panelState, workspace.id, targetSlot, canLaunch) ??
        keptLaneAgentId(keptAgents, targetSlot, canLaunch) ??
        agentId;
    }

    try {
      session = await window.electron.help.provisionSession({
        projectId: workspace.id,
        projectPath: workspace.path,
        agentId,
        context: capturedContext,
        slot: targetSlot,
        ...(parsed?.vacantOnly ? { vacantOnly: true } : {}),
      });
    } catch (err) {
      logError("Failed to provision help session", err);
      // Decode BEFORE any message formatting: the contextBridge strips the
      // custom `code` property, so it rides an encoded message prefix.
      const code = extractHelpSessionErrorCode(err);
      // A caller starting it on someone's behalf hears it from the missing result.
      if (parsed?.vacantOnly) return undefined;
      let message = "Couldn't start the Daintree Assistant session.";
      if (code === "MCP_PROBE_FAILED") {
        message =
          "Daintree's assistant services didn't respond in time. Check assistant settings, then try again.";
      } else if (code === "MCP_SERVER_NOT_STARTED" || code === "MCP_NOT_READY") {
        message =
          "Daintree's assistant services didn't start. Check assistant settings, then try again.";
      } else if (code === "USER_CONTENT_SYNC_FAILED") {
        message =
          "Daintree couldn't load this project's assistant folder, so the session didn't start. Try again.";
      } else if (code === "MIXED_AGENT_LANES") {
        message =
          "Another session in this project is running a different agent. Sessions of one project share a folder and use one agent, so stop that session first or open this one with the same agent.";
      }
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Assistant couldn't start",
        message,
      });
      return;
    }

    if (!session) {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Assistant couldn't start",
        message: "Couldn't start the Daintree Assistant session.",
      });
      return;
    }

    // The session dir owns the agent's .mcp.json / settings; the session
    // token scopes the assistant's MCP surface to this workspace.
    const cwd = session.sessionPath;
    const env: Record<string, string> = {
      DAINTREE_MCP_TOKEN: session.token,
      DAINTREE_WINDOW_ID: String(session.windowId),
      ...(session.mcpUrl ? { DAINTREE_MCP_URL: session.mcpUrl } : {}),
      DAINTREE_PROJECT_ID: workspace.id,
    };

    const agentLaunchFlags = await loadCustomLaunchFlags(agentId);
    const result = await actionService.dispatch<{ terminalId: string | null }>(
      "agent.launch",
      {
        agentId,
        cwd,
        location: "overlay",
        prompt:
          parsed?.greeting === "hub" ? HUB_STARTED_ASSISTANT_GREETING : HELP_ASSISTANT_GREETING,
        excludeFromPersistence: true,
        removeOnExit: true,
        ...(env && { env }),
        ...(agentLaunchFlags.length > 0 && { agentLaunchFlags }),
      },
      { source: "user" }
    );

    if (result.ok && result.result?.terminalId) {
      const launchedTerminalId = result.result.terminalId;
      // The lane can be closed while the provision + dispatch awaits are
      // outstanding (#12108). `setTerminal` refuses to bind into a lane that
      // is gone, so binding blind would leave this PTY holding a live bearer,
      // owned by no lane and no longer filtered out of the dock. Tear it down
      // instead — revoke before kill, mirroring `_teardownBoundSession`.
      //
      // A lane that did not exist yet is created only now, already bound, so
      // its runtime never mounts empty and auto-launches a second session into
      // the slot this one was provisioned for. Should a tab have claimed the
      // slot meanwhile — or bound the tab this launch reused — it is ours to
      // keep only while it is still free.
      claimedHelpLaneKeys.delete(claimKey);
      if (lane.stale) releaseStaleHelpLane(workspace.id, targetSlot, lane.stale);
      const bindState = useHelpPanelStore.getState();
      const laneLost = bindState.sessions[targetSlot]
        ? !isFreeHelpLane(bindState, workspace.id, targetSlot)
        : !lane.isNew || isHeldHelpSlot(bindState, workspace.id, targetSlot);
      if (laneLost) {
        window.electron.help.revokeSession(session.sessionId).catch((err) => {
          logError("Failed to revoke help session for a lane closed mid-launch", err);
        });
        usePanelStore.getState().removePanel(launchedTerminalId);
        return;
      }
      // Bind into the lane provisioning targeted above (#12108): binding
      // anywhere else would leave that session unreachable. Then show it.
      if (lane.isNew) bindState.ensureSlot(targetSlot);
      const helpPanel = useHelpPanelStore.getState();
      helpPanel.setTerminal(targetSlot, launchedTerminalId, agentId, session?.sessionId ?? null);
      useFocusStore.getState().clearAssistantGesture();
      const switchedLane = helpPanel.activeSlot !== targetSlot;
      helpPanel.setActiveSlot(targetSlot);
      if (!helpPanel.isOpen) {
        suppressSidebarResizes();
        helpPanel.setOpen(true);
      } else if (switchedLane) {
        // A lane that was in the background has no trustworthy geometry;
        // the focus request drives the panel's fit-and-repaint reveal.
        helpPanel.requestFocus();
      }
      window.electron.help.markTerminal(result.result.terminalId).catch(() => {});
      // What a caller starting an assistant on someone's behalf (a hub on
      // another machine) needs to find and enroll the lane it landed in.
      return {
        slot: targetSlot,
        terminalId: launchedTerminalId,
        sessionId: session.sessionId,
        agentId,
        cwd,
      };
    } else if (session) {
      window.electron.help.revokeSession(session.sessionId).catch((err) => {
        logError("Failed to revoke help session after failed launch", err);
      });
    }
    return undefined;
  } finally {
    claimedHelpLaneKeys.delete(claimKey);
  }
}

async function openHelpCommandsFolder(): Promise<void> {
  // The folder is the host's: its channel runs there, not on this machine.
  const hostName = isRemoteWindow() ? (getHostPlatformInfo().hostName ?? currentHostId()) : null;
  const result = await window.electron.help.openAssistantContentFolder();
  if (!result) {
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Couldn't open commands folder",
      message: hostName
        ? `Daintree couldn't create ~/.daintree/assistant on ${hostName}. Check that its home folder is writable, then try again.`
        : "Daintree couldn't create ~/.daintree/assistant. Check that your home folder is writable, then try again.",
    });
  } else if (!result.opened) {
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Couldn't open commands folder",
      message: hostName
        ? `The folder is ready at ${result.path} on ${hostName} — open it there in a file manager.`
        : `The folder is ready at ${result.path} — open it manually in your file manager.`,
    });
  } else if (hostName) {
    // The file manager opened on the host's screen, not this one.
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "info",
      title: "Opened commands folder",
      message: `The folder is open on ${hostName}, not on this machine.`,
    });
  }
}

type HelpActionRun = (
  args: unknown,
  ctx: ActionContext,
  callbacks: ActionCallbacks,
  launch?: HelpLaunchSnapshot
) => Promise<unknown>;

function readArgs<T>(args: unknown): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionService validated `argsSchema` before run()
  return args as T;
}

export const helpActionRuns = {
  "help.shortcuts": async (_args, _ctx, callbacks) => {
    callbacks.onOpenShortcuts();
  },
  "help.shortcutsAlt": async (_args, _ctx, callbacks) => {
    callbacks.onOpenShortcuts();
  },
  "help.displayImage": async () => {
    throw new Error(
      "help.displayImage must be invoked through the MCP main-process path, not renderer dispatch."
    );
  },
  "help.launchAgent": async (args, _ctx, _callbacks, launch) => {
    // Read after this chunk loaded, the snapshot would reopen #8317's race.
    if (!launch) throw new Error("help.launchAgent needs the snapshot taken at dispatch.");
    return launchHelpAgent(readArgs<HelpLaunchArgs | undefined>(args), launch);
  },
  "help.newSessionWithAgent": async (args) =>
    startHelpSessionWithAgent(readArgs<{ agentId: string }>(args).agentId),
  "help.resumePastSession": async (args) => {
    const picked = readArgs<
      { agentId: "claude" | "codex"; sessionId: string; slot?: number } | undefined
    >(args);
    if (picked) return resumeHelpPastSession(picked);
    await ensureHelpPanelRuntime();
    const store = useHelpPanelStore.getState();
    if (!store.isOpen) {
      suppressSidebarResizes();
      store.setOpen(true);
    }
    usePaletteStore.getState().openPalette("assistant-sessions");
    return undefined;
  },
  "help.openCommandsFolder": async () => openHelpCommandsFolder(),
  "help.gettingStarted.show": async () => {
    window.dispatchEvent(new CustomEvent("daintree:show-getting-started"));
  },
  "help.tour.show": async (args, ctx) =>
    requestTour(
      tourCandidates(readArgs<{ tourId?: string } | undefined>(args)?.tourId, ctx.callerPluginId)
    ),
  "help.tour.status": async (args, ctx) =>
    readTourStatus(
      tourCandidates(readArgs<{ tourId?: string } | undefined>(args)?.tourId, ctx.callerPluginId)
    ),
} satisfies Record<string, HelpActionRun>;

export type HelpActionRunId = keyof typeof helpActionRuns;
