// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import { ScrollPill } from "../ScrollPill";

describe("ScrollPill", () => {
  it("renders a button with type=button by default", () => {
    render(
      <ScrollPill isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
  });

  it("forces type=button even if a caller passes type=submit", () => {
    const extra = { type: "submit" } as Record<string, unknown>;
    render(
      <ScrollPill isVisible translateDirection="down" {...extra}>
        hi
      </ScrollPill>
    );
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });

  it("uses scoped transition-[opacity,translate] and not bare transition", () => {
    // `translate` (not `transform`) because Tailwind v4 translate-* utilities
    // emit the individual `translate` property, which a `transform` entry in
    // the transition list does not cover.
    render(
      <ScrollPill isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("transition-[opacity,translate]");
    expect(button.className.split(/\s+/)).not.toContain("transition");
  });

  it("applies the visible resting state when isVisible is true", () => {
    render(
      <ScrollPill isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-100");
    expect(button.className).toContain("translate-y-0");
  });

  it("slides up when hidden with translateDirection=up", () => {
    render(
      <ScrollPill isVisible={false} translateDirection="up">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("-translate-y-2");
  });

  it("slides down when hidden with translateDirection=down", () => {
    render(
      <ScrollPill isVisible={false} translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("translate-y-2");
    expect(button.className.split(/\s+/)).not.toContain("-translate-y-2");
  });

  it("does not move vertically when hidden with translateDirection=none", () => {
    render(
      <ScrollPill isVisible={false} translateDirection="none">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("translate-y-0");
  });

  it("merges caller className after the baked classes", () => {
    render(
      <ScrollPill isVisible translateDirection="down" className="px-2 py-0.5 gap-1">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("px-2");
    expect(button.className).toContain("py-0.5");
    expect(button.className).toContain("gap-1");
    expect(button.className).toContain("rounded-full");
  });

  it("forwards onClick", () => {
    const onClick = vi.fn();
    render(
      <ScrollPill isVisible translateDirection="down" onClick={onClick}>
        hi
      </ScrollPill>
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("forwards the ref to the button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <ScrollPill ref={ref} isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("passes through aria-label and tabIndex", () => {
    render(
      <ScrollPill isVisible translateDirection="down" aria-label="Scroll to latest" tabIndex={-1}>
        hi
      </ScrollPill>
    );
    const button = screen.getByLabelText("Scroll to latest");
    expect(button.tabIndex).toBe(-1);
  });

  it("renders without a className without crashing", () => {
    render(
      <ScrollPill isVisible translateDirection="none">
        hi
      </ScrollPill>
    );
    expect(screen.getByRole("button").className).toContain("rounded-full");
  });
});
