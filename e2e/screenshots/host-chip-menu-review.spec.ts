/**
 * Host chip menu visual-review harness: the "Working on" menu that hangs off
 * the toolbar's host chip, with four Mac hosts beside this machine.
 *
 * Drives `toolbar-preview.html` with `?fleet=`, which mounts the real `Toolbar`
 * and the real `HostChip` against a seeded host list: `macs` (every other host
 * disconnected) or `mixed` (one of each link state, a refused build among them).
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_HOST_MENU=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots host-chip-menu-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HOST_MENU  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES     theme sweep (default: a dark, a light and a high-key theme)
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

const ENABLED = !!process.env.DAINTREE_SHOT_HOST_MENU;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "bondi,svalbard,namib,highlands")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';

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
  /** The window's host; omitted for a local window. */
  host?: string;
  fleet: "macs" | "mixed" | "long";
  link?: string;
  /** Open this submenu by its trigger text. */
  submenu?: string;
  /** Move keyboard focus to this row after opening, so it shows its keyboard highlight. */
  focusRow?: string;
  media?: "forced-colors";
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
  const { theme = "daintree", link = "connected" } = shot;
  await page.setViewportSize({ width: 1280, height: 520 });
  const query = new URLSearchParams({
    theme,
    fixture: "owner",
    platform: "mac",
    link,
    rtt: "2",
    fleet: shot.fleet,
  });
  if (shot.host) query.set("host", shot.host);
  else query.set("hosts", "1");
  const url = `${server!.baseURL}/toolbar-preview.html?${query.toString()}`;
  await page.emulateMedia({ forcedColors: shot.media === "forced-colors" ? "active" : "none" });
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page
    .locator(STRIP)
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch((e: unknown) => {
      throw new Error(`toolbar never mounted (${url}): ${String(e)}\n${consoleErrors.join("\n")}`);
    });
  await page.evaluate(() => document.fonts.ready);

  const chip = page.getByTestId("host-chip");
  await expect(chip, `${shot.file}: host chip`).toBeVisible({ timeout: 15_000 });
  await expect(chip).toHaveAttribute("data-host-location", shot.host ? "remote" : "local");
  const menu = page.locator('[role="menu"]').first();
  // Radix loads lazily; under load the first click can land before it owns the
  // trigger. Click again until the menu is there rather than failing the sweep.
  await expect(async () => {
    if (!(await menu.isVisible())) await chip.click();
    await expect(menu).toBeVisible({ timeout: 2_000 });
  }, `${shot.file}: menu`).toPass({ timeout: 20_000 });
  // Five machines: this one and the four studios. Fewer is the wrong fixture.
  await expect(menu.locator("[data-host-id]")).toHaveCount(5, { timeout: 10_000 });
  if (shot.host) {
    await expect(menu.locator(`[data-host-id="${shot.host}"]`)).toHaveAttribute(
      "aria-current",
      "true"
    );
  }
  if (shot.fleet === "mixed") {
    await expect(menu.locator("[data-update-host-id]")).toHaveCount(1);
  }
  if (shot.focusRow) {
    const row = menu.getByRole("menuitem", { name: shot.focusRow });
    await row.focus();
    await expect(row, `${shot.file}: focused row`).toBeFocused();
    await expect(row).toHaveAttribute("data-highlighted", "");
  }
  if (shot.submenu) {
    const trigger = menu.getByRole("menuitem", { name: shot.submenu });
    await trigger.hover();
    await expect(page.locator('[role="menu"]')).toHaveCount(2, { timeout: 5_000 });
  }
  await settle(page);

  const out = path.join(OUT_DIR, shot.file);
  await page.screenshot({ path: out, clip: { x: 300, y: 0, width: 960, height: 520 } });
  if (!existsSync(out)) throw new Error(`${shot.file}: screenshot did not land`);
  return shot.file;
}

test.describe("host chip menu review", () => {
  test("captures", async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_HOST_MENU is required for the host menu capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_HOST_MENU to run the host menu capture");
    test.setTimeout(600_000);
    await stubViteHmrClient(page);
    page.on("pageerror", (e) => consoleErrors.push(e.stack ?? String(e)));

    const shots: Shot[] = [
      { file: "remote-macs-daintree.png", host: "studio-02", fleet: "macs" },
      { file: "remote-mixed-daintree.png", host: "studio-02", fleet: "mixed" },
      { file: "local-macs-daintree.png", fleet: "macs" },
      {
        file: "remote-submenu-daintree.png",
        host: "studio-02",
        fleet: "macs",
        submenu: "Open in new window",
      },
      {
        file: "remote-keyboard-daintree.png",
        host: "studio-02",
        fleet: "macs",
        focusRow: "Manage hosts…",
      },
      {
        file: "remote-long-names-submenu-daintree.png",
        host: "gregs-mac-studio-build-east-02",
        fleet: "long",
        submenu: "Continue this branch on…",
      },
      {
        file: "remote-forced-colors-daintree.png",
        host: "studio-02",
        fleet: "mixed",
        media: "forced-colors",
      },
    ];
    for (const theme of THEMES) {
      shots.push({ file: `theme-${theme}.png`, theme, host: "studio-02", fleet: "mixed" });
    }

    const written: string[] = [];
    for (const shot of shots) written.push(await capture(page, shot));

    const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    expect(onDisk.sort()).toEqual(written.sort());
    console.log(`[host-chip-menu-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
  });
});
