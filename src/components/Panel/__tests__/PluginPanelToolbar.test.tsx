// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import type { PluginPanelToolbarItemConfig } from "@shared/config/panelKindRegistry";
import { publishRegisteredPluginActions } from "@/services/plugin/registeredPluginActions";
import { usePluginPanelToolbarStore } from "@/store/pluginPanelToolbarStore";
import { PluginPanelToolbar } from "../PluginPanelToolbar";

const mockDispatch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

const KIND = "acme.ledger.ledger";
const PANEL_ID = "panel-ledger";
const REFRESH = "acme.ledger.refresh-quotes";
const EXPORT = "acme.ledger.export";

function registerKind(pluginToolbar: PluginPanelToolbarItemConfig[] | undefined) {
  registerPanelKind({
    id: KIND,
    name: "Ledger",
    iconId: "wallet",
    color: "#38bdf8",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "acme.ledger",
    ...(pluginToolbar ? { pluginToolbar } : {}),
  });
}

function setState(stateKey: string, state: unknown) {
  act(() => usePluginPanelToolbarStore.getState().setItemState(PANEL_ID, stateKey, state));
}

function renderToolbar() {
  return render(<PluginPanelToolbar panelId={PANEL_ID} kind={KIND} />);
}

describe("PluginPanelToolbar", () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    usePluginPanelToolbarStore.setState({ statesByPanelId: {} });
    registerKind([
      { actionId: REFRESH, stateKey: REFRESH, iconId: "chart-line", status: true },
      { actionId: EXPORT, stateKey: EXPORT, label: "Export" },
    ]);
    publishRegisteredPluginActions([
      [REFRESH, "Refresh prices"],
      [EXPORT, "Export ledger"],
    ]);
  });

  afterEach(() => {
    cleanup();
    unregisterPanelKind(KIND);
    publishRegisteredPluginActions([]);
  });

  it("draws nothing for a kind that declares no toolbar", () => {
    registerKind(undefined);
    renderToolbar();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("waits for an action to register, then draws its button in declared order", () => {
    publishRegisteredPluginActions([[EXPORT, "Export ledger"]]);
    renderToolbar();
    expect(screen.getAllByRole("button").map((b) => b.dataset.pluginAction)).toEqual([EXPORT]);

    act(() =>
      publishRegisteredPluginActions([
        [REFRESH, "Refresh prices"],
        [EXPORT, "Export ledger"],
      ])
    );
    expect(screen.getAllByRole("button").map((b) => b.dataset.pluginAction)).toEqual([
      REFRESH,
      EXPORT,
    ]);
  });

  it("names an icon button by its label, falling back to the action title, and draws a text button's label", () => {
    renderToolbar();
    const toolbar = screen.getByRole("toolbar", { name: "Ledger actions" });
    const refresh = screen.getByRole("button", { name: "Refresh prices" });
    expect(refresh.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Export" }).textContent).toBe("Export");
    expect(toolbar.contains(refresh)).toBe(true);
  });

  it("uses the state's tooltip over the label, without remounting the button", () => {
    renderToolbar();
    const tips = () => screen.queryAllByTestId("tooltip-content").map((t) => t.textContent);
    expect(tips()).toEqual(["Refresh prices", "Export"]);
    const exportButton = screen.getByRole("button", { name: "Export" });
    exportButton.focus();

    setState(REFRESH, { tooltip: "Prices fetched 14:02" });
    setState(EXPORT, { tooltip: "Exports the visible rows" });
    expect(tips()).toEqual(["Prices fetched 14:02", "Exports the visible rows"]);
    expect(screen.getByRole("button", { name: "Export" })).toBe(exportButton);
    expect(document.activeElement).toBe(exportButton);
  });

  it("dispatches the action with the panel it was clicked on", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Refresh prices" }));
    expect(mockDispatch).toHaveBeenCalledWith(REFRESH, { panelId: PANEL_ID }, { source: "user" });
  });

  it("ignores clicks while busy or disabled and announces why", () => {
    renderToolbar();
    setState(REFRESH, { busy: true });
    setState(EXPORT, { disabled: true });

    const refresh = screen.getByRole("button", { name: "Refresh prices" });
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(exportButton.getAttribute("aria-disabled")).toBe("true");
    // Never natively disabled: the button keeps focus and its tab stop.
    expect(exportButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(refresh);
    fireEvent.click(exportButton);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("draws the status text and age beside a status button, described by it", () => {
    renderToolbar();
    setState(REFRESH, { text: "2 prices kept from cache", updatedAt: Date.now() - 3 * 3_600_000 });

    const refresh = screen.getByRole("button", { name: "Refresh prices" });
    const status = document.getElementById(refresh.getAttribute("aria-describedby") ?? "");
    expect(status?.textContent).toContain("2 prices kept from cache");
    expect(status?.textContent).toMatch(/Updated 3h ago/);
    expect(status?.dataset.statusTone).toBe("default");
  });

  it("ignores status fields on a button that did not ask for a status", () => {
    renderToolbar();
    setState(EXPORT, { text: "Ready", tone: "danger" });
    expect(screen.getByRole("button", { name: "Export" }).hasAttribute("aria-describedby")).toBe(
      false
    );
  });

  it("warns once the age passes staleAfterMs, and an explicit tone wins", () => {
    renderToolbar();
    const staleAge = { updatedAt: Date.now() - 2 * 3_600_000, staleAfterMs: 3_600_000 };
    const statusEl = () =>
      document.getElementById(
        screen.getByRole("button", { name: "Refresh prices" }).getAttribute("aria-describedby") ??
          ""
      );

    setState(REFRESH, staleAge);
    expect(statusEl()?.dataset.statusTone).toBe("warning");
    expect(statusEl()?.querySelector("svg")).not.toBeNull();
    expect(statusEl()?.textContent).toContain("Out of date:");

    setState(REFRESH, { ...staleAge, tone: "default" });
    expect(statusEl()?.dataset.statusTone).toBe("default");
    expect(statusEl()?.querySelector("svg")).toBeNull();

    setState(REFRESH, { text: "Quotes failed", tone: "danger" });
    expect(statusEl()?.dataset.statusTone).toBe("danger");
    expect(statusEl()?.querySelector("svg")).not.toBeNull();
    expect(statusEl()?.textContent).toContain("Error:");
  });

  it("moves the row's tab stop to a focused button that registered after mount", () => {
    publishRegisteredPluginActions([]);
    renderToolbar();
    expect(screen.queryByRole("toolbar")).toBeNull();

    act(() =>
      publishRegisteredPluginActions([
        [REFRESH, "Refresh prices"],
        [EXPORT, "Export ledger"],
      ])
    );
    const exportButton = screen.getByRole("button", { name: "Export" });
    act(() => exportButton.focus());

    expect(exportButton.tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Refresh prices" }).tabIndex).toBe(-1);
  });

  it("keeps every button but one out of the tab order", () => {
    renderToolbar();
    const tabStops = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(tabStops).toHaveLength(1);
  });
});
