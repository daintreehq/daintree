import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { isSettingsTab } from "@/components/Settings/settingsTabIds";
import { requestHostMenu } from "@/components/Hosts/hostMenuRequests";
import { HOSTS_SETTINGS_TAB } from "@/components/Hosts/hostModel";
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

const openOnHostArgsSchema = z.object({
  hostId: hostIdSchema,
  projectId: z.string().min(1).max(512).describe("The project to open, as this window knows it."),
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

  // Placeholder until the clone dialog lands: the project switcher opens
  // projects a host already has by switching host directly, and routes every
  // other host here.
  actions.set("project.openOnHost", () => ({
    id: "project.openOnHost",
    title: "Open project on host…",
    description:
      "Open a project on another host, cloning it there first when the host doesn't have it. Not available yet: cloning a project onto another host arrives with the clone dialog.",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: anyRemoteHost,
    argsSchema: openOnHostArgsSchema,
    run: async (args: unknown) => {
      const parsed = openOnHostArgsSchema.parse(args);
      await assertKnownHost(parsed.hostId);
      throw new ClientAppError(
        "UNSUPPORTED",
        "Opening a project on another host needs the clone dialog, which isn't available yet",
        "Cloning a project onto another host isn't available yet."
      );
    },
  }));
}
