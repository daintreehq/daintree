// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectScheduleSwitches } from "@shared/types/scheduledRuns";
import type {
  ScheduleOsJobStatus,
  ScheduleSetSwitchesOutcome,
  SchedulesSnapshot,
} from "@shared/types/ipc/schedules";

// No jest-dom in this repo — plain DOM reads only.

const client = vi.hoisted(() => ({ setSwitches: vi.fn() }));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
const platform = vi.hoisted(() => ({
  isMac: vi.fn(() => true),
  isLinux: vi.fn(() => false),
  isWindows: vi.fn(() => false),
}));
vi.mock("@/lib/platform", async (importActual) => ({
  ...(await importActual<object>()),
  ...platform,
}));

import { ScheduleSwitches } from "../ScheduleSwitches";

const OFF: ProjectScheduleSwitches = {
  schedulesOn: false,
  startWhenClosed: false,
  schedulesOnSince: null,
};
const ON: ProjectScheduleSwitches = {
  schedulesOn: true,
  startWhenClosed: false,
  schedulesOnSince: 1,
};

function osStatus(
  kind: ScheduleOsJobStatus["context"]["kind"],
  unavailable: string | null = null
): ScheduleOsJobStatus {
  return {
    context: { kind, systemTimeZone: "Europe/London", unavailable },
    unavailable,
    state: "none",
    error: null,
    excluded: [],
  };
}

function snapshot(switches: ProjectScheduleSwitches): SchedulesSnapshot {
  return { projectId: "p1", switches, schedules: [], revision: 2 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const pushes = new EventTarget();
let pushed: ProjectScheduleSwitches | null = null;

/** Hands the harness switches main pushed, as another window's change arrives. */
function push(switches: ProjectScheduleSwitches) {
  pushed = switches;
  pushes.dispatchEvent(new Event("push"));
}

/** The switches as the tab holds them: main's answers, folded in. */
function Harness({
  initial,
  status,
}: {
  initial: ProjectScheduleSwitches | null;
  status: ScheduleOsJobStatus | null;
}) {
  const [switches, setSwitches] = useState(initial);
  useEffect(() => {
    const take = () => setSwitches(pushed);
    pushes.addEventListener("push", take);
    return () => pushes.removeEventListener("push", take);
  }, []);
  return (
    <ScheduleSwitches
      switches={switches}
      osJobStatus={status}
      onSaved={(next) => setSwitches(next.switches)}
    />
  );
}

function show(
  initial: ProjectScheduleSwitches | null,
  status: ScheduleOsJobStatus | null = osStatus("launch-agent")
) {
  render(<Harness initial={initial} status={status} />);
}

const schedulesOn = () => screen.getByRole("switch", { name: "Schedules on" });
const startSwitch = () => screen.getByRole("switch", { name: "Start Daintree for due schedules" });
const checked = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  platform.isMac.mockReturnValue(true);
  platform.isLinux.mockReturnValue(false);
  platform.isWindows.mockReturnValue(false);
});
afterEach(cleanup);

