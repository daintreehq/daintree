import { DEVICE_ANSWER_ENDPOINT_PREFIX } from "../../ipc/endpoint.js";
import type { WaitingRunView } from "../../services/deviceAnswer/deviceAnswerRuns.js";
import type { DeviceLeaseStanding } from "../../services/deviceAnswer/localDeviceAnswer.js";
import type { LinkClientInfo } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import {
  DeviceAnswerAnswerPayloadSchema,
  DeviceAnswerLinkMethod,
  DeviceAnswerListPayloadSchema,
  type DeviceAnswerListResult,
} from "./linkMethods.js";

/** How long one answer may go on pressing keys here once a Shell asked for it. */
export const HOST_ANSWER_BUDGET_MS = 5_000;

export interface DeviceAnswerSessionContext {
  session: LinkSession;
  client: LinkClientInfo;
}

export interface DeviceAnswerSessionSource {
  readonly sessions: ReadonlyArray<DeviceAnswerSessionContext>;
  onSession(listener: (ctx: DeviceAnswerSessionContext) => void): () => void;
}

export interface DeviceAnswerHostDeps {
  list(): Promise<WaitingRunView[]>;
  answer(request: {
    standing: DeviceLeaseStanding;
    runId: string;
    spawnedAt: number;
    label: string;
    stillAllowed: () => string | null;
  }): Promise<void>;
  now?: () => number;
}

/**
 * Host side of answering from a device paired with an attached Shell. The
 * screens are read and redacted here, and the device's answer stands as that
 * Shell's windows do in this host's drive lease, so it presses nothing where
 * the Shell couldn't type.
 *
 * The Shell's own say (the device still paired, the feature still on) is had
 * before it asks; once asked, what stops the keys is this host's: the link
 * closing, the lease moving, the terminal moving on, or the budget running out.
 */
export function installDeviceAnswerHostWith(
  server: DeviceAnswerSessionSource,
  deps: DeviceAnswerHostDeps
): () => void {
  const now = deps.now ?? Date.now;
  const wired = new WeakSet<LinkSession>();
  const unregisters = new Set<() => void>();
  let nextSession = 0;
  let disposed = false;

  const wire = ({ session, client }: DeviceAnswerSessionContext): void => {
    if (disposed || wired.has(session)) return;
    wired.add(session);
    const standing: DeviceLeaseStanding = {
      endpointId: `${DEVICE_ANSWER_ENDPOINT_PREFIX}${++nextSession}`,
      clientId: client.clientId,
    };
    const offs = [
      session.registerCallHandler(
        DeviceAnswerLinkMethod.LIST,
        DeviceAnswerListPayloadSchema,
        async (): Promise<DeviceAnswerListResult> => ({ runs: await deps.list() })
      ),
      session.registerCallHandler(
        DeviceAnswerLinkMethod.ANSWER,
        DeviceAnswerAnswerPayloadSchema,
        async ({ runId, spawnedAt, label }) => {
          const deadline = now() + HOST_ANSWER_BUDGET_MS;
          await deps.answer({
            standing,
            runId,
            spawnedAt,
            label,
            stillAllowed: () => {
              if (disposed || !session.isOpen) {
                return "The connection to the Shell closed. Nothing more was pressed.";
              }
              if (now() > deadline) return "That took too long. Nothing more was pressed.";
              return null;
            },
          });
          return null;
        }
      ),
    ];
    const unregister = () => {
      for (const off of offs) off();
    };
    unregisters.add(unregister);
    session.onClose(() => {
      unregisters.delete(unregister);
      unregister();
    });
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  return () => {
    disposed = true;
    offSession();
    for (const unregister of unregisters) unregister();
    unregisters.clear();
  };
}
