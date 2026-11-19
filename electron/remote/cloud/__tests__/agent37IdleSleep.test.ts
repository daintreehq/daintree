import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderId } from "../../../../shared/types/cloudHosts.js";
import type { HostIdleObservation } from "../../../../shared/types/hostIdle.js";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type { CommandResult, CommandRunner } from "../../client/commandRunner.js";
import { TransportError, UnusableConnectionError } from "../../client/transport.js";
import type { LinkSession } from "../../link/session.js";
import { Agent37Client } from "../agent37/Agent37Client.js";
import { Agent37Provider } from "../agent37/Agent37Provider.js";
import { CloudAccountService } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostLifecycle, IDLE_SLEEP_HOST_TOO_OLD } from "../CloudHostLifecycle.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import type { CloudProvider } from "../provider.js";
import { FAKE_AGENT37_KEY, FakeAgent37Api, type FakeAgent37Instance } from "./fakeAgent37Api.js";

let root: string;
const disposers: Array<() => void> = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-agent37-idle-"));
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await fs.rm(root, { recursive: true, force: true });
});

const ok: CommandResult = { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
const noCommands = (async () => ok) as unknown as CommandRunner;

/** The host's answer to a claim: granted or not, an error, or one that waits for the test. */
type ClaimAnswer = boolean | Error | Promise<boolean>;

function unsupported(): Error {
  return Object.assign(new Error("Unknown method"), { code: "UNSUPPORTED" });
}

/** What the host's latest summary on the link says of its idle clock. */
type IdleReading = { idle: HostIdleObservation; sampledAt: number };

/**
 * Daintree's cloud runtime over the real Agent 37 provider and client, against
 * the fake API, with the keeper's idle pass reading the summaries a test hands
 * it. The link is a stand-in that answers the host's idle claim as the test says.
 */
async function agent37(instance: Partial<FakeAgent37Instance> = {}) {
  const api = new FakeAgent37Api();
  const skew = Date.now() - api.now;
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
  let answer: () => ClaimAnswer = () => true;
  const claims = vi.fn(async (_method: string) => {
    const said = await answer();
    if (said instanceof Error) throw said;
    return { granted: said };
  });
  const session = { isOpen: true, call: claims } as unknown as LinkSession;
  let reading: IdleReading | null = null;
  const release = vi.fn();
  const hosts: HostDescriptor[] = [];
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
    idleClaims: {
      sessionFor: () => (session.isOpen ? session : null),
      idleOn: () => reading,
      release,
    },
    sleep: async () => {},
    now: () => Date.now() - skew,
  });
  disposers.push(() => lifecycle.dispose());

  const account = await accounts.addAccount({
    providerId: "agent37",
    credentials: { apiKey: FAKE_AGENT37_KEY },
    scopeId: "workspace",
  });
  const seeded = api.seed({ auto_sleep: true, idle_timeout_seconds: 1800, ...instance });
  await lifecycle.importMachine({ accountId: account.id, resourceId: seeded.id, name: "build" });
  const bindingId = store.bindings()[0]!.id;

  let lastWorkAt = 1_000_000;
  /** What the host's latest summary says, idle and ended unless told otherwise, read by a keeper pass. */
  const summary = (idle: Partial<HostIdleObservation> = {}, sampledAt = lastWorkAt + 3_600_000) => {
    const after = idle.idleAfterMinutes ?? 30;
    reading = {
      idle: {
        idleAfterMinutes: after,
        lastWorkAt,
        busy: false,
        idleEndsAt: lastWorkAt + after * 60_000,
        ...idle,
      },
      sampledAt,
    };
    return lifecycle.stopIdleDue();
  };
  const until = (check: () => boolean) =>
    vi.waitFor(() => expect(check()).toBe(true), { timeout: 5_000 });
  const sleeps = () => api.calls("POST", `/instances/${seeded.id}/sleep`);
  const patches = () => api.calls("PATCH", `/instances/${seeded.id}`);
  return {
    api,
    store,
    lifecycle,
    session,
    claims,
    release,
    bindingId,
    machine: api.instances.get(seeded.id)!,
    summary,
    until,
    sleeps,
    patches,
    answerClaim: (next: () => ClaimAnswer) => {
      answer = next;
    },
    newWork: () => {
      lastWorkAt += 60 * 60_000;
    },
    status: () => lifecycle.statuses()[0]!,
  };
}

