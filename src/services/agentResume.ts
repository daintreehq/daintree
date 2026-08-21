import {
  buildResumeCommand,
  buildResumeLatestCommand,
  reconcileBypassFlags,
  reconcileInlineModeFlag,
  resolveEffectiveBypass,
  resolveEffectiveInlineMode,
} from "@shared/types/agentSettings";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";

/**
 * Reconciles a resumed session's persisted launch flags against the current
 * global settings (#10432 skip-permissions, #10876 alt-screen — both "resume
 * traps"): the snapshot may have been captured while a global switch was in a
 * different state, so strip the agent's canonical bypass / inline flags and
 * re-add them only if they currently resolve.
 *
 * Reads `useAgentSettingsStore` synchronously (a Zustand store read, not
 * React-bound), so it is safe to call from action definitions and effects alike.
 */
export function reconcileResumeLaunchFlags(session: {
  agentId: string;
  agentLaunchFlags?: string[];
}): string[] | undefined {
  const settings = useAgentSettingsStore.getState().settings;
  const entry = settings?.agents?.[session.agentId] ?? {};
  const effectiveBypass = resolveEffectiveBypass(
    entry,
    session.agentId,
    settings?.globalSkipPermissions
  );
  const effectiveInline = resolveEffectiveInlineMode(
    entry,
    session.agentId,
    settings?.globalUseAltScreen
  );
  // Pass [] when no flags were captured so a global-on still injects the token
  // for a supported agent (each reconcile no-ops for agents without one).
  return reconcileInlineModeFlag(
    reconcileBypassFlags(
      session.agentLaunchFlags ?? [],
      session.agentId,
      effectiveBypass,
      entry.dangerousArgs as string | undefined
    ),
    session.agentId,
    effectiveInline
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
  target: { cwd: string; worktreeId?: string }
): AddPanelOptions | null {
  if (!session.agentId || !session.sessionId) return null;
  const agentConfig = getEffectiveAgentConfig(session.agentId);
  if (!agentConfig) return null;
  const resumeFlags = reconcileResumeLaunchFlags(session);
  const command =
    buildResumeCommand(session.agentId, session.sessionId, resumeFlags) ??
    buildResumeLatestCommand(session.agentId, resumeFlags);
  if (!command) return null;
  return {
    kind: "terminal",
    launchAgentId: session.agentId,
    title: agentConfig.name,
    cwd: target.cwd,
    worktreeId: target.worktreeId,
    command,
    location: "grid",
    agentSessionId: session.sessionId,
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
  /** The worktree the pane belongs to, `null` for an unscoped record. */
  worktreeId: string | null;
}

/**
 * In-flight resumes keyed by `${sessionId}::${worktreeId ?? ""}`.
 *
 * Records are non-destructive, so two dispatches that both pass the live-pane
 * scan would each spawn a terminal against ONE provider transcript. The scan
 * alone cannot prevent that: `addPanel` is async, and the second caller runs its
 * scan inside the first one's await window, before any panel exists to find.
 *
 * A `Map` of promises rather than a `Set` of keys because this is now shared
 * with a caller that must RETURN the resumed terminal id: a second dispatch
 * awaits the first one's result and reports the same pane, instead of silently
 * doing nothing and leaving an MCP caller with no id. Module-scoped — one
 * instance per project view, mirroring `reopenJournalInFlight` in
 * terminal.reopenLast.
 */
const inFlightResumes = new Map<string, Promise<ResumeSessionOutcome>>();

/**
 * The id of a live pane already resuming `sessionId` in `worktreeId`, if any.
 *
 * Scoped by worktree as well as session so a pane moved to another worktree
 * can't answer for this one. Trashed panels are pending cleanup and dialog
 * panels are ephemeral modal content — neither is a pane the caller can be
 * handed. Background panels ARE eligible: a hibernated mirror still owns the
 * transcript, so spawning a second resume beside it is the duplicate this
 * guards against.
 */
export function findLiveResumePanelId(
  sessionId: string,
  worktreeId: string | null | undefined
): string | null {
  const panelStore = usePanelStore.getState();
  const found = panelStore.panelIds.find((id) => {
    const panel = panelStore.panelsById[id];
    return (
      panel !== undefined &&
      isPtyPanel(panel) &&
      panel.location !== "trash" &&
      panel.location !== "dialog" &&
      panel.agentSessionId === sessionId &&
      (panel.worktreeId ?? null) === (worktreeId ?? null)
    );
  });
  return found ?? null;
}

/**
 * Focus the pane already resuming this session, or spawn one that does.
 *
 * The single implementation behind BOTH resume surfaces — the human palette
 * hook and the deterministic `agentSessionHistory.resume` action. They must not
 * drift: if one treated a pane location as reusable and the other didn't, the
 * same session would focus from one entry point and duplicate from the other,
 * putting two live agents on one provider transcript.
 *
 * `onBeforeSpawn` runs only on the spawning path, inside the in-flight guard and
 * before `addPanel`. That ordering is load-bearing for the human surface, which
 * uses it to switch to the session's own worktree first — `addPanel` backgrounds
 * a grid panel whose worktree differs from the active one, so switching
 * afterwards would leave the pane off-screen. Agent and plugin callers
 * deliberately pass nothing, keeping a headless resume from yanking the view.
 *
 * Only the caller that STARTS a resume gets its `onBeforeSpawn` run; one that
 * joins an in-flight resume shares the result without re-running side effects.
 * So a human clicking a session an agent is already resuming would get the
 * agent's placement — which is why the human surface also reveals the pane
 * after awaiting, rather than relying on this callback alone.
 *
 * @throws when the record has no buildable resume command
 *   ({@link RESUME_UNAVAILABLE_MESSAGE}), or when the panel is gone by the time
 *   `addPanel` settles. Never resolves with a fabricated id.
 */
export async function resumeSessionIntoPanel(
  session: AgentSessionRecord,
  target: { cwd: string; worktreeId?: string },
  options: { onBeforeSpawn?: () => void } = {}
): Promise<ResumeSessionOutcome> {
  const worktreeId = target.worktreeId ?? null;

  const existingId = findLiveResumePanelId(session.sessionId, worktreeId);
  if (existingId) {
    const panelStore = usePanelStore.getState();
    // A backgrounded pane is hidden, not closed. `activateTerminal` moves
    // selection but never restores a panel's location, so activating one on its
    // own reports `activatedExisting` while nothing appears — the pane stays
    // out of the grid. Restore first, then activate, the same order the quick
    // switcher uses for the identical case.
    if (panelStore.panelsById[existingId]?.location === "background") {
      // No explicit target worktree: the pane matched on worktree already, so
      // naming one could only re-home it to where it is. Passing it would also
      // override `restoreBackgroundTerminal`'s own rescue branch, which adopts
      // the active worktree for a worktree-less panel that would otherwise
      // strand in the global grid bucket.
      panelStore.restoreBackgroundTerminal(existingId);
    }
    panelStore.activateTerminal(existingId);
    return { terminalId: existingId, outcome: "activatedExisting", worktreeId };
  }

  const inFlightKey = `${session.sessionId}::${target.worktreeId ?? ""}`;
  const pending = inFlightResumes.get(inFlightKey);
  if (pending) return pending;

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
    options.onBeforeSpawn?.();
    const panelOptions = buildResumePanelOptions(session, target);
    if (!panelOptions) throw new Error(RESUME_UNAVAILABLE_MESSAGE);
    const terminalId = await usePanelStore.getState().addPanel(panelOptions);
    // `addPanel` resolves null when the panel was removed during its async tail
    // (a PTY prewarm await, a project switch, an explicit removePanel). There is
    // no pane to hand back, so fail rather than report a success with no id.
    if (!terminalId) {
      throw new Error("Resume started but its terminal was closed before it finished opening.");
    }
    return { terminalId, outcome: "created", worktreeId };
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
