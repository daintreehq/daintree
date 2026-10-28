// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  let listener: ((config: unknown) => void) | null = null;
  return {
    onPanelGridConfigChanged: vi.fn((cb: (config: unknown) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    push: (config: unknown) => listener?.(config),
    hasListener: () => listener !== null,
  };
});

import {
  __resetPanelGridConfigSyncForTests,
  applyBootPanelGridConfig,
  beginPanelGridConfigRead,
  initPanelGridConfigSync,
} from "../panelGridConfigSync";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";

const grid = () => useLayoutConfigStore.getState().layoutConfig;

describe("initPanelGridConfigSync (#14700)", () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    __resetPanelGridConfigSyncForTests();
    useLayoutConfigStore.setState({ layoutConfig: { strategy: "automatic", value: 3 } });
    Object.defineProperty(window, "electron", {
      value: { app: bridge },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => dispose());

  it("takes the grid another view saved, and ignores a payload that isn't one", () => {
    dispose = initPanelGridConfigSync();

    bridge.push({ strategy: "fixed-columns", value: 4 });
    expect(grid()).toEqual({ strategy: "fixed-columns", value: 4 });

    bridge.push({ strategy: "diagonal", value: 2 });
    bridge.push(null);
    expect(grid()).toEqual({ strategy: "fixed-columns", value: 4 });
  });

  it("drops a boot payload or read that a saved change overtook", () => {
    const read = beginPanelGridConfigRead();
    dispose = initPanelGridConfigSync();
    bridge.push({ strategy: "fixed-rows", value: 2 });

    applyBootPanelGridConfig({ strategy: "automatic", value: 6 });
    read({ strategy: "automatic", value: 6 });

    expect(grid()).toEqual({ strategy: "fixed-rows", value: 2 });
    beginPanelGridConfigRead()({ strategy: "fixed-columns", value: 5 });
    expect(grid()).toEqual({ strategy: "fixed-columns", value: 5 });
  });

  it("applies the boot payload when nothing newer was heard", () => {
    applyBootPanelGridConfig({ strategy: "fixed-rows", value: 7 });
    expect(grid()).toEqual({ strategy: "fixed-rows", value: 7 });
  });

  it("stops listening on dispose", () => {
    dispose = initPanelGridConfigSync();
    dispose();
    expect(bridge.hasListener()).toBe(false);
  });
});
