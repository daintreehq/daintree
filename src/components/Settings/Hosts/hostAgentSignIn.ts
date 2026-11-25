import { canopyHostClient } from "@/clients/canopyHostClient";
import type { CanopyTerminalApi } from "@/components/Canopy/canopyHostSource";
import { getAgentConfig } from "@shared/config/agentRegistry";
import type { HostId } from "@shared/types/remoteHosts";

let nextConsumer = 0;

/** A consumer id for one sign-in: its viewer on the host is its alone. */
export function newSignInConsumer(): string {
  return `sign-in-${Date.now().toString(36)}-${(++nextConsumer).toString(36)}`;
}

/**
 * The command the host runs, as this machine's registry names it, and what to
 * type in the CLI should it open without asking to sign in: what the person
 * sees before it runs. The host resolves its own copy of the CLI, so the path
 * may differ; null for an agent this machine doesn't know.
 */
export function agentSignInLabels(
  agentId: string
): { command: string; prompt: string | null } | null {
  const config = getAgentConfig(agentId);
  if (!config) return null;
  return {
    command: [config.command, ...(config.signInArgs ?? [])].join(" "),
    prompt: config.signInPrompt ?? null,
  };
}

const NO_CLEANUP = () => () => {};

function notTyped(): Promise<never> {
  return Promise.reject(new Error("A sign-in is typed into its terminal."));
}

/**
 * The live pane, pointed at one agent CLI sign-in running on another host
 * (#18196). The host serves its terminal to this consumer alone: the pane
 * watches, types and sizes it through that, and links it prints open on this
 * machine with the host named, so a loopback callback is forwarded from there.
 * A link that drops ends the sign-in on the host, which the stream says as
 * ended; nothing reopens it.
 */
export function hostSignInTerminalApi(hostId: HostId, consumer: string): CanopyTerminalApi {
  const host = canopyHostClient;
  return {
    // The host's watch answer says it takes this pane's size.
    holdsSize: false,
    hostOf: () => hostId,
    watchTerminal: async () =>
      (await host.signInStep(consumer, { op: "watch" })) ?? { watchId: null, snapshot: null },
    unwatchTerminal: async (watchId) => {
      if (watchId === undefined) return;
      await host.signInStep(consumer, { op: "unwatch", watchId });
    },
    terminalInput: async (watchId, data) => {
      await host.signInStep(consumer, { op: "input", watchId, data });
    },
    terminalResize: async (watchId, cols, rows) => {
      await host.signInStep(consumer, { op: "resize", watchId, cols, rows });
    },
    terminalClaimSize: () => Promise.resolve(),
    terminalSubmit: notTyped,
    terminalSendKey: notTyped,
    submitReply: notTyped,
    answer: notTyped,
    onTerminalData: (callback) =>
      host.onEvent((event) => {
        if (event.kind === "sign-in-terminal-data" && event.consumer === consumer) {
          callback(event.chunk);
        }
      }),
    onResync: NO_CLEANUP,
  };
}
