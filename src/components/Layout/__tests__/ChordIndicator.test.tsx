// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const dispatchMock = vi.fn().mockResolvedValue({ ok: true, result: undefined });
let manifest: Array<{ id: string; enabled: boolean; disabledReason?: string }> = [];
vi.mock("@/services/ActionService", () => ({
  actionService: {
    get: () => undefined,
    list: () => manifest,
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

import { ChordIndicator } from "../ChordIndicator";
import { keybindingService } from "@/services/KeybindingService";
import { isMac } from "@/lib/platform";

function pressCmdK(): void {
  const mac = isMac();
  const event = new KeyboardEvent("keydown", {
    key: "k",
    code: "KeyK",
    metaKey: mac,
    ctrlKey: !mac,
  });
  act(() => {
    keybindingService.resolveKeybinding(event);
  });
}

/** Let `useAnimatedPresence` mount (effect → rAF) and settle. */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

const hud = () => document.querySelector<HTMLElement>("[data-command-hud]");
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]');
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));

describe("ChordIndicator (Cmd+K command HUD)", () => {
  let terminal: HTMLTextAreaElement;

  beforeEach(() => {
    manifest = [];
    dispatchMock.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame"] });
    keybindingService.clearPendingChord();
    terminal = document.createElement("textarea");
    terminal.setAttribute("data-testid", "terminal");
    document.body.appendChild(terminal);
    terminal.focus();
  });

  afterEach(() => {
    act(() => keybindingService.clearPendingChord());
    cleanup();
    terminal.remove();
    vi.useRealTimers();
  });

  it("moves focus into the search input once the HUD has mounted", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();

    expect(hud()).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it("hands focus back to the invoking element as soon as the chord ends", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();
    expect(document.activeElement).toBe(input());

    act(() => keybindingService.clearPendingChord());

    // Immediately — the HUD is still fading out, and a key pressed now belongs
    // to the terminal, not to a retiring input.
    expect(hud()).not.toBeNull();
    expect(document.activeElement).toBe(terminal);
  });

  it("does not restore focus when a pointer press outside closed it", async () => {
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();

    fireEvent.pointerDown(elsewhere);
    elsewhere.focus();
    await flushFrames();

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("keeps the open list on screen, inert, while it fades out", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();
    const openCount = options().length;
    expect(openCount).toBeGreaterThan(0);

    act(() => keybindingService.clearPendingChord());

    expect(hud()).not.toBeNull();
    expect(options()).toHaveLength(openCount);
    expect(hud()!.hasAttribute("inert")).toBe(true);
  });

  it("names every option's group from its visible heading", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();

    const rows = options();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const group = row.closest('[role="group"]');
      expect(group).not.toBeNull();
      const labelId = group!.getAttribute("aria-labelledby");
      const label = labelId ? document.getElementById(labelId) : null;
      expect(label?.textContent?.trim()).toBeTruthy();
      expect(group!.contains(label)).toBe(true);
    }
  });

  it("marks exactly one option selected, and it is the active descendant", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();

    fireEvent.keyDown(input()!, { key: "ArrowDown" });
    fireEvent.keyDown(input()!, { key: "ArrowDown" });

    const selected = options().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(input()!.getAttribute("aria-activedescendant")).toBe(selected[0]!.id);
  });

  it("ends the chord when focus moves out of the input, leaving focus at the destination", async () => {
    const next = document.createElement("button");
    document.body.appendChild(next);
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();

    act(() => next.focus());
    await flushFrames();

    expect(keybindingService.getPendingChord()).toBeNull();
    expect(document.activeElement).toBe(next);
    next.remove();
  });

  it("returns focus to the invoker after a reopen inside the exit fade", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();
    act(() => keybindingService.clearPendingChord());
    // Reopen before the exit completes: the panel is still mounted.
    pressCmdK();
    await flushFrames();
    expect(document.activeElement).toBe(input());

    act(() => keybindingService.clearPendingChord());

    expect(document.activeElement).toBe(terminal);
  });

  it("finds a row by its key typed without separators", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();
    const first = options()[0]!;
    const keyText = first.querySelector(".sr-only")!.textContent!;

    fireEvent.change(input()!, { target: { value: keyText.replace(/\+/g, "") } });

    expect(options().map((o) => o.id)).toContain(first.id);
  });

  it("shows why a disabled command can't run, and stays open instead of dispatching", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();
    const target = options()[0]!;
    const actionId = target.id.replace("command-hud-option-", "");
    act(() => keybindingService.clearPendingChord());
    await flushFrames();

    manifest = [{ id: actionId, enabled: false, disabledReason: "No closed sessions" }];
    pressCmdK();
    await flushFrames();
    const row = options().find((o) => o.id === target.id)!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("No closed sessions");

    fireEvent.click(row);
    await flushFrames();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(keybindingService.getPendingChord()).not.toBeNull();
  });

  it("finds every row of a group by typing its visible heading", async () => {
    render(<ChordIndicator />);
    pressCmdK();
    await flushFrames();
    const group = document.querySelector('[role="group"]')!;
    const heading = document.getElementById(group.getAttribute("aria-labelledby")!)!;
    const ids = Array.from(group.querySelectorAll('[role="option"]')).map((o) => o.id);

    fireEvent.change(input()!, { target: { value: heading.textContent!.toLowerCase() } });

    const found = options().map((o) => o.id);
    for (const id of ids) expect(found).toContain(id);
  });
});
