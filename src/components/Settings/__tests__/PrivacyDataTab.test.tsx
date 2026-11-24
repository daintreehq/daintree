// @vitest-environment jsdom
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PrivacyDataTab } from "../PrivacyDataTab";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ANALYTICS_EVENTS } from "@shared/config/telemetry";
import { ClientAppError } from "@/utils/clientAppError";

const TAKE_CONTROL = "greg-mbp has control of this project. Take control first.";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div role="group" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </div>
  ),
}));

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

/** One entry per telemetry level; the Errors only entry nests its own field list. */
const levelEntries = (disclosure: HTMLElement) =>
  Array.from(disclosure.querySelectorAll("dd")).filter((dd) => !dd.parentElement?.closest("dd"));

vi.mock("../SettingsSubtabBar", () => ({
  SettingsSubtabBar: () => null,
  subtabPanelProps: (group: string, activeId: string) => ({
    role: "tabpanel",
    id: `settings-subtabpanel-${group}-${activeId}`,
    "aria-labelledby": `settings-subtab-${group}-${activeId}`,
    tabIndex: -1,
  }),
}));

function createPrivacyApi(overrides: Partial<typeof window.electron.privacy> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({
      telemetryLevel: "off" as const,
      logRetentionDays: 30 as const,
      dataFolderPath: "/tmp/daintree",
    }),
    setTelemetryLevel: vi.fn().mockResolvedValue(undefined),
    setLogRetention: vi.fn().mockResolvedValue(undefined),
    openDataFolder: vi.fn().mockResolvedValue({ opened: true }),
    clearCache: vi.fn().mockResolvedValue({ cleared: 5, failed: 0 }),
    resetAllData: vi.fn(),
    ...overrides,
  };
}

