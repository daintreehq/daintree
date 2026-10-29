/**
 * Element Picker page overlay visual-review harness: what Inspect mode draws
 * inside the user's own page — the hover box and its label, the selection,
 * a component selection and its roots — on light, dark and blue-heavy pages.
 *
 * No Electron: the overlay is plain DOM the guest picker draws, so the spec
 * bundles the real `createPicker` and the real Preact extractor with esbuild
 * and puts them in a Preact 11 dev page in Chromium (Preact, because its
 * extractor answers the roots query Alt+ArrowUp widens through). Hover, clicks and
 * Alt+ArrowUp are real pointer and key events, so labels and component roots
 * come through the same bridge the dev preview uses; only the host side is
 * replaced by a recorder.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_PICKER_OVERLAY is set.
 *
 *   DAINTREE_SHOT_PICKER_OVERLAY=1 DAINTREE_SHOT_DIR=/abs/dir \
 *     npx playwright test --project=screenshots element-picker-overlay-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PICKER_OVERLAY  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             output directory (absolute); defaults to a temp dir
 *   DAINTREE_SHOT_ONLY            comma-separated state filter (names below)
 *   DAINTREE_SCREENSHOT_SCALE     device scale factor (default 2)
 *
 * Output: <dir>/<page>-<NN-state>.png plus <dir>/meta/<same>.json describing
 * what the overlay drew. Every shot is checked against the overlay it expects
 * before it is written; a state that did not render throws instead.
 */

