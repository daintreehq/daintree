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

  test("Latin 400 woff2 is requested at most once on cold boot (preload dedupes with @font-face)", async () => {
    // Launch a separate Electron instance so the test sees a true cold boot
    // in the BrowserContext — any prior test in this file would otherwise
    // warm the memory cache and mask a duplicate request.
    const freshCtx = await launchApp();
    try {
      // Attach the request listener at the BrowserContext level BEFORE the
      // page re-evaluates `main.tsx`. Page-level listeners (added in the first
      // revision of this test) attached after `launchApp()` returned, so the
      // preload request had already fired and resolved before the listener
      // was bound. The BrowserContext catches requests from every page in
      // the context, including pages mid-navigation.
      const requests: string[] = [];
      freshCtx.app.context().on("request", (req) => {
        if (/jetbrains-mono-latin-400.*\.woff2/.test(req.url())) {
          requests.push(req.url());
        }
      });

      // Reload to force a fresh cold-boot path. The first page load (which
      // happened during `launchApp()`) may have already populated the memory
      // cache, so the reload gives us a deterministic, no-cache fetch
      // sequence we can assert against.
      await freshCtx.window.reload();
      await freshCtx.window.waitForLoadState("domcontentloaded");

      // Wait until the @font-face / preload request has actually been captured.
      // Polling here prevents both a fast-machine vacuous-pass (assertion fires
      // before the network request is recorded) and a slow-CI false-negative
      // (sleep expires before the request arrives).
      await expect.poll(() => requests.length, { timeout: T_LONG }).toBeGreaterThanOrEqual(1);

      // Brief settle to let any duplicate request arrive before the upper-bound
      // check. T_SETTLE is short enough not to introduce meaningful latency but
      // long enough to catch a regression where two fetches fire in quick succession.
      await freshCtx.window.waitForTimeout(T_SETTLE);

      // Contract: exactly 1 request. The preload should have deduped with the
      // @font-face fetch. 2+ means the bug regressed and we are double-fetching.
      expect(
        requests.length,
        `expected exactly 1 request for the Latin 400 woff2; got ${requests.length} (${requests.join(", ")})`
      ).toBeLessThanOrEqual(1);
    } finally {
      await closeApp(freshCtx.app);
    }
  });
});
