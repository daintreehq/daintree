// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const PLUGIN_ID = "daintree.markdown-editor";

const { dispatchMock, refreshMock, runtimeState } = vi.hoisted(() => {
  const init = () => {};
  return {
    dispatchMock: vi.fn(async () => ({ ok: true as const, result: undefined })),
    refreshMock: vi.fn(),
    runtimeState: {
      pluginMetaById: new Map([["daintree.markdown-editor", { displayName: "Markdown editor" }]]),
      disabledPluginIds: new Set(["daintree.markdown-editor"]),
      init,
    },
  };
});

vi.mock("@/registry/fileEditorRegistry", () => ({
  useResolvedFileEditor: () => ({
    id: "markdown",
    pluginId: PLUGIN_ID,
    slot: "markdown-editor",
    extensions: ["md"],
    maxBytes: 1_000_000,
  }),
}));

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: Object.assign(
    (selector: (state: typeof runtimeState) => unknown) => selector(runtimeState),
    { getState: () => ({ refresh: refreshMock }) }
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { FileEditorBanner } from "../FileEditorBanner";

const setEnabled = vi.fn(async () => {});
const list = vi.fn(async () => [
  { instanceId: PLUGIN_ID, disabled: false, pendingRestart: false, loadError: "boom" },
]);

beforeEach(() => {
  (window as unknown as { electron: unknown }).electron = { plugin: { setEnabled, list } };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("FileEditorBanner", () => {
  it("points a plugin that couldn't start at Settings → Plugins, and opens it", async () => {
    const onEdit = vi.fn();
    render(<FileEditorBanner filePath="/repo/README.md" content="# hi" onEdit={onEdit} />, {
      wrapper: TooltipProvider,
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("file-editor-hint-action"));
    });

    expect(setEnabled).toHaveBeenCalledWith(PLUGIN_ID, true);
    expect(onEdit).not.toHaveBeenCalled();
    // The page the message names is the one the button opens.
    const text = document.body.textContent ?? "";
    expect(text).toContain("Settings → Plugins");
    expect(text).not.toContain("Preferences");

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "plugins" },
      { source: "user" }
    );
  });
});
