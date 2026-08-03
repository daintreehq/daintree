// @vitest-environment jsdom
/**
 * The diff dialog must pin to full height like the file browser so stepping
 * between files doesn't resize and re-center the whole frame under the cursor
 * (#11364).
 *
 * The assertion is deliberately behavioral rather than a literal check: it reads
 * the className `PanelDialogHost` hands `AppDialog` for the real `diff`
 * definition and compares it against a known full-height kind (`file-browser`)
 * and a known content-height kind (`review`). Asserting the raw `h-[85vh]`
 * string would just copy the source-of-truth, which CLAUDE.md flags as
 * tautological; comparing behaviors instead catches a regression (diff losing
 * the flag) without pinning the literal.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

const StubPane = vi.hoisted(() => () => null);

// Derive `dialogFullHeight` from the real shared registry so the flag under
// test actually flows through — a blanket `{ component }` stub would drop it
// and the test would pass even without the fix.
vi.mock("@/panels/registry", async () => {
  const shared = await import("@shared/config/panelKindRegistry");
  // Built once and reused: `useSyncExternalStore` throws on a getSnapshot that
  // returns a fresh reference each call.
  let snapshot: Record<string, unknown> | undefined;
  return {
    subscribeToPanelKindDefinitions: () => () => {},
    getPanelKindDefinitionsSnapshot: () => {
      snapshot ??= Object.fromEntries(
        shared.getPanelKindIds().flatMap((id) => {
          const config = shared.getPanelKindConfig(id);
          return config ? [[id, { ...config, component: StubPane }] as const] : [];
        })
      );
      return snapshot;
    },
  };
});

vi.mock("@/components/ui/AppDialog", () => {
  // Surface the className the host passes as a DOM attribute, so the test reads
  // it back from the tree rather than writing to an outer variable in render.
  const AppDialog = ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="dialog" data-classname={className}>
      {children}
    </div>
  );
  AppDialog.Header = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.Title = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.CloseButton = () => <button>close</button>;
  AppDialog.BodyScroll = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return { AppDialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

const panelsById = vi.hoisted(() => ({
  current: {} as Record<string, { id: string; kind: string; title: string }>,
}));

vi.mock("@/store/panelStore", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
      useSyncExternalStore(
        () => () => {},
        () => selector({ panelsById: panelsById.current })
      ),
  };
});

const { usePanelDialogStore } = await import("@/store/panelDialogStore");
const { PanelDialogHost } = await import("../PanelDialogHost");

// Render one kind as a single-frame dialog and return the className the host
// passed AppDialog for it (null when the kind isn't pinned).
function classNameFor(kind: string): string | null {
  const id = `${kind}-1`;
  panelsById.current = { [id]: { id, kind, title: kind } };
  usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
  const { container, unmount } = render(<PanelDialogHost />);
  act(() => {
    usePanelDialogStore.setState({ dialogStack: [id] });
  });
  const result =
    container.querySelector('[data-testid="dialog"]')?.getAttribute("data-classname") ?? null;
  unmount();
  return result;
}

describe("PanelDialogHost full-height pinning (#11364)", () => {
  beforeEach(() => {
    panelsById.current = {};
    usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
  });

  it("pins the diff dialog to full height, matching the file browser", () => {
    const diff = classNameFor("diff");
    const fileBrowser = classNameFor("file-browser");
    expect(diff).not.toBeNull();
    expect(diff).toBe(fileBrowser);
  });

  it("leaves content-height kinds like review unpinned, so diff is treated differently", () => {
    const diff = classNameFor("diff");
    const review = classNameFor("review");
    expect(diff).not.toBe(review);
  });
});
