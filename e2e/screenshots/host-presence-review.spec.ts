/**
 * Host presence visual-review harness: who is using a project from where.
 *
 * Drives the host presence preview entry (`host-presence-preview.html`) — the
 * real in-use pill, control banner and pane read-only strip against seeded
 * host-mode status and drive lease, on the host's own screen and on a client.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PRESENCE=1 npx playwright test --project=screenshots host-presence-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PRESENCE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       output directory (default artifacts/host-presence-shots)
 *   DAINTREE_SHOT_THEMES    comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output: `<state>-<theme>.png` per state and theme, plus in the first theme the
 * in-use popover open and two narrow-window cases. Never writes a PNG it has not
 * verified, and counts the files itself rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_PRESENCE;
const DEFAULT_WIDTH = 1100;
const NARROW_WIDTH = 640;
const ATTACH_TIMEOUT_MS = 30_000;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "host-presence-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `PRESENCE_STATES`, with what each must render. */
const STATES = [
  { name: "host-connected", pill: true, banner: false, pane: false },
  { name: "host-other-project", pill: true, banner: false, pane: false },
  { name: "host-taken", pill: true, banner: true, pane: true },
  { name: "host-taken-two", pill: true, banner: true, pane: true },
  { name: "host-long-name", pill: true, banner: true, pane: true },
  { name: "host-control-confirmed", pill: true, banner: false, pane: true },
  { name: "client-other-client", pill: false, banner: true, pane: true },
  { name: "client-host-screen", pill: false, banner: true, pane: true },
] as const;

const NARROW_STATES = ["host-taken", "client-other-client", "host-long-name"] as const;

let server: ViteDevServer | undefined;
let baseURL = "";
const ENTRY = "/src/components/Hosts/__preview__/hostPresencePreview.tsx";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "warn" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
  await server.warmupRequest(ENTRY);
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold one page open until Vite's dependency optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${baseURL}/host-presence-preview.html?state=host-taken`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shells = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shells === 1) break;
  }
  await page.close();
}

async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out });
  return out;
}

/** A fresh page per capture; one renderer crash under load gets one retry. */
async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) continue;
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openState(
  page: Page,
  state: (typeof STATES)[number],
  theme: string,
  width: number
): Promise<Locator> {
  await page.setViewportSize({ width, height: 520 });
  await page.goto(
    `${baseURL}/host-presence-preview.html?theme=${theme}&state=${state.name}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  const pill = page.getByTestId("attached-machines-indicator");
  const banner = page.locator("[data-banner-slot] [role]");
  const pane = page.locator("[data-pane-banner] [role]");
  // Each element present or absent exactly as the state says — a missing pill
  // or banner is a picture of the wrong state dressed up as a passing run.
  await expect(pill, `${state.name}: pill`).toHaveCount(state.pill ? 1 : 0);
  await expect(banner, `${state.name}: banner`).toHaveCount(state.banner ? 1 : 0);
  await expect(pane, `${state.name}: pane strip`).toHaveCount(state.pane ? 1 : 0);
  return shell;
}

test("host presence — pill, control banner, pane strip", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PRESENCE is required for the host presence capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PRESENCE=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) =>
          snap(await openState(page, state, theme, DEFAULT_WIDTH), `${state.name}-${theme}.png`)
        )
      );
    }
  }

  const theme = THEMES[0]!;
  const two = STATES.find((s) => s.name === "host-taken-two")!;
  written.push(
    await withPage(context, "popover", async (page) => {
      await openState(page, two, theme, DEFAULT_WIDTH);
      await page.getByTestId("attached-machines-indicator").click();
      const menu = page.locator('[role="menu"]').first();
      await expect(menu).toBeVisible();
      await page.waitForTimeout(250);
      return snap(page.locator("body"), `host-taken-two-${theme}-popover.png`);
    })
  );

  const longName = STATES.find((s) => s.name === "host-long-name")!;
  written.push(
    await withPage(context, "long-name popover", async (page) => {
      await openState(page, longName, theme, DEFAULT_WIDTH);
      await page.getByTestId("attached-machines-indicator").click();
      await expect(page.locator('[role="menu"]').first()).toBeVisible();
      await page.waitForTimeout(250);
      return snap(page.locator("body"), `host-long-name-${theme}-popover.png`);
    })
  );

  for (const name of NARROW_STATES) {
    const state = STATES.find((s) => s.name === name)!;
    written.push(
      await withPage(context, `${name} narrow`, async (page) =>
        snap(await openState(page, state, theme, NARROW_WIDTH), `${name}-${theme}-narrow.png`)
      )
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length + 2 + NARROW_STATES.length);
  console.log(`[host-presence-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
