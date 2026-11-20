import {
  buildResumeCommand,
  buildResumeLatestCommand,
  type AgentSettings,
} from "@shared/types/agentSettings";
import { getEffectiveAgentConfig, type AgentPreset } from "@shared/config/agentRegistry";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { reconcileResumeLaunchFlagsWith } from "@shared/utils/agentResumeFlags";
import { conversationStoreFor } from "@shared/utils/conversationStore";
import { resolveCurrentAgentLaunchBaseCommand } from "@/utils/agentLaunchCommand";
import { resolveAgentRuntimeSettings } from "@/utils/agentRuntimeSettings";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { getPendingBatchIds } from "@/store/slices/panelRegistry/hydrationBatch";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";

/**
 * {@link reconcileResumeLaunchFlagsWith} against the current global settings.
 *
 * Reads `useAgentSettingsStore` synchronously (a Zustand store read, not
 * React-bound), so it is safe to call from action definitions and effects alike.
 */
export function reconcileResumeLaunchFlags(session: {
  agentId: string;
  agentLaunchFlags?: string[];
  /** The caller's verbatim tail (#13046), re-appended untouched after reconcile. */
  callerLaunchFlags?: string[];
  agentPresetId?: string;
  projectId?: string | null;
}): string[] | undefined {
  const settings = useAgentSettingsStore.getState().settings;
  return reconcileResumeLaunchFlagsWith(session, settings, resumePreset(session, settings));
}

/**
 * The preset a record says its session launched on (#17435): `undefined` when
 * it names none, so the agent's own settings apply as they always did, and
 * `null` when it names one this view can't read (deleted, not loaded, or held
 * for another project), so the launch takes the lesser of the level its flags
 * were captured at and the agent's own.
 */
function resumePreset(
  session: { agentId: string; agentPresetId?: string; projectId?: string | null },
  settings: AgentSettings | null | undefined
): AgentPreset | null | undefined {
  const { agentId, agentPresetId: presetId, projectId } = session;
  if (!presetId) return undefined;
  const projectPresets = useProjectPresetsStore.getState();
  const ownProject = !projectId || projectPresets.hydratedProjectId === projectId;
  return (
    resolveAgentRuntimeSettings({
      agentId,
      presetId,
      entry: settings?.agents?.[agentId],
      ccrPresets: useCcrPresetsStore.getState().ccrPresetsByAgent[agentId],
      projectPresets: ownProject ? projectPresets.presetsByAgent[agentId] : undefined,
    }).preset ?? null
  );
}

/**
 * Turns a journaled/palette-selected {@link AgentSessionRecord} into the
 * `addPanel` options that relaunch its agent with a resume command. Funnels
 * through `buildResumeCommand ?? buildResumeLatestCommand` (never re-derives
 * from current settings — #5343) with reconciled launch flags (#3175).
 *
 * Launches into the caller-provided `cwd`/`worktreeId`. Session resume is
 * directory-scoped — the CLI locates the conversation from the launch cwd
 * (#4781) — so callers resolve the target from the session's OWN recorded
 * location via `resolveResumeLaunchTarget`, falling back to the active worktree
 * only for records that predate those fields. Seeds `agentSessionId` so callers
 * can detect an already-open resume and focus it instead of spawning a
 * duplicate.
 *
 * @returns `addPanel` options, or `null` when the record is malformed or the
 *   agent has no resume config / no buildable command.
 */
