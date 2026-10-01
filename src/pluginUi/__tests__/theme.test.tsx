// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES, getAppThemeCssVariables } from "@shared/theme";
import {
  getDaintreeTheme,
  onDidChangeDaintreeTheme,
  useDaintreeTheme,
  type DaintreeTheme,
} from "@daintreehq/plugin-ui";
import { THEME_TOKEN_KEYS } from "../theme";

function applyTheme(id: string, mode: "dark" | "light", accent: string) {
  const root = document.documentElement;
  root.dataset.theme = id;
  root.dataset.colorMode = mode;
  root.style.setProperty("--theme-accent-primary", accent);
  root.style.setProperty("--theme-surface-canvas", mode === "dark" ? "#1a1918" : "#fafafa");
  root.style.setProperty("--theme-border-subtle", "rgba(255, 255, 255, 0.08)");
}

// A tick for the MutationObserver's microtask delivery.
const flush = () => act(async () => {});

beforeEach(() => {
  applyTheme("daintree", "dark", "#36CE94");
});

afterEach(() => {
  cleanup();
  const root = document.documentElement;
  root.removeAttribute("style");
  delete root.dataset.theme;
  delete root.dataset.colorMode;
});

describe("getDaintreeTheme", () => {
  it("reports the mode, id and tokens the host applied to the root", () => {
    const theme = getDaintreeTheme();
    expect(theme.colorMode).toBe("dark");
    expect(theme.themeId).toBe("daintree");
    expect(theme.tokens["accent-primary"]).toBe("#36ce94");
    expect(theme.tokens["surface-canvas"]).toBe("#1a1918");
    expect(theme.tokens["border-subtle"]).toBe("rgba(255, 255, 255, 0.08)");
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.tokens)).toBe(true);
  });

  it("returns the same object until the theme changes", () => {
    const first = getDaintreeTheme();
    expect(getDaintreeTheme()).toBe(first);
    applyTheme("bondi", "light", "#0a7cff");
    const next = getDaintreeTheme();
    expect(next).not.toBe(first);
    expect(next.colorMode).toBe("light");
    expect(next.tokens["accent-primary"]).toBe("#0a7cff");
  });

  it("covers every token every built-in theme defines", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const variables = getAppThemeCssVariables(scheme);
      const missing = THEME_TOKEN_KEYS.filter((key) => !variables[`--theme-${key}`]);
      expect(missing, scheme.id).toEqual([]);
    }
  });
});

describe("onDidChangeDaintreeTheme", () => {
  it("notifies after a theme change, not after unrelated root writes, until disposed", async () => {
    const listener = vi.fn<(theme: DaintreeTheme) => void>();
    const dispose = onDidChangeDaintreeTheme(listener);

    document.documentElement.style.setProperty("--scrollbar-gutter", "8px");
    await flush();
    expect(listener).not.toHaveBeenCalled();

    applyTheme("bondi", "light", "#0a7cff");
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].themeId).toBe("bondi");

    dispose();
    dispose();
    applyTheme("daintree", "dark", "#36CE94");
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still notifies when something read the new theme before the observer ran", async () => {
    const listener = vi.fn<(theme: DaintreeTheme) => void>();
    const dispose = onDidChangeDaintreeTheme(listener);
    applyTheme("bondi", "light", "#0a7cff");
    expect(getDaintreeTheme().themeId).toBe("bondi");
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("keeps a second registration of the same function when the first is disposed", async () => {
    const listener = vi.fn<(theme: DaintreeTheme) => void>();
    const first = onDidChangeDaintreeTheme(listener);
    const second = onDidChangeDaintreeTheme(listener);
    first();
    applyTheme("bondi", "light", "#0a7cff");
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    second();
  });

  it("keeps notifying other listeners when one throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = vi.fn();
    const disposeBad = onDidChangeDaintreeTheme(() => {
      throw new Error("plugin bug");
    });
    const disposeGood = onDidChangeDaintreeTheme(good);
    applyTheme("bondi", "light", "#0a7cff");
    await flush();
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    disposeBad();
    disposeGood();
    warn.mockRestore();
  });

  it("ignores a non-function listener", () => {
    const dispose: unknown = Reflect.apply(onDidChangeDaintreeTheme, undefined, ["nope"]);
    expect(typeof dispose).toBe("function");
  });
});

describe("useDaintreeTheme", () => {
  it("re-renders with the new theme", async () => {
    const seen: string[] = [];
    function Probe() {
      const theme = useDaintreeTheme();
      seen.push(`${theme.colorMode}:${theme.tokens["accent-primary"]}`);
      return null;
    }
    render(createElement(Probe));
    expect(seen.at(-1)).toBe("dark:#36ce94");
    applyTheme("bondi", "light", "#0a7cff");
    await flush();
    expect(seen.at(-1)).toBe("light:#0a7cff");
  });
});
