import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAppTheme } from "../../../shared/theme/index.js";

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

import {
  buildSkeletonCss,
  injectSkeletonCss,
  injectSkeletonProjectIdentity,
  resolveInitialCanvasBackgroundColor,
} from "../skeletonCss.js";

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

describe("resolveInitialCanvasBackgroundColor (#9573)", () => {
  beforeEach(() => {
    storeMock.get.mockClear();
  });

  it("returns the surface-canvas token for the default dark scheme", () => {
    storeMock.get.mockImplementation((key: string) => {
      if (key === "appTheme") return { colorSchemeId: "daintree" };
      return undefined;
    });
    const color = resolveInitialCanvasBackgroundColor();
    expect(color).toBe(resolveAppTheme("daintree", []).tokens["surface-canvas"]);
  });

  it("returns the surface-canvas token for the light Bondi scheme", () => {
    storeMock.get.mockImplementation((key: string) => {
      if (key === "appTheme") return { colorSchemeId: "bondi" };
      return undefined;
    });
    const color = resolveInitialCanvasBackgroundColor();
    expect(color).toBe(resolveAppTheme("bondi", []).tokens["surface-canvas"]);
  });

  it("falls back to the OS-default scheme surface-canvas when appTheme is missing", () => {
    storeMock.get.mockImplementation(() => undefined);
    const color = resolveInitialCanvasBackgroundColor();
    // shouldUseDarkColors is true in this test environment → defaults to "daintree"
    expect(color).toBe(resolveAppTheme("daintree", []).tokens["surface-canvas"]);
  });
});

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

describe("injectSkeletonCss var scoping (#9716)", () => {
  beforeEach(() => {
    // Reset to a deterministic default each test so the Bondi override below
    // can't leak its implementation into adjacent tests.
    storeMock.get.mockReset();
    storeMock.get.mockImplementation((key: string) => {
      if (key === "appState") return { sidebarWidth: 350, focusMode: false };
      if (key === "appTheme") return { colorSchemeId: "daintree" };
      return undefined;
    });
  });

  it("scopes seeded theme vars to #startup-skeleton, never :root", () => {
    const wc = makeWc();
    injectSkeletonCss(wc as never);
    const css = wc.insertCSS.mock.calls[0]?.[0] as string;
    // A :root-scoped block would persist (user-origin insertCSS is never
    // removed) and leak removed optional tokens after a theme switch.
    expect(css).toContain("#startup-skeleton {");
    expect(css).not.toMatch(/(^|\s):root\s*\{/);
  });

  it("emits the light theme's optional sidebar-card-bg extension under #startup-skeleton, not :root", () => {
    // Bondi is a light theme that defines the `sidebar-card-bg` extension and
    // dark themes do not. Before the fix this class of token was injected at
    // `:root` and survived a light→dark switch because the dark theme removes
    // the inline override, leaving the stale skeleton value to win the cascade.
    storeMock.get.mockImplementation((key: string) => {
      if (key === "appState") return { sidebarWidth: 350, focusMode: false };
      if (key === "appTheme") return { colorSchemeId: "bondi" };
      return undefined;
    });
    const wc = makeWc();
    injectSkeletonCss(wc as never);
    const css = wc.insertCSS.mock.calls[0]?.[0] as string;
    // The extension token is still emitted (so the splash paints correctly)...
    expect(css).toContain("--sidebar-card-bg:");
    // ...but the only selector wrapping it is the scoped one.
    const selectors = css.match(/[^\s][^{]*\{/g) ?? [];
    expect(selectors.some((s) => s.trim().startsWith("#startup-skeleton"))).toBe(true);
    expect(selectors.some((s) => s.trim().startsWith(":root"))).toBe(false);
  });
});

describe("buildSkeletonCss pre-read theme config (#10393)", () => {
  beforeEach(() => {
    storeMock.get.mockReset();
    storeMock.get.mockImplementation((key: string) => {
      if (key === "appState") return { sidebarWidth: 350, focusMode: false };
      if (key === "appTheme") return { colorSchemeId: "daintree" };
      return undefined;
    });
  });

  it("uses the passed config instead of re-reading appTheme from the store", () => {
    const css = buildSkeletonCss(undefined, { colorSchemeId: "bondi" });
    // The store still says "daintree" — the bondi token proves the pre-read
    // config won, and the call log proves the disk read was skipped.
    expect(css).toContain(
      `--theme-surface-canvas: ${resolveAppTheme("bondi", []).tokens["surface-canvas"]};`
    );
    expect(storeMock.get).not.toHaveBeenCalledWith("appTheme");
  });

  it("falls back to the store read when no config is passed", () => {
    const css = buildSkeletonCss();
    expect(css).toContain(
      `--theme-surface-canvas: ${resolveAppTheme("daintree", []).tokens["surface-canvas"]};`
    );
    expect(storeMock.get).toHaveBeenCalledWith("appTheme");
  });
});

describe("buildSkeletonCss instantReveal (Doherty bypass for project switches)", () => {
  beforeEach(() => {
    storeMock.get.mockReset();
    storeMock.get.mockImplementation((key: string) => {
      if (key === "appState") return { sidebarWidth: 350, focusMode: false };
      if (key === "appTheme") return { colorSchemeId: "daintree" };
      return undefined;
    });
  });

  it("drops the Doherty entry delay only when instantReveal is set", () => {
    const gated = buildSkeletonCss(undefined, undefined);
    const instant = buildSkeletonCss(undefined, undefined, { instantReveal: true });
    // The override must be opt-in: the initial-launch path keeps the 400ms gate.
    expect(gated).not.toContain("animation-delay");
    expect(instant).toContain("#startup-skeleton { animation-delay: 0ms !important; }");
  });

  it("overrides only the delay longhand so reduced-motion's `animation: none` survives", () => {
    const instant = buildSkeletonCss(undefined, undefined, { instantReveal: true });
    // Touching the `animation` shorthand would restore an animation-name that
    // the reduced-motion media query set to none — the override must not do that.
    expect(instant).not.toMatch(/#startup-skeleton\s*\{\s*animation:/);
  });

  it("threads instantReveal through injectSkeletonCss to the inserted stylesheet", () => {
    const wc = makeWc();
    injectSkeletonCss(wc as never, null, { instantReveal: true });
    const css = wc.insertCSS.mock.calls[0]?.[0] as string;
    expect(css).toContain("animation-delay: 0ms !important;");
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

  it("the generated script mutates the real skeleton DOM correctly", async () => {
    const { JSDOM } = await import("jsdom");
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
