// @vitest-environment jsdom
/**
 * A dialog-hosted plugin panel offers Reload panel from the dialog header,
 * which has no overflow menu to carry it (#12611). The kinds that share the
 * generic menu but cannot remount a view — and PTY-backed plugin kinds, which
 * are terminals — get no button.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, fireEvent, screen, cleanup } from "@testing-library/react";

const StubPane = vi.hoisted(() => () => null);

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
  const AppDialog = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
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

const dispatch = vi.hoisted(() =>
  vi.fn<(id: string, args: unknown, opts: unknown) => Promise<void>>(() => Promise.resolve())
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args: unknown, opts: unknown) => dispatch(id, args, opts),
  },
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

const { registerPanelKind } = await import("@shared/config/panelKindRegistry");
for (const [id, hasPty] of [
  ["acme.dashboard", false],
  ["acme.shell", true],
] as const) {
  registerPanelKind({
    id,
    name: id,
    iconId: "terminal",
    color: "#abcdef",
    hasPty,
    canRestart: false,
    canConvert: false,
    extensionId: "acme",
  });
}

const { usePanelDialogStore } = await import("@/store/panelDialogStore");
const { PanelDialogHost } = await import("../PanelDialogHost");

function renderDialogFor(kind: string): void {
  const id = `${kind}-1`;
  panelsById.current = { [id]: { id, kind, title: kind } };
  render(<PanelDialogHost />);
  act(() => {
    usePanelDialogStore.setState({ dialogStack: [id] });
  });
}

describe("PanelDialogHost Reload panel (#12611)", () => {
  beforeEach(() => {
    cleanup();
    dispatch.mockClear();
    panelsById.current = {};
    usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
  });

  it("reloads a hosted plugin panel by its id", () => {
    renderDialogFor("acme.dashboard");

    fireEvent.click(screen.getByTestId("panel-dialog-reload"));

    expect(dispatch).toHaveBeenCalledWith(
      "plugin.reloadPanel",
      { panelId: "acme.dashboard-1" },
      { source: "user" }
    );
  });

  it.each(["file-browser", "diff", "acme.shell"])("offers no reload for %s", (kind) => {
    renderDialogFor(kind);

    expect(screen.getByTestId("dialog")).toBeTruthy();
    expect(screen.queryByTestId("panel-dialog-reload")).toBeNull();
  });
});
