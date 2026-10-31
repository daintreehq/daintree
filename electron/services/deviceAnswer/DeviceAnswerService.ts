import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  DeviceAnswerAuditEntry,
  DeviceAnswerSettings,
  DeviceAnswerStatus,
  PairedDeviceRecord,
  SetDeviceAnswerPayload,
} from "../../../shared/types/ipc/deviceAnswer.js";
import {
  PairingCodes,
  digestsEqual,
  formatPairingCode,
  hashDeviceToken,
  isAllowedHost,
  isSameOriginRequest,
  newDeviceToken,
  normalizeTailnetHost,
} from "./deviceAuth.js";
import { redactSecrets } from "../redactSecrets.js";
import { DEVICE_PAGE_CSP, DEVICE_PAGE_HTML } from "./deviceAnswerPage.js";
import { MAX_AUDIT_ENTRIES, MAX_PAIRED_DEVICES, isValidPort } from "./deviceAnswerSettings.js";
import { LOCAL_HOST_ID, isLocalHostId } from "../../../shared/types/remoteHosts.js";
import type { DeviceWaitingList } from "./deviceAnswerRuns.js";
import { isQuestionId } from "./questionId.js";
import { sshLoginTarget } from "../../utils/machineName.js";

const MAX_BODY_BYTES = 8 * 1024;
/** How much of an oversized body is read off the socket before it is cut. */
const MAX_DRAINED_BYTES = 256 * 1024;
const MAX_DEVICE_NAME_LENGTH = 60;
/** `lastSeenAt` is written at most this often per device, not on every poll. */
const SEEN_WRITE_INTERVAL_MS = 60_000;
/** Pair attempts the listener takes per minute, across every code, before refusing. */
const PAIR_ATTEMPTS_PER_MINUTE = 10;
/** Answers one device may send per ten seconds. */
const ANSWERS_PER_TEN_SECONDS = 10;

/** The device a request's token belongs to, standing in for it in the drive lease. */
export interface DevicePrincipal {
  id: string;
  name: string;
}

export interface DeviceAnswerServiceDeps {
  readSettings: () => DeviceAnswerSettings;
  writeSettings: (settings: DeviceAnswerSettings) => void;
  /**
   * This machine's waiting runs, with every connected host's when `hosts` is
   * set, each tagged with its machine.
   */
  listWaiting: (options: { hosts: boolean }) => Promise<DeviceWaitingList>;
  /**
   * Press the option labelled `label` in the run on `hostId` (`LOCAL_HOST_ID`
   * for this machine), for `device`, only into the question `questionId` was
   * listed for. Resolves when every key went in; rejects with the reason, in
   * words the page shows, when anything stopped it. `stillAllowed` is the
   * service's own say before every key: the device still paired and the
   * listener still on.
   */
  answer: (request: {
    device: DevicePrincipal;
    hostId: string;
    runId: string;
    spawnedAt: number;
    label: string;
    questionId: string;
    stillAllowed: () => string | null;
  }) => Promise<void>;
  /** A connected host's name for the audit, or null when it isn't in the host list. */
  hostName?: (hostId: string) => string | null;
  onStatusChanged: (status: DeviceAnswerStatus) => void;
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Answer from another device: one page, served on loopback only while the
 * user has it on, that a device they paired reaches through their own tunnel
 * (`tailscale serve`, `ssh -L`). It lists every project's waiting agents with
 * their screens and presses an option a device picks by its label. Off, there
 * is no listener, no timer and no subscription.
 */
export class DeviceAnswerService {
  private server: http.Server | null = null;
  private listeningPort: number | null = null;
  /** The port setting the listener was started for; 0 binds any free port. */
  private configuredPort: number | null = null;
  /**
   * Bumped whenever a listener stops. An answer holds the one it began under,
   * so one begun before an off, a restart or a port change never goes on
   * pressing keys under the listener that replaced it.
   */
  private listenerGeneration = 0;
  /** Quit has begun: nothing starts again and nothing more is pressed. */
  private closed = false;
  private startError: string | null = null;
  private readonly pairing: PairingCodes;
  private pairingExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private pairAttempts: number[] = [];
  private readonly answerTimes = new Map<string, number[]>();
  private readonly seenWrittenAt = new Map<string, number>();
  private readonly now: () => number;
  /** Serializes start/stop, so a quick off-on never leaves two listeners. */
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DeviceAnswerServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.pairing = new PairingCodes(this.now);
  }

