import type { IpcEnvelope } from "../../shared/types/ipc/errors.js";
import type { HostId, HostPlatform } from "../../shared/types/remoteHosts.js";

/**
 * The attached Shell a request or event belongs to. A local window's Shell is
 * the process itself; a remote Shell is one authenticated link session.
 */
export interface ClientRef {
  clientId: string;
  /** Machine name shown to people, e.g. "greg-mbp". */
  clientName: string;
  platform: HostPlatform | "win32";
  kind: "local" | "remote";
}

/** The local Shell of this process. */
export const LOCAL_CLIENT_ID = "local";

/**
 * What a Host pushes to one endpoint. Terminal bytes do not travel as frames;
 * they ride the terminal stream bridge on the interactive lane. Requests that
 * need an answer go through {@link ClientEndpoint.request}.
 */
export type HostFrame = { type: "event"; channel: string; args: unknown[] };

export interface EndpointRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Disposable {
  dispose(): void;
}

/**
 * One renderer attached to this Host: a local project view (wrapping its real
 * `WebContents`) or a remote view (wrapping a link session). Registry,
 * broadcast helpers, port distribution, the worktree broker, MCP targeting and
 * plugin targeting address endpoints, never `WebContents`, so a remote view is
 * reachable wherever a local one is. Real Electron objects exist only inside
 * the local-view adapter.
 */
export interface ClientEndpoint {
  endpointId: string;
  clientId: string;
  projectId: string | null;
  kind: "local-view" | "remote-view";
  /**
   * Stable numeric handle for code that keys state per sender. A local view's
   * handle is its `WebContents` id (positive); a remote view's is negative and
   * never resolves through `webContents.fromId`.
   */
  handle: number;
  send(frame: HostFrame): void;
  /**
   * Server → client request answered by this endpoint's renderer (MCP action
   * dispatch, plugin prompts, consent). The endpoint owns correlation: it
   * validates that the answer came from this endpoint, rejects on timeout or
   * abort, and settles every pending request with a HOST_DISCONNECTED error
   * when it closes. Resolves to the renderer's unwrapped answer. A local view
   * answers through its existing request/response IPC channels; `method`
   * names the request kind (e.g. "mcp:dispatch-action").
   */
  request(method: string, payload: unknown, options?: EndpointRequestOptions): Promise<unknown>;
  onClose(cb: () => void): Disposable;
  isClosed(): boolean;
}

export function isRemoteEndpointHandle(handle: number): boolean {
  return handle < 0;
}

/** Host-side index of every attached endpoint, local and remote. */
export interface EndpointRegistry {
  add(endpoint: ClientEndpoint): void;
  remove(endpointId: string): void;
  get(endpointId: string): ClientEndpoint | undefined;
  getByHandle(handle: number): ClientEndpoint | undefined;
  /** Endpoints bound to a project, for project-scoped broadcasts. */
  getForProject(projectId: string): ClientEndpoint[];
  /** Remote endpoints only; local views are already reached through `WebContents`. */
  getRemote(): ClientEndpoint[];
  rebind(endpointId: string, projectId: string | null): void;
  onChange(cb: () => void): () => void;
}

/**
 * The per-request context a remote invocation is built with. A local
 * invocation still has the real `event`/`senderWindow`; a remote one has
 * neither, and Host code must use `endpoint` to reply or push.
 */
export interface EndpointInvocation {
  endpoint: ClientEndpoint;
  client: ClientRef;
}

export type InvokeListener<Ctx> = (ctx: Ctx, ...args: unknown[]) => unknown;
export type SendListener<Ctx> = (ctx: Ctx, ...args: unknown[]) => void;

/**
 * Client-side routing for a window attached to a remote host. Installed by the
 * remote-hosts module at startup (never imported by core IPC code, so Windows
 * builds carry none of it). The dispatcher consults it for every call from a
 * sender and, when the sender is remote-bound, forwards host channels, keeps
 * shell channels local, and hands hybrid channels to their split.
 */
export interface RemoteRouter {
  /** The host a sender's view is bound to, or null for local senders. */
  hostForSender(webContentsId: number): HostId | null;
  forwardInvoke(
    hostId: HostId,
    webContentsId: number,
    channel: string,
    args: unknown[]
  ): Promise<IpcEnvelope>;
  forwardSend(hostId: HostId, webContentsId: number, channel: string, args: unknown[]): void;
}

/**
 * A hybrid channel's split for a remote-bound sender. `local` runs the
 * channel's own handler in this process and `remote` forwards to the host,
 * each with the original args unless the split passes replacements (a setter
 * splits its payload: device fields stay local, host fields go remote). Both
 * resolve to unwrapped handler values and reject with the reconstructed error;
 * the split returns the merged unwrapped value and the dispatcher wraps it in
 * the envelope once.
 */
export type HybridSplit = (call: {
  hostId: HostId;
  webContentsId: number;
  args: unknown[];
  local: (args?: unknown[]) => Promise<unknown>;
  remote: (channel?: string, args?: unknown[]) => Promise<unknown>;
}) => Promise<unknown>;

/**
 * Transport-independent registry in front of every IPC handler. `ipcMain`
 * feeds it for local views and the link server feeds it for remote ones, so
 * a handler is written once and cannot tell which transport called it apart
 * from the endpoint on its context.
 */
export interface IpcDispatcher<Ctx> {
  registerInvoke(channel: string, listener: InvokeListener<Ctx>): () => void;
  registerSend(channel: string, listener: SendListener<Ctx>): () => void;
  hasInvoke(channel: string): boolean;
  /** Run a handler for a call that arrived over a link. Resolves to the IPC envelope. */
  invokeForEndpoint(
    invocation: EndpointInvocation,
    channel: string,
    args: unknown[]
  ): Promise<IpcEnvelope>;
  sendForEndpoint(invocation: EndpointInvocation, channel: string, args: unknown[]): void;
  setRemoteRouter(router: RemoteRouter | null): void;
  registerHybridSplit(channel: string, split: HybridSplit): () => void;
}
