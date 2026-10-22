// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { PluginHostedViewDescriptor } from "@shared/types/plugin";

interface ContentMountProps {
  panelId: string;
  panelRemovedSignal?: AbortSignal;
  hostContext?: { kind: string };
  settingsContext?: unknown;
  offerRequestReload?: boolean;
  offerToolbar?: boolean;
  onRequestClose?: () => void;
  requestCloseLabel?: string;
}

const h = vi.hoisted(() => ({
  mounts: [] as ContentMountProps[],
  configs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/Plugin/PluginViewContent", () => ({
  // The real loader imports a `plugin://` module over IPC and has its own
  // suites; here it records what the host handed it.
  makePluginViewContent: (config: Record<string, unknown>) => {
    h.configs.push(config);
    return (props: ContentMountProps) => {
      h.mounts.push(props);
      return <div data-testid="content" />;
    };
  },
  pluginViewHostContext: (kind: string) => ({ kind }),
}));

import {
  PluginHostedView,
  _pluginHostedViewRemovalSignalForTest,
  _resetPluginHostedViewRuntimesForTest,
  type PluginHostedViewSource,
} from "../PluginHostedView";
import {
  _resetPluginHostedViewsStoreForTest,
  usePluginHostedViewsStore,
} from "@/store/pluginHostedViewsStore";

const HOSTED_ID = "plugin-view:acme.tools/prefs";
const KIND_ID = "project:p1/acme.dash/overview";

function hostedView(componentPath = "plugin://acme.tools/__dtv-1/prefs.js") {
  return {
    id: HOSTED_ID,
    pluginId: "acme.tools",
    viewId: "prefs",
    location: "settings",
    name: "Acme settings",
    componentPath,
  } satisfies PluginHostedViewDescriptor;
}

