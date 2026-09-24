/**
 * Assistant figure rail and figure lightbox visual-review harness.
 *
 * Figures appear only after the assistant calls `help.displayImage` mid-session, and
 * the states worth judging — a thumbnail still loading, one whose request failed, a rail
 * that overflows the panel, the lightbox over a portrait figure — take several calls and
 * a misbehaving network to reach in the real app. So this drives the rail's own preview
 * entry (`figure-rail-preview.html`): the real `FigureRail`, the real `FigureLightbox` on
 * `AppDialog`, the real theme tokens and `index.css`, in the panel's real position.
 *
 * Every figure URL is on `https://daintree.org/docs/figures/`, and this spec answers that
 * host itself: most files load, `missing.png` 404s and `slow.png` never answers. The
 * loading and failed states are therefore the component's own reaction to the network,
 * not a prop the harness forces.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_FIGURERAIL=1 npx playwright test --project=screenshots figure-rail-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FIGURERAIL  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/figure-rail-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` refuses a target without a real box,
 * every loaded thumbnail and lightbox image is checked for decoded pixels before its
 * shot, and the test counts the files itself at the end.
 */

import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_FIGURERAIL;

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;
const VIEWPORT = { width: 1280, height: 800 };

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "figure-rail-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

let server: ViteDevServer | undefined;
let baseURL = "";
const figureBodies = new Map<string, { body: Buffer; contentType: string }>();

/**
 * A documentation figure is a screenshot of Daintree, which is exactly why the lightbox
 * frames it with an attribution line — so the fixtures are drawn to look like app UI
 * rather than like stock photos, at the aspect ratios real docs figures come in.
 */
function mockUiHtml(title: string, tone: "dark" | "light", cards: number): string {
  const bg = tone === "dark" ? "#16181d" : "#f4f4f2";
  const panel = tone === "dark" ? "#1f2229" : "#ffffff";
  const line = tone === "dark" ? "#2d313a" : "#e2e2de";
  const text = tone === "dark" ? "#d7dae0" : "#24262b";
  const sub = tone === "dark" ? "#8b919c" : "#6b6e75";
  const card = (i: number) => `
    <div style="background:${panel};border:1px solid ${line};border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:12px;height:12px;border-radius:50%;background:${i % 3 === 0 ? "#3fb27f" : i % 3 === 1 ? "#e0a53a" : "#5b8def"}"></div>
        <div style="font-size:20px;font-weight:600;color:${text}">feature/branch-${i + 1}</div>
      </div>
      <div style="font-size:15px;color:${sub}">${i + 2} agents · ${i} ahead · updated ${i + 1}m ago</div>
      <div style="height:8px;border-radius:4px;background:${line};width:${60 + ((i * 13) % 35)}%"></div>
      <div style="height:8px;border-radius:4px;background:${line};width:${40 + ((i * 7) % 40)}%"></div>
    </div>`;
  return `<!doctype html><html><body style="margin:0;background:${bg};font-family:-apple-system,system-ui,sans-serif">
    <div style="height:52px;border-bottom:1px solid ${line};display:flex;align-items:center;padding:0 22px;gap:14px;background:${panel}">
      <div style="width:14px;height:14px;border-radius:50%;background:#ff5f57"></div>
      <div style="width:14px;height:14px;border-radius:50%;background:#febc2e"></div>
      <div style="width:14px;height:14px;border-radius:50%;background:#28c840"></div>
      <div style="margin-left:18px;font-size:18px;font-weight:600;color:${text}">${title}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:22px">
      ${Array.from({ length: cards }, (_, i) => card(i)).join("")}
    </div></body></html>`;
}

async function renderFixtureImage(
  browser: Browser,
  html: string,
  width: number,
  height: number
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  const png = await page.screenshot({ type: "png" });
  await page.close();
  return png;
}

