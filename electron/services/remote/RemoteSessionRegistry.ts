import { randomUUID } from "node:crypto";
import {
  REMOTE_GATEWAY_LIMITS,
  type RemoteCapability,
} from "../../../shared/types/remote/index.js";
import type { RemoteSessionPolicySink } from "./RemoteCapabilityService.js";
import type { RemoteConnection } from "./RemoteConnection.js";

export type RemoteSessionState = "connected" | "authenticated" | "ready" | "closed";

export interface RemoteSession {
  id: string;
  connection: RemoteConnection;
  state: RemoteSessionState;
  deviceId: string | null;
  capabilities: RemoteCapability[];
  subscriptions: Map<string, RemoteConsoleStreamState>;
  pendingSubscriptions: Set<string>;
  requestTimes: number[];
}

export interface RemoteDeviceSessionSummary {
  deviceId: string;
  activeSessions: number;
  activeSubscriptions: number;
}

interface RemoteConsoleStreamState {
  unacknowledgedBytes: number;
  highestSentSeq: number;
  lastAck: number;
  frames: Array<{ seq: number; bytes: number }>;
}

export type ConsoleOutputTrackingResult = "tracked" | "missing" | "invalid-sequence" | "overflow";

export class RemoteSessionRegistry implements RemoteSessionPolicySink {
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly deviceLaunchTimes = new Map<string, number[]>();
  private readonly consoleStreamRemovedListeners = new Set<
    (connectionId: string, streamId: string) => void
  >();
  private readonly sessionRemovedListeners = new Set<(connectionId: string) => void>();
  private readonly sessionReadyListeners = new Set<(session: RemoteSession) => void>();

  create(connection: RemoteConnection): RemoteSession {
    const session: RemoteSession = {
      id: randomUUID(),
      connection,
      state: "connected",
      deviceId: null,
      capabilities: [],
      subscriptions: new Map(),
      pendingSubscriptions: new Set(),
      requestTimes: [],
    };
    this.sessions.set(connection.id, session);
    return session;
  }

  get(connectionId: string): RemoteSession | null {
    return this.sessions.get(connectionId) ?? null;
  }

  authenticate(
    connectionId: string,
    deviceId: string,
    capabilities: RemoteCapability[]
  ): RemoteSession {
    const session = this.require(connectionId);
    const activeDevices = new Set(
      [...this.sessions.values()]
        .filter((item) => item.state !== "closed" && item.deviceId !== null)
        .map((item) => item.deviceId)
    );
    if (
      !activeDevices.has(deviceId) &&
      activeDevices.size >= REMOTE_GATEWAY_LIMITS.maxConcurrentDevices
    ) {
      throw new Error("Maximum concurrent remote devices reached");
    }
    const deviceSessions = [...this.sessions.values()].filter(
      (item) => item.state !== "closed" && item.deviceId === deviceId
    ).length;
    if (deviceSessions >= REMOTE_GATEWAY_LIMITS.maxSessionsPerDevice) {
      throw new Error("Maximum sessions for remote device reached");
    }
    session.deviceId = deviceId;
    session.capabilities = [...capabilities];
    session.state = "authenticated";
    return session;
  }

  markReady(connectionId: string): RemoteSession {
    const session = this.require(connectionId);
    if (session.state !== "authenticated") throw new Error("Remote session is not authenticated");
    session.state = "ready";
    for (const listener of this.sessionReadyListeners) listener(session);
    return session;
  }

  remove(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    session.state = "closed";
    for (const streamId of session.subscriptions.keys()) {
      this.notifyConsoleStreamRemoved(connectionId, streamId);
    }
    session.subscriptions.clear();
    session.pendingSubscriptions.clear();
    this.sessions.delete(connectionId);
    for (const listener of this.sessionRemovedListeners) listener(connectionId);
  }

  closeAll(reason = "host-shutdown"): void {
    for (const session of [...this.sessions.values()]) {
      session.connection.close(1001, reason);
      this.remove(session.connection.id);
    }
  }

  closeDeviceSessions(deviceId: string, reason: "device-revoked"): void {
    for (const session of [...this.sessions.values()]) {
      if (session.deviceId !== deviceId) continue;
      session.connection.close(4003, reason);
      this.remove(session.connection.id);
    }
  }

