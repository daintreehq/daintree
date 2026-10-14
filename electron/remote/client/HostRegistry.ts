import crypto from "node:crypto";
import {
  formatHostConnection,
  isReservedHostName,
  isValidRemoteHostId,
  readStoredHostConnection,
  sameHostAccount,
  sameHostConnection,
  sameHostName,
  type HostConnection,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import type { AddHostPayload, UpdateHostPayload } from "../../../shared/types/ipc/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { parseHostConnection } from "./connection.js";

/**
 * The hosts this client can attach to, in the device-owned `remoteHosts`
 * store key. The key is optional and deliberately absent from the store
 * defaults, so the settings file of someone who never adds a host is never
 * touched; reads apply the empty default instead.
 *
 * `retiredIds` holds the id of every host removed from this device. An id is
 * what this machine's grants, consent, history and storage are keyed by, so a
 * later host never gets one back: it would inherit whatever was left under it.
 */
export interface RemoteHostsValue {
  hosts: HostDescriptor[];
  retiredIds?: string[];
}

export interface RemoteHostsStore {
  get(key: "remoteHosts"): RemoteHostsValue | undefined;
  set(key: "remoteHosts", value: RemoteHostsValue): void;
}

const MAX_HOSTS = 64;
const MAX_NAME_LENGTH = 64;

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function normalizeName(name: unknown): string {
  if (typeof name !== "string") throw invalid("Host name must be text.");
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH || hasControlChar(trimmed)) {
    throw invalid(`Host name must be 1-${MAX_NAME_LENGTH} printable characters.`);
  }
  return trimmed;
}

/**
 * Names are the only identity people see, in titles, palettes and toasts: no
 * two hosts share one, and none takes this machine's. A name stored before
 * this rule stays as it was until it is edited.
 */
function requireDistinctName(name: string, hosts: HostDescriptor[], self: HostId | null): void {
  if (isReservedHostName(name)) {
    throw invalid(`"${name}" is what Daintree calls this machine. Choose another name.`);
  }
  if (hosts.some((host) => host.id !== self && sameHostName(host.name, name))) {
    throw invalid(`Another host is already called "${name}". Choose another name.`);
  }
}

function requireNewAccount(
  connection: HostConnection,
  hosts: HostDescriptor[],
  self: HostId | null
): void {
  if (hosts.some((host) => host.id !== self && sameHostAccount(host.connection, connection))) {
    throw invalid(`${formatHostConnection(connection)} is already in your host list.`);
  }
}

function normalizeConnection(value: unknown): HostConnection {
  const connection = parseHostConnection(value);
  if (!connection) {
    throw invalid("SSH target must look like user@host, a host name, or an ~/.ssh/config alias.");
  }
  return connection;
}

/** A readable id from the name, falling back to random when nothing usable is left. */
function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
  return isValidRemoteHostId(slug) ? slug : `host-${crypto.randomBytes(4).toString("hex")}`;
}

function readRetiredIds(raw: unknown): Set<string> {
  const retired = new Set<string>();
  if (!raw || typeof raw !== "object") return retired;
  const ids = (raw as { retiredIds?: unknown }).retiredIds;
  if (!Array.isArray(ids)) return retired;
  for (const id of ids) if (typeof id === "string" && isValidRemoteHostId(id)) retired.add(id);
  return retired;
}

/** Drop anything a hand-edited or older settings file put there that isn't a usable host. */
function sanitize(raw: unknown): HostDescriptor[] {
  if (!raw || typeof raw !== "object") return [];
  const hosts = (raw as { hosts?: unknown }).hosts;
  if (!Array.isArray(hosts)) return [];
  const seen = new Set<string>();
  const out: HostDescriptor[] = [];
  for (const entry of hosts) {
    if (!entry || typeof entry !== "object") continue;
    const host = entry as Partial<HostDescriptor> & { sshTarget?: unknown };
    if (typeof host.id !== "string" || !isValidRemoteHostId(host.id) || seen.has(host.id)) continue;
    if (typeof host.name !== "string") continue;
    // Development builds saved `sshTarget: string`; read either shape.
    const connection = parseHostConnection(readStoredHostConnection(host));
    if (!connection) continue;
    seen.add(host.id);
    out.push({
      id: host.id,
      name: host.name,
      connection,
      platform: host.platform === "darwin" || host.platform === "linux" ? host.platform : null,
      arch: host.arch === "x64" || host.arch === "arm64" ? host.arch : null,
      lastHandshake: host.lastHandshake ?? null,
      lastSeenAt: typeof host.lastSeenAt === "number" ? host.lastSeenAt : null,
      addedAt: typeof host.addedAt === "number" ? host.addedAt : 0,
      notificationsEnabled: host.notificationsEnabled === true,
      assistantMessagingEnabled: host.assistantMessagingEnabled === true,
    });
  }
  return out;
}

