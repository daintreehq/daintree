/**
 * Remote window visual-review harness: does a window working on another
 * machine read as one at a glance, without reading as something gone wrong?
 *
 * Drives `toolbar-preview.html` with `?host=`, which mounts the real `Toolbar`
 * as a window bound to that host over SSH (the real host chip, the real window
 * chrome) beside a local window with hosts added, so the two can be compared.
 * macOS only: a Windows build never opens a window on a host.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_REMOTE_WINDOW=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots remote-window-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_REMOTE_WINDOW  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES         theme sweep (default: every built-in theme)
 *   DAINTREE_SHOT_ONLY           capture only the shots whose file name contains this
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_REMOTE_WINDOW;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ??
  "daintree,arashiyama,bondi,fiordland,galapagos,highlands,movile,namib,redwoods,table-mountain,atacama,bali,hokkaido,serengeti,svalbard"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = process.env.DAINTREE_SHOT_ONLY ?? "";

test.use({ deviceScaleFactor: 2 });

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';
const WINDOW_HEIGHT = 200;

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

interface Shot {
  file: string;
  theme?: string;
  host?: string;
  link?: string;
  /** The link's round trip in ms. */
  rtt?: number;
  width?: number;
  /** Open the host chip's menu before the capture. */
  menu?: boolean;
  /** Mount the real worktree sidebar and take a taller frame. */
  sidebar?: boolean;
  /** Hover the sidebar header, so its action cluster shows beside the title. */
  hoverHeader?: boolean;
  /** Give the chip keyboard focus before the capture. */
  focus?: boolean;
  /** Emulate an accessibility mode for the capture. */
  media?: "forced-colors" | "contrast-more";
}

let server: PreviewServer | undefined;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function capture(page: Page, shot: Shot): Promise<string> {
  const { theme = "daintree", link = "connected", width = 1440 } = shot;
  const height = shot.menu || shot.sidebar ? 520 : WINDOW_HEIGHT;
  await page.setViewportSize({ width, height });
  const query = new URLSearchParams({ theme, fixture: "owner", platform: "mac", link });
  if (shot.rtt !== undefined) query.set("rtt", String(shot.rtt));
  if (shot.sidebar) query.set("sidebar", "1");
  if (shot.host) query.set("host", shot.host);
  else query.set("hosts", "1");
  const url = `${server!.baseURL}/toolbar-preview.html?${query.toString()}`;
  await page.emulateMedia({
    forcedColors: shot.media === "forced-colors" ? "active" : "none",
    contrast: shot.media === "contrast-more" ? "more" : "no-preference",
  });
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page
    .locator(STRIP)
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch((e: unknown) => {
      throw new Error(`toolbar never mounted (${url}): ${String(e)}\n${consoleErrors.join("\n")}`);
    });
  await page.evaluate(() => document.fonts.ready);

  // The chip is what says where the window is; a capture without it, or with
  // the wrong location on it, is a picture of the wrong state.
  const chip = page.getByTestId("host-chip");
  await expect(chip, `${shot.file}: host chip`).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveAttribute("data-host-location", shot.host ? "remote" : "local");
  if (shot.host) await expect(chip).toContainText(shot.host.slice(-8));

  if (shot.sidebar) {
    await expect(page.getByRole("heading", { name: "Worktrees" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("sidebar-remote-host")).toHaveCount(shot.host ? 1 : 0);
    // The tag is hidden from assistive tech; the heading carries the host instead.
    await expect(page.getByRole("heading", { level: 2, name: /^Worktrees/ })).toHaveAccessibleName(
      shot.host ? `Worktrees, on host ${shot.host}` : "Worktrees"
    );
    if (shot.hoverHeader) {
      await page.getByRole("heading", { name: "Worktrees" }).hover();
      await expect(page.getByRole("button", { name: "Open worktrees overview" })).toBeVisible();
    }
  }

  // The chip's state and the menu's row for this host come from one fixture; a
  // capture where they disagree is a picture of a state that cannot happen.
  const linkTrouble = shot.host !== undefined && (link === "quiet" || link === "unreachable");
  await expect(chip.locator("[data-link-trouble]")).toHaveCount(linkTrouble ? 1 : 0);
  // The round trip shows only while the link is healthy; a state word replaces it.
  const latencyShown = shot.host !== undefined && link === "connected";
  await expect(chip.locator("[data-host-latency]")).toHaveCount(latencyShown ? 1 : 0);
  if (shot.focus) {
    await chip.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions));
    await expect(chip).toBeFocused();
  }
  if (shot.menu) {
    await chip.click();
    const menu = page.locator('[role="menu"]').first();
    await expect(menu).toBeVisible();
    if (shot.host && link === "connected") {
      await expect(menu.locator(`[data-host-id="${shot.host}"]`)).not.toContainText(
        "Not connected"
      );
    }
  }
  await settle(page);

  const out = path.join(OUT_DIR, shot.file);
  await page.screenshot({ path: out });
  if (!existsSync(out)) throw new Error(`${shot.file}: screenshot did not land`);
  return shot.file;
}

