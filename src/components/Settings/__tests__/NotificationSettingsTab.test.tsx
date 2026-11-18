// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings } from "@shared/types";
import { NotificationSettingsTab } from "../NotificationSettingsTab";

const importMock = vi.hoisted(() => ({ importNotificationSound: vi.fn() }));
vi.mock("@/services/notificationSoundImport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/notificationSoundImport")>()),
  importNotificationSound: importMock.importNotificationSound,
}));

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
let getNotificationSilences: ReturnType<typeof vi.fn>;
let setNotificationSilenced: ReturnType<typeof vi.fn>;
let listCustomSounds: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getSettings = vi.fn().mockResolvedValue({ ...BASE });
  setSettings = vi.fn().mockResolvedValue(undefined);
  getNotificationSilences = vi.fn().mockResolvedValue([]);
  setNotificationSilenced = vi.fn().mockResolvedValue([]);
  listCustomSounds = vi.fn().mockResolvedValue([]);
  importMock.importNotificationSound.mockReset();
  Reflect.set(window, "electron", {
    notification: { getSettings, setSettings, playSound: vi.fn().mockResolvedValue(undefined) },
    notificationSounds: { list: listCustomSounds },
    plugin: { getNotificationSilences, setNotificationSilenced },
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
    expect(screen.getByRole("switch", { name: "Agent finished" })).toBeTruthy();
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

    const picker = await screen.findByRole("combobox", { name: "Finished sound" });
    expect(picker.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Turn on Play sound to choose sounds and hear UI feedback")
    ).toBeTruthy();
  });

  describe("volume", () => {
    async function renderWithSound(overrides: Partial<NotificationSettings> = {}) {
      getSettings.mockResolvedValueOnce({ ...BASE, soundEnabled: true, ...overrides });
      render(<NotificationSettingsTab />);
      const slider = await screen.findByRole("slider", { name: "Volume" });
      await waitFor(() => expect((slider as HTMLInputElement).disabled).toBe(false));
      return slider as HTMLInputElement;
    }

    it("reads a missing level as full volume, unmodified", async () => {
      const slider = await renderWithSound();

      expect(slider.value).toBe("100");
      expect(screen.queryByRole("button", { name: "Reset volume to 100%" })).toBeNull();
    });

    it("shows each step while dragging and saves once when the drag ends", async () => {
      const slider = await renderWithSound({ soundVolume: 0.8 });

      expect(slider.value).toBe("80");
      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: "55" } });
      fireEvent.change(slider, { target: { value: "40" } });
      expect(slider.getAttribute("aria-valuetext")).toBe("40 percent");
      expect(setSettings).not.toHaveBeenCalled();

      fireEvent.pointerUp(slider);
      expect(setSettings).toHaveBeenCalledTimes(1);
      expect(setSettings).toHaveBeenCalledWith({ soundVolume: 0.4 });
    });

    it("saves a keyboard step when the key is released", async () => {
      const slider = await renderWithSound({ soundVolume: 0.5 });

      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      fireEvent.change(slider, { target: { value: "49" } });
      expect(setSettings).not.toHaveBeenCalled();
      fireEvent.keyUp(slider, { key: "ArrowLeft" });

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ soundVolume: 0.49 });
    });

    it("saves a value set with no pointer or key behind it, as assistive tech does", async () => {
      const slider = await renderWithSound({ soundVolume: 0.8 });

      fireEvent.change(slider, { target: { value: "30" } });

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ soundVolume: 0.3 });
    });

    it("saves a drag once even when the release is followed by a blur", async () => {
      const slider = await renderWithSound({ soundVolume: 0.8 });

      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: "65" } });
      fireEvent.pointerUp(slider);
      fireEvent.blur(slider);

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ soundVolume: 0.65 });
      expect(slider.value).toBe("65");
    });

    it("saves a touch drag the browser cancels", async () => {
      const slider = await renderWithSound({ soundVolume: 0.8 });

      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: "20" } });
      fireEvent.pointerCancel(slider);
      fireEvent.change(slider, { target: { value: "25" } });

      expect(setSettings.mock.calls).toEqual([[{ soundVolume: 0.2 }], [{ soundVolume: 0.25 }]]);
    });

    it("saves nothing when a drag ends where it started", async () => {
      const slider = await renderWithSound({ soundVolume: 0.5 });

      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: "70" } });
      fireEvent.change(slider, { target: { value: "50" } });
      fireEvent.pointerUp(slider);

      expect(setSettings).not.toHaveBeenCalled();
    });

    it("marks a changed level as modified and resets it to full volume", async () => {
      await renderWithSound({ soundVolume: 0.3 });

      fireEvent.click(await screen.findByRole("button", { name: "Reset volume to 100%" }));

      expect(setSettings).toHaveBeenCalledWith({ soundVolume: 1 });
    });

    it("is disabled with the other sound rows while Play sound is off", async () => {
      render(<NotificationSettingsTab />);
      await waitFor(() => expect(getSettings).toHaveBeenCalled());

      const slider = await screen.findByRole("slider", { name: "Volume" });
      expect((slider as HTMLInputElement).disabled).toBe(true);
    });
  });

  describe("imported sounds", () => {
    const IMPORTED = { id: "custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f", label: "Door bell" };

    async function chooseFile(row: string) {
      const picker = await screen.findByRole("combobox", { name: row });
      await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
      const input = picker.parentElement?.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
      const file = new File([new Uint8Array(4)], "Door bell.mp3", { type: "audio/mpeg" });
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });
      return { file, input };
    }

    it("selects an imported file for the row it was chosen from", async () => {
      getSettings.mockResolvedValueOnce({ ...BASE, soundEnabled: true });
      importMock.importNotificationSound.mockResolvedValue(IMPORTED);
      render(<NotificationSettingsTab />);

      const { file } = await chooseFile("Waiting sound");

      expect(importMock.importNotificationSound).toHaveBeenCalledWith(file);
      await waitFor(() =>
        expect(setSettings).toHaveBeenCalledWith({ waitingSoundFile: IMPORTED.id })
      );
    });

    it("keeps the previous sound and says why when a file is refused", async () => {
      const { SoundImportError } = await import("@/services/notificationSoundImport");
      getSettings.mockResolvedValueOnce({ ...BASE, soundEnabled: true });
      importMock.importNotificationSound.mockRejectedValue(new SoundImportError("too-long"));
      render(<NotificationSettingsTab />);

      await chooseFile("Finished sound");

      expect(await screen.findByText("Choose a sound that's 3 seconds or shorter")).toBeTruthy();
      expect(setSettings).not.toHaveBeenCalled();
    });

    it("drops an import that finishes after the row was reset", async () => {
      getSettings.mockResolvedValueOnce({
        ...BASE,
        soundEnabled: true,
        waitingSoundFile: "ping.wav",
      });
      let finishImport!: (sound: typeof IMPORTED) => void;
      importMock.importNotificationSound.mockReturnValue(
        new Promise((resolve) => (finishImport = resolve))
      );
      render(<NotificationSettingsTab />);

      await chooseFile("Waiting sound");
      fireEvent.click(screen.getByRole("button", { name: "Reset Waiting sound to default" }));
      await act(async () => finishImport(IMPORTED));

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ waitingSoundFile: "waiting.wav" });
    });

    it("keeps Preview for a bundled sound the menu doesn't list", async () => {
      getSettings.mockResolvedValueOnce({
        ...BASE,
        soundEnabled: true,
        completedSoundFile: "git-commit.wav",
      });
      render(<NotificationSettingsTab />);

      const preview = await screen.findByRole("button", { name: "Preview finished sound" });
      await waitFor(() => expect((preview as HTMLButtonElement).disabled).toBe(false));
    });

    it("doesn't call a saved import missing before the list of imports has arrived", async () => {
      getSettings.mockResolvedValueOnce({
        ...BASE,
        soundEnabled: true,
        completedSoundFile: IMPORTED.id,
      });
      listCustomSounds.mockRejectedValue(new Error("busy"));
      render(<NotificationSettingsTab />);

      const picker = await screen.findByRole("combobox", { name: "Finished sound" });
      await waitFor(() => expect(picker.textContent).toContain("Custom sound"));
      const preview = screen.getByRole("button", { name: "Preview finished sound" });
      expect((preview as HTMLButtonElement).disabled).toBe(false);
    });

    it("offers an import made before the list arrived, without calling other imports missing", async () => {
      const saved = "custom:11111111-2222-4333-8444-555555555555";
      getSettings.mockResolvedValueOnce({ ...BASE, soundEnabled: true, completedSoundFile: saved });
      listCustomSounds.mockRejectedValue(new Error("busy"));
      importMock.importNotificationSound.mockResolvedValue(IMPORTED);
      render(<NotificationSettingsTab />);

      await chooseFile("Waiting sound");

      await waitFor(() =>
        expect(setSettings).toHaveBeenCalledWith({ waitingSoundFile: IMPORTED.id })
      );
      const waiting = screen.getByRole("combobox", { name: "Waiting sound" });
      await waitFor(() => expect(waiting.textContent).toContain("Door bell"));
      const finished = screen.getByRole("combobox", { name: "Finished sound" });
      expect(finished.textContent).toContain("Custom sound");
      expect(
        (screen.getByRole("button", { name: "Preview finished sound" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });

    it("lets a list that arrives after an import have the final say", async () => {
      getSettings.mockResolvedValueOnce({ ...BASE, soundEnabled: true });
      listCustomSounds.mockRejectedValueOnce(new Error("busy")).mockResolvedValue([]);
      importMock.importNotificationSound.mockResolvedValue(IMPORTED);
      render(<NotificationSettingsTab />);

      await chooseFile("Waiting sound");

      const waiting = screen.getByRole("combobox", { name: "Waiting sound" });
      await waitFor(() => expect(waiting.textContent).toContain("Missing sound"));
    });

    it("names a saved import by its label and disables Preview when its file is gone", async () => {
      getSettings.mockResolvedValueOnce({
        ...BASE,
        soundEnabled: true,
        completedSoundFile: IMPORTED.id,
      });
      listCustomSounds.mockResolvedValue([{ ...IMPORTED, available: false }]);
      render(<NotificationSettingsTab />);

      const picker = await screen.findByRole("combobox", { name: "Finished sound" });
      await waitFor(() => expect(picker.textContent).toContain("Door bell (missing)"));
      const preview = screen.getByRole("button", { name: "Preview finished sound" });
      expect((preview as HTMLButtonElement).disabled).toBe(true);
    });
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
      name: "Reset Agent finished to default",
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

  it("an older save that lands after a newer one failed shows what main holds and keeps the failure", async () => {
    getSettings.mockResolvedValueOnce({
      ...BASE,
      quietHoursEnabled: true,
      quietHoursStartMin: 21 * 60,
    });
    const settle: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    setSettings.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          settle.push({ resolve, reject });
        })
    );
    render(<NotificationSettingsTab />);

    const pick = async (time: string) => {
      const start = await screen.findByRole("combobox", { name: "Starts at" });
      await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
      fireEvent.keyDown(start, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: time }));
    };
    await pick("22:00");
    await pick("23:00");

    await act(async () => {
      settle[1]?.reject(new Error("disk full"));
    });
    await act(async () => {
      settle[0]?.resolve();
    });

    expect(screen.getByRole("combobox", { name: "Starts at" }).textContent).toContain("22:00");
    expect(screen.getByText("Couldn't save that change")).toBeTruthy();
    setSettings.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setSettings).toHaveBeenLastCalledWith({ quietHoursStartMin: 23 * 60 });
  });
});

