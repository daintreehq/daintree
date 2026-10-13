import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAppTheme } from "../../../shared/theme/index.js";

const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string): unknown => {
    if (key === "appState") return { sidebarWidth: 350, focusMode: false };
    if (key === "appTheme") return { colorSchemeId: "daintree" };
    return undefined;
  }),
  set: vi.fn(),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

const nativeThemeMock = vi.hoisted(() => ({ shouldUseDarkColors: true }));

vi.mock("electron", () => ({
  nativeTheme: nativeThemeMock,
}));

import {
  buildSkeletonCss,
  injectSkeletonCss,
  injectSkeletonProjectIdentity,
  resolveInitialCanvasBackgroundColor,
  resolveInitialColorSchemeId,
  INITIAL_COLOR_SCHEME_ARG,
  resolveInstanceRole,
  INSTANCE_ROLE_ARG,
  resolveE2EPreloadArgs,
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

describe("buildSkeletonCss instantReveal (entrance bypass for project switches)", () => {
  beforeEach(() => {
    storeMock.get.mockReset();
    storeMock.get.mockImplementation((key: string) => {
      if (key === "appState") return { sidebarWidth: 350, focusMode: false };
      if (key === "appTheme") return { colorSchemeId: "daintree" };
      return undefined;
    });
  });

  it("removes the skeleton entrance only when instantReveal is set", () => {
    const gated = buildSkeletonCss(undefined, undefined);
    const instant = buildSkeletonCss(undefined, undefined, { instantReveal: true });
    // The override must be opt-in: the initial-launch path keeps its entrance.
    expect(gated).not.toContain("animation-name");
    expect(instant).toContain("#startup-skeleton { animation-name: none !important; }");
  });

  it("pins the staggered sections and the identified title opaque (#12394)", () => {
    const instant = buildSkeletonCss(undefined, undefined, { instantReveal: true });
    // Both rest at opacity:0 in index.html and only reach 1 through their
    // reveal animation, so dropping the animation alone would hide them.
    const rule = instant
      .split("\n")
      .find((line) => line.includes(".skel-reveal") && line.includes("opacity"));
    expect(rule).toBeDefined();
    expect(rule).toContain("#startup-skeleton .skel-reveal");
    expect(rule).toContain("#startup-skeleton .skeleton-title.skeleton-title--identified");
    expect(rule).toContain("animation-name: none !important;");
    expect(rule).toContain("opacity: 1 !important;");
  });

  it("never touches the animation shorthand or the container's opacity", () => {
    const instant = buildSkeletonCss(undefined, undefined, { instantReveal: true });
    // The `animation` shorthand would fight the reduced-motion `animation: none`
    // rules, and pinning the container's opacity would defeat `.fade-out`.
    // Property position only, so `--theme-*` token names can't match.
    expect(instant).not.toMatch(/(^|[\s;{])animation\s*:/);
    expect(instant).not.toMatch(/#startup-skeleton\s*\{[^}]*[\s;{]opacity\s*:/);
  });

  it("threads instantReveal through injectSkeletonCss to the inserted stylesheet", () => {
    const wc = makeWc();
    void injectSkeletonCss(wc as never, null, { instantReveal: true });
    const css = wc.insertCSS.mock.calls[0]?.[0] as string;
    expect(css).toContain("animation-name: none !important;");
  });

  it("resolves once the stylesheet is inserted, and swallows an insert failure", async () => {
    let finishInsert: () => void = () => {};
    const wc = makeWc();
    wc.insertCSS.mockImplementation(
      () => new Promise<string>((resolve) => (finishInsert = () => resolve("")))
    );
    let applied = false;
    const pending = injectSkeletonCss(wc as never, null, { instantReveal: true }).then(() => {
      applied = true;
    });
    await Promise.resolve();
    expect(applied).toBe(false);
    finishInsert();
    await pending;
    expect(applied).toBe(true);

    const failing = makeWc();
    failing.insertCSS.mockImplementation(() => Promise.reject(new Error("navigated")));
    await expect(injectSkeletonCss(failing as never)).resolves.toBeUndefined();
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

/**
 * Tests resolveInitialColorSchemeId — the helper that seeds the renderer's
 * first-paint theme via webPreferences.additionalArguments (#9169). It must
 * mirror createWindow/getAppThemeConfig fallback behavior.
 */
describe("resolveInitialColorSchemeId (#9169)", () => {
  const originalScreenshotScale = process.env.DAINTREE_SCREENSHOT_SCALE;

  beforeEach(() => {
    storeMock.get.mockReset();
    nativeThemeMock.shouldUseDarkColors = true;
    delete process.env.DAINTREE_SCREENSHOT_SCALE;
  });

  afterEach(() => {
    if (originalScreenshotScale === undefined) {
      delete process.env.DAINTREE_SCREENSHOT_SCALE;
    } else {
      process.env.DAINTREE_SCREENSHOT_SCALE = originalScreenshotScale;
    }
  });

  it("returns the persisted color scheme id, trimmed", () => {
    storeMock.get.mockReturnValue({ colorSchemeId: "  bondi  " });
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("falls back to daintree when no theme is persisted and the OS prefers dark", () => {
    storeMock.get.mockReturnValue(undefined);
    nativeThemeMock.shouldUseDarkColors = true;
    expect(resolveInitialColorSchemeId()).toBe("daintree");
  });

  it("falls back to bondi when no theme is persisted and the OS prefers light", () => {
    storeMock.get.mockReturnValue(undefined);
    nativeThemeMock.shouldUseDarkColors = false;
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("falls back when colorSchemeId is not a string", () => {
    storeMock.get.mockReturnValue({ colorSchemeId: 123 });
    nativeThemeMock.shouldUseDarkColors = false;
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("falls back when colorSchemeId is whitespace only", () => {
    storeMock.get.mockReturnValue({ colorSchemeId: "   " });
    nativeThemeMock.shouldUseDarkColors = false;
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("forces daintree when DAINTREE_SCREENSHOT_SCALE is set, even on a light OS", () => {
    storeMock.get.mockReturnValue(undefined);
    nativeThemeMock.shouldUseDarkColors = false;
    process.env.DAINTREE_SCREENSHOT_SCALE = "2";
    expect(resolveInitialColorSchemeId()).toBe("daintree");
  });

  it("matches the prefix preload.cts parses (drift guard)", () => {
    // preload.cts hardcodes this literal rather than importing the constant
    // (esbuild cross-bundle); this ties both halves of the contract together so
    // a rename of INITIAL_COLOR_SCHEME_ARG fails loudly instead of silently
    // reintroducing the flash (#9169).
    expect(`${INITIAL_COLOR_SCHEME_ARG}=`).toBe("--daintree-initial-color-scheme-id=");
  });
});

/**
 * Tests resolveInstanceRole — the helper that seeds each renderer with the
 * worker/attended instance role via webPreferences.additionalArguments
 * (#10123). Worker instances suppress automatic background GitHub polling;
 * the default must always be attended.
 */
describe("resolveInstanceRole (#10123)", () => {
  const originalRole = process.env.DAINTREE_INSTANCE_ROLE;

  beforeEach(() => {
    delete process.env.DAINTREE_INSTANCE_ROLE;
  });

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.DAINTREE_INSTANCE_ROLE;
    } else {
      process.env.DAINTREE_INSTANCE_ROLE = originalRole;
    }
  });

  it("defaults to attended when the env var is unset", () => {
    expect(resolveInstanceRole()).toBe("attended");
  });

  it("returns worker only for the exact value 'worker'", () => {
    process.env.DAINTREE_INSTANCE_ROLE = "worker";
    expect(resolveInstanceRole()).toBe("worker");
  });

  it("normalizes malformed values to attended", () => {
    for (const value of ["Worker", "WORKER", " worker", "worker ", "1", "true", ""]) {
      process.env.DAINTREE_INSTANCE_ROLE = value;
      expect(resolveInstanceRole()).toBe("attended");
    }
  });

  it("matches the prefix preload.cts parses (drift guard)", () => {
    // preload.cts hardcodes this literal rather than importing the constant
    // (esbuild cross-bundle); this ties both halves of the contract together
    // so a rename of INSTANCE_ROLE_ARG fails loudly instead of silently
    // leaving every instance in attended mode (#10123).
    expect(`${INSTANCE_ROLE_ARG}=`).toBe("--daintree-instance-role=");
  });
});

describe("resolveE2EPreloadArgs", () => {
  const originalMode = process.env.DAINTREE_E2E_MODE;
  const originalSkip = process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS;
  const originalFault = process.env.DAINTREE_E2E_FAULT_MODE;
  const originalArgv = process.argv;

  beforeEach(() => {
    delete process.env.DAINTREE_E2E_MODE;
    delete process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS;
    delete process.env.DAINTREE_E2E_FAULT_MODE;
    process.argv = originalArgv.slice(0, 2);
  });

  afterEach(() => {
    restoreEnv("DAINTREE_E2E_MODE", originalMode);
    restoreEnv("DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS", originalSkip);
    restoreEnv("DAINTREE_E2E_FAULT_MODE", originalFault);
    process.argv = originalArgv;
  });

  it("omits all flags outside E2E", () => {
    expect(resolveE2EPreloadArgs()).toEqual([]);
  });

  it("threads exact E2E env flags into argv-safe preload switches", () => {
    process.env.DAINTREE_E2E_MODE = "1";
    process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS = "1";
    process.env.DAINTREE_E2E_FAULT_MODE = "1";

    expect(resolveE2EPreloadArgs()).toEqual([
      "--daintree-e2e-mode",
      "--daintree-e2e-skip-first-run-dialogs",
      "--daintree-e2e-fault-mode",
    ]);
  });

  it("preserves E2E argv switches when production build strips env reads", () => {
    process.argv.push(
      "--daintree-e2e-mode",
      "--daintree-e2e-skip-first-run-dialogs",
      "--daintree-e2e-fault-mode"
    );

    expect(resolveE2EPreloadArgs()).toEqual([
      "--daintree-e2e-mode",
      "--daintree-e2e-skip-first-run-dialogs",
      "--daintree-e2e-fault-mode",
    ]);
  });

  it("rejects truthy-but-not-exact env values", () => {
    process.env.DAINTREE_E2E_MODE = "true";
    process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS = "yes";
    process.env.DAINTREE_E2E_FAULT_MODE = "on";

    expect(resolveE2EPreloadArgs()).toEqual([]);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
