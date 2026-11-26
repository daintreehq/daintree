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
  /** When each nonce reached it, by Agent 37's clock. */
  const received = new Map<string, number>();
  const close = api.listen(instanceId, PORT, (forwarded, method) => {
    const pathname = forwarded.split("?")[0] ?? "";
    const nonce = pathname.startsWith(KEEP_AWAKE_PATH)
      ? pathname.slice(KEEP_AWAKE_PATH.length)
      : "";
    if (method === "GET" && expected.delete(nonce)) {
      received.set(nonce, api.now);
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
      const at = received.get(nonce) ?? null;
      received.delete(nonce);
      return at;
    },
    close,
  };
}

/** A promise the test resolves when it lets what waits on it go on. */
function opened(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
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
    label = "link",
    base: Record<string, (payload: unknown) => Promise<unknown>> = handlers
  ) =>
    ({
      isOpen: true,
      call: vi.fn(async (method: string, payload: unknown) => {
        calls.push({ label, method, payload });
        const handler = { ...base, ...answers }[method];
        if (!handler) throw unsupported();
        return handler(payload);
      }),
    }) as unknown as LinkSession & { isOpen: boolean };
  let current: (LinkSession & { isOpen: boolean }) | null = null;
  /** Links to the other machines' hosts, by host. */
  const others = new Map<string, LinkSession & { isOpen: boolean }>();
  let changes = 0;
  const newLinks = () =>
    new CloudKeepAwakeLinks({
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
  /** The Shell's links: a restart puts new ones, knowing only what is stored, in their place. */
  let links = newLinks();
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
    keepAwake: {
      statusFor: (id) => links.statusFor(id),
      tick: () => links.tick(),
      forgetRemoved: (bindings) => links.forgetRemoved(bindings),
      observed: (id) => links.observed(id),
    },
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
    get links() {
      return links;
    },
    /** The Shell restarts: what its links kept in memory is gone, what they stored stays. */
    restartShell: () => {
      links.dispose();
      links = newLinks();
    },
    /** As a provider read that comes back late, saying asleep since `sleptAt`. */
    staleSleep: (sleptAt: number) => {
      store.updateBinding(bindingId, (binding) => ({
        ...binding,
        observation: {
          ...binding.observation!,
          machine: "stopped",
          asleep: true,
          stoppedAt: new Date(sleptAt).toISOString(),
        },
      }));
      links.observed(bindingId);
    },
    machine,
    bindingId,
    calls,
    edgeRequests,
    run,
    status: () => lifecycle.statuses()[0]!,
    /** A person's refresh: an ordinary read of the instance. */
    refresh: () => lifecycle.refresh("build"),
    /** Agent 37's clock alone moves on: the host's process is frozen with its instance asleep. */
    frozen: (seconds: number) => {
      for (let passed = 0; passed < seconds; passed += 30) api.advance(30);
    },
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
    /** Another machine on the account, linked, its host answering only as `answers` say. */
    addHost: async (
      name: string,
      answers: Record<string, (payload: unknown) => Promise<unknown>>
    ) => {
      const other = api.seed({ auto_sleep: true, idle_timeout_seconds: 1800 });
      await lifecycle.importMachine({ accountId: account.id, resourceId: other.id, name });
      const session = link(answers, name, {});
      others.set(name, session);
      return { session, instanceId: other.id };
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
      lastRequestAt: env.api.now,
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
   * behind it on the same link; the host's first arms fail as `failures` say.
   */
  async function promotedMintFails(failures: Array<"refused" | "timed out">) {
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
        const failure = failures[arms++];
        if (failure === "refused") {
          throw Object.assign(new Error("refused"), {
            code: "VALIDATION",
            userMessage:
              "This host's port closed while it checked that link. Ask for its port again.",
          });
        }
        if (failure === "timed out") {
          throw Object.assign(new Error("Timed out"), { code: "OUTCOME_UNKNOWN" });
        }
        return env.keeper.arm(KeepAwakeArmSchema.parse(payload));
      },
    });
    const asking = env.links.run("build", session, false);
    const renewal = env.links.run("build", session, true);
    release();
    await asking;
    await renewal;
    // Long enough for a queued mint against the in-memory fake to have gone out.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { env, arms: () => arms, mints: () => env.api.calls("POST", /\/signed-url$/).length };
  }

  it("still offers the renewal queued behind a question whose own mint the host refused", async () => {
    const { env, arms, mints } = await promotedMintFails(["refused"]);
    // No hour's pause first: the renewal was asked for before the question chose to mint.
    await vi.waitFor(() => expect(env.status().keepAwake).toMatchObject({ kind: "held" }));
    expect(arms()).toBe(2);
    expect(mints()).toBe(3);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: env.api.signedUrls.at(-1)!.expiresAt * 1000,
      reachedAt: env.api.now,
    });
  });

  it("keeps the hour's pause once the queued renewal is refused too", async () => {
    const { env, arms, mints } = await promotedMintFails(["refused", "refused"]);
    expect(arms()).toBe(2);
    // What reached the host through the link it held before is still said.
    expect(env.status().keepAwake).toEqual({
      kind: "none",
      problem: "This host's port closed while it checked that link. Ask for its port again.",
      lastRequestAt: expect.any(Number),
    });
    for (let i = 0; i < 59; i++) {
      env.api.advance(60);
      await env.links.tick();
    }
    expect(mints()).toBe(3);
    env.api.advance(60);
    await env.links.tick();
    expect(mints()).toBe(4);
  });

  it("offers nothing more at once when the question's arm timed out, since the host may hold that URL", async () => {
    const { env, arms, mints } = await promotedMintFails(["timed out"]);
    expect(arms()).toBe(1);
    expect(mints()).toBe(2);
    // Tried again after the wait for a failure that may pass.
    for (let i = 0; i < 4; i++) {
      env.api.advance(60);
      await env.links.tick();
    }
    expect(mints()).toBe(2);
    env.api.advance(60);
    await env.links.tick();
    expect(mints()).toBe(3);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
  });

  /** A linked host whose answers to what it holds can be made to fail, minted once on connecting. */
  async function failingQuestions() {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    let statusFails = false;
    let portless = false;
    await env.connect({
      [KeepAwakeLinkMethod.STATUS]: async () => {
        if (statusFails) throw Object.assign(new Error("Timed out"), { code: "OUTCOME_UNKNOWN" });
        const status = await env.keeper.open();
        return portless ? { ...status, port: null } : status;
      },
    });
    return {
      env,
      /** The host says it has no port open, as when it couldn't open one. */
      setPortless: (next: boolean) => {
        portless = next;
      },
      mints: () => env.api.calls("POST", /\/signed-url$/).length,
      /** A pass after `seconds`, its question failing as said. */
      pass: async (seconds: number, fails = false) => {
        await env.run(seconds, seconds);
        statusFails = fails;
        await env.links.tick();
        statusFails = false;
      },
      /** Agent 37 stops taking the host's URL, and the busy host drops it on its next request. */
      loseUrl: async () => {
        env.api.signedUrls.splice(0);
        await env.run(60);
        expect(env.keeper.status()).toMatchObject({ expiresAt: null });
      },
    };
  }

  it("asks again five minutes after a question fails just as the host loses its URL, and hands it a new one", async () => {
    const { env, mints, pass, loseUrl } = await failingQuestions();
    await loseUrl();
    await pass(0, true);
    // The passes before then find it holding none and wait, one of them failing too without
    // putting the recheck off.
    await pass(60);
    await pass(60, true);
    await pass(60);
    await pass(60);
    await pass(50);
    expect(mints()).toBe(1);
    // Five minutes after the first failure, though the host was asked ten seconds ago.
    await pass(10);
    expect(mints()).toBe(2);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
    expect(env.keeper.status().reachedAt).toBe(env.api.now);
  });

  it("hands over at most one link a half hour through rechecks, and none to a host still holding one", async () => {
    const { env, mints, pass, loseUrl } = await failingQuestions();
    // A question fails while the host holds a URL that works: asked again, nothing is minted.
    await pass(60, true);
    for (let i = 0; i < 6; i++) await pass(60);
    expect(mints()).toBe(1);
    // That recheck was used up: losing the URL now waits out the half hour since the last.
    await loseUrl();
    await pass(0);
    for (let i = 0; i < 6; i++) await pass(60);
    expect(mints()).toBe(1);

    // A question fails just as it is lost again, and its recheck hands over a new one.
    await env.run(30 * 60);
    await env.links.tick();
    expect(mints()).toBe(2);
    await loseUrl();
    await pass(0, true);
    for (let i = 0; i < 5; i++) await pass(60);
    expect(mints()).toBe(3);
    // Lost and failed again within the half hour: no second link through a recheck.
    await loseUrl();
    await pass(0, true);
    for (let i = 0; i < 10; i++) await pass(60);
    expect(mints()).toBe(3);
    // Then the ordinary half hour since the last one, and that link clears the recheck.
    for (let i = 0; i < 20; i++) await pass(60, i === 15);
    expect(mints()).toBe(4);
    await loseUrl();
    for (let i = 0; i < 6; i++) await pass(60);
    expect(mints()).toBe(4);
  });

  it("spends a recheck's early link only on one it asks Agent 37 for", async () => {
    const { env, mints, pass, loseUrl, setPortless } = await failingQuestions();
    await loseUrl();
    await pass(0, true);
    for (let i = 0; i < 4; i++) await pass(60);
    await pass(50);
    // Due, the recheck finds the host holding none and no port open: nothing to mint for yet.
    setPortless(true);
    await pass(10);
    setPortless(false);
    expect(mints()).toBe(1);
    // Tried again once the port may be open, as any failure that may pass.
    for (let i = 0; i < 5; i++) await pass(60);
    expect(mints()).toBe(2);
    // Lost again with a failed question: the recheck may still hand over one early.
    await loseUrl();
    await pass(0, true);
    for (let i = 0; i < 6; i++) await pass(60);
    expect(mints()).toBe(3);
    expect(env.status().keepAwake).toMatchObject({ kind: "held" });
  });

  it("spends a recheck's early link only once Agent 37 is asked for it", async () => {
    const { mints, pass, loseUrl } = await failingQuestions();
    await loseUrl();
    await pass(0, true);
    for (let i = 0; i < 4; i++) await pass(60);
    await pass(50);
    // Due, the recheck finds the host holding none, but the account's key can't be read.
    const read = vi
      .spyOn(CloudAccountService.prototype, "credentials")
      .mockRejectedValueOnce(new Error("The keychain is locked"));
    await pass(10);
    read.mockRestore();
    expect(mints()).toBe(1);
    for (let i = 0; i < 5; i++) await pass(60);
    expect(mints()).toBe(2);
    // Lost again with a failed question: the recheck may still hand over one early.
    await loseUrl();
    await pass(0, true);
    for (let i = 0; i < 6; i++) await pass(60);
    expect(mints()).toBe(3);
  });

  it("starts every linked host's attempt on a pass, whatever another keeps it waiting for", async () => {
    const env = await agent37();
    const gates = { status: opened(), arm: opened() };
    try {
      // Both machines' hosts hold nothing yet, and take their time over every answer.
      env.attach({
        [KeepAwakeLinkMethod.STATUS]: async () => {
          await gates.status.promise;
          return env.keeper.open();
        },
        [KeepAwakeLinkMethod.ARM]: async (payload) => {
          await gates.arm.promise;
          return env.keeper.arm(KeepAwakeArmSchema.parse(payload));
        },
      });
      let otherId = "";
      const other = await env.addHost("test", {
        [KeepAwakeLinkMethod.STATUS]: async () => {
          await gates.status.promise;
          return { port: PORT, expiresAt: null, reachedAt: null, problem: null };
        },
        [KeepAwakeLinkMethod.ARM]: async (payload) => {
          const request = KeepAwakeArmSchema.parse(payload);
          // Only this machine's own port, through a grant Agent 37 made for it.
          expect(request.resourceId).toBe(otherId);
          expect(new URL(request.url).hostname).toBe(`${otherId}-${PORT}.agent37.app`);
          const token = new URL(request.url).searchParams.get("a37_token");
          expect(env.api.signedUrls.find((grant) => grant.token === token)?.instanceId).toBe(
            otherId
          );
          await gates.arm.promise;
          return {
            port: PORT,
            expiresAt: request.expiresAt,
            reachedAt: env.api.now,
            problem: null,
          };
        },
      });
      otherId = other.instanceId;
      const asked = (label: string, method: string) =>
        env.calls.filter((call) => call.label === label && call.method === method).length;

      // Each host is asked what it holds while the other's answer is still out; Agent 37 can't mint.
      env.api.fail(
        "POST",
        /\/signed-url$/,
        FakeAgent37Api.error(403, "forbidden", "Not allowed"),
        2
      );
      const first = env.links.tick();
      await vi.waitFor(() => {
        expect(asked("link", KeepAwakeLinkMethod.STATUS)).toBe(1);
        expect(asked("test", KeepAwakeLinkMethod.STATUS)).toBe(1);
      });
      gates.status.resolve();
      await first;
      expect(env.api.signedUrls).toHaveLength(0);

      // Tried again together, each host is handed its URL while the other's is still out.
      env.api.advance(300);
      const second = env.links.tick();
      await vi.waitFor(() => {
        expect(asked("link", KeepAwakeLinkMethod.ARM)).toBe(1);
        expect(asked("test", KeepAwakeLinkMethod.ARM)).toBe(1);
      });
      gates.arm.resolve();
      await second;
      expect(env.links.statusFor(env.bindingId)).toMatchObject({ kind: "held", reached: true });
      expect(env.links.statusFor(env.store.bindingForHost("test")!.id)).toMatchObject({
        kind: "held",
        reached: true,
      });
      expect(env.api.signedUrls.map((grant) => grant.instanceId).sort()).toEqual(
        [env.machine.id, otherId].sort()
      );
    } finally {
      gates.status.resolve();
      gates.arm.resolve();
    }
  });

  it("holds a newer, shorter URL that reached the host, and goes back to the longer one once it expires", async () => {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    await env.connect();
    const working = env.api.signedUrls[0]!;
    // A URL from elsewhere, an hour from its expiry, reaches the host: it is held, the longer one behind it.
    const token = "shorter".padEnd(32, "x");
    env.api.signedUrls.push({
      instanceId: env.machine.id,
      port: PORT,
      token,
      expiresAt: env.api.now / 1000 + 3600,
    });
    // What the host says it holds is how long it is covered: until the longer one's expiry.
    const longer = working.expiresAt * 1000;
    await expect(
      env.keeper.arm({
        resourceId: env.machine.id,
        url: `https://${env.machine.id}-${PORT}.agent37.app/?a37_token=${token}`,
        expiresAt: env.api.now + 3_600_000,
      })
    ).resolves.toMatchObject({ expiresAt: longer });
    // So the Shell, asking, records that, and renews nothing early.
    await env.run(60);
    await env.links.tick();
    expect(env.status().keepAwake).toMatchObject({ kind: "held", expiresAt: longer });
    expect(env.api.calls("POST", /\/signed-url$/)).toHaveLength(1);
    // Agent 37 stops taking the longer one: the host stays awake on the shorter, never asking it.
    env.api.signedUrls.splice(0, 1, { ...working, token: "revoked" });
    expect(await env.run(1800)).toBe(true);
    expect(env.keeper.status()).toMatchObject({ expiresAt: longer, problem: null });
    expect(new URL(env.edgeRequests.at(-1)!.url).searchParams.get("a37_token")).toBe(token);
    // Once the shorter one expires the host goes back to the longer, which Agent 37 now turns away.
    await env.run(1860);
    expect(env.keeper.status()).toMatchObject({
      expiresAt: null,
      problem: expect.stringContaining("no longer accepts"),
    });
  });

  it("keeps the URL that works behind one that is about to expire, and goes back to it", async () => {
    const env = await agent37({ idle_timeout_seconds: 86_400 });
    await env.connect();
    const working = env.api.signedUrls[0]!.expiresAt * 1000;
    const workingToken = env.api.signedUrls[0]!.token;
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
      expect(new URL(env.edgeRequests.at(-1)!.url).searchParams.get("a37_token")).toBe(
        workingToken
      );
    };

    // It reaches the host seconds before it expires, and its answer comes back too late.
    const late = elsewhere("late", 5);
    env.loseAnswers(() => env.api.advance(10));
    let accepted = env.accepted();
    await expect(env.keeper.arm(late)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.accepted()).toBe(accepted + 1);
    env.loseAnswers(null);
    await stillWorking();

    // It reaches the host with seconds to spare: held for them, the one that works behind it.
    accepted = env.accepted();
    await expect(env.keeper.arm(elsewhere("soon", 15))).resolves.toMatchObject({
      expiresAt: working,
    });
    expect(env.accepted()).toBe(accepted + 1);
    await stillWorking();

    // Taken while idle, it reaches the host on the first busy pass, seconds from its expiry.
    env.setBusy(false);
    await expect(env.keeper.arm(elsewhere("idle", 40))).resolves.toMatchObject({
      expiresAt: working,
    });
    env.setBusy(true);
    accepted = env.accepted();
    await env.run(30);
    expect(env.accepted()).toBe(accepted + 1);
    expect(new URL(env.edgeRequests.at(-1)!.url).searchParams.get("a37_token")).toBe(
      "idle".padEnd(32, "x")
    );
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
      lastRequestAt: expect.any(Number),
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
    expect(env.status().keepAwake).toEqual({
      kind: "expired",
      expiredAt: firstExpiry * 1000,
      lastRequestAt: expect.any(Number),
    });
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

describe("what an Agent 37 host's keep-awake observed (#17976)", () => {
  /** A link's token, written or encoded, and its origin: none of it may be kept. */
  function expectNoLink(env: Awaited<ReturnType<typeof agent37>>) {
    const raw = env.raw();
    for (const grant of env.api.signedUrls) {
      expect(raw).not.toContain(grant.token);
      expect(raw).not.toContain(encodeURIComponent(grant.token));
    }
    expect(raw).not.toContain("agent37.app");
    expect(raw).not.toContain("a37_token");
    expect(JSON.stringify(env.status())).not.toContain("agent37.app");
  }

  it("with Agent 37 crediting the host's requests: says when the last reached it, and no sleep", async () => {
    const env = await agent37();
    await env.connect();
    env.disconnect();
    expect(await env.run(3 * 1800)).toBe(true);
    await env.refresh();
    await env.connect();
    const view = env.status().keepAwake;
    expect(view).toMatchObject({
      kind: "held",
      lastRequestAt: env.api.now,
      expiresAt: env.api.signedUrls.at(-1)!.expiresAt * 1000,
    });
    expect(view).not.toHaveProperty("sleep");
    expect(view).not.toHaveProperty("gap");
    expectNoLink(env);
  });

  it("with Agent 37 not crediting them: records its sleep beside the last request, through later reads", async () => {
    const env = await agent37();
    env.api.creditsEdge = false;
    await env.connect();
    const start = env.accepted();
    // Busy all along and linked, its requests reaching it every minute, uncounted: Agent 37 sleeps
    // it anyway, and the host's process stands still from then.
    for (let passes = 0; passes < 200 && env.machine.status === "running"; passes++) {
      env.api.advance(30);
      if (env.machine.status !== "running") break;
      await env.keeper.tick();
      await env.links.tick();
    }
    expect(env.machine.status).toBe("sleeping");
    expect(env.accepted() - start).toBeGreaterThanOrEqual(28);
    const sleptAt = env.machine.slept_at! * 1000;
    const lastRequestAt = env.status().keepAwake!.lastRequestAt!;
    expect(sleptAt - lastRequestAt).toBeLessThanOrEqual(90_000);
    env.disconnect();
    await env.refresh();
    expect(env.status().keepAwake).toMatchObject({ sleep: { sleptAt, lastRequestAt } });
    expect(env.raw()).toContain('"keepAwakeSleep"');
    // Asleep on the next read, then woken by the host's next request and running on the one after.
    await env.refresh();
    await env.run(30);
    expect(env.machine.status).toBe("running");
    await env.refresh();
    expect(env.status().keepAwake).toMatchObject({ sleep: { sleptAt, lastRequestAt } });
    expectNoLink(env);

    // A device connects: the host says a request reached it since, and the sleep is over.
    await env.connect();
    expect(env.status().keepAwake).not.toHaveProperty("sleep");
    expect(env.status().keepAwake).toMatchObject({ lastRequestAt: env.api.now });
    // The same sleep read again, late, never brings it back.
    env.staleSleep(sleptAt);
    expect(env.status().keepAwake).not.toHaveProperty("sleep");
    expectNoLink(env);
  });

  it("ends a stored sleep on the first request a restarted Shell hears of after it", async () => {
    const env = await agent37();
    env.api.creditsEdge = false;
    await env.connect();
    const lastRequestAt = env.api.now;
    env.disconnect();
    env.frozen(1830);
    const sleptAt = env.machine.slept_at! * 1000;
    await env.refresh();
    env.restartShell();
    expect(env.status().keepAwake).toMatchObject({ sleep: { sleptAt, lastRequestAt } });
    // The host wakes, one request reaches it, and it goes idle before anyone connects.
    await env.run(30);
    const wokenAt = env.api.now;
    env.setBusy(false);
    await env.connect();
    await env.links.tick();
    expect(env.status().keepAwake).toMatchObject({ lastRequestAt: wokenAt });
    expect(env.status().keepAwake).not.toHaveProperty("sleep");
  });

  it("keeps a sleep the restarted Shell can't yet place after a request, when the host says the same one", async () => {
    const env = await agent37();
    await env.connect();
    const lastRequestAt = env.api.now;
    env.disconnect();
    env.setBusy(false);
    await env.run(1830);
    await env.refresh();
    const sleptAt = env.machine.slept_at! * 1000;
    env.restartShell();
    await env.connect();
    expect(env.status().keepAwake).toMatchObject({ lastRequestAt, sleep: { sleptAt } });
  });

  it("keeps a sleep read that comes back after a later request until a request after it", async () => {
    const env = await agent37();
    await env.connect();
    const sleptAt = env.api.now;
    await env.run(60);
    await env.links.tick();
    const heard = env.status().keepAwake!.lastRequestAt!;
    expect(heard).toBeGreaterThan(sleptAt);
    // A host clock running fast looks the same: so it is said, beside no time before it.
    env.staleSleep(sleptAt);
    expect(env.status().keepAwake).toMatchObject({ sleep: { sleptAt, lastRequestAt: heard } });
    await env.run(60);
    await env.links.tick();
    expect(env.status().keepAwake).not.toHaveProperty("sleep");
    expect(env.raw()).toContain('"cleared":true');
  });

  it("says an older host's problem in the details' own words", async () => {
    const env = await agent37();
    await env.connect({
      [KeepAwakeLinkMethod.STATUS]: async () => ({
        port: null,
        expiresAt: null,
        reachedAt: null,
        problem:
          "This host couldn't open a port for Agent 37 to reach it, so it can't keep the machine awake.",
      }),
    });
    expect(env.status().keepAwake).toEqual({
      kind: "none",
      problem:
        "This host couldn't open a port for Agent 37 to reach it, so it sends no requests while it sees work.",
    });
  });

  it("records a normal idle sleep, and keeps it through an idle reconnect and a new link", async () => {
    const env = await agent37();
    await env.connect();
    const lastRequestAt = env.api.now;
    env.disconnect();
    env.setBusy(false);
    await env.run(1830);
    expect(env.machine.status).toBe("sleeping");
    const sleptAt = env.machine.slept_at! * 1000;
    await env.refresh();
    expect(env.status().keepAwake).toMatchObject({ sleep: { sleptAt, lastRequestAt } });

    // Idle on reconnect: a new link, no request, and the same last request said again.
    await env.connect();
    expect(env.api.signedUrls).toHaveLength(2);
    await env.links.tick();
    expect(env.status().keepAwake).toMatchObject({
      kind: "held",
      lastRequestAt,
      sleep: { sleptAt, lastRequestAt },
    });

    // Work starts: its first request reaches the host, and the next check ends the sleep.
    env.setBusy(true);
    await env.run(30);
    env.api.advance(60);
    await env.links.tick();
    expect(env.status().keepAwake).not.toHaveProperty("sleep");
    expect(env.status().keepAwake).toMatchObject({ lastRequestAt: env.api.now - 60_000 });
  });

  it("keeps what it saw once the link expires", async () => {
    const env = await agent37();
    await env.connect();
    const lastRequestAt = env.api.now;
    env.disconnect();
    env.setBusy(false);
    await env.run(1830);
    await env.refresh();
    const sleptAt = env.machine.slept_at! * 1000;
    env.api.advance(SEVEN_DAYS_S);
    await env.links.tick();
    expect(env.status().keepAwake).toEqual({
      kind: "expired",
      expiredAt: env.api.signedUrls[0]!.expiresAt * 1000,
      lastRequestAt,
      sleep: { sleptAt, lastRequestAt },
    });
  });

  it("says a gap in the busy host's passes with no sleep reported is of unknown cause, not a sleep", async () => {
    const env = await agent37();
    await env.connect();
    await env.run(30);
    // A tick five minutes late: the host was busy, Agent 37 never slept it.
    const from = env.api.now;
    await env.run(300, 300);
    expect(env.machine.status).toBe("running");
    await env.refresh();
    await env.links.tick();
    const view = env.status().keepAwake;
    expect(view).toMatchObject({ kind: "held", gap: { from, to: env.api.now } });
    expect(view).not.toHaveProperty("sleep");
  });

  it("takes a gap the provider reported a sleep inside as that sleep", async () => {
    const env = await agent37();
    env.api.creditsEdge = false;
    await env.connect();
    await env.run(30);
    env.frozen(1830);
    expect(env.machine.status).toBe("sleeping");
    await env.refresh();
    expect(env.status().keepAwake).toHaveProperty("sleep");
    // The host thaws: its next pass is long after the last, and its request wakes the instance.
    await env.run(30);
    expect(env.keeper.status().gap).toBeDefined();
    await env.links.tick();
    // The request since ends the sleep, and the gap it left is never said as unexplained.
    const view = env.status().keepAwake;
    expect(view).not.toHaveProperty("gap");
    expect(view).not.toHaveProperty("sleep");

    // A later sleep taking that one's place leaves the gap explained.
    env.disconnect();
    env.setBusy(false);
    await env.run(1830);
    await env.refresh();
    expect(env.status().keepAwake).toHaveProperty("sleep");
    expect(env.status().keepAwake).not.toHaveProperty("gap");
  });
});