test.beforeAll(async ({ browser }) => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const png = "image/png";
  figureBodies.set("worktree-dashboard.png", {
    body: await renderFixtureImage(browser, mockUiHtml("Worktrees", "dark", 9), 1600, 1000),
    contentType: png,
  });
  figureBodies.set("agent-settings.png", {
    body: await renderFixtureImage(browser, mockUiHtml("Agent settings", "light", 6), 1400, 900),
    contentType: png,
  });
  figureBodies.set("fleet-ribbon.png", {
    body: await renderFixtureImage(browser, mockUiHtml("Fleet", "dark", 3), 1200, 520),
    contentType: png,
  });
  figureBodies.set("bulk-command.png", {
    body: readFileSync(path.join(process.cwd(), ".github/issue-assets/bulk-command-current.png")),
    contentType: png,
  });
  figureBodies.set("theme-banner.webp", {
    body: readFileSync(path.join(process.cwd(), "public/themes/daintree.webp")),
    contentType: "image/webp",
  });

  server = await createServer({
    // A worktree reaches its dependencies through a symlinked `node_modules`, whose real
    // path sits outside Vite's default serving root — without it the mono face 403s and
    // the terminal stand-in renders in a fallback font.
    server: {
      port: 0,
      strictPort: false,
      fs: { allow: [process.cwd(), realpathSync(path.join(process.cwd(), "node_modules"))] },
    },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out, animations: "allow" });
  return out;
}

async function snapPage(page: Page, file: string): Promise<string> {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, animations: "allow" });
  return out;
}

/** Same inert HMR client the sibling harnesses use; see session-tabs-review.spec.ts. */
async function stubViteHmrClient(page: Page): Promise<void> {
  await page.route("**/@vite/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: [
        "const noop = () => {};",
        "export const createHotContext = () => ({ accept: noop, acceptExports: noop, dispose: noop, prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} });",
        "export const injectQuery = (u) => u;",
        "const sheets = new Map();",
        "export function updateStyle(id, content) {",
        "  let style = sheets.get(id);",
        "  if (!style) {",
        "    style = document.createElement('style');",
        "    style.setAttribute('type', 'text/css');",
        "    style.setAttribute('data-vite-dev-id', id);",
        "    style.textContent = content;",
        "    document.head.appendChild(style);",
        "    sheets.set(id, style);",
        "  } else {",
        "    style.textContent = content;",
        "  }",
        "}",
        "export function removeStyle(id) {",
        "  const style = sheets.get(id);",
        "  if (style) { document.head.removeChild(style); sheets.delete(id); }",
        "}",
      ].join("\n"),
    })
  );
}

/** Answer the docs host: known files load, `missing.png` 404s, `slow.png` never answers. */
async function serveFigures(page: Page): Promise<void> {
  await page.route("https://daintree.org/docs/figures/**", async (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    if (file === "slow.png") return; // left pending on purpose — the loading state
    const hit = figureBodies.get(file);
    if (!hit) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: hit.contentType,
      body: hit.body,
      headers: { "access-control-allow-origin": "*" },
    });
  });
}

interface Opened {
  panel: Locator;
  rail: Locator;
}

