/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ensureLatin400Preload } from "@/lib/fontPreload";

const FONT_HREF =
  "/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2";

describe("ensureLatin400Preload", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("inserts a preload link with crossorigin=anonymous so it dedupes with @font-face CORS fetch", () => {
    ensureLatin400Preload(FONT_HREF);

    const link = document.head.querySelector(
      'link[rel="preload"][href*="jetbrains-mono-latin-400-normal.woff2"]'
    ) as HTMLLinkElement | null;
    expect(link).not.toBeNull();
    expect(link?.rel).toBe("preload");
    expect(link?.as).toBe("font");
    expect(link?.type).toBe("font/woff2");
    // Both the property and the serialized attribute — they can drift if a
    // future refactor uses setAttribute() with the wrong keyword.
    expect(link?.crossOrigin).toBe("anonymous");
    expect(link?.getAttribute("crossorigin")).toBe("anonymous");
    // jsdom resolves the relative href against `http://localhost:3000`; assert
    // the suffix rather than the full URL so the test mirrors the production
    // `app://` resolution behavior.
    expect(link?.href).toMatch(/jetbrains-mono-latin-400-normal\.woff2$/);
  });

  it("is idempotent — second call does not append a duplicate link", () => {
    ensureLatin400Preload(FONT_HREF);
    ensureLatin400Preload(FONT_HREF);

    const links = document.head.querySelectorAll(
      'link[rel="preload"][href*="jetbrains-mono-latin-400-normal.woff2"]'
    );
    expect(links).toHaveLength(1);
  });

  it("does not set crossOrigin on the link after a second call reuses the first", () => {
    // Regression guard: if a future change replaces the `return` short-circuit
    // with an "update existing" path that forgets crossOrigin, the second call
    // would silently strip the attribute and re-introduce the bug.
    ensureLatin400Preload(FONT_HREF);
    ensureLatin400Preload(FONT_HREF);

    const link = document.head.querySelector(
      'link[rel="preload"][href*="jetbrains-mono-latin-400-normal.woff2"]'
    ) as HTMLLinkElement | null;
    expect(link?.crossOrigin).toBe("anonymous");
  });

  it("does not upgrade an existing preload link that is missing crossorigin (regression guard)", () => {
    // Pre-seed a stale preload link without crossorigin. The helper must
    // NOT silently patch it — its contract is "skip if a preload link
    // already exists", not "ensure the preload has crossorigin". A future
    // "helpfully patch" refactor would either re-introduce the dedupe bug
    // (if it strips) or duplicate the link (if it appends a new one).
    const stale = document.createElement("link");
    stale.rel = "preload";
    stale.as = "font";
    stale.type = "font/woff2";
    stale.href = FONT_HREF;
    document.head.appendChild(stale);

    ensureLatin400Preload(FONT_HREF);

    const links = document.head.querySelectorAll(
      'link[rel="preload"][href*="jetbrains-mono-latin-400-normal.woff2"]'
    );
    expect(links).toHaveLength(1);
    if (!(links[0] instanceof HTMLLinkElement)) {
      throw new Error("expected HTMLLinkElement");
    }
    // jsdom returns null for an unset crossOrigin (browsers may return ""),
    // so accept either. The contract is "we didn't touch it", not a
    // specific sentinel.
    expect(links[0].crossOrigin ?? "").toBe("");
  });
});
