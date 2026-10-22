/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { PluginTerminalStatus } from "@shared/types/plugin";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetPluginTerminalStatusStoreForTest,
  usePluginTerminalStatusStore,
} from "@/store/pluginTerminalStatusStore";
import { publishRegisteredPluginActions } from "@/services/plugin/registeredPluginActions";
import { TerminalPluginStatusChips } from "../TerminalPluginStatusChips";

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

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

beforeEach(() => {
  _resetPluginTerminalStatusStoreForTest();
  publishRegisteredPluginActions([]);
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([["acme.tracker", { devMode: false, displayName: "Tracker" }]]),
  });
  useProjectStore.setState({
    currentProject: { id: "proj-a", name: "App", path: "/work/app", emoji: "", lastOpened: 0 },
  });
  Reflect.set(window, "electron", { plugin: { onTerminalStatusesChanged: () => () => {} } });
});

function seed(projectId: string, pluginId: string, statuses: Record<string, PluginTerminalStatus>) {
  act(() => {
    usePluginTerminalStatusStore.setState({
      statusesByProject: { [projectId]: { [pluginId]: statuses } },
    });
  });
}

function renderChips(worktreeId?: string) {
  return render(
    <TooltipProvider delayDuration={0}>
      <TerminalPluginStatusChips terminalId="term-1" worktreeId={worktreeId} />
    </TooltipProvider>
  );
}

describe("TerminalPluginStatusChips", () => {
  it("draws nothing for a terminal with no status, or another project's", () => {
    seed("proj-b", "acme.tracker", { "term-1": { label: "x" } });
    seed("proj-a", "acme.tracker", { "term-2": { label: "y" } });
    const { container } = renderChips();
    expect(container.textContent).toBe("");
  });

  it("names the plugin in the accessible name and shows plugin, label and detail in the tooltip", async () => {
    seed("proj-a", "acme.tracker", { "term-1": { label: "INV-0042", tooltip: "Checkout bug" } });
    renderChips();

    const chip = screen.getByRole("button");
    expect(chip.getAttribute("aria-label")).toBe("Tracker: INV-0042");
    fireEvent.focus(chip);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Tracker · INV-0042");
    expect(tooltip.textContent).toContain("Checkout bug");
  });

  it("stays a plain status until its command is registered, then runs it with the terminal's ids", () => {
    seed("proj-a", "acme.tracker", { "term-1": { label: "INV", command: "acme.tracker.open" } });
    renderChips("wt-1");

    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => publishRegisteredPluginActions([["acme.tracker.open", "Open ticket"] as const]));
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).toHaveBeenCalledWith(
      "acme.tracker.open",
      { terminalId: "term-1", worktreeId: "wt-1" },
      { source: "user" }
    );
  });

  it("omits worktreeId when the terminal has none, and refuses a foreign command", () => {
    seed("proj-a", "acme.tracker", {
      "term-1": { label: "INV", command: "acme.tracker.open" },
    });
    act(() => publishRegisteredPluginActions([["acme.tracker.open", ""] as const]));
    renderChips();
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).toHaveBeenCalledWith(
      "acme.tracker.open",
      { terminalId: "term-1" },
      { source: "user" }
    );

    dispatchMock.mockClear();
    seed("proj-a", "acme.tracker", { "term-1": { label: "INV", command: "other.plugin.x" } });
    act(() => publishRegisteredPluginActions([["other.plugin.x", ""] as const]));
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("keeps a press from reaching the header", () => {
    seed("proj-a", "acme.tracker", { "term-1": { label: "INV" } });
    const onHeader = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <div onClick={onHeader} onDoubleClick={onHeader}>
          <TerminalPluginStatusChips terminalId="term-1" />
        </div>
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.doubleClick(screen.getByRole("button"));
    expect(onHeader).not.toHaveBeenCalled();
  });
});
