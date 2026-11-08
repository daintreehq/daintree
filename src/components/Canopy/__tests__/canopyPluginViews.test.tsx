// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  PluginCanopyHostedViewDescriptor,
  PluginHostedViewDescriptor,
} from "@shared/types/plugin";
import {
  _resetPluginHostedViewsStoreForTest,
  usePluginHostedViewsStore,
} from "@/store/pluginHostedViewsStore";
import { CanopyFrameContext, CANOPY_DIALOG_FRAME, standaloneCanopyFrame } from "../canopyFrame";
import { canopyPluginViews, useCanopyPluginViews } from "../canopyPluginViews";

function canopyView(
  pluginId: string,
  viewId: string,
  title: string,
  pluginName: string
): PluginCanopyHostedViewDescriptor {
  return {
    id: `plugin-view:${pluginId}/${viewId}`,
    pluginId,
    viewId,
    location: "canopy",
    name: `${pluginName} ${title}`,
    title,
    pluginName,
    componentPath: `plugin://${pluginId}/__dtv-1/${viewId}.js`,
  };
}

const SETTINGS: PluginHostedViewDescriptor = {
  id: "plugin-view:acme.tools/prefs",
  pluginId: "acme.tools",
  viewId: "prefs",
  location: "settings",
  name: "Acme settings",
  componentPath: "plugin://acme.tools/__dtv-1/prefs.js",
};

afterEach(() => _resetPluginHostedViewsStoreForTest());

describe("canopyPluginViews", () => {
  it("keeps only Canopy's views, by title then by plugin, whatever order they arrive in", () => {
    const board = canopyView("acme.zed", "board", "Board", "Zed");
    const triageB = canopyView("acme.beads", "triage", "Triage", "Beads");
    const triageA = canopyView("acme.alpha", "triage", "Triage", "Alpha");
    const listed = canopyPluginViews([triageB, SETTINGS, triageA, board]);
    expect(listed.map((view) => view.id)).toEqual([board.id, triageA.id, triageB.id]);
  });

  it("lists nothing before the first snapshot or with no Canopy view in it", () => {
    expect(canopyPluginViews(null)).toEqual([]);
    expect(canopyPluginViews([SETTINGS])).toEqual([]);
  });
});

describe("useCanopyPluginViews", () => {
  const view = canopyView("acme.beads", "triage", "Triage", "Beads");
  const wrapperFor =
    (frame: typeof CANOPY_DIALOG_FRAME) =>
    ({ children }: { children: ReactNode }) => (
      <CanopyFrameContext value={frame}>{children}</CanopyFrameContext>
    );

  it("offers the views in the Canopy window and none in a project window's dialog", () => {
    act(() => usePluginHostedViewsStore.setState({ views: [view] }));
    const standalone = standaloneCanopyFrame({
      close: vi.fn(),
      goToRun: vi.fn(),
      restoreElsewhere: vi.fn(),
      openAssistant: vi.fn(async () => null),
    });
    const inWindow = renderHook(() => useCanopyPluginViews(), {
      wrapper: wrapperFor(standalone),
    });
    expect(inWindow.result.current.map((entry) => entry.id)).toEqual([view.id]);
    const inDialog = renderHook(() => useCanopyPluginViews(), {
      wrapper: wrapperFor(CANOPY_DIALOG_FRAME),
    });
    expect(inDialog.result.current).toEqual([]);
  });
});
