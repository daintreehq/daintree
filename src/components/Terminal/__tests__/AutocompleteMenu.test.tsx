// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/components/ui/ScrollShadow", () => ({
  ScrollShadow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AutocompleteMenu, type AutocompleteItem } from "../AutocompleteMenu";

const noop = () => {};

describe("AutocompleteMenu", () => {
  it("returns nothing when isOpen is false", () => {
    const { container } = render(
      <AutocompleteMenu
        isOpen={false}
        items={[]}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an empty-state status row when items are empty and not loading", () => {
    render(
      <AutocompleteMenu
        isOpen={true}
        items={[]}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No files match"
      />
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("No files match");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("does not render the empty status row when isLoading is true", () => {
    render(
      <AutocompleteMenu
        isOpen={true}
        items={[]}
        selectedIndex={0}
        isLoading={true}
        onSelect={noop}
        emptyMessage="No files match"
      />
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("renders listbox with options when items are present", () => {
    const items: AutocompleteItem[] = [
      { key: "a", label: "alpha", value: "alpha" },
      { key: "b", label: "beta", value: "beta" },
    ];

    render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );

    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders a header with title and key hint when provided", () => {
    render(
      <AutocompleteMenu
        isOpen={true}
        items={[{ key: "a", label: "alpha", value: "alpha" }]}
        selectedIndex={0}
        onSelect={noop}
        title="Commands"
        keyHint="↵ run · ⇥ complete"
        emptyMessage="No matches"
      />
    );

    expect(screen.getByText("Commands")).toBeTruthy();
    expect(screen.getByText("↵ run · ⇥ complete")).toBeTruthy();
  });

  it("marks the listbox busy while results are stale or loading", () => {
    const items: AutocompleteItem[] = [{ key: "a", label: "alpha", value: "alpha" }];

    const { rerender } = render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        isStale={true}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        isStale={false}
        isLoading={true}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        isStale={false}
        isLoading={false}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBeNull();
  });

  it("renders a neutral, screen-reader-labeled badge for skill items only", () => {
    const items: AutocompleteItem[] = [
      { key: "s", label: "/commit", value: "/commit", category: "skill" },
      { key: "c", label: "/help", value: "/help", category: "command" },
    ];

    render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );

    const options = screen.getAllByRole("option");
    const skillRow = options.find((o) => within(o).queryByText("/commit"))!;
    const commandRow = options.find((o) => within(o).queryByText("/help"))!;

    // Skill row: visible badge is hidden from AT, paired with an sr-only label.
    expect(within(skillRow).getByText("Skill", { selector: "[aria-hidden='true']" })).toBeTruthy();
    expect(within(skillRow).getByText("Category: Skill")).toBeTruthy();

    // Command row carries no badge — plain by design.
    expect(
      within(commandRow).queryByText("Skill", { selector: "[aria-hidden='true']" })
    ).toBeNull();
    expect(within(commandRow).queryByText(/Category:/)).toBeNull();
  });

  it("scrolls the keyboard-selected option into view as selection moves", () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const items: AutocompleteItem[] = [
        { key: "a", label: "alpha", value: "alpha" },
        { key: "b", label: "beta", value: "beta" },
        { key: "c", label: "gamma", value: "gamma" },
      ];

      const { rerender } = render(
        <AutocompleteMenu
          isOpen={true}
          items={items}
          selectedIndex={0}
          onSelect={noop}
          emptyMessage="No matches"
        />
      );
      const callsAfterMount = scrollSpy.mock.calls.length;

      rerender(
        <AutocompleteMenu
          isOpen={true}
          items={items}
          selectedIndex={2}
          onSelect={noop}
          emptyMessage="No matches"
        />
      );

      expect(scrollSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
      expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      if (original === undefined) {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        Element.prototype.scrollIntoView = original;
      }
    }
  });
});