export function buildResumePanelOptions(
  session: AgentSessionRecord,
  target: { cwd: string; worktreeId?: string },
  /** The executable to start, from {@link resolveCurrentAgentLaunchBaseCommand}. */
  baseCommand?: string
): AddPanelOptions | null {
  if (!session.agentId || !session.sessionId) return null;
  const agentConfig = getEffectiveAgentConfig(session.agentId);
  if (!agentConfig) return null;
  const resumeFlags = reconcileResumeLaunchFlags(session);
  const preset = resumePreset(session, useAgentSettingsStore.getState().settings);
  const command =
    buildResumeCommand(session.agentId, session.sessionId, resumeFlags, baseCommand) ??
    buildResumeLatestCommand(session.agentId, resumeFlags, baseCommand);
  if (!command) return null;
  return {
    kind: "terminal",
    launchAgentId: session.agentId,
    title: agentConfig.name,
    cwd: target.cwd,
    worktreeId: target.worktreeId,
    command,
    location: "grid",
    // Restart and restore rebuild from these, not from `command`; without them
    // the pane would lose its launch configuration (model, standing
    // instruction) the first time it restarts after this resume. Only a
    // captured snapshot is stored: flags reconciliation injected into an empty
    // one are not a complete configuration, and storing them would stop a
    // restart from rebuilding the rest from settings.
    agentLaunchFlags: session.agentLaunchFlags?.length ? resumeFlags : undefined,
    agentSessionId: session.sessionId,
    // So a restart of the resumed pane reconciles against the same preset.
    ...(preset ? { agentPresetId: preset.id } : {}),
    // A conversation recorded in another account's folder reopens from there
    // (#17087); the launch's own folder is looked up by id.
    conversationStore: conversationStoreFor(session.conversationStore, session.sessionId),
  };
}

/**
 * Message shown when a record cannot be turned into a resume launch — either it
 * is malformed or its agent has no buildable resume command. Shared so the
 * human surface (a toast) and the deterministic action (a thrown tool error)
 * say the same thing about the same failure.
 */
export const RESUME_UNAVAILABLE_MESSAGE =
  "Couldn't resume this session — its agent may no longer support resuming.";

/** What {@link resumeSessionIntoPanel} did, for callers that must report it. */
export interface ResumeSessionOutcome {
  /** The panel now carrying the session — newly spawned or already live. */
  terminalId: string;
  /** Whether a pane was spawned or an existing one was brought to the front. */
  outcome: "created" | "activatedExisting";
  /**
   * The worktree the pane is filed under, `null` for an unscoped one. For an
   * existing pane that is wherever it is filed now, which a live move can have
   * made another worktree than the one the caller targeted (#18009).
   */
  worktreeId: string | null;
}

/**
 * In-flight resumes keyed by session id alone, matching the live-pane scan.
 *
 * Records are non-destructive, so two dispatches that both pass the live-pane
 * scan would each spawn a terminal against ONE provider transcript. The scan
 * alone cannot prevent that: `addPanel` is async, and the second caller runs its
 * scan inside the first one's await window, before any panel exists to find.
 * Two callers aiming one session at different worktrees are the same hazard,
 * so the target is not part of the key.
 *
 * A `Map` of promises rather than a `Set` of keys because this is shared with
 * callers that must RETURN the resumed terminal id: a second dispatch awaits the
 * first one's result and reports the same pane, instead of silently doing
 * nothing and leaving an MCP caller with no id. Module-scoped — one instance per
 * project view.
 */
const inFlightResumes = new Map<string, Promise<ResumeSessionOutcome>>();

/**
 * Errors a caller's own `validateSpawn` threw. A resume that joins another
 * caller's launch shares its result, but not a refusal only that caller's
 * checks made: the joiner's own checks may allow the launch.
 */
const callerRefusals = new WeakSet<object>();

/**
 * The id of a live pane already carrying `sessionId`, wherever it is filed.
 *
 * Not scoped by worktree: a live move refiles a pane without touching its
 * process, so the conversation's owner can sit under any worktree, and a
 * resume that only looked inside its own target launched a second agent on
 * the transcript (#18009). Trashed panels are pending cleanup and dialog
 * panels are ephemeral modal content — neither is a pane the caller can be
 * handed. A pane whose agent quit back to its shell no longer runs the
 * conversation, though it keeps naming it, as main's own scan reads it.
 * Background panels ARE eligible: a hibernated mirror still owns the
 * transcript, so spawning a second resume beside it is the duplicate this
 * guards against. Panes an open spawn batch is still holding back from
 * `panelIds` are real panes, so they are read too.
 */
export function findLiveResumePanelId(sessionId: string): string | null {
  const panelStore = usePanelStore.getState();
  const found = [...panelStore.panelIds, ...getPendingBatchIds()].find((id) => {
    const panel = panelStore.panelsById[id];
    return (
      panel !== undefined &&
      isPtyPanel(panel) &&
      panel.location !== "trash" &&
      panel.location !== "dialog" &&
      panel.agentState !== "exited" &&
      panel.agentSessionId === sessionId
    );
  });
  return found ?? null;
}

