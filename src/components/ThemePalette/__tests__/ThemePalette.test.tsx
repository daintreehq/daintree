// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { flushPendingTheme, useAppThemeStore } from "@/store/appThemeStore";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ThemePalette } from "../ThemePalette";

const COMMITTED = BUILT_IN_APP_SCHEMES.find((s) => s.type === "light")!;

function renderOpen() {
  return render(<ThemePalette isOpen onClose={() => {}} />);
}

/** Theme rows, without the inert band heads that share the option role. */
function rows() {
  return screen.getAllByRole("option").filter((o) => o.getAttribute("aria-disabled") !== "true");
}

function input() {
  return screen.getByRole("combobox");
}

describe("ThemePalette", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useAppThemeStore.setState({ selectedSchemeId: COMMITTED.id, customSchemes: [] });
  });
  afterEach(() => cleanup());

  it("marks the saved theme with aria-current and a check, apart from the cursor", async () => {
    renderOpen();
    await act(async () => {});
    const current = rows().filter((o) => o.getAttribute("aria-current"));
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(`theme-option-${COMMITTED.id}`);
    expect(current[0]!.querySelector("svg")).not.toBeNull();
    expect(current[0]!.textContent).toContain("Current theme");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    await act(async () => {});
    const cursor = rows().find((o) => o.getAttribute("aria-selected") === "true")!;
    expect(cursor.id).not.toBe(current[0]!.id);
    expect(cursor.getAttribute("aria-current")).toBeNull();
  });

  it("spends no status colour on the saved theme", async () => {
    const { container } = renderOpen();
    await act(async () => {});
    const html = document.body.innerHTML + container.innerHTML;
    expect(html).not.toMatch(/state-active|accent-primary\)?\/|status-success/);
  });

  it("says light or dark once per band, not on every row", async () => {
    renderOpen();
    await act(async () => {});
    const heads = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-disabled") === "true");
    expect(heads.map((h) => h.getAttribute("aria-label"))).toEqual(["Dark", "Light"]);
    expect(within(screen.getByRole("listbox")).queryAllByRole("group")).toHaveLength(0);
    for (const option of rows()) {
      const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        expect(n.textContent?.trim()).not.toMatch(/^(light|dark)$/i);
      }
    }
  });

  it("reaches both ends of the list with Home and End", async () => {
    renderOpen();
    await act(async () => {});
    const options = rows();
    fireEvent.keyDown(input(), { key: "End" });
    await act(async () => {});
    expect(input().getAttribute("aria-activedescendant")).toBe(options.at(-1)!.id);
    fireEvent.keyDown(input(), { key: "Home" });
    await act(async () => {});
    expect(input().getAttribute("aria-activedescendant")).toBe(options[0]!.id);
  });

  it("keeps every imported theme reachable by browsing", async () => {
    // Light, so they sort into the last band — past the shell's default cap.
    const customs = Array.from({ length: 10 }, (_, i) => ({
      ...COMMITTED,
      id: `custom-${i}`,
      name: `Custom ${i}`,
      builtin: false,
      location: undefined,
    }));
    useAppThemeStore.setState({ customSchemes: customs });
    renderOpen();
    await act(async () => {});
    const ids = rows().map((o) => o.id);
    for (const c of customs) expect(ids).toContain(`theme-option-${c.id}`);
  });

  it("names the saved theme in the footer once the cursor leaves it", async () => {
    renderOpen();
    await act(async () => {});
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(`to keep ${COMMITTED.name}`);
    expect(dialog.textContent).not.toContain("Current:");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    await act(async () => {});
    expect(dialog.textContent).toContain(`Current: ${COMMITTED.name}`);
  });

  it("goes back to the saved theme when a search hides every row", async () => {
    renderOpen();
    await act(async () => {});
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    await act(async () => {});
    flushPendingTheme();
    expect(document.documentElement.dataset.theme).not.toBe(COMMITTED.id);
    fireEvent.change(input(), { target: { value: "qqxzv" } });
    await act(async () => {});
    flushPendingTheme();
    expect(document.documentElement.dataset.theme).toBe(COMMITTED.id);
  });
});