describe("NotificationSettingsTab silenced plugins (#13818)", () => {
  const PROJECT = "a".repeat(64);
  const silences = [
    { pluginId: "acme.tools", name: "Acme Tools", projectId: null },
    { pluginId: `project__${PROJECT}__acme.records`, name: "Acme Records", projectId: PROJECT },
  ];

  it("says how to silence one while no plugin is silenced", async () => {
    render(<NotificationSettingsTab />);
    await waitFor(() => expect(getNotificationSilences).toHaveBeenCalled());
    expect(screen.getByText("Silenced plugins")).toBeTruthy();
    expect(
      screen.getByText(/Silence a plugin from the menu on one of its notifications/)
    ).toBeTruthy();
  });

  it("takes one Unsilence at a time, so each answer is the whole list", async () => {
    getNotificationSilences.mockResolvedValue(silences);
    let finish: (value: unknown) => void = () => {};
    setNotificationSilenced.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<NotificationSettingsTab />);

    const tools = await screen.findByRole("button", { name: "Unsilence Acme Tools" });
    await act(async () => {
      fireEvent.click(tools);
    });
    const records = screen.getByRole("button", { name: "Unsilence Acme Records" });
    expect(records.hasAttribute("disabled")).toBe(true);
    fireEvent.click(records);
    expect(setNotificationSilenced).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish([silences[1]]);
    });
    await waitFor(() => expect(screen.queryByTestId("silenced-plugin-acme.tools")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Unsilence Acme Records" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("lists each silence with its scope and lifts one on Unsilence", async () => {
    getNotificationSilences.mockResolvedValue(silences);
    setNotificationSilenced.mockResolvedValue([silences[1]]);
    render(<NotificationSettingsTab />);

    const tools = await screen.findByTestId("silenced-plugin-acme.tools");
    expect(within(tools).getByText("In every project")).toBeTruthy();
    const records = screen.getByTestId(`silenced-plugin-project__${PROJECT}__acme.records`);
    // A project this window doesn't know is named, never printed as its id.
    expect(within(records).getByText("In another project")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unsilence Acme Tools" }));
    });
    expect(setNotificationSilenced).toHaveBeenCalledWith("acme.tools", false);
    await waitFor(() => expect(screen.queryByTestId("silenced-plugin-acme.tools")).toBeNull());
    expect(screen.getByRole("button", { name: "Unsilence Acme Records" })).toBeTruthy();
  });

  it("keeps a plugin listed and offers Retry when Unsilence fails", async () => {
    getNotificationSilences.mockResolvedValue([silences[0]]);
    setNotificationSilenced.mockRejectedValueOnce(new Error("disk full"));
    render(<NotificationSettingsTab />);

    const unsilence = await screen.findByRole("button", { name: "Unsilence Acme Tools" });
    await act(async () => {
      fireEvent.click(unsilence);
    });
    expect(await screen.findByText("Couldn't unsilence Acme Tools")).toBeTruthy();
    expect(screen.getByTestId("silenced-plugin-acme.tools")).toBeTruthy();

    setNotificationSilenced.mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(screen.queryByTestId("silenced-plugin-acme.tools")).toBeNull());
    expect(screen.queryByText("Couldn't unsilence Acme Tools")).toBeNull();
  });

  it("says the list couldn't be read, with a Retry", async () => {
    getNotificationSilences.mockRejectedValueOnce(new Error("boom"));
    render(<NotificationSettingsTab />);

    expect(await screen.findByText("Couldn't load silenced plugins")).toBeTruthy();
    // A list that couldn't be read is not passed off as an empty one.
    expect(screen.queryByText(/Silence a plugin from the menu/)).toBeNull();
    getNotificationSilences.mockResolvedValueOnce([silences[0]]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(await screen.findByTestId("silenced-plugin-acme.tools")).toBeTruthy();
  });
});
