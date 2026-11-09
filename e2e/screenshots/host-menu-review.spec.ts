/**
 * Host menu visual-review harness.
 *
 * Boots a fixture project, feeds the host list through its real seam (the
 * `remote-hosts:list` handler and the `remote-hosts:event` broadcast), then
 * writes PNGs of the host chip's menu across a spread of link states: hosts
 * that are up, hosts never connected this session, a laptop that went to
 * sleep, a host whose Daintree isn't listening, one ssh refuses, and one on
 * another build.
 *
 * Opt-in only — skips itself unless DAINTREE_SHOT_HOST_MENU is set.
 *
 *   DAINTREE_SHOT_HOST_MENU=1 npx playwright test --project=screenshots host-menu-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HOST_MENU  required — any truthy value
 *   DAINTREE_SHOT_THEMES     comma-separated theme ids for the sweep (default below)
 *   DAINTREE_SHOT_ONLY       comma-separated step filter
 *   DAINTREE_SHOT_DIR        output directory (absolute)
 *
 * Output: artifacts/host-menu-shots/<NN-slug>.png (gitignored), or DAINTREE_SHOT_DIR.
 */

import { test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM } from "../helpers/timeouts";
import type { HostConnectionState, HostListEntry } from "../../shared/types/remoteHosts";

const ENABLED = Boolean(process.env.DAINTREE_SHOT_HOST_MENU);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard,bondi,namib,redwoods")
  .split(",")
  .filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "host-menu-shots");

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const MIN = 60_000;
const HANDSHAKE = {
  version: "0.42.0",
  commit: "39278ebe61",
  protocolVersion: 7,
  platform: "darwin" as const,
  arch: "arm64" as const,
};

function host(
  id: string,
  name: string,
  connection: HostConnectionState,
  over: { platform?: "darwin" | "linux"; lastSeenAt?: number | null } = {}
): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      connection: { kind: "ssh", target: id },
      platform: over.platform ?? "darwin",
      arch: "arm64",
      lastHandshake: HANDSHAKE,
      lastSeenAt: over.lastSeenAt ?? Date.now() - 2 * 60 * MIN,
      addedAt: Date.now() - 30 * 24 * 60 * MIN,
      notificationsEnabled: true,
      assistantControlEnabled: true,
    },
    connection,
    summary: null,
  };
}

const connected: HostConnectionState = { status: "connected", rttMs: 18, handshake: HANDSHAKE };
const disconnected: HostConnectionState = { status: "disconnected" };
const asleep = (minutesAgo: number): HostConnectionState => ({
  status: "unreachable",
  lastSeenAt: Date.now() - minutesAgo * MIN,
  detail: "ssh: connect to host greg-mbp port 22: Operation timed out",
});

/** The reported case: a laptop gone to sleep among four studio Macs. */
function reportedHosts(): HostListEntry[] {
  return [
    host("greg-mbp", "Greg’s MacBook Pro", asleep(14)),
    host("studio-01", "studio-01", disconnected),
    host("studio-02", "studio-02", connected),
    host("studio-03", "studio-03", disconnected),
    host("studio-04", "studio-04", disconnected),
  ];
}

/** Every link state the menu draws, two of them asleep, one with a long name. */
function mixedHosts(): HostListEntry[] {
  return [
    host("greg-mbp", "Greg’s MacBook Pro", asleep(14)),
    host("build-east", "build-east-01.corp.example.internal", asleep(3 * 24 * 60), {
      platform: "linux",
    }),
    host("studio-01", "studio-01", disconnected),
    host("studio-02", "studio-02", connected),
    host("studio-03", "studio-03", {
      status: "unreachable",
      lastSeenAt: Date.now() - 40 * MIN,
      detail: null,
      hostModeOff: true,
    }),
    host("studio-04", "studio-04", {
      status: "unreachable",
      lastSeenAt: Date.now() - 5 * MIN,
      detail: "Permission denied (publickey)",
      stoppedRetrying: true,
    }),
    host(
      "gpu-box",
      "gpu-box",
      {
        status: "version-mismatch",
        mismatch: { kind: "protocol", local: 7, remote: 6 },
        remote: { ...HANDSHAKE, version: "0.39.2", protocolVersion: 6, platform: "linux" },
      },
      { platform: "linux" }
    ),
  ];
}

