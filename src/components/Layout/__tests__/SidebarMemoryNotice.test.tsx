// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project } from "@shared/types/project";
import type { ProjectSleepResult, ProjectStatusEntry } from "@shared/types/ipc/project";
import { projectPresenceClient } from "@/clients/projectPresenceClient";
import { terminalClient } from "@/clients/terminalClient";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectStore } from "@/store/projectStore";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";
import { SidebarMemoryNotice } from "../SidebarMemoryNotice";

const READING = "Swap is 91% full.";
const DETAIL = "Swap is 91% full. Restarting your Mac clears this.";

function renderRow() {
  return render(
    <TooltipProvider>
      <SidebarMemoryNotice />
    </TooltipProvider>
  );
}

const initialSleep = useProjectStore.getState().sleepProject;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSystemMemoryNoticeStore.setState({ notice: null });
  useProjectStore.setState({ projects: [], currentProject: null, sleepProject: initialSleep });
  useProjectStatsStore.setState({ stats: {} });
});

function seedIdleProjects(ids: string[], waitingAgentCount = 2) {
  useProjectStore.setState({
    projects: ids.map((id): Project => ({
      id,
      name: `Project ${id}`,
      path: `/repos/${id}`,
      emoji: "🌲",
      lastOpened: 0,
      status: "background",
    })),
    currentProject: null,
  });
  useProjectStatsStore.setState({
    stats: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          activeAgentCount: 0,
          waitingAgentCount,
          processCount: 0,
          blockedAgentCount: 0,
          completedAgentCount: 0,
          unacknowledgedCompletedAgentCount: 0,
          snoozedAgentCount: 0,
        } satisfies ProjectStatusEntry,
      ])
    ),
  });
}

describe("SidebarMemoryNotice", () => {
  it("renders nothing while no episode is open", () => {
    const { container } = renderRow();
    expect(container.querySelector("[data-sidebar-memory-notice]")).toBeNull();
  });

  it("states the reading as a polite status line with no action when none was offered", () => {
    act(() =>
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ reading: READING, detail: DETAIL, action: null })
    );
    const { container } = renderRow();

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(READING);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("[data-sidebar-memory-action]")).toBeNull();
    // Ambient chrome: no accent outside the focus ring, no status colour.
    const row = container.querySelector("[data-sidebar-memory-notice]")!;
    expect(row.outerHTML).not.toMatch(/(?<!outline-)accent-primary/);
    expect(row.outerHTML).not.toMatch(/status-(warning|danger|error)/);
  });

  it("offers the diagnosis and clears when the store does", () => {
    const onClick = vi.fn();
    act(() =>
      useSystemMemoryNoticeStore.getState().setNotice({
        reading: READING,
        detail: DETAIL,
        action: { label: "Ask agent about memory", onClick },
      })
    );
    const { container } = renderRow();

    const button = container.querySelector<HTMLButtonElement>("[data-sidebar-memory-action]")!;
    expect(button.getAttribute("aria-label")).toBe("Ask agent about memory");
    expect(button.textContent).toBe("Ask agent about memory");
    // The action sits outside the live region so it isn't re-announced.
    expect(container.querySelector('[role="status"]')?.contains(button)).toBe(false);

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => useSystemMemoryNoticeStore.getState().clearNotice());
    expect(container.querySelector("[data-sidebar-memory-notice]")).toBeNull();
  });

  it("offers to sleep idle projects only while there are some", () => {
    act(() =>
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ reading: READING, detail: DETAIL, action: null })
    );
    const { container } = renderRow();
    expect(container.querySelector("[data-sidebar-memory-sleep]")).toBeNull();

    act(() => seedIdleProjects(["a"]));
    const button = container.querySelector<HTMLButtonElement>("[data-sidebar-memory-sleep]")!;
    expect(button.getAttribute("aria-label")).toBe("Sleep idle projects");
    expect(container.querySelector('[role="status"]')?.contains(button)).toBe(false);
    const row = container.querySelector("[data-sidebar-memory-notice]")!;
    expect(row.outerHTML).not.toMatch(/(?<!outline-)accent-primary/);
  });

  it("names every project in the confirmation, and sleeps them on confirm", async () => {
    const sleepProject = vi.fn(async (_id: string): Promise<ProjectSleepResult> => ({
      terminalsKilled: 0,
      rendererViewsEvicted: 0,
      workspaceEvicted: false,
    }));
    act(() => {
      seedIdleProjects(["a", "b"]);
      useProjectStore.setState({ sleepProject });
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ reading: READING, detail: DETAIL, action: null });
    });
    vi.spyOn(projectPresenceClient, "getSnapshot").mockResolvedValue({
      thisWindow: [],
      otherWindows: [],
    });
    vi.spyOn(terminalClient, "getAll").mockResolvedValue([]);
    const { container } = renderRow();

    await act(async () => {
      fireEvent.click(container.querySelector("[data-sidebar-memory-sleep]")!);
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sleep 2 idle projects?");
    const listed = Array.from(
      dialog.querySelectorAll("[data-sleep-idle-projects] li"),
      (li) => li.textContent
    );
    expect(listed).toEqual(["Project a/repos/a", "Project b/repos/b"]);
    expect(dialog.textContent).toContain("Their terminals will be stopped");
    expect(dialog.textContent).toContain("4 waiting agents");
    expect(sleepProject).not.toHaveBeenCalled();

    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "Sleep projects"
    )!;
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(sleepProject.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("says the terminals stop even when it has no counts to show", async () => {
    act(() => {
      seedIdleProjects(["a"], 0);
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ reading: READING, detail: DETAIL, action: null });
    });
    vi.spyOn(projectPresenceClient, "getSnapshot").mockResolvedValue({
      thisWindow: [],
      otherWindows: [],
    });
    vi.spyOn(terminalClient, "getAll").mockResolvedValue([]);
    const { container } = renderRow();

    await act(async () => {
      fireEvent.click(container.querySelector("[data-sidebar-memory-sleep]")!);
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sleep 'Project a'?");
    expect(dialog.textContent).toContain("Its terminals will be stopped");
    expect(dialog.textContent).not.toContain("waiting agent");
  });
});
