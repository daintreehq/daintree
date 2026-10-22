// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";
import { primeRadix } from "@/components/ui/radix-loader";
import { APP_DIALOG_SURFACE_ATTR } from "@/lib/appDialogSurface";
import { ESCAPE_BACKSTOP_DIALOG_ATTR } from "@/lib/dialogEscapeBackstop";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  mounts: [] as Array<{ host: string; mountId: string; kindId: string }>,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => h.dispatch(...args) },
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => undefined,
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ layout: { pinnedButtons: {} }, setPluginButtonPromoted: () => {} }),
}));

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ pluginMetaById: new Map() }),
    { getState: () => ({ refresh: () => {} }) }
  ),
}));

vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: () => null,
}));

// The real loader imports a `plugin://` module over IPC and has its own suites;
// here the view is a stand-in that can close its host, as a plugin's would.
vi.mock("@/components/Plugin/PluginHostedView", () => ({
  PluginHostedView: ({
    source,
    host,
    mountId,
    onClose,
  }: {
    source: { config: { id: string } };
    host: string;
    mountId: string;
    onClose?: () => void;
  }) => {
    h.mounts.push({ host, mountId, kindId: source.config.id });
    return (
      <div data-testid="plugin-view" data-host={host}>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    );
  },
}));

const { PluginToolbarButton, PluginTrayButton } = await import("../PluginTrayButton");
const { usePluginToolbarPopoverStore } = await import("@/store/pluginToolbarPopoverStore");

const KIND_ID = "acme.inbox.inbox";

function kind(overrides: Partial<PanelKindConfig> = {}): PanelKindConfig {
  return {
    id: KIND_ID,
    name: "Inbox",
    iconId: "puzzle",
    color: "#ffffff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "acme.inbox",
    componentPath: "plugin://acme.inbox/1/inbox.js",
    ...overrides,
  };
}

function popoverButton(id: PluginToolbarButtonId, label = "Inbox"): ToolbarButtonConfig {
  return {
    id,
    label,
    iconId: "package",
    priority: 3,
    pluginId: "acme.inbox",
    popover: { viewId: "inbox", panelKindId: KIND_ID },
  };
}

function actionButton(id: PluginToolbarButtonId, label: string): ToolbarButtonConfig {
  return {
    id,
    label,
    iconId: "package",
    priority: 3,
    pluginId: "acme.inbox",
    actionId: `${id}.run`,
  };
}

const popovers = () => document.querySelectorAll('[data-testid="plugin-toolbar-popover"]');

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openTrayRow(trayButton: HTMLElement, rowName: string) {
  await act(async () => {
    trayButton.focus();
    fireEvent.keyDown(trayButton, { key: "Enter" });
  });
  await flush();
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(rowName) }));
  });
  // The menu's close hook runs once its focus scope unmounts.
  await flush();
  await flush();
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  h.dispatch.mockReset();
  h.mounts.length = 0;
  usePluginToolbarPopoverStore.setState({ opening: null });
  registerPanelKind(kind());
});

afterEach(() => {
  cleanup();
  unregisterPanelKind(KIND_ID);
  for (const el of document.querySelectorAll("[data-test-overlay]")) el.remove();
});

