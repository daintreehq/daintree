// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/clients/logsClient", () => ({
  logsClient: {
    getLevelOverrides: vi.fn().mockResolvedValue({}),
    getRegistry: vi.fn().mockResolvedValue([]),
    setLevelOverrides: vi.fn().mockResolvedValue({ success: true }),
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { logsClient } from "@/clients/logsClient";
import { LogLevelPalette } from "../LogLevelPalette";

const noop = () => {};

function renderPalette(isOpen: boolean, onClose: () => void = noop) {
  return render(<LogLevelPalette isOpen={isOpen} onClose={onClose} />, {
    wrapper: TooltipProvider,
  });
}

function input() {
  return screen.getByRole("combobox") as HTMLInputElement;
}

function optionIds() {
  return screen.getAllByRole("option").map((o) => o.id);
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

/** The palette is closed and opened by its host while the component stays mounted. */
async function reopen(rerender: ReturnType<typeof renderPalette>["rerender"], onClose = noop) {
  rerender(<LogLevelPalette isOpen={false} onClose={onClose} />);
  await settle();
  rerender(<LogLevelPalette isOpen onClose={onClose} />);
  await settle();
}

describe("LogLevelPalette reopening", () => {
  beforeEach(() => {
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
    const ids = optionIds();
    expect(ids.length).toBeGreaterThan(10);
    expect(input().getAttribute("aria-activedescendant")).toBe(ids[0]);
  });

  it("shows an empty field, the full list and the first row after a module and level were chosen from a search", async () => {
    const onClose = vi.fn();
    const { rerender } = renderPalette(true, onClose);
    await settle();
    const fullList = optionIds();

    await type("PtyManager");
    expect(optionIds().length).toBeLessThan(fullList.length);
    await enter();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("choose a level");
    await enter();
    expect(logsClient.setLevelOverrides).toHaveBeenCalledWith({ "pty-host:PtyManager": "debug" });
    expect(onClose).toHaveBeenCalledTimes(1);

    await reopen(rerender, onClose);

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("choose a module");
    expect(input().value).toBe("");
    expect(optionIds()).toEqual(fullList);
    expect(input().getAttribute("aria-activedescendant")).toBe(fullList[0]);
  });

  it("shows an empty field, the full list and the first row after the scrim closed it with text in the field", async () => {
    const onClose = vi.fn();
    const { rerender } = renderPalette(true, onClose);
    await settle();
    const fullList = optionIds();

    await type("PtyManager");
    expect(optionIds().length).toBeLessThan(fullList.length);
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);

    await reopen(rerender, onClose);

    expect(input().value).toBe("");
    expect(optionIds()).toEqual(fullList);
    expect(input().getAttribute("aria-activedescendant")).toBe(fullList[0]);
  });

  it("goes back to the first row after the cursor moved with no search", async () => {
    const { rerender } = renderPalette(true);
    await settle();
    const fullList = optionIds();

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    await settle();
    expect(input().getAttribute("aria-activedescendant")).toBe(fullList[2]);

    await reopen(rerender);

    expect(input().getAttribute("aria-activedescendant")).toBe(fullList[0]);
  });

  it("lands on the first level, not the one a stale level search matched, after the scrim closed the level step", async () => {
    const onClose = vi.fn();
    const { rerender } = renderPalette(true, onClose);
    await settle();
    await enter();
    const levelRows = optionIds();
    await type("off");
    expect(optionIds().length).toBeLessThan(levelRows.length);
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);

    await reopen(rerender, onClose);
    await enter();

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("choose a level");
    expect(input().value).toBe("");
    expect(optionIds()).toEqual(levelRows);
    expect(input().getAttribute("aria-activedescendant")).toBe(levelRows[0]);
  });

  it("keeps the step and the search while it stays open and the overrides load", async () => {
    let resolveOverrides: (value: Record<string, string>) => void = noop;
    vi.mocked(logsClient.getLevelOverrides).mockReturnValue(
      new Promise((resolve) => {
        resolveOverrides = resolve;
      })
    );
    renderPalette(true);
    await settle();

    await type("PtyManager");
    await act(async () => resolveOverrides({ "pty-host:PtyManager": "debug" }));

    expect(input().value).toBe("PtyManager");
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("choose a module");
    expect(input().getAttribute("aria-activedescendant")).toBe(optionIds()[0]);
  });
});
