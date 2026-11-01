import { z } from "zod";
import { Lane } from "../link/frames.js";
import { InteractiveKind } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { safePost, type PortLike } from "../terminal/ports.js";
import { checkRemoteWorktreePortRequest, requiresDriving } from "./requestSchema.js";

/**
 * The worktree RPC port over the link. The renderer's preload client posts
 * `{id, action, payload}` and gets `{id, result}` / `{id, error}` back, plus
 * `{type: "event", event}` pushes; both ends of the link carry those messages
 * unchanged as WORKTREE_PORT frames, so the preload client and the workspace
 * host speak the same protocol they do locally.
 *
 * There is no replay here. A dropped link closes the renderer's port, which
 * fails its pending requests and runs its disconnect handling; the port
 * posted after the next connect runs its ready handling, which refetches.
 *
 * While the view holds no port (a cached view, a reload), the Shell tells the
 * host with a {@link ViewPortStateSchema} message and the host stops sending
 * it events; the view refetches when its next port arrives. An older host
 * fails the message's request check without an id and ignores it.
 */

const requestId = z.union([z.string().min(1).max(256), z.number().int().min(0)]);

const WorktreePortRequestSchema = z.object({
  id: requestId,
  action: z.string().min(1).max(128),
  payload: z.unknown().optional(),
});

const WorktreePortReplySchema = z.union([
  z.looseObject({ id: requestId }),
  z.looseObject({ type: z.literal("event"), event: z.looseObject({ type: z.string().max(256) }) }),
]);

/** Shell → host: whether the view holds a worktree port. Never reaches the workspace host. */
const ViewPortStateSchema = z.strictObject({
  type: z.literal("view-port"),
  open: z.boolean(),
});

const HOST_UNAVAILABLE = "Worktree host is not connected";

function postWorktree(session: LinkSession | null, endpointId: string, message: unknown): boolean {
  if (!session?.isOpen) return false;
  try {
    return (
      session.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.WORKTREE_PORT,
        body: { endpointId, message },
      }) !== "refused"
    );
  } catch {
    return false;
  }
}

export interface WorktreePortHostBridgeOptions {
  endpointId: string;
  /**
   * Connect the endpoint to the project's workspace host; the port arrives
   * through {@link WorktreePortHostBridge.setPort}, now or after a host restart.
   */
  open(projectId: string): void;
  /** Close the endpoint's workspace-host port for good. */
  release(): void;
  /**
   * The root of the endpoint's project, read per request so a project moved
   * or forgotten since the port opened is judged by where it is now.
   */
  resolveProjectRoot(projectId: string): string | null;
  /**
   * Whether this endpoint may change its project now: it holds the lease, or
   * nobody does. Asked per request for those {@link requiresDriving} names.
   * Absent means always.
   */
  mayDrive?(): boolean;
}

const DRIVEN_ELSEWHERE =
  "Another screen has control of this project. Take control to change its worktrees.";

/** Host side: one remote endpoint's port to its project's workspace host. */
export class WorktreePortHostBridge {
  readonly endpointId: string;
  private readonly opts: WorktreePortHostBridgeOptions;
  private port: PortLike | null = null;
  private projectId: string | null = null;
  private session: LinkSession | null = null;
  private sessionCleanup: (() => void)[] = [];
  private opened = false;
  private disposed = false;
  /** Starts true on every session, so a Shell that never reports gets every event. */
  private viewHasPort = true;

  constructor(options: WorktreePortHostBridgeOptions) {
    this.opts = options;
    this.endpointId = options.endpointId;
  }

  get hasPort(): boolean {
    return this.port !== null;
  }

  /** Adopt the workspace host's port (a fresh one after each host restart). */
  setPort(port: PortLike): void {
    if (this.disposed || !this.session) {
      port.close();
      return;
    }
    const previous = this.port;
    this.port = port;
    port.onMessage((message) => {
      if (this.port !== port) return;
      if (!WorktreePortReplySchema.safeParse(message).success) return;
      if (!this.viewHasPort && (message as { type?: unknown }).type === "event") return;
      postWorktree(this.session, this.endpointId, message);
    });
    port.onClose(() => {
      if (this.port === port) this.port = null;
    });
    previous?.close();
  }

  setProject(projectId: string | null): void {
    if (this.disposed || projectId === this.projectId) return;
    this.projectId = projectId;
    if (this.session) this.reopen();
  }

  attach(session: LinkSession): void {
    if (this.disposed || this.session === session) return;
    this.detach();
    this.session = session;
    this.viewHasPort = true;
    this.sessionCleanup = [
      session.on(Lane.INTERACTIVE, InteractiveKind.WORKTREE_PORT, (body) => {
        if (body.endpointId === this.endpointId) this.onClientMessage(body.message);
      }),
      session.onClose(() => {
        if (this.session === session) this.detach();
      }),
    ];
    this.reopen();
  }

