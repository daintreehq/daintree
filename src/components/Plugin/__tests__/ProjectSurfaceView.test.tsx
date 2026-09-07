// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import { syncPluginPanels } from "@/services/plugin/pluginPanelLifecycle";

const h = vi.hoisted(() => ({
  mounts: [] as Array<{ panelId: string; panelRemovedSignal?: AbortSignal }>,
}));

vi.mock("@/components/Plugin/PluginViewContent", () => ({
  // The real content does a `plugin://` import over IPC; what is under test
  // here is the lifetime the surface hands it, not the loader.
  makePluginViewContent: () => (props: { panelId: string; panelRemovedSignal?: AbortSignal }) => {
    h.mounts.push(props);
    return <div data-testid="content" />;
  },
}));

import { ProjectSurfaceView, _resetProjectSurfaceRuntimesForTest } from "../ProjectSurfaceView";

const KIND_ID = "project:p1/acme.dash/overview";

function surfaceKind(componentPath = "plugin://acme.dash/1/overview.js"): PanelKindConfig {
  return {
    id: KIND_ID,
    name: "Mission Control",
    iconId: "puzzle",
    color: "#ffffff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "project__p1__acme.dash",
    componentPath,
  };
}

beforeEach(() => {
  h.mounts = [];
  _resetProjectSurfaceRuntimesForTest();
  registerPanelKind(surfaceKind());
});

afterEach(() => {
  unregisterPanelKind(KIND_ID);
  _resetProjectSurfaceRuntimesForTest();
});

describe("ProjectSurfaceView", () => {
  it("supplies its own removal signal instead of the panel lifecycle's", () => {
    render(<ProjectSurfaceView config={surfaceKind()} />);

    const mount = h.mounts.at(-1);
    expect(mount?.panelId).toBe(`surface:${KIND_ID}`);
    expect(mount?.panelRemovedSignal?.aborted).toBe(false);

    // The lifecycle service sweeps every tracked id the panel store no longer
    // lists. A surface is not a panel record, so if it were tracked this sweep
    // would report a still-mounted surface as permanently removed and tear down
    // the durable resources that signal exists to protect.
    act(() => syncPluginPanels([], new Set()));

    expect(mount?.panelRemovedSignal?.aborted).toBe(false);
  });

  it("aborts the removal signal when the kind leaves the registry", () => {
    render(<ProjectSurfaceView config={surfaceKind()} />);
    const signal = h.mounts.at(-1)?.panelRemovedSignal;

    // The plugin unloaded: this IS the surface's permanent removal.
    act(() => unregisterPanelKind(KIND_ID));

    expect(signal?.aborted).toBe(true);
  });

  it("reuses one factory per kind across re-renders", () => {
    const { rerender } = render(<ProjectSurfaceView config={surfaceKind()} />);
    const first = h.mounts.length;
    rerender(<ProjectSurfaceView config={surfaceKind()} />);

    // A fresh factory would be a new component type, remounting the plugin's
    // view and restarting its import on every render.
    expect(h.mounts.length).toBe(first + 1);
    expect(h.mounts[0]?.panelRemovedSignal).toBe(h.mounts[1]?.panelRemovedSignal);
  });

  it("retires the old runtime when the plugin's module URL changes", () => {
    render(<ProjectSurfaceView config={surfaceKind()} />);
    const stale = h.mounts.at(-1)?.panelRemovedSignal;

    const upgraded = surfaceKind("plugin://acme.dash/2/overview.js");
    act(() => registerPanelKind(upgraded));
    render(<ProjectSurfaceView config={upgraded} />);

    expect(stale?.aborted).toBe(true);
    expect(h.mounts.at(-1)?.panelRemovedSignal?.aborted).toBe(false);
  });
});
