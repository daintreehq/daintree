import type { MessagePort } from "node:worker_threads";
import type { PtyManager } from "../../services/PtyManager.js";
import type { PtyPool } from "../../services/PtyPool.js";
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
  ipcDataMirrorTerminals: Set<string>;

  // Reassignable — backed by getter/setter pairs in the construction site
  // so handlers always see the current value after init-buffers reassigns.
  visualBuffers: SharedRingBuffer[];
  visualSignalView: Int32Array | null;
  analysisBuffer: SharedRingBuffer | null;
  ptyPool: PtyPool | null;

  // Stable function references
  sendEvent: (event: PtyHostEvent) => void;
  getPauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  getOrCreatePauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  disconnectWindow: (windowId: number, reason: string) => void;
  recomputeActivityTiers: () => void;
  tryReplayAndResume: (id: string) => void;
  resumePausedTerminal: (id: string) => void;
  createPortQueueManager: (windowId: number) => PortQueueManager;
}

export type PtyHostHandler = (msg: any, ports?: MessagePort[]) => void | Promise<void>;
export type HandlerMap = Record<string, PtyHostHandler>;