async function open(
  page: Page,
  fixture: string,
  theme: string,
  width = DEFAULT_WIDTH,
  extra = ""
): Promise<Opened> {
  await page.setViewportSize(VIEWPORT);
  const url = `${baseURL}/figure-rail-preview.html?theme=${theme}&fixture=${fixture}&width=${width}${extra}`;
  const panel = page.locator("[data-preview-panel]").first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(panel).toBeAttached({ timeout });
  } catch {
    console.warn(`[figure-rail-shots] first mount of ${fixture}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(panel).toBeAttached({ timeout });
  }
  // `flex` comes from a Tailwind utility, so its presence proves the stylesheet landed.
  await expect(panel).toHaveCSS("display", "flex");
  const rail = page.getByTestId("figure-rail");
  await expect(rail).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  return { panel, rail };
}

/** Every thumbnail that should load has decoded pixels and finished fading in. */
async function settleThumbnails(page: Page, expectedLoaded: number): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .getByTestId("figure-thumbnail")
          .locator("img")
          .evaluateAll(
            (imgs) =>
              (imgs as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth > 0).length
          ),
      { timeout: 15_000 }
    )
    .toBe(expectedLoaded);
  // Past the 150ms fade and the 1200ms arrival pulse, so a rest-state shot is at rest.
  await page.waitForTimeout(1400);
}

async function openLightboxOn(page: Page, figureNumber: number): Promise<Locator> {
  await page
    .getByTestId("figure-thumbnail")
    .getByRole("button", { name: new RegExp(`^Figure ${figureNumber}\\b`) })
    .click();
  const dialog = page.getByTestId("figure-lightbox");
  await expect(dialog).toBeVisible();
  await settleLightbox(page);
  return dialog;
}

async function settleLightbox(page: Page): Promise<void> {
  const dialog = page.getByTestId("figure-lightbox");
  await expect
    .poll(
      () =>
        dialog
          .locator("img")
          .evaluateAll((imgs) =>
            (imgs as HTMLImageElement[]).some((i) => i.complete && i.naturalWidth > 0)
          ),
      { timeout: 15_000 }
    )
    .toBe(true);
  // Past the dialog's entry motion.
  await page.waitForTimeout(450);
}

test("assistant figure rail and lightbox — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FIGURERAIL is required for the figure-rail capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FIGURERAIL=1 to run the capture");
  test.setTimeout(240_000);

  await stubViteHmrClient(page);
  await serveFigures(page);

  const written: string[] = [];

  for (const theme of THEMES) {
    {
      const { panel, rail } = await open(page, "several", theme);
      await settleThumbnails(page, 5);
      written.push(await snap(panel, `several-${theme}-panel.png`));
      written.push(await snap(rail, `several-${theme}-rail.png`));

      await openLightboxOn(page, 1);
      written.push(await snapPage(page, `lightbox-landscape-${theme}.png`));

      await page.keyboard.press("ArrowRight");
      await settleLightbox(page);
      written.push(await snapPage(page, `lightbox-portrait-${theme}.png`));
    }
    {
      const { rail } = await open(page, "mixed", theme);
      await settleThumbnails(page, 1);
      await expect(page.getByRole("button", { name: "Retry figure 2" })).toBeVisible();
      written.push(await snap(rail, `mixed-${theme}-rail.png`));
    }
  }

  const base = THEMES[0]!;

  // The arrival pulse, frozen partway through — the one moment the rail asks for
  // attention, and invisible in any rest-state shot.
  {
    const { rail } = await open(page, "one", base);
    await settleThumbnails(page, 1);
    // Rewind the finished pulse rather than racing it live: a paused CSS animation at a
    // fixed time is the same frame on every run.
    const rewound = await page.evaluate(() => {
      const pulses = document
        .getAnimations()
        .filter((a) => (a as CSSAnimation).animationName === "figure-arrive");
      for (const a of pulses) {
        a.pause();
        a.currentTime = 250;
      }
      return pulses.length;
    });
    if (rewound === 0) throw new Error("no figure-arrive animation to freeze — refusing to write");
    await page.waitForTimeout(100);
    written.push(await snap(rail, `one-${base}-rail-arriving.png`));
  }

  // Pointer hover and keyboard focus on a thumbnail.
  {
    const { rail } = await open(page, "several", base);
    await settleThumbnails(page, 5);
    await rail.getByRole("button", { name: /^Figure 2\b/ }).hover();
    await page.waitForTimeout(250);
    written.push(await snap(rail, `several-${base}-rail-hover.png`));

    await page.mouse.move(0, 0);
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await rail.evaluate((el) => el.contains(document.activeElement));
    }
    if (!reached) throw new Error("focus never reached the figure rail — refusing to write");
    await page.waitForTimeout(250);
    written.push(await snap(rail, `several-${base}-rail-focus.png`));

    // Keyboard-open the lightbox from the focused thumbnail, which is how a keyboard
    // user reaches it, and look at where focus lands.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("figure-lightbox")).toBeVisible();
    await settleLightbox(page);
    written.push(await snapPage(page, `lightbox-keyboard-open-${base}.png`));

    // The far end: the last figure, where "next" has nowhere to go.
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowRight");
    await settleLightbox(page);
    written.push(await snapPage(page, `lightbox-last-${base}.png`));
  }

  // Narrowest panel the resizer allows.
  {
    const { panel } = await open(page, "several", base, MIN_WIDTH);
    await settleThumbnails(page, 5);
    written.push(await snap(panel, `several-${base}-panel-320.png`));
  }

  // Caption extremes in the lightbox.
  {
    await open(page, "long-caption", base);
    await settleThumbnails(page, 2);
    await openLightboxOn(page, 1);
    written.push(await snapPage(page, `lightbox-long-caption-${base}.png`));
  }
  {
    await open(page, "no-caption", base);
    await settleThumbnails(page, 3);
    await openLightboxOn(page, 3);
    written.push(await snapPage(page, `lightbox-no-caption-panorama-${base}.png`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * 5 + 8);
  console.log(`[figure-rail-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
