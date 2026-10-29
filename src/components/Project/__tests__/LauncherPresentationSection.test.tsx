// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types/project";
import type { PresentationLevels } from "@shared/config/presentationProfile";
import type { ProjectPresentationSnapshot } from "@shared/types/ipc/projectPresentation";
import type { PluginLaunchEntryConfig } from "@shared/types/plugin";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import { usePluginLaunchEntriesStore } from "@/store/pluginLaunchEntriesStore";
import { LauncherPresentationSection } from "../LauncherPresentationSection";

const PROJECT = "a".repeat(64);
const NOTES = `project__${PROJECT}__acme.notes`;
const TOOLS = "zeta.tools";

const snapshot = (
  levels: PresentationLevels = {},
  over: Partial<ProjectPresentationSnapshot> = {}
): ProjectPresentationSnapshot => ({
  projectId: PROJECT,
  levels,
  suggestion: null,
  suggestionAnswer: null,
  useProjectToolbar: null,
  promotedPluginButtons: [],
  launcherGroupOrder: [],
  featuredLaunchEntry: null,
  webProject: null,
  revision: 0,
  ...over,
});

function entry(pluginId: string, pluginName: string, id: string): PluginLaunchEntryConfig {
  return {
    id: `${pluginId}.${id}`,
    pluginId,
    pluginName,
    label: id,
    iconId: "plus",
    priority: 3,
    target: { type: "command", actionId: `${pluginId}.${id}` },
  };
}

const get = vi.fn<() => Promise<ProjectPresentationSnapshot | null>>();
const setLevel = vi.fn<(feature: string, level: string | null) => Promise<unknown>>();
const setLauncherGroupOrder = vi.fn<(order: string[]) => Promise<unknown>>();
const setFeaturedLaunchEntry = vi.fn<(ref: string | null) => Promise<unknown>>();

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

async function renderSection(stored: ProjectPresentationSnapshot = snapshot()) {
  get.mockResolvedValue(stored);
  render(
    <TooltipProvider>
      <LauncherPresentationSection />
    </TooltipProvider>
  );
  await act(async () => {});
}

/** The group order as the list draws it. */
function drawnOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-launcher-group]")).map(
    (row) => row.dataset.launcherGroup ?? ""
  );
}

function groupRow(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-launcher-group="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  return within(row);
}

beforeEach(() => {
  _resetProjectPresentationStoreForTest();
  for (const mock of [get, setLevel, setLauncherGroupOrder, setFeaturedLaunchEntry]) {
    mock.mockReset();
  }
  setLauncherGroupOrder.mockImplementation((order) =>
    Promise.resolve(snapshot({}, { launcherGroupOrder: order, revision: 1 }))
  );
  setFeaturedLaunchEntry.mockImplementation((ref) =>
    Promise.resolve(snapshot({}, { featuredLaunchEntry: ref, revision: 1 }))
  );
  setLevel.mockImplementation(() => Promise.resolve(snapshot({}, { revision: 1 })));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      projectPresentation: {
        get,
        setLevel,
        setLauncherGroupOrder,
        setFeaturedLaunchEntry,
        onChanged: () => () => {},
      },
    },
  });
  const project: Project = {
    id: PROJECT,
    name: "Repo",
    path: "/repo",
    emoji: "",
    lastOpened: 0,
    gitBacked: true,
  };
  useProjectStore.setState({ currentProject: project });
  usePluginLaunchEntriesStore.setState({
    entries: [entry(TOOLS, "Tools", "run"), entry(NOTES, "Notes", "board")],
    hiddenPluginIds: [],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  _resetProjectPresentationStoreForTest();
  useProjectStore.setState({ currentProject: null });
  usePluginLaunchEntriesStore.setState({ entries: [], hiddenPluginIds: [] });
});

