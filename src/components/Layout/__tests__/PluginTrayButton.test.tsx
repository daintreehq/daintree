// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId, ToolbarButtonPriority } from "@shared/types/toolbar";

const dispatchMock = vi.fn();
const setPluginButtonPromotedMock = vi.fn();
const refreshRuntimeMock = vi.fn();

let mockPinnedButtons: Record<string, boolean> = {};
let mockPluginMetaById = new Map<string, { devMode: boolean; displayName: string }>();

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

type MockToolbarStoreState = {
  layout: { pinnedButtons: Record<string, boolean> };
  setPluginButtonPromoted: typeof setPluginButtonPromotedMock;
  toggleButtonVisibility: () => void;
};

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (selector: (s: MockToolbarStoreState) => unknown) =>
    selector({
      layout: { pinnedButtons: mockPinnedButtons },
      setPluginButtonPromoted: setPluginButtonPromotedMock,
      toggleButtonVisibility: () => {},
    }),
}));

type MockRuntimeStoreState = {
  pluginMetaById: Map<string, { devMode: boolean; displayName: string }>;
};

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: Object.assign(
    (selector: (s: MockRuntimeStoreState) => unknown) =>
      selector({ pluginMetaById: mockPluginMetaById }),
    { getState: () => ({ refresh: refreshRuntimeMock }) }
  ),
}));

let mockKeybindingDisplay: Record<string, string | null> = {};

vi.mock("@/hooks", () => ({
  useKeybindingDisplay: (actionId: string) => mockKeybindingDisplay[actionId] ?? null,
  useAriaKeyshortcuts: () => undefined,
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
}));

vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: ({ buttonId, onUnpin }: { buttonId: string; onUnpin?: () => void }) => (
    <button data-testid="toolbar-context-items" data-button-id={buttonId} onClick={onUnpin}>
      unpin
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-group">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-label">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    onKeyDown,
    ...props
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={(e) => onSelect?.(e as unknown as Event)}
      onKeyDown={onKeyDown}
      {...props}
    >
      {children}
    </div>
  ),
  DropdownMenuActionItem: ({
    actionId,
    args,
    children,
  }: {
    actionId: string;
    args?: unknown;
    children: React.ReactNode;
  }) => (
    <div role="menuitem" data-action-id={actionId} data-args={JSON.stringify(args)}>
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="menu-shortcut">{children}</span>
  ),
}));

const { PluginTrayButton, PluginToolbarButton, groupPluginToolbarButtons } =
  await import("../PluginTrayButton");

function config(
  overrides: Omit<Partial<ToolbarButtonConfig>, "id"> & { id: string }
): ToolbarButtonConfig {
  return {
    id: overrides.id as PluginToolbarButtonId,
    label: overrides.label ?? overrides.id,
    iconId: overrides.iconId ?? "sparkles",
    actionId: overrides.actionId ?? `${overrides.id}.action`,
    priority: (overrides.priority ?? 3) as ToolbarButtonPriority,
    pluginId: overrides.pluginId ?? "acme",
  };
}

