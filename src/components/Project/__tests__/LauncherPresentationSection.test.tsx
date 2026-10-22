// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types/project";
import type { PresentationLevels } from "@shared/config/presentationProfile";
import type { ProjectPresentationSnapshot } from "@shared/types/ipc/projectPresentation";
import type { PluginLaunchEntryConfig } from "@shared/types/plugin";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import { _resetProjectPresentationStoreForTest } from "@/store/projectPresentationStore";
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
    expect(setLauncherGroupOrder).toHaveBeenCalledWith([
      "panels",
      "agents",
      `plugin:${NOTES}`,
      `plugin:${TOOLS}`,
      "recipes",
      "plugin:gone.plugin",
    ]);
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
