import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getTerminalBufferLength,
  getTerminalText,
  runTerminalCommand,
  waitForTerminalPty,
  waitForTerminalText,
} from "../../helpers/terminal";
import {
  expectToolbarButtonReachable,
  getFirstGridPanel,
  getGridPanelCount,
  openTerminal,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import {
  diffProcessSnapshots,
  getProcessInfo,
  getPtyPid,
  getTerminalStats,
  isPidAlive,
  measureMainMemory,
  measureRendererMemory,
  snapshotProcesses,
  startFrameProbe,
  stopFrameProbe,
  verifyProcessIdentity,
  type ProcessIdentity,
} from "../../helpers/stress";
import { dismissBlockingPalette } from "../../helpers/overlays";

// PTY bytes flow pty-host -> renderer over a MessagePort and never touch the
// main process, so a leak shows up in the renderer or the pty-host; the main
// heap bound stays as a guard on the IPC and bookkeeping around them. Renderer
// and pty-host bounds were set from measured growth on macOS (see the
// annotations each test records) with generous headroom for CI VMs.
const FLOOD_LIMITS = { mainMb: 50, rendererMb: 20, ptyHostMb: 96 };
const CYCLE_LIMITS = { mainMb: 50, rendererMb: 15, ptyHostMb: 24 };
const RAPID_LIMITS = { mainMb: 20, rendererMb: 15, ptyHostMb: 24 };
const RAPID_CYCLE_COUNT = 8;

// Closing a terminal normally trashes it; the PTY is only reaped when the
// trash entry expires. A short E2E TTL lets the reaping be observed directly,
// while leaving enough time to see a panel sitting in the trash first.
const TRASH_TTL_MS = 6_000;

const FIXTURE_NAME = "pty-stress";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

const MB = 1024 * 1024;

async function measureRendererHeapBytes(page: Page): Promise<number> {
  const mem = await measureRendererMemory(page, { forceGc: true });
  expect(mem, "performance.memory must be available in the renderer").not.toBeNull();
  return mem!.usedJSHeapSize;
}

/** Resident set of a process in KB, from procfs (Linux only). */
function readProcRssKb(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  if (!match) throw new Error(`no VmRSS for pid ${pid}`);
  return Number(match[1]);
}

/**
 * Resident set of every pty-host utility process, in bytes. The utility
 * process's `serviceName` fork option surfaces as the metric's `name`; the
 * metric's own `serviceName` is the mojo interface (node.mojom.NodeService).
 * Electron leaves `memory` out of the metrics on Linux, so there the RSS is
 * read from procfs by pid.
 */
async function measurePtyHostRssBytes(app: ElectronApplication): Promise<number> {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name ?? "",
      workingSetKb: (metric.memory as Electron.MemoryInfo | undefined)?.workingSetSize ?? null,
    }))
  );
  const hosts = metrics.filter(
    (metric) => metric.type === "Utility" && metric.name.startsWith("daintree-pty-host")
  );
  expect(
    hosts.length,
    `no daintree-pty-host utility process in app metrics: ${metrics.map((m) => m.name || m.type).join(", ")}`
  ).toBeGreaterThan(0);
  // workingSetSize and VmRSS are both reported in kilobytes.
  return (
    hosts.reduce((sum, host) => sum + (host.workingSetKb ?? readProcRssKb(host.pid)), 0) * 1024
  );
}

interface MemorySample {
  main: number;
  renderer: number;
  ptyHost: number;
}

async function sampleMemory(): Promise<MemorySample> {
  return {
    main: (await measureMainMemory(ctx.app, { forceGc: true })).heapUsed,
    renderer: await measureRendererHeapBytes(ctx.window),
    ptyHost: await measurePtyHostRssBytes(ctx.app),
  };
}

async function expectBoundedGrowth(
  label: string,
  before: MemorySample,
  limits: { mainMb: number; rendererMb: number; ptyHostMb: number }
): Promise<void> {
  const after = await sampleMemory();
  const growth = {
    main: (after.main - before.main) / MB,
    renderer: (after.renderer - before.renderer) / MB,
    ptyHost: (after.ptyHost - before.ptyHost) / MB,
  };
  test.info().annotations.push({
    type: "memory",
    description: `${label} main=${growth.main.toFixed(1)}MB renderer=${growth.renderer.toFixed(1)}MB ptyHost=${growth.ptyHost.toFixed(1)}MB`,
  });
  expect(growth.main, `${label}: main heap growth (MB)`).toBeLessThan(limits.mainMb);
  expect(growth.renderer, `${label}: renderer heap growth (MB)`).toBeLessThan(limits.rendererMb);
  expect(growth.ptyHost, `${label}: pty-host RSS growth (MB)`).toBeLessThan(limits.ptyHostMb);
}

