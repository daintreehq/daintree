import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../services/AgentNotificationService.js", () => ({
  agentNotificationService: { setShellPolicy: vi.fn() },
}));
vi.mock("../../../store.js", () => ({ store: {} }));

import type { ShellNotificationPolicy } from "../../../services/AgentNotificationService.js";
import type { LinkClientInfo } from "../../link/messages.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import {
  installNotificationPolicyHost,
  installNotificationPolicyPush,
  NOTIFICATION_POLICY_METHOD,
  type NotificationPolicySource,
} from "../notificationPolicy.js";

const CHOICES: ShellNotificationPolicy = {
  enabled: true,
  completedEnabled: true,
  waitingEnabled: true,
  waitingEscalationEnabled: true,
  waitingEscalationDelayMs: 180_000,
};

let dir: string;
const open: LinkSession[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const session of open.splice(0)) session.close("test done");
  await removeTempDir(dir);
});

function fakeSource(initial: ShellNotificationPolicy) {
  let policy = initial;
  const listeners = new Set<() => void>();
  const source: NotificationPolicySource = {
    read: () => policy,
    onMaybeChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    /** A write: the store tells everyone after each field, whatever it was. */
    write(next: Partial<ShellNotificationPolicy> = {}) {
      policy = { ...policy, ...next };
      for (const listener of listeners) listener();
    },
  };
}

function fakeServer() {
  type Ctx = { session: LinkSession; client: LinkClientInfo };
  const sessions: Ctx[] = [];
  const listeners = new Set<(ctx: Ctx) => void>();
  return {
    sessions,
    onSession(listener: (ctx: Ctx) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(session: LinkSession, clientId: string) {
      const ctx = { session, client: { clientId, clientName: clientId, platform: "darwin" as const } };
      sessions.push(ctx);
      for (const listener of listeners) listener(ctx);
    },
  };
}

/** A Shell and a host joined by real sessions, each side wired by its own installer. */
async function link(
  clientId: string,
  manager: { opened(session: LinkSession): void },
  server: ReturnType<typeof fakeServer>
) {
  const pair = await openSessionPair(dir);
  open.push(pair.host, pair.client);
  server.attach(pair.host, clientId);
  manager.opened(pair.client);
  return pair;
}

function fakeManager() {
  const listeners = new Set<(hostId: string, session: LinkSession) => void>();
  return {
    onSessionOpened(listener: (hostId: string, session: LinkSession) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    opened(session: LinkSession) {
      for (const listener of listeners) listener("studio", session);
    },
  };
}

describe("notification policy over a link (#14701)", () => {
  it("hands the host each Shell's choices under the client its session proved", async () => {
    const applied: Array<[string, ShellNotificationPolicy]> = [];
    const server = fakeServer();
    const offHost = installNotificationPolicyHost(server, (clientId, policy) =>
      applied.push([clientId, policy])
    );
    const manager = fakeManager();
    const settings = fakeSource({ ...CHOICES, waitingEnabled: false });
    const offShell = installNotificationPolicyPush(manager, settings.source);

    await link("launch-1", manager, server);
    await waitFor(() => applied.length === 1);
    expect(applied[0]).toEqual(["launch-1", { ...CHOICES, waitingEnabled: false }]);

    // A save writes field by field; the host hears the settled result once.
    settings.write({ waitingEnabled: true });
    settings.write({ waitingEscalationDelayMs: 60_000 });
    await waitFor(() => applied.length === 2);
    expect(applied[1]).toEqual([
      "launch-1",
      { ...CHOICES, waitingEnabled: true, waitingEscalationDelayMs: 60_000 },
    ]);

    // A write that leaves the choices as they were (a sound, say) sends nothing.
    settings.write();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(applied).toHaveLength(2);

    offShell();
    offHost();
  });

  it("refuses choices that don't validate, and keeps nothing from them", async () => {
    const apply = vi.fn();
    const server = fakeServer();
    const offHost = installNotificationPolicyHost(server, apply);
    const pair = await openSessionPair(dir);
    open.push(pair.host, pair.client);
    server.attach(pair.host, "launch-1");

    await expect(
      pair.client.call(NOTIFICATION_POLICY_METHOD, { ...CHOICES, waitingEscalationDelayMs: 5 })
    ).rejects.toBeTruthy();
    await expect(
      pair.client.call(NOTIFICATION_POLICY_METHOD, { waitingEnabled: false })
    ).rejects.toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
    offHost();
  });

  it("watches this machine's settings only while some host session is open", async () => {
    const server = fakeServer();
    const offHost = installNotificationPolicyHost(server, () => {});
    const manager = fakeManager();
    const settings = fakeSource(CHOICES);
    const offShell = installNotificationPolicyPush(manager, settings.source);
    expect(settings.listeners.size).toBe(0);

    const a = await link("launch-1", manager, server);
    const b = await link("launch-1", manager, server);
    expect(settings.listeners.size).toBe(1);

    a.client.close("done");
    await waitFor(() => !a.client.isOpen);
    expect(settings.listeners.size).toBe(1);
    b.client.close("done");
    await waitFor(() => settings.listeners.size === 0);

    await link("launch-1", manager, server);
    expect(settings.listeners.size).toBe(1);
    offShell();
    expect(settings.listeners.size).toBe(0);
    offHost();
  });

  it("keeps going when a host from before it refuses the method", async () => {
    const manager = fakeManager();
    const settings = fakeSource(CHOICES);
    const offShell = installNotificationPolicyPush(manager, settings.source);
    const pair = await openSessionPair(dir);
    open.push(pair.host, pair.client);
    // No host handler: the call is answered as an unknown method.
    manager.opened(pair.client);
    settings.write({ completedEnabled: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pair.client.isOpen).toBe(true);
    offShell();
  });
});
