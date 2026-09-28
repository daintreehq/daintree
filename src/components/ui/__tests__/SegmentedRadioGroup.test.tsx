/**
 * @vitest-environment jsdom
 */
import { useState } from "react";
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SegmentedRadioGroup } from "../SegmentedRadioGroup";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(cleanup);

const OPTIONS = [
  { value: "new", label: "New branch" },
  { value: "existing", label: "Existing branch" },
  { value: "third", label: "Third" },
];

function renderGroup(value = "new") {
  const onChange = vi.fn();
  render(
    <SegmentedRadioGroup
      options={OPTIONS}
      value={value}
      onChange={onChange}
      aria-label="Branch mode"
    />
  );
  return { onChange, group: screen.getByRole("radiogroup", { name: "Branch mode" }) };
}

describe("SegmentedRadioGroup keyboard model", () => {
  it("keeps the group to a single tab stop by roving tabindex onto the checked segment", () => {
    renderGroup("existing");

    const tabbable = screen
      .getAllByRole("radio")
      .filter((radio) => radio.getAttribute("tabindex") === "0");

    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.textContent).toBe("Existing branch");
  });

  it("moves the selection forward and wraps past the last segment", () => {
    const { onChange, group } = renderGroup("third");

    fireEvent.keyDown(group, { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledWith("new");
  });

  it("moves the selection backward and wraps past the first segment", () => {
    const { onChange, group } = renderGroup("new");

    fireEvent.keyDown(group, { key: "ArrowLeft" });

    expect(onChange).toHaveBeenCalledWith("third");
  });

  it("treats vertical arrows as equivalent to horizontal ones", () => {
    const { onChange, group } = renderGroup("new");

    fireEvent.keyDown(group, { key: "ArrowDown" });

    expect(onChange).toHaveBeenCalledWith("existing");
  });

  it("jumps to the ends on Home and End", () => {
    const { onChange, group } = renderGroup("existing");

    fireEvent.keyDown(group, { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("new");

    fireEvent.keyDown(group, { key: "End" });
    expect(onChange).toHaveBeenCalledWith("third");
  });

  it("does not tell the owner about a pick of the segment that is already checked", () => {
    const { onChange } = renderGroup("existing");

    fireEvent.click(screen.getByRole("radio", { name: "Existing branch" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves modified arrows to the app", () => {
    const { onChange, group } = renderGroup("new");

    fireEvent.keyDown(group, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(group, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(group, { key: "End", metaKey: true });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves unrelated keys to the surrounding form", () => {
    const { onChange, group } = renderGroup();

    fireEvent.keyDown(group, { key: "Enter" });
    fireEvent.keyDown(group, { key: "a" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("still exposes a tab stop when the value matches no segment", () => {
    renderGroup("unknown-mode");

    const tabbable = screen
      .getAllByRole("radio")
      .filter((radio) => radio.getAttribute("tabindex") === "0");

    expect(tabbable).toHaveLength(1);
    expect(
      screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")
    ).toBe(true);
  });

  it("moves off an unmatched value rather than getting stuck", () => {
    const { onChange, group } = renderGroup("unknown-mode");

    fireEvent.keyDown(group, { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledWith("existing");
  });
  it("steps past an option whose change was rolled back, from where focus is", () => {
    // The owner rejected "existing" and kept "new" selected, but focus stayed on the
    // option the user tried. The next arrow has to move on to "third".
    const { onChange, group } = renderGroup("new");
    screen.getByRole("radio", { name: "Existing branch" }).focus();

    fireEvent.keyDown(group, { key: "ArrowRight" });

    expect(onChange).toHaveBeenLastCalledWith("third");
  });
});

describe("SegmentedRadioGroup thumb motion", () => {
  const thumbSlides = (container: HTMLElement) =>
    container
      .querySelector('[data-slot="segmented-thumb"]')
      ?.className.includes("transition-[translate,width]") ?? false;

  function Controlled({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return (
      <>
        <SegmentedRadioGroup
          options={OPTIONS}
          value={value}
          onChange={setValue}
          aria-label="Branch mode"
        />
        <button type="button" onClick={() => setValue("third")}>
          Load
        </button>
      </>
    );
  }

  it("does not slide into place on mount", () => {
    const { container } = render(<Controlled initial="existing" />);

    expect(thumbSlides(container)).toBe(false);
  });

  it("snaps when the value changes from outside the control", () => {
    const { container } = render(<Controlled initial="new" />);

    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    expect(screen.getByRole("radio", { name: "Third" }).getAttribute("aria-checked")).toBe("true");
    expect(thumbSlides(container)).toBe(false);
  });

  it("forgets a pick the owner rejected once the user re-picks the current value", () => {
    function Rejecting() {
      const [value, setValue] = useState("new");
      return (
        <>
          <SegmentedRadioGroup
            options={OPTIONS}
            value={value}
            onChange={(next) => {
              if (next === "new") setValue(next);
            }}
            aria-label="Branch mode"
          />
          <button type="button" onClick={() => setValue("existing")}>
            Load
          </button>
        </>
      );
    }
    const { container } = render(<Rejecting />);

    fireEvent.click(screen.getByRole("radio", { name: "Existing branch" }));
    fireEvent.click(screen.getByRole("radio", { name: "New branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    expect(thumbSlides(container)).toBe(false);
  });

  it("keeps sliding when the resize observer reports mid-slide with nothing moved", () => {
    const callbacks: ResizeObserverCallback[] = [];
    class RecordingObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", RecordingObserver);
    try {
      const { container } = render(<Controlled initial="new" />);

      fireEvent.click(screen.getByRole("radio", { name: "Existing branch" }));
      // Every observer attached so far reports, as a real one does on attach.
      act(() => {
        for (const callback of callbacks) callback([], {} as ResizeObserver);
      });

      expect(thumbSlides(container)).toBe(true);
    } finally {
      vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    }
  });

  it("slides when the user picks a segment", () => {
    const { container } = render(<Controlled initial="new" />);

    fireEvent.click(screen.getByRole("radio", { name: "Existing branch" }));

    expect(thumbSlides(container)).toBe(true);
  });
});

describe("SegmentedRadioGroup disabled segments", () => {
  const WITH_DISABLED = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo", disabled: true },
    { value: "c", label: "Charlie" },
    { value: "d", label: "Delta", disabled: true },
  ];

  function renderWith(value: string, options = WITH_DISABLED) {
    const onChange = vi.fn();
    render(
      <SegmentedRadioGroup options={options} value={value} onChange={onChange} aria-label="Mode" />
    );
    return { onChange, group: screen.getByRole("radiogroup", { name: "Mode" }) };
  }

  const enabledValues = (options: typeof WITH_DISABLED) =>
    new Set(options.filter((o) => !o.disabled).map((o) => o.value));

  it("never lands the arrow keys or Home/End on a disabled segment", () => {
    const { onChange, group } = renderWith("a");
    const allowed = enabledValues(WITH_DISABLED);

    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      fireEvent.keyDown(group, { key });
    }

    expect(onChange).toHaveBeenCalled();
    for (const [picked] of onChange.mock.calls) expect(allowed.has(picked as string)).toBe(true);
  });

  it("steps over a disabled segment to the next enabled one rather than stopping at it", () => {
    const allowed = enabledValues(WITH_DISABLED);
    for (const from of allowed) {
      for (const key of ["ArrowRight", "ArrowLeft"]) {
        cleanup();
        const { onChange, group } = renderWith(from);
        fireEvent.keyDown(group, { key });
        const picked = onChange.mock.calls[0]?.[0] as string | undefined;
        expect(picked, `${key} from ${from}`).toBeDefined();
        expect(allowed.has(picked!), `${key} from ${from}`).toBe(true);
        expect(picked, `${key} from ${from}`).not.toBe(from);
      }
    }
  });

  it("keeps exactly one tab stop, and never on a disabled segment, whatever is checked", () => {
    for (const value of ["a", "b", "c", "d", "nothing"]) {
      cleanup();
      renderWith(value);
      const stops = screen
        .getAllByRole("radio")
        .filter((radio) => radio.getAttribute("tabindex") === "0");
      expect(stops, `value=${value}`).toHaveLength(1);
      expect((stops[0] as HTMLButtonElement).disabled, `value=${value}`).toBe(false);
    }
  });

  it("still shows a disabled segment as the checked one when it is", () => {
    renderWith("b");

    expect(screen.getByRole("radio", { name: "Bravo" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does nothing when every segment is disabled", () => {
    const { onChange, group } = renderWith("a", [
      { value: "a", label: "Alpha", disabled: true },
      { value: "b", label: "Bravo", disabled: true },
    ]);

    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.keyDown(group, { key: "End" });

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SegmentedRadioGroup inside a larger keyboard domain", () => {
  it("keeps the keys it handles from reaching a surrounding list, and passes the rest", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(event) => outer(event.key)}>
        <SegmentedRadioGroup options={OPTIONS} value="new" onChange={() => {}} aria-label="Mode" />
      </div>
    );
    const group = screen.getByRole("radiogroup", { name: "Mode" });

    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End", "Enter", "Escape"]) {
      fireEvent.keyDown(group, { key });
    }

    expect(outer.mock.calls.map(([key]) => key)).toEqual(["Enter", "Escape"]);
  });
});

describe("SegmentedRadioGroup naming", () => {
  it("names each segment by its ariaLabel when the visible label is an abbreviation", () => {
    render(
      <SegmentedRadioGroup
        options={[
          { value: "60", label: "60d", ariaLabel: "60 days" },
          { value: "120", label: "120d", ariaLabel: "120 days" },
        ]}
        value="60"
        onChange={() => {}}
        aria-label="Range"
      />
    );

    expect(screen.getByRole("radio", { name: "60 days" }).getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(screen.getByRole("radio", { name: "120 days" })).toBeTruthy();
  });

  it("derives a distinct test id per segment from the group's", () => {
    render(
      <SegmentedRadioGroup
        options={OPTIONS}
        value="new"
        onChange={() => {}}
        aria-label="Mode"
        testId="mode"
      />
    );

    const group = screen.getByTestId("mode");
    const ids = screen.getAllByRole("radio").map((radio) => radio.getAttribute("data-testid"));
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(new Set(ids).size).toBe(OPTIONS.length);
    for (const id of ids) expect(id?.startsWith("mode-")).toBe(true);
  });
});

describe("SegmentedRadioGroup thumb", () => {
  /** Tailwind's `z-<n>` — jsdom has no stylesheet to compute against. */
  const stackLevel = (el: Element) => {
    const match = /(?:^|\s)z-(\d+)(?=\s|$)/.exec(el.className);
    return match?.[1] === undefined ? 0 : Number(match[1]);
  };
  const dims = (el: Element) =>
    el.className.split(/\s+/).some((utility) => {
      const match = /(?:^|:)opacity-(\d+)$/.exec(utility);
      return match?.[1] !== undefined && Number(match[1]) < 100;
    });

  it("keeps every segment stacked above the thumb, so a sliding thumb never covers a label", () => {
    const { container } = render(
      <SegmentedRadioGroup options={OPTIONS} value="new" onChange={() => {}} aria-label="Mode" />
    );
    const thumb = container.querySelector('[data-slot="segmented-thumb"]');

    expect(thumb).not.toBeNull();
    for (const radio of screen.getAllByRole("radio")) {
      expect(stackLevel(radio)).toBeGreaterThan(stackLevel(thumb!));
    }
  });

  it("dims the thumb with a checked segment that is disabled, rather than dropping it", () => {
    const { container } = render(
      <SegmentedRadioGroup
        options={[
          { value: "a", label: "Alpha", disabled: true },
          { value: "b", label: "Bravo" },
        ]}
        value="a"
        onChange={() => {}}
        aria-label="Mode"
      />
    );
    const thumb = container.querySelector('[data-slot="segmented-thumb"]');

    expect(thumb).not.toBeNull();
    expect(dims(thumb!)).toBe(true);
  });

  it("leaves the thumb at full strength when only an unchecked segment is disabled", () => {
    const { container } = render(
      <SegmentedRadioGroup
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Bravo", disabled: true },
        ]}
        value="a"
        onChange={() => {}}
        aria-label="Mode"
      />
    );

    expect(dims(container.querySelector('[data-slot="segmented-thumb"]')!)).toBe(false);
  });
});
