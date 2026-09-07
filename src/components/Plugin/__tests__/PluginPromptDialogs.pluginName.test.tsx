// @vitest-environment jsdom
/**
 * Both imperative prompt dialogs attribute the prompt to a plugin by name. The
 * id they are handed is the host's plugin *instance* key, so for a
 * project-owned plugin the raw value is `project__{projectId}__{manifestId}` —
 * a machine-local project id that must never reach user-facing copy (#12211).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useEscapeStack: () => {}, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/store/paletteStore", () => {
  const usePaletteStore = (selector?: (s: { activePaletteId: null }) => unknown) =>
    selector ? selector({ activePaletteId: null }) : { activePaletteId: null };
  usePaletteStore.getState = () => ({ activePaletteId: null });
  return { usePaletteStore };
});

import { PluginInputBoxDialog } from "../PluginInputBoxDialog";
import { PluginQuickPickDialog } from "../PluginQuickPickDialog";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import {
  _resetPluginRuntimeStoreForTest,
  usePluginRuntimeStore,
  type PluginRuntimeMeta,
} from "@/store/pluginRuntimeStore";

const INSTANCE_KEY = "project__b6700c7a__gregpriday.video-manager";

function seedMeta(entries: Array<[string, PluginRuntimeMeta]>): void {
  usePluginRuntimeStore.setState({ pluginMetaById: new Map(entries) });
}

function seedInputBoxPrompt(pluginId: string): void {
  usePluginPromptStore.setState({
    queue: [],
    current: {
      promptId: "p1",
      pluginId,
      params: { kind: "inputBox", options: { title: "Name it" } },
      resolve: () => {},
    },
  });
}

function seedQuickPickPrompt(pluginId: string): void {
  usePluginPromptStore.setState({
    queue: [],
    current: {
      promptId: "p1",
      pluginId,
      // No items: the empty message is the copy under test.
      params: { kind: "quickPick", items: [], options: { title: "Pick one" } },
      resolve: () => {},
    },
  });
}

afterEach(() => {
  cleanup();
  usePluginPromptStore.getState().reset();
  _resetPluginRuntimeStoreForTest();
});

describe("PluginInputBoxDialog — plugin attribution", () => {
  it("names a project plugin by its display name, not its instance key", () => {
    seedMeta([[INSTANCE_KEY, { devMode: false, displayName: "Video Manager" }]]);
    seedInputBoxPrompt(INSTANCE_KEY);

    render(<PluginInputBoxDialog />);

    expect(screen.queryByText("Requested by the 'Video Manager' plugin")).not.toBeNull();
    expect(document.body.textContent).not.toContain("project__b6700c7a__");
  });

  it("falls back to the manifest id before the runtime snapshot lands", () => {
    seedInputBoxPrompt(INSTANCE_KEY);

    render(<PluginInputBoxDialog />);

    expect(screen.queryByText("Requested by the 'gregpriday.video-manager' plugin")).not.toBeNull();
    expect(document.body.textContent).not.toContain("project__b6700c7a__");
  });
});

describe("PluginQuickPickDialog — plugin attribution", () => {
  it("names a project plugin by its display name in the empty message", () => {
    seedMeta([[INSTANCE_KEY, { devMode: false, displayName: "Video Manager" }]]);
    seedQuickPickPrompt(INSTANCE_KEY);

    render(<PluginQuickPickDialog />);

    expect(document.body.textContent).toContain(
      "No options provided by the 'Video Manager' plugin"
    );
    expect(document.body.textContent).not.toContain("project__b6700c7a__");
  });

  it("falls back to the manifest id before the runtime snapshot lands", () => {
    seedQuickPickPrompt(INSTANCE_KEY);

    render(<PluginQuickPickDialog />);

    expect(document.body.textContent).toContain(
      "No options provided by the 'gregpriday.video-manager' plugin"
    );
    expect(document.body.textContent).not.toContain("project__b6700c7a__");
  });
});
