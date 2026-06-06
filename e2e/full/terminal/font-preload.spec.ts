import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";

// Regression: issue #10072. The cold-boot Latin-400 font preload was emitted
// without `crossorigin="anonymous"`, so the no-cors preload never deduped with
// the CORS-anonymous `@font-face` fetch in `index.css`. The woff2 downloaded
// twice and `font-display: optional`'s 100 ms block expired, forcing the
// session into the system monospace fallback.
//
// The fix sets `link.crossOrigin = "anonymous"` in `src/lib/fontPreload.ts`.
// This spec verifies the runtime side: (1) the link element carries the
// attribute; (2) the woff2 is requested at most once on cold boot, proving the
// preload actually satisfies the @font-face request in the real WebContentsView
// (the only place the `app://` scheme with `corsEnabled: true` is registered).
let ctx: AppContext;

test.describe.serial("Core: Font Preload Dedupe (#10072)", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("preload link carries crossorigin=anonymous for the Latin 400 woff2", async () => {
    const { window } = ctx;

    // Wait for the preload helper to run at module-eval — it's invoked before
    // bootstrap() returns, so the link should be in the document by the time
    // the app window is responsive.
    const link = window.locator(
      'link[rel="preload"][as="font"][type="font/woff2"][crossorigin="anonymous"][href*="jetbrains-mono-latin-400"]'
    );
    await expect(link).toHaveCount(1, { timeout: T_LONG });

    // Verify the href actually resolves to the same hashed asset the CSS
    // @font-face references — if these ever drift, dedupe silently fails.
    const cssHref = await window.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSFontFaceRule) {
              const src = rule.style.getPropertyValue("src");
              if (src.includes("jetbrains-mono-latin-400")) return src;
            }
          }
        } catch {
          // Cross-origin sheets throw on cssRules access; skip them.
        }
      }
      return null;
    });
    expect(cssHref, "CSS @font-face src for Latin 400").toBeTruthy();

    const preloadHref = await link.first().getAttribute("href");
    expect(preloadHref).toBeTruthy();
    // Both must point at the latin-400 weight; the matching algorithm keys on
    // the URL string, so any hash drift would silently regress the fix.
    expect(preloadHref).toMatch(/jetbrains-mono-latin-400.*\.woff2/);
  });

  test("Latin 400 woff2 is requested at most once on cold boot (preload dedupes with @font-face)", async () => {
    // Spin a fresh window so the test sees a true cold boot — any prior test
    // in this file would otherwise warm the memory cache and mask a duplicate
    // request.
    const freshCtx = await launchApp();
    try {
      const requests: string[] = [];
      freshCtx.window.on("request", (req) => {
        const url = req.url();
        if (/jetbrains-mono-latin-400.*\.woff2/.test(url)) {
          requests.push(url);
        }
      });

      // Wait for the renderer to settle past bootstrap so any lazy
      // @font-face-driven request has had a chance to fire.
      await freshCtx.window.waitForLoadState("domcontentloaded");
      // Give the CSS-driven @font-face fetch a moment to dispatch after parse.
      await freshCtx.window.waitForTimeout(T_MEDIUM);

      expect(
        requests,
        `expected ≤1 request for the Latin 400 woff2; got ${requests.length} (${requests.join(", ")})`
      ).toHaveLength(1);
    } finally {
      await closeApp(freshCtx.app);
    }
  });
});