describe("ScheduleSwitches (#16168)", () => {
  it("says what turning schedules on allows while they're off, and holds the start switch until then", () => {
    show(OFF);
    expect(checked(schedulesOn())).toBe(false);
    expect(text()).toContain("Lets agents in this project run unattended on their schedules");
    expect(startSwitch().hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("Turn schedules on to use this");
  });

  it("offers the start switch once schedules are on", () => {
    show(ON);
    expect(startSwitch().hasAttribute("disabled")).toBe(false);
    expect(text()).not.toContain("Turn schedules on to use this");
  });

  it("holds both switches until the project's switches have been read", () => {
    show(null);
    expect(schedulesOn().hasAttribute("disabled")).toBe(true);
    expect(startSwitch().hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["launch-agent", "while the Mac is awake. It never wakes a sleeping Mac."],
    ["systemd-timer", "while the computer is awake. It never wakes a sleeping computer."],
    ["task-scheduler", "can wake the PC for it where wake timers are allowed"],
  ] as const)("says what starting Daintree does with a %s", (kind, words) => {
    show(ON, osStatus(kind));
    expect(text()).toContain(words);
  });

  it("says what this platform does before main has answered", () => {
    platform.isMac.mockReturnValue(false);
    platform.isWindows.mockReturnValue(true);
    show(ON, null);
    expect(text()).toContain("can wake the PC");
    expect(startSwitch().hasAttribute("disabled")).toBe(false);
  });

  it("can't be turned on where the job can't exist, and says why", () => {
    show(ON, osStatus("task-scheduler", "A Microsoft Store build can't register the task"));
    expect(startSwitch().hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("A Microsoft Store build can't register the task");
    cleanup();

    show(ON, osStatus(null));
    expect(startSwitch().hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("isn't available on this platform");
  });

  it("can always be turned off, even where the job can't exist", async () => {
    client.setSwitches.mockResolvedValueOnce({ status: "saved", snapshot: snapshot(ON) });
    show({ ...ON, startWhenClosed: true }, osStatus(null));
    expect(startSwitch().hasAttribute("disabled")).toBe(false);

    await act(async () => fireEvent.click(startSwitch()));
    expect(client.setSwitches).toHaveBeenCalledWith({ startWhenClosed: false });
    expect(checked(startSwitch())).toBe(false);
  });

  it("changes only the switch pressed, showing main's answer rather than the click", async () => {
    const answer = deferred<ScheduleSetSwitchesOutcome>();
    client.setSwitches.mockReturnValueOnce(answer.promise);
    show(ON);

    startSwitch().focus();
    fireEvent.click(startSwitch());
    expect(client.setSwitches).toHaveBeenCalledWith({ startWhenClosed: true });
    expect(checked(startSwitch())).toBe(false);
    expect(startSwitch().getAttribute("aria-busy")).toBe("true");
    // Held, not disabled, so the keyboard keeps its place.
    expect(startSwitch().hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(startSwitch());

    await act(async () =>
      answer.resolve({ status: "saved", snapshot: snapshot({ ...ON, startWhenClosed: true }) })
    );
    expect(checked(startSwitch())).toBe(true);
    expect(startSwitch().getAttribute("aria-busy")).toBeNull();
  });

  it("sends one change at a time", async () => {
    const answer = deferred<ScheduleSetSwitchesOutcome>();
    client.setSwitches.mockReturnValueOnce(answer.promise);
    show(ON);

    fireEvent.click(schedulesOn());
    fireEvent.click(schedulesOn());
    fireEvent.click(startSwitch());
    expect(client.setSwitches).toHaveBeenCalledTimes(1);
    expect(client.setSwitches).toHaveBeenCalledWith({ schedulesOn: false });

    await act(async () => answer.resolve({ status: "saved", snapshot: snapshot(OFF) }));
    expect(checked(schedulesOn())).toBe(false);
  });

  it("says why main refused a switch, offering no Retry, and leaves it as it was", async () => {
    client.setSwitches.mockResolvedValueOnce({
      status: "invalid",
      issues: [
        {
          path: "switches.startWhenClosed",
          cronField: null,
          message: "A Microsoft Store build can't register the task",
        },
      ],
    });
    show(ON);

    await act(async () => fireEvent.click(startSwitch()));
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't turn on starting Daintree for due schedules. A Microsoft Store build can't register the task"
    );
    expect(checked(startSwitch())).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says a switch couldn't be saved, and Retry asks for the same change again", async () => {
    const retried = deferred<ScheduleSetSwitchesOutcome>();
    client.setSwitches
      .mockRejectedValueOnce(new Error("The disk is full"))
      .mockReturnValueOnce(retried.promise);
    show(ON);

    await act(async () => fireEvent.click(schedulesOn()));
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't turn off schedules. The disk is full"
    );
    expect(checked(schedulesOn())).toBe(true);
    // Another window turned them off meanwhile: Retry still asks for off, not a flip.
    act(() => push(OFF));

    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(client.setSwitches).toHaveBeenLastCalledWith({ schedulesOn: false });
    // The failure, and its focused Retry, stay up while the retry is pending.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.activeElement).toBe(retry);

    await act(async () => retried.resolve({ status: "saved", snapshot: snapshot(OFF) }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(checked(schedulesOn())).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(schedulesOn()));
  });

  it("hands focus to the switch when a retry is refused and Retry goes", async () => {
    const retried = deferred<ScheduleSetSwitchesOutcome>();
    client.setSwitches
      .mockRejectedValueOnce(new Error("main went away"))
      .mockReturnValueOnce(retried.promise);
    show(ON);
    await act(async () => fireEvent.click(startSwitch()));

    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await act(async () =>
      retried.resolve({
        status: "invalid",
        issues: [{ path: "switches.startWhenClosed", cronField: null, message: "Not here" }],
      })
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(startSwitch()));
  });

  it("leaves focus where the keyboard went while a retry was pending", async () => {
    const retried = deferred<ScheduleSetSwitchesOutcome>();
    client.setSwitches
      .mockRejectedValueOnce(new Error("main went away"))
      .mockReturnValueOnce(retried.promise);
    show(ON);
    await act(async () => fireEvent.click(schedulesOn()));

    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    startSwitch().focus();
    await act(async () => retried.resolve({ status: "saved", snapshot: snapshot(OFF) }));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(startSwitch());
  });

  it("clears a failure when another change goes through", async () => {
    client.setSwitches.mockRejectedValueOnce(new Error("The disk is full")).mockResolvedValueOnce({
      status: "saved",
      snapshot: snapshot({ ...ON, startWhenClosed: true }),
    });
    show(ON);

    await act(async () => fireEvent.click(schedulesOn()));
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => fireEvent.click(startSwitch()));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
