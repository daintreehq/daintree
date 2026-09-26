import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { actionService } from "@/services/ActionService";
import { isSettingsTab } from "@/components/Settings/settingsTabIds";
import { HOSTS_OVERVIEW_ACTION_ID, HOSTS_SETTINGS_TAB } from "@/components/Hosts/hostModel";
import { getHostListSnapshot, hasRemoteHosts } from "@/components/Hosts/hostList";
import { remoteHostOfView } from "@/services/terminal/remoteLoopbackLinks";
import { ClientAppError } from "@/utils/clientAppError";

const forwardArgsSchema = z
  .object({
    port: z.number().int().min(1).max(65535).describe("The port on the host to forward."),
    hostId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("A host id from the host list. Defaults to this window's host."),
    label: z.string().max(128).optional().describe("A name to show for the forward."),
  })
  .optional();

const forwardResultSchema = z.object({
  forwardId: z.string(),
  hostId: z.string(),
  remotePort: z.number(),
  localPort: z.number(),
});

async function openPortsView(callbacks: ActionCallbacks): Promise<void> {
  // The Ports view lives in the hosts overview; until that is registered,
  // Settings → Hosts is where hosts are managed.
  if (actionService.has(HOSTS_OVERVIEW_ACTION_ID)) {
    const result = await actionService.dispatch(HOSTS_OVERVIEW_ACTION_ID, undefined, {
      source: "user",
    });
    if (result.ok) return;
  }
  const tab: string = HOSTS_SETTINGS_TAB;
  if (isSettingsTab(tab)) callbacks.onOpenSettingsTab({ tab });
  else callbacks.onOpenSettings();
}

/**
 * Port forwarding actions. Registered only where Remote Hosts is supported,
 * and listed only once a host other than this machine exists.
 */
export function registerPortActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("host.forwardPort", () => ({
    id: "host.forwardPort",
    title: "Forward port…",
    description:
      "Forward a port from a remote host so this machine's browser reaches it as localhost. With port, forwards it from hostId (default: this window's host) and returns the local port; with no args, opens the Ports view.",
    category: "workspace",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["port", "forward", "tunnel", "localhost", "remote", "host", "ssh"],
    nonRepeatable: true,
    isVisible: () => hasRemoteHosts(getHostListSnapshot()),
    argsSchema: forwardArgsSchema,
    resultSchema: forwardResultSchema.optional(),
    run: async (args: unknown) => {
      const parsed = forwardArgsSchema.parse(args);
      if (!parsed) {
        await openPortsView(callbacks);
        return undefined;
      }
      const hostId = parsed.hostId ?? remoteHostOfView();
      if (!hostId) {
        throw new ClientAppError(
          "VALIDATION",
          "No hostId given and this window runs on this machine",
          "Choose which host to forward the port from."
        );
      }
      const forward = await window.electron.portForwards.forward({
        hostId,
        remotePort: parsed.port,
        origin: "manual",
        ...(parsed.label ? { label: parsed.label } : {}),
      });
      return {
        forwardId: forward.forwardId,
        hostId: forward.hostId,
        remotePort: forward.remotePort,
        localPort: forward.localPort,
      };
    },
  }));
}
