// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { PluginHostedViewDescriptor } from "@shared/types/plugin";

interface ContentMountProps {
  panelId: string;
  panelRemovedSignal?: AbortSignal;
  hostContext?: { kind: string; close?: () => void };
  settingsContext?: unknown;
  offerRequestReload?: boolean;
  offerUnsavedChanges?: boolean;
  offerToolbar?: boolean;
  initialArgs?: Record<string, unknown>;
  stateVersion?: number;
  persistState?: (patch: Record<string, unknown>) => boolean;
  readRecoveryState?: () => { state?: Record<string, unknown>; version?: number } | null;
  onRequestClose?: () => void;
  requestCloseLabel?: string;
}

const h = vi.hoisted(() => ({
  mounts: [] as ContentMountProps[],
  mountCount: 0,
  configs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/Plugin/PluginViewContent", () => ({
  // The real loader imports a `plugin://` module over IPC and has its own
  // suites; here it records what the host handed it.
  makePluginViewContent: (config: Record<string, unknown>) => {
    h.configs.push(config);
    return (props: ContentMountProps) => {
      h.mounts.push(props);
      useEffect(() => {
        h.mountCount++;
      }, []);
      return <div data-testid="content" />;
    };
  },
  pluginViewHostContext: (kind: string) => ({ kind }),
}));

