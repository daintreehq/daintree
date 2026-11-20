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

/**
 * The host's listener, reached through the fake's edge: it answers a GET
 * carrying a nonce it expects, once, and counts what it accepted.
 */
function edgeListener(
  api: FakeAgent37Api,
  instanceId: string,
  accepted: { count: number }
): KeepAwakeListener {
  const expected = new Set<string>();
  const received = new Set<string>();
  const close = api.listen(instanceId, PORT, (forwarded, method) => {
    const pathname = forwarded.split("?")[0] ?? "";
    const nonce = pathname.startsWith(KEEP_AWAKE_PATH)
      ? pathname.slice(KEEP_AWAKE_PATH.length)
      : "";
    if (method === "GET" && expected.delete(nonce)) {
      received.add(nonce);
      accepted.count += 1;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  });
  return {
    port: PORT,
    expect: (nonce) => {
      expected.add(nonce);
    },
    take: (nonce) => {
      expected.delete(nonce);
      return received.delete(nonce);
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
  const accepted = { count: 0 };
  /** Set, the edge's answer never comes back: this runs while the host waits, then its wait times out. */
  let answerLost: (() => void) | null = null;
  const keeper = new KeepAwakeKeeper({
    idle,
    listen: async () => edgeListener(api, seeded.id, accepted),
    fetch: (async (input: URL | string, init?: RequestInit) => {
      edgeRequests.push({ url: String(input), headers: init?.headers ?? null });
      const response = await api.edge(input, init);
      if (!answerLost) return response;
      answerLost();
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof globalThis.fetch,
    now,
    monotonic: now,
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
  /** Links to the other machines' hosts, by host. */
  const others = new Map<string, LinkSession & { isOpen: boolean }>();
  let changes = 0;
  const links = new CloudKeepAwakeLinks({
    store,
    accounts,
    hosts: { get: (id) => hosts.find((host) => host.id === id) ?? null },
    sessionFor: (id) => {
      const session = id === "build" ? current : others.get(id);
      return session?.isOpen ? session : null;
    },
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
    /** What the store last wrote, as it would land on disk. */
    raw: () => JSON.stringify(saved),
    /** Requests that reached the host's listener with a nonce it expected. */
    accepted: () => accepted.count,
    /** The link the Shell has to the host now, or null. */
    current: () => current,
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
    /** A link comes up, with nothing run on it yet. */
    attach: (answers?: Record<string, (payload: unknown) => Promise<unknown>>) => {
      current = link(answers);
      return current;
    },
    /** A new link takes the host's place, the old one not yet closed. */
    relink: (answers?: Record<string, (payload: unknown) => Promise<unknown>>, label?: string) => {
      current = link(answers, label);
      return { session: current, done: links.run("build", current, true) };
    },
    hits: () => api.edgeHits.get(`${seeded.id}:${PORT}`) ?? 0,
    /** The edge's answers never come back, `meanwhile` running while the host waits; null puts them back. */
    loseAnswers: (meanwhile: (() => void) | null) => {
      answerLost = meanwhile;
    },
    /** Another machine on the account, linked, its host answering as `answers` say. */
    addHost: async (
      name: string,
      answers: Record<string, (payload: unknown) => Promise<unknown>>
    ) => {
      const other = api.seed({ auto_sleep: true, idle_timeout_seconds: 1800 });
      await lifecycle.importMachine({ accountId: account.id, resourceId: other.id, name });
      const session = link(answers, name);
      others.set(name, session);
      return session;
    },
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
      reached: true,
    });
    // Connecting again while it holds one still hands over a new one, for seven days from then.
    env.api.advance(600);
    await env.connect();
    expect(env.api.signedUrls).toHaveLength(2);
    expect(env.api.signedUrls[1]!.expiresAt).toBe(minted[0]!.expiresAt + 600);
    expect(env.status().keepAwake).toMatchObject({
      kind: "held",
      expiresAt: env.api.signedUrls[1]!.expiresAt * 1000,
    });
    env.disconnect();

    // Three of Agent 37's idle timeouts with no device, and the host working all along.
    const start = env.accepted();
    expect(await env.run(3 * 1800)).toBe(true);
    expect(env.machine.status).toBe("running");
    // About once a minute, each reaching the host's listener, never more often.
    expect(env.accepted() - start).toBeGreaterThanOrEqual(88);
    expect(env.accepted() - start).toBeLessThanOrEqual(91);
    expect(env.hits()).toBe(env.accepted());

    // The host goes idle: nothing more is sent, and Agent 37 sleeps it after its own idle time.
    env.setBusy(false);
    const before = env.hits();
    expect(await env.run(1770)).toBe(true);
    await env.run(60);
    expect(env.machine.status).toBe("sleeping");
    expect(env.hits()).toBe(before);
  });

  it("never holds an idle host's instance awake, and checks its URL once work starts with no Shell", async () => {
    const env = await agent37();
    env.setBusy(false);
    await env.connect();
    // Taken, but not tried: a request now could land after a sleep the idle time allows.
    expect(env.status().keepAwake).toMatchObject({
      kind: "held",
      expiresAt: env.api.signedUrls[0]!.expiresAt * 1000,
      reached: false,
    });
    expect(env.edgeRequests).toHaveLength(0);
    expect(env.keeper.status()).toMatchObject({ reachedAt: null, problem: null });
    env.disconnect();
    await env.run(600);
    expect(env.edgeRequests).toHaveLength(0);

    // Work starts with nobody connected: its first pass checks the URL, and it reaches the host.
    env.setBusy(true);
    await env.run(30);
    expect(env.accepted()).toBe(1);
    expect(env.keeper.status().reachedAt).toBe(env.api.now);

    // Idle again: Agent 37 sleeps it its idle time after that last request, with nothing more sent.
    env.setBusy(false);
    expect(await env.run(1770)).toBe(true);
    await env.run(30);
    expect(env.machine.status).toBe("sleeping");
    expect(env.edgeRequests).toHaveLength(1);
  });

  it("mints once when a pass that found the URL lost and a renewal on the same link overlap", async () => {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    await env.connect();
    env.api.signedUrls.splice(0, 1, { ...env.api.signedUrls[0]!, token: "revoked" });
    await env.run(1860);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const session = env.attach({
      [KeepAwakeLinkMethod.STATUS]: async () => {
        await gate;
        return env.keeper.open();
      },
    });
    // A question finds the URL lost and decides to mint; meanwhile a renewal is asked for.
    const asking = env.links.run("build", session, false);
    const renewal = env.links.run("build", session, true);
    release();
    await asking;
    await renewal;
    await vi.waitFor(() => expect(env.status().keepAwake).toMatchObject({ kind: "held" }));
    // Long enough for a queued second mint against the in-memory fake to have gone out.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(2);
  });

  /**
   * A question finds the host's URL lost and mints in place of a renewal queued
   * behind it on the same link; the host turns away its first `refusals` arms.
   */
  async function promotedMintRefused(refusals: number) {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    await env.connect();
    env.api.signedUrls.splice(0, 1, { ...env.api.signedUrls[0]!, token: "revoked" });
    await env.run(1860);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arms = 0;
    const session = env.attach({
      [KeepAwakeLinkMethod.STATUS]: async () => {
        await gate;
        return env.keeper.open();
      },
      [KeepAwakeLinkMethod.ARM]: async (payload) => {
        arms += 1;
        if (arms <= refusals) {
          throw Object.assign(new Error("refused"), {
            code: "VALIDATION",
            userMessage:
              "This host's port closed while it checked that link. Ask for its port again.",
          });
        }
        return env.keeper.arm(KeepAwakeArmSchema.parse(payload));
      },
    });
    const asking = env.links.run("build", session, false);
    const renewal = env.links.run("build", session, true);
    release();
    await asking;
    await renewal;
    return { env, arms: () => arms };
  }

  it("still offers the renewal queued behind a question whose own mint the host refused", async () => {
    const { env, arms } = await promotedMintRefused(1);
    // No hour's pause first: the renewal was asked for before the question chose to mint.
    await vi.waitFor(() => expect(arms()).toBe(2));
    await vi.waitFor(() => expect(env.status().keepAwake).toMatchObject({ kind: "held" }));
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(3);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: env.api.signedUrls.at(-1)!.expiresAt * 1000,
      reachedAt: env.api.now,
    });
  });

  it("keeps the hour's pause once the queued renewal is refused too", async () => {
    const { env, arms } = await promotedMintRefused(2);
    await vi.waitFor(() => expect(arms()).toBe(2));
    await vi.waitFor(() =>
      expect(env.status().keepAwake).toEqual({
        kind: "none",
        problem: "This host's port closed while it checked that link. Ask for its port again.",
      })
    );
    for (let i = 0; i < 59; i++) {
      env.api.advance(60);
      await env.links.tick();
    }
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(3);
    env.api.advance(60);
    await env.links.tick();
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(4);
  });

  it("asks again five minutes after a question fails just as the host loses its URL, and hands it a new one", async () => {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    let statusFails = false;
    await env.connect({
      [KeepAwakeLinkMethod.STATUS]: async () => {
        if (statusFails) throw Object.assign(new Error("Timed out"), { code: "TIMEOUT" });
        return env.keeper.open();
      },
    });
    const mints = () => env.api.calls("POST", /\/signed-url$/).length;
    // Agent 37 stops taking that URL, the busy host drops it, and the next question fails.
    env.api.signedUrls.splice(0);
    await env.run(60);
    expect(env.keeper.status()).toMatchObject({ expiresAt: null });
    statusFails = true;
    await env.links.tick();
    statusFails = false;
    // The passes before then find it holding none, and wait.
    for (let i = 0; i < 4; i++) {
      await env.run(60);
      await env.links.tick();
    }
    await env.run(30);
    await env.links.tick();
    expect(mints()).toBe(1);
    // Five minutes on, not half an hour after the last, the host is handed a new one.
    await env.run(30);
    await env.links.tick();
    expect(mints()).toBe(2);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
    expect(env.keeper.status().reachedAt).toBe(env.api.now);

    // A question that fails while the host holds a URL that works mints nothing when asked again.
    statusFails = true;
    await env.run(60);
    await env.links.tick();
    statusFails = false;
    for (let i = 0; i < 10; i++) {
      await env.run(60);
      await env.links.tick();
    }
    expect(mints()).toBe(2);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
  });

  it("starts every linked host's attempt on a pass, whatever one of them keeps it waiting for", async () => {
    const env = await agent37();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      // The first machine's host takes its time over the URL it is handed.
      env.attach({
        [KeepAwakeLinkMethod.ARM]: async (payload) => {
          await gate;
          return env.keeper.arm(KeepAwakeArmSchema.parse(payload));
        },
      });
      // The other's holds nothing yet, and takes what it's handed at once.
      await env.addHost("test", {
        [KeepAwakeLinkMethod.STATUS]: async () => ({
          port: PORT,
          expiresAt: null,
          reachedAt: null,
          problem: null,
        }),
        [KeepAwakeLinkMethod.ARM]: async (payload) => {
          const { expiresAt } = KeepAwakeArmSchema.parse(payload);
          return { port: PORT, expiresAt, reachedAt: env.api.now, problem: null };
        },
      });
      const other = env.store.bindingForHost("test")!.id;
      const pass = env.links.tick();
      await vi.waitFor(() =>
        expect(
          env.calls.filter(
            (call) => call.label === "link" && call.method === KeepAwakeLinkMethod.ARM
          )
        ).toHaveLength(1)
      );
      // While the first host still holds its URL, the other is handed one and holds it.
      await vi.waitFor(() =>
        expect(env.links.statusFor(other)).toMatchObject({ kind: "held", reached: true })
      );
      expect(env.links.statusFor(env.bindingId)).toEqual({ kind: "none", problem: null });
      expect(new Set(env.api.signedUrls.map((grant) => grant.instanceId)).size).toBe(2);
      release();
      await pass;
      expect(env.links.statusFor(env.bindingId)).toMatchObject({ kind: "held", reached: true });
      expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(2);
    } finally {
      release();
    }
  });

  it("never lets a URL that is about to expire take the place of one that works", async () => {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    await env.connect();
    const working = env.api.signedUrls[0]!.expiresAt * 1000;
    /** A URL from elsewhere for the same port, `seconds` from its expiry. */
    const elsewhere = (name: string, seconds: number) => {
      const token = name.padEnd(32, "x");
      env.api.signedUrls.push({
        instanceId: env.machine.id,
        port: PORT,
        token,
        expiresAt: env.api.now / 1000 + seconds,
      });
      return {
        resourceId: env.machine.id,
        url: `https://${env.machine.id}-${PORT}.agent37.app/?a37_token=${token}`,
        expiresAt: env.api.now + seconds * 1000,
      };
    };
    const stillWorking = async () => {
      expect(env.keeper.status()).toMatchObject({ expiresAt: working, problem: null });
      const hits = env.accepted();
      expect(await env.run(120)).toBe(true);
      expect(env.keeper.status()).toMatchObject({ expiresAt: working, problem: null });
      expect(env.accepted()).toBeGreaterThan(hits);
    };

    // It reaches the host seconds before it expires, and its answer comes back too late.
    const late = elsewhere("late", 5);
    env.loseAnswers(() => env.api.advance(10));
    let accepted = env.accepted();
    await expect(env.keeper.arm(late)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.accepted()).toBe(accepted + 1);
    env.loseAnswers(null);
    await stillWorking();

    // It reaches the host with seconds to spare.
    accepted = env.accepted();
    await expect(env.keeper.arm(elsewhere("soon", 15))).resolves.toMatchObject({
      expiresAt: working,
    });
    expect(env.accepted()).toBe(accepted + 1);
    await stillWorking();

    // Taken while idle, it reaches the host on the first busy pass, seconds from its expiry.
    env.setBusy(false);
    await expect(env.keeper.arm(elsewhere("idle", 40))).resolves.toMatchObject({
      reachedAt: null,
    });
    env.setBusy(true);
    accepted = env.accepted();
    await env.run(30);
    expect(env.accepted()).toBe(accepted + 1);
    await stillWorking();
  });

  it("hands the host a URL as soon as a link to it opens", async () => {
    const env = await agent37();
    const session = env.attach();
    env.links.sessionOpened("build", session);
    await vi.waitFor(() => expect(env.status().keepAwake).toMatchObject({ kind: "held" }));
    expect(env.calls.map((call) => call.method)).toEqual([
      KeepAwakeLinkMethod.STATUS,
      KeepAwakeLinkMethod.ARM,
    ]);
    expect(env.accepted()).toBe(1);
  });

  it("hands a host that lost its URL a new one on a link that stays up, no more than twice an hour", async () => {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    await env.connect();
    // Agent 37 stops taking that URL, and the busy host drops it.
    env.api.signedUrls.splice(0);
    await env.run(60);
    expect(env.keeper.status()).toMatchObject({ expiresAt: null });
    await env.links.tick();
    expect(env.status().keepAwake).toEqual({
      kind: "none",
      problem: expect.stringContaining("no longer accepts"),
    });
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(1);

    // Still linked: nothing more until half an hour after the last one.
    await env.run(1680);
    await env.links.tick();
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(1);
    // Then a new URL, and the host holds it awake again.
    await env.run(120);
    await env.links.tick();
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(2);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
    expect(env.keeper.status().reachedAt).toBe(env.api.now);
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
    expect(env.raw()).not.toContain(token);
    expect(env.raw()).toContain('"keepAwake"');
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
    let statusFails = false;
    const listened = await env.connect({
      [KeepAwakeLinkMethod.STATUS]: async () => {
        if (statusFails) throw Object.assign(new Error("Timed out"), { code: "TIMEOUT" });
        return { port: PORT + 1, expiresAt: null, reachedAt: null, problem: null };
      },
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
    // Refused, it isn't offered again for an hour, though the host holds none: links can't be
    // revoked. The host is still asked what it holds meanwhile.
    const mints = env.api.calls("POST", /\/signed-url$/).length;
    const asked = env.calls.filter((call) => call.method === KeepAwakeLinkMethod.STATUS).length;
    for (let i = 0; i < 59; i++) {
      env.api.advance(60);
      // A question that fails partway through the pause doesn't bring the next offer forward.
      statusFails = i === 20;
      await env.links.tick();
    }
    statusFails = false;
    // The host says nothing of the refusal, but its reason stays said through the pause.
    expect(env.status().keepAwake).toEqual({
      kind: "none",
      problem: "Agent 37 couldn't reach this host through the link Daintree gave it.",
    });
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(mints);
    expect(
      env.calls.filter((call) => call.method === KeepAwakeLinkMethod.STATUS).length
    ).toBeGreaterThanOrEqual(asked + 50);
    env.api.advance(60);
    await env.links.tick();
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(mints + 1);
  });

  it("says why the host holds none when the Shell can't mint one, and tries again on the same link", async () => {
    const env = await agent37();
    env.api.fail("POST", /\/signed-url$/, FakeAgent37Api.error(403, "forbidden", "Not allowed"));
    await env.connect();
    expect(env.status().keepAwake).toEqual({
      kind: "none",
      problem: expect.stringContaining("Daintree couldn't get a link from Agent 37"),
    });
    env.api.advance(300);
    await env.links.tick();
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(2);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
  });

  it("keeps the host's URL when the Shell can't mint a new one, and says why only while none is held", async () => {
    const env = await agent37();
    await env.connect();
    const held = env.status().keepAwake;
    env.api.fail("POST", /\/signed-url$/, FakeAgent37Api.error(403, "forbidden", "Not allowed"), 5);
    await env.connect();
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(2);
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
    // The device reconnects before the host answered on the first link, which isn't closed yet.
    const second = env.relink(undefined, "second");
    expect(first.session.isOpen).toBe(true);
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
