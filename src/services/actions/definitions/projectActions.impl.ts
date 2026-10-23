// The project actions' run bodies, loaded on first dispatch by
// `runProjectAction` in projectActions.ts, which keeps the metadata every view
// registers at boot (#14269). Nothing here may import projectActions.ts at runtime.
import type { ActionCallbacks } from "../actionTypes";
import { beginSwitchTrace } from "@/utils/switchTrace";
import type { ActionContext } from "@shared/types/actions";
import type { ProjectSettings } from "@shared/types";
import { pickAgentVisibleProjectSettings } from "@shared/types";
import { projectClient, projectGroupsClient } from "@/clients";
import { terminalClient } from "@/clients/terminalClient";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { usePilotStore } from "@/store/pilotStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { hasWorktreeAxis } from "@/components/Pilot/pilotRows";
import { getWorktreeIdSet } from "@/store/storeAccessors";
import { actionService } from "@/services/ActionService";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { notify, EVENT_KIND_TO_SETTING_KEY, EVENT_KIND_LABEL } from "@/lib/notify";
import type { NotificationEventKind } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import type { NotificationAction } from "@/store/notificationStore";
import { switchToLastWorkspace } from "@/lib/projectHistoryNav";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { suppressPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { sleepIdleProjectsWithConfirm } from "@/hooks/useSleepIdleProjects";
import {
  createGroupArgs,
  neverAutoSleepArgs,
  openRunArgs,
  setGroupArgs,
} from "./projectActionArgs";

/**
 * The one thing a row in the agent overview promises, not kept.
 *
 * Every other failure on that surface is visible in it — a stale fleet says so
 * in a banner, an unreachable host says so in the body. Opening is the one that
 * happens somewhere else, so when it fails there is nothing on the surface to
 * change: the dialog sits there and the row looks dead. That silence read as a
 * broken click rather than as a run that had moved on.
 *
 * A toast rather than an inline banner because the dialog is closing on the
 * cross-workspace path, so there may be no surface left to draw it on — and the
 * reason is never something this dialog can fix, which is also why it carries
 * no action.
 *
 * The underlying message is logged rather than shown. "Terminal panel no longer
 * exists" is true and useless: it names the renderer's bookkeeping, not the
 * thing the user was looking at — so the two callers supply their own sentence
 * instead, because the two failures are different facts. One says the run is
 * not here; the other says we never got to where it lives.
 *
 * Throws rather than returns, so the dispatch that asked for this reports a
 * failure too. A caller that is not a person — the MCP tool surface, an
 * automation — reads the result and nothing else, and "opened" is the one thing
 * it must not be told about a run that did not open. The action carries
 * `selfNotifiesOnExecutionError` so the action palette does not stack a vaguer
 * toast on top of the specific one raised here.
 */
function failToOpenRun(error: unknown, message: string, action?: NotificationAction): never {
  logWarn("Failed to open a run from the agent overview", {
    error: formatErrorMessage(error, "unknown"),
  });
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    title: "Couldn't open agent",
    message,
    context: { eventKind: "agent" },
    duration: 6000,
    // One caller has a recovery worth offering — a switch that failed can be
    // asked for again — and the other does not: the overview is still open
    // behind the toast with every other row in it, and nothing a button could
    // do there differs from pressing the same row again.
    ...(action !== undefined ? { actions: [action] } : {}),
  });
  throw new Error(message);
}

/**
 * What one press of the scoped chord resolves to, before anything is applied.
 *
 * `explain` is the workspace whose missing worktree axis the fleet is standing
 * in for, or null where the fleet is simply the fleet. It is part of the
 * IDENTITY of the resulting surface, not a decoration on it, which is why it
 * lives here rather than being written straight into the store: two openings
 * that differ only by that line are two different answers, and the chord's
 * toggle has to be able to tell them apart.
 */
type PilotChordTarget =
  { kind: "project"; workspaceId: string } | { kind: "fleet"; explain: string | null };

const resolveProjectId = (projectId: string | undefined): string => {
  const id = projectId ?? useProjectStore.getState().currentProject?.id;
  if (!id) throw new Error("No project given and no project is open");
  return id;
};

