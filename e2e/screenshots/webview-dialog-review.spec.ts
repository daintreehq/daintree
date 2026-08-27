/**
 * Contained webview-dialog visual-review harness (#11971).
 *
 * `WebviewDialog` is the alert / confirm / prompt surface a guest page raises inside its
 * own browser panel. It deliberately does NOT portal to the document — it is `absolute
 * inset-0` over the owning pane — so it can never be judged from an isolated component
 * render: the whole question is whether a panel-contained surface still reads as a
 * Daintree dialog. That only shows up in pixels, against the real pane behind it.
 *
 * The guest supplies the page behind the overlay; the dialog itself is raised by emitting
 * the exact `webview:dialog-request` payload `electron/setup/protocols.ts` sends. The real
 * `useWebviewDialog` queue, the real component, the real pane and the real theme are all on
 * the live path — only Chromium's own interception is short-circuited, and #11971 puts that
 * out of scope. See `raise()` for why the guest cannot raise its own dialog here.
 *
 * State axes captured (issue #11971's capture matrix):
 *
 *   type      alert (no Cancel), confirm (two actions), prompt (field + two actions)
 *   message   short one-liner, long paragraph, multi-paragraph, unbroken hostile token
 *   value     empty, populated, overflowing
 *   focus     initial focus per type, Tab-moved focus, focus inside the field
 *   media     default, prefers-contrast: more, forced-colors: active
 *
 * The `spoof` page is not decoration: it has the guest impersonate Daintree's own voice
 * ("Daintree — your session has expired"), which is the adversarial case for the issue's
 * requirement that page-authored text stay distinguishable from Daintree-authored text.
 *
 * Opt-in only, like confirm-dialog-review: skips itself unless DAINTREE_SHOT_WEBVIEW is
 * set, so the marketing screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_WEBVIEW=1 npx playwright test --project=screenshots webview-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_WEBVIEW  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME    optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG      optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names below)
 *
 * Output: artifacts/webview-dialog-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page, type Locator } from "@playwright/test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { mkdtempSync, mkdirSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { openBrowser } from "../helpers/panels";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_WEBVIEW;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "webview-dialog-shots");

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

const LONG_MESSAGE =
  "The upload could not be completed because the connection to the storage service was " +
  "interrupted after 4 of 12 parts had been transferred. Any parts already uploaded have " +
  "been retained for 24 hours, so retrying will resume rather than restart. If this keeps " +
  "happening, check whether a proxy or VPN is terminating long-lived connections.";

const MULTILINE_MESSAGE =
  "Three files could not be migrated:\n\n" +
  "  • src/legacy/adapter.ts\n" +
  "  • src/legacy/bridge.ts\n" +
  "  • src/legacy/shim.ts\n\n" +
  "Re-run with --force to overwrite them.";

/** No spaces: exercises `break-words` and the width cap at the same time. */
const HOSTILE_TOKEN =
  "ERR_" +
  "TRANSPORT_HANDSHAKE_REJECTED_UPSTREAM_CERTIFICATE_CHAIN_INCOMPLETE_".repeat(3) +
  "0x8F2A";

/** The guest impersonating Daintree's own voice — the provenance-labelling case. */
const SPOOF_MESSAGE =
  "Daintree — your session has expired.\n\n" +
  "Re-enter your workspace access token to continue syncing worktrees.";

const LONG_VALUE =
  "/Users/greg/Projects/daintree/packages/plugin-sdk/src/generated/manifest.contributions.d.ts";

interface DialogPage {
  /** URL path, also the step name for DAINTREE_SHOT_ONLY. */
  slug: string;
  /** Visible page body, so the pane behind the overlay is not blank. */
  heading: string;
}

const PAGES: DialogPage[] = [
  { slug: "alert-short", heading: "Deploy console" },
  {
    slug: "alert-long",
    heading: "Upload manager",
  },
  {
    slug: "alert-multiline",
    heading: "Migration report",
  },
  {
    slug: "alert-hostile",
    heading: "Transport diagnostics",
  },
  {
    slug: "confirm-short",
    heading: "Asset library",
  },
  {
    slug: "confirm-long",
    heading: "Billing portal",
  },
  {
    slug: "prompt-empty",
    heading: "Team directory",
  },
  {
    slug: "prompt-filled",
    heading: "File manager",
  },
  {
    slug: "prompt-longvalue",
    heading: "Path resolver",
  },
  {
    slug: "prompt-spoof",
    heading: "Third-party dashboard",
  },
];

