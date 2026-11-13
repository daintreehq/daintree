// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/clients/logsClient", () => ({
  logsClient: {
    getLevelOverrides: vi.fn().mockResolvedValue({}),
    getRegistry: vi.fn().mockResolvedValue([]),
    setLevelOverrides: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// A small fixed catalog: the searched module sits inside the rendered rows and
// past the first one however the real catalog grows.
vi.mock("@shared/config/loggerNames", () => ({
  LOGGER_NAMES: ["*", "main:Alpha", "main:Bravo", "main:Charlie", "main:Delta"],
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { logsClient } from "@/clients/logsClient";
import { LogLevelPalette } from "../LogLevelPalette";

const noop = () => {};

const MODULE_ROWS = ["*", "main:Alpha", "main:Bravo", "main:Charlie", "main:Delta"].map(
  (name) => `palette-option-${name}`
);
const LEVEL_ROWS = ["debug", "info", "warn", "error", "off", "clear"].map(
  (id) => `palette-option-${id}`
);

function renderPalette(isOpen: boolean, onClose: () => void = noop) {
  return render(<LogLevelPalette isOpen={isOpen} onClose={onClose} />, {
    wrapper: TooltipProvider,
  });
}

function input() {
  return screen.getByRole("combobox") as HTMLInputElement;
}

function optionIds() {
  return screen.queryAllByRole("option").map((o) => o.id);
}

function cursorId() {
  return input().getAttribute("aria-activedescendant");
}

function stepLabel() {
  return screen.getByRole("dialog").getAttribute("aria-label") ?? "";
}

async function settle() {
  await act(async () => {});
}

async function type(value: string) {
  fireEvent.change(input(), { target: { value } });
  await settle();
}

async function enter() {
  fireEvent.keyDown(input(), { key: "Enter" });
  await settle();
}

async function arrowDown() {
  fireEvent.keyDown(input(), { key: "ArrowDown" });
  await settle();
}

/** The scrim sits behind the dialog panel; clicking it is how a mouse user dismisses. */
async function clickScrim() {
  fireEvent.click(screen.getByRole("dialog").parentElement!);
  await settle();
}

/**
 * The host closes the palette and opens it again while the component stays
 * mounted. `afterExit` waits for the shell to drop its DOM first, the way a
 * reopen after a pause finds it; otherwise the reopen lands mid-animation.
 */
async function reopen(
  rerender: ReturnType<typeof renderPalette>["rerender"],
  onClose: () => void = noop,
  { afterExit = false } = {}
) {
  rerender(<LogLevelPalette isOpen={false} onClose={onClose} />);
  await settle();
  if (afterExit) {
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
  rerender(<LogLevelPalette isOpen onClose={onClose} />);
  await settle();
}

describe("LogLevelPalette reopening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(logsClient.getLevelOverrides).mockResolvedValue({});
    vi.mocked(logsClient.getRegistry).mockResolvedValue([]);
    vi.mocked(logsClient.setLevelOverrides).mockResolvedValue({ success: true });
  });
  afterEach(() => cleanup());

  it("opens on the full module list with the first row selected", async () => {
    renderPalette(true);
    await settle();
    expect(input().value).toBe("");
    expect(optionIds()).toEqual(MODULE_ROWS);
    expect(cursorId()).toBe(MODULE_ROWS[0]);
  });

  it("shows an empty field, the full list and the first row after a module and level were chosen from a search", async () => {
    const onClose = vi.fn();
    const { rerender } = renderPalette(true, onClose);
    await settle();

    await type("Charlie");
    expect(optionIds()).toEqual(["palette-option-main:Charlie"]);
    await enter();
    expect(stepLabel()).toContain("choose a level");
    await enter();
    expect(logsClient.setLevelOverrides).toHaveBeenCalledWith({ "main:Charlie": "debug" });
    expect(onClose).toHaveBeenCalledTimes(1);

    await reopen(rerender, onClose);

    expect(stepLabel()).toContain("choose a module");
    expect(input().value).toBe("");
    expect(optionIds()).toEqual(MODULE_ROWS);
    expect(cursorId()).toBe(MODULE_ROWS[0]);
  });

  it.each([
    ["straight away", false],
    ["once the exit animation has finished", true],
  ])(
    "shows an empty field, the full list and the first row when the scrim closed it with text in the field and it reopens %s",
    async (_name, afterExit) => {
      const onClose = vi.fn();
      const { rerender } = renderPalette(true, onClose);
      await settle();

      await type("Charlie");
      expect(optionIds()).toEqual(["palette-option-main:Charlie"]);
      await clickScrim();
      expect(onClose).toHaveBeenCalledTimes(1);

      await reopen(rerender, onClose, { afterExit });

      expect(input().value).toBe("");
      expect(optionIds()).toEqual(MODULE_ROWS);
      expect(cursorId()).toBe(MODULE_ROWS[0]);
    }
  );

  it("recovers from a search with no matches", async () => {
    const onClose = vi.fn();
    const { rerender } = renderPalette(true, onClose);
    await settle();

    await type("zzzzqqqq");
    expect(optionIds()).toEqual([]);
    await clickScrim();
    expect(onClose).toHaveBeenCalledTimes(1);

    await reopen(rerender, onClose);

    expect(input().value).toBe("");
    expect(optionIds()).toEqual(MODULE_ROWS);
    expect(cursorId()).toBe(MODULE_ROWS[0]);
  });

  it("goes back to the first row after the cursor moved with no search", async () => {
    const { rerender } = renderPalette(true);
    await settle();

    await arrowDown();
    await arrowDown();
    expect(cursorId()).toBe(MODULE_ROWS[2]);

    await reopen(rerender);

    expect(cursorId()).toBe(MODULE_ROWS[0]);
  });

  it("lands on the first level, not the one a stale level search matched, after the scrim closed the level step", async () => {
    const onClose = vi.fn();
    const { rerender } = renderPalette(true, onClose);
    await settle();
    await enter();
    expect(optionIds()).toEqual(LEVEL_ROWS);

    await type("off");
    expect(optionIds()[0]).toBe("palette-option-off");
    await clickScrim();
    expect(onClose).toHaveBeenCalledTimes(1);

    await reopen(rerender, onClose);
    await enter();

    expect(stepLabel()).toContain("choose a level");
    expect(input().value).toBe("");
    expect(optionIds()).toEqual(LEVEL_ROWS);
    expect(cursorId()).toBe(LEVEL_ROWS[0]);
  });

  it("keeps the search and the cursor while it stays open and the overrides load", async () => {
    let resolveOverrides: (value: Record<string, string>) => void = noop;
    vi.mocked(logsClient.getLevelOverrides).mockReturnValue(
      new Promise((resolve) => {
        resolveOverrides = resolve;
      })
    );
    renderPalette(true);
    await settle();

    await type("main");
    expect(optionIds().length).toBeGreaterThan(2);
    await arrowDown();
    await arrowDown();
    const cursor = cursorId();
    expect(cursor).not.toBe(optionIds()[0]);

    await act(async () => resolveOverrides({ "main:Delta": "debug" }));

    expect(document.getElementById("palette-option-main:Delta")!.textContent).toContain("debug");
    expect(input().value).toBe("main");
    expect(cursorId()).toBe(cursor);
    expect(stepLabel()).toContain("choose a module");
  });
});

describe("LogLevelPalette Escape on the level step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(logsClient.getLevelOverrides).mockResolvedValue({});
    vi.mocked(logsClient.getRegistry).mockResolvedValue([]);
    vi.mocked(logsClient.setLevelOverrides).mockResolvedValue({ success: true });
  });
  afterEach(() => cleanup());

  async function escape(target: HTMLElement = input()) {
    fireEvent.keyDown(target, { key: "Escape" });
    await settle();
  }

  it("goes back to the module step where it was left, and closes from there", async () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);
    await settle();
    await type("Bravo");
    await enter();
    expect(stepLabel()).toContain("choose a level");

    await escape();
    expect(onClose).not.toHaveBeenCalled();
    expect(stepLabel()).toContain("choose a module");
    expect(input().value).toBe("Bravo");
    expect(cursorId()).toBe("palette-option-main:Bravo");

    await escape();
    expect(input().value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears a level search before it steps back, from the field or the results region", async () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);
    await settle();
    await enter();
    await type("off");

    await escape(screen.getByRole("group", { name: /^Level for/ }));
    expect(stepLabel()).toContain("choose a level");
    expect(input().value).toBe("");
    expect(optionIds()).toEqual(LEVEL_ROWS);

    await escape(screen.getByRole("group", { name: /^Level for/ }));
    expect(stepLabel()).toContain("choose a module");
    expect(onClose).not.toHaveBeenCalled();
  });
});
