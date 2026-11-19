import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-agent37-recovery-"));
});

afterEach(async () => {
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

/**
 * Daintree's cloud runtime over the real Agent 37 provider and client, against
 * the fake API. A crash ends a run on the spot: nothing it would still write
 * reaches the settings file, and the next run starts from what was saved.
 */
async function agent37() {
  const api = new FakeAgent37Api();
  /** Requests that go out but are never answered, as when Daintree quits while they're in flight. */
  const unanswered = new Set<string>();
  const sent: string[] = [];
  const fetch = (input: URL | string, init?: RequestInit): Promise<Response> => {
    const route = `${init?.method ?? "GET"} ${new URL(String(input)).pathname.replace(/^\/v1/, "")}`;
    sent.push(route);
    if (!unanswered.has(route)) return api.fetch(input, init);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  let saved: unknown;
  const vault = new MemoryCloudCredentialVault();
  const hosts: HostDescriptor[] = [];
  const files = new CloudSshFiles(path.join(root, "cloud"), keygen);
  const build = () => {
    let alive = true;
    const store = new CloudHostStore({
      get: () => saved,
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
    });
    const crash = () => {
      alive = false;
      // Only so this run's timers and waits end with the test; it writes nothing more.
      lifecycle.dispose();
      const next = build();
      next.lifecycle.start();
      return next;
    };
    return { store, accounts, lifecycle, crash };
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
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };
  return { api, unanswered, sent, first, create, until };
}

describe("an Agent 37 create interrupted before setup finished (#17928)", () => {
  it("asks Agent 37 for the machine on Retry after a quit while the key was being registered", async () => {
    const { api, unanswered, sent, first, create, until } = await agent37();
    unanswered.add("POST /ssh-keys");
    await create();
    await until(() => sent.includes("POST /ssh-keys"));

    const next = first.crash();
    await until(() => next.lifecycle.statuses()[0]?.lastError !== null);
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
    expect(sent.filter((route) => route === "POST /instances")).toHaveLength(1);
    const [instance] = [...api.instances.values()];
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: instance!.id,
      lastError: null,
    });
    next.lifecycle.dispose();
  });

  it("only looks again on Retry after a quit while the instance itself was asked for", async () => {
    const { unanswered, sent, first, create, until } = await agent37();
    unanswered.add("POST /instances");
    await create();
    await until(() => sent.includes("POST /instances"));

    const next = first.crash();
    await until(() => next.lifecycle.statuses()[0]?.lastError !== null);
    expect(next.lifecycle.statuses()[0]!.lastError).toMatchObject({
      code: "outcome-unknown",
      message: expect.stringContaining("hasn't shown a machine"),
    });

    unanswered.clear();
    await expect(next.lifecycle.retryCreate("build")).rejects.toThrow(/remove the host/);
    expect(sent.filter((route) => route === "POST /instances")).toHaveLength(1);
    expect(next.store.bindings()[0]!.creation!.sentAt).toEqual(expect.any(Number));
    next.lifecycle.dispose();
  });
});
