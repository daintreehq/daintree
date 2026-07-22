import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../../../shared/types/plugin.js";

const archiveMock = vi.hoisted(() => ({
  readArchiveManifest: vi.fn<(p: string) => Promise<PluginManifest>>(),
}));

const deepLinkMock = vi.hoisted(() => {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    painted: null as { send: (channel: string, payload: unknown) => void } | null,
    getPaintedPrimaryWebContents: vi.fn(() => deepLinkMock.painted),
    registerPaintedFlushListener: vi.fn((fn: () => void) => {
      listeners.push(fn);
    }),
  };
});

const utilsMock = vi.hoisted(() => ({ broadcastToRenderer: vi.fn() }));
const pendingErrorsMock = vi.hoisted(() => ({ appendPendingError: vi.fn() }));
const registryMock = vi.hoisted(() => ({
  getAllAppWebContents: vi.fn<() => { isDestroyed: () => boolean }[]>(() => [
    { isDestroyed: () => false },
  ]),
}));

vi.mock("../../services/PluginArchive.js", () => archiveMock);
vi.mock("../deepLinkInstall.js", () => ({
  getPaintedPrimaryWebContents: deepLinkMock.getPaintedPrimaryWebContents,
  registerPaintedFlushListener: deepLinkMock.registerPaintedFlushListener,
}));
vi.mock("../../ipc/utils.js", () => utilsMock);
vi.mock("../../ipc/pendingErrorsStore.js", () => pendingErrorsMock);
vi.mock("../../window/webContentsRegistry.js", () => registryMock);
vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { NOTIFICATION_SHOW_TOAST: "notification:show-toast", EVENTS_PUSH: "events:push" },
}));

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { name: "acme.tool", version: "1.2.3", ...overrides } as PluginManifest;
}

/** A painted primary window that records everything pushed to it. */
function makePainted() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    wc: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  };
}

function intentsFrom(sent: Array<{ channel: string; payload: unknown }>) {
  return sent.map((entry) => {
    const envelope = entry.payload as { name: string; payload: Record<string, unknown> };
    expect(entry.channel).toBe("events:push");
    expect(envelope.name).toBe("plugin:archive-install-intent");
    return envelope.payload;
  });
}

async function importFresh() {
  deepLinkMock.listeners.length = 0;
  const mod = await import("../archiveInstallIntent.js");
  mod._resetArchiveInstallIntentStateForTest();
  return mod;
}

