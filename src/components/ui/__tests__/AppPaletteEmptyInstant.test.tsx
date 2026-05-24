// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lets each test dictate what the deferred query lags behind, so we can
// deterministically exercise the `trimmedQuery !== deferredTrimmedQuery`
// staleness branch without depending on the concurrent scheduler's timing.
let deferQuery: (value: string) => string = (value) => value;

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useDeferredValue: (value: string) => deferQuery(value),
  };
});

const emptyStateProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/ui/EmptyState", () => ({
  EmptyState: (props: Record<string, unknown>) => {
    emptyStateProps.push(props);
    return <div data-instant={String(props.instant)}>{props.title as string}</div>;
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

import { AppPaletteDialog } from "../AppPaletteDialog";

const lastProps = () => emptyStateProps[emptyStateProps.length - 1];

describe("AppPaletteDialog.Empty instant derivation", () => {
  beforeEach(() => {
    emptyStateProps.length = 0;
    deferQuery = (value) => value;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses the fade (instant) when the query is mid-keystroke stale", () => {
    // Deferred value lags behind the urgent query -> the user is still typing.
    deferQuery = (value) => (value === "foo" ? "fo" : value);
    render(<AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />);
    expect(lastProps().instant).toBe(true);
    expect(lastProps().variant).toBe("filtered-empty");
  });

  it("keeps the fade when the deferred query has caught up to the urgent query", () => {
    // deferQuery is identity -> deferred === urgent -> not stale.
    render(<AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />);
    expect(lastProps().instant).toBe(false);
    expect(lastProps().variant).toBe("filtered-empty");
  });

  it("keeps the fade on the zero-data branch when the input is cleared (length guard)", () => {
    // Input cleared to "" while the deferred value still lags on "foo": stale by
    // string comparison, but the length guard must keep instant false so the
    // crossfade back to the zero-data state still plays.
    deferQuery = () => "foo";
    render(<AppPaletteDialog.Empty query="" emptyMessage="No items available" />);
    expect(lastProps().instant).toBe(false);
    expect(lastProps().variant).toBe("zero-data");
  });

  it("keeps the fade on the steady zero-data state", () => {
    render(<AppPaletteDialog.Empty query="" emptyMessage="No items available" />);
    expect(lastProps().instant).toBe(false);
    expect(lastProps().variant).toBe("zero-data");
  });

  it("treats a whitespace-only query as zero-data with the fade intact", () => {
    // trim() collapses "   " to "" -> zero-data branch, and the length guard
    // keeps instant false even while the deferred value lags on "foo".
    deferQuery = () => "foo";
    render(<AppPaletteDialog.Empty query="   " emptyMessage="No items available" />);
    expect(lastProps().instant).toBe(false);
    expect(lastProps().variant).toBe("zero-data");
  });
});
