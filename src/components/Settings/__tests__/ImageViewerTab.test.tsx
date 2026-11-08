// @vitest-environment jsdom
import { useContext, type ContextType } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImageViewerTab } from "../ImageViewerTab";
import { SettingsFlushContext, SettingsFlushProvider } from "../SettingsFlushRegistry";
import { useProjectStore } from "@/store/projectStore";
import { cleanupProjectSettingsStore, useProjectSettingsStore } from "@/store/projectSettingsStore";
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

const TEST_PROJECT: Project = {
  id: "proj-1",
  path: "/repo",
  name: "Repo",
  emoji: "🌲",
  lastOpened: 0,
};

/** Render for "proj-1" with settings loaded and the Save button enabled. */
async function renderLoadedTab() {
  installElectron(async () => ({}));
  setProject(TEST_PROJECT);
  render(<ImageViewerTab />);
  const osRadio = screen.getByRole("radio", { name: /Use OS default/i }) as HTMLInputElement;
  await waitFor(() => {
    expect(osRadio.disabled).toBe(false);
  });
  return screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
}

async function renderFlushable(saved: unknown = {}) {
  installElectron(async () => saved);
  setProject(TEST_PROJECT);
  let registry: ContextType<typeof SettingsFlushContext> = null;
  const Capture = () => {
    registry = useContext(SettingsFlushContext);
    return null;
  };
  render(
    <SettingsFlushProvider>
      <Capture />
      <ImageViewerTab />
    </SettingsFlushProvider>
  );
  const osRadio = screen.getByRole("radio", { name: /Use OS default/i }) as HTMLInputElement;
  await waitFor(() => expect(osRadio.disabled).toBe(false));
  return async () => {
    let failed: Array<{ tab: string; landOn: string }> = [];
    await act(async () => {
      failed = await registry!.flushAll();
    });
    return failed;
  };
}

const CUSTOM_GIMP = { preferredImageViewer: { mode: "custom", customCommand: "gimp" } };

function chooseCustom(command: string) {
  fireEvent.click(screen.getByRole("radio", { name: /Custom command/i }));
  fireEvent.change(screen.getByRole("textbox", { name: "Command" }), {
    target: { value: command },
  });
}

describe("ImageViewerTab flushed by a close", () => {
  it("writes nothing over the suggestion a project with no preference shows, while Save still pins it", async () => {
    const flush = await renderFlushable();

    await expect(flush()).resolves.toEqual([]);
    expect(projectClient.saveSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(projectClient.saveSettings).toHaveBeenCalledTimes(1));
  });

  it("writes nothing when a draft comes back to what is saved", async () => {
    const flush = await renderFlushable(CUSTOM_GIMP);
    fireEvent.click(screen.getByRole("radio", { name: /Use OS default/i }));
    chooseCustom(" gimp ");

    await expect(flush()).resolves.toEqual([]);
    expect(projectClient.saveSettings).not.toHaveBeenCalled();
  });

  it("ignores a command left behind by the option no longer chosen", async () => {
    const flush = await renderFlushable();
    chooseCustom("gimp");
    fireEvent.click(screen.getByRole("radio", { name: /Use OS default/i }));

    await expect(flush()).resolves.toEqual([]);
    expect(projectClient.saveSettings).not.toHaveBeenCalled();
  });

  it("saves a valid draft for the project", async () => {
    const flush = await renderFlushable();
    chooseCustom("gimp");

    await expect(flush()).resolves.toEqual([]);

    expect(projectClient.saveSettings).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        preferredImageViewer: { mode: "custom", customCommand: "gimp" },
      })
    );
    await expect(flush()).resolves.toEqual([]);
    expect(projectClient.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("lands on the command field when it is empty", async () => {
    const flush = await renderFlushable();
    chooseCustom("  ");

    const [failure] = await flush();

    expect(projectClient.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the command that opens images")).toBeTruthy();
    const target = document.getElementById(failure!.landOn)!;
    expect(target.contains(screen.getByRole("textbox", { name: "Command" }))).toBe(true);
  });

  it("keeps the draft and its error when the save fails", async () => {
    vi.mocked(projectClient.saveSettings).mockRejectedValueOnce(new Error("disk full"));
    const flush = await renderFlushable();
    chooseCustom("gimp");

    const [failure] = await flush();

    expect(failure?.landOn).toBe("image-viewer");
    expect(await screen.findByText(/disk full/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement).value).toBe(
      "gimp"
    );
  });

  it("reports the outcome of a Save still running rather than saving again", async () => {
    let failSave!: (reason: Error) => void;
    vi.mocked(projectClient.saveSettings).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failSave = reject))
    );
    const flush = await renderFlushable();
    chooseCustom("gimp");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(projectClient.saveSettings).toHaveBeenCalledTimes(1));

    const flushing = flush();
    await act(async () => failSave(new Error("disk full")));
    const [failure] = await flushing;

    expect(failure?.landOn).toBe("image-viewer");
    expect(projectClient.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("reports a Save of the shown suggestion still running, though nothing is pending", async () => {
    let failSave!: (reason: Error) => void;
    vi.mocked(projectClient.saveSettings).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failSave = reject))
    );
    const flush = await renderFlushable();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(projectClient.saveSettings).toHaveBeenCalledTimes(1));

    const flushing = flush();
    await act(async () => failSave(new Error("disk full")));

    expect((await flushing)[0]?.landOn).toBe("image-viewer");
  });

  it("offers Discard only for a pending draft, and discarding clears the error", async () => {
    vi.mocked(projectClient.saveSettings).mockRejectedValue(new Error("disk full"));
    const flush = await renderFlushable(CUSTOM_GIMP);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Command" }), {
      target: { value: "krita" },
    });
    await flush();
    expect(await screen.findByText(/disk full/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect((screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement).value).toBe(
      "gimp"
    );
    expect(screen.queryByText(/disk full/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    vi.mocked(projectClient.saveSettings).mockClear();
    await expect(flush()).resolves.toEqual([]);
    expect(projectClient.saveSettings).not.toHaveBeenCalled();
  });
});

describe("ImageViewerTab", () => {
  it("renders section chrome and disabled controls while settings are loading", async () => {
    const deferred = deferredSettings();
    installElectron(() => deferred.promise as Promise<unknown>);
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ImageViewerTab />);

    // Section chrome appears immediately, before the load resolves.
    expect(screen.getByText("Image viewer")).toBeTruthy();
    expect(
      screen.getByText(
        'For Repo only. The app "Open in image viewer" launches from the file viewer.'
      )
    ).toBeTruthy();

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

      expect(screen.getByText("The saved image viewer took too long to load")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

      const saveButton = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
      expect(saveButton.disabled).toBe(true);
      // Radios remain disabled so user can't overwrite unknown data.
      expect(osRadio.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables Save once the saved preference matches the draft", async () => {
    installElectron(async () => ({ preferredImageViewer: { mode: "os" } }));
    setProject(TEST_PROJECT);
    render(<ImageViewerTab />);
    const osRadio = screen.getByRole("radio", { name: /Use OS default/i }) as HTMLInputElement;
    await waitFor(() => expect(osRadio.disabled).toBe(false));
    const saveButton = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Custom command/i }));
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(osRadio);
    expect(saveButton.disabled).toBe(true);
  });

  it("treats a project with no saved preference as unsaved, and clean after saving", async () => {
    const saveButton = await renderLoadedTab();
    expect(saveButton.disabled).toBe(false);
    expect(screen.getByText(/Not saved yet/i)).toBeTruthy();

    fireEvent.click(saveButton);

    await screen.findByText("OS default");
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(saveButton.disabled).toBe(true);
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
