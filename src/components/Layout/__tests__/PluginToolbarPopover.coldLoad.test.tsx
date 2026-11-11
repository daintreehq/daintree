// @vitest-environment jsdom
// Its own file so its module cache starts cold: the hosted-view chunk loads on
// the first popover opened here and no sooner (#16802).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import { primeRadix } from "@/components/ui/radix-loader";

const h = vi.hoisted(() => {
  let release: () => void = () => {};
  const chunk = new Promise<void>((resolve) => (release = resolve));
  return { chunk, release: () => release(), imported: vi.fn() };
});

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => undefined,
  useShortcutHintHover: () => ({}),
  useEffectiveCombo: () => "",
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

// Held back until the test lets the chunk land.
vi.mock("@/components/Plugin/PluginHostedView", async () => {
  h.imported();
  await h.chunk;
  return {
    PluginHostedView: ({ onClose }: { onClose?: () => void }) => (
      <div data-testid="plugin-view">
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    ),
  };
});

const { PluginToolbarButton } = await import("../PluginTrayButton");

const KIND_ID = "acme.inbox.inbox";

function kind(): PanelKindConfig {
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
  };
}

const config: ToolbarButtonConfig = {
  id: "acme.inbox.open",
  label: "Inbox",
  iconId: "package",
  priority: 3,
  pluginId: "acme.inbox",
  popover: { viewId: "inbox", panelKindId: KIND_ID },
};

const popover = () => document.querySelector<HTMLElement>('[data-testid="plugin-toolbar-popover"]');

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(async () => {
  await primeRadix();
  registerPanelKind(kind());
});

afterEach(() => {
  cleanup();
});

describe("plugin toolbar popover, first open (#16802)", () => {
  it("opens and hands focus back while the view's chunk is still loading, then draws the view in later openings' first commit", async () => {
    render(<PluginToolbarButton pluginId="acme.inbox.open" config={config} />);
    const button = screen.getByRole("button", { name: "Inbox" });
    // Nothing loads for a toolbar that has only been drawn.
    expect(h.imported).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(button);
    });
    const content = popover();
    if (content === null) throw new Error("Missing popover");
    expect(screen.queryByTestId("plugin-view")).toBeNull();
    expect(content.contains(document.activeElement)).toBe(true);

    await act(async () => {
      fireEvent.keyDown(content, { key: "Escape" });
    });
    await flush();
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(button);

    await act(async () => h.release());
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByTestId("plugin-view")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));

    unregisterPanelKind(KIND_ID);
  });
});
