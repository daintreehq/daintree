// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import type { PluginPanelActivityReport } from "@shared/types/plugin";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  describePluginPanelActivity,
  resolveActivityReporter,
} from "@/lib/pluginPanelActivityPresentation";
import { usePanelStore } from "@/store/panelStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import {
  _resetPluginPanelActivityStoreForTest,
  usePluginPanelActivityStore,
} from "@/store/pluginPanelActivityStore";
import { PluginPanelActivityIndicator } from "../PluginPanelActivity";

const PANEL_ID = "panel-1";

function registerKind(id: string, extensionId: string, reportsActivity?: boolean): void {
  registerPanelKind({
    id,
    name: id,
    iconId: "puzzle",
    color: "#abcdef",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId,
    ...(reportsActivity !== undefined ? { reportsActivity } : {}),
  });
}

function seedPanel(panel: { kind: string; pluginPanelKindId?: string }): void {
  usePanelStore.setState({
    panelsById: { [PANEL_ID]: { id: PANEL_ID, title: "Panel", ...panel } as never },
  });
}

function seedReports(
  byPlugin: Record<string, PluginPanelActivityReport>,
  seenRevision?: number
): void {
  usePluginPanelActivityStore.setState({
    activityByPanelId: { [PANEL_ID]: byPlugin },
    seenRevisionByPanelId: seenRevision === undefined ? {} : { [PANEL_ID]: seenRevision },
  });
}

function renderIndicator() {
  return render(
    <TooltipProvider>
      <PluginPanelActivityIndicator panelId={PANEL_ID} />
    </TooltipProvider>
  );
}

const status = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="status"]');

describe("describePluginPanelActivity", () => {
  it("attributes every state to the plugin and adds the reason", () => {
    expect(
      describePluginPanelActivity("acme", { state: "waiting", revision: 1 }, false, "Acme")
    ).toEqual({ pluginId: "acme", shown: "waiting", description: "Reported by Acme: Waiting" });
    expect(
      describePluginPanelActivity(
        "acme",
        { state: "failed", reason: "Token expired", revision: 1 },
        false,
        "Acme"
      ).description
    ).toBe("Reported by Acme: Failed — Token expired");
  });

  it("draws finished as unread until seen, and leaves failed failed once seen", () => {
    const finished = { state: "finished" as const, revision: 1 };
    expect(describePluginPanelActivity("acme", finished, false, "Acme").shown).toBe("unread");
    expect(describePluginPanelActivity("acme", finished, true, "Acme").shown).toBe("finished");
    expect(
      describePluginPanelActivity("acme", { state: "failed", revision: 1 }, true, "Acme").shown
    ).toBe("failed");
  });
});

describe("resolveActivityReporter", () => {
  it("names the owner only for a kind declaring reportsActivity", () => {
    expect(resolveActivityReporter({ reportsActivity: true, extensionId: "acme" })).toBe("acme");
    expect(resolveActivityReporter({ reportsActivity: false, extensionId: "acme" })).toBeNull();
    expect(resolveActivityReporter({ extensionId: "acme" })).toBeNull();
    expect(resolveActivityReporter({ reportsActivity: true })).toBeNull();
    expect(resolveActivityReporter(undefined)).toBeNull();
  });
});

describe("PluginPanelActivityIndicator", () => {
  beforeEach(() => {
    _resetPluginPanelActivityStoreForTest();
    _resetPluginRuntimeStoreForTest();
    registerKind("acme.chat", "acme", true);
    registerKind("acme.notes", "acme");
    registerKind("other.chat", "other", true);
  });

  afterEach(() => {
    for (const id of ["acme.chat", "acme.notes", "other.chat"]) unregisterPanelKind(id);
    _resetPluginPanelActivityStoreForTest();
    usePanelStore.setState({ panelsById: {} });
  });

  it("draws the owning plugin's report, named for the plugin", () => {
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([["acme", { devMode: false, displayName: "Acme Sync" }]]),
    });
    seedPanel({ kind: "acme.chat" });
    seedReports({ acme: { state: "working", reason: "Importing 3 of 12", revision: 1 } });

    const { container } = renderIndicator();
    const mark = status(container);
    expect(mark?.getAttribute("aria-label")).toBe(
      "Reported by Acme Sync: Working — Importing 3 of 12"
    );
    expect(mark?.dataset.pluginPanelActivity).toBe("working");
  });

  it("falls back to the manifest id before the plugin's name is known", () => {
    seedPanel({ kind: "acme.chat" });
    seedReports({ acme: { state: "waiting", revision: 1 } });
    const { container } = renderIndicator();
    expect(status(container)?.getAttribute("aria-label")).toBe("Reported by acme: Waiting");
  });

  it("turns finished from unread to done once that revision is seen", () => {
    seedPanel({ kind: "acme.chat" });
    seedReports({ acme: { state: "finished", revision: 5 } });
    const { container } = renderIndicator();
    expect(status(container)?.dataset.pluginPanelActivity).toBe("unread");

    act(() => usePluginPanelActivityStore.getState().markSeen(PANEL_ID, 5));
    expect(status(container)?.dataset.pluginPanelActivity).toBe("finished");
  });

  it("draws nothing for another plugin's report, or on a kind not declaring reportsActivity", () => {
    seedPanel({ kind: "acme.chat" });
    seedReports({ other: { state: "failed", revision: 1 } });
    const foreign = renderIndicator();
    expect(status(foreign.container)).toBeNull();
    foreign.unmount();

    seedPanel({ kind: "acme.notes" });
    seedReports({ acme: { state: "failed", revision: 1 } });
    const undeclared = renderIndicator();
    expect(status(undeclared.container)).toBeNull();
  });

  it("reads a PTY-backed plugin panel's own kind, not `terminal`", () => {
    seedPanel({ kind: "terminal", pluginPanelKindId: "acme.chat" });
    seedReports({ acme: { state: "waiting", revision: 1 } });
    const { container } = renderIndicator();
    expect(status(container)?.dataset.pluginPanelActivity).toBe("waiting");
  });
});
