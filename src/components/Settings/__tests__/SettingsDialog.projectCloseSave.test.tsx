// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectSettings } from "@shared/types/project";

// The real project form runs here; only the persistence under it is stubbed, so a
// failed write reaches the dialog the way it does in the app (#15649).
const persistence = vi.hoisted(() => {
  const settings = {
    runCommands: [],
    environmentVariables: { MY_VAR: "a" },
  } as ProjectSettings;
  return {
    settings,
    saveSettings: vi.fn<(next: ProjectSettings) => Promise<void>>(),
    getSettings: vi.fn(async () => settings),
    refresh: vi.fn(async () => {}),
  };
});
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    settings: persistence.settings,
    saveSettings: persistence.saveSettings,
    isLoading: false,
    error: null,
    refresh: persistence.refresh,
  }),
}));
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    appClient: { getVersionInfo: () => Promise.resolve({ appVersion: "0.0.0", arch: "arm64" }) },
    projectClient: { ...actual.projectClient, getSettings: persistence.getSettings },
  };
});
vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: [], worktreeMap: new Map() }),
}));
vi.mock("@/components/Hosts/hostList", () => ({ useHostList: () => ({ hosts: [] }) }));
vi.mock("../pluginSettingsSearch", () => ({ usePluginSettingsSearchIndex: () => [] }));
vi.mock("../GeneralTab", () => ({ GeneralTab: () => <p>General page</p> }));

import { SettingsDialog } from "../SettingsDialog";
import { useProjectStore } from "@/store/projectStore";

vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => {});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const SAVE_BANNER = "Couldn't save settings for Test Project";

beforeEach(() => {
  persistence.saveSettings.mockReset();
  persistence.saveSettings.mockRejectedValue(new Error("Read-only file system"));
  persistence.getSettings.mockClear();
  useProjectStore.setState({
    projects: [{ id: "proj-1", name: "Test Project", emoji: "🌲", path: "/test" } as Project],
  });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      ...window.electron,
      globalEnv: { get: vi.fn().mockResolvedValue({}), set: vi.fn() },
    },
  });
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

async function openOnProjectVariables() {
  const onClose = vi.fn();
  render(
    <SettingsDialog isOpen onClose={onClose} defaultTab="project:variables" projectId="proj-1" />
  );
  await waitFor(() => {
    expect(valueInput().value).toBe("a");
  });
  return onClose;
}

function valueInput() {
  return screen.getByLabelText<HTMLInputElement>("Environment variable value");
}

function variablesSection() {
  return document.getElementById("project-environment-variables")!;
}

function pressEscape() {
  return act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
}

describe("SettingsDialog close when the project save fails", () => {
  it("holds a close-time Variables save on its section, with the page's own error", async () => {
    const onClose = await openOnProjectVariables();
    fireEvent.change(valueInput(), { target: { value: "b" } });

    await pressEscape();

    await waitFor(() => {
      expect(variablesSection().textContent).toContain("Read-only file system");
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(valueInput().value).toBe("b");
    expect(variablesSection().contains(document.activeElement)).toBe(true);
    expect(persistence.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ environmentVariables: { MY_VAR: "b" } })
    );
    expect(screen.getByText(SAVE_BANNER)).toBeTruthy();
  });

  it("refuses a close after a failed Save and keeps the edit, then closes once a retry saves", async () => {
    const onClose = await openOnProjectVariables();
    fireEvent.change(valueInput(), { target: { value: "b" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => {
      expect(variablesSection().textContent).toContain("Read-only file system");
    });

    // The page's draft is the form's now, so only the form's own close-time save
    // stands between the edit and a close.
    await pressEscape();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(valueInput().value).toBe("b");
    expect(screen.getByText(SAVE_BANNER)).toBeTruthy();

    persistence.saveSettings.mockResolvedValue(undefined);
    await pressEscape();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(persistence.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentVariables: { MY_VAR: "b" } })
    );
    expect(screen.queryByText(SAVE_BANNER)).toBeNull();
  });

  it("closes after the edit is discarded, without writing it", async () => {
    const onClose = await openOnProjectVariables();
    fireEvent.change(valueInput(), { target: { value: "b" } });
    await pressEscape();
    await waitFor(() => {
      expect(screen.getByText(SAVE_BANNER)).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    });
    await waitFor(() => {
      expect(valueInput().value).toBe("a");
    });
    expect(screen.queryByText(SAVE_BANNER)).toBeNull();

    persistence.saveSettings.mockClear();
    await pressEscape();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(persistence.saveSettings).not.toHaveBeenCalled();
  });

  it("closes an untouched form without writing", async () => {
    const onClose = await openOnProjectVariables();
    persistence.getSettings.mockClear();

    await pressEscape();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(persistence.saveSettings).not.toHaveBeenCalled();
    expect(persistence.getSettings).not.toHaveBeenCalled();
  });
});
