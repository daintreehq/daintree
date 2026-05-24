/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ExistingBranchPicker } from "../ExistingBranchPicker";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(cleanup);

function renderPicker(overrides: Partial<Parameters<typeof ExistingBranchPicker>[0]> = {}) {
  return render(
    <ExistingBranchPicker
      open
      onOpenChange={() => {}}
      selectedBranch={null}
      query=""
      onQueryChange={() => {}}
      filteredBranches={[]}
      onSelect={() => {}}
      {...overrides}
    />
  );
}

describe("ExistingBranchPicker empty states", () => {
  it("renders zero-data EmptyState when no branches and no query", () => {
    const { container } = renderPicker({ query: "", filteredBranches: [] });
    expect(screen.getByText("No available local branches")).toBeTruthy();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[aria-describedby]")).toBeNull();
  });

  it("renders filtered-empty EmptyState with interpolated query", () => {
    renderPicker({ query: "feature/foo", filteredBranches: [] });
    expect(screen.getByText('No matches for "feature/foo"')).toBeTruthy();
  });

  it("falls back to zero-data copy for whitespace-only query", () => {
    renderPicker({ query: "   ", filteredBranches: [] });
    expect(screen.getByText("No available local branches")).toBeTruthy();
  });
});
