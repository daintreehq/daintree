import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { openAndOnboardProject } from "../../helpers/project";
import { createFixtureRepo, removePathSync, type FixtureRepo } from "../../helpers/fixtures";
import {
  installProjectPlugin,
  openProjectPluginPanel,
  trustProjectPlugins,
  waitForProjectPluginPanelKind,
} from "../../helpers/projectPlugins";
import type { PluginPerfSnapshot } from "../../../shared/types/pluginMetrics";

// A third-party plugin's real path: committed under the project's
// `.daintree/plugins/`, trusted, loaded with `isBuiltin: false`, activated in a
// forked worker, and talking to the host and its view over IPC. Every
// assertion here is about a transport or platform guarantee on that path, so
// the fixture is a zero-build plugin written inline rather than a demo.

const NAME = "acme.workerpath";
const MiB = 1024 * 1024;

const WORKER = String.raw`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function activate(host) {
  const worktrees = { raw: 0, coalesced: 0, rawLast: 0, coalescedLast: 0 };
  await host.onDidChangeWorktrees((list) => {
    worktrees.coalesced++;
    worktrees.coalescedLast = list.length;
  });
  await host.onDidChangeWorktrees(
    (list) => {
      worktrees.raw++;
      worktrees.rawLast = list.length;
    },
    { debounceMs: 0 }
  );

  await host.registerHandler("slow", async () => {
    await sleep(15_000);
    return "late";
  }, { timeoutMs: 300 });
  await host.registerHandler("argBytes", async (_ctx, arg) => (typeof arg === "string" ? arg.length : -1));
  await host.registerHandler("bigResult", async (_ctx, bytes) => "r".repeat(bytes));
  await host.registerHandler("push", async (_ctx, { channel, payload, panelId }) => {
    try {
      await host.postToPanel(channel, payload, panelId);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  });
  await host.registerHandler("burst", async (_ctx, count) => {
    const sent = [];
    for (let i = 0; i < count; i++) sent.push(host.postToPanel("burst", i));
    await Promise.all(sent);
    return count;
  });
  await host.registerHandler("worktreeCounts", async () => ({ ...worktrees }));
  await host.registerHandler("readFiles", async (_ctx, paths) => host.fs.readFiles(paths));

  return () => {};
}
`;

const VIEW = String.raw`
import { createElement as h, useEffect } from "react";
import { Button, Icon, useDaintreeTheme } from "@daintreehq/plugin-ui";

export default function WorkerPathView({ pluginId, panelId }) {
  const theme = useDaintreeTheme();
  useEffect(() => {
    const all = (window.__workerPath = window.__workerPath || {});
    const mine = (all[panelId] = { burst: [], targeted: [] });
    const offBurst = window.electron.plugin.on(pluginId, "burst", (n) => mine.burst.push(n));
    const offTargeted = window.electron.plugin.onPanel(pluginId, "targeted", panelId, (p) =>
      mine.targeted.push(p)
    );
    return () => {
      offBurst();
      offTargeted();
      delete all[panelId];
    };
  }, [pluginId, panelId]);
  return h(
    "div",
    {
      "data-testid": "worker-path-root",
      "data-panel": panelId,
      "data-color-mode": theme.colorMode,
      "data-theme-id": theme.themeId,
    },
    h(Button, { icon: "check" }, "Run"),
    h(Icon, { name: "activity", "aria-label": "Activity" })
  );
}
`;

interface ViewInbox {
  burst: number[];
  targeted: Array<{ to: string; n: number }>;
}

let ctx: AppContext | undefined;
let fixture: FixtureRepo;
let page: Page;
let pluginId = "";
let kindId = "";
let panelA = "";
const extraWorktrees: string[] = [];

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(({ id, ch, a }) => window.electron.plugin.invoke(id, ch, ...a), {
    id: pluginId,
    ch: channel,
    a: args,
  });
}

/** Invoke and return the rejection message the renderer sees, or null if it resolved. */
async function invokeError(channel: string, ...args: unknown[]): Promise<string | null> {
  return page.evaluate(
    async ({ id, ch, a }) => {
      try {
        await window.electron.plugin.invoke(id, ch, ...a);
        return null;
      } catch (err) {
        return String((err as Error)?.message ?? err);
      }
    },
    { id: pluginId, ch: channel, a: args }
  );
}

