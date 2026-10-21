/**
 * "On other hosts" visual-review harness: the sidebar section that summarises
 * this project on every other host.
 *
 * Drives `other-hosts-group-preview.html` — the real section and its real data
 * hook, fed through the host list, `hostSwitch.locate` and
 * `hostMetrics.listWorktrees` seams, under the local worktree list it sits
 * beneath (decoration).
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_OTHER_HOSTS=1 npx playwright test --project=screenshots other-hosts-group-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_OTHER_HOSTS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/other-hosts-shots)
 *   DAINTREE_SHOT_THEMES       themes for the main states (default: daintree,bondi,namib,hokkaido)
 *   DAINTREE_SHOT_SWEEP        themes the batch state is swept across (default: every built-in)
 *
 * Output: `<state>-<theme>[-narrow].png`, a keyboard-focus capture, and
 * `sweep-<theme>.png` for the sweep. Never writes a PNG it has not verified,
 * and counts the files itself rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_OTHER_HOSTS;
const DEFAULT_WIDTH = 350;
const NARROW_WIDTH = 240;
/** The sidebar's minimum width (AppLayout's MIN_SIDEBAR_WIDTH). */
const MIN_WIDTH = 200;
const ATTACH_TIMEOUT_MS = 30_000;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "other-hosts-shots")
);

const list = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

const THEMES = list(process.env.DAINTREE_SHOT_THEMES, "daintree,bondi,namib,hokkaido");
const SWEEP = list(
  process.env.DAINTREE_SHOT_SWEEP,
  "daintree,arashiyama,fiordland,galapagos,highlands,movile,namib,redwoods,atacama,bali,bondi,hokkaido,serengeti,svalbard,table-mountain"
);

/** Mirrors the preview's STATES, with what each must render. */
const STATES = [
  { name: "batch", hosts: 4, asks: 1, more: 0, everyTheme: true },
  { name: "asking", hosts: 4, asks: 4, more: 1, everyTheme: true },
  { name: "settled", hosts: 4, asks: 0, more: 0, everyTheme: false },
  { name: "dropped", hosts: 4, asks: 0, more: 0, everyTheme: false, staged: true },
  { name: "remote-window", hosts: 3, asks: 1, more: 0, everyTheme: false },
  { name: "long", hosts: 2, asks: 1, more: 0, everyTheme: false },
  { name: "one-host", hosts: 1, asks: 0, more: 0, everyTheme: false },
  { name: "overflow", hosts: 4, asks: 8, more: 4, everyTheme: false, overflows: true },
] as const;

type State = (typeof STATES)[number];

const NARROW_STATES = ["batch", "asking", "long"] as const;
const MIN_STATES = ["batch", "long", "overflow"] as const;

