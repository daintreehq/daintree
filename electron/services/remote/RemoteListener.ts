import { EventEmitter } from "node:events";
import { createServer, type Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import ipaddr from "ipaddr.js";
import { WebSocket, WebSocketServer } from "ws";
import { REMOTE_GATEWAY_LIMITS } from "../../../shared/types/remote/index.js";
import type { RemoteConnection } from "./RemoteConnection.js";
import type { RemoteTlsIdentity } from "./RemoteTlsIdentityService.js";

export interface RemoteListenerConfig {
  bindAddress: string;
  port: number;
}

export function isAllowedRemoteBindAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  const parsed = ipaddr.parse(address);
  const range = parsed.range();
  return (
    range === "private" || range === "loopback" || range === "linkLocal" || range === "uniqueLocal"
  );
}

export function isRemoteLoopbackAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  return ipaddr.parse(address).range() === "loopback";
}

class WebSocketRemoteConnection implements RemoteConnection {
  readonly id = randomUUID();
  private readonly events = new EventEmitter();

  constructor(
    private readonly socket: WebSocket,
    readonly sourceAddress: string
  ) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.close(1003, "BINARY_NOT_SUPPORTED");
        return;
      }
      this.events.emit("message", data.toString());
    });
    socket.once("close", () => this.events.emit("close"));
    socket.once("error", () => this.events.emit("close"));
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  send(data: string): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data);
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(code, reason.slice(0, 123));
  }

  onMessage(listener: (data: string) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  onClose(listener: () => void): () => void {
    this.events.on("close", listener);
    return () => this.events.off("close", listener);
  }
}

export class RemoteListener {
  private server: HttpsServer | null = null;
  private webSockets: WebSocketServer | null = null;
  private connectionHandler: ((connection: RemoteConnection) => void) | null = null;

  onConnection(handler: (connection: RemoteConnection) => void): void {
    this.connectionHandler = handler;
  }

  async start(config: RemoteListenerConfig, tls: RemoteTlsIdentity): Promise<number> {
    if (this.server) throw new Error("Remote listener is already running");
    if (!isAllowedRemoteBindAddress(config.bindAddress)) {
      throw new Error("Remote listener requires an explicit private or loopback IP address");
    }
    const server = createServer({
      cert: tls.certificate,
      key: tls.privateKey,
      minVersion: "TLSv1.3",
    });
    const webSockets = new WebSocketServer({
      server,
      perMessageDeflate: false,
      maxPayload: REMOTE_GATEWAY_LIMITS.maxFrameBytes,
      clientTracking: true,
    });
    this.server = server;
    this.webSockets = webSockets;
    webSockets.on("connection", (socket, request) => {
      if (webSockets.clients.size > REMOTE_GATEWAY_LIMITS.maxConcurrentConnections) {
        socket.close(4008, "CONNECTION_LIMIT_REACHED");
        return;
      }
      const sourceAddress = request.socket.remoteAddress ?? "unknown";
      this.connectionHandler?.(new WebSocketRemoteConnection(socket, sourceAddress));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.bindAddress);
    }).catch((error) => {
      this.server = null;
      this.webSockets = null;
      webSockets.close();
      server.close();
      throw error;
    });

    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Remote listener address unavailable");
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const webSockets = this.webSockets;
    this.server = null;
    this.webSockets = null;
    if (!server || !webSockets) return;
    for (const socket of webSockets.clients) socket.close(1001, "host-shutdown");
    await Promise.all([
      new Promise<void>((resolve) => webSockets.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  }

  isRunning(): boolean {
    return this.server !== null;
  }
}