  /** Nobody is listening: let the workspace host drop this endpoint's port. */
  detach(): void {
    if (!this.session) return;
    this.session = null;
    for (const cleanup of this.sessionCleanup.splice(0)) cleanup();
    this.closePort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
  }

  private reopen(): void {
    this.closePort();
    if (this.projectId !== null) {
      this.opened = true;
      this.opts.open(this.projectId);
    }
  }

  private closePort(): void {
    const port = this.port;
    this.port = null;
    port?.close();
    if (this.opened) {
      this.opened = false;
      this.opts.release();
    }
  }

  private onClientMessage(raw: unknown): void {
    const viewPort = ViewPortStateSchema.safeParse(raw);
    if (viewPort.success) {
      this.viewHasPort = viewPort.data.open;
      return;
    }
    // Only a port the view holds sends requests, so one also undoes a pause
    // whose resume the Shell's queue refused.
    this.viewHasPort = true;
    // The far end is another machine: nothing reaches the trusted workspace
    // port unless it is a protocol request aimed at this endpoint's project.
    const projectRoot =
      this.projectId === null ? null : this.opts.resolveProjectRoot(this.projectId);
    const checked = checkRemoteWorktreePortRequest(raw, projectRoot);
    if (!checked.ok) {
      if (checked.id !== null) {
        postWorktree(this.session, this.endpointId, { id: checked.id, error: checked.error });
      }
      return;
    }
    if (requiresDriving(checked.request) && this.opts.mayDrive?.() === false) {
      postWorktree(this.session, this.endpointId, {
        id: checked.request.id,
        error: DRIVEN_ELSEWHERE,
      });
      return;
    }
    if (!safePost(this.port, checked.request)) {
      postWorktree(this.session, this.endpointId, {
        id: checked.request.id,
        error: HOST_UNAVAILABLE,
      });
    }
  }
}

export interface WorktreePortClientRelayOptions {
  endpointId: string;
  /**
   * Post the view a fresh worktree port through the usual `worktree-port`
   * delivery and receipt; its far end arrives through
   * {@link WorktreePortClientRelay.setRendererPort}.
   */
  deliver(): void;
  /** Close the view's worktree port, failing its pending requests. */
  close(): void;
}

/** Client side: one remote view's worktree port, relayed to its host. */
export class WorktreePortClientRelay {
  readonly endpointId: string;
  private readonly opts: WorktreePortClientRelayOptions;
  private port: PortLike | null = null;
  private session: LinkSession | null = null;
  private sessionCleanup: (() => void)[] = [];
  private disposed = false;
  /** What the host was last told, as the host bridge assumes at each session's start. */
  private hostSeesPort = true;

  constructor(options: WorktreePortClientRelayOptions) {
    this.opts = options;
    this.endpointId = options.endpointId;
  }

  get isAttached(): boolean {
    return this.session !== null;
  }

  /** The main-held end of the port the view was just given. */
  setRendererPort(port: PortLike): void {
    if (this.disposed) {
      port.close();
      return;
    }
    const previous = this.port;
    this.port = port;
    port.onMessage((message) => {
      if (this.port === port) this.onRendererMessage(message);
    });
    port.onClose(() => {
      if (this.port !== port) return;
      this.port = null;
      this.reportPort(false);
    });
    previous?.close();
    // Before the view holds its end, so the host resumes ahead of its first request.
    this.reportPort(true);
  }

  attach(session: LinkSession): void {
    if (this.disposed || this.session === session) return;
    this.detach();
    this.session = session;
    this.sessionCleanup = [
      session.on(Lane.INTERACTIVE, InteractiveKind.WORKTREE_PORT, (body) => {
        if (body.endpointId !== this.endpointId) return;
        if (!WorktreePortReplySchema.safeParse(body.message).success) return;
        safePost(this.port, body.message);
      }),
      session.onClose(() => {
        if (this.session === session) this.detach();
      }),
    ];
    this.hostSeesPort = true;
    this.opts.deliver();
    if (this.port === null) this.reportPort(false);
  }

  detach(): void {
    if (!this.session) return;
    this.session = null;
    for (const cleanup of this.sessionCleanup.splice(0)) cleanup();
    this.opts.close();
    // The view's port went with it; a late close event must not stand in for
    // the next session's delivery.
    const port = this.port;
    this.port = null;
    port?.close();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    const port = this.port;
    this.port = null;
    port?.close();
  }

  private reportPort(open: boolean): void {
    if (!this.session || this.hostSeesPort === open) return;
    // A refused report leaves the host as it was: sending everything, or
    // paused until this view's next request.
    if (postWorktree(this.session, this.endpointId, { type: "view-port", open })) {
      this.hostSeesPort = open;
    }
  }

  private onRendererMessage(raw: unknown): void {
    const parsed = WorktreePortRequestSchema.safeParse(raw);
    if (!parsed.success) return;
    if (postWorktree(this.session, this.endpointId, parsed.data)) {
      this.hostSeesPort = true;
    } else {
      safePost(this.port, { id: parsed.data.id, error: HOST_UNAVAILABLE });
    }
  }
}
