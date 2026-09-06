/* eslint-disable @typescript-eslint/no-explicit-any */
// The worker entry module has no test twin, so the commands-only bootstrap
// branch it gained in #12274 — boot the harness, import nothing, report
// activated — was provable only by deleting it and watching nothing fail.
// These drive the real module against a stubbed `process.parentPort`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const IDENTITY = {
  instanceId: "acme.demo",
  manifestId: "acme.demo",
  origin: "global" as const,
  projectId: null,
  projectRoot: null,
};

class FakeParentPort extends EventEmitter {
  posted: any[] = [];
  postMessage = (msg: any): void => {
    this.posted.push(msg);
  };
}

/**
 * The entry module runs on import and installs process-level handlers, so each
 * test gets a fresh module registry and hands back the listeners it added.
 */
async function loadWorker(port: FakeParentPort): Promise<void> {
  vi.resetModules();
  Object.defineProperty(process, "parentPort", {
    value: port,
    configurable: true,
    writable: true,
  });
  await import("../plugin-dev-worker.js");
}

/** Let the module's async `start()` settle — it awaits a real dynamic import. */
async function settled(port: FakeParentPort, type: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const found = port.posted.find((m) => m.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no "${type}" posted; got ${JSON.stringify(port.posted)}`);
}

describe("plugin worker bootstrap", () => {
  let tmpDir: string;
  let port: FakeParentPort;
  let rejectionListeners: NodeJS.UnhandledRejectionListener[];
  let exceptionListeners: NodeJS.UncaughtExceptionListener[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-worker-boot-"));
    port = new FakeParentPort();
    // The module adds process-level guards on import; snapshot so each test's
    // additions can be removed rather than accumulating across the file.
    rejectionListeners = process.listeners("unhandledRejection");
    exceptionListeners = process.listeners("uncaughtException");
  });

  afterEach(async () => {
    for (const l of process.listeners("unhandledRejection")) {
      if (!rejectionListeners.includes(l)) process.off("unhandledRejection", l);
    }
    for (const l of process.listeners("uncaughtException")) {
      if (!exceptionListeners.includes(l)) process.off("uncaughtException", l);
    }
    delete (process as { parentPort?: unknown }).parentPort;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("announces readiness once the message listener is attached", async () => {
    await loadWorker(port);
    expect(port.posted.find((m) => m.type === "ready")).toBeTruthy();
  });

  it("reports activated without importing anything when there is no bundle (#12274)", async () => {
    await loadWorker(port);
    port.emit("message", { type: "start", bundleUrl: undefined, pluginId: "acme.demo", identity: IDENTITY });

    expect(await settled(port, "activated")).toMatchObject({ hasCleanup: false });
    // A commands-only plugin has no `activate()` to fail, so nothing may be
    // reported as an activation error.
    expect(port.posted.find((m) => m.type === "activate-error")).toBeUndefined();
  });

  it("still serves a manifest command after a bundle-less start", async () => {
    // The whole point of booting with nothing to import: the harness is up and
    // able to import a command handler on first dispatch.
    const handler = path.join(tmpDir, "go.mjs");
    await fs.writeFile(handler, `export default async (args) => ({ ran: true, args })`);

    await loadWorker(port);
    port.emit("message", { type: "start", pluginId: "acme.demo", identity: IDENTITY });
    await settled(port, "activated");

    port.emit("message", {
      type: "invoke",
      requestId: "c1",
      kind: "command",
      namespacedId: "acme.demo.go",
      resolvedPath: handler,
      args: { n: 1 },
    });

    expect(await settled(port, "invoke-result")).toMatchObject({
      requestId: "c1",
      ok: true,
      result: { ran: true, args: { n: 1 } },
    });
  });

  it("still imports and activates a bundle when one is given", async () => {
    // The bundle-less branch must not have displaced the ordinary path.
    const bundle = path.join(tmpDir, "index.mjs");
    await fs.writeFile(bundle, `export const activate = () => () => {};`);

    await loadWorker(port);
    port.emit("message", {
      type: "start",
      bundleUrl: pathToFileURL(bundle).href,
      pluginId: "acme.demo",
      identity: IDENTITY,
    });

    expect(await settled(port, "activated")).toMatchObject({ hasCleanup: true });
  });
});
