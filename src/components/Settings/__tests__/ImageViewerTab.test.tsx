// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImageViewerTab } from "../ImageViewerTab";
import { useProjectStore } from "@/store/projectStore";
import {
  cleanupProjectSettingsStore,
  useProjectSettingsStore,
} from "@/store/projectSettingsStore";
import { projectClient } from "@/clients";
import type { Project, ProjectSettings } from "@shared/types/project";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: vi.fn(async () => ({})),
    saveSettings: vi.fn(async () => undefined),
  },
}));

function setProject(project: Project | null) {
  useProjectStore.setState({ currentProject: project });
}

type DeferredSettings = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

function deferredSettings(): DeferredSettings {
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installElectron(getSettings: () => Promise<unknown>) {
  window.electron = {
    project: {
      getSettings: vi.fn(getSettings),
    },
  } as unknown as typeof window.electron;
}

beforeEach(() => {
  vi.clearAllMocks();
  setProject(null);
  cleanupProjectSettingsStore();
  // Carries the pre-save value, so merging this fetched copy over the cache
  // instead of patching only the preference would be caught below.
  vi.mocked(projectClient.getSettings).mockResolvedValue({
    runCommands: [],
    devServerCommand: "npm run dev",
  } as ProjectSettings);
  vi.mocked(projectClient.saveSettings).mockResolvedValue(undefined);
});

/** Settings seeded into the cache, with a sentinel a bad write would disturb. */
const SEEDED_SETTINGS: ProjectSettings = {
  runCommands: [],
  devServerCommand: "npm run dev",
  preferredEditor: { id: "vscode" },
};

/** Render for "proj-1" with settings loaded and the Save button enabled. */
async function renderLoadedTab() {
  installElectron(async () => ({}));
  setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);
  render(<ImageViewerTab />);
  const osRadio = screen.getByRole("radio", { name: /Use OS default/i }) as HTMLInputElement;
  await waitFor(() => {
    expect(osRadio.disabled).toBe(false);
  });
  return screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
}