function filedWorktreeId(terminalId: string): string | null {
  return usePanelStore.getState().panelsById[terminalId]?.worktreeId ?? null;
}

/**
 * Bring the pane already carrying the session forward, if the caller may.
 *
 * A pane filed under another worktree than the active one — or under none
 * while one is active — is only revealed through `showWorktree`, which selects
 * its worktree first. Without it — an agent or plugin caller — the pane is
 * handed back untouched: activating it could follow focus into its worktree and
 * move the person's view.
 */
function revealExistingPane(
  terminalId: string,
  showWorktree: ((worktreeId: string) => void) | undefined
): void {
  if (!Object.hasOwn(usePanelStore.getState().panelsById, terminalId)) return;
  const holderWorktreeId = filedWorktreeId(terminalId);
  const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
  if (holderWorktreeId !== activeWorktreeId) {
    if (!showWorktree) return;
    if (holderWorktreeId !== null) showWorktree(holderWorktreeId);
  }
  const panelStore = usePanelStore.getState();
  // A backgrounded pane is hidden, not closed. `activateTerminal` moves
  // selection but never restores a panel's location, so activating one on its
  // own reports `activatedExisting` while nothing appears — the pane stays out
  // of the grid. Restore first, then activate, the same order the quick
  // switcher uses for the identical case.
  if (panelStore.panelsById[terminalId]?.location === "background") {
    // No target worktree: naming the caller's would refile the pane, or its
    // whole group, under a worktree it isn't in. Passing none also keeps
    // `restoreBackgroundTerminal`'s own rescue branch, which adopts the active
    // worktree for a worktree-less panel that would otherwise strand in the
    // global grid bucket.
    panelStore.restoreBackgroundTerminal(terminalId);
  }
  usePanelStore.getState().activateTerminal(terminalId);
}

/**
 * Bring a resumed pane on screen for a person: its worktree selected, restored
 * if parked, and focused. For a foreground caller to run after the resume
 * settles, because only the caller that STARTS a launch gets its callbacks run
 * inside it: one that joined it would otherwise be left looking elsewhere. The
 * caller decides first whether a newer navigation should stand.
 */
export function bringResumedPaneForward(
  resumed: ResumeSessionOutcome,
  showWorktree: (worktreeId: string) => void
): void {
  revealExistingPane(resumed.terminalId, showWorktree);
}

/**
 * Focus the pane already carrying this session, or spawn one that does.
 *
 * The single implementation behind every view resume surface — the person
 * surfaces, the deterministic `agentSessionHistory.resume` action, and
 * `terminal.reopenLast`. They must not drift: if one treated a pane location as
 * reusable and the other didn't, the same session would focus from one entry
 * point and duplicate from the other, putting two live agents on one provider
 * transcript.
 *
 * The pane already carrying the session answers whatever worktree it is filed
 * under (#18009), so checks that only make sense for a NEW launch — is the
 * recorded worktree still here, is the recorded directory inside the one the
 * caller named — go in `validateSpawn`, which throws to refuse and runs only on
 * the spawning path.
 *
 * `onBeforeSpawn` runs only on the spawning path, inside the in-flight guard and
 * before `addPanel`. That ordering is load-bearing for the human surface, which
 * uses it to switch to the session's own worktree first — `addPanel` backgrounds
 * a grid panel whose worktree differs from the active one, so switching
 * afterwards would leave the pane off-screen. Agent and plugin callers
 * deliberately pass nothing, keeping a headless resume from yanking the view.
 * `showWorktree` is the same choice for an existing pane: given, a pane filed
 * under another worktree is brought on screen; absent, it is only reported.
 *
 * Only the caller that STARTS a resume gets its callbacks run; one that joins an
 * in-flight resume shares the result without re-running side effects — except
 * a refusal by the starter's own `validateSpawn`, after which the joiner tries
 * once under its own checks. So a human clicking a session an agent is already
 * resuming would get the agent's placement — which is why foreground callers
 * also bring the pane forward after awaiting ({@link bringResumedPaneForward}),
 * rather than relying on these callbacks alone.
 *
 * @throws when `validateSpawn` refuses, when the record has no buildable resume
 *   command ({@link RESUME_UNAVAILABLE_MESSAGE}), or when the panel is gone by
 *   the time `addPanel` settles. Never resolves with a fabricated id.
 */
