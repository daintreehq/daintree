import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderId } from "../../../../shared/types/cloudHosts.js";
import type { HostIdleObservation } from "../../../../shared/types/hostIdle.js";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type { CommandResult, CommandRunner } from "../../client/commandRunner.js";
import { KeepAwakeKeeper, type KeepAwakeListener } from "../../host/KeepAwakeKeeper.js";
import type { LinkSession } from "../../link/session.js";
import { Agent37Client } from "../agent37/Agent37Client.js";
import { KEEP_AWAKE_PATH } from "../agent37/agent37KeepAwake.js";
import { Agent37Provider } from "../agent37/Agent37Provider.js";
import { CloudAccountService } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostLifecycle } from "../CloudHostLifecycle.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import { CloudKeepAwakeLinks } from "../CloudKeepAwakeLinks.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import { KeepAwakeArmSchema, KeepAwakeLinkMethod } from "../machineKeeperLink.js";
import type { CloudProvider } from "../provider.js";
import { FAKE_AGENT37_KEY, FakeAgent37Api, type FakeAgent37Instance } from "./fakeAgent37Api.js";

let root: string;
const disposers: Array<() => void> = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-agent37-awake-"));
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await fs.rm(root, { recursive: true, force: true });
});

const ok: CommandResult = { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
const noCommands = (async () => ok) as unknown as CommandRunner;
const PORT = 41_234;
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

function unsupported(): Error {
  return Object.assign(new Error("Unknown method"), { code: "UNSUPPORTED" });
}

/** The host's listener, reached through the fake's edge: it answers only the nonce it expects. */
function edgeListener(api: FakeAgent37Api, instanceId: string): KeepAwakeListener {
  let expected: string | null = null;
  let received: string | null = null;
  const close = api.listen(instanceId, PORT, (forwarded) => {
    const pathname = forwarded.split("?")[0] ?? "";
    const nonce = pathname.startsWith(KEEP_AWAKE_PATH)
      ? pathname.slice(KEEP_AWAKE_PATH.length)
      : "";
    if (nonce !== "" && nonce === expected) {
      expected = null;
      received = nonce;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  });
  return {
    port: PORT,
    expect: (nonce) => {
      expected = nonce;
      received = null;
    },
    take: (nonce) => {
      const arrived = received === nonce;
      received = null;
      expected = null;
      return arrived;
    },
    close,
  };
}

/**
 * Daintree's cloud runtime over the real Agent 37 provider and client, the
 * real keep-awake links on the Shell and the real keeper on the host, joined
 * by a stand-in link, against the fake API and its edge. Every clock is the
 * fake's, so its idle timer and the keeper's pings share one timeline.
 */
async function agent37(instance: Partial<FakeAgent37Instance> = {}) {
  const api = new FakeAgent37Api();
  let saved: unknown;
  const store = new CloudHostStore({
    get: () => structuredClone(saved),
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      saved = JSON.parse(JSON.stringify(value));
    },
  });
  const client = new Agent37Client({
    baseUrl: api.baseUrl,
    fetch: api.fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  const accounts = new CloudAccountService({
    store,
    vault: new MemoryCloudCredentialVault(),
    providers: new Map<CloudProviderId, CloudProvider>([
      ["agent37", new Agent37Provider(() => client)],
    ]),
    apiUrlFor: () => api.baseUrl,
    platform: "darwin",
  });
  const hosts: HostDescriptor[] = [];
  const now = () => api.now;

  // The host: its idle clock, as the test says, and its keeper behind the link's CALLs.
  let busy = true;
  const idle = {
    observation: (): HostIdleObservation =>
      busy
        ? { idleAfterMinutes: 30, lastWorkAt: now(), busy: true, idleEndsAt: null }
        : { idleAfterMinutes: 30, lastWorkAt: now(), busy: false, idleEndsAt: now() + 1_800_000 },
  };
  const seeded = api.seed({ auto_sleep: true, idle_timeout_seconds: 1800, ...instance });
  const edgeRequests: Array<{ url: string; headers: unknown }> = [];
  const keeper = new KeepAwakeKeeper({
    idle,
    listen: async () => edgeListener(api, seeded.id),
    fetch: (async (input: URL | string, init?: RequestInit) => {
      edgeRequests.push({ url: String(input), headers: init?.headers ?? null });
      return api.edge(input, init);
    }) as typeof globalThis.fetch,
    now,
  });
  disposers.push(() => keeper.dispose());
  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    [KeepAwakeLinkMethod.STATUS]: () => keeper.open(),
    [KeepAwakeLinkMethod.ARM]: (payload) => keeper.arm(KeepAwakeArmSchema.parse(payload)),
  };
  const calls: Array<{ label: string; method: string; payload: unknown }> = [];
  const link = (
    answers: Record<string, (payload: unknown) => Promise<unknown>> = handlers,
    label = "link"
  ) =>
    ({
      isOpen: true,
      call: vi.fn(async (method: string, payload: unknown) => {
        calls.push({ label, method, payload });
        const handler = { ...handlers, ...answers }[method];
        if (!handler) throw unsupported();
        return handler(payload);
      }),
    }) as unknown as LinkSession & { isOpen: boolean };
  let current: (LinkSession & { isOpen: boolean }) | null = null;
  let changes = 0;
  const links = new CloudKeepAwakeLinks({
    store,
    accounts,
    hosts: { get: (id) => hosts.find((host) => host.id === id) ?? null },
    sessionFor: () => (current?.isOpen ? current : null),
    changed: () => {
      changes += 1;
    },
    now,
  });
  disposers.push(() => links.dispose());
  const lifecycle = new CloudHostLifecycle({
    store,
    accounts,
    files: new CloudSshFiles(path.join(root, "cloud"), noCommands),
    clientDir: root,
    hosts: {
      add: (name: string, connection: HostConnection) => {
        const descriptor = { id: name, name, connection } as HostDescriptor;
        hosts.push(descriptor);
        return descriptor;
      },
      get: (id) => hosts.find((host) => host.id === id) ?? null,
      list: () => hosts,
      forget: async () => {},
      disconnect: async () => {},
      onChange: () => () => {},
    },
    changed: () => {},
    keepAwake: links,
    sleep: async () => {},
    now,
  });
  disposers.push(() => lifecycle.dispose());

  const account = await accounts.addAccount({
    providerId: "agent37",
    credentials: { apiKey: FAKE_AGENT37_KEY },
    scopeId: "workspace",
  });
  await lifecycle.importMachine({ accountId: account.id, resourceId: seeded.id, name: "build" });
  const bindingId = store.bindings()[0]!.id;
  const machine = api.instances.get(seeded.id)!;

  /** Agent 37's clock and the host's keeper move on together, `seconds` at a time; true while it never slept. */
  const run = async (seconds: number, step = 30): Promise<boolean> => {
    let stayedAwake = true;
    for (let passed = 0; passed < seconds; passed += step) {
      api.advance(step);
      if (machine.status !== "running") stayedAwake = false;
      await keeper.tick();
    }
    return stayedAwake;
  };

  return {
    api,
    store,
    keeper,
    links,
    machine,
    bindingId,
    calls,
    edgeRequests,
    run,
    status: () => lifecycle.statuses()[0]!,
    changes: () => changes,
    setBusy: (next: boolean) => {
      busy = next;
    },
    /** A device connects: a new link, on which the Shell hands the host a URL. */
    connect: async (answers?: Record<string, (payload: unknown) => Promise<unknown>>) => {
      current = link(answers);
      await links.run("build", current, true);
      return current;
    },
    /** As `connect`, without waiting for the Shell to finish. */
    open: (answers?: Record<string, (payload: unknown) => Promise<unknown>>, label?: string) => {
      current = link(answers, label);
      return { session: current, done: links.run("build", current, true) };
    },
    /** Every device goes away. */
    disconnect: () => {
      if (current) current.isOpen = false;
      current = null;
    },
    hits: () => api.edgeHits.get(`${seeded.id}:${PORT}`) ?? 0,
  };
}

describe("holding a busy Agent 37 instance awake with no Daintree connected (#17918)", () => {
  it("keeps a busy host's instance awake with no Shell, then lets Agent 37 sleep it once the host is idle", async () => {
    const env = await agent37();
    await env.connect();
    const minted = env.api.signedUrls;
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ port: PORT, expiresAt: env.api.now / 1000 + SEVEN_DAYS_S });
    expect(env.status().keepAwake).toEqual({
      kind: "held",
      expiresAt: minted[0]!.expiresAt * 1000,
      confirmedAt: env.api.now,
    });
    env.disconnect();

    // Three of Agent 37's idle timeouts with no device, and the host working all along.
    expect(await env.run(3 * 1800)).toBe(true);
    expect(env.machine.status).toBe("running");
    // About once a minute, never more often than the host's pass allows.
    expect(env.hits()).toBeGreaterThanOrEqual(85);
    expect(env.hits()).toBeLessThanOrEqual(92);

    // The host goes idle: nothing more is sent, and Agent 37 sleeps it after its own idle time.
    env.setBusy(false);
    const before = env.hits();
    expect(await env.run(1770)).toBe(true);
    await env.run(60);
    expect(env.machine.status).toBe("sleeping");
    expect(env.hits()).toBe(before);
  });

  it("never holds an idle host's instance awake", async () => {
    const env = await agent37();
    env.setBusy(false);
    await env.connect();
    // Taken, but not tried: a request now could land after a sleep the idle time allows.
    expect(env.hits()).toBe(0);
    expect(env.keeper.status()).toMatchObject({ reachedAt: null, problem: null });
    env.disconnect();
    await env.run(1830);
    expect(env.machine.status).toBe("sleeping");
    expect(env.hits()).toBe(0);
  });

  it("falls back to Agent 37's timer once the URL expires, and a new connection renews it", async () => {
    // The longest idle time Agent 37 takes, so a day's steps keep the busy host's instance up.
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    await env.connect();
    const firstExpiry = env.api.signedUrls[0]!.expiresAt;
    env.disconnect();

    expect(await env.run(SEVEN_DAYS_S - 3600, 3600)).toBe(true);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
    const changesBefore = env.changes();
    await env.run(2 * 3600, 3600);
    // Past its expiry the host drops it and sends nothing more, however busy it is.
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("expired"),
    });
    await env.links.tick();
    expect(env.status().keepAwake).toEqual({ kind: "expired", expiredAt: firstExpiry * 1000 });
    expect(env.changes()).toBeGreaterThan(changesBefore);
    const hits = env.hits();
    await env.run(86_400, 3600);
    expect(env.machine.status).toBe("sleeping");
    expect(env.hits()).toBe(hits);

    // Daintree connects again (waking it, as any connection does): a new URL, for seven days from now.
    env.machine.status = "running";
    await env.connect();
    expect(env.api.signedUrls).toHaveLength(2);
    expect(env.status().keepAwake).toMatchObject({
      kind: "held",
      expiresAt: env.api.signedUrls[1]!.expiresAt * 1000,
    });
  });

  it("puts nothing on the instance that reaches the account, and reports no URL back", async () => {
    const env = await agent37();
    await env.connect();
    env.disconnect();
    await env.run(600);
    const handedOver = JSON.stringify(env.calls);
    expect(handedOver).not.toContain(FAKE_AGENT37_KEY);
    for (const request of env.edgeRequests) {
      expect(JSON.stringify(request)).not.toContain(FAKE_AGENT37_KEY);
      expect(new URL(request.url).hostname).toBe(`${env.machine.id}-${PORT}.agent37.app`);
    }
    const token = env.api.signedUrls[0]!.token;
    expect(JSON.stringify(env.keeper.status())).not.toContain(token);
    expect(JSON.stringify(env.status())).not.toContain(token);
    expect(JSON.stringify(env.store.bindings())).not.toContain(token);
  });

  it("says Agent 37's own timer is in charge when the host can't hold the instance", async () => {
    const env = await agent37();
    expect(env.status().keepAwake).toEqual({ kind: "none", problem: null });

    // A host from before these calls.
    const tooOld = async () => {
      throw unsupported();
    };
    await env.connect({
      [KeepAwakeLinkMethod.STATUS]: tooOld,
      [KeepAwakeLinkMethod.ARM]: tooOld,
    });
    expect(env.status().keepAwake).toEqual({
      kind: "none",
      problem: expect.stringContaining("too old"),
    });
    expect(env.api.signedUrls).toHaveLength(0);

    // A URL whose request never reaches the host is refused, and nothing is held.
    const listened = await env.connect({
      [KeepAwakeLinkMethod.STATUS]: async () => ({
        port: PORT + 1,
        expiresAt: null,
        reachedAt: null,
        problem: null,
      }),
      [KeepAwakeLinkMethod.ARM]: async () => {
        throw Object.assign(new Error("refused"), {
          code: "VALIDATION",
          userMessage: "Agent 37 couldn't reach this host through the link Daintree gave it.",
        });
      },
    });
    expect(listened.isOpen).toBe(true);
    expect(env.status().keepAwake).toEqual({
      kind: "none",
      problem: "Agent 37 couldn't reach this host through the link Daintree gave it.",
    });
  });

  it("keeps the host's URL when the Shell can't mint a new one, and says why only while none is held", async () => {
    const env = await agent37();
    await env.connect();
    const held = env.status().keepAwake;
    env.api.fail("POST", /\/signed-url$/, FakeAgent37Api.error(403, "forbidden", "Not allowed"), 5);
    await env.connect();
    expect(env.status().keepAwake).toEqual(held);
    expect(env.keeper.status().expiresAt).toBe(env.api.signedUrls[0]!.expiresAt * 1000);
  });

  it("never hands a URL over a link that was replaced while the host answered", async () => {
    const env = await agent37();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = env.open(
      {
        [KeepAwakeLinkMethod.STATUS]: async () => {
          await gate;
          return env.keeper.open();
        },
      },
      "first"
    );
    // The device reconnects before the host answered on the first link.
    env.disconnect();
    const second = env.open(undefined, "second");
    release();
    await first.done;
    await second.done;
    await vi.waitFor(() =>
      expect(env.calls.filter((call) => call.method === KeepAwakeLinkMethod.ARM)).toHaveLength(1)
    );
    const arms = env.calls.filter((call) => call.method === KeepAwakeLinkMethod.ARM);
    expect(arms[0]!.label).toBe("second");
    expect(env.api.signedUrls).toHaveLength(1);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
  });
});