  /** Start the listener if the setting is on; nothing at all otherwise. */
  async init(): Promise<void> {
    if (this.deps.readSettings().enabled) await this.sync();
  }

  getStatus(): DeviceAnswerStatus {
    const settings = this.deps.readSettings();
    const pairingUntil = this.pairing.openUntil();
    return {
      enabled: settings.enabled,
      listening: this.server !== null && this.listeningPort !== null,
      port: settings.port,
      tailnetHost: settings.tailnetHost,
      sshTarget: sshLoginTarget(),
      error: settings.enabled ? this.startError : null,
      pairing:
        pairingUntil !== null && this.openCode !== null
          ? { code: formatPairingCode(this.openCode), expiresAt: pairingUntil }
          : null,
      devices: settings.devices.map(({ tokenHash: _tokenHash, ...device }) => device),
      recentAnswers: settings.answers,
    };
  }

  async setEnabled(payload: SetDeviceAnswerPayload): Promise<DeviceAnswerStatus> {
    const settings = this.deps.readSettings();
    const next: DeviceAnswerSettings = { ...settings, enabled: payload.enabled };
    if (payload.port !== undefined) {
      if (!isValidPort(payload.port)) throw new Error("Choose a port from 1024 to 65535.");
      next.port = payload.port;
    }
    if (payload.tailnetHost !== undefined) {
      if (payload.tailnetHost === null || payload.tailnetHost.trim() === "") {
        next.tailnetHost = null;
      } else {
        const host = normalizeTailnetHost(payload.tailnetHost);
        if (host === null) throw new Error("That isn't a host name, like mac.tail1234.ts.net.");
        next.tailnetHost = host;
      }
    }
    this.deps.writeSettings(next);
    if (!next.enabled) this.cancelPairing();
    await this.sync();
    return this.publish();
  }

  /** Open a pairing code for the next device; replaces one already open. */
  createPairingCode(): DeviceAnswerStatus {
    const settings = this.deps.readSettings();
    if (!settings.enabled || this.server === null) {
      throw new Error("Turn on answering from another device first.");
    }
    if (settings.devices.length >= MAX_PAIRED_DEVICES) {
      throw new Error(`Remove a device first; up to ${MAX_PAIRED_DEVICES} can be paired.`);
    }
    const { code, expiresAt } = this.pairing.issue();
    this.openCode = code;
    this.armPairingExpiry(expiresAt);
    return this.publish();
  }

  cancelPairingCode(): DeviceAnswerStatus {
    this.cancelPairing();
    return this.publish();
  }

  revokeDevice(deviceId: string): DeviceAnswerStatus {
    const settings = this.deps.readSettings();
    const devices = settings.devices.filter((d) => d.id !== deviceId);
    if (devices.length !== settings.devices.length) {
      this.deps.writeSettings({ ...settings, devices });
      this.answerTimes.delete(deviceId);
      this.seenWrittenAt.delete(deviceId);
    }
    return this.publish();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.listenerGeneration += 1;
    this.cancelPairing();
    await this.queue(() => this.stopListener());
  }

  // --- listener -------------------------------------------------------------

  private openCode: string | null = null;

  private sync(): Promise<void> {
    return this.queue(async () => {
      const settings = this.deps.readSettings();
      if (!settings.enabled || this.closed) {
        await this.stopListener();
        return;
      }
      if (this.server !== null && this.configuredPort === settings.port) return;
      await this.stopListener();
      await this.startListener(settings.port);
    });
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const next = this.transition.then(task, task);
    this.transition = next.catch(() => {});
    return next;
  }