  disconnectDeviceSessions(deviceId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.deviceId !== deviceId) continue;
      session.connection.close(4003, "policy-changed");
      this.remove(session.connection.id);
    }
  }

  disconnectAllDevices(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.deviceId === null) continue;
      session.connection.close(4003, "policy-changed");
      this.remove(session.connection.id);
    }
  }

  deviceSummaries(): RemoteDeviceSessionSummary[] {
    const summaries = new Map<string, RemoteDeviceSessionSummary>();
    for (const session of this.sessions.values()) {
      if (session.deviceId === null || session.state === "closed") continue;
      const summary = summaries.get(session.deviceId) ?? {
        deviceId: session.deviceId,
        activeSessions: 0,
        activeSubscriptions: 0,
      };
      summary.activeSessions += 1;
      summary.activeSubscriptions += session.subscriptions.size;
      summaries.set(session.deviceId, summary);
    }
    return [...summaries.values()];
  }

  deviceCapabilitiesChanged(deviceId: string, capabilities: RemoteCapability[]): void {
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId) session.capabilities = [...capabilities];
    }
  }

  size(): number {
    return this.sessions.size;
  }

  readySessions(): RemoteSession[] {
    return [...this.sessions.values()].filter((session) => session.state === "ready");
  }

  consumeDeviceLaunch(deviceId: string, now: number, windowMs: number, limit: number): boolean {
    const timestamps = this.deviceLaunchTimes.get(deviceId) ?? [];
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0]! <= cutoff) timestamps.shift();
    if (timestamps.length >= limit) return false;
    timestamps.push(now);
    this.deviceLaunchTimes.set(deviceId, timestamps);
    return true;
  }

  isDeviceLaunchWithinRate(
    deviceId: string,
    now: number,
    windowMs: number,
    limit: number
  ): boolean {
    const timestamps = this.deviceLaunchTimes.get(deviceId) ?? [];
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0]! <= cutoff) timestamps.shift();
    if (timestamps.length === 0) this.deviceLaunchTimes.delete(deviceId);
    else this.deviceLaunchTimes.set(deviceId, timestamps);
    return timestamps.length > 0 && timestamps.length <= limit;
  }

  reserveConsoleSubscription(connectionId: string, requestId: string): boolean {
    const session = this.require(connectionId);
    if (
      session.subscriptions.size + session.pendingSubscriptions.size >=
      REMOTE_GATEWAY_LIMITS.maxConsoleSubscriptionsPerSession
    ) {
      return false;
    }
    session.pendingSubscriptions.add(requestId);
    return true;
  }

  registerConsoleStream(connectionId: string, requestId: string, streamId: string): boolean {
    const session = this.require(connectionId);
    if (!session.pendingSubscriptions.delete(requestId)) return false;
    session.subscriptions.set(streamId, {
      unacknowledgedBytes: 0,
      highestSentSeq: -1,
      lastAck: -1,
      frames: [],
    });
    return true;
  }

  cancelConsoleSubscription(connectionId: string, requestId: string): void {
    this.sessions.get(connectionId)?.pendingSubscriptions.delete(requestId);
  }

  removeConsoleStream(connectionId: string, streamId: string): void {
    const session = this.require(connectionId);
    if (!session.subscriptions.delete(streamId)) return;
    this.notifyConsoleStreamRemoved(connectionId, streamId);
  }

  onConsoleStreamRemoved(listener: (connectionId: string, streamId: string) => void): () => void {
    this.consoleStreamRemovedListeners.add(listener);
    return () => this.consoleStreamRemovedListeners.delete(listener);
  }

  onSessionRemoved(listener: (connectionId: string) => void): () => void {
    this.sessionRemovedListeners.add(listener);
    return () => this.sessionRemovedListeners.delete(listener);
  }

  onSessionReady(listener: (session: RemoteSession) => void): () => void {
    this.sessionReadyListeners.add(listener);
    return () => this.sessionReadyListeners.delete(listener);
  }

  trackConsoleOutput(connectionId: string, streamId: string, seq: number, bytes: number): boolean {
    return this.trackConsoleOutputResult(connectionId, streamId, seq, bytes) === "tracked";
  }

  trackConsoleOutputResult(
    connectionId: string,
    streamId: string,
    seq: number,
    bytes: number
  ): ConsoleOutputTrackingResult {
    const stream = this.require(connectionId).subscriptions.get(streamId);
    if (!stream) return "missing";
    if (seq <= stream.highestSentSeq) return "invalid-sequence";
    if (stream.unacknowledgedBytes + bytes > REMOTE_GATEWAY_LIMITS.maxQueuedBytes) {
      return "overflow";
    }
    stream.highestSentSeq = seq;
    stream.unacknowledgedBytes += bytes;
    stream.frames.push({ seq, bytes });
    return "tracked";
  }

  acknowledgeConsoleOutput(connectionId: string, streamId: string, ack: number): boolean {
    const stream = this.require(connectionId).subscriptions.get(streamId);
    if (!stream || ack < stream.lastAck || ack > stream.highestSentSeq) return false;
    stream.lastAck = ack;
    while (stream.frames.length > 0 && stream.frames[0]!.seq <= ack) {
      stream.unacknowledgedBytes -= stream.frames.shift()!.bytes;
    }
    return true;
  }

  clearRateLimits(): void {
    this.deviceLaunchTimes.clear();
  }

  private require(connectionId: string): RemoteSession {
    const session = this.sessions.get(connectionId);
    if (!session) throw new Error("Remote session not found");
    return session;
  }

  private notifyConsoleStreamRemoved(connectionId: string, streamId: string): void {
    for (const listener of this.consoleStreamRemovedListeners) listener(connectionId, streamId);
  }
}