export function resumeSessionIntoPanel(
  session: AgentSessionRecord,
  target: { cwd: string; worktreeId?: string },
  options: ResumeSessionOptions = {}
): Promise<ResumeSessionOutcome> {
  return resumeSession(session, target, options, false);
}

interface ResumeSessionOptions {
  onBeforeSpawn?: () => void;
  showWorktree?: (worktreeId: string) => void;
  validateSpawn?: () => void;
}

async function resumeSession(
  session: AgentSessionRecord,
  target: { cwd: string; worktreeId?: string },
  options: ResumeSessionOptions,
  retried: boolean
): Promise<ResumeSessionOutcome> {
  const answerFromLivePane = (): ResumeSessionOutcome | null => {
    const existingId = findLiveResumePanelId(session.sessionId);
    if (!existingId) return null;
    revealExistingPane(existingId, options.showWorktree);
    return {
      terminalId: existingId,
      outcome: "activatedExisting",
      worktreeId: filedWorktreeId(existingId),
    };
  };

  const existing = answerFromLivePane();
  if (existing) return existing;

  const inFlightKey = session.sessionId;
  const pending = inFlightResumes.get(inFlightKey);
  if (pending) {
    try {
      return await pending;
    } catch (error) {
      // Refused by the starter's own checks, which aren't this caller's: try
      // under its own, once, after that launch has gone.
      if (retried || typeof error !== "object" || error === null) throw error;
      if (!callerRefusals.has(error)) throw error;
      if (inFlightResumes.get(inFlightKey) === pending) inFlightResumes.delete(inFlightKey);
      return resumeSession(session, target, options, true);
    }
  }

  // Register BEFORE running any of the work. An async function body runs
  // synchronously up to its first await, so building the promise first would
  // leave `onBeforeSpawn` — which can call `selectWorktree` and drive store
  // subscribers — executing while the map is still empty. A subscriber that
  // re-entered here would find neither an in-flight entry nor a committed
  // panel, and spawn a second agent on the same transcript.
  let begin: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const run = gate.then(async (): Promise<ResumeSessionOutcome> => {
    try {
      options.validateSpawn?.();
    } catch (error) {
      if (typeof error === "object" && error !== null) callerRefusals.add(error);
      throw error;
    }
    options.onBeforeSpawn?.();
    const panelOptions = buildResumePanelOptions(
      session,
      target,
      await resolveCurrentAgentLaunchBaseCommand(session.agentId)
    );
    if (!panelOptions) throw new Error(RESUME_UNAVAILABLE_MESSAGE);
    // A pane that took the session while the executable was being resolved —
    // restore, or a resume this guard can't see — answers instead.
    const arrived = answerFromLivePane();
    if (arrived) return arrived;
    const terminalId = await usePanelStore.getState().addPanel(panelOptions);
    // `addPanel` resolves null when the panel was removed during its async tail
    // (a PTY prewarm await, a project switch, an explicit removePanel). There is
    // no pane to hand back, so fail rather than report a success with no id.
    if (!terminalId) {
      throw new Error("Resume started but its terminal was closed before it finished opening.");
    }
    // Where the pane is filed now: a move while `addPanel` awaited its PTY
    // prewarm has already refiled it.
    const created = usePanelStore.getState().panelsById[terminalId];
    return {
      terminalId,
      outcome: "created",
      worktreeId: created ? (created.worktreeId ?? null) : (target.worktreeId ?? null),
    };
  });

  inFlightResumes.set(inFlightKey, run);
  begin();
  try {
    return await run;
  } finally {
    // Only clear our own entry: a later resume for the same key may already have
    // replaced it, and deleting that one would drop a live guard.
    if (inFlightResumes.get(inFlightKey) === run) inFlightResumes.delete(inFlightKey);
  }
}