/** Nothing but this machine can be reached; one link is up but silent. */
function allAsleepHosts(): HostListEntry[] {
  return [
    host("greg-mbp", "Greg’s MacBook Pro", asleep(14)),
    host("studio-01", "studio-01", asleep(65)),
    host("studio-02", "studio-02", asleep(26 * 60)),
    host("studio-05", "studio-05", { ...connected, quietSince: Date.now() - 2 * MIN }),
  ];
}

async function stubHostList(app: ElectronApplication, hosts: HostListEntry[]): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, hosts) => {
      ipcMain.removeHandler("remote-hosts:list");
      ipcMain.handle("remote-hosts:list", async () => hosts);
    },
    hosts as unknown as Record<string, unknown>[]
  );
}

/** Push a list change to every view, the way the client broadcasts one. */
async function broadcastHosts(app: ElectronApplication, hosts: HostListEntry[]): Promise<void> {
  await app.evaluate(
    ({ webContents }, hosts) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send("remote-hosts:event", { type: "hosts-changed", hosts });
      }
    },
    hosts as unknown as Record<string, unknown>[]
  );
}

async function settle(page: Page, ms = 600): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

function menu(page: Page): Locator {
  return page.locator('[role="menu"]').first();
}

/** The menu with the chip above it, so the pointer and its anchor read together. */
async function snapMenu(page: Page, slug: string): Promise<void> {
  await settle(page);
  const chip = await page.locator(SEL.remoteHosts.hostChip).boundingBox();
  const box = await menu(page).boundingBox();
  if (!chip || !box) throw new Error(`${slug}: menu or chip not on screen`);
  const pad = 16;
  const x = Math.max(0, Math.min(chip.x, box.x) - pad);
  const y = Math.max(0, chip.y - pad);
  const right = Math.max(chip.x + chip.width, box.x + box.width) + pad;
  const bottom = box.y + box.height + pad;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x, y, width: right - x, height: bottom - y },
  });
}

/** The menu and whichever submenu is open beside it. */
async function snapWithSubmenu(page: Page, slug: string): Promise<void> {
  await settle(page);
  const boxes = await page.locator('[role="menu"]').evaluateAll((menus) =>
    menus.map((m) => {
      const r = m.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    })
  );
  if (boxes.length < 2) throw new Error(`${slug}: submenu did not open`);
  const pad = 16;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.max(...boxes.map((b) => b.right)) + pad;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + pad;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x, y, width: right - x, height: bottom - y },
  });
}

async function openMenu(page: Page): Promise<void> {
  const chip = page.locator(SEL.remoteHosts.hostChip);
  await chip.waitFor({ state: "visible", timeout: T_MEDIUM });
  await chip.click();
  await menu(page).waitFor({ state: "visible", timeout: T_MEDIUM });
  // The pointer would otherwise rest on whichever row the menu opened under.
  await page.mouse.move(2, 400);
  await settle(page, 500);
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await settle(page, 400);
}

/** Show `hosts`, and wait until the menu's rows say so. */
async function showHosts(
  app: ElectronApplication,
  page: Page,
  hosts: HostListEntry[]
): Promise<void> {
  await stubHostList(app, hosts);
  await broadcastHosts(app, hosts);
  await settle(page, 800);
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    stepFailures.push(`${name}: ${String(error).slice(0, 300)}`);
    console.warn(`[host-menu-shots] step "${name}" failed:`, String(error).slice(0, 300));
  }
}

