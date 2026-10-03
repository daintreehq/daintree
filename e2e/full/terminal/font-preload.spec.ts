import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";

// Regression: issue #10072. The cold-boot Latin-400 font preload was emitted
// without `crossorigin="anonymous"`, so the no-cors preload never deduped with
// the CORS-anonymous `@font-face` fetch in `index.css`. The woff2 downloaded
// twice and `font-display: optional`'s 100 ms block expired, forcing the
// session into the system monospace fallback.
//
// The fix sets `link.crossOrigin = "anonymous"` in `src/lib/fontPreload.ts`.
// This spec verifies the runtime side in the real WebContentsView (the only
// place the `app://` scheme with `corsEnabled: true` is registered):
//   (1) the link element carries `crossorigin="anonymous"` and points at the
//       same hashed asset the CSS @font-face references (URL parity);
//   (2) the woff2 is requested at most once on cold boot, proving the preload
//       satisfies the @font-face request instead of triggering a duplicate.
let ctx: AppContext;

test.describe.serial("Core: Font Preload Dedupe (#10072)", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("Latin 400 woff2 is requested at most once on cold boot (preload dedupes with @font-face)", async () => {
    // Runs first on the shared launch, before anything else in this file has
    // touched the renderer. The listener sits on the BrowserContext so it sees
    // requests from the page mid-navigation; a page-level listener bound after
    // boot misses the preload entirely.
    const { app, window } = ctx;
    const requests: string[] = [];
    app.context().on("request", (req) => {
      if (/jetbrains-mono-latin-400.*\.woff2/.test(req.url())) {
        requests.push(req.url());
      }
    });

    // The boot load may already have populated the memory cache, so the
    // reload gives a deterministic, no-cache fetch sequence to assert against.
    await window.reload();
    await window.waitForLoadState("domcontentloaded");

    await expect.poll(() => requests.length, { timeout: T_LONG }).toBeGreaterThanOrEqual(1);

    // A duplicate fetch has nothing to poll for; the second @font-face request
    // fires in the same style recalc as the first, well inside this window.
    // timer: negative-assertion dwell for a duplicate font request
    await window.waitForTimeout(T_SETTLE);

    // Contract: exactly 1 request. 2+ means the preload no longer dedupes with
    // the @font-face fetch and the woff2 is double-fetched.
    expect(
      requests.length,
      `expected exactly 1 request for the Latin 400 woff2; got ${requests.length} (${requests.join(", ")})`
    ).toBeLessThanOrEqual(1);
  });

  test("preload link carries crossorigin=anonymous for the Latin 400 woff2", async () => {
    const { window } = ctx;

    // Module-eval in `main.tsx` runs before `bootstrap()`; the preload link
    // should be in the document by the time the app window is responsive.
    const link = window.locator(
      'link[rel="preload"][as="font"][type="font/woff2"][crossorigin="anonymous"][href*="jetbrains-mono-latin-400"]'
    );
    await expect(link).toHaveCount(1, { timeout: T_LONG });

    // Verify the preload href points at the same hashed asset the CSS
    // @font-face references. If these ever drift (Vite hash, asset rename,
    // path resolution), dedupe silently fails — this is the only assertion
    // that catches that class of regression.
    const parity = await window.evaluate(() => {
      const linkEl = document.querySelector<HTMLLinkElement>(
        'link[rel="preload"][as="font"][crossorigin="anonymous"]'
      );
      const preloadUrl = linkEl
        ? new URL(linkEl.getAttribute("href") ?? "", document.baseURI).href
        : null;
      let cssUrl: string | null = null;
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSFontFaceRule) {
              const src = rule.style.getPropertyValue("src");
              const m = src.match(/url\((['"]?)([^'")]+)\1\)/);
              if (m && m[2].includes("jetbrains-mono-latin-400")) {
                cssUrl = new URL(m[2], sheet.href ?? document.baseURI).href;
                break;
              }
            }
          }
        } catch {
          // Cross-origin sheets throw on cssRules access; skip them.
        }
        if (cssUrl) break;
      }
      return { preloadUrl, cssUrl };
    });
    expect(parity.preloadUrl, "preload href resolves to a URL").toBeTruthy();
    expect(
      parity.cssUrl,
      "No @font-face rule found for jetbrains-mono-latin-400 — sheet may be cross-origin or asset path changed"
    ).toBeTruthy();
    expect(parity.preloadUrl).toBe(parity.cssUrl);
  });
});