function createAgentSessionHistoryApi(
  overrides: Partial<typeof window.electron.agentSessionHistory> = {}
) {
  return {
    list: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    getRetentionDays: vi.fn().mockResolvedValue(30),
    setRetentionDays: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("PrivacyDataTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electron = {
      privacy: createPrivacyApi(),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;
  });

  it("hydrates telemetry level from getSettings", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "errors",
          logRetentionDays: 90,
          dataFolderPath: "/tmp",
        }),
      }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      expect(radio("Errors only").checked).toBe(true);
    });
  });

  it("reverts telemetry level and says so beside it on IPC failure", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "off",
          logRetentionDays: 30,
          dataFolderPath: "/tmp",
        }),
        setTelemetryLevel: vi.fn().mockRejectedValue(new Error("IPC fail")),
      }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      expect(radio("Off").checked).toBe(true);
    });

    fireEvent.click(radio("Errors only"));

    await waitFor(() => {
      // Should revert back to "Off" being selected
      expect(radio("Off").checked).toBe(true);
      expect(radio("Errors only").checked).toBe(false);
    });

    expect(window.electron.privacy.setTelemetryLevel).toHaveBeenCalledWith("errors");
    expect(screen.getByText("Telemetry level couldn't be saved")).toBeTruthy();
    // Retry repeats the same change rather than asking the user to find it again.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(window.electron.privacy.setTelemetryLevel).toHaveBeenCalledTimes(2);
    });
    expect(window.electron.privacy.setTelemetryLevel).toHaveBeenLastCalledWith("errors");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("reverts a failed second change to the first, which saved", async () => {
    const setTelemetry = vi
      .fn()
      .mockResolvedValueOnce(undefined) // first call succeeds
      .mockRejectedValueOnce(new Error("IPC fail")); // second call fails

    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "off",
          logRetentionDays: 30,
          dataFolderPath: "/tmp",
        }),
        setTelemetryLevel: setTelemetry,
      }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      expect(radio("Off").checked).toBe(true);
    });

    // First change: off → errors (succeeds)
    fireEvent.click(radio("Errors only"));
    await waitFor(() => {
      expect(radio("Errors only").checked).toBe(true);
    });

    // Second change: errors → full (fails)
    fireEvent.click(radio("Full usage"));
    await screen.findByText("Telemetry level couldn't be saved");
    // Back to "errors", which saved, not "off" from before it.
    expect(radio("Errors only").checked).toBe(true);
    expect(radio("Full usage").checked).toBe(false);
    expect(setTelemetry.mock.calls).toEqual([["errors"], ["full"]]);
  });

  it("renders telemetry disclosure listing all allowlisted analytics events", async () => {
    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const disclosure = await waitFor(() =>
      screen.getByRole("group", { name: /What's collected at each level/i })
    );

    // The inventory sits one disclosure away, and that disclosure lists every event.
    const toggle = within(disclosure).getByRole("button", {
      name: `Show the ${ANALYTICS_EVENTS.length} analytics events`,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    for (const name of ANALYTICS_EVENTS) {
      expect(within(disclosure).getByText(name)).toBeTruthy();
    }
  });

  it("does not claim telemetry is sampled in the disclosure", async () => {
    // Sentry deliberately runs without `sampleRate` (#5259), so every captured
    // error is eligible for transmission. Consent copy must not suggest otherwise.
    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const disclosure = await waitFor(() =>
      screen.getByRole("group", { name: /What's collected at each level/i })
    );

    // Scoped to the per-level summaries: field lists may legitimately carry
    // percentages (CPU, memory) that aren't sampling claims.
    const summaries = levelEntries(disclosure).map(
      (dd) => dd.querySelector(":scope > p")?.textContent ?? ""
    );
    expect(summaries).toHaveLength(3);
    for (const summary of summaries) {
      expect(summary).not.toMatch(/sampl/i);
      expect(summary).not.toMatch(/\d+\s*%/);
    }
  });

  it("names every breadcrumb kind sent with crash reports", async () => {
    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const disclosure = await waitFor(() =>
      screen.getByRole("group", { name: /What's collected at each level/i })
    );
    const text = disclosure.textContent ?? "";
    for (const kind of [
      /main and renderer processes/i,
      /lifecycle/i,
      /console logs/i,
      /network requests/i,
      /child-process/i,
      /navigation/i,
      /clicks/i,
      /earlier error reports/i,
    ]) {
      expect(text).toMatch(kind);
    }
    expect(text).toMatch(/reduced to their origin/i);
    expect(text).toMatch(/email addresses/i);
  });

  it("discloses the location Sentry derives from the connection's IP address", async () => {
    // The client never sends an IP (#13540), but Sentry's ingestion still looks up
    // city and country from the connection, for crash reports and analytics alike.
    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const disclosure = await waitFor(() =>
      screen.getByRole("group", { name: /What's collected at each level/i })
    );
    const levels = levelEntries(disclosure).map((dd) => dd.textContent ?? "");
    expect(levels).toHaveLength(3);
    const [off, errors, full] = levels;
    expect(off).not.toMatch(/location/i);
    expect(errors).toMatch(/approximate location \(city and country\)/i);
    expect(errors).toMatch(/IP address itself isn't stored/i);
    expect(full).toMatch(/same approximate location/i);
  });

  it("does not render telemetry disclosure on the storage subtab", async () => {
    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    await waitFor(() => {
      // Two retention pickers now live on this subtab (log retention + session
      // history), so the "30 days" label is intentionally non-unique.
      expect(screen.getAllByText("30 days").length).toBeGreaterThan(0);
    });

    expect(screen.queryByText(/What's collected at each level/i)).toBeNull();
  });

  it("opens the data folder and stays quiet when the OS accepts it", async () => {
    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));

    await waitFor(() => expect(window.electron.privacy.openDataFolder).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Couldn't open the folder/)).toBeNull();
  });

  it("says beside the control when the OS refuses to open the data folder", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        openDataFolder: vi.fn().mockResolvedValue({ opened: false }),
      }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));

    expect(await screen.findByText(/Couldn't open the folder/)).toBeTruthy();
  });

  it("ignores a second click while the first open is pending, so an old refusal can't outlive a success", async () => {
    let resolveOpen!: (r: { opened: boolean }) => void;
    const openDataFolder = vi.fn(
      () => new Promise<{ opened: boolean }>((resolve) => (resolveOpen = resolve))
    );
    window.electron = {
      privacy: createPrivacyApi({ openDataFolder }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const button = await screen.findByRole("button", { name: "Open folder" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(openDataFolder).toHaveBeenCalledTimes(1);

    resolveOpen({ opened: false });
    expect(await screen.findByText(/Couldn't open the folder/)).toBeTruthy();

    openDataFolder.mockResolvedValueOnce({ opened: true });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(/Couldn't open the folder/)).toBeNull());
    expect(openDataFolder).toHaveBeenCalledTimes(2);
  });

  it("lets the data folder open again after a rejected request and after a success", async () => {
    const openDataFolder = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC fail"))
      .mockResolvedValueOnce({ opened: true })
      .mockResolvedValueOnce({ opened: true });
    window.electron = {
      privacy: createPrivacyApi({ openDataFolder }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const button = await screen.findByRole("button", { name: "Open folder" });
    fireEvent.click(button);
    expect(await screen.findByText(/Couldn't open the folder/)).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(/Couldn't open the folder/)).toBeNull());
    expect(openDataFolder).toHaveBeenCalledTimes(2);

    fireEvent.click(button);
    await waitFor(() => expect(openDataFolder).toHaveBeenCalledTimes(3));
  });

  it("says beside the control when the open request itself fails", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        openDataFolder: vi.fn().mockRejectedValue(new Error("IPC fail")),
      }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));

    expect(await screen.findByText(/Couldn't open the folder/)).toBeTruthy();
  });

  it("reverts log retention and says so beside it on IPC failure", async () => {
    window.electron = {
      privacy: createPrivacyApi({
        getSettings: vi.fn().mockResolvedValue({
          telemetryLevel: "off",
          logRetentionDays: 30,
          dataFolderPath: "/tmp",
        }),
        setLogRetention: vi.fn().mockRejectedValue(new Error("IPC fail")),
      }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    } as unknown as typeof window.electron;

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const logRetentionOption = (label: string) =>
      within(screen.getByRole("radiogroup", { name: "Log retention" })).getByRole("radio", {
        name: label,
      });

    await waitFor(() => {
      expect(logRetentionOption("30 days").getAttribute("aria-checked")).toBe("true");
    });

    fireEvent.click(logRetentionOption("90 days"));

    await waitFor(() => {
      // Should revert back to 30 days
      expect(logRetentionOption("30 days").getAttribute("aria-checked")).toBe("true");
      expect(logRetentionOption("90 days").getAttribute("aria-checked")).toBe("false");
    });

    expect(window.electron.privacy.setLogRetention).toHaveBeenCalledWith(90);
    expect(screen.getByText("Log retention couldn't be saved")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("disables session retention with an inline error and Retry when it fails to load", async () => {
    const getRetentionDays = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC fail"))
      .mockResolvedValueOnce(90);
    Reflect.set(window, "electron", {
      privacy: createPrivacyApi(),
      agentSessionHistory: createAgentSessionHistoryApi({ getRetentionDays }),
    });

    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const sessionOption = (label: string) =>
      within(screen.getByRole("radiogroup", { name: "Keep session history for" })).getByRole(
        "radio",
        { name: label }
      ) as HTMLButtonElement;

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Session history retention didn't load")).toBeTruthy();
    // The 30-day fallback is not presented as the user's value, nor as editable.
    expect(sessionOption("30 days").getAttribute("aria-checked")).toBe("false");
    expect(sessionOption("30 days").disabled).toBe(true);

    fireEvent.click(retry);

    await waitFor(() => {
      expect(sessionOption("90 days").getAttribute("aria-checked")).toBe("true");
    });
    expect(sessionOption("90 days").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(getRetentionDays).toHaveBeenCalledTimes(2);
  });

  it("disables telemetry and log retention with an inline Retry when privacy settings fail to load", async () => {
    const getSettings = vi.fn().mockRejectedValueOnce(new Error("IPC fail")).mockResolvedValueOnce({
      telemetryLevel: "errors",
      logRetentionDays: 7,
      dataFolderPath: "/tmp",
    });
    Reflect.set(window, "electron", {
      privacy: createPrivacyApi({ getSettings }),
      agentSessionHistory: createAgentSessionHistoryApi(),
    });

    render(<PrivacyDataTab activeSubtab="telemetry" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(radio("Off").disabled).toBe(true);
    expect(radio("Off").checked).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();

    fireEvent.click(retry);

    await waitFor(() => {
      expect(radio("Errors only").checked).toBe(true);
    });
    expect(radio("Errors only").disabled).toBe(false);
  });

  describe("clear cache", () => {
    const clearCacheButton = () =>
      screen.getByRole("button", {
        name: /^Clear cache$|^Clearing|^Cache cleared$/,
      }) as HTMLButtonElement;

    type ClearCache = typeof window.electron.privacy.clearCache;

    function renderWithClearCache(clearCache: ClearCache) {
      window.electron.privacy.clearCache = clearCache;
      render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
        wrapper: TooltipProvider,
      });
    }

    it("shows the cleared label only when every cache cleared", async () => {
      const clearCache = vi.fn<ClearCache>().mockResolvedValue({ cleared: 5, failed: 0 });
      renderWithClearCache(clearCache);

      fireEvent.click(clearCacheButton());

      await waitFor(() => {
        expect(screen.queryByText("Cache cleared")).not.toBeNull();
      });
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("reports a partial failure instead of claiming success", async () => {
      const clearCache = vi.fn<ClearCache>().mockResolvedValue({ cleared: 4, failed: 1 });
      renderWithClearCache(clearCache);

      fireEvent.click(clearCacheButton());

      await screen.findByText(/Some caches couldn't be cleared/);
      expect(screen.queryByText("Cache cleared")).toBeNull();
      expect(clearCacheButton().disabled).toBe(false);
    });

    it("reports a rejected clear beside the button and retries from there", async () => {
      const clearCache = vi
        .fn<ClearCache>()
        .mockRejectedValueOnce(new Error("IPC fail"))
        .mockResolvedValueOnce({ cleared: 5, failed: 0 });
      renderWithClearCache(clearCache);

      fireEvent.click(clearCacheButton());

      await screen.findByText(/The cache couldn't be cleared/);
      expect(screen.queryByText("Cache cleared")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(screen.queryByText("Cache cleared")).not.toBeNull();
      });
      expect(clearCache).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/The cache couldn't be cleared/)).toBeNull();
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });

  describe("session retention deletes, so a shorter window asks first", () => {
    const sessionOption = (label: string) =>
      within(screen.getByRole("radiogroup", { name: "Keep session history for" })).getByRole(
        "radio",
        { name: label }
      ) as HTMLButtonElement;

    async function renderStorage() {
      render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
        wrapper: TooltipProvider,
      });
      await waitFor(() => {
        expect(sessionOption("30 days").getAttribute("aria-checked")).toBe("true");
      });
    }

    it("holds a shorter window until the deletion is confirmed", async () => {
      await renderStorage();
      fireEvent.click(sessionOption("7 days"));

      const dialog = await screen.findByRole("alertdialog");
      expect(window.electron.agentSessionHistory.setRetentionDays).not.toHaveBeenCalled();
      expect(within(dialog).getByText(/7 days instead of 30 days/)).toBeTruthy();

      fireEvent.click(within(dialog).getByRole("button", { name: "Shorten and delete" }));
      await waitFor(() => {
        expect(window.electron.agentSessionHistory.setRetentionDays).toHaveBeenCalledWith(7);
      });
    });

    it("keeps the current window when the shorter one is cancelled", async () => {
      await renderStorage();
      fireEvent.click(sessionOption("7 days"));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(window.electron.agentSessionHistory.setRetentionDays).not.toHaveBeenCalled();
      expect(sessionOption("30 days").getAttribute("aria-checked")).toBe("true");
    });

    it("keeps the confirm open and says so inside it when shortening fails", async () => {
      Reflect.set(window, "electron", {
        privacy: createPrivacyApi(),
        agentSessionHistory: createAgentSessionHistoryApi({
          setRetentionDays: vi.fn().mockRejectedValue(new Error("disk full")),
        }),
      });
      await renderStorage();
      fireEvent.click(sessionOption("7 days"));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Shorten and delete" }));

      await within(dialog).findByText(/couldn't be saved/);
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(sessionOption("30 days").getAttribute("aria-checked")).toBe("true");
    });

    it("says to take control when the host refuses because another screen drives a project", async () => {
      Reflect.set(window, "electron", {
        privacy: createPrivacyApi(),
        agentSessionHistory: createAgentSessionHistoryApi({
          setRetentionDays: vi
            .fn()
            .mockRejectedValue(new ClientAppError("DRIVEN_ELSEWHERE", "refused", TAKE_CONTROL)),
        }),
      });
      await renderStorage();
      fireEvent.click(sessionOption("7 days"));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Shorten and delete" }));

      await within(dialog).findByText(TAKE_CONTROL);
      expect(sessionOption("30 days").getAttribute("aria-checked")).toBe("true");
    });

    it("applies a longer window straight away, since nothing is deleted", async () => {
      await renderStorage();
      fireEvent.click(sessionOption("Keep forever"));

      await waitFor(() => {
        expect(window.electron.agentSessionHistory.setRetentionDays).toHaveBeenCalledWith(0);
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  it("keeps the clear confirm open with the host's refusal when another screen drives a project", async () => {
    Reflect.set(window, "electron", {
      privacy: createPrivacyApi(),
      agentSessionHistory: createAgentSessionHistoryApi({
        clear: vi
          .fn()
          .mockRejectedValue(new ClientAppError("DRIVEN_ELSEWHERE", "refused", TAKE_CONTROL)),
      }),
    });
    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Clear history…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));

    await within(dialog).findByText(TAKE_CONTROL);
    expect(screen.queryByRole("button", { name: "History cleared" })).toBeNull();
  });

  it("resets all app data only from a confirm dialog, behind the typed-name gate", async () => {
    render(<PrivacyDataTab activeSubtab="storage" onSubtabChange={vi.fn()} />, {
      wrapper: TooltipProvider,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reset all data…" }));

    const dialog = await screen.findByRole("alertdialog");
    const reset = within(dialog).getByRole("button", { name: "Reset and restart" });
    // D3: the primary answers nothing until the name is typed.
    fireEvent.click(reset);
    expect(window.electron.privacy.resetAllData).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Daintree" } });
    fireEvent.click(reset);
    expect(window.electron.privacy.resetAllData).toHaveBeenCalledTimes(1);
  });

  describe("two quick choices whose writes settle out of order", () => {
    function deferredWrites() {
      const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
      const send = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            pending.push({ resolve, reject });
          })
      );
      /** Settles the nth write: resolved without an error, rejected with one. */
      const settle = async (index: number, error?: unknown) => {
        const write = pending[index];
        if (!write) throw new Error(`write ${index} was never sent`);
        await act(async () => (error === undefined ? write.resolve() : write.reject(error)));
      };
      return { send, settle };
    }

    const logRetentionOption = (label: string) =>
      within(screen.getByRole("radiogroup", { name: "Log retention" })).getByRole("radio", {
        name: label,
      });
    const sessionOption = (label: string) =>
      within(screen.getByRole("radiogroup", { name: "Keep session history for" })).getByRole(
        "radio",
        { name: label }
      );
    const isChecked = (option: HTMLElement) => option.getAttribute("aria-checked") === "true";

    async function renderTab(
      subtab: "telemetry" | "storage",
      apis: {
        privacy?: Partial<typeof window.electron.privacy>;
        sessions?: Partial<typeof window.electron.agentSessionHistory>;
      }
    ) {
      Reflect.set(window, "electron", {
        privacy: createPrivacyApi(apis.privacy),
        agentSessionHistory: createAgentSessionHistoryApi(apis.sessions),
      });
      render(<PrivacyDataTab activeSubtab={subtab} onSubtabChange={vi.fn()} />, {
        wrapper: TooltipProvider,
      });
      if (subtab === "telemetry") await waitFor(() => expect(radio("Off").checked).toBe(true));
      else
        await waitFor(() => {
          expect(isChecked(logRetentionOption("30 days"))).toBe(true);
          expect(isChecked(sessionOption("30 days"))).toBe(true);
        });
    }

    it("keeps the newer telemetry level when the older write fails after it saved", async () => {
      const writes = deferredWrites();
      await renderTab("telemetry", { privacy: { setTelemetryLevel: writes.send } });

      fireEvent.click(radio("Errors only"));
      fireEvent.click(radio("Full usage"));
      expect(writes.send).toHaveBeenCalledTimes(2);

      await writes.settle(1);
      await writes.settle(0, new Error("IPC fail"));

      expect(radio("Full usage").checked).toBe(true);
      expect(screen.queryByText("Telemetry level couldn't be saved")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("falls back to the older level still in flight when the newer write fails, and retries the newer one", async () => {
      const writes = deferredWrites();
      await renderTab("telemetry", { privacy: { setTelemetryLevel: writes.send } });

      fireEvent.click(radio("Errors only"));
      fireEvent.click(radio("Full usage"));

      await writes.settle(1, new Error("IPC fail"));
      expect(radio("Errors only").checked).toBe(true);
      expect(screen.getByText("Telemetry level couldn't be saved")).toBeTruthy();

      await writes.settle(0);
      expect(radio("Errors only").checked).toBe(true);
      expect(screen.getByText("Telemetry level couldn't be saved")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(writes.send).toHaveBeenCalledTimes(3);
      expect(writes.send).toHaveBeenLastCalledWith("full");
      expect(radio("Full usage").checked).toBe(true);
    });

    it("keeps the newer log retention when the older write fails after it saved", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { privacy: { setLogRetention: writes.send } });

      fireEvent.click(logRetentionOption("90 days"));
      fireEvent.click(logRetentionOption("7 days"));

      await writes.settle(1);
      await writes.settle(0, new Error("IPC fail"));

      expect(isChecked(logRetentionOption("7 days"))).toBe(true);
      expect(screen.queryByText("Log retention couldn't be saved")).toBeNull();
    });

    it("falls back past every failed log retention write, and retries only the newest", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { privacy: { setLogRetention: writes.send } });

      fireEvent.click(logRetentionOption("90 days"));
      fireEvent.click(logRetentionOption("7 days"));

      await writes.settle(1, new Error("IPC fail"));
      expect(isChecked(logRetentionOption("90 days"))).toBe(true);
      await writes.settle(0, new Error("IPC fail"));
      expect(isChecked(logRetentionOption("30 days"))).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(writes.send).toHaveBeenCalledTimes(3);
      expect(writes.send).toHaveBeenLastCalledWith(7);
    });

    it("drops the Retry once the value it would resend is in play again", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { privacy: { setLogRetention: writes.send } });

      fireEvent.click(logRetentionOption("90 days"));
      fireEvent.click(logRetentionOption("7 days"));
      fireEvent.click(logRetentionOption("90 days"));

      await writes.settle(2, new Error("IPC fail"));
      expect(isChecked(logRetentionOption("7 days"))).toBe(true);
      expect(screen.getByText("Log retention couldn't be saved")).toBeTruthy();

      // The first write asked for 90 days too, and it's still on its way.
      await writes.settle(1, new Error("IPC fail"));
      expect(isChecked(logRetentionOption("90 days"))).toBe(true);
      expect(screen.queryByText("Log retention couldn't be saved")).toBeNull();

      await writes.settle(0);
      expect(isChecked(logRetentionOption("90 days"))).toBe(true);
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("brings the Retry back when the older write for the same value fails too", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { privacy: { setLogRetention: writes.send } });

      fireEvent.click(logRetentionOption("90 days"));
      fireEvent.click(logRetentionOption("7 days"));
      fireEvent.click(logRetentionOption("90 days"));
      await writes.settle(2, new Error("IPC fail"));
      await writes.settle(1, new Error("IPC fail"));
      await writes.settle(0, new Error("IPC fail"));

      expect(isChecked(logRetentionOption("30 days"))).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(writes.send).toHaveBeenCalledTimes(4);
      expect(writes.send).toHaveBeenLastCalledWith(90);
    });

    it("keeps the newer session retention when the older write fails after it saved", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { sessions: { setRetentionDays: writes.send } });

      // Both are longer windows, so each applies straight away without a confirm.
      fireEvent.click(sessionOption("90 days"));
      fireEvent.click(sessionOption("Keep forever"));

      await writes.settle(1);
      await writes.settle(0, new Error("IPC fail"));

      expect(isChecked(sessionOption("Keep forever"))).toBe(true);
      expect(screen.queryByText("Session history retention couldn't be saved")).toBeNull();
    });

    it("shows the host's refusal for the newer session retention and retries it once the older one saved", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { sessions: { setRetentionDays: writes.send } });

      fireEvent.click(sessionOption("90 days"));
      fireEvent.click(sessionOption("Keep forever"));

      await writes.settle(1, new ClientAppError("DRIVEN_ELSEWHERE", "refused", TAKE_CONTROL));
      expect(isChecked(sessionOption("90 days"))).toBe(true);
      expect(screen.getByText(TAKE_CONTROL)).toBeTruthy();
      await writes.settle(0);
      expect(isChecked(sessionOption("90 days"))).toBe(true);

      // Keep forever is still longer than what's saved, so the retry needs no confirm.
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(writes.send).toHaveBeenCalledTimes(3);
      expect(writes.send).toHaveBeenLastCalledWith(0);
    });

    it("asks before shortening a longer window that is still being saved", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { sessions: { setRetentionDays: writes.send } });

      fireEvent.click(sessionOption("90 days"));
      fireEvent.click(sessionOption("Keep forever"));
      // Main may already hold 90 days, so 30 days would delete sessions it keeps.
      await writes.settle(1, new Error("IPC fail"));
      fireEvent.click(sessionOption("30 days"));

      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText(/30 days instead of 90 days/)).toBeTruthy();
      expect(writes.send).toHaveBeenCalledTimes(2);
    });

    it("names the window being replaced as it changes, and holds it while the shortening saves", async () => {
      const writes = deferredWrites();
      await renderTab("storage", { sessions: { setRetentionDays: writes.send } });

      fireEvent.click(sessionOption("90 days"));
      fireEvent.click(sessionOption("7 days"));
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText(/7 days instead of 90 days/)).toBeTruthy();

      await writes.settle(0, new Error("IPC fail"));
      expect(within(dialog).getByText(/7 days instead of 30 days/)).toBeTruthy();

      fireEvent.click(within(dialog).getByRole("button", { name: "Shorten and delete" }));
      await waitFor(() => expect(writes.send).toHaveBeenLastCalledWith(7));
      expect(isChecked(sessionOption("7 days"))).toBe(true);
      expect(within(dialog).getByText(/7 days instead of 30 days/)).toBeTruthy();

      await writes.settle(1);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    });
  });
});
