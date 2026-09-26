// @vitest-environment jsdom
/**
 * A dialog-hosted panel mounts with its persisted `extensionState` and version,
 * exactly as a grid or dock panel does (#12608).
 *
 * `PanelDialogFrame` used to hand-build a smaller prop set than the other two
 * hosts and dropped both fields, so a plugin view shown in a dialog started from
 * an empty bag and the future-version refusal (#12280) never ran. The refusal
 * cases below go through the real `makePluginViewHost` and decoder, because the
 * bug lived in the seam between the host and the view — a probe alone would
 * pass even if the plugin host stopped reading what the dialog now forwards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PanelKindDefinition } from "@/panels/registry";

const PROBE_KIND = "acme.probe";
const PLUGIN_KIND = "acme.dashboard";

const registry = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    snapshot: {} as Record<string, Pick<PanelKindDefinition, "component">>,
    publish(kind: string, component: PanelKindDefinition["component"]) {
      this.snapshot = { ...this.snapshot, [kind]: { component } };
      for (const listener of listeners) listener();
    },
    reset() {
      this.snapshot = {};
      listeners.clear();
    },
  };
});

vi.mock("@/panels/registry", () => ({
  subscribeToPanelKindDefinitions: (listener: () => void) => {
    registry.listeners.add(listener);
    return () => registry.listeners.delete(listener);
  },
  getPanelKindDefinitionsSnapshot: () => registry.snapshot,
}));

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  );
  AppDialog.Header = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.Title = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.CloseButton = () => <button>close</button>;
  AppDialog.BodyScroll = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return { AppDialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

// Subscribing, unlike the inert store in the sibling suites: the update case
// below needs a replaced record to actually reach the mounted frame.
const panelStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    panelsById: {} as Record<string, Record<string, unknown>>,
    set(next: Record<string, Record<string, unknown>>) {
      this.panelsById = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("@/store/panelStore", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
      useSyncExternalStore(
        (listener) => {
          panelStore.listeners.add(listener);
          return () => panelStore.listeners.delete(listener);
        },
        () => selector({ panelsById: panelStore.panelsById })
      ),
  };
});

// The plugin host's chrome and content are covered by their own suites; here
// ContentPanel is a passthrough and the content is a probe, so what's under test
// is the dialog → host → decoder path and nothing downstream of the decode.
vi.mock("@/components/Panel", () => ({
  ContentPanel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Recorders are called rather than assigned to during render — a write to an
// outer variable is a React Compiler lint violation even in a test double.
const contentRender = vi.hoisted(() => vi.fn<(props: Record<string, unknown>) => void>());

vi.mock("@/components/Plugin/PluginViewContent", () => ({
  makePluginViewContent: () =>
    function ProbeContent(props: Record<string, unknown>) {
      contentRender(props);
      return <div data-testid="plugin-content" />;
    },
}));

// Spread over the real module: the plugin view host's setup strip reads the
// project store, which registers its own accessors here at import.
vi.mock("@/store/storeAccessors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/storeAccessors")>()),
  getPanelStoreSnapshot: () => null,
  persistPanelExtensionStateThroughAccessor: () => true,
}));

const probeRender = vi.fn<(props: Record<string, unknown>) => void>();

function ProbePane(props: Record<string, unknown>) {
  probeRender(props);
  return <div data-testid="probe" />;
}

function lastProps(recorder: typeof probeRender): Record<string, unknown> {
  const call = recorder.mock.lastCall;
  if (!call) throw new Error("component never rendered");
  return call[0];
}

const { usePanelDialogStore } = await import("@/store/panelDialogStore");
const { PanelDialogHost } = await import("../PanelDialogHost");
const { makePluginViewHost } = await import("@/components/Plugin/PluginViewHost");

function pluginConfig(overrides: Partial<PanelKindConfig> = {}): PanelKindConfig {
  return {
    id: PLUGIN_KIND,
    name: "Dashboard",
    iconId: "gauge",
    color: "#abcdef",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "acme",
    componentPath: "plugin://acme/dashboard.js",
    stateVersion: 2,
    ...overrides,
  };
}

function openDialog(record: { id: string } & Record<string, unknown>) {
  panelStore.set({ [record.id]: record });
  render(<PanelDialogHost />);
  act(() => {
    usePanelDialogStore.setState({ dialogStack: [record.id] });
  });
}

describe("PanelDialogHost extension state (#12608)", () => {
  beforeEach(() => {
    registry.reset();
    panelStore.listeners.clear();
    panelStore.panelsById = {};
    probeRender.mockReset();
    contentRender.mockReset();
    usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
    registry.publish(PROBE_KIND, ProbePane);
  });

  afterEach(() => {
    cleanup();
  });

  it("hands the kind's component the record's persisted state and version", () => {
    const extensionState = { tab: "logs" };
    openDialog({
      id: "probe-1",
      kind: PROBE_KIND,
      title: "Probe",
      worktreeId: "wt-1",
      extensionState,
      extensionStateVersion: 1,
    });

    const props = lastProps(probeRender);
    expect(props.extensionState).toBe(extensionState);
    expect(props.extensionStateVersion).toBe(1);
    expect(props.id).toBe("probe-1");
    expect(props.worktreeId).toBe("wt-1");
    expect(props.location).toBe("dialog");
    expect(props.isFocused).toBe(true);
  });

  it("forwards a version of 0 as-is and leaves an unstamped record undefined", () => {
    openDialog({
      id: "probe-1",
      kind: PROBE_KIND,
      title: "Probe",
      extensionState: { tab: "logs" },
      extensionStateVersion: 0,
    });
    expect(lastProps(probeRender).extensionStateVersion).toBe(0);

    act(() => {
      panelStore.set({ "probe-1": { id: "probe-1", kind: PROBE_KIND, title: "Probe" } });
    });
    expect(lastProps(probeRender).extensionState).toBeUndefined();
    expect(lastProps(probeRender).extensionStateVersion).toBeUndefined();
  });

  it("follows the record when its state changes while the dialog is open", () => {
    openDialog({
      id: "probe-1",
      kind: PROBE_KIND,
      title: "Probe",
      extensionState: { tab: "logs" },
      extensionStateVersion: 1,
    });

    const next = { tab: "metrics" };
    act(() => {
      panelStore.set({
        "probe-1": {
          id: "probe-1",
          kind: PROBE_KIND,
          title: "Probe",
          extensionState: next,
          extensionStateVersion: 2,
        },
      });
    });

    expect(lastProps(probeRender).extensionState).toBe(next);
    expect(lastProps(probeRender).extensionStateVersion).toBe(2);
  });

  it("mounts a plugin view with the saved state the plugin can read", () => {
    registry.publish(PLUGIN_KIND, makePluginViewHost(pluginConfig()));
    const extensionState = { tab: "logs" };
    openDialog({
      id: "plugin-1",
      kind: PLUGIN_KIND,
      title: "Dashboard",
      extensionState,
      extensionStateVersion: 1,
    });

    expect(screen.queryByTestId("plugin-content")).not.toBeNull();
    expect(lastProps(contentRender).initialArgs).toBe(extensionState);
    expect(lastProps(contentRender).stateVersion).toBe(1);
  });

  it("refuses state written by a newer build of the plugin instead of mounting the view", () => {
    registry.publish(PLUGIN_KIND, makePluginViewHost(pluginConfig()));
    openDialog({
      id: "plugin-1",
      kind: PLUGIN_KIND,
      title: "Dashboard",
      extensionState: { tab: "logs" },
      extensionStateVersion: 3,
    });

    expect(screen.queryByTestId("plugin-content")).toBeNull();
    expect(contentRender).not.toHaveBeenCalled();
    expect(screen.getByText("Dashboard unavailable")).toBeTruthy();
    expect(screen.getByText(/state format 3; this version reads 2/)).toBeTruthy();
  });
});
