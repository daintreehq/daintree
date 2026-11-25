import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type { CloudProviderId } from "../../../../shared/types/cloudHosts.js";
import type { CommandResult, CommandRunner } from "../../client/commandRunner.js";
import { Agent37Client } from "../agent37/Agent37Client.js";
import { Agent37Provider } from "../agent37/Agent37Provider.js";
import { CloudAccountService } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostLifecycle } from "../CloudHostLifecycle.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import type { CloudProvider } from "../provider.js";
import { FAKE_AGENT37_KEY, FakeAgent37Api } from "./fakeAgent37Api.js";

let root: string;
/** Every run a test started, ended with it even when an assertion stops the test first. */
const runs: CloudHostLifecycle[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-agent37-recovery-"));
});

afterEach(async () => {
  for (const lifecycle of runs.splice(0)) lifecycle.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

const ok: CommandResult = { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };

/** Makes the account's key as ssh-keygen would, and prints its public half for `-y`. */
const keygen = (async (cmd: string, args: string[]): Promise<CommandResult> => {
  if (cmd !== "ssh-keygen") return ok;
  const keyPath = args[args.length - 1]!;
  if (args.includes("-y")) return { ...ok, stdout: `${await fs.readFile(keyPath, "utf8")}\n` };
  const made = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForDaintree ${path.basename(keyPath)}`;
  await fs.writeFile(keyPath, made);
  await fs.writeFile(`${keyPath}.pub`, made);
  return ok;
}) as unknown as CommandRunner;

type SavedCreation = { sentAt: number | null } | null;

/**
 * Daintree's cloud runtime over the real Agent 37 provider and client, against
 * the fake API. A crash ends a run on the spot: nothing it would still write
 * reaches the settings file, and the next run starts from what was saved. A
 * quit ends it the way Daintree does, letting what it was doing wind down.
 */
async function agent37() {
  const api = new FakeAgent37Api();
  // Daintree's clock runs with Agent 37's, so a machine it made dates from its send.
  const skew = Date.now() - api.now;
  /**
   * Requests still in flight when Daintree quits: `held` never reached Agent 37,
   * `lost` did, and only its answer never came back.
   */
  const unanswered = new Map<string, "held" | "lost">();
  const sent: string[] = [];
  let saved: unknown;
  /** The create as saved when each request went out. */
  const savedWhenSent = new Map<string, SavedCreation>();
  const creationSaved = (): SavedCreation =>
    (saved as { bindings?: Array<{ creation: SavedCreation }> } | undefined)?.bindings?.[0]
      ?.creation ?? null;
  const fetch = (input: URL | string, init?: RequestInit): Promise<Response> => {
    const route = `${init?.method ?? "GET"} ${new URL(String(input)).pathname.replace(/^\/v1/, "")}`;
    sent.push(route);
    savedWhenSent.set(route, structuredClone(creationSaved()));
    const mode = unanswered.get(route);
    if (!mode) return api.fetch(input, init);
    return new Promise((_resolve, reject) => {
      // Taken by Agent 37, and only the answer lost; a fake that fails it fails the request.
      if (mode === "lost") void api.fetch(input, init).catch(reject);
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const vault = new MemoryCloudCredentialVault();
  const hosts: HostDescriptor[] = [];
  const files = new CloudSshFiles(path.join(root, "cloud"), keygen);
  const build = () => {
    let alive = true;
    const store = new CloudHostStore({
      // A copy: the store edits what it reads before it writes, and a crashed run must reach nothing.
      get: () => structuredClone(saved),
      set: (_key: "cloudHosts", value: CloudHostsValue) => {
        if (alive) saved = JSON.parse(JSON.stringify(value));
      },
    });
    const client = new Agent37Client({
      baseUrl: api.baseUrl,
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    // Its own process each run: what it remembers of registered keys goes with the crash.
    const provider = new Agent37Provider(() => client);
    const accounts = new CloudAccountService({
      store,
      vault,
      providers: new Map<CloudProviderId, CloudProvider>([["agent37", provider]]),
      apiUrlFor: () => api.baseUrl,
      platform: "darwin",
    });
    const lifecycle = new CloudHostLifecycle({
      store,
      accounts,
      files,
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
      sleep: async () => {},
      now: () => Date.now() - skew,
      // Wherever the test runs: a create refuses without the tunnel's command (#18180).
      findCommand: async (command) => (command === "agent37" ? "/usr/local/bin/agent37" : null),
    });
    runs.push(lifecycle);
    const crash = () => {
      alive = false;
      // Only so this run's waits end with the test; it writes nothing more.
      lifecycle.dispose();
      const next = build();
      next.lifecycle.start();
      return next;
    };
    const quit = async () => {
      lifecycle.dispose();
      await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
      alive = false;
      const next = build();
      next.lifecycle.start();
      return next;
    };
    return { store, accounts, lifecycle, crash, quit };
  };
  const first = build();
  const account = await first.accounts.addAccount({
    providerId: "agent37",
    credentials: { apiKey: FAKE_AGENT37_KEY },
    scopeId: "workspace",
  });
  const create = () =>
    first.lifecycle.create({
      accountId: account.id,
      name: "build",
      machineType: "2x4",
      lifetimeHours: null,
    });
  const until = (check: () => boolean) =>
    vi.waitFor(() => expect(check()).toBe(true), { timeout: 5_000 });
  const count = (route: string) => sent.filter((entry) => entry === route).length;
  return { api, unanswered, sent, savedWhenSent, first, create, until, count };
}

describe("an Agent 37 create interrupted before setup finished (#17928)", () => {
  it("asks Agent 37 for the machine on Retry after a crash while the key was being registered", async () => {
    const { api, unanswered, sent, savedWhenSent, first, create, until, count } = await agent37();
    // Agent 37 took the key; its answer was still on the way when Daintree quit.
    unanswered.set("POST /ssh-keys", "lost");
    await create();
    await until(() => sent.includes("POST /ssh-keys"));
    expect(savedWhenSent.get("POST /ssh-keys")).toMatchObject({ sentAt: null });
    expect(api.sshKeys).toHaveLength(1);
    expect(count("POST /instances")).toBe(0);

    const next = first.crash();
    await until(() => (next.lifecycle.statuses()[0]?.lastError ?? null) !== null);
    expect(next.store.bindings()[0]!.creation!.sentAt).toBeNull();
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: null,
      operation: null,
      providerUnavailable: null,
      lastError: { message: expect.stringContaining("Retry to create it") },
    });
    expect(next.lifecycle.statuses()[0]!.lastError!.code).not.toBe("outcome-unknown");

    unanswered.clear();
    await next.lifecycle.retryCreate("build");
    // The key it registered before the quit counts as registered now.
    expect(count("POST /ssh-keys")).toBe(2);
    expect(api.sshKeys).toHaveLength(1);
    expect(count("POST /instances")).toBe(1);
    const [instance] = [...api.instances.values()];
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: instance!.id,
      machine: "running",
      lastError: null,
    });
    expect(next.store.bindings()[0]!.creation).toBeNull();
    next.lifecycle.dispose();
  });

  it("asks Agent 37 for the machine on Retry after Daintree quits while the key was being registered", async () => {
    const { api, unanswered, sent, first, create, until, count } = await agent37();
    unanswered.set("POST /ssh-keys", "held");
    await create();
    await until(() => sent.includes("POST /ssh-keys"));

    const next = await first.quit();
    await until(() => (next.lifecycle.statuses()[0]?.lastError ?? null) !== null);
    expect(next.store.bindings()[0]!.creation!.sentAt).toBeNull();
    // Said by the run that quit, as its registration was stopped.
    expect(next.lifecycle.statuses()[0]!.lastError!.message).toMatch(
      /stopped while the machine was readied.*Retry to create it/
    );

    unanswered.clear();
    await next.lifecycle.retryCreate("build");
    expect(count("POST /instances")).toBe(1);
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: [...api.instances.values()][0]!.id,
      lastError: null,
    });
  });

  it("only looks again on Retry after a crash while the instance itself was asked for", async () => {
    const { unanswered, sent, savedWhenSent, first, create, until, count } = await agent37();
    unanswered.set("POST /instances", "held");
    await create();
    await until(() => sent.includes("POST /instances"));
    // Saved before the request left, so a lost answer is looked for, never sent again.
    expect(savedWhenSent.get("POST /instances")).toMatchObject({ sentAt: expect.any(Number) });

    const next = first.crash();
    await until(() => (next.lifecycle.statuses()[0]?.lastError ?? null) !== null);
    expect(next.lifecycle.statuses()[0]!.lastError).toMatchObject({
      code: "outcome-unknown",
      message: expect.stringContaining("hasn't shown a machine"),
    });

    unanswered.clear();
    const looked = count("GET /instances");
    await expect(next.lifecycle.retryCreate("build")).rejects.toThrow(/remove the host/);
    expect(count("GET /instances")).toBe(looked + 1);
    expect(count("POST /instances")).toBe(1);
    expect(next.store.bindings()[0]!.creation!.sentAt).toEqual(expect.any(Number));
    next.lifecycle.dispose();
  });

  it("binds the instance a lost answer made, once the restart finds it", async () => {
    const { api, unanswered, sent, first, create, until, count } = await agent37();
    unanswered.set("POST /instances", "lost");
    await create();
    await until(() => sent.includes("POST /instances"));

    const next = first.crash();
    const [instance] = [...api.instances.values()];
    await until(() => next.lifecycle.statuses()[0]?.resourceId === instance!.id);
    expect(count("POST /instances")).toBe(1);
    next.lifecycle.dispose();
  });

  it("says nothing was asked for when Agent 37 won't take the key, and Retry asks for it", async () => {
    const { api, first, create, until, count } = await agent37();
    api.fail(
      "POST",
      /^\/ssh-keys$/,
      FakeAgent37Api.error(400, "invalid_request", "A workspace holds at most 20 SSH keys.")
    );
    await create();
    await until(() => (first.lifecycle.statuses()[0]?.lastError ?? null) !== null);
    expect(first.lifecycle.statuses()[0]!.lastError).toMatchObject({
      code: "ssh-authorization",
      message: expect.stringMatching(/at most 20 SSH keys.*Retry to create it/),
    });
    expect(first.store.bindings()[0]!.creation!.sentAt).toBeNull();
    expect(count("POST /instances")).toBe(0);

    await first.lifecycle.retryCreate("build");
    expect(count("POST /instances")).toBe(1);
    expect(first.lifecycle.statuses()[0]).toMatchObject({ lastError: null });
    expect(first.lifecycle.statuses()[0]!.resourceId).not.toBeNull();
    first.lifecycle.dispose();
  });
});
