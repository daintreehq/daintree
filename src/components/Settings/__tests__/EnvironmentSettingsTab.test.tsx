// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { EnvironmentSettingsTab } from "../EnvironmentSettingsTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";
import {
  SettingsFlushContext,
  SettingsFlushProvider,
  type FailedSettingsFlush,
} from "../SettingsFlushRegistry";

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";

beforeEach(() => {
  vi.clearAllMocks();
  window.electron = {
    globalEnv: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as typeof window.electron;
});

function renderTab() {
  return render(
    <SettingsValidationProvider>
      <EnvironmentSettingsTab />
    </SettingsValidationProvider>
  );
}

// The tab under the dialog's flush registry; `flushAll` is the close-time flush.
let flushAll: () => Promise<FailedSettingsFlush[]> = async () => [];
function renderTabInDialog() {
  const { result } = renderHook(() => useContext(SettingsFlushContext)!, {
    wrapper: ({ children }) => (
      <SettingsValidationProvider>
        <SettingsFlushProvider>
          <EnvironmentSettingsTab />
          {children}
        </SettingsFlushProvider>
      </SettingsValidationProvider>
    ),
  });
  flushAll = () => result.current.flushAll();
}

async function closeFlush() {
  let failed: FailedSettingsFlush[] = [];
  await act(async () => {
    failed = await flushAll();
  });
  return failed;
}

describe("EnvironmentSettingsTab", () => {
  it("saves global env vars via IPC", async () => {
    window.electron = {
      globalEnv: {
        get: vi.fn().mockResolvedValue({ EXISTING: "value" }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.electron;

    renderTab();

    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
    });

    const valueInput = screen.getByLabelText(/^Value of /);
    fireEvent.change(valueInput, { target: { value: "new-value" } });

    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ EXISTING: "new-value" });
    });
  });

  it("blocks editing and notifies the user when globalEnv.get fails", async () => {
    window.electron = {
      globalEnv: {
        get: vi.fn().mockRejectedValue(new Error("IPC channel not found")),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.electron;

    renderTab();

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load saved environment variables/)).toBeTruthy();
    });

    // Save and editing affordances must be absent so a failed load can't
    // overwrite the user's stored variables with an empty record.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add variable/i })).toBeNull();

    expect(logError).toHaveBeenCalledWith("Failed to load global env vars", expect.any(Error));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Couldn't load environment variables",
        priority: "high",
        duration: 0,
      })
    );
  });

  it("retries a failed load in place and unlocks editing once it succeeds", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC channel not found"))
      .mockResolvedValueOnce({ EXISTING: "value" });
    Reflect.set(window, "electron", {
      globalEnv: { get, set: vi.fn().mockResolvedValue(undefined) },
    });

    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: /add variable/i })).toBeTruthy();
  });

  it("wires aria-invalid and aria-describedby on row inputs when validation fails", async () => {
    window.electron = {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.electron;

    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Add a variable to set it in every new terminal")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));

    const nameInput = screen.getByLabelText(/^Name of variable \d+$/);
    const valueInput = screen.getByLabelText(/^Value of /);
    fireEvent.change(nameInput, { target: { value: "1BAD-NAME" } });
    fireEvent.change(valueInput, { target: { value: "anything" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    });

    const errorId = nameInput.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    expect(document.getElementById(errorId!)?.textContent).toContain(
      "Start with a letter or underscore"
    );

    expect(valueInput.getAttribute("aria-invalid")).toBeNull();
    expect(valueInput.getAttribute("aria-describedby")).toBe(errorId);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.electron.globalEnv.set).not.toHaveBeenCalled();
  });

  it("adds new variable row and saves via globalEnv.set", async () => {
    window.electron = {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.electron;

    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Add a variable to set it in every new terminal")).toBeTruthy();
    });

    const addButton = screen.getByRole("button", { name: /add variable/i });
    fireEvent.click(addButton);

    const nameInput = screen.getByLabelText(/^Name of variable \d+$/);
    const valueInput = screen.getByLabelText(/^Value of /);

    fireEvent.change(nameInput, { target: { value: "NEW_VAR" } });
    fireEvent.change(valueInput, { target: { value: "new_value" } });

    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ NEW_VAR: "new_value" });
    });
  });
});

