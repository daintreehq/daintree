// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const mockUseDndPlaceholder = vi.fn();
vi.mock("../dndPlaceholderContext", () => ({
  useDndPlaceholder: () => mockUseDndPlaceholder(),
  GRID_PLACEHOLDER_ID: "__grid-placeholder__",
}));
vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-terminal-icon="" />,
}));
vi.mock("@dnd-kit/sortable", () => ({ useSortable: () => ({}) }));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));
vi.mock("framer-motion", () => ({
  m: { div: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
}));

import { GridPlaceholder } from "../GridPlaceholder";
import { DROP_SLOT_FRAME } from "../dropIndicator";

const panel = {
  id: "p1",
  kind: "browser",
  title: "localhost:5173",
  location: "grid",
  isVisible: true,
};

function root(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[aria-hidden='true']");
  if (!el) throw new Error("placeholder root not rendered");
  return el;
}

/**
 * "Where will it land" must never depend on knowing what is being dragged.
 * The fallback used to be a borderless wash that read as a hole in the grid;
 * now the slot keeps its frame and header bar and only the identity goes.
 */
describe("GridPlaceholder destination boundary", () => {
  it("draws the same frame whether or not the active panel is known", () => {
    mockUseDndPlaceholder.mockReturnValue({ activeTerminal: panel });
    const known = root(render(<GridPlaceholder />).container);
    mockUseDndPlaceholder.mockReturnValue({ activeTerminal: null });
    const unknown = root(render(<GridPlaceholder />).container);
    expect(unknown.className).toBe(known.className);
    expect(unknown.children.length).toBe(known.children.length);
    // Equal is not enough — both could be equally frameless.
    for (const cls of DROP_SLOT_FRAME.split(/\s+/)) {
      expect(known.className.split(/\s+/), cls).toContain(cls);
    }
  });

  it("carries identity only when it has it", () => {
    mockUseDndPlaceholder.mockReturnValue({ activeTerminal: panel });
    const known = render(<GridPlaceholder />).container;
    expect(known.textContent).toContain("localhost:5173");
    expect(known.querySelector("[data-terminal-icon]")).not.toBeNull();

    mockUseDndPlaceholder.mockReturnValue({ activeTerminal: null });
    const unknown = render(<GridPlaceholder />).container;
    expect(unknown.textContent).toBe("");
    expect(unknown.querySelector("[data-terminal-icon]")).toBeNull();
  });
});