export class HostRegistry {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: RemoteHostsStore,
    private readonly now: () => number = Date.now
  ) {}

  list(): HostDescriptor[] {
    return sanitize(this.store.get("remoteHosts"));
  }

  get(hostId: HostId): HostDescriptor | null {
    return this.list().find((host) => host.id === hostId) ?? null;
  }

  require(hostId: HostId): HostDescriptor {
    const host = typeof hostId === "string" ? this.get(hostId) : null;
    if (!host) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id ${String(hostId)}`,
        userMessage: "That host isn't in your host list.",
      });
    }
    return host;
  }

  add(payload: AddHostPayload): HostDescriptor {
    const name = normalizeName(payload?.name);
    const connection = normalizeConnection(payload?.connection);
    const hosts = this.list();
    if (hosts.length >= MAX_HOSTS) throw invalid(`At most ${MAX_HOSTS} hosts can be added.`);
    requireDistinctName(name, hosts, null);
    requireNewAccount(connection, hosts, null);
    const retired = this.retiredIds();
    const taken = (candidate: string) =>
      retired.has(candidate) || hosts.some((host) => host.id === candidate);
    const base = slugFor(name);
    let id = base;
    for (let n = 2; taken(id); n++) {
      id = `${base.slice(0, 58)}-${n}`;
    }
    const descriptor: HostDescriptor = {
      id,
      name,
      connection,
      platform: null,
      arch: null,
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: this.now(),
      notificationsEnabled: false,
      assistantMessagingEnabled: false,
    };
    this.write([...hosts, descriptor]);
    return descriptor;
  }

  update(payload: UpdateHostPayload): HostDescriptor {
    return this.replace(this.validateUpdate(payload));
  }

  /** The record {@link update} would write, validated, without writing it. */
  validateUpdate(payload: UpdateHostPayload): HostDescriptor {
    const current = this.require(payload?.hostId);
    const next: HostDescriptor = { ...current };
    const hosts = this.list();
    if (payload.name !== undefined) {
      next.name = normalizeName(payload.name);
      // Re-casing its own name is no clash, even with a name stored before the rule.
      if (!sameHostName(next.name, current.name)) requireDistinctName(next.name, hosts, current.id);
    }
    if (payload.connection !== undefined) {
      next.connection = normalizeConnection(payload.connection);
      requireNewAccount(next.connection, hosts, current.id);
      if (!sameHostConnection(next.connection, current.connection)) {
        // A different machine may answer now; what we saw of the old one is not about it.
        next.platform = null;
        next.arch = null;
        next.lastHandshake = null;
        next.lastSeenAt = null;
        // Consent was given to the machine that answered before, not this one.
        next.assistantMessagingEnabled = false;
      }
    }
    if (payload.notificationsEnabled !== undefined) {
      if (typeof payload.notificationsEnabled !== "boolean") {
        throw invalid("notificationsEnabled must be true or false.");
      }
      next.notificationsEnabled = payload.notificationsEnabled;
    }
    if (payload.assistantMessagingEnabled !== undefined) {
      if (typeof payload.assistantMessagingEnabled !== "boolean") {
        throw invalid("assistantMessagingEnabled must be true or false.");
      }
      next.assistantMessagingEnabled = payload.assistantMessagingEnabled;
    }
    return next;
  }

  /** Record what a connection observed. Not a user edit, so it never validates names. */
  recordObservation(
    hostId: HostId,
    observed: Partial<Pick<HostDescriptor, "platform" | "arch" | "lastHandshake" | "lastSeenAt">>
  ): HostDescriptor | null {
    const current = this.get(hostId);
    if (!current) return null;
    return this.replace({ ...current, ...observed });
  }

  forget(hostId: HostId): boolean {
    const hosts = this.list();
    const next = hosts.filter((host) => host.id !== hostId);
    if (next.length === hosts.length) return false;
    this.write(next, hostId);
    return true;
  }

  /** Ids of hosts removed from this device, never given to another host. */
  retiredIds(): Set<string> {
    return readRetiredIds(this.store.get("remoteHosts"));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replace(descriptor: HostDescriptor): HostDescriptor {
    this.write(this.list().map((host) => (host.id === descriptor.id ? descriptor : host)));
    return descriptor;
  }

  private write(hosts: HostDescriptor[], retire?: HostId): void {
    const retired = this.retiredIds();
    if (retire !== undefined) retired.add(retire);
    this.store.set(
      "remoteHosts",
      retired.size > 0 ? { hosts, retiredIds: [...retired] } : { hosts }
    );
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[HostRegistry] change listener failed:", error);
      }
    }
  }
}
