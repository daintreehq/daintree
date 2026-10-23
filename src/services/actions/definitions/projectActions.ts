import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { AgentVisibleProjectSettingsKey } from "@shared/types";
import { z } from "zod";
import { PROJECT_LIST_SORT_MODES } from "@shared/types/project";
import {
  createGroupArgs,
  neverAutoSleepArgs,
  openRunArgs,
  setGroupArgs,
} from "./projectActionArgs";
import type { ProjectActionRunId } from "./projectActions.impl";

/**
 * Wire shape of `project.getSettings`.
 *
 * Typing the shape as `Record<AgentVisibleProjectSettingsKey, z.ZodType>` is what keeps
 * this honest: omitting a key classified `exposed`, or adding one that isn't, is a
 * compile error, so the advertised schema cannot drift from
 * `PROJECT_SETTINGS_AGENT_EXPOSURE`.
 *
 * `ActionService.dispatch` now parses results through this schema (#11539), so it
 * filters as well as documents. `pickAgentVisibleProjectSettings` in `run()` is kept
 * as the inner boundary: it cannot fail, whereas a parse that rejects the payload
 * would surface `RESULT_VALIDATION_ERROR` instead of a safe subset.
 */
const agentVisibleProjectSettingsShape: Record<AgentVisibleProjectSettingsKey, z.ZodType> = {
  runCommands: z.array(
    z.object({
      id: z.string(),
      // Every optional key here is typed rather than left open, which is only
      // safe because `pickAgentVisibleRunCommand` now drops a value whose type
      // doesn't match instead of forwarding it. Nothing below that projection
      // guarantees these types: the codec admits any entry with a string
      // `id`/`command` and copies the rest through verbatim, and the
      // agent-callable `project.saveSettings` types runCommands as
      // `z.array(z.unknown())`. Without the sanitize, one persisted
      // `preferredLocation: "sidebar"` would make this action return
      // RESULT_VALIDATION_ERROR for that project on every call, forever.
      name: z.string().optional(),
      command: z.string(),
      icon: z.string().optional(),
      description: z.string().optional(),
      preferredLocation: z.enum(["dock", "grid"]).optional(),
      preferredAutoRestart: z.boolean().optional(),
      isFrameworkDefault: z.boolean().optional(),
    })
  ),
  excludedPaths: z.array(z.string()).optional(),
  defaultWorktreeRecipeId: z.string().optional(),
  devServerCommand: z.string().optional(),
  devServerLoadTimeout: z.number().optional(),
  turbopackEnabled: z.boolean().optional(),
  copyTreeSettings: z.record(z.string(), z.unknown()).optional(),
  branchPrefixMode: z.enum(["none", "username", "custom"]).optional(),
  branchPrefixCustom: z.string().optional(),
  forgeRemote: z.string().optional(),
  forgeProviderOverride: z.string().nullable().optional(),
  issueProviderOverride: z.string().nullable().optional(),
  worktreePathPattern: z.string().optional(),
  terminalSettings: z
    .object({
      shell: z.string().optional(),
      shellArgs: z.array(z.string()).optional(),
      defaultWorkingDirectory: z.string().optional(),
      scrollbackLines: z.number().optional(),
    })
    .optional(),
  notificationOverrides: z.record(z.string(), z.unknown()).optional(),
  activeResourceEnvironment: z.string().optional(),
  defaultWorktreeMode: z.string().optional(),
};

/**
 * Run bodies load on first dispatch (#14269). Every view registers the project
 * actions at boot for menus, keybindings and the MCP manifest, but an empty
 * view runs few of them. A failed chunk load rejects inside `run`, which
 * ActionService turns into an error result like any other failure.
 */
async function runProjectAction(
  id: ProjectActionRunId,
  args: unknown,
  ctx: ActionContext,
  callbacks: ActionCallbacks
): Promise<unknown> {
  const { projectActionRuns } = await import("./projectActions.impl");
  return projectActionRuns[id](args, ctx, callbacks);
}

