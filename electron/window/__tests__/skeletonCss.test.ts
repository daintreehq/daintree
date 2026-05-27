import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => {
    if (key === "appState") return { sidebarWidth: 350, focusMode: false };
    if (key === "appTheme") return { colorSchemeId: "daintree" };
    return undefined;
  }),
  set: vi.fn(),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

vi.mock("electron", () => ({
  nativeTheme: { shouldUseDarkColors: true },
}));

import { injectSkeletonCss, injectSkeletonProjectIdentity } from "../skeletonCss.js";

interface FakeWc {
  insertCSS: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
}

function makeWc(): FakeWc {
  return {
    insertCSS: vi.fn(() => Promise.resolve("")),
    executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
    isDestroyed: vi.fn(() => false),
  };
}

describe("injectSkeletonCss accent override (#9162)", () => {
  beforeEach(() => {
    storeMock.get.mockClear();
  });

  it("paints the project color as the accent token when a color is set", () => {
    const wc = makeWc();
    injectSkeletonCss(wc as never, { color: "#ff0000" });
    const css = wc.insertCSS.mock.calls[0]?.[0] as string;
    expect(css).toContain("--theme-accent-primary: #ff0000");
  });

  it("leaves the theme accent untouched when no project is supplied", () => {
    const wc = makeWc();
    injectSkeletonCss(wc as never);
    const css = wc.insertCSS.mock.calls[0]?.[0] as string;
    expect(css).toContain("--theme-accent-primary:");
    expect(css).not.toContain("--theme-accent-primary: #ff0000");
  });

  it("ignores an invalid color and falls back to the theme accent", () => {
    const wc = makeWc();
    injectSkeletonCss(wc as never, { color: "not-a-hex" });
    const css = wc.insertCSS.mock.calls[0]?.[0] as string;
    expect(css).toContain("--theme-accent-primary:");
    expect(css).not.toContain("not-a-hex");
  });
});

describe("injectSkeletonProjectIdentity (#9162)", () => {
  it("paints emoji and name into the title via executeJavaScript", () => {
    const wc = makeWc();
    injectSkeletonProjectIdentity(wc as never, { name: "My Project", emoji: "🚀" });
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1);
    const script = wc.executeJavaScript.mock.calls[0]?.[0] as string;
    expect(script).toContain("skeleton-title--identified");
    expect(script).toContain("skeleton-logo-section--identified");
    expect(script).toContain(JSON.stringify("🚀  My Project"));
  });

  it("uses the name alone when there is no emoji", () => {
    const wc = makeWc();
    injectSkeletonProjectIdentity(wc as never, { name: "Solo", emoji: "" });
    const script = wc.executeJavaScript.mock.calls[0]?.[0] as string;
    expect(script).toContain(JSON.stringify("Solo"));
  });

  it("escapes names that contain quotes and backslashes", () => {
    const wc = makeWc();
    const hostile = 'a";b\\c</script>';
    injectSkeletonProjectIdentity(wc as never, { name: hostile, emoji: "" });
    const script = wc.executeJavaScript.mock.calls[0]?.[0] as string;
    // The raw payload must be JSON-encoded, never spliced in verbatim.
    expect(script).toContain(JSON.stringify(hostile));
    expect(script).not.toContain('"' + hostile + '"');
  });

  it("does nothing when the project has no resolvable name", () => {
    const wc = makeWc();
    injectSkeletonProjectIdentity(wc as never, { name: "   ", emoji: "🚀" });
    injectSkeletonProjectIdentity(wc as never, null);
    expect(wc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("the generated script mutates the real skeleton DOM correctly", () => {
    const { JSDOM } = require("jsdom") as typeof import("jsdom");
    const dom = new JSDOM(
      `<div id="startup-skeleton"><div class="skeleton-logo-section"><div class="skeleton-title"></div></div></div>`
    );
    const wc = makeWc();
    // U+2028 (line separator) would break a naive string-spliced script but is
    // safe through JSON.stringify — execute the real generated script to prove it.
    const name = "Edge Case";
    injectSkeletonProjectIdentity(wc as never, { name, emoji: "✨" });
    const script = wc.executeJavaScript.mock.calls[0]?.[0] as string;

    // Execute the real generated script with jsdom's document in scope (the
    // script references a free `document`, which we bind as a parameter).
    const run = new Function("document", script) as (d: unknown) => void;
    run(dom.window.document);

    const title = dom.window.document.querySelector("#startup-skeleton .skeleton-title");
    const section = dom.window.document.querySelector("#startup-skeleton .skeleton-logo-section");
    expect(title?.textContent).toBe(`✨  ${name}`);
    expect(title?.classList.contains("skeleton-title--identified")).toBe(true);
    expect(section?.classList.contains("skeleton-logo-section--identified")).toBe(true);
  });
});