function panelKind(componentPath = "plugin://acme.dash/1/overview.js"): PanelKindConfig {
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

const hosted = (view = hostedView()): PluginHostedViewSource => ({ from: "hosted", view });

function serve(views: PluginHostedViewDescriptor[]) {
  act(() => usePluginHostedViewsStore.setState({ views }));
}

beforeEach(() => {
  h.mounts = [];
  h.configs = [];
  _resetPluginHostedViewRuntimesForTest();
  _resetPluginHostedViewsStoreForTest();
  serve([hostedView()]);
});

afterEach(() => {
  cleanup();
  unregisterPanelKind(KIND_ID);
  _resetPluginHostedViewRuntimesForTest();
  _resetPluginHostedViewsStoreForTest();
});

describe("PluginHostedView", () => {
  it("hands the view the panel contract plus where it is, and nothing a panel record polices", () => {
    render(
      <PluginHostedView
        source={hosted()}
        host="settings"
        mountId="settings:acme.tools:user"
        settingsContext={{ scope: "user", projectId: null }}
      />
    );

    const mount = h.mounts.at(-1)!;
    expect(mount.panelId).toBe("settings:acme.tools:user");
    expect(mount.hostContext?.kind).toBe("settings");
    expect(mount.settingsContext).toEqual({ scope: "user", projectId: null });
    expect(mount.panelRemovedSignal?.aborted).toBe(false);
    expect(mount.offerRequestReload).toBeFalsy();
    expect(mount.offerToolbar).toBeFalsy();
    expect(mount.onRequestClose).toBeUndefined();
  });

  it("passes a host's way out of a broken view, in the host's words", () => {
    const showWorktrees = vi.fn();
    render(
      <PluginHostedView
        source={hosted()}
        host="sidebar"
        mountId="sidebar:acme.tools.prefs"
        onRequestClose={showWorktrees}
        requestCloseLabel="Show worktrees"
      />
    );

    const mount = h.mounts.at(-1)!;
    expect(mount.hostContext?.kind).toBe("sidebar");
    expect(mount.requestCloseLabel).toBe("Show worktrees");
    mount.onRequestClose?.();
    expect(showWorktrees).toHaveBeenCalledTimes(1);
  });

  it("loads a hosted view standalone, and a panel kind under its own teardown", () => {
    render(<PluginHostedView source={hosted()} host="settings" mountId="a" />);
    registerPanelKind(panelKind());
    render(
      <PluginHostedView
        source={{ from: "panel-kind", config: panelKind() }}
        host="surface"
        mountId="b"
      />
    );

    // A hosted id is in no panel-kind snapshot, so the kind-registry teardown
    // would read every broadcast as removal; a real kind keeps it.
    expect(h.configs[0]).toMatchObject({
      id: HOSTED_ID,
      extensionId: "acme.tools",
      standalone: true,
    });
    expect(h.configs[1]).toMatchObject({ id: KIND_ID, extensionId: "project__p1__acme.dash" });
    expect(h.configs[1]?.standalone).toBeUndefined();
  });

  it("reuses one factory and one removal signal across re-renders and remounts", () => {
    const { rerender, unmount } = render(
      <PluginHostedView source={hosted()} host="settings" mountId="a" />
    );
    rerender(<PluginHostedView source={hosted()} host="settings" mountId="a" />);
    unmount();
    render(<PluginHostedView source={hosted()} host="settings" mountId="a" />);

    // A fresh factory would be a new component type, remounting the view and
    // restarting its import; closing the home is not removal.
    expect(h.configs).toHaveLength(1);
    const signals = new Set(h.mounts.map((m) => m.panelRemovedSignal));
    expect(signals.size).toBe(1);
    expect([...signals][0]?.aborted).toBe(false);
  });

  it("retires a hosted view withdrawn from the snapshot, with nothing mounted", () => {
    render(<PluginHostedView source={hosted()} host="settings" mountId="a" />);
    cleanup();
    const signal = _pluginHostedViewRemovalSignalForTest(HOSTED_ID)!;

    serve([hostedView()]);
    expect(signal.aborted).toBe(false);

    // Stopped, uninstalled or hidden in this project.
    serve([]);
    expect(signal.aborted).toBe(true);
    expect(_pluginHostedViewRemovalSignalForTest(HOSTED_ID)).toBeUndefined();
  });

  it("retires a hosted view whose plugin now serves a new module", () => {
    render(<PluginHostedView source={hosted()} host="settings" mountId="a" />);
    const stale = h.mounts.at(-1)?.panelRemovedSignal;

    const reloaded = hostedView("plugin://acme.tools/__dtv-2/prefs.js");
    serve([reloaded]);
    render(<PluginHostedView source={hosted(reloaded)} host="settings" mountId="a" />);

    expect(stale?.aborted).toBe(true);
    expect(h.configs.at(-1)?.componentPath).toBe("plugin://acme.tools/__dtv-2/prefs.js");
    expect(h.mounts.at(-1)?.panelRemovedSignal?.aborted).toBe(false);
  });

  it("does not read the snapshot not having arrived yet as a withdrawal", () => {
    render(<PluginHostedView source={hosted()} host="settings" mountId="a" />);
    const signal = h.mounts.at(-1)?.panelRemovedSignal;

    act(() => usePluginHostedViewsStore.setState({ views: null }));
    registerPanelKind(panelKind());

    expect(signal?.aborted).toBe(false);
  });

  it("retires a panel-kind source when its kind leaves the registry", () => {
    registerPanelKind(panelKind());
    render(
      <PluginHostedView
        source={{ from: "panel-kind", config: panelKind() }}
        host="surface"
        mountId="b"
      />
    );
    const signal = h.mounts.at(-1)?.panelRemovedSignal;

    // An unrelated hosted-view snapshot leaves it alone.
    serve([]);
    expect(signal?.aborted).toBe(false);

    act(() => {
      unregisterPanelKind(KIND_ID);
    });
    expect(signal?.aborted).toBe(true);
  });

  it("contains the view in its own flex column, sized by the caller", () => {
    const { container } = render(
      <PluginHostedView source={hosted()} host="settings" mountId="a" className="h-full" />
    );
    const box = container.querySelector('[data-testid="content"]')?.parentElement;

    // jsdom computes no layout, so the containment contract is asserted on what
    // produces it: the loader fills its host with `flex-1 min-h-0`, inert
    // outside a flex container, and `isolate` + `contain` keep a fixed or
    // high-z descendant inside the box.
    expect(box?.classList.contains("flex")).toBe(true);
    expect(box?.classList.contains("flex-col")).toBe(true);
    expect(box?.classList.contains("isolate")).toBe(true);
    expect(box?.classList.contains("overflow-hidden")).toBe(true);
    expect(box?.classList.contains("h-full")).toBe(true);
    expect(box?.style.contain).toBe("layout paint");
  });
});
