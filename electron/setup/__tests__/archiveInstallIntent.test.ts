import nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../../../shared/types/plugin.js";

// Production resolves every path through `path.resolve`, which turns P("x")
// into a drive-qualified path on Windows. Resolve the expected values the same
// way so assertions and mock branches match on every platform.
const P = (name: string) => nodePath.resolve("/tmp", name);

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
  // `category` short-circuits `resolvePluginCategory` so the fixture doesn't
  // need the full normalized `contributes` tree a real parse guarantees.
  return { name: "acme.tool", version: "1.2.3", category: "other", ...overrides } as PluginManifest;
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
    await enqueueArchiveInstallIntent(P("acme.dntr"));

    const [intent] = intentsFrom(painted.sent);
    expect(intent).toMatchObject({
      archivePath: P("acme.dntr"),
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
    // The projected category must cross IPC — the dialog's icon tile keys off it.
    expect(intent).toMatchObject({ manifest: { category: "other" } });
  });

  it("derives the preview category from contributions when none is declared", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    archiveMock.readArchiveManifest.mockResolvedValue(
      manifest({
        category: undefined,
        contributes: {
          forgeProviders: [{ id: "forge" }],
          agents: [],
          mcpServers: [],
          skills: [],
          panels: [],
          views: [],
        } as unknown as PluginManifest["contributes"],
      })
    );

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("forge.dntr"));

    const [intent] = intentsFrom(painted.sent);
    expect(intent).toMatchObject({ manifest: { category: "forge" } });
  });

  it("strips Unicode format controls from every display field before IPC", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    archiveMock.readArchiveManifest.mockResolvedValue(
      manifest({
        displayName: "Nice\u202ETool\u200Bt",
        authors: [{ name: "A\u200Bda", role: "main\u202Etainer" }],
      })
    );

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("bidi\u202E.dntr"));

    const [intent] = intentsFrom(painted.sent) as Array<{
      archivePath: string;
      archiveFileName: string;
      manifest: { displayName: string; authors: Array<{ name: string; role?: string }> };
    }>;
    expect(intent.manifest.displayName).toBe("NiceToolt");
    expect(intent.manifest.authors[0]).toMatchObject({ name: "Ada", role: "maintainer" });
    // Only the display copy is sanitized — the path must stay verbatim for the installer.
    expect(intent.archiveFileName).toBe("bidi.dntr");
    expect(intent.archivePath).toBe(P("bidi\u202E.dntr"));
  });

  it("normalizes absent authors and capabilities to empty arrays", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("bare.dntr"));

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

    await enqueueArchiveInstallIntent(P("1.dntr"));
    await enqueueArchiveInstallIntent(P("2.dntr"));

    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    expect(painted.sent).toHaveLength(0);

    // The paint signal is what releases the queue.
    for (const listener of deepLinkMock.listeners) listener();

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual([P("1.dntr"), P("2.dntr")]);
  });

  it("preserves arrival order even when an earlier manifest resolves last", async () => {
    let releaseSlow: ((m: PluginManifest) => void) | undefined;
    archiveMock.readArchiveManifest.mockImplementation(async (p: string) => {
      if (p === P("slow.dntr")) {
        return new Promise<PluginManifest>((resolve) => {
          releaseSlow = resolve;
        });
      }
      return manifest({ name: "fast" });
    });

    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    const { enqueueArchiveInstallIntent } = await importFresh();

    const slow = enqueueArchiveInstallIntent(P("slow.dntr"));
    const fast = enqueueArchiveInstallIntent(P("fast.dntr"));
    // The worker awaits a dynamic import before the manifest read, so spin the
    // microtask queue until the slow read is actually in flight.
    await vi.waitFor(() => expect(releaseSlow).toBeTypeOf("function"));
    expect(painted.sent).toHaveLength(0);

    releaseSlow?.(manifest({ name: "slow" }));
    await Promise.all([slow, fast]);

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual([P("slow.dntr"), P("fast.dntr")]);
  });

  it("fails closed on an unreadable archive — no intent, an error instead", async () => {
    archiveMock.readArchiveManifest.mockRejectedValue(new Error("plugin.json is not valid JSON"));
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("bad.dntr"));

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
      if (p === P("bad.dntr")) throw new Error("Archive size exceeds limit");
      return manifest({ name: "good" });
    });
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("bad.dntr"));
    await enqueueArchiveInstallIntent(P("good.dntr"));

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual([P("good.dntr")]);
  });

  it("persists the failure durably when no renderer is live", async () => {
    archiveMock.readArchiveManifest.mockRejectedValue(new Error("boom"));
    registryMock.getAllAppWebContents.mockReturnValue([]);

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("bad.dntr"));

    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    expect(pendingErrorsMock.appendPendingError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "main-process", message: expect.stringContaining("boom") })
    );
  });

  it("ignores a duplicate path that is still awaiting a decision", async () => {
    const { enqueueArchiveInstallIntent } = await importFresh();

    await enqueueArchiveInstallIntent(P("dup.dntr"));
    await enqueueArchiveInstallIntent(P("dup.dntr"));

    expect(archiveMock.readArchiveManifest).toHaveBeenCalledTimes(1);
  });

  it("prompts again for the same path once its intent has been delivered", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    const { enqueueArchiveInstallIntent } = await importFresh();

    await enqueueArchiveInstallIntent(P("again.dntr"));
    await enqueueArchiveInstallIntent(P("again.dntr"));

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
    await enqueueArchiveInstallIntent(P("retry.dntr"));
    expect(sent).toHaveLength(0);

    failSend = false;
    for (const listener of deepLinkMock.listeners) listener();

    expect(intentsFrom(sent).map((i) => (i as { archivePath: string }).archivePath)).toEqual([
      P("retry.dntr"),
    ]);
  });

  it("keeps a batch contiguous when a live archive arrives mid-drain", async () => {
    // Regression: awaiting each path in turn let a live arrival split a captured
    // batch, so prompts came out a, c, b instead of a, b, c.
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    const mod = await importFresh();

    const fireLive = () => void mod.enqueueArchiveInstallIntent(P("c.dntr"));
    archiveMock.readArchiveManifest.mockImplementation(async (p: string) => {
      if (p === P("a.dntr")) fireLive();
      return manifest({ name: "pkg" });
    });

    await mod.enqueueArchiveInstallIntents([P("a.dntr"), P("b.dntr")]);

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual([P("a.dntr"), P("b.dntr"), P("c.dntr")]);
  });

  it("starts a fresh worker for an archive queued as the previous drain ends", async () => {
    // Regression: nulling the worker handle a microtask late left a path queued
    // with no worker running — it sat unprocessed until an unrelated archive
    // happened to arrive.
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    const mod = await importFresh();

    await mod.enqueueArchiveInstallIntent(P("first.dntr"));
    await mod.enqueueArchiveInstallIntent(P("second.dntr"));

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual([P("first.dntr"), P("second.dntr")]);
  });

  it("keeps draining when error reporting itself throws", async () => {
    // A throwing error sink must not reject the shared worker promise and
    // strand every archive queued behind the bad one.
    registryMock.getAllAppWebContents.mockReturnValue([]);
    pendingErrorsMock.appendPendingError.mockImplementation(() => {
      throw new Error("store is corrupt");
    });
    archiveMock.readArchiveManifest.mockImplementation(async (p: string) => {
      if (p === P("bad.dntr")) throw new Error("invalid");
      return manifest({ name: "good" });
    });

    const mod = await importFresh();
    await expect(
      mod.enqueueArchiveInstallIntents([P("bad.dntr"), P("good.dntr")])
    ).resolves.toBeUndefined();

    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    for (const listener of deepLinkMock.listeners) listener();

    expect(
      intentsFrom(painted.sent).map((i) => (i as { archivePath: string }).archivePath)
    ).toEqual([P("good.dntr")]);
  });

  it("clamps attacker-controlled preview strings before they cross IPC", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    archiveMock.readArchiveManifest.mockResolvedValue(
      manifest({ displayName: "x".repeat(5_000), authors: [{ name: "y".repeat(5_000) }] })
    );

    const mod = await importFresh();
    await mod.enqueueArchiveInstallIntent(P("huge.dntr"));

    const [intent] = intentsFrom(painted.sent) as Array<{
      manifest: { displayName: string; authors: Array<{ name: string }> };
    }>;
    expect(intent.manifest.displayName.length).toBeLessThan(500);
    expect(intent.manifest.authors[0]!.name.length).toBeLessThan(500);
  });

  it("registers itself as a paint-flush listener on import", async () => {
    await importFresh();
    expect(deepLinkMock.registerPaintedFlushListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it("discloses contributed recipe names and the true count (#11860)", async () => {
    // Recipes ship with no capability to advertise them, so this dialog is the
    // only place a user sees them before approving.
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    archiveMock.readArchiveManifest.mockResolvedValue(
      manifest({
        contributes: {
          recipes: [
            { id: "a", name: "Deploy stack", terminals: [] },
            { id: "b", name: "Run \u202Etset", terminals: [] },
          ],
        },
      } as unknown as Partial<PluginManifest>)
    );

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("recipes.dntr"));

    const [intent] = intentsFrom(painted.sent);
    const recipes = (intent as { manifest: { recipes: { count: number; names: string[] } } })
      .manifest.recipes;
    expect(recipes.count).toBe(2);
    expect(recipes.names[0]).toBe("Deploy stack");
    // Bidi overrides can repaint the dialog's own trusted copy, so they are
    // stripped from every author-controlled string that crosses IPC.
    expect(recipes.names[1]).not.toContain("\u202E");
  });

  it("reports no recipes for a manifest that contributes none (#11860)", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("plain.dntr"));

    const [intent] = intentsFrom(painted.sent);
    expect(intent).toMatchObject({ manifest: { recipes: { count: 0, names: [] } } });
  });

  it("sends every recipe name, not a leading subset (#12001)", async () => {
    // The preview used to arrive truncated, leaving the D2 confirm to print
    // "+N more" for executable content nothing downstream could open. The
    // schema already bounds this at 50 recipes of 200 characters, so the
    // dialog bounds its viewport instead of the data.
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    const declared = Array.from({ length: 24 }, (_, i) => ({
      id: `r${i}`,
      name: `Recipe ${i}`,
      terminals: [],
    }));
    archiveMock.readArchiveManifest.mockResolvedValue(
      manifest({ contributes: { recipes: declared } } as unknown as Partial<PluginManifest>)
    );

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("many-recipes.dntr"));

    const [intent] = intentsFrom(painted.sent);
    const recipes = (intent as { manifest: { recipes: { count: number; names: string[] } } })
      .manifest.recipes;
    expect(recipes.names).toHaveLength(declared.length);
    expect(recipes.count).toBe(recipes.names.length);
    // The last one specifically: a `.slice()` regression keeps the head intact.
    expect(recipes.names.at(-1)).toBe(declared.at(-1)!.name);
  });

  it("still clamps and sanitizes names once the subset cap is gone (#12001)", async () => {
    const painted = makePainted();
    deepLinkMock.painted = painted.wc;
    archiveMock.readArchiveManifest.mockResolvedValue(
      manifest({
        contributes: {
          recipes: [
            ...Array.from({ length: 15 }, (_, i) => ({
              id: `p${i}`,
              name: `Pad ${i}`,
              terminals: [],
            })),
            { id: "long", name: "L".repeat(500), terminals: [] },
            { id: "bidi", name: "Run \u202Etset", terminals: [] },
          ],
        },
      } as unknown as Partial<PluginManifest>)
    );

    const { enqueueArchiveInstallIntent } = await importFresh();
    await enqueueArchiveInstallIntent(P("hostile-recipes.dntr"));

    const [intent] = intentsFrom(painted.sent);
    const { names } = (intent as { manifest: { recipes: { count: number; names: string[] } } })
      .manifest.recipes;
    // Past the old cap of ten, so both would have been dropped before.
    const long = names.at(-2)!;
    expect(long.length).toBeLessThan(500);
    expect(long.endsWith("\u2026")).toBe(true);
    expect(names.at(-1)).not.toContain("\u202E");
  });
});
