import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { requestHostSwitch } from "@/components/HostSwitch/hostSwitchRequests";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { isSettingsTab } from "@/components/Settings/settingsTabIds";
import { requestHostMenu } from "@/components/Hosts/hostMenuRequests";
import { HOSTS_OVERVIEW_ACTION_ID, HOSTS_SETTINGS_TAB } from "@/components/Hosts/hostModel";
import { requestHostsOverview } from "@/components/Hosts/Overview/hostsOverviewRequests";
import { ClientAppError } from "@/utils/clientAppError";
import { getHostListSnapshot, hasRemoteHosts } from "@/components/Hosts/hostList";

const hostIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('A host id from the host list, or "local" for this machine.');

const switchArgsSchema = z
  .object({
    hostId: hostIdSchema.optional(),
    newWindow: z
      .boolean()
      .optional()
      .describe("Open the host in a new window instead of switching this one."),
  })
  .optional();

const branchSchema = z.string().min(1).max(512);

const openOnHostArgsSchema = z.object({
  hostId: hostIdSchema,
  projectId: z.string().min(1).max(512).describe("The project to open, as this window knows it."),
  newWindow: z
    .boolean()
    .optional()
    .describe("Open the project on the host in a new window instead of this one."),
  worktree: z
    .object({
      newBranch: branchSchema,
      baseBranch: branchSchema,
      fromRemote: z.boolean(),
      useExistingBranch: z.boolean(),
      relativePath: z
        .string()
        .min(1)
        .max(1024)
        .nullable()
        .describe(
          "Where the worktree goes, relative to the project folder; null for the host's pattern."
        ),
      recipeId: z.string().min(1).max(256).nullable(),
    })
    .optional()
    .describe(
      "Create this worktree on the host once the project is there, instead of handing over the current branch."
    ),
});

/** Listed (palette, MCP) only once a host other than this machine exists; dispatch still works. */
function anyRemoteHost(): boolean {
  return hasRemoteHosts(getHostListSnapshot());
}

function openHostsSettings(callbacks: ActionCallbacks): void {
  // The Hosts tab registers only where Remote Hosts exists; until it does,
  // Settings opens on its first page rather than failing.
  const tab: string = HOSTS_SETTINGS_TAB;
  if (isSettingsTab(tab)) callbacks.onOpenSettingsTab({ tab });
  else callbacks.onOpenSettings();
}

async function assertKnownHost(hostId: string): Promise<void> {
  if (hostId === LOCAL_HOST_ID) return;
  const hosts = await window.electron.remoteHosts.list();
  if (!hosts.some((entry) => entry.descriptor.id === hostId)) {
    throw new ClientAppError(
      "NOT_FOUND",
      `No host with id "${hostId}"`,
      "That host isn't in the host list."
    );
  }
}

/**
 * Remote Hosts actions. Registered only where Remote Hosts is supported, so
 * they never reach the palette or the MCP manifest on Windows.
 */
export function registerHostActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("host.switch", () => ({
    id: "host.switch",
    title: "Switch host…",
    description:
      'Switch this window to another machine running Daintree. With no args, opens the host menu. With hostId (from the host list, or "local"), switches directly; newWindow opens it in a new window instead. Fails when the host is not in the list.',
    category: "workspace",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["host", "machine", "remote", "ssh", "server", "switch"],
    nonRepeatable: true,
    isVisible: anyRemoteHost,
    argsSchema: switchArgsSchema,
    run: async (args: unknown) => {
      const parsed = switchArgsSchema.parse(args);
      if (!parsed?.hostId) {
        if (!requestHostMenu()) openHostsSettings(callbacks);
        return;
      }
      await assertKnownHost(parsed.hostId);
      await window.electron.remoteHosts.switchWindowHost({
        hostId: parsed.hostId,
        newWindow: parsed.newWindow ?? false,
      });
    },
  }));

  actions.set("host.add", () => ({
    id: "host.add",
    title: "Add host…",
    description:
      "Open Settings → Hosts to add another machine this one can run projects on over SSH.",
    category: "workspace",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["host", "machine", "remote", "ssh", "server", "add"],
    nonRepeatable: true,
    run: async () => {
      openHostsSettings(callbacks);
    },
  }));

  actions.set(HOSTS_OVERVIEW_ACTION_ID, () => ({
    id: HOSTS_OVERVIEW_ACTION_ID,
    title: "Hosts overview…",
    description:
      "Open the hosts overview: one card per machine with its recent CPU and memory pressure, observed agent counts, open projects, version, link latency, who drives it, and active port forwards. Clicking a card switches this window to that host.",
    category: "workspace",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["host", "hosts", "machine", "remote", "overview", "metrics", "fleet", "ports"],
    nonRepeatable: true,
    isVisible: anyRemoteHost,
    run: async () => {
      if (!requestHostsOverview()) {
        throw new ClientAppError(
          "UNSUPPORTED",
          "No view can show the hosts overview",
          "Couldn't open the hosts overview in this window."
        );
      }
    },
  }));

  // The confirmations live in the dialog: an agent dispatching this gets
  // exactly what a click does — nothing is pushed or cloned until the user
  // picks a step there.
  actions.set("project.openOnHost", () => ({
    id: "project.openOnHost",
    title: "Open project on host…",
    description:
      "Open this window's project on another host through git: the host's own copy is found by the repository's remote URLs (never by name), or cloned there as the host; then a worktree is offered for the current branch, or the given worktree is created. Opens a dialog; every push, clone and worktree is confirmed there.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: anyRemoteHost,
    argsSchema: openOnHostArgsSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const parsed = openOnHostArgsSchema.parse(args);
      await assertKnownHost(parsed.hostId);
      const windowHost = window.__DAINTREE_HOST_ID__?.id ?? LOCAL_HOST_ID;
      if (parsed.hostId === windowHost) {
        throw new ClientAppError(
          "VALIDATION",
          "The project is already on that host",
          "This window is already on that host."
        );
      }
      const worktreePath =
        ctx.projectId === parsed.projectId ? (ctx.activeWorktreePath ?? null) : null;
      const requestId = requestHostSwitch({
        toHostId: parsed.hostId,
        projectId: parsed.projectId,
        worktreePath,
        newWindow: parsed.newWindow ?? false,
        worktree: parsed.worktree ?? null,
      });
      if (requestId === null) {
        throw new ClientAppError(
          "UNSUPPORTED",
          "No view can show the host switch dialog",
          "Couldn't open the host switch dialog in this window."
        );
      }
      return { requestId };
    },
  }));
}