describe("EnvironmentSettingsTab close-time save", () => {
  it("keeps an invalid draft and points the close at the row that failed", async () => {
    window.electron.globalEnv.get = vi.fn().mockResolvedValue({ GOOD: "1" });
    renderTabInDialog();
    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const badName = screen.getAllByLabelText<HTMLInputElement>(/^Name of variable \d+$/)[1]!;
    fireEvent.change(badName, { target: { value: "1BAD" } });

    const failed = await closeFlush();

    expect(failed).toHaveLength(1);
    expect(failed[0]!.tab).toBe("environment");
    const landing = document.getElementById(failed[0]!.landOn);
    expect(landing?.contains(badName)).toBe(true);
    expect(landing?.contains(screen.getAllByLabelText(/^Name of variable \d+$/)[0]!)).toBe(false);
    // The reason is on screen once the close has tried to save.
    expect(badName.getAttribute("aria-invalid")).toBe("true");
    expect(badName.value).toBe("1BAD");
    expect(window.electron.globalEnv.set).not.toHaveBeenCalled();
  });

  it("keeps a draft whose save failed, with the error on the page", async () => {
    window.electron.globalEnv.get = vi.fn().mockResolvedValue({ GOOD: "1" });
    window.electron.globalEnv.set = vi.fn().mockRejectedValue(new Error("disk full"));
    renderTabInDialog();
    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
    });
    const value = screen.getByLabelText(/^Value of /) as HTMLInputElement;
    fireEvent.change(value, { target: { value: "2" } });

    const failed = await closeFlush();

    expect(failed).toHaveLength(1);
    const landing = document.getElementById(failed[0]!.landOn);
    expect(landing?.contains(value)).toBe(true);
    expect(landing?.contains(screen.getByRole("alert"))).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("disk full");
    expect(value.value).toBe("2");
  });

  it("saves a valid draft and lets the close through", async () => {
    window.electron.globalEnv.get = vi.fn().mockResolvedValue({ GOOD: "1" });
    renderTabInDialog();
    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
    });
    fireEvent.change(screen.getByLabelText(/^Value of /), {
      target: { value: "2" },
    });

    expect(await closeFlush()).toEqual([]);
    expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ GOOD: "2" });
  });

  it("answers a close during a Save with that Save's outcome, without saving twice", async () => {
    window.electron.globalEnv.get = vi.fn().mockResolvedValue({ GOOD: "1" });
    let rejectSave: (err: Error) => void = () => {};
    window.electron.globalEnv.set = vi.fn(
      () => new Promise<void>((_resolve, reject) => (rejectSave = reject))
    );
    renderTabInDialog();
    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
    });
    fireEvent.change(screen.getByLabelText(/^Value of /), {
      target: { value: "2" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    let failed: FailedSettingsFlush[] | null = null;
    await act(async () => {
      void flushAll().then((result) => (failed = result));
      await Promise.resolve();
    });
    expect(failed).toBeNull();

    await act(async () => rejectSave(new Error("disk full")));

    expect(failed).toHaveLength(1);
    expect(window.electron.globalEnv.set).toHaveBeenCalledTimes(1);
  });
});

// Obviously fake, and short of the long-opaque fallback so the vendor shapes are what match.
const FAKE_GITHUB_PAT = `ghp_${"FAKE".repeat(8)}`;
const FAKE_OPENAI_KEY = `sk-${"FAKE".repeat(6)}`;

async function renderWith(vars: Record<string, string>) {
  window.electron.globalEnv.get = vi.fn().mockResolvedValue(vars);
  renderTab();
  await waitFor(() => {
    expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(
      Object.keys(vars).length
    );
  });
}

