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
    expect(link?.crossOrigin).toBe("anonymous");
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
});
