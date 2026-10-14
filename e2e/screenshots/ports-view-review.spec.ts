/**
 * Ports view visual-review harness: forwarded ports across hosts, the host
 * picker that scopes scanning and new forwards, and each operation's pending
 * and failure states.
 *
 * Drives the ports preview entry (`ports-preview.html`) — the real `PortsView`
 * against seeded hosts, forwards and scan results.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PORTS=1 npx playwright test --project=screenshots ports-view-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PORTS   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR     output directory (default artifacts/ports-view-shots)
 *   DAINTREE_SHOT_THEMES  comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output: `<state>-<theme>.png` per state in the first theme, the populated
 * state in every theme, interaction states (pending, failed, menu open) in the
 * first theme, and two narrow cases. Never writes a PNG it has not verified.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_PORTS;
const DEFAULT_WIDTH = 976;
const NARROW_WIDTH = 560;
const ATTACH_TIMEOUT_MS = 30_000;
// Past the inline loading gate, so a pending state shows what a slow call shows.
const PENDING_SETTLE_MS = 700;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "ports-view-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `PORTS_STATES`, with text each must render once settled. */
const STATES = [
  { name: "no-hosts", expects: /Connect to a host/ },
  { name: "one-host-empty", expects: /9229/ },
  { name: "one-host", expects: /8080/ },
  { name: "several-hosts", expects: /build-box/ },
  { name: "long-names", expects: /astro-dev-server/ },
  { name: "scanning", expects: /build-box/ },
  { name: "scan-error", expects: /didn't answer/ },
  { name: "nothing-listening", expects: /5173/ },
  { name: "host-dropped", expects: /isn.t connected/ },
] as const;

type StateName = (typeof STATES)[number]["name"] | "forward-pending" | "forward-error";

const NARROW_STATES = ["several-hosts", "long-names"] as const;

let server: ViteDevServer | undefined;
let baseURL = "";
const ENTRY = "/src/components/Hosts/__preview__/portsPreview.tsx";

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
  await page.goto(`${baseURL}/ports-preview.html?state=several-hosts`);
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
      const thrown = errors.length > 0 ? ` (page threw: ${errors.join(" | ")})` : "";
      throw new Error(`${what}: ${String(error)}${thrown}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openState(
  page: Page,
  name: StateName | "stop-pending" | "stop-error",
  theme: string,
  width: number,
  expects: RegExp | null
): Promise<Locator> {
  await page.setViewportSize({ width: width + 32, height: 640 });
  await page.goto(`${baseURL}/ports-preview.html?theme=${theme}&state=${name}&width=${width}`);
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // The scan and the host drop both land after mount; a picture taken before
  // them is a picture of a different state.
  await page.waitForTimeout(PENDING_SETTLE_MS);
  if (expects) await expect(shell, `${name}: settled content`).toContainText(expects);
  return shell;
}

const forwardedList = (page: Page) =>
  page.locator('[data-testid="ports-forwarded"], [aria-label="Forwarded ports"]').first();
const detectedList = (page: Page) =>
  page.locator('[data-testid="ports-detected"], [aria-label="Detected ports"]').first();

test("ports view — forwards, scope, pending and failure", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PORTS is required for the ports view capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PORTS=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];
  const theme = THEMES[0]!;

  for (const state of STATES) {
    written.push(
      await withPage(context, `${state.name} ${theme}`, async (page) =>
        snap(
          await openState(page, state.name, theme, DEFAULT_WIDTH, state.expects),
          `${state.name}-${theme}.png`
        )
      )
    );
  }

  for (const other of THEMES.slice(1)) {
    written.push(
      await withPage(context, `several-hosts ${other}`, async (page) =>
        snap(
          await openState(page, "several-hosts", other, DEFAULT_WIDTH, /build-box/),
          `several-hosts-${other}.png`
        )
      )
    );
  }

  // Forwarding a detected port that never answers.
  written.push(
    await withPage(context, "forward-pending", async (page) => {
      const shell = await openState(page, "forward-pending", theme, DEFAULT_WIDTH, /9229/);
      await detectedList(page).locator("button").first().click();
      await page.waitForTimeout(PENDING_SETTLE_MS);
      return snap(shell, `forward-pending-${theme}.png`);
    })
  );

  // A typed port the host refuses.
  written.push(
    await withPage(context, "forward-error", async (page) => {
      const shell = await openState(page, "forward-error", theme, DEFAULT_WIDTH, /9229/);
      const input = page.getByPlaceholder("Port");
      await input.fill("8080");
      await input.press("Enter");
      await expect(shell).toContainText(/already in use/);
      await page.waitForTimeout(250);
      return snap(shell, `forward-error-${theme}.png`);
    })
  );

  // An invalid typed port, caught before any call.
  written.push(
    await withPage(context, "invalid-port", async (page) => {
      const shell = await openState(page, "several-hosts", theme, DEFAULT_WIDTH, /9229/);
      const input = page.getByPlaceholder("Port");
      await input.fill("99999");
      await input.press("Enter");
      await expect(shell).toContainText(/1 to 65535/);
      await page.waitForTimeout(250);
      return snap(shell, `invalid-port-${theme}.png`);
    })
  );

  for (const name of ["stop-pending", "stop-error"] as const) {
    written.push(
      await withPage(context, name, async (page) => {
        const shell = await openState(page, name, theme, DEFAULT_WIDTH, /build-box/);
        await forwardedList(page).locator("button").first().click();
        if (name === "stop-error") await expect(shell).toContainText(/closed unexpectedly/);
        await page.waitForTimeout(PENDING_SETTLE_MS);
        return snap(shell, `${name}-${theme}.png`);
      })
    );
  }

  // The host picker open, listing every host it can scope to.
  written.push(
    await withPage(context, "picker-open", async (page) => {
      await openState(page, "several-hosts", theme, DEFAULT_WIDTH, /build-box/);
      await page.getByRole("combobox").first().click();
      await expect(page.getByRole("listbox").first()).toBeVisible();
      await page.waitForTimeout(250);
      return snap(page.locator("body"), `picker-open-${theme}.png`);
    })
  );

  for (const name of NARROW_STATES) {
    const state = STATES.find((s) => s.name === name)!;
    written.push(
      await withPage(context, `${name} narrow`, async (page) =>
        snap(
          await openState(page, name, theme, NARROW_WIDTH, state.expects),
          `${name}-${theme}-narrow.png`
        )
      )
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(STATES.length + (THEMES.length - 1) + 6 + NARROW_STATES.length);
  console.log(`[ports-view-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