const nameInputs = () => screen.getAllByLabelText<HTMLInputElement>(/^Name of variable \d+$/);
const valueInputs = () => screen.getAllByLabelText<HTMLInputElement>(/^Value of /);
const revealToggle = (name: string) =>
  screen.queryByRole("button", { name: `Show value of ${name}` });

describe("EnvironmentSettingsTab masking (#15577)", () => {
  it("masks a token stored under a neutral name and leaves an ordinary value readable", async () => {
    await renderWith({ GITHUB_PAT: FAKE_GITHUB_PAT, TOOLS_DIR: "/usr/local/bin" });
    const [pat, tools] = valueInputs();
    expect(pat!.type).toBe("password");
    expect(revealToggle("GITHUB_PAT")!.getAttribute("aria-pressed")).toBe("false");
    expect(tools!.type).toBe("text");
    expect(revealToggle("TOOLS_DIR")).toBeNull();
  });

  it("masks a long opaque value under a neutral name", async () => {
    await renderWith({ BUILD_ID: "FAKE".repeat(10) });
    expect(valueInputs()[0]!.type).toBe("password");
  });

  it("still masks a secret-sounding name whatever its value, except a ${VAR} reference", async () => {
    await renderWith({ API_TOKEN: "plain", EMPTY_SECRET: "", GH_TOKEN: "${GITHUB_TOKEN}" });
    const [apiToken, emptySecret, ghToken] = valueInputs();
    expect(apiToken!.type).toBe("password");
    expect(emptySecret!.type).toBe("password");
    expect(ghToken!.type).toBe("text");
    expect(revealToggle("GH_TOKEN")).toBeNull();
  });

  it("masks an unrevealed row as soon as a token is pasted into its value", async () => {
    await renderWith({ OPENAI: "pending" });
    expect(valueInputs()[0]!.type).toBe("text");
    fireEvent.change(valueInputs()[0]!, { target: { value: FAKE_OPENAI_KEY } });
    expect(valueInputs()[0]!.type).toBe("password");
    expect(revealToggle("OPENAI")).toBeTruthy();
  });

  it("masks an unrevealed row as soon as its name turns secret", async () => {
    await renderWith({ DEPLOY: "plain" });
    fireEvent.change(nameInputs()[0]!, { target: { value: "DEPLOY_TOKEN" } });
    expect(valueInputs()[0]!.type).toBe("password");
  });

  it("keeps a row the user revealed revealed while they edit it, until they hide it", async () => {
    await renderWith({ GITHUB_PAT: FAKE_GITHUB_PAT });
    fireEvent.click(revealToggle("GITHUB_PAT")!);
    expect(valueInputs()[0]!.type).toBe("text");

    // Cut short of anything the detector recognises, then the token put back.
    fireEvent.change(valueInputs()[0]!, { target: { value: "ghp_" } });
    expect(valueInputs()[0]!.type).toBe("text");
    expect(revealToggle("GITHUB_PAT")).toBeNull();
    fireEvent.change(valueInputs()[0]!, { target: { value: FAKE_GITHUB_PAT } });
    expect(valueInputs()[0]!.type).toBe("text");
    expect(revealToggle("GITHUB_PAT")!.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(revealToggle("GITHUB_PAT")!);
    expect(valueInputs()[0]!.type).toBe("password");
  });

  it("keeps a revealed row revealed through a rename that leaves and regains a secret name", async () => {
    await renderWith({ API_KEY: "plain" });
    fireEvent.click(revealToggle("API_KEY")!);
    fireEvent.change(nameInputs()[0]!, { target: { value: "API" } });
    fireEvent.change(nameInputs()[0]!, { target: { value: "API_TOKEN" } });
    expect(valueInputs()[0]!.type).toBe("text");
    expect(revealToggle("API_TOKEN")!.getAttribute("aria-pressed")).toBe("true");
  });
});
