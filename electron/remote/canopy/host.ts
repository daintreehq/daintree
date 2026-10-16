import type { ClientRef } from "../../ipc/endpoint.js";
import { Lane } from "../link/frames.js";
import { EventKind, type LinkClientInfo } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import {
  CANOPY_VIEWER_ENDPOINT_PREFIX,
  CanopyInvokePayloadSchema,
  CanopyLinkMethod,
  CanopyReleasePayloadSchema,
} from "./linkMethods.js";
import type { CanopyViewers } from "./viewer.js";

export interface CanopySessionContext {
  session: LinkSession;
  client: LinkClientInfo;
  sessionId: string;
}

export interface CanopySessionSource {
  readonly sessions: ReadonlyArray<CanopySessionContext>;
  onSession(listener: (ctx: CanopySessionContext) => void): () => void;
}

function clientRefOf(client: LinkClientInfo): ClientRef {
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    platform: client.platform,
    kind: "remote",
    ...(client.deviceId ? { deviceId: client.deviceId } : {}),
  };
}

/**
 * Host side of Canopy for Shells reading this host without a view bound to
 * it. Each Shell's viewer is one panel, served by this host's own Canopy
 * handlers; it lasts as long as the link it was opened on, and a Shell that
 * reconnects says its panel's state again. Its pushes are addressed to the
 * viewer, so the Shell can tell them from its bound views'.
 */
export function installCanopyHostWith(
  server: CanopySessionSource,
  viewers: CanopyViewers
): () => void {
  const wired = new WeakSet<LinkSession>();
  let nextSession = 0;

  const wire = ({ session, client }: CanopySessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    // Per link, not per host session: a resumed link starts its viewers afresh.
    const prefix = `${++nextSession}:`;
    const ref = clientRefOf(client);
    session.registerCallHandler(
      CanopyLinkMethod.INVOKE,
      CanopyInvokePayloadSchema,
      ({ viewerId, channel, args }) =>
        viewers.invoke(
          prefix + viewerId,
          () => ({
            endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + viewerId,
            clientId: client.clientId,
            kind: "remote-view",
            onPush: (pushed, payload) => {
              if (!session.isOpen) return;
              try {
                // A full queue drops this one; the next snapshot replaces it.
                session.post({
                  lane: Lane.EVENTS,
                  kind: EventKind.EVENT,
                  body: {
                    endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + viewerId,
                    channel: pushed,
                    args: [payload],
                  },
                });
              } catch (error) {
                console.warn("[CanopyHost] Couldn't push to a Shell's viewer:", error);
              }
            },
          }),
          ref,
          channel,
          args
        )
    );
    session.registerCallHandler(
      CanopyLinkMethod.RELEASE,
      CanopyReleasePayloadSchema,
      ({ viewerId }) => {
        viewers.close(prefix + viewerId);
        return null;
      }
    );
    session.onClose(() => viewers.closeWhere((key) => key.startsWith(prefix)));
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  return () => {
    offSession();
    viewers.dispose();
  };
}
