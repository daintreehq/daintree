// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const cancelMock = vi.hoisted(() => vi.fn());
const sleepNowMock = vi.hoisted(() => vi.fn());
const keepWaitingMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/projectSleepWait", () => ({
  SLEEP_WAIT_TIMEOUT_MS: 30 * 60_000,
  cancelSleepWait: () => cancelMock(),
  sleepWaitingNow: () => sleepNowMock(),
  keepWaiting: () => keepWaitingMock(),
}));

import { useProjectSleepWaitStore, type SleepWaitRun } from "@/store/projectSleepWaitStore";
import { ProjectSleepWaitDialog } from "../ProjectSleepWaitDialog";

function runWith(overrides: Partial<SleepWaitRun> = {}): SleepWaitRun {
  return {
    id: 1,
    phase: "waiting",
    pauseNote: false,
    projects: [
      {
        id: "a",
        name: "Alpha",
        status: "waiting",
        agents: [
          { terminalId: "t1", title: "Claude", observation: "working", note: "sent" },
          { terminalId: "t2", title: "Codex", observation: "approval" },
          { terminalId: "t3", title: "Gemini", observation: "waiting-input" },
        ],
      },
      { id: "b", name: "Beta", status: "left-open", agents: [] },
    ],
    ...overrides,
  };
}

const dialog = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!el) throw new Error("dialog not open");
    return el;
  });

const button = (root: HTMLElement, label: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);

afterEach(() => {
  cleanup();
  useProjectSleepWaitStore.getState().setRun(null);
  vi.clearAllMocks();
});

describe("ProjectSleepWaitDialog", () => {
  it("renders nothing while no wait runs", () => {
    render(<ProjectSleepWaitDialog />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("lists what was observed for each agent, per project", async () => {
    useProjectSleepWaitStore.getState().setRun(runWith());
    render(<ProjectSleepWaitDialog />);
    const el = await dialog();
    expect(el.textContent).toContain("Waiting to sleep 2 projects");
    const rows = Array.from(el.querySelectorAll("[data-sleep-wait-agent]"), (n) => n.textContent);
    expect(rows).toEqual([
      "ClaudeWorking · asked to pause",
      "CodexWaiting for approval",
      "GeminiWaiting for input",
    ]);
    expect(el.querySelector('[data-sleep-wait-project="b"]')?.textContent).toContain("Left open");
    expect(el.textContent).not.toMatch(/safe/i);
    expect(button(el, "Keep waiting")).toBeUndefined();
    expect(el.querySelector("[data-sleep-wait-announce]")?.textContent).toBe("");
  });

  it("locks every choice once sleeping has begun, Escape included", async () => {
    useProjectSleepWaitStore.getState().setRun(runWith({ phase: "sleeping" }));
    render(<ProjectSleepWaitDialog />);
    const el = await dialog();
    expect(el.textContent).toContain("Sleeping 2 projects");
    await act(async () => {
      fireEvent.click(button(el, "Sleep now")!);
      fireEvent.click(button(el, "Cancel")!);
      fireEvent.keyDown(el, { key: "Escape" });
    });
    expect(sleepNowMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("cancels the wait on Escape while it is still waiting", async () => {
    useProjectSleepWaitStore.getState().setRun(runWith());
    render(<ProjectSleepWaitDialog />);
    const el = await dialog();
    await act(async () => {
      fireEvent.keyDown(el, { key: "Escape" });
    });
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("follows the run as agents settle", async () => {
    useProjectSleepWaitStore.getState().setRun(runWith());
    render(<ProjectSleepWaitDialog />);
    await dialog();
    act(() => {
      useProjectSleepWaitStore.getState().setRun(
        runWith({
          projects: [
            {
              id: "a",
              name: "Alpha",
              status: "ready",
              agents: [{ terminalId: "t1", title: "Claude", observation: "idle" }],
            },
          ],
        })
      );
    });
    const el = await dialog();
    expect(el.textContent).toContain("Waiting to sleep 'Alpha'");
    expect(el.textContent).toContain("Ready to sleep");
    expect(el.querySelector('[data-sleep-wait-agent="t1"]')?.textContent).toBe("ClaudeIdle");
  });

  it("routes Sleep now and Cancel to the run", async () => {
    useProjectSleepWaitStore.getState().setRun(runWith());
    render(<ProjectSleepWaitDialog />);
    const el = await dialog();
    await act(async () => {
      fireEvent.click(button(el, "Sleep now")!);
    });
    expect(sleepNowMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(button(el, "Cancel")!);
    });
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("asks after the timeout instead of sleeping, with Keep waiting", async () => {
    useProjectSleepWaitStore.getState().setRun(runWith({ phase: "timed-out" }));
    render(<ProjectSleepWaitDialog />);
    const el = await dialog();
    expect(el.textContent).toContain("Still waiting to sleep 2 projects");
    expect(el.textContent).toContain("Nothing sleeps until you choose");
    expect(el.querySelector("[data-sleep-wait-announce]")?.textContent).toContain(
      "Still waiting"
    );
    await act(async () => {
      fireEvent.click(button(el, "Keep waiting")!);
    });
    expect(keepWaitingMock).toHaveBeenCalledTimes(1);
    expect(sleepNowMock).not.toHaveBeenCalled();
  });
});
