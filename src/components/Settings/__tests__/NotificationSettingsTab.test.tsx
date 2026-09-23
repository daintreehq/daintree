// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(picker instanceof HTMLSelectElement && picker.disabled).toBe(true);
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
});
