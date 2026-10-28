/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { act, render, screen, fireEvent, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetPluginWorktreeCardStatusStoreForTest,
  usePluginWorktreeCardStatusStore,
} from "@/store/pluginWorktreeCardStatusStore";
import { publishRegisteredPluginActions } from "@/services/plugin/registeredPluginActions";
import { WorktreePluginStatusChips, useWorktreePluginStatuses } from "../WorktreePluginStatusChips";

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

const onWorktreeCardStatusesChanged = vi.fn(() => () => {});

beforeEach(() => {
  _resetPluginWorktreeCardStatusStoreForTest();
  publishRegisteredPluginActions([]);
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  onWorktreeCardStatusesChanged.mockClear();
  usePluginRuntimeStore.setState({ pluginMetaById: new Map() });
  useProjectStore.setState({
    currentProject: { id: "proj-a", name: "App", path: "/work/app", emoji: "", lastOpened: 0 },
  });
  Reflect.set(window, "electron", { plugin: { onWorktreeCardStatusesChanged } });
});

type ChipProps = Parameters<typeof WorktreePluginStatusChips>[0];

function renderChips(
  statuses: ChipProps["statuses"],
  props: Omit<ChipProps, "statuses" | "worktreeId"> = {}
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <WorktreePluginStatusChips worktreeId="/wt" statuses={statuses} {...props} />
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

  it("keeps a press on a chip from reaching the card", () => {
    const onCardClick = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <div onClick={onCardClick}>
          <WorktreePluginStatusChips
            worktreeId="/wt"
            statuses={[{ pluginId: "acme.x", status: { label: "up" } }]}
          />
        </div>
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onCardClick).not.toHaveBeenCalled();
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

describe("WorktreePluginStatusChips commands (#13776)", () => {
  const docker = {
    pluginId: "acme.docker",
    status: { label: "2 up", command: "acme.docker.show" },
  };

  it("runs its plugin's registered command with the card's worktree, never selecting the card", () => {
    publishRegisteredPluginActions([["acme.docker.show", "Show containers"]]);
    const onCardClick = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <div onClick={onCardClick}>
          <WorktreePluginStatusChips worktreeId="/repo/wt-a" statuses={[docker]} />
        </div>
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button"));

    expect(dispatchMock).toHaveBeenCalledWith(
      "acme.docker.show",
      { worktreeId: "/repo/wt-a" },
      { source: "user" }
    );
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("says in its tooltip what a click runs", async () => {
    publishRegisteredPluginActions([["acme.docker.show", "Show containers"]]);
    renderChips([docker]);
    fireEvent.focus(screen.getByRole("button"));
    expect((await screen.findByRole("tooltip")).textContent).toContain("Click: Show containers");
  });

  it("stays a plain status until its command registers, then becomes runnable", async () => {
    renderChips([docker]);

    // Read the tooltip before any click: a press on a trigger closes it.
    fireEvent.focus(screen.getByRole("button"));
    expect((await screen.findByRole("tooltip")).textContent).not.toContain("Click");
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => publishRegisteredPluginActions([["acme.docker.show", "Show containers"]]));
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("never runs a command outside its own plugin's namespace, even a registered one", () => {
    publishRegisteredPluginActions([["acme.other.show", "Other"]]);
    renderChips([{ pluginId: "acme.docker", status: { label: "x", command: "acme.other.show" } }]);
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("goes passive again when its command unregisters", async () => {
    publishRegisteredPluginActions([["acme.docker.show", "Show containers"]]);
    renderChips([docker]);

    act(() => publishRegisteredPluginActions([]));
    fireEvent.focus(screen.getByRole("button"));
    expect((await screen.findByRole("tooltip")).textContent).not.toContain("Click");
    fireEvent.click(screen.getByRole("button"));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("calls onBeforeRun as a command starts, and never for a plain status", () => {
    publishRegisteredPluginActions([["acme.docker.show", "Show containers"]]);
    const order: string[] = [];
    const onBeforeRun = vi.fn(() => order.push("before"));
    dispatchMock.mockImplementation(() => {
      order.push("dispatch");
      return new Promise(() => {});
    });
    renderChips(
      [docker, { pluginId: "acme.plain", status: { label: "idle", command: "acme.plain.x" } }],
      { onBeforeRun }
    );

    fireEvent.click(screen.getByRole("button", { name: "acme.plain: idle" }));
    expect(onBeforeRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "acme.docker: 2 up" }));
    expect(order).toEqual(["before", "dispatch"]);
  });

  it("hands focus back when the focused chip's status goes while another stays", async () => {
    const onFocusLost = vi.fn();
    const other = { pluginId: "acme.other", status: { label: "ok" } };
    const { rerender } = renderChips([docker, other], { onFocusLost });
    screen.getByRole("button", { name: "acme.docker: 2 up" }).focus();

    rerender(
      <TooltipProvider delayDuration={0}>
        <WorktreePluginStatusChips worktreeId="/wt" statuses={[other]} onFocusLost={onFocusLost} />
      </TooltipProvider>
    );

    await waitFor(() => expect(onFocusLost).toHaveBeenCalledTimes(1));
  });

  it("takes the tab order it is given", () => {
    renderChips([docker], { tabIndex: -1 });
    expect(screen.getByRole("button").tabIndex).toBe(-1);
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
    expect(onWorktreeCardStatusesChanged).toHaveBeenCalledTimes(1);
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