describe("ImageViewerTab", () => {
  it("renders section chrome and disabled controls while settings are loading", async () => {
    const deferred = deferredSettings();
    installElectron(() => deferred.promise as Promise<unknown>);
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ImageViewerTab />);

    // Section chrome appears immediately, before the load resolves.
    expect(screen.getByText("Image viewer")).toBeTruthy();
    expect(screen.getByText(/Choose the application that opens when you click/i)).toBeTruthy();

    const osRadio = screen.getByRole("radio", { name: /Use OS default/i }) as HTMLInputElement;
    const customRadio = screen.getByRole("radio", {
      name: /Custom command/i,
    }) as HTMLInputElement;
    const saveButton = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;

    expect(osRadio).toBeTruthy();
    expect(customRadio).toBeTruthy();
    expect(saveButton).toBeTruthy();
    expect(osRadio.disabled).toBe(true);
    expect(customRadio.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);

    deferred.resolve({});
    await waitFor(() => {
      expect(osRadio.disabled).toBe(false);
    });
  });

  it("populates and enables controls after settings resolve with custom mode", async () => {
    installElectron(async () => ({
      preferredImageViewer: { mode: "custom", customCommand: "open -a Photoshop" },
    }));
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ImageViewerTab />);

    const customInput = (await waitFor(() =>
      screen.getByDisplayValue("open -a Photoshop")
    )) as HTMLInputElement;
    expect(customInput.disabled).toBe(false);

    const customRadio = screen.getByRole("radio", {
      name: /Custom command/i,
    }) as HTMLInputElement;
    expect(customRadio.checked).toBe(true);
    expect(customRadio.disabled).toBe(false);
  });

  it("shows the empty-project hint when no project is open", async () => {
    installElectron(async () => ({}));
    render(<ImageViewerTab />);
    expect(
      screen.getByText(/Open a project to configure its image viewer preference/i)
    ).toBeTruthy();
    expect(window.electron.project.getSettings).not.toHaveBeenCalled();
  });

  it("blocks Save when the settings load rejects", async () => {
    installElectron(async () => {
      throw new Error("ipc blew up");
    });
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ImageViewerTab />);

    // Wait on the error, not on the button. Save is disabled while `isLoading` is
    // still true, so waiting for `disabled` returns on the very first render — before
    // the rejection has flushed and setLoadError has run. That raced green locally and
    // failed on a slower runner.
    await screen.findByText(/ipc blew up|Couldn't load image viewer settings/i);

    const saveButton = screen.getByRole("button", {
      name: /save/i,
    }) as HTMLButtonElement;

    // Section chrome stays visible.
    expect(screen.getByText("Image viewer")).toBeTruthy();

    // Radios remain disabled — load failed, the persisted value is unknown.
    const osRadio = screen.getByRole("radio", { name: /Use OS default/i }) as HTMLInputElement;
    const customRadio = screen.getByRole("radio", {
      name: /Custom command/i,
    }) as HTMLInputElement;
    expect(osRadio.disabled).toBe(true);
    expect(customRadio.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);
  });

  it("blocks Save when the settings load times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const deferred = deferredSettings();
      installElectron(() => deferred.promise as Promise<unknown>);
      setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

      render(<ImageViewerTab />);

      // Before the timeout fires, controls are merely loading.
      const osRadio = screen.getByRole("radio", { name: /Use OS default/i }) as HTMLInputElement;
      expect(osRadio.disabled).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByText(/took too long to load/i)).toBeTruthy();

      const saveButton = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
      expect(saveButton.disabled).toBe(true);
      // Radios remain disabled so user can't overwrite unknown data.
      expect(osRadio.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // A save here never reaches useProjectSettingsStore on its own, so the cache
  // keeps the pre-save value and the next settings-form write reverts it (#12326).
  describe("cached settings write-through", () => {
    it("merges the saved preference into the cache, preserving unrelated fields", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-1" });
      const saveButton = await renderLoadedTab();

      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(useProjectSettingsStore.getState().settings?.preferredImageViewer).toEqual({
          mode: "os",
          customCommand: undefined,
        });
      });
      expect(useProjectSettingsStore.getState().settings?.devServerCommand).toBe("npm run dev");
      expect(useProjectSettingsStore.getState().settings?.preferredEditor).toEqual({
        id: "vscode",
      });
      expect(projectClient.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("merges into the settings the cache holds after the save, not the pre-await copy", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-1" });
      // A concurrent writer lands while the save IPC is in flight.
      vi.mocked(projectClient.saveSettings).mockImplementation(async () => {
        useProjectSettingsStore.setState({
          settings: { runCommands: [], devServerCommand: "npm run other" },
        });
      });
      const saveButton = await renderLoadedTab();

      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(useProjectSettingsStore.getState().settings?.preferredImageViewer).toBeTruthy();
      });
      expect(useProjectSettingsStore.getState().settings?.devServerCommand).toBe("npm run other");
    });

    it("leaves the cache untouched when the save rejects", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-1" });
      vi.mocked(projectClient.saveSettings).mockRejectedValue(new Error("save blew up"));
      const saveButton = await renderLoadedTab();

      fireEvent.click(saveButton);

      await screen.findByText(/save blew up|Failed to save image viewer preference/i);
      // Asserting the whole object, not just the absent preference — wiping the
      // cache outright would satisfy a `?.preferredImageViewer` check.
      expect(useProjectSettingsStore.getState().settings).toEqual(SEEDED_SETTINGS);
      expect(useProjectSettingsStore.getState().projectId).toBe("proj-1");
    });

    it("leaves the cache untouched when it holds a different project", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-2" });
      const saveButton = await renderLoadedTab();

      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(projectClient.saveSettings).toHaveBeenCalledTimes(1);
      });
      expect(useProjectSettingsStore.getState().settings).toEqual(SEEDED_SETTINGS);
      expect(useProjectSettingsStore.getState().projectId).toBe("proj-2");
    });
  });
});