describe("archiveInstallIntent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    deepLinkMock.painted = null;
    registryMock.getAllAppWebContents.mockReturnValue([{ isDestroyed: () => false }]);
    archiveMock.readArchiveManifest.mockResolvedValue(manifest());
  });

  it("never installs — it only pushes a preview of the parsed manifest", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    archiveMock.readArchiveManifest.mockResolvedValue(
      manifest({
        displayName: "Acme Tool",
        authors: [{ name: "Ada", role: "maintainer" }],
        capabilities: ["fs:project-read", "network:fetch"],
      })
    );

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent("/tmp/acme.dntr");

    const [intent] = intentsFrom(painted.sent);
    expect(intent).toMatchObject({
      archivePath: "/tmp/acme.dntr",
      archiveFileName: "acme.dntr",
      manifest: {
        name: "acme.tool",
        displayName: "Acme Tool",
        version: "1.2.3",
        authors: [{ name: "Ada", role: "maintainer" }],
        capabilities: ["fs:project-read", "network:fetch"],
      },
    });
    expect(intent).toHaveProperty("intentId", expect.any(String));
  });

  it("normalizes absent authors and capabilities to empty arrays", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent("/tmp/bare.dntr");

    const [intent] = intentsFrom(painted.sent) as Array<{
      manifest: { authors: unknown[]; capabilities: unknown[] };
    }>;
    expect(intent.manifest.authors).toEqual([]);
    expect(intent.manifest.capabilities).toEqual([]);
  });

  it("holds intents until a primary window has painted, then flushes FIFO", async () => {
    const { enqueueArchiveInstallIntent } = await importFresh();
    archiveMock.readArchiveManifest.mockImplementation(async (p: string) =>
      manifest({ name: `pkg${p.replace(/\D/g, "")}` })
    );

    await enqueueArchiveInstallIntent("/tmp/1.dntr");
    await enqueueArchiveInstallIntent("/tmp/2.dntr");

    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    expect(painted.sent).toHaveLength(0);

    // The paint signal is what releases the queue.
    for (const listener of deepLinkMock.listeners) listener();

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual(["/tmp/1.dntr", "/tmp/2.dntr"]);
  });

  it("preserves arrival order even when an earlier manifest resolves last", async () => {
    let releaseSlow: ((m: PluginManifest) => void) | undefined;
    archiveMock.readArchiveManifest.mockImplementation(async (p: string) => {
      if (p === "/tmp/slow.dntr") {
        return new Promise<PluginManifest>((resolve) => {
          releaseSlow = resolve;
        });
      }
      return manifest({ name: "fast" });
    });

    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    const { enqueueArchiveInstallIntent } = await importFresh();

    const slow = enqueueArchiveInstallIntent("/tmp/slow.dntr");
    const fast = enqueueArchiveInstallIntent("/tmp/fast.dntr");
    // The worker awaits a dynamic import before the manifest read, so spin the
    // microtask queue until the slow read is actually in flight.
    await vi.waitFor(() => expect(releaseSlow).toBeTypeOf("function"));
    expect(painted.sent).toHaveLength(0);

    releaseSlow?.(manifest({ name: "slow" }));
    await Promise.all([slow, fast]);

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual(["/tmp/slow.dntr", "/tmp/fast.dntr"]);
  });

  it("fails closed on an unreadable archive — no intent, an error instead", async () => {
    archiveMock.readArchiveManifest.mockRejectedValue(new Error("plugin.json is not valid JSON"));
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent("/tmp/bad.dntr");

    expect(painted.sent).toHaveLength(0);
    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      "notification:show-toast",
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("plugin.json is not valid JSON"),
      })
    );
  });

  it("keeps previewing the rest of a batch after one archive fails", async () => {
    archiveMock.readArchiveManifest.mockImplementation(async (p: string) => {
      if (p === "/tmp/bad.dntr") throw new Error("Archive size exceeds limit");
      return manifest({ name: "good" });
    });
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent("/tmp/bad.dntr");
    await enqueueArchiveInstallIntent("/tmp/good.dntr");

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual(["/tmp/good.dntr"]);
  });

  it("persists the failure durably when no renderer is live", async () => {
    archiveMock.readArchiveManifest.mockRejectedValue(new Error("boom"));
    registryMock.getAllAppWebContents.mockReturnValue([]);

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent("/tmp/bad.dntr");

    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    expect(pendingErrorsMock.appendPendingError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "main-process", message: expect.stringContaining("boom") })
    );
  });

  it("ignores a duplicate path that is still awaiting a decision", async () => {
    const { enqueueArchiveInstallIntent } = await importFresh();

    await enqueueArchiveInstallIntent("/tmp/dup.dntr");
    await enqueueArchiveInstallIntent("/tmp/dup.dntr");

    expect(archiveMock.readArchiveManifest).toHaveBeenCalledTimes(1);
  });

  it("prompts again for the same path once its intent has been delivered", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    const { enqueueArchiveInstallIntent } = await importFresh();

    await enqueueArchiveInstallIntent("/tmp/again.dntr");
    await enqueueArchiveInstallIntent("/tmp/again.dntr");

    expect(archiveMock.readArchiveManifest).toHaveBeenCalledTimes(2);
    expect(painted.sent).toHaveLength(2);
  });

  it("retains the head when a send throws, and redelivers on the next paint", async () => {
    let failSend = true;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    deepLinkMock.painted = {
      send: (channel: string, payload: unknown) => {
        if (failSend) throw new Error("destroyed");
        sent.push({ channel, payload });
      },
    };

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent("/tmp/retry.dntr");
    expect(sent).toHaveLength(0);

    failSend = false;
    for (const listener of deepLinkMock.listeners) listener();

    expect(intentsFrom(sent).map((i) => (i as { archivePath: string }).archivePath)).toEqual([
      "/tmp/retry.dntr",
    ]);
  });

  it("registers itself as a paint-flush listener on import", async () => {
    await importFresh();
    expect(deepLinkMock.registerPaintedFlushListener).toHaveBeenCalledWith(expect.any(Function));
  });
});
