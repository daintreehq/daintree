/**
 * @vitest-environment jsdom
 */
import { useRef, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { usePrefixPicker, type UsePrefixPickerResult } from "../usePrefixPicker";

/**
 * A bare input wired the way `NewBranchInput` wires it: the hook's key handler
 * on the field, and one option element per suggestion inside the list ref.
 */
function renderPicker() {
  let latest: UsePrefixPickerResult | null = null;
  const onSelectPrefix = vi.fn();
  // Recorded through a prop: the react-compiler lint forbids assigning to an
  // outer binding during render.
  const record = (picker: UsePrefixPickerResult): void => {
    latest = picker;
  };

  function Harness({ onRender }: { onRender: (picker: UsePrefixPickerResult) => void }) {
    const [value, setValue] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const picker = usePrefixPicker({
      branchInput: value,
      onSelectPrefix: (next) => {
        onSelectPrefix(next);
        setValue(next);
      },
      newBranchInputRef: inputRef,
    });
    onRender(picker);
    return (
      <>
        <input
          ref={inputRef}
          data-testid="field"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={picker.handleInputFocus}
          onKeyDown={picker.handlePrefixKeyDown}
          aria-activedescendant={
            picker.prefixPickerOpen && picker.prefixSuggestions.length > 0
              ? `prefix-option-${picker.prefixSelectedIndex}`
              : undefined
          }
        />
        <div ref={picker.prefixListRef}>
          {picker.prefixPickerOpen &&
            picker.prefixSuggestions.map((s, i) => (
              <div key={s.type.prefix} id={`prefix-option-${i}`} role="option" />
            ))}
        </div>
      </>
    );
  }

  const utils = render(<Harness onRender={record} />);
  const field = utils.getByTestId("field");
  if (!(field instanceof HTMLInputElement)) throw new Error("harness field is not an input");
  field.focus();
  return {
    field,
    onSelectPrefix,
    get picker() {
      if (!latest) throw new Error("picker never rendered");
      return latest;
    },
    type: (value: string) =>
      act(() => {
        fireEvent.change(field, { target: { value } });
      }),
    key: (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      act(() => {
        field.dispatchEvent(event);
      });
      return event;
    },
  };
}

function activeDescendantResolves(field: HTMLInputElement): boolean {
  const id = field.getAttribute("aria-activedescendant");
  return id !== null && document.getElementById(id) !== null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("usePrefixPicker — cursor across a changing list", () => {
  it("keeps the active row on a real option when a keystroke shrinks the list", () => {
    const p = renderPicker();
    p.type("d");
    expect(p.picker.prefixSuggestions.length).toBeGreaterThan(1);

    const last = p.picker.prefixSuggestions.length - 1;
    for (let i = 0; i < last; i++) p.key("ArrowDown");
    expect(p.picker.prefixSelectedIndex).toBe(last);

    p.type("do");
    expect(p.picker.prefixSuggestions.length).toBeLessThanOrEqual(last);
    expect(p.picker.prefixSelectedIndex).toBeLessThan(p.picker.prefixSuggestions.length);
    expect(activeDescendantResolves(p.field)).toBe(true);
  });

  it("keeps the cursor where it is when a keystroke leaves the same rows on offer", () => {
    const p = renderPicker();
    p.type("r");
    const rows = p.picker.prefixSuggestions.map((s) => s.type.prefix);
    expect(rows.length).toBeGreaterThan(1);
    p.key("ArrowDown");

    p.type("re");
    expect(p.picker.prefixSuggestions.map((s) => s.type.prefix)).toEqual(rows);
    expect(p.picker.prefixSelectedIndex).toBe(1);
  });

  it("Tab after a shrink picks the row the cursor is on", () => {
    const p = renderPicker();
    p.type("d");
    p.key("ArrowDown");
    p.type("do");
    const onOffer = p.picker.prefixSuggestions[p.picker.prefixSelectedIndex]!.type.prefix;

    const event = p.key("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(p.onSelectPrefix).toHaveBeenCalledWith(`${onOffer}/`);
  });
});

describe("usePrefixPicker — stepping rule", () => {
  it("wraps the arrows at the ends, jumps with Home/End, and leaves Shift+End to the field", () => {
    const p = renderPicker();
    p.type("d");
    const count = p.picker.prefixSuggestions.length;
    expect(count).toBeGreaterThan(1);
    const first = "prefix-option-0";
    const last = `prefix-option-${count - 1}`;
    const active = () => p.field.getAttribute("aria-activedescendant");
    expect(active()).toBe(first);

    expect(p.key("ArrowUp").defaultPrevented).toBe(true);
    expect(active()).toBe(last);
    p.key("ArrowDown");
    expect(active()).toBe(first);

    expect(p.key("End").defaultPrevented).toBe(true);
    expect(active()).toBe(last);
    expect(p.key("Home").defaultPrevented).toBe(true);
    expect(active()).toBe(first);

    expect(p.key("End", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(active()).toBe(first);
  });
});

describe("usePrefixPicker — Tab and Enter only swallowed on a pick", () => {
  it("leaves Tab and Enter alone when the list is closed", () => {
    const p = renderPicker();
    p.type("feature/x");
    expect(p.picker.prefixPickerOpen).toBe(false);

    expect(p.key("Tab").defaultPrevented).toBe(false);
    expect(p.key("Enter").defaultPrevented).toBe(false);
    expect(p.onSelectPrefix).not.toHaveBeenCalled();
  });

  it("swallows Enter exactly when it picks the active row", () => {
    const p = renderPicker();
    p.type("d");
    const active = p.picker.prefixSuggestions[p.picker.prefixSelectedIndex]!.type.prefix;

    expect(p.key("Enter").defaultPrevented).toBe(true);
    expect(p.onSelectPrefix).toHaveBeenCalledWith(`${active}/`);
  });

  it.each([
    ["Shift+Tab", "Tab", { shiftKey: true }],
    ["Cmd+Enter", "Enter", { metaKey: true }],
    ["Ctrl+Enter", "Enter", { ctrlKey: true }],
  ] as const)("leaves %s to navigation and submit, picking nothing", (_label, key, init) => {
    const p = renderPicker();
    p.type("d");
    expect(p.picker.prefixPickerOpen).toBe(true);

    expect(p.key(key, init).defaultPrevented).toBe(false);
    expect(p.onSelectPrefix).not.toHaveBeenCalled();
  });

  it("does not swallow keys the IME is composing with", () => {
    const p = renderPicker();
    p.type("d");
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      p.field.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(p.onSelectPrefix).not.toHaveBeenCalled();
  });
});

describe("usePrefixPicker — active row stays in view", () => {
  it("scrolls the row the cursor moves to into view", () => {
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.id);
    });
    const p = renderPicker();
    p.type("d");
    scrolled.length = 0;

    p.key("ArrowDown");
    expect(scrolled.at(-1)).toBe(`prefix-option-${p.picker.prefixSelectedIndex}`);
  });
});
