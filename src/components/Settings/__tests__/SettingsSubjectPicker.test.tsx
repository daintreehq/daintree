// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup, act } from "@testing-library/react";
import { SettingsSubjectPicker } from "../SettingsSubjectPicker";

afterEach(cleanup);

interface Item {
  id: string;
  name: string;
  group?: string;
}

const OVERVIEW: Item = { id: "overview", name: "Overview" };
const ENTRIES: Item[] = [
  { id: "alpha", name: "Alpha", group: "Local" },
  { id: "beta", name: "Beta", group: "Local" },
  { id: "gamma", name: "Gamma", group: "Installed" },
];

function renderPicker(activeId: string, onChange = vi.fn()) {
  render(
    <SettingsSubjectPicker<Item>
      idPrefix="test-picker"
      overview={OVERVIEW}
      entries={ENTRIES}
      matches={(item, q) => item.name.toLowerCase().includes(q)}
      groupOf={(item) => item.group}
      activeId={activeId}
      onChange={onChange}
      current={<span>{activeId}</span>}
      renderRow={(item) => <span>{item.name}</span>}
      listLabel="Things"
      filterLabel="Filter things"
      placeholder="Filter things…"
      noMatches={(q) => <>Nothing matches {q}</>}
    />
  );
  return onChange;
}

async function openWithPointer() {
  const trigger = screen.getByTestId("test-picker-trigger");
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  return await screen.findByRole("combobox");
}

async function openWithKeyboard() {
  const trigger = screen.getByTestId("test-picker-trigger");
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(trigger);
  return await screen.findByRole("combobox");
}

const options = () =>
  screen.getAllByRole("option").filter((o) => o.getAttribute("aria-disabled") !== "true");
const cursorRows = () => options().filter((o) => o.getAttribute("aria-selected") === "true");
const currentRows = () => options().filter((o) => o.getAttribute("aria-current") === "page");

describe("SettingsSubjectPicker", () => {
  it("opens from a pointer with no cursor, marking only the page being shown", async () => {
    const onChange = renderPicker("beta");
    const input = await openWithPointer();

    expect(cursorRows()).toHaveLength(0);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(currentRows().map((o) => o.id)).toEqual(["test-picker-item-beta"]);

    // Nothing is under the cursor, so Enter has nothing to act on.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("starts the first arrow after a pointer opening from the page being shown", async () => {
    renderPicker("beta");
    const input = await openWithPointer();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("test-picker-item-beta");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("test-picker-item-gamma");
    expect(cursorRows()).toHaveLength(1);
  });

  it("opens from the keyboard with the cursor on the page being shown", async () => {
    const onChange = renderPicker("gamma");
    const input = await openWithKeyboard();
    expect(input.getAttribute("aria-activedescendant")).toBe("test-picker-item-gamma");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("gamma");
  });

  it("never lets a failed search pick the overview", async () => {
    const onChange = renderPicker("alpha");
    const input = await openWithKeyboard();
    act(() => {
      fireEvent.change(input, { target: { value: "zzz" } });
    });
    expect(screen.getByRole("status").textContent).toContain("zzz");
    expect(cursorRows()).toHaveLength(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("puts the cursor on the first match, not the overview, while filtering", async () => {
    const onChange = renderPicker("overview");
    const input = await openWithPointer();
    act(() => {
      fireEvent.change(input, { target: { value: "gam" } });
    });
    expect(input.getAttribute("aria-activedescendant")).toBe("test-picker-item-gamma");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("gamma");
  });

  it("opens a band where the group changes, without claiming an item id", async () => {
    renderPicker("overview");
    await openWithPointer();
    const bands = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-disabled") === "true")
      .map((o) => o.textContent);
    expect(bands).toEqual(["Local", "Installed"]);
    const ids = screen
      .getAllByRole("option")
      .map((o) => o.id)
      .filter(Boolean);
    expect(ids).toHaveLength(ENTRIES.length + 1);
  });
});