export const projectActionRuns = {
  "project.switcherPalette": async (
    _args: unknown,
    _ctx: ActionContext,
    callbacks: ActionCallbacks
  ) => {
    callbacks.onOpenProjectSwitcherPalette();
  },

  "pilot.toggle": async () => {
    const pilot = usePilotStore.getState();

    // Scoped right now: this chord is the step OUT, so it widens rather than
    // closing. The pair is one axis — I narrows to the project, O widens to
    // the fleet — and a second press from the fleet still closes, so the
    // toggle is intact. Closing outright from a scope was the wrong half of
    // that pair: it made the "show me more" key the one that showed nothing,
    // and dismissal already belongs to Escape.
    if (pilot.isOpen && pilot.scope.kind === "project") {
      pilot.showFleet();
      return;
    }

    pilot.toggle();
  },

  "pilot.openProject": async () => {
    const pilot = usePilotStore.getState();

    // The workspace THIS view owns, and nothing else. `currentProject` is
    // replicated to every view including cached ones and is null outright in
    // a scratch view, so it names what the app is globally pointed at rather
    // than the project whose agents the user is asking to see — the same trap
    // `pilot.openRun` documents below.
    const workspaceId = getViewWorkspaceId();

    // What this press is asking for, decided before anything is applied.
    //
    // Deciding first is what lets the toggle be exact. The chord closes when
    // it would land on the state it is already showing — a key that rewrites
    // its own output is a key that visibly does nothing — and "the state it
    // is already showing" is not a property of the scope alone: the fallback
    // opening is byte for byte the plain fleet plus one line of explanation,
    // so the answer includes which project that line names.
    //
    // Two states where the question cannot be asked yet, as opposed to
    // answered no: a view with no workspace identity has no project to scope
    // to, and a fleet nobody has reported cannot be filtered. Both mean the
    // plain fleet with nothing said — an explanation naming a project would
    // be describing a decision that was never taken.
    const runs = useFleetSnapshotStore.getState().snapshot?.runs;
    const target = ((): PilotChordTarget => {
      if (workspaceId === null || runs === undefined) return { kind: "fleet", explain: null };

      // Scoping is offered only where regrouping would say something new, and
      // the project's own worktrees are the half of that the runs cannot
      // answer (#11957). Read here rather than inside the gate because this
      // is the one place the two identities are known to agree:
      // `getWorktreeIdSet` is the CURRENT VIEW's store and
      // `getViewWorkspaceId` is that view's workspace, so the count belongs
      // to the project being asked about. A scratch is excluded outright — it
      // is not a git repository, so no count of its worktrees can be anything
      // but zero, whatever a store happens to hold.
      const projectRuns = runs.filter((run) => run.workspaceId === workspaceId);
      const isScratch = isScratchWorkspaceId(workspaceId);
      const knownWorktreeCount = isScratch ? 0 : (getWorktreeIdSet()?.size ?? 0);
      if (hasWorktreeAxis(projectRuns, knownWorktreeCount)) return { kind: "project", workspaceId };

      // The unscoped fleet is the honest fallback — still the surface the
      // user asked for, just without a narrowing it cannot support — but it
      // is byte for byte what the unscoped chord already gives, so where the
      // refusal is informed it carries the reason with it.
      //
      // A project carries its own root as a first-class entry the moment its
      // view store hydrates, so a zero there is "not told yet" rather than
      // "no worktrees" — and a decision taken on an answer nobody gave has no
      // business explaining itself. A scratch IS a real answer: it is not a
      // git repository, so its none is a none.
      const topologyIsKnown = isScratch || knownWorktreeCount > 0;
      return { kind: "fleet", explain: topologyIsKnown ? workspaceId : null };
    })();

    const scope = pilot.scope;
    const alreadyShowingTarget =
      pilot.isOpen &&
      (target.kind === "project"
        ? scope.kind === "project" && scope.workspaceId === target.workspaceId
        : scope.kind === "fleet" && pilot.fellBackFrom === target.explain);
    if (alreadyShowingTarget) {
      pilot.close();
      return;
    }

    if (target.kind === "project") {
      pilot.openProject(target.workspaceId);
      return;
    }
    if (target.explain !== null) {
      pilot.openFleetFallback(target.explain);
      return;
    }
    pilot.open();
  },

  "pilot.openRun": async (args: unknown) => {
    // Parsed rather than asserted: this is the one action whose args arrive
    // from a click payload, and a parse both narrows the type and rejects a
    // malformed dispatch instead of trusting it.
    const { runId, workspaceId: requestedWorkspaceId } = openRunArgs.parse(args);

    // The workspace THIS view owns, not the one the app is globally pointed
    // at. `currentProject` is per-view — main answers `project:get-current`
    // from the sender's own binding — and it is null outright in a scratch
    // view, so reading it here sent a run that was already on screen through
    // a cross-workspace switch, and sent every scratch run to
    // `switchProject`, which rejects a scratch id.
    const currentId = getViewWorkspaceId();

    const workspaceId = requestedWorkspaceId ?? currentId;
    if (workspaceId === null) {
      // Only reachable from a caller that omitted the workspace in a view
      // with no workspace identity at all. Nothing can be routed from that,
      // and guessing a destination is the failure mode this whole action
      // exists to avoid.
      failToOpenRun(
        new Error("no workspace identity"),
        "Daintree couldn't tell which workspace this run belongs to."
      );
    }

    // A view nobody is looking at cannot take anyone anywhere, and saying so
    // is the entire fix (#12315).
    //
    // `getViewWorkspaceId()` is the workspace this view was CREATED for —
    // immutable identity, seeded at view creation — which says nothing about
    // whether the view is the one attached to the window right now. For a
    // click the two always agree, because the dialog only ever runs in the
    // view the user is looking at. They come apart when an MCP session
    // dispatches into its bound workspace: `dispatchActionForWorkspace`
    // routes into a cached, detached, thawed background view, where the id
    // comparison below is trivially true, so this action used to select the
    // panel inside a view nobody could see and report success.
    //
    // Switching from here would be worse than refusing, not better. The view
    // this one would replace is a DIFFERENT renderer, and only that renderer
    // can snapshot its own drafts and layout on the way out — caching fires
    // no `visibilitychange` for a child view, so nothing else would flush
    // them. `terminal.revealOwned` routes to the active view for exactly that
    // reason; anything still arriving here has no way to show a person
    // anything, and an error it can act on beats a success it cannot.
    //
    // Main's cache lifecycle is the only signal that can tell the two apart:
    // `document.visibilityState` reports "visible" forever for a detached
    // child view.
    if (isProjectViewCached()) {
      failToOpenRun(
        new Error("view is cached"),
        "Daintree couldn't open that run — this project isn't the one on screen."
      );
    }

    // Already here: focus directly. Going through a switch would tear down
    // and rebuild a view that is already the active one.
    //
    // Focus BEFORE closing, and only close on success. An agent can exit
    // between the list rendering and the click, and `panel.focus` rejects on
    // a panel that no longer exists — closing first would leave the user back
    // where they started with the overview gone and nothing explaining why.
    if (workspaceId === currentId) {
      const result = await actionService.dispatch("panel.focus", { panelId: runId });
      if (result.ok) {
        // Closing a palette normally returns the keyboard to whatever opened
        // it. Here that would undo the line above: the restore fires from the
        // exit animation and hands focus back to the panel the user was
        // trying to leave. Set only on the success path — on failure the
        // dialog stays open and the flag would leak to another palette.
        suppressPaletteFocusRestore();
        usePilotStore.getState().close();
        return;
      }
      // The rows come from the PTY host's terminal list, which is a different
      // population from this view's panels: a run whose window or view no
      // longer holds it is listed here and cannot be focused from here. That
      // is rare, but it used to be SILENT — the click landed, the dispatch
      // failed, and the dialog sat there looking like a dead row. Say it.
      failToOpenRun(
        result.error,
        "This run isn't open in this window — it may have exited, or it may be open in another one."
      );
    }

    // Elsewhere: the switch is the only way across, and this context dies
    // with it — so the target rides along as a one-shot intent that the
    // incoming view applies once its state has hydrated. Closing first is
    // right here: the view holding this dialog is about to be replaced.
    usePilotStore.getState().close();
    const focusIntent = { intent: "focus-panel", panelId: runId } as const;

    // Projects and scratches are disjoint id spaces with separate stores,
    // switch handlers and current-pointers (#11518), so the destination has
    // to be routed by kind — `switchProject` rejects a scratch id outright.
    //
    // Routed on the id's SHAPE, not on whether the scratch store happens to
    // list it. That store hydrates asynchronously, so a membership test
    // answers "has the list loaded yet" during the boot window and sends a
    // scratch down the project path exactly when the fleet first renders.
    //
    // A rejected switch is reported for the same reason the focus above is:
    // the dialog is already gone by then, so an unhandled rejection would
    // leave the user looking at the project they started in with nothing
    // saying the click was received at all.
    //
    // This covers the SCRATCH half in practice. `switchProject` is
    // fire-and-forget by design — the main process swaps WebContentsViews out
    // from under this renderer — so it settles before its IPC does and
    // reports its own failure, with a Try again that now carries the focus
    // intent. `switchScratch` awaits its client and rejects to here, where
    // nothing else is listening.
    try {
      if (isScratchWorkspaceId(workspaceId)) {
        await useScratchStore.getState().switchScratch(workspaceId, { focusIntent });
        return;
      }
      await useProjectStore.getState().switchProject(workspaceId, { focusIntent });
    } catch (error) {
      failToOpenRun(error, "Daintree couldn't switch to the workspace this run lives in.", {
        label: "Try again",
        variant: "primary",
        onClick: () => {
          void actionService.dispatch("pilot.openRun", { runId, workspaceId });
        },
      });
    }
  },

  "project.mruCycleOlder": async () => {
    beginSwitchTrace("mru-shortcut");
    return switchToLastWorkspace();
  },

  "project.add": async (args: unknown) => {
    const { path, destination } =
      (args as { path?: string; destination?: "current" | "new" } | undefined) ?? {};
    const trimmedPath = path?.trim();
    if (destination === "new") {
      await useProjectStore.getState().addProjectByPath(trimmedPath ?? "", { disposition: "new" });
      return;
    }
    if (!trimmedPath) {
      await useProjectStore.getState().addProject();
      return;
    }
    await useProjectStore.getState().addProjectByPath(trimmedPath);
  },

  "project.openInNewWindow": async () => {
    await useProjectStore.getState().addProjectByPath("", { disposition: "new" });
  },

  "project.openDialog": async () => {
    return await projectClient.openDialog();
  },

  "project.switch": async (args: unknown) => {
    const { projectId } = args as { projectId: string };
    await useProjectStore.getState().switchProject(projectId);
  },

  "project.update": async (args: unknown) => {
    const { projectId, updates } = args as {
      projectId: string;
      updates: {
        name?: string;
        emoji?: string;
        color?: string;
        pinned?: boolean;
        neverAutoSleep?: boolean;
      };
    };
    await useProjectStore.getState().updateProject(projectId, updates);
  },

  "project.toggleNeverAutoSleep": async (args: unknown) => {
    const { projectId, enabled } = neverAutoSleepArgs.parse(args);
    const store = useProjectStore.getState();
    const id = projectId ?? store.currentProject?.id;
    if (!id) throw new Error("No project given and no project is open");
    const project = store.projects.find((p) => p.id === id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await store.updateProject(id, { neverAutoSleep: enabled ?? !project.neverAutoSleep });
  },

  "project.remove": async (args: unknown) => {
    const { projectId } = args as { projectId: string };
    await useProjectStore.getState().removeProject(projectId);
  },

  "project.archive": async (args: unknown) => {
    const { projectId } = (args ?? {}) as { projectId?: string };
    await projectGroupsClient.setArchived(resolveProjectId(projectId), true);
  },

  "project.unarchive": async (args: unknown) => {
    const { projectId } = (args ?? {}) as { projectId?: string };
    await projectGroupsClient.setArchived(resolveProjectId(projectId), false);
  },

  "project.setGroup": async (args: unknown) => {
    const { projectId, groupId } = setGroupArgs.parse(args);
    await projectGroupsClient.setMembership(projectId, groupId);
  },

  "project.listGroups": async () => ({ groups: await projectGroupsClient.list() }),

  "project.createGroup": async (args: unknown) => {
    const { name, projectId } = createGroupArgs.parse(args);
    // Checked before anything is created: refusing an unknown project after
    // the group exists would leave a retry of the same call failing on its
    // own duplicate name.
    if (
      projectId !== undefined &&
      !useProjectStore.getState().projects.some((p) => p.id === projectId)
    ) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const group = await projectGroupsClient.create(name);
    if (projectId !== undefined) {
      try {
        await projectGroupsClient.setMembership(projectId, group.id);
      } catch (error) {
        throw new Error(
          `Created group "${group.name}" (${group.id}), but couldn't move the project into it: ${formatErrorMessage(error, "unknown error")}. Use project.setGroup to retry.`,
          { cause: error }
        );
      }
    }
    return group;
  },

  "project.close": async (args: unknown, _ctx: ActionContext, callbacks: ActionCallbacks) => {
    const { projectId } = args as { projectId: string };
    const state = useProjectStore.getState();
    if (projectId === state.currentProject?.id) {
      callbacks.onConfirmCloseActiveProject(projectId);
      return;
    }
    await state.closeProject(projectId);
  },

  "project.closeActive": async (
    _args: unknown,
    _ctx: ActionContext,
    callbacks: ActionCallbacks
  ) => {
    const projectId = useProjectStore.getState().currentProject?.id;
    if (!projectId) return;
    callbacks.onConfirmCloseActiveProject(projectId);
  },

  "project.sleep": async (args: unknown, ctx: ActionContext) => {
    const { projectId } = (args ?? {}) as { projectId?: string };
    const id = resolveProjectId(projectId);
    const store = useProjectStore.getState();
    const project = store.projects.find((p) => p.id === id);
    if (!project) throw new Error(`Project not found: ${id}`);

    const entry = useProjectStatsStore.getState().stats[id];
    const isActive = store.currentProject?.id === id;
    const terminalCount = entry?.processCount ?? 0;
    const activeAgentCount = entry?.activeAgentCount ?? 0;
    const waitingAgentCount = entry?.waitingAgentCount ?? 0;
    // Matches the switcher: confirm when something would be stopped, or when the
    // project is the one on screen; a quiet background project sleeps at once.
    // No stats entry is unknown rather than quiet.
    let liveTerminalCount = 0;
    let liveReadFailed = false;
    if (!isActive && ctx.dispatchSource !== "agent") {
      // The pushed counts leave out a hidden assistant's terminal, so read the
      // host's own list; a read that fails is unknown, not quiet.
      try {
        liveTerminalCount = (await terminalClient.getAll()).filter(
          (t) => t.projectId === id && !t.isTrashed && t.hasPty !== false
        ).length;
      } catch {
        liveReadFailed = true;
      }
    }
    const mayStopWork =
      isActive ||
      !entry ||
      liveReadFailed ||
      liveTerminalCount > 0 ||
      terminalCount > 0 ||
      activeAgentCount > 0 ||
      waitingAgentCount > 0;
    // An agent dispatch has already cleared the MCP bridge's own confirm, which
    // names this project through its args; this store resolves only from a
    // renderer dialog a headless client can't click, so asking again would
    // hang past the dispatch deadline and could still fire afterwards (#11538).
    if (mayStopWork && ctx.dispatchSource !== "agent") {
      const ok = await useProjectSleepConfirmStore.getState().requestConfirmation({
        kind: "project",
        projects: [
          {
            id,
            name: project.name,
            path: project.path,
            terminalCount: Math.max(terminalCount, liveTerminalCount),
            activeAgentCount,
            waitingAgentCount,
            isActive,
          },
        ],
      });
      if (!ok) return { slept: false };
    }
    await useProjectStore.getState().sleepProject(id);
    return { slept: true };
  },

  "project.restart": async (args: unknown, ctx: ActionContext) => {
    // A project's own assistant is one of the terminals the teardown stops,
    // so an agent restarting it would end its own session mid-call.
    if (ctx.dispatchSource === "agent") {
      throw new Error("Restarting a project is only available to the user");
    }
    const { projectId } = (args ?? {}) as { projectId?: string };
    const store = useProjectStore.getState();
    const current = store.currentProject;
    if (!current) throw new Error("No project is open in this window");
    // The reopen lands in this window, so only the project it shows can be
    // restarted here; another window's project restarts from that window.
    if (projectId !== undefined && projectId !== current.id) {
      throw new Error("Only the project open in this window can be restarted");
    }
    const id = current.id;
    const project = store.projects.find((p) => p.id === id) ?? current;

    const entry = useProjectStatsStore.getState().stats[id];
    const ok = await useProjectSleepConfirmStore.getState().requestConfirmation({
      kind: "restart",
      projects: [
        {
          id,
          name: project.name,
          path: project.path,
          terminalCount: entry?.processCount ?? 0,
          activeAgentCount: entry?.activeAgentCount ?? 0,
          waitingAgentCount: entry?.waitingAgentCount ?? 0,
          isActive: true,
        },
      ],
    });
    if (!ok) return { restarted: false };
    // The window may have moved on while the dialog was open.
    if (useProjectStore.getState().currentProject?.id !== id) return { restarted: false };

    // Loaded on use: the restart pulls in the whole hydration graph, which
    // every action registration would otherwise pay for.
    const { restartProject } = await import("@/services/projectRestart");
    const outcome = await restartProject(id);
    return { restarted: outcome === "restarted", outcome };
  },

  "project.sleepIdle": async (_args: unknown, ctx: ActionContext) => {
    // Targets are resolved here, from live state, so an agent's approval can't
    // name them; the same candidate rules and per-project re-checks still apply.
    const slept = await sleepIdleProjectsWithConfirm({
      alreadyApproved: ctx.dispatchSource === "agent",
    });
    return { slept: slept > 0, count: slept };
  },

  "project.getAll": async () => {
    const result = await projectClient.getAll();
    return { projects: result };
  },

  "project.getCurrent": async () => {
    const result = await projectClient.getCurrent();
    return { project: result };
  },

  "project.getSettings": async (args: unknown, ctx: ActionContext) => {
    const { projectId } = (args ?? {}) as { projectId?: string };
    const resolvedProjectId = projectId ?? ctx.projectId;
    if (!resolvedProjectId) throw new Error("No active project");
    const settings = await projectClient.getSettings(resolvedProjectId);
    // Project down to the agent-safe field set before returning. This action is on
    // every MCP tier's allowlist, and the settings payload carries decrypted secure
    // env vars (ProjectSettingsManager resolves them) plus a 250KB icon blob.
    // Dispatch also parses the result against `resultSchema` (#11539), but this stays
    // as the inner boundary — it builds a fresh object (projectClient caches the value
    // it returns and the renderer's settings UI legitimately needs the full payload)
    // and, unlike a parse, has no failure mode that could fall back to the raw value.
    return pickAgentVisibleProjectSettings(settings);
  },

  "project.saveSettings": async (args: unknown) => {
    const { projectId, settings } = args as {
      projectId: string;
      settings: Record<string, unknown>;
    };
    // Merge over current settings rather than full-replace so dispatchers
    // (notably MCP callers) cannot wipe unrelated fields by sending a
    // partial object. Strip privilege-escalation keys before merging —
    // the MCP-tier knob lives in ProjectSettings and must not be
    // self-mutable by an agent.
    const current = await projectClient.getSettings(projectId);
    const sanitized: Record<string, unknown> = { ...settings };
    delete sanitized.daintreeMcpTier;
    delete sanitized.daintreeMcpSkipConfirmations;
    delete sanitized.exposeDaintreeMcpToAgents;
    const updated = { ...current, ...sanitized } as ProjectSettings;
    await projectClient.saveSettings(projectId, updated);

    const currentProjectId = useProjectStore.getState().currentProject?.id;
    const projectSettingsState = useProjectSettingsStore.getState();
    if (projectId === currentProjectId && projectSettingsState.projectId === projectId) {
      projectSettingsState.setSettings(updated);
    }
  },

  "project.muteNotifications": async (args: unknown) => {
    const { projectId } = args as { projectId: string };
    try {
      const current = await projectClient.getSettings(projectId);
      const priorOverrides = { ...current.notificationOverrides };
      const updated = {
        ...current,
        notificationOverrides: {
          ...current.notificationOverrides,
          completedEnabled: false,
          waitingEnabled: false,
        },
      };
      await projectClient.saveSettings(projectId, updated);
      const settingsState = useProjectSettingsStore.getState();
      if (settingsState.projectId === projectId) {
        settingsState.setSettings(updated);
      }
      if (updated.notificationOverrides) {
        useProjectSettingsStore.setState((s) => ({
          notificationOverridesByProjectId: {
            ...s.notificationOverridesByProjectId,
            [projectId]: updated.notificationOverrides!,
          },
        }));
      }
      notify({
        type: "success",
        message: "Project notifications muted",
        priority: "high",
        duration: UNDO_TOAST_DURATION_MS,
        context: { eventKind: "settings" },
        // One-shot Undo confirmation; mute is reversible from the project's
        // notification settings tab, so the 5s Undo window plus the settings
        // surface make inbox persistence redundant.
        transient: true,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              const currentNow = await projectClient.getSettings(projectId);
              await projectClient.saveSettings(projectId, {
                ...currentNow,
                notificationOverrides: priorOverrides,
              });
            } catch {
              // Undo failed silently — settings can be restored manually
            }
          },
        },
      });
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't mute notifications",
        message: formatErrorMessage(error, "Couldn't mute project notifications"),
        duration: 5000,
      });
      throw error;
    }
  },

  "project.silenceNotificationKind": async (args: unknown) => {
    const { kind, projectId } = args as { kind: NotificationEventKind; projectId?: string };
    const label = EVENT_KIND_LABEL[kind] ?? kind;
    const settingKey = EVENT_KIND_TO_SETTING_KEY[kind];
    // Routing-only kinds (e.g. "host", "git") have no persisted silence
    // toggle. The Zod enum below only admits the four silenceable kinds, so
    // this is a type-narrowing guard rather than a reachable runtime path.
    if (!settingKey) return;

    try {
      const isGlobalOnly = kind === "uiFeedback";
      let priorValue: boolean | undefined;
      let priorGlobalSnapshot: Partial<Record<string, boolean>> | undefined;

      if (projectId && !isGlobalOnly) {
        const current = await projectClient.getSettings(projectId);
        priorValue = (current.notificationOverrides as Record<string, unknown> | undefined)?.[
          settingKey
        ] as boolean | undefined;
        await projectClient.saveSettings(projectId, {
          ...current,
          notificationOverrides: {
            ...current.notificationOverrides,
            [settingKey]: false,
          },
        });
      } else {
        const current = await window.electron?.notification?.getSettings();
        if (current) {
          priorValue = (current as unknown as Record<string, unknown>)[settingKey] as
            boolean | undefined;
          priorGlobalSnapshot = {
            [settingKey]: (current as unknown as Record<string, unknown>)[settingKey] as
              boolean | undefined,
          };
          await window.electron.notification.setSettings({ [settingKey]: false });
        }
      }

      const scopeSuffix = isGlobalOnly ? " for all projects" : projectId ? " for this project" : "";

      notify({
        type: "success",
        message: `Silenced ${label}${scopeSuffix}`,
        priority: "high",
        duration: UNDO_TOAST_DURATION_MS,
        context: { eventKind: "settings" },
        // One-shot Undo confirmation; silenced kinds are reversible from
        // notification settings, so the 5s Undo plus the settings surface
        // make inbox persistence redundant.
        transient: true,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              if (projectId && !isGlobalOnly) {
                const currentNow = await projectClient.getSettings(projectId);
                const overrides = {
                  ...(currentNow.notificationOverrides as Record<string, unknown>),
                };
                if (priorValue === undefined) {
                  delete overrides[settingKey];
                } else {
                  overrides[settingKey] = priorValue;
                }
                await projectClient.saveSettings(projectId, {
                  ...currentNow,
                  notificationOverrides: overrides,
                });
              } else if (priorGlobalSnapshot) {
                await window.electron?.notification?.setSettings(priorGlobalSnapshot);
              }
            } catch {
              // Undo failed silently — settings can be restored manually
            }
          },
        },
      });
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't silence notifications",
        message: formatErrorMessage(error, `Couldn't silence ${label}`),
        duration: 5000,
      });
      throw error;
    }
  },

  "project.detectRunners": async (args: unknown, ctx: ActionContext) => {
    const { projectId } = (args ?? {}) as { projectId?: string };
    const resolvedProjectId = projectId ?? ctx.projectId;
    if (!resolvedProjectId) throw new Error("No active project");
    const result = await projectClient.detectRunners(resolvedProjectId);
    return { runners: result };
  },

  "project.getStats": async (args: unknown, ctx: ActionContext) => {
    const { projectId } = (args ?? {}) as { projectId?: string };
    const resolvedProjectId = projectId ?? ctx.projectId;
    if (!resolvedProjectId) throw new Error("No active project");
    return await projectClient.getStats(resolvedProjectId);
  },

  "project.cloneRepo": async () => {
    useProjectStore.getState().openCloneRepoDialog();
  },

  "project.settings.open": async () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", {
        detail: { tab: "project:general" },
      })
    );
  },
} satisfies Record<
  string,
  (args: unknown, ctx: ActionContext, callbacks: ActionCallbacks) => Promise<unknown>
>;

export type ProjectActionRunId = keyof typeof projectActionRuns;
