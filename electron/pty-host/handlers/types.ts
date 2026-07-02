import type { MessagePort } from "node:worker_threads";
import type { PtyManager } from "../../services/PtyManager.js";
import type { PtyPool } from "../../services/PtyPool.js";
import type { AnalysisWorkerPool } from "../../services/pty/analysis/AnalysisWorkerPool.js";
import type { ProcessTreeCache } from "../../services/ProcessTreeCache.js";
import type { TerminalResourceMonitor } from "../../services/pty/TerminalResourceMonitor.js";
import type { PtyHostEvent } from "../../../shared/types/pty-host.js";
import type { SharedRingBuffer, PacketFramer } from "../../../shared/utils/SharedRingBuffer.js";
import type {
  BackpressureManager,
  IpcQueueManager,
  PortBatcher,
  PortQueueManager,
  PtyPauseCoordinator,
  ResourceGovernor,
} from "../index.js";

export interface RendererConnection {
  port: MessagePort;
  handler: (e: MessageEvent) => void;
  portQueueManager: PortQueueManager;
  batcher: PortBatcher;
}

export interface HostContext {
  // Stable references — never reassigned
  ptyManager: PtyManager;
  processTreeCache: ProcessTreeCache;
  terminalResourceMonitor: TerminalResourceMonitor;
  backpressureManager: BackpressureManager;
  ipcQueueManager: IpcQueueManager;
  resourceGovernor: ResourceGovernor;
  packetFramer: PacketFramer;

  // Stable Map/Set references — mutated in place
  pauseCoordinators: Map<string, PtyPauseCoordinator>;
  rendererConnections: Map<number, RendererConnection>;
  windowProjectMap: Map<number, string | null>;
  /**
   * Per-window UI-focused terminal id, pushed from the renderer's
   * `focusedId` (terminalFocusSlice). Read by each window's PortQueueManager
   * and PortBatcher to prioritize the focused terminal under backpressure and
   * batching. `null` (or absent) means no terminal is focused in that window.
   */
  windowFocusedTerminalMap: Map<number, string | null>;
  ipcDataMirrorTerminals: Set<string>;
  /** Analysis worker pool (null when DAINTREE_DISABLE_ANALYSIS_WORKERS=1). */
  analysisWorkerPool: AnalysisWorkerPool | null;

  // Reassignable — backed by getter/setter pairs in the construction site
  // so handlers always see the current value after init-buffers reassigns.
  visualBuffers: SharedRingBuffer[];
  visualSignalView: Int32Array | null;
  analysisBuffer: SharedRingBuffer | null;
  ptyPool: PtyPool | null;
  /**
   * True when the boot-time homedir pool warm was deferred because main
   * signalled an imminent project restore (DAINTREE_PTY_DEFER_POOL_WARM).
   * Consumed (set false) by the first set-active-project / project-switch.
   */
  initialPoolWarmDeferred: boolean;

  // Stable function references
  sendEvent: (event: PtyHostEvent) => void;
  getPauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  getOrCreatePauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  disconnectWindow: (windowId: number, reason: string) => void;
  recomputeActivityTiers: (nextProjectId: string | null) => void;
  tryReplayAndResume: (id: string) => void;
  resumePausedTerminal: (id: string) => void;
  createPortQueueManager: (windowId: number) => PortQueueManager;
  /**
   * Per-paused-terminal held duration aggregated across SAB, IPC, and
   * per-window MessagePort pause sources (oldest still-held start wins).
   * Authoritative for "how long has this been paused?" — the live IPC/port
   * paths keep their start times outside `backpressureManager.pauseStartTimes`.
   */
  getPausedDurationsSnapshot: () => Array<{ terminalId: string; heldDurationMs: number }>;
}

export type PtyHostHandler = (msg: any, ports?: MessagePort[]) => void | Promise<void>;
export type HandlerMap = Record<string, PtyHostHandler>;
