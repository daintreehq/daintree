import type net from "node:net";
import { z } from "zod";
import type { HostListeningPort } from "../../../shared/types/ipc/portForwards.js";
import type { LinkSession } from "../link/session.js";
import { scanHostListeners } from "./listenerScan.js";
import {
  PortLinkMethod,
  PreviewResolutionSchema,
  ResolvePreviewPayloadSchema,
  type PreviewResolution,
} from "./linkMethods.js";
import { connectLoopback, PortStreamMux } from "./streamForwarder.js";

export interface HostPortSessionFeed {
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

export interface HostPortServiceOptions {
  connect?: (port: number) => Promise<net.Socket>;
  scan?: () => Promise<HostListeningPort[]>;
  resolvePreview?: (subdomain: string) => Promise<PreviewResolution>;
}

const LISTENER_CACHE_MS = 2_000;

/**
 * Host side of port forwarding: every Shell session may open streams to this
 * machine's loopback, list what is listening here, and ask which dev server a
 * preview subdomain maps to. Streams die with their session.
 */
export function installHostPortService(
  feed: HostPortSessionFeed,
  options: HostPortServiceOptions = {}
): () => void {
  const connect = options.connect ?? ((port: number) => connectLoopback(port));
  const scan = options.scan ?? (() => scanHostListeners());
  const resolvePreview =
    options.resolvePreview ??
    (async (subdomain: string) => {
      const { resolveLocalDevPreviewUpstream } = await import("../../ipc/handlers/devPreview.js");
      return PreviewResolutionSchema.parse(resolveLocalDevPreviewUpstream(subdomain));
    });
  const live = new Set<{ dispose(): void }>();
  let cached: { at: number; result: Promise<HostListeningPort[]> } | null = null;

  const listListeners = (): Promise<HostListeningPort[]> => {
    const now = Date.now();
    if (cached && now - cached.at < LISTENER_CACHE_MS) return cached.result;
    const result = scan();
    cached = { at: now, result };
    result.catch(() => {
      if (cached?.result === result) cached = null;
    });
    return result;
  };

  const attach = (session: LinkSession): void => {
    if (session.isClosed) return;
    const mux = new PortStreamMux(session, { connect });
    const disposers = [
      session.registerCallHandler(PortLinkMethod.LIST_LISTENERS, z.null(), () => listListeners()),
      session.registerCallHandler(
        PortLinkMethod.RESOLVE_PREVIEW,
        ResolvePreviewPayloadSchema,
        ({ subdomain }) => resolvePreview(subdomain)
      ),
    ];
    const entry = {
      dispose() {
        live.delete(entry);
        for (const dispose of disposers.splice(0)) dispose();
        mux.dispose();
      },
    };
    live.add(entry);
    session.onClose(() => entry.dispose());
  };

  const unsubscribe = feed.onSession(({ session }) => attach(session));
  return () => {
    unsubscribe();
    for (const entry of [...live]) entry.dispose();
    cached = null;
  };
}
