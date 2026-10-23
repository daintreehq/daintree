import type { ClientRef } from "../../ipc/endpoint.js";
import { Lane } from "../link/frames.js";
import { EventKind, InteractiveKind, type LinkClientInfo } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import {
  CANOPY_VIEWER_ENDPOINT_PREFIX,
  CanopyAssistantInvokePayloadSchema,
  CanopyAssistantsPayloadSchema,
  CanopyInvokePayloadSchema,
  CanopyLinkMethod,
  CanopyReleasePayloadSchema,
  type CanopyAssistantsAnswer,
} from "./linkMethods.js";
import type { CanopyViewerParams, CanopyViewers } from "./viewer.js";
import { unreadAgentDirectory, type AgentDirectory } from "../../../shared/types/agentDirectory.js";
import { ASSISTANT_VIEWER_VERSION } from "../../../shared/types/ipc/canopyHost.js";
import { createLogger } from "../../utils/logger.js";
import { createKeyedLogLimiter } from "../../utils/keyedLogLimiter.js";

const logger = createLogger("main:CanopyHost");
const logLimiter = createKeyedLogLimiter();

/** How often, and how far apart, a lost-viewer notice the Shell didn't take is sent again. */
export const VIEWER_LOST_RETRIES = 5;
export const VIEWER_LOST_RETRY_MS = 1_000;

export interface CanopySessionContext {
  session: LinkSession;
  client: LinkClientInfo;
  sessionId: string;
}

export interface CanopySessionSource {
  readonly sessions: ReadonlyArray<CanopySessionContext>;
  onSession(listener: (ctx: CanopySessionContext) => void): () => void;
}

export interface CanopyHostOptions {
  /** This host's agent directory, read when a Shell's picker asks; absent, none is read. */
  readAgents?: (options: {
    projectId?: string;
    assistantsOnly?: boolean;
  }) => Promise<AgentDirectory>;
}

/**
 * A directory's assistants alone, read as it was: a read that missed or cut
 * entries still says so, so the picker never takes it for every assistant.
 */
export function assistantsOf(directory: AgentDirectory): AgentDirectory {
  return {
    ...directory,
    entries: directory.entries.filter((entry) => entry.role === "assistant"),
  };
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
  viewers: CanopyViewers,
  options: CanopyHostOptions = {}
): () => void {
  const wired = new WeakSet<LinkSession>();
  let nextSession = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  const wire = ({ session, client }: CanopySessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    // Per link, not per host session: a resumed link starts its viewers afresh.
    const prefix = `${++nextSession}:`;
    const ref = clientRefOf(client);
    /**
     * A push the Shell never got leaves its panel wrong: a snapshot no later
     * one may replace, or a terminal missing bytes. The viewer is dropped,
     * after the push in progress, and the Shell told to have its panel say
     * its state again, on the request lane rather than the full one.
     */
    const tell = (viewerId: string, attempt: number): void => {
      if (!session.isOpen || disposed) return;
      session.call(CanopyLinkMethod.VIEWER_LOST, { viewerId }).catch(() => {
        // A full request queue isn't a dropped link: say it again while the
        // link is up. The link going down resyncs every reader anyway.
        if (attempt + 1 >= VIEWER_LOST_RETRIES) return;
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            tell(viewerId, attempt + 1);
          },
          VIEWER_LOST_RETRY_MS * (attempt + 1)
        );
        timer.unref?.();
        timers.add(timer);
      });
    };
    const lose = (viewerId: string): void => {
      queueMicrotask(() => {
        if (viewers.close(prefix + viewerId)) tell(viewerId, 0);
      });
    };
    const paramsFor =
      (viewerId: string, interactive: boolean | undefined) => (): CanopyViewerParams => ({
        endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + viewerId,
        clientId: client.clientId,
        onPush: (pushed, payload) => {
          if (!session.isOpen) return;
          const endpointId = CANOPY_VIEWER_ENDPOINT_PREFIX + viewerId;
          let result: string;
          try {
            // Its terminal's bytes take turns with grid panes' output, so
            // busy terminals elsewhere on this host don't hold up its echo.
            result =
              interactive === true && pushed === "canopy:terminal-data"
                ? session.post({
                    lane: Lane.INTERACTIVE,
                    kind: InteractiveKind.CANOPY_TERMINAL,
                    body: { endpointId, channel: pushed, args: [payload] },
                  })
                : session.post({
                    lane: Lane.EVENTS,
                    kind: EventKind.EVENT,
                    body: { endpointId, channel: pushed, args: [payload] },
                  });
          } catch (error) {
            const suppressedCount = logLimiter.take("push-viewer");
            if (suppressedCount !== null) {
              logger.warn("Couldn't push to a Shell's viewer", { error, suppressedCount });
            }
            result = "refused";
          }
          if (result === "refused") lose(viewerId);
        },
      });
    session.registerCallHandler(
      CanopyLinkMethod.INVOKE,
      CanopyInvokePayloadSchema,
      ({ viewerId, channel, args, interactive }) =>
        viewers.invoke(prefix + viewerId, paramsFor(viewerId, interactive), ref, channel, args)
    );
    // A person's assistant viewer: the subject names this host as its own,
    // and this host's own hold on that run answers, never the Shell's word.
    session.registerCallHandler(
      CanopyLinkMethod.ASSISTANT_INVOKE,
      CanopyAssistantInvokePayloadSchema,
      ({ viewerId, channel, args, interactive }) =>
        viewers.invokeAssistant(
          prefix + viewerId,
          paramsFor(viewerId, interactive),
          ref,
          channel,
          args
        )
    );
    session.registerCallHandler(
      CanopyLinkMethod.ASSISTANTS,
      CanopyAssistantsPayloadSchema,
      async ({ projectId }): Promise<CanopyAssistantsAnswer> => {
        const read = options.readAgents;
        const directory = read
          ? await read({
              ...(projectId === undefined ? {} : { projectId }),
              assistantsOnly: true,
            }).catch(() => unreadAgentDirectory("unreachable"))
          : unreadAgentDirectory("unsupported");
        return { version: ASSISTANT_VIEWER_VERSION, directory: assistantsOf(directory) };
      }
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
    disposed = true;
    offSession();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    viewers.dispose();
  };
}