test("host menu review — reachable and unreachable hosts", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HOST_MENU is required for the host menu capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_HOST_MENU to run the host menu capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo({ name: "host-menu-shots" });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-hostmenushot-"));
  const expected: string[] = [];
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 960 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await stubHostList(ctx.app, reportedHosts());
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Daintree");
    const app = ctx.app;
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await showHosts(app, page, reportedHosts());

    await step("reported", async () => {
      expected.push("01-reported");
      await openMenu(page);
      await snapMenu(page, "01-reported");
      await closeMenu(page);
    });

    await step("hover-asleep", async () => {
      expected.push("02-hover-asleep");
      await openMenu(page);
      await page.locator(SEL.remoteHosts.hostMenuRow("greg-mbp")).hover();
      await settle(page, 1500);
      await snapMenu(page, "02-hover-asleep");
      await closeMenu(page);
    });

    await step("new-window-submenu", async () => {
      expected.push("03-new-window-submenu");
      await openMenu(page);
      await page.getByRole("menuitem", { name: "Open in new window" }).hover();
      await page.locator("[data-new-window-host-id]").first().waitFor({ timeout: T_MEDIUM });
      await snapWithSubmenu(page, "03-new-window-submenu");
      await closeMenu(page);
    });

    await step("mixed", async () => {
      expected.push("04-mixed");
      await showHosts(app, page, mixedHosts());
      await openMenu(page);
      await snapMenu(page, "04-mixed");
      await closeMenu(page);
    });

    await step("mixed-continue-submenu", async () => {
      expected.push("05-mixed-continue-submenu");
      await openMenu(page);
      await page.getByRole("menuitem", { name: /Continue this branch on/ }).hover();
      await page.locator("[data-continue-host-id]").first().waitFor({ timeout: T_MEDIUM });
      await snapWithSubmenu(page, "05-mixed-continue-submenu");
      await closeMenu(page);
    });

    // Links change while the menu is open: the laptop wakes and studio-01 drops.
    // Rows keep their sections and change their words in place.
    // Links change while the menu is open: the laptop wakes and studio-01 drops.
    // Rows keep their sections, change their words in place, and the focused
    // row keeps focus through the change in either direction.
    await step("changed-while-open", async () => {
      expected.push("07-changed-while-open");
      await showHosts(app, page, reportedHosts());
      await openMenu(page);
      const changed = reportedHosts().map((entry) =>
        entry.descriptor.id === "greg-mbp"
          ? { ...entry, connection: connected }
          : entry.descriptor.id === "studio-01"
            ? { ...entry, connection: asleep(1) }
            : entry
      );
      const focusedHost = () =>
        page.evaluate(() => document.activeElement?.getAttribute("data-host-id") ?? null);
      await page.locator(SEL.remoteHosts.hostMenuRow("greg-mbp")).focus();
      await broadcastHosts(app, changed);
      await settle(page, 800);
      const afterWake = await focusedHost();
      if (afterWake !== "greg-mbp") throw new Error(`focus left the woken row (${afterWake})`);
      await snapMenu(page, "07-changed-while-open");
      await page.locator(SEL.remoteHosts.hostMenuRow("studio-01")).focus();
      await broadcastHosts(app, reportedHosts());
      await settle(page, 800);
      const afterRecover = await focusedHost();
      if (afterRecover !== "studio-01") throw new Error(`focus left the recovered row (${afterRecover})`);
      await closeMenu(page);
    });

    await step("all-asleep", async () => {
      expected.push("06-all-asleep");
      await showHosts(app, page, allAsleepHosts());
      await openMenu(page);
      await snapMenu(page, "06-all-asleep");
      await closeMenu(page);
    });

    await step("themes", async () => {
      await showHosts(app, page, reportedHosts());
      for (const themeId of THEMES) {
        expected.push(`10-theme-${themeId}`);
        await setAppTheme(page, themeId);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await settle(page, 800);
        await openMenu(page);
        await snapMenu(page, `10-theme-${themeId}`);
        await closeMenu(page);
      }
    });
  } finally {
    if (ctx) await closeApp(ctx.app);
    repo.cleanup();
  }

  const written = new Set(readdirSync(OUTPUT_DIR).map((file) => file.replace(/\.png$/, "")));
  const missing = expected.filter((slug) => !written.has(slug));
  if (missing.length > 0) stepFailures.push(`missing captures: ${missing.join(", ")}`);
  if (stepFailures.length > 0) {
    throw new Error(
      `[host-menu-shots] ${stepFailures.length} problem(s):\n${stepFailures.join("\n")}`
    );
  }
});