describe("plugin toolbar popover (#13784)", () => {
  it("opens the button's view from a promoted button, and the view can close it", async () => {
    render(
      <PluginToolbarButton pluginId={"acme.inbox.open"} config={popoverButton("acme.inbox.open")} />
    );
    const button = screen.getByRole("button", { name: "Inbox" });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(popovers()).toHaveLength(1);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const view = screen.getByTestId("plugin-view");
    expect(view.dataset.host).toBe("popover");
    expect(h.mounts.at(-1)?.kindId).toBe(KIND_ID);
    expect(h.dispatch).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(popovers()).toHaveLength(0);
    expect(usePluginToolbarPopoverStore.getState().opening).toBeNull();
  });

  it("toggles closed on a second click of the promoted button", async () => {
    render(
      <PluginToolbarButton pluginId={"acme.inbox.open"} config={popoverButton("acme.inbox.open")} />
    );
    const button = screen.getByRole("button", { name: "Inbox" });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(popovers()).toHaveLength(0);
  });

  it("keeps one popover open across buttons: opening another replaces it", async () => {
    render(
      <>
        <PluginToolbarButton
          pluginId={"acme.inbox.a"}
          config={popoverButton("acme.inbox.a", "First")}
        />
        <PluginToolbarButton
          pluginId={"acme.inbox.b"}
          config={popoverButton("acme.inbox.b", "Second")}
        />
      </>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "First" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Second" }));
    });
    expect(popovers()).toHaveLength(1);
    expect(popovers()[0]?.getAttribute("aria-label")).toBe("Second");
  });

  it("opens from a tray row off the tray button, and Escape hands focus back to it", async () => {
    const configs = new Map<string, ToolbarButtonConfig>([
      ["acme.inbox.open", popoverButton("acme.inbox.open")],
      ["acme.inbox.sync", actionButton("acme.inbox.sync", "Sync")],
    ]);
    render(<PluginTrayButton configs={configs} />);
    const tray = screen.getByRole("button", { name: "Plugin tray" });

    await openTrayRow(tray, "Inbox");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(popovers()).toHaveLength(1);
    expect(usePluginToolbarPopoverStore.getState().opening?.origin).toBe("tray");
    expect(h.dispatch).not.toHaveBeenCalled();

    const [content] = popovers();
    if (!(content instanceof HTMLElement)) throw new Error("Missing popover");
    await act(async () => {
      fireEvent.keyDown(content, { key: "Escape" });
    });
    await flush();
    expect(popovers()).toHaveLength(0);
    // The row went with the menu; the tray button is the control left to land on.
    expect(document.activeElement).toBe(tray);
  });

  it("still dispatches an action row from the tray", async () => {
    const configs = new Map<string, ToolbarButtonConfig>([
      ["acme.inbox.open", popoverButton("acme.inbox.open")],
      ["acme.inbox.sync", actionButton("acme.inbox.sync", "Sync")],
    ]);
    render(<PluginTrayButton configs={configs} />);
    await openTrayRow(screen.getByRole("button", { name: "Plugin tray" }), "Sync");
    expect(h.dispatch).toHaveBeenCalledWith("acme.inbox.sync.run", undefined, { source: "user" });
    expect(popovers()).toHaveLength(0);
  });

  it("stays open behind a dialog, and leaves that dialog its own Escape", async () => {
    render(
      <PluginToolbarButton pluginId={"acme.inbox.open"} config={popoverButton("acme.inbox.open")} />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    });

    // An `AppDialog` portals to the body, so to Radix every press and focus in
    // it is outside the popover that opened it.
    const dialog = document.createElement("div");
    dialog.setAttribute("data-test-overlay", "");
    dialog.setAttribute(APP_DIALOG_SURFACE_ATTR, "");
    dialog.setAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR, "");
    const field = document.createElement("input");
    dialog.appendChild(field);
    document.body.appendChild(dialog);

    await act(async () => {
      fireEvent.pointerDown(field, { pointerType: "mouse", button: 0, pointerId: 1 });
      field.focus();
    });
    await flush();
    expect(popovers()).toHaveLength(1);

    await act(async () => {
      fireEvent.keyDown(field, { key: "Escape" });
    });
    await flush();
    expect(popovers()).toHaveLength(1);
  });

  it("refuses a view its button's plugin did not register", async () => {
    unregisterPanelKind(KIND_ID);
    registerPanelKind(kind({ extensionId: "someone.else" }));
    render(
      <PluginToolbarButton pluginId={"acme.inbox.open"} config={popoverButton("acme.inbox.open")} />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    });
    expect(popovers()).toHaveLength(1);
    expect(screen.queryByTestId("plugin-view")).toBeNull();
    expect(screen.getByText("Inbox isn't available")).toBeTruthy();
  });

  it("closes when its button goes away, and ignores a close kept from an earlier opening", () => {
    const store = usePluginToolbarPopoverStore.getState();
    store.open("acme.inbox.a", "tray");
    const first = usePluginToolbarPopoverStore.getState().opening;
    store.open("acme.inbox.b", "tray");
    // The first opening's view kept its close; it must not end this one.
    store.close(first?.seq);
    expect(usePluginToolbarPopoverStore.getState().opening?.buttonId).toBe("acme.inbox.b");

    store.retain(new Set(["acme.inbox.b"]));
    expect(usePluginToolbarPopoverStore.getState().opening).not.toBeNull();
    store.retain(new Set(["acme.inbox.a"]));
    expect(usePluginToolbarPopoverStore.getState().opening).toBeNull();
  });
});