import { test, type Browser, type Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const ENABLED = !!process.env.DAINTREE_SHOT_PICKER_OVERLAY;
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_DIR ?? mkdtempSync(path.join(tmpdir(), "picker-overlay-shots-"));
const ONLY = new Set(
  (process.env.DAINTREE_SHOT_ONLY ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
);
const SCALE = Number(process.env.DAINTREE_SCREENSHOT_SCALE ?? "2");
const ROOT = path.resolve(import.meta.dirname, "../..");
const ORIGIN = "http://picker-fixture.test";
const CHANNEL = "daintree-picker-review";
const VIEWPORT = { width: 1000, height: 640 };
/** `ELEMENT_CROP_MARGIN` in electron/ipc/handlers/webviewCapture.ts: what the agent's picture keeps around a selection. */
const AGENT_CROP_MARGIN = 32;

type PageTheme = "light" | "dark" | "blue";

/**
 * A small product site in three palettes. `blue` is the one the overlay has to
 * survive: its brand colour is the overlay's own blue. `PricingSection`
 * renders three roots from a fragment, and the long-named panel carries a
 * utility-class list deep enough to overflow a label.
 */
const APP_SOURCE = String.raw`
import { Fragment, render } from "preact";
import { useState } from "preact/hooks";

function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="#">Northwind</a>
      <nav className="nav">
        <a href="#features" id="nav-features">Features</a>
        <a href="#pricing">Pricing</a>
        <a href="#docs">Docs</a>
        <a href="#signin" className="nav-cta">Sign in</a>
      </nav>
    </header>
  );
}

function HeroBanner() {
  return (
    <section className="hero" id="hero">
      <h1>Ship the release notes your customers read</h1>
      <p className="lede">
        Draft them from merged pull requests, review them with your team, and publish with
        <code className="inline-code">npx notes ship</code> in one step.
      </p>
      <div className="actions">
        <button className="btn btn-primary" id="hero-primary">Start free trial</button>
        <button className="btn btn-ghost">Book a demo</button>
      </div>
    </section>
  );
}

function FeatureCard({ id, title, body }) {
  return (
    <article className="card feature-card" id={id}>
      <div className="card-icon" />
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function FeatureGrid() {
  return (
    <section className="features" id="features">
      <FeatureCard id="card-drafts" title="Drafts from PRs" body="Every merged PR becomes a line you can keep, edit or drop." />
      <FeatureCard id="card-review" title="Team review" body="Comment on a draft and resolve threads before it goes out." />
      <FeatureCard id="card-publish" title="One-step publish" body="Push to your changelog, email list and in-app feed at once." />
    </section>
  );
}

function PricingSection() {
  return (
    <Fragment>
      <h2 className="section-title" id="pricing">Pricing that scales with your team</h2>
      <div className="plans">
        <div className="plan"><strong>Starter</strong><span>$0</span></div>
        <div className="plan plan-featured"><strong>Team</strong><span>$24</span></div>
        <div className="plan"><strong>Enterprise</strong><span>Talk to us</span></div>
      </div>
      <p className="footnote">Prices per seat per month, billed annually.</p>
    </Fragment>
  );
}

function AnnualBillingDiscountComparisonPanelWithSeatCalculator() {
  return (
    <aside className="calculator">
      <div
        id="seat-calculator-summary-row"
        className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white/80 px-6 py-4 text-sm font-medium tracking-tight shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/60 md:px-8"
      >
        <span>12 seats, annual</span>
        <span className="calc-total">$3,456 / year</span>
      </div>
    </aside>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>© 2026 Northwind Labs</span>
      <button className="btn btn-small" id="footer-contact">Contact sales</button>
    </footer>
  );
}

function ReleaseNotice() {
  return <div className="release-notice">v2.4 is out — drafts now group by label.</div>;
}

function App() {
  const [notice, setNotice] = useState(false);
  window.__fixture = { showNotice: () => setNotice(true) };
  return (
    <main className="page">
      <SiteHeader />
      {notice ? <ReleaseNotice /> : null}
      <HeroBanner />
      <FeatureGrid />
      <PricingSection />
      <AnnualBillingDiscountComparisonPanelWithSeatCalculator />
      <SiteFooter />
    </main>
  );
}

render(<App />, document.getElementById("root"));
`;

const PALETTES: Record<PageTheme, Record<string, string>> = {
  light: {
    bg: "#ffffff",
    surface: "#f6f7f9",
    text: "#14171f",
    muted: "#5b6372",
    border: "#e3e6eb",
    brand: "#5b45e0",
    brandText: "#ffffff",
    hero: "#f3f1ff",
  },
  dark: {
    bg: "#0d1017",
    surface: "#161a23",
    text: "#e8ebf2",
    muted: "#9aa3b5",
    border: "#262c38",
    brand: "#22c55e",
    brandText: "#06210f",
    hero: "#11151d",
  },
  blue: {
    bg: "#eef4ff",
    surface: "#dbe8ff",
    text: "#0b2a6b",
    muted: "#3b5b9a",
    border: "#9cbcf5",
    brand: "#3884ff",
    brandText: "#ffffff",
    hero: "#2f6fe0",
  },
};

function pageHtml(theme: PageTheme): string {
  const p = PALETTES[theme];
  const heroText = theme === "blue" ? "#ffffff" : p.text;
  const heroMuted = theme === "blue" ? "#dbe8ff" : p.muted;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Northwind</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { background: ${p.bg}; color: ${p.text}; font: 15px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; }
  a { color: inherit; text-decoration: none; }
  .site-header { display: flex; align-items: center; justify-content: space-between; height: 52px; padding: 0 32px; border-bottom: 1px solid ${p.border}; background: ${p.bg}; }
  .brand { font-weight: 700; font-size: 17px; }
  .nav { display: flex; gap: 22px; align-items: center; font-size: 14px; color: ${p.muted}; }
  .nav-cta { color: ${p.brandText}; background: ${p.brand}; padding: 6px 12px; border-radius: 8px; }
  .release-notice { padding: 14px 32px; background: ${p.surface}; border-bottom: 1px solid ${p.border}; font-size: 14px; }
  .hero { padding: 44px 32px 40px; background: ${p.hero}; color: ${heroText}; }
  .hero h1 { margin: 0 0 12px; font-size: 34px; line-height: 1.15; letter-spacing: -0.02em; max-width: 640px; }
  .lede { margin: 0 0 22px; color: ${heroMuted}; max-width: 600px; font-size: 16px; }
  .inline-code { font: 13px/1 ui-monospace, Menlo, monospace; padding: 2px 5px; border-radius: 4px; background: ${theme === "blue" ? "#1d4fb8" : p.surface}; color: ${heroText}; margin-left: 4px; }
  .actions { display: flex; gap: 12px; }
  .btn { font: 600 14px/1 inherit; font-family: inherit; padding: 11px 18px; border-radius: 8px; border: 1px solid ${p.border}; background: ${p.bg}; color: ${p.text}; }
  .btn-primary { background: ${theme === "blue" ? "#ffffff" : p.brand}; color: ${theme === "blue" ? "#1d4fb8" : p.brandText}; border-color: transparent; }
  .btn-ghost { background: transparent; color: ${heroText}; border-color: ${theme === "blue" ? "#8fb4ff" : p.border}; }
  .btn-small { padding: 8px 14px; background: ${p.brand}; color: ${p.brandText}; border-color: transparent; }
  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 28px 32px; }
  .card { padding: 18px; border-radius: 12px; border: 1px solid ${p.border}; background: ${p.surface}; }
  .card-icon { width: 28px; height: 28px; border-radius: 8px; background: ${p.brand}; margin-bottom: 12px; }
  .card h3 { margin: 0 0 6px; font-size: 16px; }
  .card p { margin: 0; color: ${p.muted}; font-size: 14px; }
  .section-title { margin: 8px 32px 14px; font-size: 22px; letter-spacing: -0.01em; }
  .plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 0 32px; }
  .plan { display: flex; justify-content: space-between; padding: 16px 18px; border-radius: 12px; border: 1px solid ${p.border}; background: ${p.surface}; }
  .plan-featured { border-color: ${p.brand}; box-shadow: 0 0 0 1px ${p.brand}; }
  .footnote { margin: 10px 32px 22px; color: ${p.muted}; font-size: 13px; }
  .calculator { padding: 0 32px 24px; }
  #seat-calculator-summary-row { display: flex; justify-content: space-between; padding: 16px 24px; border-radius: 12px; border: 1px solid ${p.border}; background: ${p.surface}; }
  .calc-total { font-weight: 600; }
  .site-footer { display: flex; justify-content: space-between; align-items: center; padding: 18px 32px; border-top: 1px solid ${p.border}; color: ${p.muted}; font-size: 13px; }
</style></head>
<body><div id="root"></div>
<script src="/app.js"></script>
<script src="/extractor.js"></script>
<script src="/picker.js"></script>
</body></html>`;
}

const PICKER_ENTRY = `
import { createPicker } from "./electron/services/elementPicker/guest/picker.ts";
const events = [];
const picker = createPicker({ channel: ${JSON.stringify(CHANNEL)}, mode: "select", post: (event) => events.push(event) });
picker.setAvailability({ detection: "settled", extractors: { preact: "installed" } });
window.__harness = { picker, events };
`;

const EXTRACTOR_ENTRY = `
import { installExtractor } from "./electron/services/elementPicker/guest/registry.ts";
import { createPreactExtractor } from "./electron/services/elementPicker/guest/preact/extractor.ts";
const api = { channel: ${JSON.stringify(CHANNEL)}, framework: "preact", installed: false };
installExtractor(api, createPreactExtractor());
if (!api.installed) throw new Error("preact extractor did not install");
`;

async function bundle(contents: string, loader: "js" | "jsx"): Promise<string> {
  const result = await build({
    stdin: { contents, loader, resolveDir: ROOT, sourcefile: "entry." + loader },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome130",
    jsx: "automatic",
    jsxDev: true,
    jsxImportSource: "preact",
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("esbuild produced no output");
  return output.text;
}

interface Assets {
  app: string;
  extractor: string;
  picker: string;
}

interface OverlayReport {
  boxes: number;
  labels: string[];
  layerChildren: number;
  hostConnected: boolean;
  cursor: string;
  selection: string[];
  scope: string;
}

async function openPage(
  browser: Browser,
  assets: Assets,
  theme: PageTheme
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(ORIGIN + "/**", async (route) => {
    const url = new URL(route.request().url());
    const body =
      url.pathname === "/app.js"
        ? assets.app
        : url.pathname === "/extractor.js"
          ? assets.extractor
          : url.pathname === "/picker.js"
            ? assets.picker
            : pageHtml(theme);
    await route.fulfill({
      status: 200,
      contentType: url.pathname.endsWith(".js") ? "text/javascript" : "text/html",
      body,
    });
  });
  await page.goto(ORIGIN + "/");
  await page.waitForFunction(() => {
    const harness = (window as unknown as { __harness?: unknown }).__harness;
    return harness !== undefined && document.querySelector("#features") !== null;
  });
  if (errors.length > 0) throw new Error("fixture page errors: " + errors.join("; "));
  return { page, close: () => context.close() };
}

/** Two frames for the picker's rAF to resolve the hit and paint, then a beat. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await page.waitForTimeout(80); // e2e-wait: ok — lets a ResizeObserver-triggered repaint land
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error("no box for " + selector);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function hover(page: Page, selector: string, at?: { dx: number; dy: number }) {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error("no box for " + selector);
  const x = at ? box.x + at.dx : box.x + box.width / 2;
  const y = at ? box.y + at.dy : box.y + box.height / 2;
  await page.mouse.move(x - 3, y - 3);
  await page.mouse.move(x, y);
  await settle(page);
}

async function click(page: Page, selector: string, at?: { dx: number; dy: number }) {
  await hover(page, selector, at);
  const point = at
    ? await page
        .locator(selector)
        .first()
        .boundingBox()
        .then((box) => ({ x: box!.x + at.dx, y: box!.y + at.dy }))
    : await centerOf(page, selector);
  await page.mouse.click(point.x, point.y);
  await settle(page);
}

/** What the host does when the pointer leaves the preview for the drawer. */
async function pointerAway(page: Page) {
  await page.evaluate(() => {
    (
      window as unknown as { __harness: { picker: { clearHover(): void } } }
    ).__harness.picker.clearHover();
  });
  await settle(page);
}

async function widen(page: Page) {
  await page.keyboard.press("Alt+ArrowUp");
  await settle(page);
}

async function report(page: Page): Promise<OverlayReport> {
  return page.evaluate(() => {
    const harness = (
      window as unknown as {
        __harness: {
          picker: { getOverlayRoot(): ShadowRoot | null };
          events: Array<{
            type: string;
            observations?: Array<{ label: string }>;
            scope?: { kind: string; componentId?: string };
          }>;
        };
      }
    ).__harness;
    const root = harness.picker.getOverlayRoot();
    const layer = root?.firstElementChild as HTMLElement | null | undefined;
    const children = layer ? Array.from(layer.querySelectorAll("*")) : [];
    const boxes = children.filter((node) => {
      const style = (node as HTMLElement).style;
      return (
        node.childElementCount === 0 &&
        (node.textContent ?? "") === "" &&
        style.position === "fixed" &&
        parseFloat(style.width) > 0
      );
    }).length;
    const labels = children
      .filter((node) => (node.textContent ?? "").trim() !== "" && node.parentElement === layer)
      .map((node) => (node.textContent ?? "").trim());
    const last = [...harness.events].reverse().find((event) => event.type === "selectionChanged");
    const hit = document.elementFromPoint(500, 300);
    return {
      boxes,
      labels,
      layerChildren: layer?.childElementCount ?? 0,
      hostConnected: root?.host.isConnected ?? false,
      cursor: hit ? getComputedStyle(hit).cursor : "none",
      selection: last?.observations?.map((observation) => observation.label) ?? [],
      scope: last?.scope?.kind ?? "none",
    };
  });
}

interface StateSpec {
  name: string;
  /** Pages this state is captured on; the first is the default. */
  themes: PageTheme[];
  run(page: Page): Promise<void>;
  /** Throws when the overlay is not what the state is meant to show. */
  expect(overlay: OverlayReport): void;
  /** Crop the shot as the agent's picture is cropped, rather than the whole viewport. */
  agentCrop?: boolean;
}

function need(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const STATES: StateSpec[] = [
  {
    name: "01-inspect-idle",
    themes: ["light"],
    run: async (page) => {
      await page.mouse.move(500, 300);
      await settle(page);
      await pointerAway(page);
    },
    expect: (overlay) => need(overlay.selection.length === 0, "idle state has a selection"),
  },
  {
    name: "02-hover-inline",
    themes: ["light", "dark", "blue"],
    run: (page) => hover(page, ".inline-code"),
    expect: (overlay) => need(overlay.labels.length >= 1, "no hover label on the inline element"),
  },
  {
    name: "03-hover-container",
    themes: ["light"],
    run: (page) => hover(page, "#features", { dx: 8, dy: 8 }),
    expect: (overlay) => need(overlay.labels.length >= 1, "no hover label on the container"),
  },
  {
    name: "04-hover-top-edge",
    themes: ["light"],
    run: (page) => hover(page, "#nav-features"),
    expect: (overlay) => need(overlay.labels.length >= 1, "no hover label at the top edge"),
  },
  {
    name: "05-hover-bottom-right",
    themes: ["light"],
    run: async (page) => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await settle(page);
      await hover(page, "#footer-contact");
    },
    expect: (overlay) => need(overlay.labels.length >= 1, "no hover label at the bottom edge"),
  },
  {
    name: "06-selected-pointer-away",
    themes: ["light"],
    run: async (page) => {
      await click(page, "#card-review h3");
      await pointerAway(page);
    },
    expect: (overlay) => need(overlay.selection.length === 1, "nothing selected"),
  },
  {
    name: "07-selected-hover-neighbour",
    themes: ["light", "dark", "blue"],
    run: async (page) => {
      await click(page, "#card-review", { dx: 10, dy: 10 });
      await hover(page, "#card-publish", { dx: 10, dy: 10 });
    },
    expect: (overlay) => {
      need(overlay.selection.length === 1, "nothing selected");
      need(overlay.labels.length >= 1, "no hover label on the neighbour");
    },
  },
  {
    name: "08-component-one-root",
    themes: ["light"],
    run: async (page) => {
      await click(page, "#card-review h3");
      await widen(page);
      await pointerAway(page);
    },
    expect: (overlay) => {
      need(overlay.scope === "component", "Alt+Up did not select a component");
      need(overlay.selection.length === 1, "FeatureCard should have one root");
    },
  },
  {
    name: "09-component-multi-root",
    themes: ["light", "dark", "blue"],
    run: async (page) => {
      await page.evaluate(() => document.querySelector("#pricing")!.scrollIntoView());
      await page.evaluate(() => window.scrollBy(0, -70));
      await settle(page);
      await click(page, "#pricing");
      await widen(page);
      await pointerAway(page);
    },
    expect: (overlay) => {
      need(overlay.scope === "component", "Alt+Up did not select PricingSection");
      need(overlay.selection.length === 3, "PricingSection should have three roots");
    },
  },
  {
    name: "10-hover-inside-component",
    themes: ["light"],
    run: async (page) => {
      await click(page, "#card-review h3");
      await widen(page);
      await hover(page, "#card-review p");
    },
    expect: (overlay) => need(overlay.scope === "component", "not a component selection"),
  },
  {
    name: "11-long-label",
    themes: ["light"],
    run: async (page) => {
      await page.evaluate(() =>
        document.querySelector("#seat-calculator-summary-row")!.scrollIntoView({ block: "center" })
      );
      await settle(page);
      await hover(page, "#seat-calculator-summary-row", { dx: 300, dy: 6 });
    },
    expect: (overlay) => need(overlay.labels.length >= 1, "no long label"),
  },
  {
    name: "12-zoomed",
    themes: ["light"],
    run: async (page) => {
      await page.evaluate(() => {
        document.documentElement.style.setProperty("zoom", "1.25");
      });
      await settle(page);
      await click(page, "#card-drafts", { dx: 12, dy: 12 });
      await hover(page, ".inline-code");
    },
    expect: (overlay) => need(overlay.selection.length === 1, "nothing selected when zoomed"),
  },
  {
    name: "13-mid-scroll",
    themes: ["light"],
    run: async (page) => {
      // Room to scroll the card half out of the top of the viewport.
      await page.evaluate(() => document.body.style.setProperty("padding-bottom", "800px"));
      await click(page, "#card-review", { dx: 10, dy: 10 });
      const top = await page.evaluate(
        () => document.querySelector("#card-review")!.getBoundingClientRect().top
      );
      await page.evaluate((by) => window.scrollBy(0, by), top + 70);
      await settle(page);
      await hover(page, "#pricing");
    },
    expect: (overlay) => need(overlay.selection.length === 1, "selection lost on scroll"),
  },
  {
    name: "14-after-hot-update",
    themes: ["light"],
    run: async (page) => {
      await click(page, "#card-review", { dx: 10, dy: 10 });
      await pointerAway(page);
      await page.evaluate(() =>
        (window as unknown as { __fixture: { showNotice(): void } }).__fixture.showNotice()
      );
      await settle(page);
      await settle(page);
    },
    expect: (overlay) => need(overlay.selection.length === 1, "selection lost to the update"),
  },
  {
    name: "15-browse-with-selection",
    themes: ["light"],
    run: async (page) => {
      await click(page, "#card-review", { dx: 10, dy: 10 });
      await page.evaluate(() =>
        (
          window as unknown as {
            __harness: { picker: { setMode(mode: string): void } };
          }
        ).__harness.picker.setMode("browse")
      );
      await settle(page);
      await page.mouse.move(300, 200);
      await settle(page);
    },
    expect: (overlay) => need(overlay.selection.length === 1, "selection dropped in browse"),
  },
  {
    name: "16-hover-brand-button",
    themes: ["blue", "light"],
    run: (page) => hover(page, "#hero-primary"),
    expect: (overlay) => need(overlay.labels.length >= 1, "no label on the button"),
  },
  {
    name: "17-agent-crop-element",
    themes: ["light", "blue"],
    agentCrop: true,
    // The picture is taken the moment the click selects, with the pointer still there.
    run: (page) => click(page, "#card-review h3"),
    expect: (overlay) => need(overlay.selection.length === 1, "nothing selected"),
  },
  {
    name: "18-agent-crop-component",
    themes: ["light"],
    agentCrop: true,
    run: async (page) => {
      await page.evaluate(() => document.querySelector("#pricing")!.scrollIntoView());
      await page.evaluate(() => window.scrollBy(0, -70));
      await settle(page);
      await click(page, "#pricing");
      await widen(page);
    },
    expect: (overlay) =>
      need(overlay.selection.length === 3, "PricingSection should have three roots"),
  },
];

/** The union of the selection's reported bounds plus the agent crop margin, clamped to the viewport. */
async function agentClip(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number }> {
  const bounds = await page.evaluate(() => {
    const events = (
      window as unknown as {
        __harness: {
          events: Array<{
            type: string;
            observations?: Array<{
              bounds: Array<{ x: number; y: number; width: number; height: number }>;
            }>;
          }>;
        };
      }
    ).__harness.events;
    const last = [...events].reverse().find((event) => event.type === "selectionChanged");
    return (last?.observations ?? []).flatMap((observation) => observation.bounds);
  });
  if (bounds.length === 0) throw new Error("no selection bounds to crop to");
  const left = Math.max(0, Math.min(...bounds.map((b) => b.x)) - AGENT_CROP_MARGIN);
  const top = Math.max(0, Math.min(...bounds.map((b) => b.y)) - AGENT_CROP_MARGIN);
  const right = Math.min(
    VIEWPORT.width,
    Math.max(...bounds.map((b) => b.x + b.width)) + AGENT_CROP_MARGIN
  );
  const bottom = Math.min(
    VIEWPORT.height,
    Math.max(...bounds.map((b) => b.y + b.height)) + AGENT_CROP_MARGIN
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

test("element picker overlay review — every state that carries design weight", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PICKER_OVERLAY is required for the picker overlay capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PICKER_OVERLAY to run the picker overlay capture");

  mkdirSync(path.join(OUTPUT_DIR, "meta"), { recursive: true });
  const assets: Assets = {
    app: await bundle(APP_SOURCE, "jsx"),
    extractor: await bundle(EXTRACTOR_ENTRY, "js"),
    picker: await bundle(PICKER_ENTRY, "js"),
  };
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    for (const state of STATES) {
      if (ONLY.size > 0 && !ONLY.has(state.name)) continue;
      for (const theme of state.themes) {
        const { page, close } = await openPage(browser, assets, theme);
        try {
          await state.run(page);
          const overlay = await report(page);
          state.expect(overlay);
          const name = `${theme}-${state.name}`;
          await page.screenshot({
            path: path.join(OUTPUT_DIR, name + ".png"),
            ...(state.agentCrop ? { clip: await agentClip(page) } : {}),
          });
          writeFileSync(
            path.join(OUTPUT_DIR, "meta", name + ".json"),
            JSON.stringify(overlay, null, 2)
          );
          written.push(name);
        } catch (error) {
          throw new Error(`${theme}-${state.name}: ${(error as Error).message}`, { cause: error });
        } finally {
          await close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`[picker-overlay] wrote ${written.length} shots to ${OUTPUT_DIR}`);
});
