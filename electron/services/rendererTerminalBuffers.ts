// Renderer xterm buffer estimates across every resident project view (#14213).
// Sampled only when someone asks (the memory popover, a diagnostics export):
// active views are sent `window:sample-terminal-buffers` and given a bounded
// wait; cached views are never asked — a frozen renderer would not answer and
// waking one to count lines defeats caching — so they report the counts they
// pushed on the way into the cache, or `unavailable`, never a zero.

import type { WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import type { HandlerDependencies } from "../ipc/types.js";
import { estimateTerminalBufferBytes } from "../../shared/config/terminalBufferMemory.js";
import type {
  RendererTerminalBufferEntry,
  RendererTerminalBufferSlice,
  RendererTerminalBufferView,
} from "../../shared/types/memoryAccounting.js";
import {
  getRendererTerminalBufferSample,
  waitForRendererTerminalBufferSample,
} from "./RendererTerminalDiagnosticsCache.js";

/** How long an active view gets to answer before its last-known counts are used. */
export const RENDERER_BUFFER_SAMPLE_TIMEOUT_MS = 1_000;

/**
 * A sample this recent is reused instead of asking again, so the popover's 4s
 * poll and a diagnostics export landing together cost one round-trip per view.
 */
export const RENDERER_BUFFER_SAMPLE_REUSE_MS = 5_000;

// Coalesces concurrent requests to the same view.
const inflight = new Map<number, Promise<void>>();
// Last time each view was asked, so a view that never answers isn't re-asked
// on every poll either.
const lastRequestedAt = new Map<number, number>();

interface ResidentView {
  windowId: number | null;
  projectId: string;
  state: "loading" | "active" | "cached";
  webContents: WebContents;
}

export type RendererViewSource = Pick<HandlerDependencies, "windowRegistry" | "projectViewManager">;

function listResidentViews(deps: RendererViewSource): ResidentView[] {
  const managers: Array<{
    windowId: number | null;
    pvm: NonNullable<HandlerDependencies["projectViewManager"]>;
  }> = [];
  for (const ctx of deps.windowRegistry?.all() ?? []) {
    const pvm = ctx.services.projectViewManager;
    if (pvm) managers.push({ windowId: ctx.windowId, pvm });
  }
  if (managers.length === 0 && deps.projectViewManager) {
    managers.push({ windowId: null, pvm: deps.projectViewManager });
  }

  const views: ResidentView[] = [];
  for (const { windowId, pvm } of managers) {
    try {
      for (const entry of pvm.getAllViews()) {
        const wc = entry.view.webContents;
        if (!wc || wc.isDestroyed()) continue;
        views.push({ windowId, projectId: entry.projectId, state: entry.state, webContents: wc });
      }
    } catch {
      // A PVM mid-teardown must not erase every other window's views.
    }
  }
  return views;
}

function requestSample(wc: WebContents, now: number): Promise<void> {
  const id = wc.id;
  const pending = inflight.get(id);
  if (pending) return pending;
  const last = lastRequestedAt.get(id);
  if (last !== undefined && now - last >= 0 && now - last < RENDERER_BUFFER_SAMPLE_REUSE_MS) {
    return Promise.resolve();
  }
  lastRequestedAt.set(id, now);
  const wait = waitForRendererTerminalBufferSample(id, RENDERER_BUFFER_SAMPLE_TIMEOUT_MS);
  try {
    wc.send(CHANNELS.EVENTS_PUSH, {
      name: "window:sample-terminal-buffers",
      payload: { requestId: `buffers-${now.toString(36)}` },
    });
  } catch {
    // The wait still settles on its deadline; last-known counts stand in.
  }
  const promise = wait.finally(() => {
    inflight.delete(id);
  });
  inflight.set(id, promise);
  return promise;
}

function isRecent(sampledAt: number | undefined, now: number): boolean {
  if (sampledAt === undefined) return false;
  const age = now - sampledAt;
  return age >= 0 && age < RENDERER_BUFFER_SAMPLE_REUSE_MS;
}

/**
 * Pure projection of the stored samples onto the resident views — the seam
 * unit tests exercise. `freshIds` are the active views whose counts are
 * recent enough to call current.
 */
export function composeRendererTerminalBufferSlice(
  views: Array<Omit<ResidentView, "webContents"> & { webContentsId: number }>,
  freshIds: ReadonlySet<number>,
  now: number
): RendererTerminalBufferSlice {
  let total = 0;
  let anyCounts = false;
  let complete = true;
  const out: RendererTerminalBufferView[] = [];
  for (const view of views) {
    const sample = getRendererTerminalBufferSample(view.webContentsId);
    if (!sample) {
      complete = false;
      out.push({
        webContentsId: view.webContentsId,
        windowId: view.windowId,
        projectId: view.projectId,
        state: view.state,
        status: "unavailable",
        sampledAt: null,
        ageMs: null,
        estimatedBytes: null,
        terminals: null,
      });
      continue;
    }
    let viewBytes = 0;
    const terminals: RendererTerminalBufferEntry[] = sample.terminals.map((t) => {
      const estimatedBytes = estimateTerminalBufferBytes(t.normalLines + t.alternateLines, t.cols);
      viewBytes += estimatedBytes;
      return { ...t, estimatedBytes };
    });
    total += viewBytes;
    anyCounts = true;
    out.push({
      webContentsId: view.webContentsId,
      windowId: view.windowId,
      projectId: view.projectId,
      state: view.state,
      status: view.state === "active" && freshIds.has(view.webContentsId) ? "fresh" : "last-known",
      sampledAt: sample.sampledAt,
      ageMs: Math.max(0, now - sample.sampledAt),
      estimatedBytes: viewBytes,
      terminals,
    });
  }
  return {
    views: out,
    estimatedBytes: anyCounts || out.length === 0 ? total : null,
    complete,
  };
}

/**
 * Ask every active view for its buffer counts (bounded, coalesced, reused for
 * {@link RENDERER_BUFFER_SAMPLE_REUSE_MS}) and project the result over all
 * resident views. Never rejects.
 */
export async function collectRendererTerminalBuffers(
  deps: RendererViewSource
): Promise<RendererTerminalBufferSlice> {
  const views = listResidentViews(deps);
  const resident = new Set(views.map((v) => v.webContents.id));
  for (const id of lastRequestedAt.keys()) {
    if (!resident.has(id)) lastRequestedAt.delete(id);
  }
  const requestedAt = Date.now();
  await Promise.all(
    views
      .filter((v) => v.state === "active")
      .filter(
        (v) => !isRecent(getRendererTerminalBufferSample(v.webContents.id)?.sampledAt, requestedAt)
      )
      .map((v) => requestSample(v.webContents, requestedAt))
  );
  const now = Date.now();
  const freshIds = new Set<number>();
  for (const v of views) {
    if (
      v.state === "active" &&
      isRecent(getRendererTerminalBufferSample(v.webContents.id)?.sampledAt, now)
    ) {
      freshIds.add(v.webContents.id);
    }
  }
  return composeRendererTerminalBufferSlice(
    views.map(({ webContents, ...rest }) => ({ ...rest, webContentsId: webContents.id })),
    freshIds,
    now
  );
}

/** Drop request bookkeeping so tests stay isolated. */
export function _resetRendererTerminalBuffersForTesting(): void {
  inflight.clear();
  lastRequestedAt.clear();
}
