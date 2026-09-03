// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useToolbarRoving } from "../useToolbarRoving";

afterEach(cleanup);

function Toolbar({ labels, enabled = true }: { labels: string[]; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useToolbarRoving(ref, enabled);
  return (
    <div ref={ref} role="toolbar" aria-label="Test controls" onKeyDown={onKeyDown}>
      {labels.map((label) => (
        <button key={label} type="button">
          {label}
        </button>
      ))}
    </div>
  );
}

function Growing() {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useToolbarRoving(ref);
  const [extra, setExtra] = useState(false);
  return (
    <div ref={ref} role="toolbar" aria-label="Test controls" onKeyDown={onKeyDown}>
      <button type="button">one</button>
      {extra && <button type="button">middle</button>}
      <button type="button">last</button>
      <button
        type="button"
        onClick={() => {
          setExtra((value) => !value);
        }}
      >
        toggle
      </button>
    </div>
  );
}

function tabIndexes(): number[] {
  return Array.from(document.querySelectorAll("button")).map((b) => b.tabIndex);
}

describe("useToolbarRoving", () => {
  it("leaves exactly one control in the tab order", () => {
    // The whole point of the pattern: a dense row must cost one Tab press to
    // pass, not one per control.
    render(<Toolbar labels={["a", "b", "c"]} />);
    expect(tabIndexes()).toEqual([0, -1, -1]);
  });

  it("moves the tab stop with the arrow keys rather than adding stops", () => {
    render(<Toolbar labels={["a", "b", "c"]} />);
    const toolbar = screen.getByRole("toolbar");
    screen.getByText("a").focus();

    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByText("b"));
    // Still exactly one stop — the count is the invariant, not the position.
    expect(tabIndexes().filter((t) => t === 0)).toHaveLength(1);
  });

  it("wraps in both directions, so neither end is a dead key", () => {
    render(<Toolbar labels={["a", "b", "c"]} />);
    const toolbar = screen.getByRole("toolbar");

    screen.getByText("c").focus();
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByText("a"));

    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByText("c"));
  });

  it("jumps to the ends with Home and End", () => {
    render(<Toolbar labels={["a", "b", "c"]} />);
    const toolbar = screen.getByRole("toolbar");
    screen.getByText("b").focus();

    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement).toBe(screen.getByText("c"));
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByText("a"));
  });

  it("continues from wherever focus actually is, not from where it last put it", () => {
    // A pointer click moves focus without telling the hook. Arrowing after a
    // click has to carry on from the clicked control.
    render(<Toolbar labels={["a", "b", "c"]} />);
    const toolbar = screen.getByRole("toolbar");
    screen.getByText("c").focus();

    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByText("b"));
  });

  it("ignores modifier chords, which belong to the app", () => {
    render(<Toolbar labels={["a", "b", "c"]} />);
    const toolbar = screen.getByRole("toolbar");
    screen.getByText("a").focus();

    for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
      fireEvent.keyDown(toolbar, { key: "ArrowRight", [modifier]: true });
      expect(document.activeElement).toBe(screen.getByText("a"));
    }
  });

  it("leaves the DOM untouched when disabled", () => {
    // A container that is not currently acting as a toolbar must not have its
    // children pulled out of the tab order behind the caller's back.
    render(<Toolbar labels={["a", "b", "c"]} enabled={false} />);
    expect(tabIndexes().every((t) => t === 0)).toBe(true);
  });

  it("keeps exactly one tab stop when the control set changes shape", () => {
    // These toolbars are conditional by nature — Up one level appears on
    // re-root, the viewer's actions come and go with the selection — so a hook
    // that only assigned tabindex once would strand the stop on a removed node.
    render(<Growing />);
    expect(tabIndexes().filter((t) => t === 0)).toHaveLength(1);

    fireEvent.click(screen.getByText("toggle"));
    expect(screen.getByText("middle")).toBeTruthy();
    expect(tabIndexes().filter((t) => t === 0)).toHaveLength(1);

    fireEvent.click(screen.getByText("toggle"));
    expect(tabIndexes().filter((t) => t === 0)).toHaveLength(1);
  });

  it("moves the tab stop to a clicked control even with no re-render", () => {
    // The repair cannot wait for a commit: a descendant can re-render alone, so
    // clicking a control the row marks `tabindex="-1"` would otherwise leave
    // focus on an untabbable element — the exact state that lets Tab escape a
    // focus trap, which excludes negative tabindex when computing its boundary.
    render(<Toolbar labels={["a", "b", "c"]} />);
    const c = screen.getByText("c");
    expect(c.tabIndex).toBe(-1);

    fireEvent.focus(c, { target: c });
    c.focus();

    expect(c.tabIndex).toBe(0);
    expect(screen.getByText("a").tabIndex).toBe(-1);
    expect(tabIndexes().filter((t) => t === 0)).toHaveLength(1);
  });

  it("leaves the tab stop on the control that holds focus after a click", () => {
    // Clicking focuses without going through the arrow handler, so the
    // remembered index is stale by the time the re-render's effect runs. Handing
    // the stop to some other control would set `tabindex="-1"` on the focused
    // one — and `TABBABLE_SELECTOR` excludes negative tabindex, so AppDialog's
    // trap would stop recognising it as the row's last element and let Tab walk
    // out of the modal.
    render(<Growing />);
    const toggle = screen.getByText("toggle");
    toggle.focus();

    fireEvent.click(toggle);

    expect(document.activeElement).toBe(toggle);
    expect(toggle.tabIndex).toBe(0);
    expect(tabIndexes().filter((t) => t === 0)).toHaveLength(1);
  });

  it("keeps the stop with the focused control when one appears ahead of it", () => {
    // A control inserted before the focused one shifts every index after it, so
    // a remembered index now names the wrong button. Keyed by label, so React
    // reconciles "c" to the same node and it keeps focus across the re-render.
    const { rerender } = render(<Toolbar labels={["a", "b", "c"]} />);
    screen.getByText("c").focus();

    rerender(<Toolbar labels={["a", "new", "b", "c"]} />);

    expect(document.activeElement).toBe(screen.getByText("c"));
    expect(screen.getByText("c").tabIndex).toBe(0);
    expect(tabIndexes().filter((t) => t === 0)).toHaveLength(1);
  });
});