describe("putting a linked Agent 37 instance to sleep once its host is idle (#17916)", () => {
  it("sleeps an idle linked instance once the host grants its idle time, lets go of the link, and doesn't redial it", async () => {
    const env = await agent37();
    expect(env.status().linkedIdleStop).toEqual({ kind: "sleeps" });
    await env.summary();
    expect(env.claims).toHaveBeenCalledTimes(1);
    expect(env.sleeps()).toHaveLength(1);
    expect(env.machine.status).toBe("sleeping");
    expect(env.release).toHaveBeenCalledWith("build", env.session);
    expect(env.status()).toMatchObject({ machine: "stopped", asleep: true, lastError: null });

    // A dial reads the machine afresh and stops at "asleep": it never asks for a tunnel to it.
    const error = await env.lifecycle.ensureAccess(env.bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect(String((error as Error).message)).toContain("asleep");
    expect(env.machine.status).toBe("sleeping");

    // The same idle time again asks nothing more.
    await env.summary();
    expect(env.claims).toHaveBeenCalledTimes(1);
    expect(env.sleeps()).toHaveLength(1);
  });

  it("leaves a busy host's instance awake, and one whose host refuses the claim", async () => {
    const env = await agent37();
    await env.summary({ busy: true, idleEndsAt: null });
    // Ended by its own figures, but taken before the host's clock got there.
    await env.summary({}, 1_000_000 + 29 * 60_000);
    expect(env.claims).not.toHaveBeenCalled();

    // The host read afresh and saw work, or another device claimed it first.
    env.answerClaim(() => false);
    await env.summary();
    expect(env.claims).toHaveBeenCalledTimes(1);
    await env.summary();
    expect(env.claims).toHaveBeenCalledTimes(1);
    expect(env.sleeps()).toHaveLength(0);
    expect(env.machine.status).toBe("running");
    expect(env.release).not.toHaveBeenCalled();
  });

  it("counts a sleep that meets 409 try_again while Agent 37 writes its own checkpoint as asleep, sent once", async () => {
    const env = await agent37();
    // Agent 37's own sleep began as the request went out: the status flips first.
    env.api.fail("POST", /\/sleep$/, () => {
      env.machine.status = "sleeping";
      env.machine.slept_at = 1_781_222_400;
      return FakeAgent37Api.error(409, "try_again")();
    });
    await env.summary();
    expect(env.sleeps()).toHaveLength(1);
    expect(env.status()).toMatchObject({ asleep: true, lastError: null });
  });

  it("sends a sleep that meets 409 try_again on a running instance once, and says why it's awake", async () => {
    const env = await agent37();
    env.api.fail("POST", /\/sleep$/, FakeAgent37Api.error(409, "try_again"));
    await env.summary();
    expect(env.sleeps()).toHaveLength(1);
    expect(env.machine.status).toBe("running");
    expect(env.status().asleep).toBe(false);
    expect(env.status().lastError?.message).toBe(
      "Agent 37 didn't put the machine to sleep once the host's idle time ended: Agent 37 was busy with another change to the machine."
    );
    // The claim spent that idle time: nothing is sent again until new work ends another.
    await env.summary();
    expect(env.claims).toHaveBeenCalledTimes(1);
    env.newWork();
    await env.summary();
    expect(env.sleeps()).toHaveLength(2);
    expect(env.status()).toMatchObject({ asleep: true, lastError: null });
  });

  it("refuses every dial while the sleep is under way", async () => {
    const env = await agent37();
    let grant!: (granted: boolean) => void;
    env.answerClaim(() => new Promise<boolean>((resolve) => (grant = resolve)));
    const pass = env.summary();
    await env.until(() => env.claims.mock.calls.length === 1);
    const meanwhile = await env.lifecycle.ensureAccess(env.bindingId).catch((e: unknown) => e);
    expect(meanwhile).toBeInstanceOf(TransportError);
    grant(true);
    await pass;
    expect(env.sleeps()).toHaveLength(1);
    expect(env.status().asleep).toBe(true);
  });

  it("sends nothing to a host too old to confirm its idle time, and says so on that link", async () => {
    const env = await agent37();
    env.answerClaim(() => unsupported());
    await env.summary();
    expect(env.sleeps()).toHaveLength(0);
    expect(env.status().linkedIdleStop).toEqual({
      kind: "blocked",
      problem: IDLE_SLEEP_HOST_TOO_OLD,
    });
    // Not asked again on that link, whatever idle time comes next.
    env.newWork();
    await env.summary();
    expect(env.claims).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of a host with no open link", async () => {
    const env = await agent37();
    (env.session as { isOpen: boolean }).isOpen = false;
    await env.summary();
    expect(env.claims).not.toHaveBeenCalled();
  });

  it("leaves an instance whose own idle sleep is off awake", async () => {
    const env = await agent37({ auto_sleep: false });
    await env.summary();
    expect(env.claims).not.toHaveBeenCalled();
    expect(env.patches()).toHaveLength(0);
  });
});

describe("keeping an Agent 37 instance's own idle timeout at its host's idle time (#17916)", () => {
  it("brings a created instance's own idle timeout to the host's idle time, and to each one picked", async () => {
    const env = await agent37({ idle_timeout_seconds: 900 });
    env.store.updateBinding(env.bindingId, (current) => ({
      ...current,
      ownership: "created-by-daintree",
    }));
    await env.summary({ busy: true, idleEndsAt: null });
    await env.until(
      () => env.status().lifetime?.kind === "idle-sleep" && env.patches().length === 1
    );
    expect(env.patches()[0]!.body).toEqual({ idle_timeout_seconds: 1800 });
    await vi.waitFor(() =>
      expect(env.status().lifetime).toEqual({ kind: "idle-sleep", idleSeconds: 1800 })
    );
    expect(env.status().idleTimeFollowsHost).toBe(true);
    // Already there: nothing more is sent.
    await env.summary({ busy: true, idleEndsAt: null });
    expect(env.patches()).toHaveLength(1);

    env.lifecycle.idleTimePicked("build", [
      { key: "hostIdle.idleAfterMinutes", value: 60, revision: "r2" },
    ]);
    await env.until(() => env.patches().length === 2);
    expect(env.patches()[1]!.body).toEqual({ idle_timeout_seconds: 3600, auto_sleep: true });
    await env.until(() => env.machine.idle_timeout_seconds === 3600);
  });

  it("leaves an imported instance's own idle timeout alone until the person picks one, then follows the host", async () => {
    const env = await agent37({ idle_timeout_seconds: 600, name: "kept" });
    await env.summary({ busy: true, idleEndsAt: null });
    expect(env.patches()).toHaveLength(0);
    expect(env.status().idleTimeFollowsHost).toBe(false);

    env.lifecycle.idleTimePicked("build", [
      { key: "hostIdle.idleAfterMinutes", value: 30, revision: "r2" },
    ]);
    await env.until(() => env.patches().length === 1);
    expect(env.patches()[0]!.body).toEqual({ idle_timeout_seconds: 1800, auto_sleep: true });
    expect(env.store.bindings()[0]!.idleTimeChosen).toBe(true);
    expect(env.status().idleTimeFollowsHost).toBe(true);

    // Changed on the host from elsewhere: it follows now.
    await env.until(() => env.status().lifetime?.kind === "idle-sleep");
    await vi.waitFor(() =>
      expect(env.status().lifetime).toEqual({ kind: "idle-sleep", idleSeconds: 1800 })
    );
    // Each keeper pass reads the latest summary; the one after the pick settles sends it.
    await env.until(() => {
      void env.summary({ busy: true, idleEndsAt: null, idleAfterMinutes: 120 });
      return env.patches().length === 2;
    });
    expect(env.patches()[1]!.body).toEqual({ idle_timeout_seconds: 7200 });
    await env.until(() => env.machine.idle_timeout_seconds === 7200);
    expect(env.machine.name).toBe("kept");
  });

  it("turns an instance's own idle sleep on only when the person picks an idle time", async () => {
    const env = await agent37({ auto_sleep: false });
    env.store.updateBinding(env.bindingId, (current) => ({
      ...current,
      ownership: "created-by-daintree",
    }));
    await env.summary({ busy: true, idleEndsAt: null, idleAfterMinutes: 60 });
    expect(env.patches()).toHaveLength(0);
    env.lifecycle.idleTimePicked("build", [
      { key: "hostIdle.idleAfterMinutes", value: 60, revision: "r2" },
    ]);
    await env.until(() => env.machine.auto_sleep);
    expect(env.machine.idle_timeout_seconds).toBe(3600);
  });

  it("says when Agent 37 didn't take the idle time, and clears it once it does", async () => {
    const env = await agent37();
    env.api.fail("PATCH", /^\/instances\/[^/]+$/, FakeAgent37Api.error(403, "forbidden"));
    env.lifecycle.idleTimePicked("build", [
      { key: "hostIdle.idleAfterMinutes", value: 60, revision: "r2" },
    ]);
    await env.until(() => env.status().lastError !== null);
    expect(env.status().lastError?.message).toContain(
      "Agent 37 didn't take the host's idle time as the machine's own:"
    );
    env.lifecycle.idleTimePicked("build", [
      { key: "hostIdle.idleAfterMinutes", value: 60, revision: "r3" },
    ]);
    await env.until(() => env.status().lastError === null);
    expect(env.machine.idle_timeout_seconds).toBe(3600);
  });
});