let server: ViteDevServer | undefined;
let baseURL = "";
const ENTRY = "/src/components/Sidebar/__preview__/otherHostsGroup.tsx";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await createServer({
    // A worktree's node_modules is a symlink; without its real path the fonts 403 and the
    // captures paint a fallback face.
    server: {
      port: 0,
      strictPort: false,
      fs: { allow: [process.cwd(), realpathSync("node_modules")] },
    },
    logLevel: "warn",
  });
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
  await page.goto(`${baseURL}/other-hosts-group-preview.html?state=batch`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const rows = await page.getByTestId("other-hosts-host-row").count();
    if (navigations === before && rows === 4) break;
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

async function openState(page: Page, state: State, theme: string, width: number) {
  await page.setViewportSize({ width: width + 40, height: 680 });
  await page.goto(
    `${baseURL}/other-hosts-group-preview.html?theme=${theme}&state=${state.name}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("body[data-staged='true']")).toBeAttached({ timeout: 10_000 });
  // Each count exactly as the state says — a missing row is a picture of the
  // wrong state dressed up as a passing run.
  await expect(page.getByTestId("other-hosts-host-row"), `${state.name}: hosts`).toHaveCount(
    state.hosts
  );
  await expect(page.getByTestId("other-hosts-ask-row"), `${state.name}: asks`).toHaveCount(
    state.asks
  );
  await expect(page.getByTestId("other-hosts-more-row"), `${state.name}: more`).toHaveCount(
    state.more
  );
  if ("overflows" in state) {
    // More than half the sidebar: the pill says what is below, and how much is asking.
    await expect(page.locator("[data-other-hosts-overflow='below']")).toBeVisible();
  }
  if ("staged" in state) {
    await expect(page.getByTestId("other-hosts-worktree-group")).toContainText("Not connected");
  } else if (state.name !== "settled") {
    // Every live state counts something; a row with no counts is a read that never landed.
    await expect(page.locator("[data-band]").filter({ hasText: /\d/ }).first()).toBeAttached();
  }
  await page.waitForTimeout(300);
  return shell;
}

test("on other hosts — sidebar section", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_OTHER_HOSTS is required for the other-hosts capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_OTHER_HOSTS=1 to run the capture");
  test.setTimeout(15 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];
  const first = THEMES[0]!;

  for (const theme of THEMES) {
    for (const state of STATES) {
      if (theme !== first && !state.everyTheme) continue;
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) =>
          snap(await openState(page, state, theme, DEFAULT_WIDTH), `${state.name}-${theme}.png`)
        )
      );
    }
  }

  for (const name of NARROW_STATES) {
    const state = STATES.find((s) => s.name === name)!;
    written.push(
      await withPage(context, `${name} narrow`, async (page) =>
        snap(await openState(page, state, first, NARROW_WIDTH), `${name}-${first}-narrow.png`)
      )
    );
  }

  for (const name of MIN_STATES) {
    const state = STATES.find((s) => s.name === name)!;
    written.push(
      await withPage(context, `${name} min`, async (page) =>
        snap(await openState(page, state, first, MIN_WIDTH), `${name}-${first}-min.png`)
      )
    );
  }

  const overflow = STATES.find((s) => s.name === "overflow")!;
  written.push(
    await withPage(context, "overflow scrolled", async (page) => {
      const shell = await openState(page, overflow, first, DEFAULT_WIDTH);
      await page
        .getByTestId("other-hosts-worktree-group")
        .locator("ul")
        .first()
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      // Scrolled to the end, the asks on the first hosts are now above the edge.
      await expect(page.locator("[data-other-hosts-overflow='above']")).toBeVisible();
      await page.waitForTimeout(300);
      return snap(shell, `overflow-${first}-scrolled.png`);
    })
  );

  const asking = STATES.find((s) => s.name === "asking")!;
  written.push(
    await withPage(context, "keyboard focus", async (page) => {
      await openState(page, asking, first, DEFAULT_WIDTH);
      // Room to the right for the row's tooltip, which opens on focus as on hover.
      await page.setViewportSize({ width: DEFAULT_WIDTH + 340, height: 680 });
      await page.getByTestId("other-hosts-host-row").nth(1).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("other-hosts-ask-row").nth(2)).toBeFocused();
      await expect(page.getByRole("tooltip").first()).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(250);
      return snap(page.locator("body"), `asking-${first}-focus.png`);
    })
  );

  const long = STATES.find((s) => s.name === "long")!;
  written.push(
    await withPage(context, "long name hover", async (page) => {
      await openState(page, long, first, NARROW_WIDTH);
      await page.setViewportSize({ width: NARROW_WIDTH + 340, height: 680 });
      await page.getByTestId("other-hosts-host-row").first().hover();
      await expect(page.getByRole("tooltip").first()).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(250);
      return snap(page.locator("body"), `long-${first}-narrow-hover.png`);
    })
  );

  const batch = STATES.find((s) => s.name === "batch")!;
  for (const theme of SWEEP) {
    written.push(
      await withPage(context, `sweep ${theme}`, async (page) => {
        await openState(page, batch, theme, DEFAULT_WIDTH);
        return snap(page.getByTestId("other-hosts-worktree-group"), `sweep-${theme}.png`);
      })
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  const everyTheme = STATES.filter((s) => s.everyTheme).length;
  expect(onDisk.length).toBe(
    STATES.length +
      (THEMES.length - 1) * everyTheme +
      NARROW_STATES.length +
      MIN_STATES.length +
      3 +
      SWEEP.length
  );
  console.log(`[other-hosts-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