function renderPage(page: DialogPage): string {
  // Static on purpose — the guest supplies the backdrop, not the dialog. A page that
  // raised its own dialog would be answered before it reached the renderer under this
  // harness (see `raise`), and would only add a second, invisible one to the queue.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; font: 14px/1.5 system-ui, sans-serif; background:#f4f5f7; color:#1c1e21; }
    header { padding:14px 20px; background:#fff; border-bottom:1px solid #dfe1e6; font-weight:600; }
    main { padding:20px; }
    .row { height:38px; background:#fff; border:1px solid #e4e6ea; border-radius:6px; margin-bottom:8px; }
  </style></head><body>
    <header>${page.heading}</header>
    <main><div class="row"></div><div class="row"></div><div class="row"></div><div class="row"></div></main>
  </body></html>`;
}

const PAGE_BY_SLUG = new Map(PAGES.map((p) => [p.slug, p]));

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const slug = (req.url ?? "/").replace(/^\//, "").split("?")[0] ?? "";
  const page = PAGE_BY_SLUG.get(slug);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page ? renderPage(page) : "<html><body><h1>Idle</h1></body></html>");
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, target?: Locator): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (target) {
    await target.screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled" });
  }
}

/**
 * Every built-in theme. Switching themes in place crashes the project view under this
 * harness (same constraint as confirm-dialog-review), so the sweep boots once per theme.
 */
export const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the other shots are still worth having. But the
// run must still FAIL, or a silent exit 0 with an empty output directory reads as success.
const failures: string[] = [];

test("contained webview dialog review — alert, confirm and prompt over a browser panel", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_WEBVIEW is required for the webview dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_WEBVIEW to run the webview dialog capture");

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const server: Server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const { dir: fixture, cleanup } = createFixtureRepo({ name: "webview-dialog-shots" });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-webviewshot-"));
  let ctx: AppContext | undefined;
  let captured = 0;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Webview Dialogs");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    await openBrowser(page);
    const panel = page
      .locator(SEL.panel.gridPanel)
      .filter({ has: page.locator(SEL.browser.addressBar) })
      .first();
    await panel.waitFor({ state: "visible", timeout: T_LONG });
    await settle(page, 1200);

    const addressBar = panel.locator(SEL.browser.addressBar);
    // Scoped to the browser panel: the app shell has other dialog roles, and a
    // page-level `[role="dialog"]` would match whichever painted last.
    const dialog = panel.locator('[role="dialog"][aria-modal="true"]');

    const panelId = await panel.getAttribute("data-panel-id");
    if (!panelId) throw new Error("browser panel has no data-panel-id to address dialogs to");

    /**
     * Put the guest on a real page so the pane behind the overlay is real content —
     * the containment shot is half the point of this harness.
     */
    async function showPage(slug: string): Promise<void> {
      await addressBar.click();
      await addressBar.fill(`http://127.0.0.1:${port}/${slug}`);
      await page.keyboard.press("Enter");
      await settle(page, 700);
    }

    /**
     * Raise the dialog by emitting the exact `webview:dialog-request` payload
     * `electron/setup/protocols.ts` sends from its `js-dialog` listener.
     *
     * Deliberately not by letting the guest call `alert()` itself: under this harness
     * the guest's dialog is answered before it reaches the renderer, so nothing paints
     * (verified — the guest navigates and renders, and no `[role="dialog"]` ever
     * appears). Injecting at the channel keeps everything this review is actually about
     * on the real path — the real `useWebviewDialog` queue, the real component, the real
     * pane, the real theme — and short-circuits only Chromium's interception, which
     * issue #11971 puts out of scope anyway.
     *
     * Broadcast rather than targeted: panels live in a per-project WebContentsView, and
     * `useWebviewDialog` already filters on `panelId`, so every non-owner ignores it.
     */
    let dialogSeq = 0;
    async function raise(
      type: "alert" | "confirm" | "prompt",
      message: string,
      defaultValue = ""
    ): Promise<void> {
      const payload = {
        dialogId: `shot-${++dialogSeq}`,
        panelId: panelId!,
        type,
        message,
        defaultValue,
      };
      await ctx!.app.evaluate(({ webContents }, data) => {
        for (const wc of webContents.getAllWebContents()) {
          if (!wc.isDestroyed()) wc.send("webview:dialog-request", data);
        }
      }, payload);
      await dialog.waitFor({ state: "visible", timeout: 15_000 });
      await settle(page, 400);
    }

    /** Answer the dialog so the next one starts from a clean queue. */
    async function dismiss(): Promise<void> {
      const ok = dialog.locator("button").last();
      if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
      await dialog.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
      await settle(page, 250);
    }

    async function step(name: string, fn: () => Promise<void>): Promise<void> {
      if (ONLY.length > 0 && !ONLY.includes(name)) return;
      try {
        await fn();
      } catch (error) {
        const detail = String(error).slice(0, 300);
        console.warn(`[webview-shots] step "${name}" failed:`, detail);
        failures.push(`${name}: ${detail}`);
      } finally {
        // Unconditional: a step that dies holding an open guest dialog would wedge
        // every step after it behind a blocked guest renderer.
        await dismiss().catch((error) => {
          failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
        });
      }
    }

    // ---- 1. The three types, at their most ordinary. The family-resemblance shots. ----
    await step("alert-short", async () => {
      await showPage("alert-short");
      await raise("alert", "Changes saved.");
      await snap(page, "10-alert-short-card", dialog);
      await snap(page, "11-alert-short-in-panel", panel);
      captured += 2;
    });

    await step("confirm-short", async () => {
      await showPage("confirm-short");
      await raise("confirm", "Delete this item?");
      await snap(page, "12-confirm-short-card", dialog);
      await snap(page, "13-confirm-short-in-panel", panel);
      captured += 2;
    });

    await step("prompt-filled", async () => {
      await showPage("prompt-filled");
      await raise("prompt", "Rename this file", "quarterly-report-final-v3.pdf");
      await snap(page, "14-prompt-filled-card", dialog);
      await snap(page, "15-prompt-filled-in-panel", panel);
      captured += 2;
    });

    // ---- 2. Content stress: what long, multiline and hostile page text does to it. ----
    const STRESS: Array<[string, "alert" | "confirm" | "prompt", string, string]> = [
      ["alert-long", "alert", LONG_MESSAGE, ""],
      ["alert-multiline", "alert", MULTILINE_MESSAGE, ""],
      ["alert-hostile", "alert", HOSTILE_TOKEN, ""],
      ["confirm-long", "confirm", LONG_MESSAGE, ""],
      ["prompt-longvalue", "prompt", "Confirm the output path", LONG_VALUE],
      ["prompt-empty", "prompt", "What should we call this workspace?", ""],
    ];
    for (const [index, [slug, type, message, value]] of STRESS.entries()) {
      await step(slug, async () => {
        await showPage(slug);
        await raise(type, message, value);
        await snap(page, `${20 + index}-${slug}-card`, dialog);
        captured += 1;
      });
    }

    // ---- 3. The provenance case: the guest speaking in Daintree's voice. ----
    await step("prompt-spoof", async () => {
      await showPage("prompt-spoof");
      await raise("prompt", SPOOF_MESSAGE, "");
      await snap(page, "30-prompt-spoof-card", dialog);
      await snap(page, "31-prompt-spoof-in-panel", panel);
      captured += 2;
    });

    // ---- 4. Keyboard: where initial focus lands, and where Tab takes it. ----
    await step("focus-confirm", async () => {
      await showPage("confirm-short");
      await raise("confirm", "Delete this item?");
      await snap(page, "40-confirm-initial-focus", dialog);
      await page.keyboard.press("Tab");
      await settle(page, 250);
      await snap(page, "41-confirm-tabbed-focus", dialog);
      captured += 2;
    });

    await step("focus-prompt", async () => {
      await showPage("prompt-filled");
      await raise("prompt", "Rename this file", "quarterly-report-final-v3.pdf");
      await snap(page, "42-prompt-initial-focus", dialog);
      await page.keyboard.press("Tab");
      await settle(page, 250);
      await snap(page, "43-prompt-tabbed-focus", dialog);
      captured += 2;
    });

    // ---- 5. Accessibility media. Both blocks exist separately in index.css on
    //         purpose (macOS fires prefers-contrast, Windows swaps system colors),
    //         so both are captured rather than assumed equivalent. ----
    await step("contrast-more", async () => {
      await page.emulateMedia({ contrast: "more" });
      await raise("confirm", "Delete this item?");
      await snap(page, "50-confirm-contrast-more", dialog);
      captured += 1;
    });
    await page.emulateMedia({ contrast: "no-preference" }).catch(() => {});

    await step("forced-colors", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await raise("prompt", "Rename this file", "quarterly-report-final-v3.pdf");
      await snap(page, "51-prompt-forced-colors", dialog);
      captured += 1;
    });
    await page.emulateMedia({ forcedColors: "none" }).catch(() => {});
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }

  // Count what actually landed on disk rather than trusting the step bookkeeping —
  // a screenshot call that resolves without writing would otherwise report success.
  const written = readdirSync(OUTPUT_DIR).filter(
    (f) => f.endsWith(`${TAG}.png`) || (!TAG && f.endsWith(".png"))
  ).length;
  console.log(`[webview-shots] ${written} PNG(s) in ${OUTPUT_DIR} (expected ${captured})`);

  if (failures.length > 0) {
    throw new Error(`[webview-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written < captured) {
    throw new Error(`[webview-shots] expected ${captured} PNG(s), found ${written}`);
  }
});