/** Same as {@link invokeError}, with an argument built in the renderer so it never crosses CDP. */
async function invokeWithStringArg(channel: string, bytes: number): Promise<unknown> {
  return page.evaluate(
    async ({ id, ch, n }) => {
      try {
        return { ok: true, value: await window.electron.plugin.invoke(id, ch, "a".repeat(n)) };
      } catch (err) {
        return { ok: false, message: String((err as Error)?.message ?? err) };
      }
    },
    { id: pluginId, ch: channel, n: bytes }
  );
}

async function inbox(panelId: string): Promise<ViewInbox | null> {
  return page.evaluate(
    (id) =>
      (window as unknown as { __workerPath?: Record<string, ViewInbox> }).__workerPath?.[id] ??
      null,
    panelId
  );
}

async function resetInboxes(): Promise<void> {
  await page.evaluate(() => {
    const all = (window as unknown as { __workerPath?: Record<string, ViewInbox> }).__workerPath;
    for (const box of Object.values(all ?? {})) {
      box.burst.length = 0;
      box.targeted.length = 0;
    }
  });
}

async function closePanel(panelId: string): Promise<void> {
  await page.evaluate(
    (id) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (
            i: string,
            a: unknown,
            o: { source: string }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction("terminal.close", { terminalId: id }, { source: "user" }),
    panelId
  );
  await expect(
    page.locator(`[data-testid="worker-path-root"][data-panel="${panelId}"]`)
  ).toHaveCount(0);
}

async function snapshot(): Promise<PluginPerfSnapshot | undefined> {
  const all = await page.evaluate(() => window.electron.plugin.getPerfSnapshots());
  return all.find((s) => s.pluginId === pluginId);
}

interface RecordedBatch {
  /** Receiving webContents id. */
  to: number;
  /** This plugin's entries, in wire order: channel suffix and target panel (null = broadcast). */
  entries: Array<{ channel: string; panelId: string | null }>;
}

/**
 * Record what main actually hands to IPC on the batched push channel, for this
 * plugin only, until the returned function restores the original `send` and
 * returns the batches.
 */
async function recordPushBatches(): Promise<() => Promise<RecordedBatch[]>> {
  await ctx!.app.evaluate(({ webContents }, prefix) => {
    type Send = (this: { id: number }, channel: string, ...args: unknown[]) => void;
    const g = globalThis as unknown as {
      __wpRecorder?: { original: Send; proto: { send: Send }; batches: RecordedBatch[] };
    };
    if (g.__wpRecorder) throw new Error("push recorder already installed");
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]) as { send: Send };
    const recorder = { original: proto.send, proto, batches: [] as RecordedBatch[] };
    g.__wpRecorder = recorder;
    proto.send = function (channel, ...args) {
      if (channel === "plugin-push:batch" && Array.isArray(args[0])) {
        const entries = (args[0] as Array<[string, { panelId?: unknown }]>)
          .filter(([full]) => full.startsWith(prefix))
          .map(([full, env]) => ({
            channel: full.slice(prefix.length),
            panelId: typeof env?.panelId === "string" ? env.panelId : null,
          }));
        if (entries.length > 0) recorder.batches.push({ to: this.id, entries });
      }
      return recorder.original.call(this, channel, ...args);
    };
  }, `plugin:${pluginId}:`);
  return () =>
    ctx!.app.evaluate(() => {
      const g = globalThis as unknown as {
        __wpRecorder?: {
          original: unknown;
          proto: { send: unknown };
          batches: RecordedBatch[];
        };
      };
      const recorder = g.__wpRecorder;
      if (!recorder) return [];
      recorder.proto.send = recorder.original;
      delete g.__wpRecorder;
      return recorder.batches;
    });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test.describe("Third-party plugin on the worker path", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    fixture = createFixtureRepo({ name: "plugin-worker-path" });
    writeFileSync(path.join(fixture.dir, "alpha.txt"), "ALPHA\n");
    writeFileSync(path.join(fixture.dir, "bravo.txt"), "BRAVO\n");
    mkdirSync(path.join(fixture.dir, "folder"), { recursive: true });
    installProjectPlugin(fixture.dir, NAME, {
      manifest: {
        version: "0.1.0",
        scope: "project",
        displayName: "Worker Path",
        main: "dist/index.mjs",
        engines: { daintree: ">=0.11.0" },
        capabilities: ["fs:project-read"],
        contributes: {
          panels: [
            {
              id: "main",
              name: "Worker Path",
              iconId: "puzzle",
              color: "var(--theme-category-orange)",
            },
          ],
          views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
        },
      },
      files: { "dist/index.mjs": WORKER, "dist/panel.js": VIEW },
    });
    ctx = await launchApp({});
    page = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
    ctx.window = page;
    await trustProjectPlugins(page);
    ({ kindId, pluginId } = await waitForProjectPluginPanelKind(page, NAME));
    panelA = await openProjectPluginPanel(page, kindId);
    await expect(
      page.locator(`[data-testid="worker-path-root"][data-panel="${panelA}"]`)
    ).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => inbox(panelA).then(Boolean)).toBe(true);
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app);
    for (const dir of extraWorktrees) removePathSync(dir);
    fixture?.cleanup();
  });

  test("loads as a non-builtin plugin running in a forked worker", async () => {
    const listed = await page.evaluate(() => window.electron.plugin.list());
    const entry = listed.find((p) => p.instanceId === pluginId);
    expect(entry, `${pluginId} not listed`).toBeDefined();
    expect(entry!.manifest.name).toBe(NAME);
    expect(entry!.origin).toBe("project");
    expect(entry!.isBuiltin).toBe(false);
    await expect.poll(async () => (await snapshot())?.isolation).toBe("worker");
  });

  test("renders kit components from @daintreehq/plugin-ui and reads the theme", async () => {
    const root = page.locator(`[data-testid="worker-path-root"][data-panel="${panelA}"]`);
    const button = root.getByRole("button", { name: "Run" });
    await expect(button).toBeVisible();
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(root.getByRole("img", { name: "Activity" })).toBeVisible();
    expect(["dark", "light"]).toContain(await root.getAttribute("data-color-mode"));
    expect(await root.getAttribute("data-theme-id")).toBeTruthy();
  });

  test("an invoke past its handler's timeoutMs rejects with PLUGIN_INVOKE_TIMEOUT", async () => {
    const started = Date.now();
    const message = await invokeError("slow");
    test.info().annotations.push({ type: "timeout-ms", description: String(Date.now() - started) });
    // The handler sleeps 15s and never settles on its own before this error.
    expect(message).toMatch(/^PLUGIN_INVOKE_TIMEOUT:/);
    expect(message).toContain("within 300 ms");
  });

  test("invoke arguments: 2 MiB succeeds, over 4 MiB is refused as too large", async () => {
    expect(await invokeWithStringArg("argBytes", 2 * MiB)).toEqual({ ok: true, value: 2 * MiB });
    // Past the handler cap but inside the IPC envelope's headroom, so the
    // named cap — not the generic envelope guard — is what refuses it.
    const justOver = (await invokeWithStringArg("argBytes", 4 * MiB + 16 * 1024)) as {
      ok: boolean;
      message?: string;
    };
    expect(justOver.ok).toBe(false);
    expect(justOver.message).toMatch(/^PLUGIN_PAYLOAD_TOO_LARGE:/);
    expect(justOver.message).toContain(`the ${4 * MiB}-byte limit`);
  });

  test("an invoke argument past the IPC envelope is refused as PLUGIN_PAYLOAD_TOO_LARGE too", async () => {
    // Over the envelope guard's 4 MiB + 64 KiB budget, which refuses it before
    // the handler runs — with the same named error, not a generic AppError.
    const farOver = (await invokeWithStringArg("argBytes", 6 * MiB)) as {
      ok: boolean;
      message?: string;
    };
    expect(farOver.ok).toBe(false);
    expect(farOver.message).toMatch(/^PLUGIN_PAYLOAD_TOO_LARGE:/);
    expect(farOver.message).toContain(`the ${4 * MiB + 64 * 1024}-byte limit`);
  });

  test("an invoke result over 16 MiB is refused as too large", async () => {
    const message = await invokeError("bigResult", 17 * MiB);
    expect(message).toMatch(/^PLUGIN_PAYLOAD_TOO_LARGE:/);
    expect(message).toContain(`the ${16 * MiB}-byte limit`);
    // The same handler under the cap still returns.
    expect(await invoke("bigResult", 1024)).toHaveLength(1024);
  });

  test("a push over 1 MiB is refused in the worker as too large", async () => {
    const refused = (await invoke("push", {
      channel: "big",
      payload: "p".repeat(MiB + 1024),
      panelId: null,
    })) as { ok: boolean; message?: string };
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/^PLUGIN_PAYLOAD_TOO_LARGE:/);
    expect(refused.message).toContain(`the ${MiB}-byte limit`);
  });

  test("1,000 pushes posted in a loop all reach the view, in order, in batches", async () => {
    await resetInboxes();
    const stop = await recordPushBatches();
    let batches: RecordedBatch[];
    try {
      expect(await invoke("burst", 1000)).toBe(1000);
      await expect
        .poll(async () => (await inbox(panelA))?.burst.length, { timeout: 20_000 })
        .toBe(1000);
    } finally {
      batches = await stop();
    }
    expect((await inbox(panelA))!.burst).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    const burst = batches
      .map((b) => b.entries.filter((e) => e.channel === "burst").length)
      .filter((n) => n > 0);
    test.info().annotations.push({
      type: "push-batches",
      description: `${burst.length} IPC messages carried ${burst.reduce((a, b) => a + b, 0)} pushes`,
    });
    // Every push crossed IPC exactly once, and pushes shared messages rather
    // than each costing one.
    expect(burst.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Math.max(...burst)).toBeGreaterThan(1);
    expect(burst.length).toBeLessThan(1000);
  });

  test("a push targeted at one panel is not delivered to a sibling of the same kind", async () => {
    const panelB = await openProjectPluginPanel(page, kindId, { reuseExisting: false });
    expect(panelB).not.toBe(panelA);
    try {
      await expect(
        page.locator(`[data-testid="worker-path-root"][data-panel="${panelB}"]`)
      ).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => inbox(panelB).then(Boolean)).toBe(true);
      await resetInboxes();
      const stop = await recordPushBatches();
      let batches: RecordedBatch[];
      try {
        for (let n = 0; n < 5; n++) {
          expect(
            await invoke("push", { channel: "targeted", payload: { to: "A", n }, panelId: panelA })
          ).toEqual({ ok: true });
        }
        // B's own push goes last; pushes reach a renderer in order, so once it has
        // arrived, any misrouted A push would already be in B's inbox.
        expect(
          await invoke("push", { channel: "targeted", payload: { to: "B", n: 0 }, panelId: panelB })
        ).toEqual({ ok: true });
        await expect.poll(async () => (await inbox(panelB))?.targeted.length).toBe(1);
      } finally {
        batches = await stop();
      }
      // On the wire each push stays addressed to its own panel and goes to one
      // renderer — not re-broadcast for the renderer to sort out. Both panels
      // share this project's renderer, so the per-panel split below is the
      // preload honouring that address.
      const targeted = batches.flatMap((b) =>
        b.entries.filter((e) => e.channel === "targeted").map((e) => ({ ...e, to: b.to }))
      );
      expect(targeted.map((e) => e.panelId)).toEqual([...Array(5).fill(panelA), panelB]);
      expect(new Set(targeted.map((e) => e.to)).size).toBe(1);
      expect((await inbox(panelB))!.targeted).toEqual([{ to: "B", n: 0 }]);
      expect((await inbox(panelA))!.targeted).toEqual(
        Array.from({ length: 5 }, (_, n) => ({ to: "A", n }))
      );
    } finally {
      await closePanel(panelB);
    }
  });

  test("onDidChangeWorktrees coalesces a burst by default; debounceMs: 0 delivers it raw", async () => {
    type Counts = { raw: number; coalesced: number; rawLast: number; coalescedLast: number };
    const counts = () => invoke("worktreeCounts") as Promise<Counts>;
    // Quiet = three consecutive identical reads a second apart, so a status
    // poll landing between two reads cannot pass for the end of a burst.
    const waitQuiet = async (): Promise<Counts> => {
      let last = await counts();
      let stable = 0;
      await expect
        .poll(
          async () => {
            const now = await counts();
            stable = now.raw === last.raw && now.coalesced === last.coalesced ? stable + 1 : 0;
            last = now;
            return stable >= 3 && now.rawLast > 0;
          },
          { timeout: 45_000, intervals: [1_000] }
        )
        .toBe(true);
      return last;
    };
    // Let activation-time deliveries drain so the burst is measured from quiet.
    const before = await waitQuiet();
    const added = 6;
    for (let i = 0; i < added; i++) {
      const dir = `${fixture.dir}-wt-${i}`;
      extraWorktrees.push(dir);
      git(fixture.dir, "worktree", "add", "-q", "-b", `burst/${i}`, dir);
      writeFileSync(path.join(dir, `burst-${i}.txt`), `burst ${i}\n`);
    }
    await expect
      .poll(
        async () => {
          const now = await counts();
          return (
            now.rawLast === before.rawLast + added &&
            now.coalescedLast === before.coalescedLast + added
          );
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    // Trailing coalesced callbacks fire by their window's deadline; wait for quiet.
    const last = await waitQuiet();
    const raw = last.raw - before.raw;
    const coalesced = last.coalesced - before.coalesced;
    test.info().annotations.push({
      type: "worktree-callbacks",
      description: `raw=${raw} coalesced=${coalesced}`,
    });
    // Both saw the whole burst (the lists above), raw one callback per event.
    // Coalesced must be materially fewer; observed locally at raw=20 coalesced=4,
    // so the 2x margin is not a timing knife-edge.
    expect(raw).toBeGreaterThanOrEqual(added);
    expect(coalesced).toBeGreaterThanOrEqual(1);
    expect(coalesced * 2).toBeLessThanOrEqual(raw);
  });

  test("host.fs.readFiles reads a batch in request order with per-entry errors", async () => {
    const at = (rel: string) => path.join(fixture.dir, rel);
    const entries = (await invoke("readFiles", [
      at("alpha.txt"),
      at("missing.txt"),
      at("bravo.txt"),
      at("folder"),
    ])) as Array<{ path: string; ok: boolean; content?: string; error?: { code: string } }>;
    expect(entries.map((e) => e.ok)).toEqual([true, false, true, false]);
    expect(entries[0].content).toBe("ALPHA\n");
    expect(entries[2].content).toBe("BRAVO\n");
    expect(entries[1].error?.code).toBe("NOT_FOUND");
    expect(entries[3].error?.code).toBe("NOT_A_FILE");
  });

  test("per-plugin perf snapshot records activation, invokes, pushes and the view load", async () => {
    // Its own traffic, so this test does not depend on the others having run.
    expect(await invokeError("slow")).toMatch(/^PLUGIN_INVOKE_TIMEOUT:/);
    expect(await invokeError("bigResult", 17 * MiB)).toMatch(/^PLUGIN_PAYLOAD_TOO_LARGE:/);
    expect(
      await invoke("push", { channel: "big", payload: "p".repeat(MiB + 1024), panelId: null })
    ).toMatchObject({ ok: false });
    expect(await invoke("burst", 10)).toBe(10);
    await expect
      .poll(
        async () => {
          const s = await snapshot();
          return (
            !!s &&
            s.viewLoads.length > 0 &&
            s.invokes.timeouts >= 1 &&
            s.invokes.oversized >= 1 &&
            s.pushes.messages >= 10 &&
            s.pushes.oversized >= 1
          );
        },
        { timeout: 20_000, message: "perf snapshot never caught up" }
      )
      .toBe(true);
    const s = (await snapshot())!;
    expect(s.isolation).toBe("worker");
    expect(s.activation).not.toBeNull();
    expect(s.activation!.count).toBeGreaterThanOrEqual(1);
    expect(s.activation!.lastMs).toBeGreaterThan(0);
    expect(s.invokes.count).toBeGreaterThanOrEqual(4);
    expect(s.invokes.errors).toBeGreaterThanOrEqual(2);
    const load = s.viewLoads.find((l) => l.kindId === kindId);
    expect(load, `no view load for ${kindId}`).toBeDefined();
    expect(load!.firstPaintMs).toBeGreaterThan(0);
  });
});