/**
 * Run a command whose proof line is assembled at runtime by node, so the
 * shell's echo of the command itself can never satisfy the wait.
 */
async function runNodeAndWait(
  page: Page,
  panel: Locator,
  script: string,
  marker: string,
  timeout = T_LONG
): Promise<void> {
  await runTerminalCommand(page, panel, `node -e "${script}"`);
  await waitForTerminalText(panel, marker, timeout);
}

async function floodLines(page: Page, panel: Locator, lines: number): Promise<void> {
  const tag = Date.now();
  await runNodeAndWait(
    page,
    panel,
    `for(let i=0;i<${lines};i++) console.log('L'+i); console.log('FLOOD_'+'DONE_${tag}')`,
    `FLOOD_DONE_${tag}`,
    60_000
  );
}

async function expectInteractive(page: Page, panel: Locator, name: string): Promise<void> {
  await runNodeAndWait(page, panel, `console.log('${name}_'+'OK')`, `${name}_OK`);
}

async function openReadyTerminal(page: Page): Promise<Locator> {
  const countBefore = await getGridPanelCount(page);
  await openTerminal(page);
  await expect.poll(() => getGridPanelCount(page), { timeout: T_LONG }).toBe(countBefore + 1);
  const panel = page.locator(SEL.panel.gridPanel).last();
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await waitForTerminalPty(page, panel, T_LONG);
  // The prompt shows the cwd, so the fixture name means the shell is ready.
  await waitForTerminalText(panel, FIXTURE_NAME, T_LONG);
  return panel;
}

/** Alt+click on the close button force-closes (kills) instead of trashing. */
async function forceCloseFirstPanel(page: Page): Promise<void> {
  const countBefore = await getGridPanelCount(page);
  const panel = getFirstGridPanel(page);
  await dismissBlockingPalette(page);
  await panel
    .locator(SEL.panel.close)
    .first()
    .click({ modifiers: ["Alt"] });
  await expect.poll(() => getGridPanelCount(page), { timeout: T_MEDIUM }).toBe(countBefore - 1);
}

async function tryGetPtyPid(page: Page, panel: Locator): Promise<number> {
  return getPtyPid(page, panel).catch(() => 0);
}

async function expectPidGone(pid: number, baseline: ProcessIdentity | null): Promise<void> {
  // A dead pid may already be reused by an unrelated process; only the same
  // command started at the same instant counts as the original still running.
  await expect
    .poll(() => isPidAlive(pid) && (baseline === null || verifyProcessIdentity(pid, baseline)), {
      timeout: 30_000,
      intervals: [100, 250, 500],
    })
    .toBe(false);
}

/**
 * Open, use and force-close one terminal, then wait for its PTY to die, so
 * every memory baseline is taken from the same warm state rather than from
 * whatever an earlier test left behind.
 */
async function warmUp(page: Page): Promise<void> {
  const panel = await openReadyTerminal(page);
  const pid = await getPtyPid(page, panel);
  const identity = getProcessInfo(pid);
  await expectInteractive(page, panel, "WARM");
  await forceCloseFirstPanel(page);
  await expectPidGone(pid, identity);
}