export function registerProjectActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("project.switcherPalette", () => ({
    id: "project.switcherPalette",
    title: "Open project switcher",
    description: "Open the quick project switcher palette",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.switcherPalette", args, ctx, callbacks),
  }));

  actions.set("pilot.toggle", () => ({
    id: "pilot.toggle",
    title: "View all agents",
    description:
      "Open the overview of every agent running across all projects and scratches, grouped by project",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("pilot.toggle", args, ctx, callbacks),
  }));

  actions.set("pilot.openProject", () => ({
    id: "pilot.openProject",
    title: "View this project's agents",
    description:
      "Open the agent overview scoped to this project, grouped by worktree, or the whole fleet when this workspace has no worktree axis",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("pilot.openProject", args, ctx, callbacks),
  }));

  actions.set("pilot.openRun", () => ({
    id: "pilot.openRun",
    title: "Open run",
    description:
      "Go to a specific agent run, switching project first when it lives in another workspace",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: openRunArgs,
    // Every failure escaping `run()` below has already been toasted with the
    // specific reason, so the action palette must not stack its generic one on
    // top. Validation failures are raised BEFORE `run()` and keep the palette's
    // toast, which is the right owner for them.
    selfNotifiesOnExecutionError: true,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("pilot.openRun", args, ctx, callbacks),
  }));

  // Id kept from when this was one half of a cycle pair; renaming it would
  // orphan any binding a user has already customised.
  actions.set("project.mruCycleOlder", () => ({
    id: "project.mruCycleOlder",
    title: "Switch to last workspace",
    description:
      "Switch to the workspace this window was in before the current one — a project or a scratch. Running it again returns to where you started.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.mruCycleOlder", args, ctx, callbacks),
  }));

  actions.set("project.add", () => ({
    id: "project.add",
    title: "Open project",
    description: "Open a project (optionally by path)",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        path: z.string().optional(),
        destination: z
          .enum(["current", "new"])
          .optional()
          .describe(
            "Where the project opens. `new` uses an empty or new window and leaves this one as it is; defaults to `current`. A window already showing the project is brought forward instead."
          ),
      })
      .optional(),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.add", args, ctx, callbacks),
  }));

  // `project.add` with a new-window destination, as its own action: keybindings
  // dispatch without arguments, so this is what one can be bound to (#12594).
  actions.set("project.openInNewWindow", () => ({
    id: "project.openInNewWindow",
    title: "Open project in new window",
    description:
      "Pick a folder and open it in an empty or new window, leaving this window as it is",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.openInNewWindow", args, ctx, callbacks),
  }));

  actions.set("project.openDialog", () => ({
    id: "project.openDialog",
    title: "Pick directory",
    description: "Open a directory picker dialog",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.string().nullable(),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.openDialog", args, ctx, callbacks),
  }));

  actions.set("project.switch", () => ({
    id: "project.switch",
    title: "Switch project",
    description: "Switch to another project",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.switch", args, ctx, callbacks),
  }));

  actions.set("project.update", () => ({
    id: "project.update",
    title: "Update project",
    description:
      "Change a project's stored metadata, such as its display name. This persists immediately and has no undo here, so read the project's current record first rather than overwriting fields blindly.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      projectId: z.string(),
      updates: z.object({
        name: z.string().optional(),
        emoji: z.string().optional(),
        color: z.string().optional(),
        pinned: z.boolean().optional(),
        neverAutoSleep: z.boolean().optional(),
      }),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.update", args, ctx, callbacks),
  }));

  actions.set("project.toggleNeverAutoSleep", () => ({
    id: "project.toggleNeverAutoSleep",
    title: "Never sleep automatically",
    description:
      "Exempt a project from automatic sleep, so the idle background sweep never closes it. Manual Sleep project still works on it. Defaults to the current project; pass enabled to set the exemption explicitly, or omit it to flip the current state. This is unrelated to the system Keep awake setting and to pinning.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: neverAutoSleepArgs,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.toggleNeverAutoSleep", args, ctx, callbacks),
  }));

  actions.set("project.remove", () => ({
    id: "project.remove",
    title: "Remove project",
    description: "Remove a project from the list",
    category: "project",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Removes a project from the list. Worktrees on disk remain but the project entry is lost.",
    argsSchema: z.object({ projectId: z.string() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.remove", args, ctx, callbacks),
  }));

  // Filing: archive and groups. Read-modify on the host, which validates every
  // write and broadcasts it, so these go through the client rather than a
  // renderer store — an agent gets the host's own refusal, not a toast.
  actions.set("project.archive", () => ({
    id: "project.archive",
    title: "Archive project",
    description:
      "File a project away: it leaves the project switcher's main list for a folded Archived section, but keeps its settings, worktrees, pin and group, and still surfaces if one of its agents runs or asks for input. Defaults to the current project. Reverse it with project.unarchive.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.archive", args, ctx, callbacks),
  }));

  actions.set("project.unarchive", () => ({
    id: "project.unarchive",
    title: "Unarchive project",
    description:
      "Bring an archived project back to where it was in the project switcher — its group, or Other projects. Defaults to the current project. Does nothing to a project that isn't archived.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.unarchive", args, ctx, callbacks),
  }));

  actions.set("project.setGroup", () => ({
    id: "project.setGroup",
    title: "Move project to group",
    description:
      "File a project under one of the user's project groups, or pass null for groupId to take it out of its group and back into Other projects. A project sits in at most one group. List the groups first for their ids; an unknown id is refused.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: setGroupArgs,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.setGroup", args, ctx, callbacks),
  }));

  actions.set("project.listGroups", () => ({
    id: "project.listGroups",
    title: "List project groups",
    description:
      "List the user's project groups — the named sections of the project switcher — in the order they appear, with each one's id and sort order. Which projects belong to a group is on each project's own groupId. It never fails: an empty list means no groups exist yet.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      groups: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          position: z.number(),
          sortMode: z.enum(PROJECT_LIST_SORT_MODES),
          createdAt: z.number(),
        })
      ),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.listGroups", args, ctx, callbacks),
  }));

  actions.set("project.createGroup", () => ({
    id: "project.createGroup",
    title: "Create project group",
    description:
      "Create a named project group, shown as its own section of the project switcher after the existing groups. Pass projectId to file that project under it straight away. Names are unique ignoring case; a duplicate or empty name is refused.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: createGroupArgs,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.createGroup", args, ctx, callbacks),
  }));

  actions.set("project.close", () => ({
    id: "project.close",
    title: "Close project",
    description: "Close a project and kill its processes",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.close", args, ctx, callbacks),
  }));

  actions.set("project.closeActive", () => ({
    id: "project.closeActive",
    title: "Close project",
    description: "Close the currently active project and return to the welcome screen",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.closeActive", args, ctx, callbacks),
  }));

  actions.set("project.sleep", () => ({
    id: "project.sleep",
    title: "Sleep project",
    description:
      "Stop a project's terminals to free memory. Its layout, terminal scrollback and agent sessions come back when the project is reopened. Defaults to the current project; sleeping that one returns the window to the project picker. Asks the user to confirm unless the project is in the background with nothing running.",
    category: "project",
    kind: "command",
    danger: "confirm",
    dangerRationale:
      "Stops the project's terminals and agent processes. Layout and sessions are kept for the reopen, but anything running in them is lost.",
    nonRepeatable: true,
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.sleep", args, ctx, callbacks),
  }));

  actions.set("project.restart", () => ({
    id: "project.restart",
    title: "Restart project…",
    description:
      "Restart the project open in this window without restarting the app: its terminals and agents stop, its workspace host is replaced, and it reopens here with its layout, scrollback and agent sessions. Other projects keep running. Defaults to the current project and only accepts that one. Always asks the user to confirm.",
    category: "project",
    kind: "command",
    danger: "confirm",
    dangerRationale:
      "Stops the project's terminals and agent processes before reopening it. Layout and sessions come back, but anything running in them is lost.",
    nonRepeatable: true,
    keywords: ["reload", "relaunch", "recover", "refresh"],
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.restart", args, ctx, callbacks),
  }));

  actions.set("project.sleepIdle", () => ({
    id: "project.sleepIdle",
    title: "Sleep idle projects",
    description:
      "Sleep every background project that has no agent working or waiting on the user and isn't open in a window, after the user confirms a preview naming each one with an estimate of its terminal memory. Takes no arguments. The estimate sums process memory and counts shared pages, so the memory actually freed is lower.",
    category: "project",
    kind: "command",
    danger: "confirm",
    dangerRationale:
      "Stops the terminals of every previewed project. Layout and sessions are kept for the reopen, but anything running in them is lost.",
    nonRepeatable: true,
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.sleepIdle", args, ctx, callbacks),
  }));

  actions.set("project.getAll", () => ({
    id: "project.getAll",
    title: "List projects",
    description:
      "List every project registered in the app, whether or not it is currently open. Use this to discover project ids; ask for the current project instead when all you need is the one the user is working in. It never fails — an empty list means no projects are registered rather than an error.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ projects: z.array(z.unknown()) }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.getAll", args, ctx, callbacks),
  }));

  actions.set("project.getCurrent", () => ({
    id: "project.getCurrent",
    title: "Get current project",
    description:
      "Get the project currently open in the active window, which is what most work should be scoped to. Use the full project listing only when you genuinely need projects the user is not in. It never fails: an empty result means no project is open.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ project: z.unknown().nullable() }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.getCurrent", args, ctx, callbacks),
  }));

  actions.set("project.getSettings", () => ({
    id: "project.getSettings",
    title: "Get project settings",
    description:
      "Read a project's operational settings — run commands, dev server command, worktree naming, forge remote and notification overrides. Dedicated environment-variable, secret and access-control fields are withheld. The command strings themselves come back verbatim though, so treat them as potentially sensitive: a project may have inlined a credential in one.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    resultSchema: z.object(agentVisibleProjectSettingsShape),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.getSettings", args, ctx, callbacks),
  }));

  actions.set("project.saveSettings", () => ({
    id: "project.saveSettings",
    title: "Save project settings",
    description:
      "Persist a project's settings, merging the supplied fields over the stored ones so anything omitted is kept. This writes immediately and has no undo, and settings drive real behaviour such as run commands and worktree naming. The MCP tier and agent-exposure keys are stripped from every write, so setting those reports success and changes nothing.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string(), settings: z.record(z.string(), z.unknown()) }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.saveSettings", args, ctx, callbacks),
  }));

  actions.set("project.muteNotifications", () => ({
    id: "project.muteNotifications",
    title: "Mute project notifications",
    description:
      "Stop a project from raising notifications when its agents finish or need attention, and stop its plugins' notifications too. The user will no longer be prompted for work that is waiting, so anything blocked on them may sit unnoticed. This persists until it is turned back on.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().min(1) }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.muteNotifications", args, ctx, callbacks),
  }));

  actions.set("project.silenceNotificationKind", () => ({
    id: "project.silenceNotificationKind",
    title: "Silence notification kind",
    description: "Suppress a specific category of notifications",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      kind: z.enum(["completed", "waiting", "workingPulse", "uiFeedback"]),
      projectId: z.string().min(1).optional(),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.silenceNotificationKind", args, ctx, callbacks),
  }));

  actions.set("project.detectRunners", () => ({
    id: "project.detectRunners",
    title: "Detect runners",
    description:
      "Detect the runnable commands a project defines from its manifest files, instead of guessing. Returns every script, publish and deploy included, and synthesizes conventional ones for some frameworks; check what a command does before running it.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    resultSchema: z.object({ runners: z.array(z.unknown()) }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.detectRunners", args, ctx, callbacks),
  }));

  actions.set("project.getStats", () => ({
    id: "project.getStats",
    title: "Get project stats",
    description:
      "Get aggregate resource usage for a project — how many processes and terminals it is running and roughly how much memory they consume. Use this to judge whether there is headroom before launching more work. Host process ids are deliberately withheld, so this cannot be used to target individual processes.",
    category: "project",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectId: z.string().optional() }).optional(),
    // Shaped, not open: the previous `z.object({}).catchall(z.unknown())` kept
    // every key, which shipped `ProjectStats.processIds` — live host pids — to
    // any agent that called this. Naming the fields is what strips them, since
    // a catchall opts out of zod's unknown-key stripping entirely (#11539).
    resultSchema: z.object({
      processCount: z.number(),
      terminalCount: z.number(),
      estimatedMemoryMB: z.number(),
      terminalTypes: z.record(z.string(), z.number()),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.getStats", args, ctx, callbacks),
  }));

  actions.set("project.cloneRepo", () => ({
    id: "project.cloneRepo",
    title: "Clone repository",
    description: "Clone a Git repository from a URL",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.cloneRepo", args, ctx, callbacks),
  }));

  actions.set("project.settings.open", () => ({
    id: "project.settings.open",
    title: "Open project settings",
    description: "Open the project settings dialog",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runProjectAction("project.settings.open", args, ctx, callbacks),
  }));
}