test.describe("remote window review", () => {
  test("captures", async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_REMOTE_WINDOW is required for the remote window capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_REMOTE_WINDOW to run the remote window capture");
    test.setTimeout(900_000);
    await stubViteHmrClient(page);
    page.on("pageerror", (e) => consoleErrors.push(e.stack ?? String(e)));

    const shots: Shot[] = [];
    for (const theme of THEMES) {
      shots.push({ file: `local-${theme}.png`, theme });
      shots.push({ file: `remote-${theme}.png`, theme, host: "studio-01" });
      shots.push({ file: `remote-sidebar-${theme}.png`, theme, host: "studio-01", sidebar: true });
    }
    shots.push(
      { file: "remote-second-host-daintree.png", host: "build-east-02" },
      { file: "remote-connecting-daintree.png", host: "studio-01", link: "connecting" },
      { file: "remote-slow-daintree.png", host: "studio-01", rtt: 180 },
      { file: "remote-unreachable-daintree.png", host: "studio-01", link: "unreachable" },
      { file: "remote-quiet-bondi.png", theme: "bondi", host: "studio-01", link: "quiet" },
      { file: "remote-focus-bondi.png", theme: "bondi", host: "studio-01", focus: true },
      { file: "remote-focus-daintree.png", host: "studio-01", focus: true },
      { file: "remote-quiet-daintree.png", host: "studio-01", link: "quiet" },
      { file: "remote-disconnected-daintree.png", host: "studio-01", link: "disconnected" },
      {
        file: "remote-long-name-daintree.png",
        host: "gregs-ubuntu-workstation-build-east-01",
      },
      { file: "remote-narrow-daintree.png", host: "studio-01", width: 980 },
      { file: "remote-menu-daintree.png", host: "studio-01", menu: true },
      {
        file: "remote-long-name-quiet-narrow-daintree.png",
        host: "gregs-ubuntu-workstation-build-east-01",
        link: "quiet",
        width: 980,
      },
      {
        file: "remote-fqdn-daintree.png",
        host: "gregs-ubuntu-workstation-build-east-02.corp.example.com",
        width: 1100,
      },
      {
        file: "remote-sidebar-hover-daintree.png",
        host: "studio-01",
        sidebar: true,
        hoverHeader: true,
      },
      {
        file: "remote-sidebar-long-name-daintree.png",
        host: "gregs-ubuntu-workstation-build-east-01",
        sidebar: true,
      },
      {
        file: "remote-sidebar-contrast-more-daintree.png",
        host: "studio-01",
        sidebar: true,
        media: "contrast-more",
      },
      {
        file: "remote-sidebar-contrast-more-svalbard.png",
        theme: "svalbard",
        host: "studio-01",
        sidebar: true,
        media: "contrast-more",
      },
      {
        file: "remote-sidebar-forced-colors-daintree.png",
        host: "studio-01",
        sidebar: true,
        media: "forced-colors",
      },
      { file: "local-sidebar-daintree.png", sidebar: true },
      {
        file: "remote-sidebar-fqdn-daintree.png",
        host: "gregs-ubuntu-workstation-build-east-02.corp.example.com",
        sidebar: true,
      },
      { file: "remote-forced-colors-daintree.png", host: "studio-01", media: "forced-colors" },
      { file: "remote-contrast-more-daintree.png", host: "studio-01", media: "contrast-more" },
      {
        file: "remote-contrast-more-svalbard.png",
        theme: "svalbard",
        host: "studio-01",
        media: "contrast-more",
      }
    );

    const written: string[] = [];
    for (const shot of shots.filter((s) => s.file.includes(ONLY)))
      written.push(await capture(page, shot));

    const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    expect(onDisk.sort()).toEqual(written.sort());
    console.log(`[remote-window-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
  });
});