test.describe("Core: PTY stress", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: FIXTURE_NAME });
    fixtureCleanup = cleanup;
    ctx = await launchApp({ env: { DAINTREE_E2E_TRASH_TTL_MS: String(TRASH_TTL_MS) } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "PTY Stress Test");
  });

  test.beforeEach(async () => {
    const { window } = ctx;
    const closed: Array<{ pid: number; identity: ProcessIdentity | null }> = [];
    while ((await getGridPanelCount(window)) > 0) {
      const pid = await tryGetPtyPid(window, getFirstGridPanel(window));
      if (pid > 0) closed.push({ pid, identity: getProcessInfo(pid) });
      await forceCloseFirstPanel(window);
    }
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
    for (const { pid, identity } of closed) await expectPidGone(pid, identity);
    // Anything still in the trash holds a live PTY until its TTL expires.
    await expect(window.locator(SEL.trash.container)).not.toBeVisible({
      timeout: TRASH_TTL_MS + T_LONG,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("50k-line flood stays memory-bounded, trims scrollback and stays interactive", async () => {
    test.setTimeout(T_LONG * 6);
    const { window } = ctx;
    await warmUp(window);
    const panel = await openReadyTerminal(window);
    const before = await sampleMemory();

    await floodLines(window, panel, 50_000);

    await test.step("main heap, renderer heap and pty-host RSS growth are bounded", async () => {
      await expectBoundedGrowth("flood", before, FLOOD_LIMITS);
    });

    await test.step("scrollback buffer is trimmed", async () => {
      const bufferLength = await getTerminalBufferLength(panel);
      expect(bufferLength).toBeGreaterThan(0);
      // 50,000 lines were written; only a small fraction should survive.
      expect(bufferLength).toBeLessThan(2000);
    });

    await test.step("terminal remains interactive", async () => {
      await expectInteractive(window, panel, "POST_FLOOD");
    });
  });

  test("2k-line flood keeps frames flowing and the closed PTY is reaped", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;
    await warmUp(window);
    const panel = await openReadyTerminal(window);

    const ptyPid = await getPtyPid(window, panel);
    expect(ptyPid).toBeGreaterThan(0);
    expect(isPidAlive(ptyPid)).toBe(true);

    // Baseline identity guards against pid reuse (Unix only).
    const baseline = getProcessInfo(ptyPid);
    if (process.platform !== "win32") {
      expect(baseline).not.toBeNull();
    }

    const procsBefore = snapshotProcesses((e) => e.ppid === ptyPid);
    const before = await sampleMemory();
    expect(before.main).toBeGreaterThan(0);
    expect(before.renderer).toBeGreaterThan(0);
    expect(before.ptyHost).toBeGreaterThan(0);

    await startFrameProbe(window);
    let frameResult;
    try {
      await floodLines(window, panel, 2000);
    } finally {
      frameResult = await stopFrameProbe(window);
    }
    expect(frameResult.sampleCount).toBeGreaterThan(0);
    // Catastrophic stall threshold — generous for CI VMs.
    expect(frameResult.maxGapMs).toBeLessThan(5000);

    await expectBoundedGrowth("smallFlood", before, FLOOD_LIMITS);

    const stats = await getTerminalStats(window);
    expect(stats.terminalCount).toBeGreaterThanOrEqual(1);
    expect(stats.withPty).toBeGreaterThanOrEqual(1);

    // The flood's `node -e` exits; no persistent children expected.
    const procsAfter = snapshotProcesses((e) => e.ppid === ptyPid);
    expect(diffProcessSnapshots(procsBefore, procsAfter).added.length).toBeLessThanOrEqual(1);

    await test.step("closing the panel trashes it and trash expiry kills the PTY", async () => {
      await dismissBlockingPalette(window);
      await panel.locator(SEL.panel.close).first().click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
      await expectPidGone(ptyPid, baseline);
    });
  });

  test("memory stays stable across terminal open/close cycles", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;
    await warmUp(window);
    const before = await sampleMemory();
    const pids: Array<{ pid: number; baseline: ProcessIdentity | null }> = [];

    for (let i = 0; i < 3; i++) {
      const panel = await openReadyTerminal(window);
      const pid = await getPtyPid(window, panel);
      pids.push({ pid, baseline: getProcessInfo(pid) });
      await dismissBlockingPalette(window);
      await panel.locator(SEL.panel.close).first().click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
    }

    // Measure only once the trashed PTYs are actually gone.
    for (const { pid, baseline } of pids) await expectPidGone(pid, baseline);

    await expectBoundedGrowth("cycles", before, CYCLE_LIMITS);
  });

  test("rapid Alt-close create/destroy cycles reap every PTY and leave a working terminal", async () => {
    test.setTimeout(300_000);
    const { window } = ctx;
    const trackedPids: number[] = [];

    await warmUp(window);
    const before = await sampleMemory();

    try {
      await test.step("run rapid create/destroy cycles", async () => {
        // No pacing: the spawn limiter queues past its burst instead of rejecting.
        for (let i = 0; i < RAPID_CYCLE_COUNT; i++) {
          const countBefore = await getGridPanelCount(window);
          await openTerminal(window);
          await expect
            .poll(() => getGridPanelCount(window), { timeout: T_LONG })
            .toBe(countBefore + 1);
          const panel = getFirstGridPanel(window);
          await expect(panel).toBeVisible({ timeout: T_MEDIUM });
          await expect
            .poll(() => getPtyPid(window, panel).catch(() => 0), {
              timeout: T_LONG,
              intervals: [100, 250, 500],
            })
            .toBeGreaterThan(0);
          trackedPids.push(await getPtyPid(window, panel));
          await forceCloseFirstPanel(window);
        }
      });

      await test.step("verify no leaked PIDs", async () => {
        expect(trackedPids).toHaveLength(RAPID_CYCLE_COUNT);
        if (process.platform === "win32") return;
        await expect
          .poll(() => trackedPids.filter((pid) => isPidAlive(pid)), {
            timeout: 10_000,
            intervals: [200, 500, 1000],
          })
          .toEqual([]);
      });

      await test.step("verify main, renderer and pty-host memory growth is bounded", async () => {
        await expectBoundedGrowth("rapid", before, RAPID_LIMITS);
      });

      await test.step("post-stress: new terminal is functional", async () => {
        const panel = await openReadyTerminal(window);
        const ptyPid = await getPtyPid(window, panel);
        trackedPids.push(ptyPid);
        expect(ptyPid).toBeGreaterThan(0);
        await expectInteractive(window, panel, "RAPID_STRESS");
        await forceCloseFirstPanel(window);
      });
    } finally {
      if (process.platform !== "win32") {
        for (const pid of trackedPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already dead
          }
        }
      }
    }
  });

  test("SIGKILL of a shell mid-output trashes the exited panel and the app stays usable", async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Unix-only: kills the PTY shell with SIGKILL",
    });
    test.skip(process.platform === "win32", "Unix-only: kills the PTY shell with SIGKILL");
    test.setTimeout(120_000);
    const { window } = ctx;

    const floodPanel = await openReadyTerminal(window);
    const floodPanelId = await floodPanel.getAttribute("data-panel-id");
    expect(floodPanelId).toBeTruthy();

    // The shell echoes the command before expanding $$, so wait for the digits,
    // not just the prefix.
    await runTerminalCommand(window, floodPanel, "echo DAINTREE_PID_$$");
    let shellPid = 0;
    await expect
      .poll(
        async () => {
          const m = (await getTerminalText(floodPanel)).match(/DAINTREE_PID_(\d+)/);
          if (m) shellPid = Number(m[1]);
          return shellPid;
        },
        { timeout: T_LONG, intervals: [250] }
      )
      .toBeGreaterThan(0);
    expect(shellPid).toBe(await getPtyPid(window, floodPanel));

    await runTerminalCommand(
      window,
      floodPanel,
      "while true; do echo FLOOD_LINE_$(date +%s); sleep 0.05; done"
    );
    // The echoed command reads `FLOOD_LINE_$(date`, so only digits prove the
    // loop is running.
    await expect
      .poll(async () => /FLOOD_LINE_\d{9,}/.test(await getTerminalText(floodPanel)), {
        timeout: T_LONG,
        intervals: [250],
      })
      .toBe(true);

    await ctx.app.evaluate((_, pid) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ESRCH — already dead
      }
    }, shellPid);

    await test.step("the signal death reads as exit code 0, so the plain terminal is auto-trashed", async () => {
      // node-pty reports a signal death with exitCode 0 (TerminalExitHandler
      // normalises `exitCode ?? 0`), and a plain terminal that exits 0 is
      // trashed rather than preserved with an exit banner.
      await waitForProcessExit(shellPid, T_LONG);
      // A preserved panel would stay in the grid with its exit banner; a
      // deleted one would never reach the trash. Only a trashed panel leaves
      // the grid and shows up as a trash row (the TTL outlasts this check).
      const trashPill = window.locator(SEL.trash.container);
      await expect(trashPill).toHaveAttribute("aria-label", /^Trash: 1 terminal/, {
        timeout: T_LONG,
      });
      await trashPill.click();
      const popover = window.getByRole("dialog", { name: "Recently closed terminals" });
      await expect(popover.locator(`[data-trash-row][data-row-id="${floodPanelId}"]`)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.keyboard.press("Escape");
      await expect(popover).not.toBeVisible({ timeout: T_MEDIUM });
      expect(await getGridPanelCount(window)).toBe(0);
    });

    await test.step("the toolbar is still interactive", async () => {
      await expectToolbarButtonReachable(window, SEL.toolbar.toggleSidebar, T_MEDIUM);
      await expectToolbarButtonReachable(window, SEL.toolbar.openSettings, T_MEDIUM);
    });

    await test.step("a new terminal works after the crash", async () => {
      const newPanel = await openReadyTerminal(window);
      await expectInteractive(window, newPanel, "POST_CRASH");
    });
  });
});
