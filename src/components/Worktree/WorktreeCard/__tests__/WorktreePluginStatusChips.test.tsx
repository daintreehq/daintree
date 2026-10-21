/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetPluginWorktreeCardStatusStoreForTest,
  usePluginWorktreeCardStatusStore,
} from "@/store/pluginWorktreeCardStatusStore";
import { WorktreePluginStatusChips, useWorktreePluginStatuses } from "../WorktreePluginStatusChips";

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
  _resetPluginWorktreeCardStatusStoreForTest();
  usePluginRuntimeStore.setState({ pluginMetaById: new Map() });
  useProjectStore.setState({ currentProject: { id: "proj-a" } as never });
  Reflect.set(window, "electron", {
    plugin: { onWorktreeCardStatusesChanged: vi.fn(() => () => {}) },
  });
});

function renderChips(statuses: Parameters<typeof WorktreePluginStatusChips>[0]["statuses"]) {
  return render(
    <TooltipProvider delayDuration={0}>
      <WorktreePluginStatusChips statuses={statuses} />
    </TooltipProvider>
  );
}

describe("WorktreePluginStatusChips", () => {
  it("draws one focusable chip per plugin, each named after its plugin", () => {
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([
        ["acme.docker", { devMode: false, displayName: "Docker" }],
        ["project__proj-a__acme.status", { devMode: false, displayName: "Status" }],
      ]),
    });
    renderChips([
      { pluginId: "acme.docker", status: { label: "2 up" } },
      { pluginId: "project__proj-a__acme.status", status: { label: "2 up" } },
    ]);

    const chips = screen.getAllByRole("button");
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Docker: 2 up",
      "Status: 2 up",
    ]);
    for (const chip of chips) {
      expect(chip.getAttribute("type")).toBe("button");
      expect(chip.hasAttribute("data-no-dnd")).toBe(true);
      expect(chip.tabIndex).toBe(0);
    }
  });

  it("falls back to the manifest id, never the project instance key", () => {
    renderChips([{ pluginId: "project__proj-a__acme.status", status: { label: "ok" } }]);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("acme.status: ok");
  });

  it("opens a tooltip with the plugin, label and detail on keyboard focus", async () => {
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([["acme.docker", { devMode: false, displayName: "Docker" }]]),
    });
    renderChips([
      { pluginId: "acme.docker", status: { label: "2 up", tooltip: "api: running\ndb: running" } },
    ]);

    fireEvent.focus(screen.getByRole("button"));

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Docker · 2 up");
    expect(tooltip.textContent).toContain("api: running\ndb: running");
  });

  it("renders a label as text, never as markup", () => {
    renderChips([{ pluginId: "acme.x", status: { label: "<b>bold</b>" } }]);
    expect(screen.getByRole("button").textContent).toBe("<b>bold</b>");
    expect(screen.getByRole("button").querySelector("b")).toBeNull();
  });

  it("renders nothing without statuses", () => {
    const { container } = renderChips([]);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("useWorktreePluginStatuses", () => {
  it("reads only the current project's statuses for this card, and subscribes the store", () => {
    usePluginWorktreeCardStatusStore.setState({
      statusesByProject: {
        "proj-a": {
          "zeta.b": { "/wt": { label: "z" } },
          "acme.a": { "/wt": { label: "a" }, "/other": { label: "no" } },
        },
        "proj-b": { "acme.c": { "/wt": { label: "wrong project" } } },
      },
    });

    const { result } = renderHook(() => useWorktreePluginStatuses("/wt"));

    expect(result.current.map((entry) => entry.status.label)).toEqual(["a", "z"]);
    const bridge = (
      window as unknown as { electron: { plugin: { onWorktreeCardStatusesChanged: unknown } } }
    ).electron.plugin.onWorktreeCardStatusesChanged;
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("answers nothing with no current project", () => {
    useProjectStore.setState({ currentProject: null });
    usePluginWorktreeCardStatusStore.setState({
      statusesByProject: { "proj-a": { "acme.a": { "/wt": { label: "a" } } } },
    });
    const { result } = renderHook(() => useWorktreePluginStatuses("/wt"));
    expect(result.current).toEqual([]);
  });
});