vi.mock("@/components/Plugin/PluginViewLoadError", () => ({
  PluginViewLoadError: ({ message }: { message: string }) => (
    <div data-testid="load-error">{message}</div>
  ),
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

  it("hands a dismissible host's close to the view, per mount and stable across renders", () => {
    const close = vi.fn();
    const { rerender } = render(
      <PluginHostedView
        source={{ from: "panel-kind", config: panelKind() }}
        host="popover"
        mountId="toolbar-popover:a"
        onClose={close}
      />
    );
    const first = h.mounts.at(-1)?.hostContext;
    expect(first?.kind).toBe("popover");
    first?.close?.();
    expect(close).toHaveBeenCalledTimes(1);

    rerender(
      <PluginHostedView
        source={{ from: "panel-kind", config: panelKind() }}
        host="popover"
        mountId="toolbar-popover:a"
        onClose={close}
      />
    );
    // The same object while the callback is unchanged, so a view memoizing on
    // it doesn't churn.
    expect(h.mounts.at(-1)?.hostContext).toBe(first);

    // A host with nothing to dismiss hands no close.
    render(<PluginHostedView source={hosted()} host="settings" mountId="b" />);
    expect(h.mounts.at(-1)?.hostContext).not.toHaveProperty("close");
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

  describe("durable state outside the grid (#14095)", () => {
    const win = window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } };

    beforeEach(() => {
      window.localStorage.clear();
      win.__DAINTREE_INITIAL_PROJECT__ = { id: "p1" };
    });
    afterEach(() => {
      delete win.__DAINTREE_INITIAL_PROJECT__;
      window.localStorage.clear();
    });

    const sidebar = () => (
      <PluginHostedView source={hosted()} host="sidebar" mountId="sidebar:acme.tools/prefs" />
    );

    it("brings back what the view persisted on its next mount", () => {
      const { unmount } = render(sidebar());
      const first = h.mounts.at(-1)!;
      expect(first.initialArgs).toBeUndefined();
      expect(first.offerUnsavedChanges).toBe(true);
      expect(first.persistState?.({ draft: "half a form", tab: 2 })).toBe(true);
      unmount();

      render(sidebar());
      expect(h.mounts.at(-1)?.initialArgs).toEqual({ draft: "half a form", tab: 2 });
    });

    it("restores the latest bag on a retry, not the one the mount read", () => {
      render(sidebar());
      const mount = h.mounts.at(-1)!;
      mount.persistState?.({ draft: "typed since mount" });
      expect(mount.readRecoveryState?.()?.state).toEqual({ draft: "typed since mount" });
    });

    it("keeps one project's bag out of another's", () => {
      const { unmount } = render(sidebar());
      h.mounts.at(-1)!.persistState?.({ draft: "p1 work" });
      unmount();

      win.__DAINTREE_INITIAL_PROJECT__ = { id: "p2" };
      render(sidebar());
      expect(h.mounts.at(-1)?.initialArgs).toBeUndefined();
    });

    it("scopes a settings section to its home, not the window", () => {
      const settings = (scope: "user" | "project", projectId: string | null) => (
        <PluginHostedView
          source={hosted()}
          host="settings"
          mountId={`settings:acme.tools:${scope}`}
          settingsContext={{ scope, projectId }}
        />
      );
      const user = render(settings("user", null));
      h.mounts.at(-1)!.persistState?.({ tab: "accounts" });
      user.unmount();

      // The user-scope section follows the user into another project's window.
      win.__DAINTREE_INITIAL_PROJECT__ = { id: "p2" };
      const again = render(settings("user", null));
      expect(h.mounts.at(-1)?.initialArgs).toEqual({ tab: "accounts" });
      again.unmount();

      const projectA = render(settings("project", "pa"));
      h.mounts.at(-1)!.persistState?.({ tab: "a" });
      projectA.unmount();
      render(settings("project", "pb"));
      expect(h.mounts.at(-1)?.initialArgs).toBeUndefined();
    });

    it("remounts the content when the identity changes under it", () => {
      const settings = (projectId: string) => (
        <PluginHostedView
          source={hosted()}
          host="settings"
          mountId="settings:acme.tools:project"
          settingsContext={{ scope: "project", projectId }}
        />
      );
      const first = render(settings("pa"));
      h.mounts.at(-1)!.persistState?.({ tab: "a" });
      first.unmount();

      const { rerender } = render(settings("pb"));
      h.mounts.at(-1)!.persistState?.({ tab: "b" });
      const before = h.mountCount;
      rerender(settings("pa"));
      // A fresh mount read pa's bag, rather than the pb view carrying on.
      expect(h.mountCount).toBe(before + 1);
      expect(h.mounts.at(-1)?.initialArgs).toEqual({ tab: "a" });
    });

    it("versions a surface's bag by its panel kind and keeps a newer build's bag intact", () => {
      registerPanelKind({ ...panelKind(), stateVersion: 2 });
      const surface = () => (
        <PluginHostedView
          source={{ from: "panel-kind", config: { ...panelKind(), stateVersion: 2 } }}
          host="surface"
          mountId={`surface:${KIND_ID}`}
        />
      );
      const first = render(surface());
      expect(h.mounts.at(-1)?.stateVersion).toBe(2);
      h.mounts.at(-1)!.persistState?.({ layout: "wide" });
      first.unmount();

      const second = render(surface());
      expect(h.mounts.at(-1)?.initialArgs).toEqual({ layout: "wide" });
      expect(h.mounts.at(-1)?.stateVersion).toBe(2);
      second.unmount();

      // The same plugin downgraded to state version 1 gets the panel's version
      // error rather than a view whose every write would be refused.
      registerPanelKind({ ...panelKind(), stateVersion: 1 });
      const before = h.mountCount;
      const downgraded = render(
        <PluginHostedView
          source={{ from: "panel-kind", config: { ...panelKind(), stateVersion: 1 } }}
          host="surface"
          mountId={`surface:${KIND_ID}`}
        />
      );
      expect(h.mountCount).toBe(before);
      expect(downgraded.getByTestId("load-error").textContent).toContain("state format 2");
      downgraded.unmount();

      // The newer build's bag is still there for the newer build.
      registerPanelKind({ ...panelKind(), stateVersion: 2 });
      render(surface());
      expect(h.mounts.at(-1)?.initialArgs).toEqual({ layout: "wide" });
    });

    it("hands a view with no declared version no stateVersion, as a panel would", () => {
      const { unmount } = render(sidebar());
      h.mounts.at(-1)!.persistState?.({ tab: 1 });
      unmount();
      render(sidebar());
      expect(h.mounts.at(-1)?.initialArgs).toEqual({ tab: 1 });
      expect(h.mounts.at(-1)?.stateVersion).toBeUndefined();
      // A retry restores the bag under the same rule.
      expect(h.mounts.at(-1)?.readRecoveryState?.()).toEqual({ state: { tab: 1 } });
    });

    it("hands a reloaded plugin's new module the latest bag, not the first mount's", () => {
      const { rerender } = render(sidebar());
      expect(h.mounts.at(-1)?.initialArgs).toBeUndefined();
      h.mounts.at(-1)!.persistState?.({ draft: "kept across the reload" });

      const reloaded = hostedView("plugin://acme.tools/__dtv-2/prefs.js");
      serve([reloaded]);
      rerender(
        <PluginHostedView
          source={hosted(reloaded)}
          host="sidebar"
          mountId="sidebar:acme.tools/prefs"
        />
      );
      expect(h.mounts.at(-1)?.initialArgs).toEqual({ draft: "kept across the reload" });
    });

    it("leaves a file editor's draft to its document", () => {
      render(<PluginHostedView source={hosted()} host="fileEditor" mountId="file-editor:panel" />);
      const mount = h.mounts.at(-1)!;
      expect(mount.persistState).toBeUndefined();
      expect(mount.offerUnsavedChanges).toBeFalsy();
    });
  });
});
