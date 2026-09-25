import crypto from "node:crypto";
import {
  isValidRemoteHostId,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import type { AddHostPayload, UpdateHostPayload } from "../../../shared/types/ipc/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { isValidSshTarget } from "./sshTransport.js";

/**
 * The hosts this client can attach to, in the device-owned `remoteHosts`
 * store key. The key is optional and deliberately absent from the store
 * defaults, so the settings file of someone who never adds a host is never
 * touched; reads apply the empty default instead.
 */

export interface RemoteHostsStore {
  get(key: "remoteHosts"): { hosts: HostDescriptor[] } | undefined;
  set(key: "remoteHosts", value: { hosts: HostDescriptor[] }): void;
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

function normalizeTarget(target: unknown): string {
  if (typeof target !== "string" || !isValidSshTarget(target.trim())) {
    throw invalid("SSH target must look like user@host, a host name, or an ~/.ssh/config alias.");
  }
  return target.trim();
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

/** Drop anything a hand-edited or older settings file put there that isn't a usable host. */
function sanitize(raw: unknown): HostDescriptor[] {
  if (!raw || typeof raw !== "object") return [];
  const hosts = (raw as { hosts?: unknown }).hosts;
  if (!Array.isArray(hosts)) return [];
  const seen = new Set<string>();
  const out: HostDescriptor[] = [];
  for (const entry of hosts) {
    if (!entry || typeof entry !== "object") continue;
    const host = entry as Partial<HostDescriptor>;
    if (typeof host.id !== "string" || !isValidRemoteHostId(host.id) || seen.has(host.id)) continue;
    if (typeof host.name !== "string" || typeof host.sshTarget !== "string") continue;
    if (!isValidSshTarget(host.sshTarget)) continue;
    seen.add(host.id);
    out.push({
      id: host.id,
      name: host.name,
      sshTarget: host.sshTarget,
      platform: host.platform === "darwin" || host.platform === "linux" ? host.platform : null,
      arch: host.arch === "x64" || host.arch === "arm64" ? host.arch : null,
      lastHandshake: host.lastHandshake ?? null,
      lastSeenAt: typeof host.lastSeenAt === "number" ? host.lastSeenAt : null,
      addedAt: typeof host.addedAt === "number" ? host.addedAt : 0,
      notificationsEnabled: host.notificationsEnabled === true,
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
    const sshTarget = normalizeTarget(payload?.sshTarget);
    const hosts = this.list();
    if (hosts.length >= MAX_HOSTS) throw invalid(`At most ${MAX_HOSTS} hosts can be added.`);
    if (hosts.some((host) => host.sshTarget === sshTarget)) {
      throw invalid(`${sshTarget} is already in your host list.`);
    }
    const base = slugFor(name);
    let id = base;
    for (let n = 2; hosts.some((host) => host.id === id); n++) {
      id = `${base.slice(0, 58)}-${n}`;
    }
    const descriptor: HostDescriptor = {
      id,
      name,
      sshTarget,
      platform: null,
      arch: null,
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: this.now(),
      notificationsEnabled: false,
    };
    this.write([...hosts, descriptor]);
    return descriptor;
  }

  update(payload: UpdateHostPayload): HostDescriptor {
    const current = this.require(payload?.hostId);
    const next: HostDescriptor = { ...current };
    if (payload.name !== undefined) next.name = normalizeName(payload.name);
    if (payload.sshTarget !== undefined) {
      next.sshTarget = normalizeTarget(payload.sshTarget);
      const hosts = this.list();
      if (hosts.some((host) => host.id !== current.id && host.sshTarget === next.sshTarget)) {
        throw invalid(`${next.sshTarget} is already in your host list.`);
      }
      if (next.sshTarget !== current.sshTarget) {
        // A different machine may answer now; what we saw of the old one is not about it.
        next.platform = null;
        next.arch = null;
        next.lastHandshake = null;
        next.lastSeenAt = null;
      }
    }
    if (payload.notificationsEnabled !== undefined) {
      if (typeof payload.notificationsEnabled !== "boolean") {
        throw invalid("notificationsEnabled must be true or false.");
      }
      next.notificationsEnabled = payload.notificationsEnabled;
    }
    return this.replace(next);
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
    this.write(next);
    return true;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replace(descriptor: HostDescriptor): HostDescriptor {
    this.write(this.list().map((host) => (host.id === descriptor.id ? descriptor : host)));
    return descriptor;
  }

  private write(hosts: HostDescriptor[]): void {
    this.store.set("remoteHosts", { hosts });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[HostRegistry] change listener failed:", error);
      }
    }
  }
}
