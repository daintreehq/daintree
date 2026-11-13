// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { flushPendingTheme, injectSchemeToDOM, useAppThemeStore } from "@/store/appThemeStore";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { appThemeClient } from "@/clients/appThemeClient";
import { ThemePalette } from "../ThemePalette";

const COMMITTED = BUILT_IN_APP_SCHEMES.find((s) => s.type === "light")!;

function renderOpen() {
  return render(<ThemePalette isOpen onClose={() => {}} />, { wrapper: TooltipProvider });
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
    // The window shows the saved theme when the palette opens; opening paints nothing.
    injectSchemeToDOM(COMMITTED, { immediate: true });
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

  it("previews the theme under the pointer, and restores the saved one on close", async () => {
    // Theme injection lands on the next frame; flush it before every read.
    const readCanvas = () => {
      flushPendingTheme();
      return document.documentElement.style.getPropertyValue("--theme-surface-canvas").trim();
    };
    const { rerender } = renderOpen();
    await act(async () => {});
    const savedCanvas = readCanvas();

    // The pointer moves the one cursor, and the preview follows the cursor.
    const other = rows().find((o) => o.getAttribute("aria-selected") !== "true")!;
    const otherId = other.id.replace("theme-option-", "");
    const otherScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === otherId)!;
    fireEvent.pointerMove(other);
    await act(async () => {});
    expect(other.getAttribute("aria-selected")).toBe("true");
    expect(readCanvas()).toBe(otherScheme.tokens["surface-canvas"]);

    // Closing without choosing puts the saved theme back.
    rerender(<ThemePalette isOpen={false} onClose={() => {}} />);
    await act(async () => {});
    expect(readCanvas()).toBe(savedCanvas);
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
    expect(dialog.textContent).not.toContain("to go back to");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    await act(async () => {});
    expect(dialog.textContent).toContain(`to go back to ${COMMITTED.name}`);
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

  it("turns Match system off and saves recents when a theme is chosen", async () => {
    vi.clearAllMocks();
    useAppThemeStore.setState({ followSystem: true });
    const onClose = vi.fn();
    render(<ThemePalette isOpen onClose={onClose} />, { wrapper: TooltipProvider });
    await act(async () => {});
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    await act(async () => {});
    const targetId = rows()
      .find((o) => o.getAttribute("aria-selected") === "true")!
      .id.replace("theme-option-", "");
    expect(targetId).not.toBe(COMMITTED.id);
    fireEvent.keyDown(input(), { key: "Enter" });
    await act(async () => {});

    expect(onClose).toHaveBeenCalled();
    expect(useAppThemeStore.getState().followSystem).toBe(false);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(targetId);
    expect(appThemeClient.setFollowSystem).toHaveBeenCalledWith(false);
    expect(appThemeClient.setColorScheme).toHaveBeenCalledWith(targetId);
    expect(appThemeClient.setRecentSchemeIds).toHaveBeenCalledWith(
      expect.arrayContaining([targetId])
    );
  });

  it("opens on the saved theme after a search was left up at the last close", async () => {
    const { rerender } = renderOpen();
    await act(async () => {});
    fireEvent.change(input(), { target: { value: "hokkaido" } });
    await act(async () => {});
    expect(input().getAttribute("aria-activedescendant")).not.toBe(`theme-option-${COMMITTED.id}`);

    rerender(<ThemePalette isOpen={false} onClose={() => {}} />);
    await act(async () => {});
    rerender(<ThemePalette isOpen onClose={() => {}} />);
    await act(async () => {});

    expect(input().getAttribute("aria-activedescendant")).toBe(`theme-option-${COMMITTED.id}`);
    flushPendingTheme();
    expect(document.documentElement.dataset.theme).toBe(COMMITTED.id);
  });

  // Off the field, Escape reaches the dialog's backstop rather than the
  // field's handler; a query still clears before anything closes.
  it("clears a search before closing on Escape from the results", async () => {
    const onClose = vi.fn();
    render(<ThemePalette isOpen onClose={onClose} />, { wrapper: TooltipProvider });
    await act(async () => {});
    fireEvent.change(input(), { target: { value: "bondi" } });
    await act(async () => {});
    const results = screen.getByRole("group", { name: "Theme switcher" });
    act(() => results.focus());

    fireEvent.keyDown(results, { key: "Escape" });
    await act(async () => {});
    expect((input() as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(results, { key: "Escape" });
    await act(async () => {});
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The palette edits the global theme, as Settings does (#13833), while a
  // project with its own theme keeps showing it. Every hint has to say which.
  describe("in a project that shows its own theme", () => {
    const PROJECT = BUILT_IN_APP_SCHEMES.find((s) => s.type !== "light")!;
    const shownTheme = () => {
      flushPendingTheme();
      return document.documentElement.dataset.theme;
    };
    const cursorScheme = () => {
      const id = rows()
        .find((o) => o.getAttribute("aria-selected") === "true")!
        .id.replace("theme-option-", "");
      return BUILT_IN_APP_SCHEMES.find((s) => s.id === id)!;
    };

    beforeEach(() => {
      useAppThemeStore.setState({
        projectSchemeId: PROJECT.id,
        projectSnapshotScheme: null,
        followSystem: false,
      });
      injectSchemeToDOM(PROJECT, { immediate: true });
    });
    afterEach(() => {
      useAppThemeStore.setState({ projectSchemeId: null, projectSnapshotScheme: null });
    });

    it("leaves the project's theme on screen until the cursor moves", async () => {
      renderOpen();
      await act(async () => {});
      expect(shownTheme()).toBe(PROJECT.id);

      fireEvent.keyDown(input(), { key: "ArrowDown" });
      await act(async () => {});
      expect(shownTheme()).toBe(cursorScheme().id);

      // Once the cursor has moved, the saved global theme previews like any other.
      fireEvent.keyDown(input(), { key: "ArrowUp" });
      await act(async () => {});
      expect(cursorScheme().id).toBe(COMMITTED.id);
      expect(shownTheme()).toBe(COMMITTED.id);
    });

    it.each([
      ["no rows", "qqxzv"],
      ["only the saved row", "bondi"],
    ])("counts no move from a key with nowhere to go (%s)", async (_label, search) => {
      renderOpen();
      await act(async () => {});
      fireEvent.change(input(), { target: { value: search } });
      await act(async () => {});
      const themeRows = screen
        .queryAllByRole("option")
        .filter((o) => o.getAttribute("aria-disabled") !== "true");
      expect(themeRows.length).toBeLessThanOrEqual(1);

      fireEvent.keyDown(input(), { key: "ArrowDown" });
      fireEvent.keyDown(input(), { key: "Home" });
      await act(async () => {});
      fireEvent.change(input(), { target: { value: "" } });
      await act(async () => {});

      expect(cursorScheme().id).toBe(COMMITTED.id);
      expect(shownTheme()).toBe(PROJECT.id);
    });

    it("leaves the project's theme on screen while a search moves the saved row", async () => {
      const saved = BUILT_IN_APP_SCHEMES.find((s) => s.name === "Arashiyama")!;
      useAppThemeStore.setState({ selectedSchemeId: saved.id });
      const savedRowIndex = () => rows().findIndex((o) => o.id === `theme-option-${saved.id}`);
      renderOpen();
      await act(async () => {});
      const unfilteredIndex = savedRowIndex();

      fireEvent.change(input(), { target: { value: "japan" } });
      await act(async () => {});

      // The search moves the saved row to another index while keeping a row at
      // its old one, which is what reads as a move for a render.
      expect(savedRowIndex()).not.toBe(unfilteredIndex);
      expect(rows().length).toBeGreaterThan(unfilteredIndex);
      expect(cursorScheme().id).toBe(saved.id);
      expect(shownTheme()).toBe(PROJECT.id);
    });

    it("says Enter sets the global theme and Escape goes back to the project's", async () => {
      renderOpen();
      await act(async () => {});
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain(`This project shows its own theme, ${PROJECT.name}`);
      expect(dialog.textContent).toContain(`to keep ${COMMITTED.name} as the global theme`);
      const saved = rows().find((o) => o.getAttribute("aria-current"))!;
      expect(saved.textContent).toContain("Global theme");
      const note = document.getElementById(input().getAttribute("aria-describedby")!)!;
      expect(note.textContent).toBe(`This project shows its own theme, ${PROJECT.name}`);

      fireEvent.keyDown(input(), { key: "ArrowDown" });
      await act(async () => {});
      expect(dialog.textContent).toContain(`to set ${cursorScheme().name} as the global theme`);
      expect(dialog.textContent).toContain(`to go back to ${PROJECT.name}`);
      expect(dialog.textContent).not.toContain(`to go back to ${COMMITTED.name}`);

      // On the project's own row Escape changes nothing on screen, so it isn't offered.
      fireEvent.pointerMove(rows().find((o) => o.id === `theme-option-${PROJECT.id}`)!);
      await act(async () => {});
      expect(cursorScheme().id).toBe(PROJECT.id);
      expect(dialog.textContent).not.toContain("to go back to");

      fireEvent.change(input(), { target: { value: "a" } });
      await act(async () => {});
      expect(dialog.textContent).toContain("to clear search");
      expect(dialog.textContent).not.toContain("to go back to");
    });

    it("goes back to the project's theme when closed without a pick", async () => {
      const { rerender } = renderOpen();
      await act(async () => {});
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      await act(async () => {});
      expect(shownTheme()).not.toBe(PROJECT.id);

      rerender(<ThemePalette isOpen={false} onClose={() => {}} />);
      await act(async () => {});
      expect(shownTheme()).toBe(PROJECT.id);
    });

    it("saves the pick as the global theme and keeps showing the project's", async () => {
      function Harness() {
        const [open, setOpen] = useState(true);
        return <ThemePalette isOpen={open} onClose={() => setOpen(false)} />;
      }
      render(<Harness />, { wrapper: TooltipProvider });
      await act(async () => {});
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      await act(async () => {});
      const target = cursorScheme();

      fireEvent.keyDown(input(), { key: "Enter" });
      await act(async () => {});

      expect(useAppThemeStore.getState().selectedSchemeId).toBe(target.id);
      expect(shownTheme()).toBe(PROJECT.id);
    });
  });
});
