// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings } from "@shared/types";
import { NotificationSettingsTab } from "../NotificationSettingsTab";

const BASE: NotificationSettings = {
  enabled: true,
  completedEnabled: false,
  waitingEnabled: true,
  soundEnabled: false,
  completedSoundFile: "complete.wav",
  waitingSoundFile: "waiting.wav",
  escalationSoundFile: "ping.wav",
  waitingEscalationEnabled: false,
  waitingEscalationDelayMs: 180_000,
  workingPulseEnabled: false,
  workingPulseSoundFile: "pulse.wav",
  uiFeedbackSoundEnabled: false,
  flashEnabled: false,
  quietHoursEnabled: false,
  quietHoursStartMin: 22 * 60,
  quietHoursEndMin: 8 * 60,
  quietHoursWeekdays: [],
};

let getSettings: ReturnType<typeof vi.fn>;
let setSettings: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getSettings = vi.fn().mockResolvedValue({ ...BASE });
  setSettings = vi.fn().mockResolvedValue(undefined);
  Reflect.set(window, "electron", {
    notification: { getSettings, setSettings, playSound: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("NotificationSettingsTab", () => {
  it("renders agent events as switches that keep the e2e ids", async () => {
    const { container } = render(<NotificationSettingsTab />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    for (const id of ["notif-completed", "notif-waiting", "notif-waiting-escalation"]) {
      const control = container.querySelector(`#${id}`);
      expect(control?.getAttribute("role")).toBe("switch");
    }
    expect(screen.getByRole("switch", { name: "Agent completed" })).toBeTruthy();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    const completed = container.querySelector("#notif-completed");
    if (!(completed instanceof HTMLElement)) throw new Error("switch missing");
    await waitFor(() => expect(completed.hasAttribute("disabled")).toBe(false));
    fireEvent.click(completed);
    expect(setSettings).toHaveBeenCalledWith({ completedEnabled: true });
  });

  it("keeps sound pickers visible but disabled with a reason while sound is off", async () => {
    render(<NotificationSettingsTab />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    const picker = await screen.findByRole("combobox", { name: "Completed sound" });
    expect(picker.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Turn on Play sound to choose sounds and hear UI feedback")
    ).toBeTruthy();
  });

  it("keeps the page and offers Retry when settings fail to load", async () => {
    getSettings.mockRejectedValueOnce(new Error("boom"));
    render(<NotificationSettingsTab />);

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Agent notifications")).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: "Enable notifications" }) as HTMLButtonElement).disabled
    ).toBe(true);

    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it("marks a changed setting as modified and resets it to the default", async () => {
    getSettings.mockResolvedValueOnce({ ...BASE, completedEnabled: true });
    render(<NotificationSettingsTab />);

    const resetButton = await screen.findByRole("button", {
      name: "Reset Agent completed to default",
    });
    fireEvent.click(resetButton);
    expect(setSettings).toHaveBeenCalledWith({ completedEnabled: false });
  });

  it("keeps a failed save on its group with a Retry that re-sends the change", async () => {
    setSettings.mockRejectedValueOnce(new Error("disk full"));
    const { container } = render(<NotificationSettingsTab />);

    const completed = container.querySelector("#notif-completed");
    if (!(completed instanceof HTMLElement)) throw new Error("switch missing");
    await waitFor(() => expect(completed.hasAttribute("disabled")).toBe(false));

    fireEvent.click(completed);
    await screen.findByText("Couldn't save that change");
    expect(completed.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setSettings).toHaveBeenLastCalledWith({ completedEnabled: true });
    await waitFor(() => expect(screen.queryByText("Couldn't save that change")).toBeNull());
    expect(completed.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the escalation delay visible but disabled with a reason while escalation is off", async () => {
    render(<NotificationSettingsTab />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    const delay = await screen.findByRole("radiogroup", { name: "Escalation delay" });
    await screen.findByText("Turn on Escalate if still waiting to choose a delay");
    for (const option of within(delay).getAllByRole("radio")) {
      expect(option.hasAttribute("disabled")).toBe(true);
    }
    const reason = screen.getByText("Turn on Escalate if still waiting to choose a delay");
    const describedBy = delay.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toContain(reason.closest("p")?.id);
  });

  it("describes the quiet-hours time pickers by their row description", async () => {
    getSettings.mockResolvedValueOnce({
      ...BASE,
      quietHoursEnabled: true,
      quietHoursStartMin: 8 * 60,
      quietHoursEndMin: 8 * 60,
    });
    render(<NotificationSettingsTab />);

    const end = await screen.findByRole("combobox", { name: "Ends at" });
    const describedBy = end.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!.split(" ")[0]!)?.textContent).toMatch(
      /Start and end match/
    );
  });

  it("never lets the last active quiet-hours day be cleared into 'every day'", async () => {
    getSettings.mockResolvedValueOnce({
      ...BASE,
      quietHoursEnabled: true,
      quietHoursWeekdays: [3],
    });
    render(<NotificationSettingsTab />);

    const wednesday = await screen.findByRole("button", { name: "Wednesday" });
    await waitFor(() => expect(wednesday.hasAttribute("disabled")).toBe(false));
    fireEvent.click(wednesday);
    expect(setSettings).not.toHaveBeenCalled();
    expect(wednesday.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Monday" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("marks an overnight schedule as ending the next day", async () => {
    getSettings.mockResolvedValueOnce({ ...BASE, quietHoursEnabled: true });
    render(<NotificationSettingsTab />);

    expect(await screen.findByText("22:00 to 08:00 the next day")).toBeTruthy();
  });

  it("a failed save rolls back only its own change, not a newer one that succeeded", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    setSettings
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
      )
      .mockResolvedValueOnce(undefined);
    const { container } = render(<NotificationSettingsTab />);

    const completed = container.querySelector("#notif-completed");
    const waiting = container.querySelector("#notif-waiting");
    if (!(completed instanceof HTMLElement) || !(waiting instanceof HTMLElement)) {
      throw new Error("switches missing");
    }
    await waitFor(() => expect(completed.hasAttribute("disabled")).toBe(false));

    fireEvent.click(completed);
    fireEvent.click(waiting);
    await act(async () => {
      rejectFirst(new Error("disk full"));
    });

    await screen.findByText("Couldn't save that change");
    expect(completed.getAttribute("aria-checked")).toBe("false");
    expect(waiting.getAttribute("aria-checked")).toBe("false");
  });

  it("a failed save that a newer edit superseded rolls nothing back", async () => {
    const rejects: Array<(error: Error) => void> = [];
    setSettings.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejects.push(reject);
        })
    );
    const { container } = render(<NotificationSettingsTab />);

    const completed = container.querySelector("#notif-completed");
    if (!(completed instanceof HTMLElement)) throw new Error("switch missing");
    await waitFor(() => expect(completed.hasAttribute("disabled")).toBe(false));

    fireEvent.click(completed); // on
    fireEvent.click(completed); // off
    fireEvent.click(completed); // on — the newest edit
    await act(async () => {
      rejects[0]?.(new Error("disk full"));
    });

    expect(completed.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Couldn't save that change")).toBeNull();
  });

  it("ignores a superseded load that settles after a successful retry", async () => {
    let resolveFirst: (value: NotificationSettings) => void = () => {};
    getSettings
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ ...BASE, completedEnabled: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = render(<NotificationSettingsTab />);
      await act(async () => {
        vi.advanceTimersByTime(10_001);
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      });
      const completed = container.querySelector("#notif-completed");
      await waitFor(() => expect(completed?.getAttribute("aria-checked")).toBe("true"));

      await act(async () => {
        resolveFirst({ ...BASE, completedEnabled: false });
      });
      expect(completed?.getAttribute("aria-checked")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Retry resends only what a newer successful edit hasn't already replaced", async () => {
    getSettings.mockResolvedValueOnce({
      ...BASE,
      quietHoursEnabled: true,
      quietHoursStartMin: 21 * 60,
      quietHoursEndMin: 7 * 60,
    });
    let rejectReset: (error: Error) => void = () => {};
    setSettings
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectReset = reject;
          })
      )
      .mockResolvedValue(undefined);
    render(<NotificationSettingsTab />);

    const resetHours = await screen.findByRole("button", {
      name: "Reset quiet hours to 22:00 to 08:00",
    });
    fireEvent.click(resetHours);

    const start = screen.getByRole("combobox", { name: "Starts at" });
    fireEvent.keyDown(start, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "23:00" }));
    await waitFor(() => expect(setSettings).toHaveBeenLastCalledWith({ quietHoursStartMin: 1380 }));

    await act(async () => {
      rejectReset(new Error("disk full"));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    });
    expect(setSettings).toHaveBeenLastCalledWith({ quietHoursEndMin: 480 });
  });
});
