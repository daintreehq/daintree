import {
  isLocalHostId,
  parseHostScopedKey,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { getRemoteService } from "../../remote/runtime.js";
import type {
  PaneCorrectionContext,
  PaneProjectInfo,
  PaneScope,
  PaneStartContext,
} from "./paneContext.js";

export interface HostPaneReadOptions {
  /** How long this Shell waits; the host is asked to answer inside it. */
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * The Shell's reads of a pane in one of its views of a host's project. Each
 * resolves to null when the host has no session, is too old to answer, or
 * doesn't answer in time: dictation then goes on without that context.
 */
export interface HostPaneContextReader {
  readStart(
    hostId: HostId,
    scope: PaneScope,
    options: HostPaneReadOptions
  ): Promise<PaneStartContext | null>;
  readCorrection(
    hostId: HostId,
    scope: PaneScope,
    options: HostPaneReadOptions
  ): Promise<PaneCorrectionContext | null>;
  /** Per description, in order. */
  findFileCandidates(
    hostId: HostId,
    scope: PaneScope,
    descriptions: readonly string[],
    options: HostPaneReadOptions
  ): Promise<string[][] | null>;
  readProject(
    hostId: HostId,
    projectId: string,
    options: HostPaneReadOptions
  ): Promise<PaneProjectInfo | null>;
}

declare module "../../remote/runtime.js" {
  interface RemoteServices {
    voicePaneHosts: HostPaneContextReader;
  }
}

export interface HostPane {
  hostId: HostId;
  /** The project as the host knows it. */
  projectId: string;
}

/**
 * The host a view's project lives on, from the view's own key; null for a
 * project on this machine and for a view with none. Its panes are the
 * host's, so nothing about them can be read here.
 */
export function hostPaneOf(viewProjectKey: string | null): HostPane | null {
  if (!viewProjectKey) return null;
  const { hostId, projectId } = parseHostScopedKey(viewProjectKey);
  return isLocalHostId(hostId) ? null : { hostId, projectId };
}

// The reader passes the deadline to the link too; this keeps a reader that
// overruns it from holding up dictation.
async function withinHostDeadline<T>(
  read: (reader: HostPaneContextReader) => Promise<T | null>,
  { timeoutMs, signal }: HostPaneReadOptions
): Promise<T | null> {
  const reader = getRemoteService("voicePaneHosts");
  if (!reader || signal?.aborted) return null;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const gaveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref();
      onAbort = () => resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([read(reader).catch(() => null), gaveUp]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function scopeOf(pane: HostPane, terminalId: string | undefined): PaneScope {
  return { projectId: pane.projectId, terminalId: terminalId ?? null };
}

export function readHostPaneStart(
  pane: HostPane,
  terminalId: string | undefined,
  options: HostPaneReadOptions
): Promise<PaneStartContext | null> {
  return withinHostDeadline(
    (reader) => reader.readStart(pane.hostId, scopeOf(pane, terminalId), options),
    options
  );
}

export function readHostPaneCorrection(
  pane: HostPane,
  terminalId: string | undefined,
  options: HostPaneReadOptions
): Promise<PaneCorrectionContext | null> {
  return withinHostDeadline(
    (reader) => reader.readCorrection(pane.hostId, scopeOf(pane, terminalId), options),
    options
  );
}

export function findHostPaneFileCandidates(
  pane: HostPane,
  terminalId: string | undefined,
  descriptions: readonly string[],
  options: HostPaneReadOptions
): Promise<string[][] | null> {
  return withinHostDeadline(
    (reader) =>
      reader.findFileCandidates(pane.hostId, scopeOf(pane, terminalId), descriptions, options),
    options
  );
}

export function readHostPaneProject(
  pane: HostPane,
  options: HostPaneReadOptions
): Promise<PaneProjectInfo | null> {
  return withinHostDeadline(
    (reader) => reader.readProject(pane.hostId, pane.projectId, options),
    options
  );
}
