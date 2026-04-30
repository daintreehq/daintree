// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EnvironmentSettingsTab } from "../EnvironmentSettingsTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";

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

describe("EnvironmentSettingsTab", () => {
  it("renders without a project open (no empty-state guard)", async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Environment Variables")).toBeTruthy();
    });
    expect(screen.queryByText("No project open")).toBeNull();
  });

  it("loads global env vars via IPC on mount", async () => {
    window.electron = {
      globalEnv: {
        get: vi.fn().mockResolvedValue({ NODE_ENV: "production", PORT: "3000" }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.electron;

    renderTab();

    await waitFor(() => {
      expect(window.electron.globalEnv.get).toHaveBeenCalledTimes(1);
    });

    const nameInputs = screen.getAllByLabelText("Environment variable name");
    expect(nameInputs).toHaveLength(2);
  });

  it("saves global env vars via IPC", async () => {
    window.electron = {
      globalEnv: {
        get: vi.fn().mockResolvedValue({ EXISTING: "value" }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.electron;

    renderTab();

    await waitFor(() => {
      expect(screen.getAllByLabelText("Environment variable name")).toHaveLength(1);
    });

    const valueInput = screen.getByLabelText("Environment variable value");
    fireEvent.change(valueInput, { target: { value: "new-value" } });

    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ EXISTING: "new-value" });
    });
  });

  it("shows description about global scope", async () => {
    renderTab();

    await waitFor(() => {
      expect(
        screen.getByText(
          "Global environment variables injected into all new terminals. Project-level variables override globals with the same name."
        )
      ).toBeTruthy();
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

  it("adds new variable row and saves via globalEnv.set", async () => {
    window.electron = {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as typeof window.electron;

    renderTab();

    await waitFor(() => {
      expect(screen.getByText("No environment variables configured yet")).toBeTruthy();
    });

    const addButton = screen.getByRole("button", { name: /add variable/i });
    fireEvent.click(addButton);

    const nameInput = screen.getByLabelText("Environment variable name");
    const valueInput = screen.getByLabelText("Environment variable value");

    fireEvent.change(nameInput, { target: { value: "NEW_VAR" } });
    fireEvent.change(valueInput, { target: { value: "new_value" } });

    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ NEW_VAR: "new_value" });
    });
  });
});
