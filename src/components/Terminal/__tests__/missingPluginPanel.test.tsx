// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MissingPluginPanel } from "@/components/Panel/MissingPluginPanel";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("MissingPluginPanel", () => {
  it("renders the kind identifier", () => {
    render(<MissingPluginPanel kind="some-plugin:custom-kind" onRemove={vi.fn()} />);

    const container = screen.getByTestId("missing-plugin-panel");
    expect(container.getAttribute("data-kind")).toBe("some-plugin:custom-kind");
    expect(screen.getByText("Kind: some-plugin:custom-kind")).toBeTruthy();
  });

  it("renders the 'Plugin not available' headline", () => {
    render(<MissingPluginPanel kind="x" onRemove={vi.fn()} />);
    expect(screen.getByText("Plugin not available")).toBeTruthy();
  });

  it("invokes onRemove when the remove button is clicked", () => {
    const onRemove = vi.fn();
    render(<MissingPluginPanel kind="x" onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: /remove panel/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("does not promise cross-session persistence", () => {
    render(<MissingPluginPanel kind="x" onRemove={vi.fn()} />);
    expect(screen.queryByText(/state is preserved/i)).toBeNull();
  });
});