  private async startListener(port: number): Promise<void> {
    const server = http.createServer(
      { maxHeaderSize: 8 * 1024, headersTimeout: 5_000, requestTimeout: 10_000 },
      (req, res) => void this.handle(req, res)
    );
    server.keepAliveTimeout = 5_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.startError =
        code === "EADDRINUSE"
          ? `Port ${port} is in use by another app. Choose another port.`
          : `Couldn't listen on port ${port}.`;
      server.close();
      return;
    }
    server.on("error", (error) => {
      console.error("[DeviceAnswer] Listener error:", (error as Error).message);
    });
    this.server = server;
    this.listeningPort = (server.address() as AddressInfo).port;
    this.configuredPort = port;
    this.startError = null;
  }

  private async stopListener(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    this.configuredPort = null;
    this.listenerGeneration += 1;
    this.startError = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** The port the listener is bound to, when it is. */
  get boundPort(): number | null {
    return this.listeningPort;
  }

  private cancelPairing(): void {
    this.pairing.cancel();
    this.openCode = null;
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = null;
  }

  private armPairingExpiry(expiresAt: number): void {
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = setTimeout(
      () => {
        this.pairingExpiryTimer = null;
        if (this.pairing.openUntil() === null) {
          this.openCode = null;
          this.publish();
        }
      },
      Math.max(0, expiresAt - this.now()) + 50
    );
    this.pairingExpiryTimer.unref?.();
  }

  private publish(): DeviceAnswerStatus {
    const status = this.getStatus();
    this.deps.onStatusChanged(status);
    return status;
  }

  // --- requests -------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const settings = this.deps.readSettings();
      const port = this.listeningPort;
      // The Host check comes first: a page that rebound its own name onto
      // 127.0.0.1 gets nothing, not even the page.
      if (port === null || !isAllowedHost(req.headers.host, port, settings.tailnetHost)) {
        throw new HttpError(421, "Unknown host.");
      }
      const url = new URL(req.url ?? "/", "http://device.invalid");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        this.sendPage(res);
        return;
      }
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
      // The API is for this page only: no other site's script may call it,
      // and the custom header forces a browser to preflight anything cross-site.
      if (
        !isSameOriginRequest({
          host: req.headers.host,
          origin: req.headers.origin,
          "sec-fetch-site": headerValue(req.headers["sec-fetch-site"]),
        }) ||
        req.headers["x-daintree-device"] !== "1"
      ) {
        throw new HttpError(403, "Refused.");
      }

      if (req.method === "POST" && url.pathname === "/api/pair") {
        const body = await readJson(req);
        this.sendJson(res, 200, this.pair(body));
        return;
      }

      const device = this.authenticate(req.headers.authorization);
      if (req.method === "GET" && url.pathname === "/api/waiting") {
        // A page from before hosts were listed answers every run as this
        // machine's, so it is shown this machine's alone.
        const { computer, runs, hosts, hostsUnlisted } = await this.deps.listWaiting({
          hosts: url.searchParams.get("hosts") === "1",
        });
        // Only a device still paired once the screens are read is shown them.
        this.requireStillPaired(device);
        this.sendJson(res, 200, {
          ...(computer ? { computer } : {}),
          runs,
          hosts,
          hostsUnlisted: hostsUnlisted === true,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/answer") {
        const body = await readJson(req);
        await this.answer(device, body);
        this.sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/unpair") {
        this.revokeDevice(device.id);
        this.sendJson(res, 200, { ok: true });
        return;
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        this.sendJson(res, error.status, { error: error.message });
      } else {
        console.error("[DeviceAnswer] Request failed:", (error as Error)?.message ?? error);
        this.sendJson(res, 500, { error: "Something went wrong in Daintree." });
      }
    }
  }

  private pair(body: unknown): { token: string; deviceId: string } {
    const now = this.now();
    this.pairAttempts = this.pairAttempts.filter((at) => now - at < 60_000);
    if (this.pairAttempts.length >= PAIR_ATTEMPTS_PER_MINUTE) {
      throw new HttpError(429, "Too many tries. Wait a minute, then ask for a new code.");
    }
    this.pairAttempts.push(now);
    const { code, deviceName } = (body ?? {}) as { code?: unknown; deviceName?: unknown };
    if (typeof code !== "string" || code.length > 32) throw new HttpError(400, "Enter the code.");
    const outcome = this.pairing.redeem(code);
    if (outcome !== "ok") {
      if (this.pairing.openUntil() === null) {
        this.openCode = null;
        this.publish();
      }
      throw new HttpError(
        403,
        outcome === "none"
          ? "No pairing code is open. Ask for a new one in Daintree's settings."
          : "That code didn't work."
      );
    }
    this.openCode = null;
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = null;
    const name =
      typeof deviceName === "string" && deviceName.trim() !== ""
        ? deviceName.trim().replace(/\s+/g, " ").slice(0, MAX_DEVICE_NAME_LENGTH)
        : "Unnamed device";
    const settings = this.deps.readSettings();
    if (settings.devices.length >= MAX_PAIRED_DEVICES) {
      this.publish();
      throw new HttpError(409, "Too many devices are paired. Remove one in Daintree's settings.");
    }
    const token = newDeviceToken();
    const device: PairedDeviceRecord = {
      id: randomUUID(),
      name,
      tokenHash: hashDeviceToken(token),
      pairedAt: now,
      lastSeenAt: now,
    };
    this.deps.writeSettings({ ...settings, devices: [...settings.devices, device] });
    this.publish();
    return { token, deviceId: device.id };
  }

  private authenticate(authorization: string | undefined): DevicePrincipal {
    const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(authorization ?? "");
    if (!match) throw new HttpError(401, "Pair this device first.");
    const digest = hashDeviceToken(match[1]!);
    const settings = this.deps.readSettings();
    // Every record is compared, so how long this takes says nothing about which matched.
    let found: PairedDeviceRecord | null = null;
    for (const device of settings.devices) {
      if (digestsEqual(device.tokenHash, digest)) found = device;
    }
    if (!found) throw new HttpError(401, "This device isn't paired any more.");
    this.noteSeen(found, settings);
    return { id: found.id, name: found.name };
  }

  private isPaired(deviceId: string): boolean {
    return this.deps.readSettings().devices.some((d) => d.id === deviceId);
  }

  private requireStillPaired(device: DevicePrincipal): void {
    if (!this.isPaired(device.id)) throw new HttpError(401, "This device isn't paired any more.");
  }

  private noteSeen(device: PairedDeviceRecord, settings: DeviceAnswerSettings): void {
    const now = this.now();
    const last = this.seenWrittenAt.get(device.id) ?? device.lastSeenAt ?? 0;
    if (now - last < SEEN_WRITE_INTERVAL_MS) return;
    this.seenWrittenAt.set(device.id, now);
    this.deps.writeSettings({
      ...settings,
      devices: settings.devices.map((d) => (d.id === device.id ? { ...d, lastSeenAt: now } : d)),
    });
    this.publish();
  }

  private async answer(device: DevicePrincipal, body: unknown): Promise<void> {
    const now = this.now();
    const times = (this.answerTimes.get(device.id) ?? []).filter((at) => now - at < 10_000);
    if (times.length >= ANSWERS_PER_TEN_SECONDS) {
      throw new HttpError(429, "Too many answers at once. Nothing was pressed.");
    }
    times.push(now);
    this.answerTimes.set(device.id, times);

    const {
      hostId: rawHostId,
      runId,
      spawnedAt,
      label,
      questionId,
    } = (body ?? {}) as Record<string, unknown>;
    // A page from before hosts were listed names none: it was shown this machine's runs only.
    const hostId = rawHostId === undefined ? LOCAL_HOST_ID : rawHostId;
    if (
      typeof hostId !== "string" ||
      hostId === "" ||
      hostId.length > 64 ||
      typeof runId !== "string" ||
      runId === "" ||
      runId.length > 256 ||
      typeof spawnedAt !== "number" ||
      !Number.isFinite(spawnedAt) ||
      typeof label !== "string" ||
      label.trim() === "" ||
      label.length > 200
    ) {
      throw new HttpError(400, "That answer wasn't understood. Nothing was pressed.");
    }
    // A page from before answers named their question would be answering by
    // label alone, which a later question with the same options also matches.
    if (questionId === undefined) {
      throw new HttpError(409, "This page is out of date. Reload it, then answer again. Nothing was pressed.");
    }
    if (!isQuestionId(questionId)) {
      throw new HttpError(400, "That answer wasn't understood. Nothing was pressed.");
    }
    // A page from before redaction, or a hand-made request, can still send a
    // label with a secret in it; the audit is kept on disk and shown in Settings.
    const audited = redactSecrets(label);
    const local = isLocalHostId(hostId);
    const auditedHost = redactSecrets(hostId);
    const onHost = local
      ? {}
      : { hostId: auditedHost, hostName: this.deps.hostName?.(hostId) ?? auditedHost };
    const generation = this.listenerGeneration;
    try {
      await this.deps.answer({
        device,
        hostId: local ? LOCAL_HOST_ID : hostId,
        runId,
        spawnedAt,
        label,
        questionId,
        stillAllowed: () => {
          if (this.closed || this.server === null || this.listenerGeneration !== generation) {
            return "Answering from another device was turned off. Nothing more was pressed.";
          }
          if (!this.isPaired(device.id)) {
            return "This device was removed. Nothing more was pressed.";
          }
          return null;
        },
      });
    } catch (error) {
      const reason = redactSecrets(refusalText(error));
      this.audit({
        at: now,
        deviceId: device.id,
        deviceName: device.name,
        runId,
        ...onHost,
        label: audited,
        outcome: "refused",
        reason,
      });
      throw new HttpError(409, reason);
    }
    this.audit({
      at: now,
      deviceId: device.id,
      deviceName: device.name,
      runId,
      ...onHost,
      label: audited,
      outcome: "answered",
    });
  }

  private audit(entry: DeviceAnswerAuditEntry): void {
    const settings = this.deps.readSettings();
    this.deps.writeSettings({
      ...settings,
      answers: [entry, ...settings.answers].slice(0, MAX_AUDIT_ENTRIES),
    });
    this.publish();
  }

  private sendPage(res: http.ServerResponse): void {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": DEVICE_PAGE_CSP,
    });
    res.end(DEVICE_PAGE_HTML);
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      // A body left unread can't share the connection with the next request.
      ...(status === 413 ? { Connection: "close" } : {}),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(JSON.stringify(body));
  }
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function refusalText(error: unknown): string {
  const userMessage = (error as { userMessage?: unknown } | null)?.userMessage;
  if (typeof userMessage === "string" && userMessage !== "") return userMessage;
  // Nothing says how far it got.
  return "Something went wrong while answering. Check the screen before answering again.";
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  const type = headerValue(req.headers["content-type"]) ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return Promise.reject(new HttpError(415, "Send JSON."));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      outcome();
    };
    // Past the cap the rest is read and dropped, so the 413 still reaches the
    // client; past the drain limit reading stops and the reply closes the
    // connection. `requestTimeout` bounds the drain either way.
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else if (size > MAX_DRAINED_BYTES) {
        req.pause();
        settle(() => reject(new HttpError(413, "Too large.")));
      }
    };
    req.on("data", onData);
    req.once("error", (error) => settle(() => reject(error)));
    req.once("end", () =>
      settle(() => {
        if (size > MAX_BODY_BYTES) return reject(new HttpError(413, "Too large."));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new HttpError(400, "Send JSON."));
        }
      })
    );
  });
}
