// @vitest-environment jsdom
import { render, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { BrowserToolbar } from "../BrowserToolbar";

const sectionProps = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
const pluginHook = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/store/urlHistoryStore", () => ({
  useUrlHistoryStore: () => ({ entries: [] }),
  getFrecencySuggestions: () => [],
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
}));
vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: unknown) => unknown) =>
    selector({ panelsById: { "panel-1": { kind: "dev-preview" } } }),
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: pluginHook,
}));
vi.mock("@/components/Plugin/PluginContextMenuSection", () => ({
  PluginContextMenuSection: (props: Record<string, unknown>) => {
    sectionProps.calls.push(props);
    return <div data-testid="plugin-section" />;
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function openMoreMenu(getByTestId: (id: string) => HTMLElement) {
  const trigger = getByTestId("browser-more-actions");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

const props = {
  terminalId: "panel-1",
  url: "http://user:secret@localhost:5173/app?x=1",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  onNavigate: vi.fn(),
  onBack: vi.fn(),
  onForward: vi.fn(),
  onReload: vi.fn(),
  onOpenExternal: vi.fn(),
  canOpenExternal: true,
  onToggleDevTools: vi.fn(),
};

describe("BrowserToolbar plugin page-menu items", () => {
  beforeEach(() => {
    sectionProps.calls.length = 0;
    pluginHook.mockReset();
    pluginHook.mockReturnValue([
      { pluginId: "acme", item: { actionId: "acme.go", label: "Go", location: "browser" } },
    ]);
  });

  it("asks for the browser location with the panel's keys", () => {
    render(<BrowserToolbar {...props} />);
    expect(pluginHook).toHaveBeenCalledWith("browser", {
      panelId: "panel-1",
      panelKind: "dev-preview",
    });
  });

  it("hands items the panel, its kind and the page URL without credentials", async () => {
    const { getByTestId } = render(<BrowserToolbar {...props} />);
    openMoreMenu(getByTestId);
    await waitFor(() => expect(sectionProps.calls.length).toBeGreaterThan(0));
    expect(sectionProps.calls.at(-1)?.dispatchArgs).toEqual({
      panelId: "panel-1",
      panelKind: "dev-preview",
      url: "http://localhost:5173/app?x=1",
    });
  });
});
