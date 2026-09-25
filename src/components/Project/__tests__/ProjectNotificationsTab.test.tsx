// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings } from "@shared/types";
import { ProjectNotificationsTab } from "../ProjectNotificationsTab";
import { NotificationSettingsTab } from "@/components/Settings/NotificationSettingsTab";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const GLOBAL: NotificationSettings = {
  enabled: true,
  completedEnabled: false,
  waitingEnabled: true,
  soundEnabled: true,
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

beforeEach(() => {
  getSettings = vi.fn().mockResolvedValue({ ...GLOBAL });
  Reflect.set(window, "electron", {
    notification: {
      getSettings,
      setSettings: vi.fn().mockResolvedValue(undefined),
      playSound: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

function labelsOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-settings-row] > div > div > span[id]"))
    .map((el) => el.textContent ?? "")
    .filter(Boolean);
}

describe("ProjectNotificationsTab", () => {
  it("offers every setting the global page shows that a project can override, worded the same", async () => {
    const project = render(<ProjectNotificationsTab overrides={{}} onChange={vi.fn()} />);
    await screen.findAllByText(/Using global default/);
    const projectLabels = labelsOf(project.container);
    project.unmount();

    const global = render(<NotificationSettingsTab />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    const globalLabels = labelsOf(global.container);

    // Keys the effective-settings resolver lets a project override
    // (ProjectSettingsManager.getEffectiveNotificationSettings).
    const overridable = [
      "Agent completed",
      "Agent waiting for input",
      "Escalate if still waiting",
      "Escalation delay",
      "Play sound",
      "Completed sound",
      "Waiting sound",
      "Escalation sound",
      "Working pulse",
      "Working pulse sound",
    ];
    for (const label of overridable) {
      expect(projectLabels).toContain(label);
      expect(globalLabels).toContain(label);
    }
  });

  it("resetting a row clears only that row's override", async () => {
    const onChange = vi.fn();
    render(
      <ProjectNotificationsTab
        overrides={{
          waitingEnabled: false,
          waitingEscalationEnabled: true,
          waitingEscalationDelayMs: 600_000,
        }}
        onChange={onChange}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Reset agent waiting for input to global default" })
    );
    expect(onChange).toHaveBeenCalledWith({
      waitingEscalationEnabled: true,
      waitingEscalationDelayMs: 600_000,
    });
  });

  it("disables every row with a reason while notifications are off globally", async () => {
    getSettings.mockResolvedValue({ ...GLOBAL, enabled: false });
    render(<ProjectNotificationsTab overrides={{ completedEnabled: true }} onChange={vi.fn()} />);

    const reasons = await screen.findAllByText(/Notifications are turned off in global settings/);
    expect(reasons.length).toBeGreaterThan(0);
    for (const toggle of screen.getAllByRole("switch")) {
      expect(toggle.hasAttribute("disabled")).toBe(true);
    }
  });

  it("keeps the escalation delay visible, disabled with a reason, while escalation is off", async () => {
    render(<ProjectNotificationsTab overrides={{}} onChange={vi.fn()} />);

    const delay = await screen.findByRole("radiogroup", { name: "Escalation delay" });
    await screen.findByText("Turn on Escalate if still waiting to choose a delay");
    for (const option of Array.from(delay.querySelectorAll('[role="radio"]'))) {
      expect(option.hasAttribute("disabled")).toBe(true);
    }
  });

  it("says the global default is unavailable, with Retry, when the globals fail to load", async () => {
    getSettings.mockRejectedValueOnce(new Error("boom"));
    render(<ProjectNotificationsTab overrides={{}} onChange={vi.fn()} />);

    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getAllByText(/Global default unavailable/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading global default/)).toBeNull();
  });
});