describe("LauncherPresentationSection", () => {
  it("lists the groups in the order the launcher draws them", async () => {
    await renderSection();
    expect(drawnOrder()).toEqual([
      "agents",
      "panels",
      `plugin:${NOTES}`,
      `plugin:${TOOLS}`,
      "recipes",
    ]);
  });

  it("puts the project's plugin first and demoted groups last once the project arranges it", async () => {
    await renderSection(snapshot({ launcherAgents: "demoted" }));
    expect(drawnOrder()).toEqual([
      `plugin:${NOTES}`,
      "panels",
      `plugin:${TOOLS}`,
      "recipes",
      "agents",
    ]);
    expect(groupRow("agents").getByText("In More")).toBeTruthy();
    // A demoted group moves only inside More, so it has nowhere to go.
    expect(groupRow("agents").getByLabelText("Move Agents up").hasAttribute("disabled")).toBe(true);
  });

  it("saves the whole order on a move, keeping groups that are not drawn right now", async () => {
    await renderSection(snapshot({}, { launcherGroupOrder: ["plugin:gone.plugin"] }));
    fireEvent.click(groupRow("panels").getByLabelText("Move Panels up"));
    await act(async () => {});
    // A group the stored order put first, and nothing draws now, stays first.
    expect(setLauncherGroupOrder).toHaveBeenCalledWith([
      "plugin:gone.plugin",
      "panels",
      "agents",
      `plugin:${NOTES}`,
      `plugin:${TOOLS}`,
      "recipes",
    ]);
  });

  it("keeps a group that is not drawn right now in the place the user gave it", async () => {
    await renderSection(
      snapshot({}, { launcherGroupOrder: ["plugin:gone.plugin", "agents", "panels"] })
    );
    fireEvent.click(groupRow("panels").getByLabelText("Move Panels up"));
    await act(async () => {});
    expect(setLauncherGroupOrder).toHaveBeenLastCalledWith([
      "plugin:gone.plugin",
      "panels",
      "agents",
      `plugin:${NOTES}`,
      `plugin:${TOOLS}`,
      "recipes",
    ]);
  });

  it("builds a second move on the first while the first is still saving", async () => {
    let resolveFirst!: (value: ProjectPresentationSnapshot) => void;
    setLauncherGroupOrder.mockImplementationOnce(
      () => new Promise<ProjectPresentationSnapshot>((resolve) => (resolveFirst = resolve))
    );
    await renderSection();
    fireEvent.click(groupRow("recipes").getByLabelText("Move Recipes up"));
    // The rows show the order being saved, and the buttons follow it.
    expect(drawnOrder()).toEqual([
      "agents",
      "panels",
      `plugin:${NOTES}`,
      "recipes",
      `plugin:${TOOLS}`,
    ]);
    fireEvent.click(groupRow("recipes").getByLabelText("Move Recipes up"));
    expect(setLauncherGroupOrder).toHaveBeenLastCalledWith([
      "agents",
      "panels",
      "recipes",
      `plugin:${NOTES}`,
      `plugin:${TOOLS}`,
    ]);
    await act(async () => {
      resolveFirst(snapshot({}, { revision: 1 }));
    });
  });

  it("lets an order saved elsewhere win over one still being saved here", async () => {
    setLauncherGroupOrder.mockImplementationOnce(() => new Promise(() => {}));
    await renderSection();
    fireEvent.click(groupRow("panels").getByLabelText("Move Panels up"));
    act(() => {
      useProjectPresentationStore.setState({
        launcherGroupOrder: ["recipes", "agents", "panels"],
        revision: 7,
      });
    });
    expect(drawnOrder().slice(0, 3)).toEqual(["recipes", "agents", "panels"]);
    fireEvent.click(groupRow("agents").getByLabelText("Move Agents down"));
    expect(setLauncherGroupOrder).toHaveBeenLastCalledWith([
      "recipes",
      "panels",
      "agents",
      `plugin:${NOTES}`,
      `plugin:${TOOLS}`,
    ]);
  });

  it("keeps a move that failed to save in place for Retry and builds on it", async () => {
    setLauncherGroupOrder.mockRejectedValueOnce(new Error("offline"));
    await renderSection();
    fireEvent.click(groupRow("recipes").getByLabelText("Move Recipes up"));
    await act(async () => {});
    expect(screen.getByText("Couldn't save the change")).toBeTruthy();
    expect(drawnOrder()[3]).toBe("recipes");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(groupRow("recipes").getByLabelText("Move Recipes up"));
    expect(setLauncherGroupOrder).toHaveBeenLastCalledWith([
      "agents",
      "panels",
      "recipes",
      `plugin:${NOTES}`,
      `plugin:${TOOLS}`,
    ]);
    await act(async () => {});
  });

  it("resets the order back to the project's", async () => {
    await renderSection(snapshot({}, { launcherGroupOrder: ["recipes"] }));
    expect(drawnOrder()[0]).toBe("recipes");
    fireEvent.click(screen.getByLabelText("Reset group order"));
    await act(async () => {});
    expect(setLauncherGroupOrder).toHaveBeenCalledWith([]);
  });

  it("shows the featured entry by its own label", async () => {
    await renderSection(snapshot({}, { featuredLaunchEntry: "acme.notes.board" }));
    const row = document.getElementById("project-launcher-featured");
    expect(row?.textContent).toContain("board");
  });

  it("keeps a featured entry whose plugin is not loaded, and lets it go", async () => {
    await renderSection(snapshot({}, { featuredLaunchEntry: "acme.gone.entry" }));
    const row = document.getElementById("project-launcher-featured");
    // Named in words: the stored ref is an internal id.
    expect(row?.textContent).toContain("An entry from a plugin that isn't loaded");
    expect(row?.textContent).not.toContain("acme.gone.entry");
    fireEvent.click(within(row!).getByRole("button", { name: /reset/i }));
    await act(async () => {});
    expect(setFeaturedLaunchEntry).toHaveBeenCalledWith(null);
  });

  it("says when a change could not be saved and retries it", async () => {
    setFeaturedLaunchEntry.mockRejectedValueOnce(new Error("offline"));
    await renderSection(snapshot({}, { featuredLaunchEntry: "acme.notes.board" }));
    const row = document.getElementById("project-launcher-featured");
    fireEvent.click(within(row!).getByRole("button", { name: /reset/i }));
    await act(async () => {});
    expect(screen.getByText("Couldn't save the change")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(setFeaturedLaunchEntry).toHaveBeenCalledTimes(2);
    expect(setFeaturedLaunchEntry).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("Couldn't save the change")).toBeNull();
  });

  it("offers nothing to feature when only installed plugins add entries", async () => {
    usePluginLaunchEntriesStore.setState({ entries: [entry(TOOLS, "Tools", "deploy")] });
    await renderSection();
    const row = document.getElementById("project-launcher-featured");
    expect(row?.textContent).toContain("This project's plugins add no launcher entries");
    expect(row?.querySelector("button")?.disabled).toBe(true);
  });

  it("takes no input until main has answered for the project", () => {
    get.mockReturnValue(new Promise(() => {}));
    render(
      <TooltipProvider>
        <LauncherPresentationSection />
      </TooltipProvider>
    );
    for (const button of screen.getAllByLabelText(/^Move /)) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });
});
