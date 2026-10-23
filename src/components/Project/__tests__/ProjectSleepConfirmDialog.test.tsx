// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import type { SleepConfirmProject, SleepConfirmRequest } from "@/store/projectSleepConfirmStore";
import { ProjectSleepConfirmDialog, formatEstimatedMemory } from "../ProjectSleepConfirmDialog";

function project(id: string, overrides: Partial<SleepConfirmProject> = {}): SleepConfirmProject {
  return {
    id,
    name: `Project ${id}`,
    path: `/repos/${id}`,
    terminalCount: 0,
    waitingAgentCount: 0,
    activeAgentCount: 0,
    isActive: false,
    ...overrides,
  };
}

function open(request: SleepConfirmRequest): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = useProjectSleepConfirmStore.getState().requestConfirmation(request);
  });
  return answer;
}

const dialog = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!el) throw new Error("dialog not open");
    return el;
  });

const button = (root: HTMLElement, label: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label)!;

afterEach(() => {
  cleanup();
  useProjectSleepConfirmStore.getState().resolveConfirmation(false);
});

describe("formatEstimatedMemory", () => {
  it("rounds megabytes, switches to gigabytes from 1024, and doesn't invent a floor", () => {
    expect(formatEstimatedMemory(0)).toBe("0 MB");
    expect(formatEstimatedMemory(511.6)).toBe("512 MB");
    expect(formatEstimatedMemory(1536)).toBe("1.5 GB");
  });
});

describe("ProjectSleepConfirmDialog", () => {
  it("renders nothing until a request is pending", () => {
    render(<ProjectSleepConfirmDialog />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("previews one project with its counts and no memory estimate, and resolves true on confirm", async () => {
    render(<ProjectSleepConfirmDialog />);
    const answer = open({
      kind: "project",
      projects: [project("a", { terminalCount: 3, activeAgentCount: 1, waitingAgentCount: 2 })],
    });
    const el = await dialog();
    expect(el.textContent).toContain("Sleep 'Project a'?");
    expect(el.textContent).toContain("3 terminals");
    expect(el.textContent).toContain("1 active agent");
    expect(el.textContent).toContain("2 waiting agents");
    expect(el.querySelector("[data-sleep-project-memory]")).toBeNull();
    expect(el.textContent).not.toContain("This window returns");

    await act(async () => {
      fireEvent.click(button(el, "Sleep project"));
    });
    expect(await answer).toBe(true);
  });

  it("says the window returns to the picker when the project is on screen", async () => {
    render(<ProjectSleepConfirmDialog />);
    void open({ kind: "project", projects: [project("a", { isActive: true })] });
    const el = await dialog();
    expect(el.textContent).toContain("This window returns to the project picker");
    expect(el.textContent).not.toContain("terminals will be stopped");
  });

  it("estimates each idle project, and totals only what was measured", async () => {
    render(<ProjectSleepConfirmDialog />);
    void open({
      kind: "idle",
      projects: [project("a", { terminalMemoryMB: 1536 }), project("b")],
    });
    const el = await dialog();
    expect(
      Array.from(el.querySelectorAll("[data-sleep-project-memory]"), (n) => n.textContent)
    ).toEqual(["About 1.5 GB", "Memory unavailable"]);
    expect(el.textContent).toContain("About 1.5 GB across the 1 project measured");
    expect(el.textContent).not.toContain("Up to");
  });

  it("states an upper bound only when every project was measured", async () => {
    render(<ProjectSleepConfirmDialog />);
    void open({
      kind: "idle",
      projects: [project("a", { terminalMemoryMB: 100 }), project("b", { terminalMemoryMB: 200 })],
    });
    const el = await dialog();
    expect(el.textContent).toContain("Up to 300 MB of terminal memory, estimated");
    expect(el.textContent).toContain("the memory actually freed is lower");
  });

  it("omits the total when no project has a reading", async () => {
    render(<ProjectSleepConfirmDialog />);
    void open({ kind: "idle", projects: [project("a"), project("b")] });
    const el = await dialog();
    expect(el.querySelector("[data-sleep-memory-total]")).toBeNull();
    expect(el.textContent).toContain("Sleep 2 idle projects?");
  });

  it("resolves false on cancel", async () => {
    render(<ProjectSleepConfirmDialog />);
    const answer = open({ kind: "idle", projects: [project("a")] });
    const el = await dialog();
    await act(async () => {
      fireEvent.click(button(el, "Cancel"));
    });
    expect(await answer).toBe(false);
    expect(useProjectSleepConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("shows the newer request when it supersedes an open one", async () => {
    render(<ProjectSleepConfirmDialog />);
    const first = open({ kind: "project", projects: [project("a")] });
    await dialog();
    void open({ kind: "project", projects: [project("b")] });
    expect(await first).toBe(false);
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Sleep 'Project b'?")
    );
  });

  it("warns about a restart even with nothing counted, names the reopen, and resolves on confirm", async () => {
    render(<ProjectSleepConfirmDialog />);
    const answer = open({ kind: "restart", projects: [project("a", { isActive: true })] });
    const root = await dialog();
    expect(root.textContent).toContain("Restart 'Project a'?");
    expect(root.textContent).toContain("Everything running in it will be stopped");
    expect(root.textContent).toContain("reopens in this window");
    expect(root.textContent).toContain("Other windows showing it return to the project picker");
    expect(root.textContent).not.toContain("This window returns to the project picker");
    expect(button(root, "Sleep project")).toBeUndefined();
    fireEvent.click(button(root, "Restart project"));
    await expect(answer).resolves.toBe(true);
  });

  it("lists what a restart stops when the counts are known", async () => {
    render(<ProjectSleepConfirmDialog />);
    void open({
      kind: "restart",
      projects: [project("a", { isActive: true, terminalCount: 3, activeAgentCount: 1 })],
    });
    const root = await dialog();
    expect(root.textContent).toContain("3 terminals");
    expect(root.textContent).toContain("1 active agent");
    expect(root.textContent).not.toContain("waiting agent");
  });
});
