// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

let entries: PluginContextMenuItemEntry[] = [];
const hookMock = vi.fn((_location: string, _ctx?: unknown) => entries);
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: (location: string, ctx?: unknown) => hookMock(location, ctx),
}));

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: (
    selector: (s: { pluginMetaById: Map<string, { displayName: string }> }) => unknown
  ) => selector({ pluginMetaById: new Map([["acme.one", { displayName: "One Plugin" }]]) }),
}));

// Radix menus need an open portal; plain elements keep this on the component's
// own grouping, ordering and dispatch.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-testid="separator" />,
  ContextMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="label">{children}</div>
  ),
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sub">{children}</div>
  ),
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="trigger">{children}</div>
  ),
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ProjectPluginMenuItems } from "../ProjectPluginMenuItems";

function entry(pluginId: string, label: string, actionId: string): PluginContextMenuItemEntry {
  return { pluginId, item: { label, actionId, location: "project" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  entries = [];
});

describe("ProjectPluginMenuItems", () => {
  it("renders nothing when no plugin contributes a project item", () => {
    const { container } = render(<ProjectPluginMenuItems projectId="p1" />);
    expect(container.firstChild).toBeNull();
  });

  it("asks for the project location with the project id as when-context", () => {
    render(<ProjectPluginMenuItems projectId="p1" />);
    expect(hookMock).toHaveBeenCalledWith("project", { projectId: "p1" });
  });

  it("nests a single plugin's items under Extensions with no heading or separator", () => {
    entries = [entry("acme.one", "Do A", "acme.one.a")];
    render(<ProjectPluginMenuItems projectId="p1" />);
    expect(screen.getByTestId("trigger").textContent).toBe("Extensions");
    expect(screen.queryByTestId("label")).toBeNull();
    expect(screen.queryByTestId("separator")).toBeNull();
  });

  it("dispatches with the project id", () => {
    entries = [entry("acme.one", "Do A", "acme.one.a")];
    render(<ProjectPluginMenuItems projectId="p1" />);
    fireEvent.click(screen.getByText("Do A"));
    expect(dispatchMock).toHaveBeenCalledWith(
      "acme.one.a",
      { projectId: "p1" },
      expect.objectContaining({ source: expect.any(String) })
    );
  });

  it("groups by plugin with a heading each and one separator between groups", () => {
    entries = [
      entry("acme.one", "A1", "acme.one.a"),
      entry("acme.two", "B1", "acme.two.b"),
      entry("acme.one", "A2", "acme.one.c"),
    ];
    render(<ProjectPluginMenuItems projectId="p1" />);
    expect(screen.getAllByTestId("label").map((n) => n.textContent)).toEqual([
      "One Plugin",
      "acme.two",
    ]);
    expect(screen.getAllByTestId("separator")).toHaveLength(1);
    const text = screen.getByTestId("sub").textContent ?? "";
    expect(text.indexOf("A1")).toBeLessThan(text.indexOf("A2"));
    expect(text.indexOf("A2")).toBeLessThan(text.indexOf("B1"));
  });
});
