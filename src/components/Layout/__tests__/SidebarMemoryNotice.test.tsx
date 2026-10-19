// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

function openMenu(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector<HTMLButtonElement>("[data-sidebar-memory-menu]")!;
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

function findDialog(): Promise<HTMLElement> {
  return waitFor(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("confirmation not open");
    return dialog;
  });
}

function menuItemLabels(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"]'), (el) => el.textContent ?? "");
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
        .setNotice({ critical: false, reading: READING, detail: DETAIL, action: null })
    );
    const { container } = renderRow();

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(READING);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("[data-sidebar-memory-menu]")).toBeNull();
    // Ambient chrome: no accent outside the focus ring, no status colour.
    const row = container.querySelector("[data-sidebar-memory-notice]")!;
    expect(row.outerHTML).not.toMatch(/(?<!outline-)accent-primary/);
    expect(row.outerHTML).not.toMatch(/status-(warning|danger|error)/);
  });

  it("takes the warning colour once the kernel reports its critical level (#13529)", () => {
    act(() =>
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ critical: true, reading: READING, detail: DETAIL, action: null })
    );
    const { container } = renderRow();

    const row = container.querySelector("[data-sidebar-memory-notice]")!;
    expect(row.outerHTML).toMatch(/status-warning/);
    expect(row.outerHTML).not.toMatch(/(?<!outline-)accent-primary/);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(READING);
  });

  it("offers the memory breakdown and clears when the store does", async () => {
    const onClick = vi.fn();
    act(() =>
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({
          critical: false,
          reading: READING,
          detail: DETAIL,
          action: { label: "Show memory use", onClick },
        })
    );
    const { container } = renderRow();

    const trigger = container.querySelector<HTMLButtonElement>("[data-sidebar-memory-menu]")!;
    // The menu sits outside the live region so it isn't re-announced.
    expect(container.querySelector('[role="status"]')?.contains(trigger)).toBe(false);

    const menu = openMenu(container);
    expect(menuItemLabels(menu)).toEqual(["Show memory use"]);
    const item = menu.querySelector<HTMLElement>("[data-sidebar-memory-action]")!;
    expect(item.getAttribute("aria-label")).toBe("Show memory use");

    fireEvent.click(item);
    await waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));

    act(() => useSystemMemoryNoticeStore.getState().clearNotice());
    expect(container.querySelector("[data-sidebar-memory-notice]")).toBeNull();
  });

  it("offers to sleep idle projects only while there are some", () => {
    act(() =>
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ critical: false, reading: READING, detail: DETAIL, action: null })
    );
    const { container } = renderRow();
    expect(container.querySelector("[data-sidebar-memory-menu]")).toBeNull();

    act(() => seedIdleProjects(["a"]));
    const trigger = container.querySelector<HTMLButtonElement>("[data-sidebar-memory-menu]")!;
    expect(container.querySelector('[role="status"]')?.contains(trigger)).toBe(false);
    const row = container.querySelector("[data-sidebar-memory-notice]")!;
    expect(row.outerHTML).not.toMatch(/(?<!outline-)accent-primary/);
    expect(menuItemLabels(openMenu(container))).toEqual(["Sleep idle projects"]);
  });

  it("collapses both actions into one button so the reading keeps the row", () => {
    act(() => {
      seedIdleProjects(["a"]);
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({
          critical: false,
          reading: READING,
          detail: DETAIL,
          action: { label: "Show memory use", onClick: vi.fn() },
        });
    });
    const { container } = renderRow();

    const row = container.querySelector("[data-sidebar-memory-notice]")!;
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(menuItemLabels(openMenu(container))).toEqual(["Show memory use", "Sleep idle projects"]);
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
        .setNotice({ critical: false, reading: READING, detail: DETAIL, action: null });
    });
    vi.spyOn(projectPresenceClient, "getSnapshot").mockResolvedValue({
      thisWindow: [],
      otherWindows: [],
    });
    vi.spyOn(terminalClient, "getAll").mockResolvedValue([]);
    const { container } = renderRow();

    const sleepItem = openMenu(container).querySelector("[data-sidebar-memory-sleep]")!;
    fireEvent.click(sleepItem);
    const dialog = await findDialog();
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
        .setNotice({ critical: false, reading: READING, detail: DETAIL, action: null });
    });
    vi.spyOn(projectPresenceClient, "getSnapshot").mockResolvedValue({
      thisWindow: [],
      otherWindows: [],
    });
    vi.spyOn(terminalClient, "getAll").mockResolvedValue([]);
    const { container } = renderRow();

    const sleepItem = openMenu(container).querySelector("[data-sidebar-memory-sleep]")!;
    fireEvent.click(sleepItem);
    const dialog = await findDialog();
    expect(dialog.textContent).toContain("Sleep 'Project a'?");
    expect(dialog.textContent).toContain("Its terminals will be stopped");
    expect(dialog.textContent).not.toContain("waiting agent");
  });

  it("hands focus to the confirmation, and back to the menu button on cancel", async () => {
    act(() => {
      seedIdleProjects(["a"]);
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({ critical: false, reading: READING, detail: DETAIL, action: null });
    });
    vi.spyOn(projectPresenceClient, "getSnapshot").mockResolvedValue({
      thisWindow: [],
      otherWindows: [],
    });
    vi.spyOn(terminalClient, "getAll").mockResolvedValue([]);
    const { container } = renderRow();
    const trigger = container.querySelector<HTMLButtonElement>("[data-sidebar-memory-menu]")!;
    trigger.focus();

    fireEvent.click(openMenu(container).querySelector("[data-sidebar-memory-sleep]")!);
    const dialog = await findDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // The menu's own restoration has already run; nothing pulls focus back out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialog.contains(document.activeElement)).toBe(true);

    const cancel = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel"
    )!;
    await act(async () => {
      fireEvent.click(cancel);
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("leaves focus where the agent action put it", async () => {
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    const onClick = vi.fn(() => elsewhere.focus());
    act(() =>
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({
          critical: false,
          reading: READING,
          detail: DETAIL,
          action: { label: "Show memory use", onClick },
        })
    );
    const { container } = renderRow();
    container.querySelector<HTMLButtonElement>("[data-sidebar-memory-menu]")!.focus();

    fireEvent.click(openMenu(container).querySelector("[data-sidebar-memory-action]")!);
    await waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("runs nothing when the menu is dismissed", async () => {
    const onClick = vi.fn();
    act(() => {
      seedIdleProjects(["a"]);
      useSystemMemoryNoticeStore
        .getState()
        .setNotice({
          critical: false,
          reading: READING,
          detail: DETAIL,
          action: { label: "Show memory use", onClick },
        });
    });
    const { container } = renderRow();

    const menu = openMenu(container);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onClick).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