function configMap(...configs: ToolbarButtonConfig[]): Map<string, ToolbarButtonConfig> {
  return new Map(configs.map((c) => [c.id, c]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPinnedButtons = {};
  mockPluginMetaById = new Map();
  mockKeybindingDisplay = {};
});

describe("groupPluginToolbarButtons", () => {
  it("groups by the authoritative pluginId, not by splitting the dotted button id", () => {
    // `zeta.tools` owns a button whose id splits to a different prefix than
    // its pluginId — id-splitting would file it under the wrong plugin.
    const groups = groupPluginToolbarButtons(
      configMap(
        config({ id: "zeta.tools.a", pluginId: "zeta.tools" }),
        config({ id: "zeta.b", pluginId: "zeta" })
      ),
      (id) => id
    );

    expect(groups.map((g) => g.pluginId)).toEqual(["zeta", "zeta.tools"]);
    expect(groups.find((g) => g.pluginId === "zeta.tools")?.buttons.map((b) => b.id)).toEqual([
      "zeta.tools.a",
    ]);
  });

  it("orders rows within a group by manifest priority, ascending", () => {
    const groups = groupPluginToolbarButtons(
      configMap(
        config({ id: "acme.late", priority: 5 }),
        config({ id: "acme.early", priority: 1 }),
        config({ id: "acme.mid", priority: 3 })
      ),
      (id) => id
    );

    expect(groups[0]!.buttons.map((b) => b.id)).toEqual(["acme.early", "acme.mid", "acme.late"]);
  });

  it("breaks priority ties deterministically so a re-broadcast cannot reshuffle rows", () => {
    const build = (ids: string[]) =>
      groupPluginToolbarButtons(
        configMap(...ids.map((id) => config({ id, priority: 3, label: id.split(".")[1]! }))),
        (id) => id
      )[0]!.buttons.map((b) => b.id);

    // Same set, opposite insertion order — the output must match.
    expect(build(["acme.beta", "acme.alpha"])).toEqual(build(["acme.alpha", "acme.beta"]));
  });

  it("sorts groups by resolved display name, not plugin load order", () => {
    const groups = groupPluginToolbarButtons(
      configMap(config({ id: "zzz.a", pluginId: "zzz" }), config({ id: "aaa.b", pluginId: "aaa" })),
      (id) => (id === "zzz" ? "Alpha tools" : "Zebra tools")
    );

    expect(groups.map((g) => g.displayName)).toEqual(["Alpha tools", "Zebra tools"]);
  });
});

describe("PluginTrayButton", () => {
  it("renders nothing when no plugin contributes a toolbar button", () => {
    const { container } = render(<PluginTrayButton configs={new Map()} />);
    expect(container.innerHTML).toBe("");
  });

  it("labels each group with the plugin display name, falling back to the plugin id", () => {
    mockPluginMetaById = new Map([["acme", { devMode: false, displayName: "Acme Tools" }]]);

    const { getAllByTestId } = render(
      <PluginTrayButton
        configs={configMap(
          config({ id: "acme.a", pluginId: "acme" }),
          config({ id: "unknown.b", pluginId: "unknown" })
        )}
      />
    );

    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Acme Tools");
    expect(labels).toContain("unknown");
  });

  it("keeps a promoted contribution listed in the tray", () => {
    mockPinnedButtons = { "acme.a": true };

    const { getByTestId } = render(
      <PluginTrayButton configs={configMap(config({ id: "acme.a", label: "Ping" }))} />
    );

    // Promotion adds a top-level access point; it must not remove the row.
    expect(getByTestId("plugin-tray-row-acme.a")).toBeTruthy();
    expect(getByTestId("plugin-tray-pin-acme.a").getAttribute("data-pinned")).toBe("true");
  });

  it("dispatches the contribution's actionId when its row is chosen", () => {
    const { getByTestId } = render(
      <PluginTrayButton configs={configMap(config({ id: "acme.a", actionId: "acme.greet" }))} />
    );

    fireEvent.click(getByTestId("plugin-tray-row-acme.a"));

    expect(dispatchMock).toHaveBeenCalledWith("acme.greet", undefined, { source: "user" });
  });

  it("promotes via the pin affordance without dispatching the row action", () => {
    const { getByTestId } = render(
      <PluginTrayButton configs={configMap(config({ id: "acme.a", actionId: "acme.greet" }))} />
    );

    fireEvent.click(getByTestId("plugin-tray-pin-acme.a"));

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.a", true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("demotes an already-promoted contribution", () => {
    mockPinnedButtons = { "acme.a": true };
    const { getByTestId } = render(
      <PluginTrayButton configs={configMap(config({ id: "acme.a" }))} />
    );

    fireEvent.click(getByTestId("plugin-tray-pin-acme.a"));

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.a", false);
  });

  it("toggles promotion from the keyboard via P", () => {
    const { getByTestId } = render(
      <PluginTrayButton configs={configMap(config({ id: "acme.a", actionId: "acme.greet" }))} />
    );

    fireEvent.keyDown(getByTestId("plugin-tray-row-acme.a"), { key: "P" });

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.a", true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("shows the contribution's keyboard shortcut when one is bound", () => {
    mockKeybindingDisplay = { "acme.greet": "⌘⇧G" };
    const { getByTestId } = render(
      <PluginTrayButton configs={configMap(config({ id: "acme.a", actionId: "acme.greet" }))} />
    );

    expect(getByTestId("menu-shortcut").textContent).toBe("⌘⇧G");
  });

  it("right-click targets the tray itself, not an individual contribution", () => {
    const { getByTestId } = render(
      <PluginTrayButton configs={configMap(config({ id: "acme.a" }))} />
    );

    expect(getByTestId("toolbar-context-items").getAttribute("data-button-id")).toBe("plugin-tray");
  });
});

describe("PluginToolbarButton (promoted contribution)", () => {
  it("unpinning demotes rather than writing a hide entry", () => {
    // Under tray-default semantics only an explicit `true` grants the
    // top-level slot, so the store's generic hide toggle would leave the
    // button promoted and visibly stuck.
    const { getByTestId } = render(
      <PluginToolbarButton
        pluginId={"acme.a" as PluginToolbarButtonId}
        config={config({ id: "acme.a" })}
      />
    );

    fireEvent.click(getByTestId("toolbar-context-items"));

    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith("acme.a", false);
  });

  it("dispatches its action and names itself from the contribution label", () => {
    const { getByRole } = render(
      <PluginToolbarButton
        pluginId={"acme.a" as PluginToolbarButtonId}
        config={config({ id: "acme.a", label: "Hello ping", actionId: "acme.greet" })}
      />
    );

    const button = getByRole("button", { name: "Hello ping" });
    fireEvent.click(button);

    expect(dispatchMock).toHaveBeenCalledWith("acme.greet", undefined, { source: "user" });
  });
});
