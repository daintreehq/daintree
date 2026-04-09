// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeSelector } from "../ThemeSelector";

interface TestItem {
  id: string;
  name: string;
}

const items: TestItem[] = [
  { id: "alpha", name: "Alpha Theme" },
  { id: "beta", name: "Beta Theme" },
  { id: "gamma", name: "Gamma Theme" },
];

const defaultProps = {
  items,
  selectedId: "alpha",
  onSelect: vi.fn(),
  renderPreview: (item: TestItem) => <div data-testid={`preview-${item.id}`}>Preview</div>,
  getName: (item: TestItem) => item.name,
};

describe("ThemeSelector", () => {
  it("renders all items", () => {
    render(<ThemeSelector {...defaultProps} />);
    expect(screen.getByText("Alpha Theme")).toBeTruthy();
    expect(screen.getByText("Beta Theme")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("renders preview for each item", () => {
    render(<ThemeSelector {...defaultProps} />);
    expect(screen.getByTestId("preview-alpha")).toBeTruthy();
    expect(screen.getByTestId("preview-beta")).toBeTruthy();
    expect(screen.getByTestId("preview-gamma")).toBeTruthy();
  });

  it("marks selected item with aria-selected", () => {
    render(<ThemeSelector {...defaultProps} selectedId="beta" />);
    const options = screen.getAllByRole("option");
    const selected = options.find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toBeTruthy();
    expect(selected!.textContent).toContain("Beta Theme");
  });

  it("calls onSelect with id and click origin when item is clicked", () => {
    const onSelect = vi.fn();
    render(<ThemeSelector {...defaultProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Gamma Theme"), { clientX: 123, clientY: 456 });
    expect(onSelect).toHaveBeenCalledWith("gamma", { x: 123, y: 456 });
  });

  it("filters items by search query (case-insensitive)", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes...");
    fireEvent.change(input, { target: { value: "beta" } });

    expect(screen.queryByText("Alpha Theme")).toBeNull();
    expect(screen.getByText("Beta Theme")).toBeTruthy();
    expect(screen.queryByText("Gamma Theme")).toBeNull();
  });

  it("shows empty state when no items match search", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes...");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    expect(screen.getByText("No themes match your search.")).toBeTruthy();
  });

  it("clears search on Escape key", () => {
    render(<ThemeSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Filter themes...");
    fireEvent.change(input, { target: { value: "beta" } });
    expect(screen.queryByText("Alpha Theme")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Alpha Theme")).toBeTruthy();
    expect(screen.getByText("Beta Theme")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("renders group labels when groups are provided", () => {
    render(
      <ThemeSelector
        {...defaultProps}
        items={undefined}
        groups={[
          { label: "Dark", items: [items[0], items[1]] },
          { label: "Light", items: [items[2]] },
        ]}
      />
    );
    expect(screen.getByText("Dark")).toBeTruthy();
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Alpha Theme")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("filters within groups", () => {
    render(
      <ThemeSelector
        {...defaultProps}
        items={undefined}
        groups={[
          { label: "Dark", items: [items[0], items[1]] },
          { label: "Light", items: [items[2]] },
        ]}
      />
    );
    const input = screen.getByPlaceholderText("Filter themes...");
    fireEvent.change(input, { target: { value: "gamma" } });

    expect(screen.queryByText("Dark")).toBeNull();
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Gamma Theme")).toBeTruthy();
  });

  it("uses renderMeta when provided", () => {
    render(
      <ThemeSelector
        {...defaultProps}
        renderMeta={(item) => <span data-testid={`meta-${item.id}`}>{item.name} (custom)</span>}
      />
    );
    expect(screen.getByTestId("meta-alpha")).toBeTruthy();
    expect(screen.getByText("Alpha Theme (custom)")).toBeTruthy();
  });

  it("renders search input with correct aria-label", () => {
    render(<ThemeSelector {...defaultProps} />);
    expect(screen.getByLabelText("Filter themes")).toBeTruthy();
  });
});
