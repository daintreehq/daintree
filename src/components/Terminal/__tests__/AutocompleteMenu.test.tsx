// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
});
