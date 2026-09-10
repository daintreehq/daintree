// @vitest-environment jsdom
/**
 * EditorIntegrationTab covers two threads that meet in the same handler pair:
 *
 * - #12327: the Test button has to exercise the preference it sits next to.
 *   Without a project id the main process never loads `preferredEditor` and
 *   silently launches whatever discovery finds first, so the button reported
 *   success for an editor the user had not chosen.
 * - #12326: main writes `preferredEditor` straight into the settings file, so
 *   every renderer-side copy goes stale and the next settings-form save reverts
 *   it unless both the cache and the store are refreshed on save.
 *
 * The stores are used for real rather than mocked: the component reads
 * `useProjectStore` and `patchCachedProjectSettings` from the same `@/store`
 * barrel, and a wholesale module mock would have to restate both halves of it.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorIntegrationTab } from "../EditorIntegrationTab";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import { cleanupProjectSettingsStore, useProjectSettingsStore } from "@/store/projectSettingsStore";
import { invalidateProjectSettingsCache, projectClient } from "@/clients/projectClient";
import type { Project, ProjectSettings } from "@shared/types/project";

const { getConfigMock, setConfigMock, discoverMock, openInEditorMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  setConfigMock: vi.fn(),
  discoverMock: vi.fn(),
  openInEditorMock: vi.fn(),
}));

vi.mock("@/clients/editorClient", () => ({
  editorClient: {
    getConfig: getConfigMock,
    setConfig: setConfigMock,
    discover: discoverMock,
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

/** Settings seeded into the cache, with sentinels a bad write would disturb. */
const SEEDED_SETTINGS: ProjectSettings = {
  runCommands: [],
  devServerCommand: "npm run dev",
  preferredImageViewer: { mode: "os" },
};

// Explicit return type: inferring it from the literal narrows to
// `{ runCommands: never[] }`, and the richer mockResolvedValue payloads below
// then fail typecheck as excess properties.
const ipcGetSettings = vi.fn(async (): Promise<ProjectSettings> => ({ runCommands: [] }));

const TEST_PROJECT: Project = {
  id: "proj-1",
  path: "/repo",
  name: "Repo",
  emoji: "🌲",
  lastOpened: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ currentProject: null });
  cleanupProjectSettingsStore();
  // Module-level cache in the real projectClient — leaks between tests otherwise.
  invalidateProjectSettingsCache();
  getConfigMock.mockResolvedValue({
    preferredEditor: { id: "vscode" },
    discoveredEditors: [
      { id: "vscode", available: true, executablePath: "/usr/bin/code" },
      { id: "zed", available: true, executablePath: "/usr/bin/zed" },
    ],
  });
  setConfigMock.mockResolvedValue(undefined);
  discoverMock.mockResolvedValue([]);
  openInEditorMock.mockResolvedValue(undefined);
  ipcGetSettings.mockClear();
  // stubGlobal rather than assigning onto a cast window: only the handful of
  // members the real projectClient and the Test button reach are stubbed here.
  vi.stubGlobal("electron", {
    project: {
      getSettings: ipcGetSettings,
      onSwitch: vi.fn(() => () => {}),
    },
    system: {
      openInEditor: openInEditorMock,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render for "proj-1" and wait for the editor config to load. */
async function renderLoadedTab() {
  useProjectStore.setState({ currentProject: TEST_PROJECT });
  render(
    <TooltipProvider>
      <EditorIntegrationTab />
    </TooltipProvider>
  );
  await waitFor(() => {
    expect(getConfigMock).toHaveBeenCalledWith("proj-1");
  });
  await screen.findByText(/Saved:/i);
  return screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
}

/** Same render, but hands back the Test button. */
async function renderTabForTestButton() {
  await renderLoadedTab();
  return screen.getByRole("button", { name: "Test" });
}

function selectEditor(id: string) {
  const select = screen.getByLabelText("Editor") as HTMLSelectElement;
  fireEvent.change(select, { target: { value: id } });
}

describe("EditorIntegrationTab", () => {
  it("shows the empty-project hint when no project is open", () => {
    render(
      <TooltipProvider>
        <EditorIntegrationTab />
      </TooltipProvider>
    );
    expect(screen.getByText(/Open a project to configure its editor preference/i)).toBeTruthy();
    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it("saves the selected editor through the editor IPC", async () => {
    const saveButton = await renderLoadedTab();
    selectEditor("zed");

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(setConfigMock).toHaveBeenCalledWith({
        editor: { id: "zed", customCommand: undefined, customTemplate: undefined },
        projectId: "proj-1",
      });
    });
  });

  // The Test button has to launch the editor the preference names, which the
  // main process only resolves when it is told which project to look at (#12327).
  describe("Test button", () => {
    it("sends the active project id so the saved preference is the thing under test", async () => {
      const testButton = await renderTabForTestButton();

      fireEvent.click(testButton);

      await waitFor(() => expect(openInEditorMock).toHaveBeenCalledTimes(1));
      expect(openInEditorMock).toHaveBeenCalledWith({
        path: TEST_PROJECT.path,
        projectId: TEST_PROJECT.id,
      });
    });

    it("reports the launch only once the main process answers, and claims no more than it saw", async () => {
      let settle!: () => void;
      openInEditorMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          })
      );

      const testButton = await renderTabForTestButton();
      fireEvent.click(testButton);

      await waitFor(() => expect(screen.getByRole("button", { name: "Testing…" })).toBeDefined());
      expect(screen.queryByText("Open requested")).toBeNull();

      await act(async () => {
        settle();
      });

      // All this path verifies is that the request was handled. The chain can
      // end in a fallback editor, or in shell.openPath, so naming an editor
      // would claim more than was observed.
      await waitFor(() => expect(screen.getByText("Open requested")).toBeDefined());
    });

    it("surfaces a failed launch instead of a success message", async () => {
      openInEditorMock.mockRejectedValue(new Error("no such binary"));

      const testButton = await renderTabForTestButton();
      fireEvent.click(testButton);

      await waitFor(() => expect(screen.getByText("Failed to open")).toBeDefined());
      expect(screen.queryByText("Open requested")).toBeNull();
    });
  });

  // Main writes preferredEditor straight into the settings file, so every
  // renderer-side copy goes stale and the next settings-form save reverts it
  // unless both the cache and the store are refreshed here (#12326).
  describe("renderer-side settings refresh", () => {
    it("merges the saved editor into the cached settings, preserving unrelated fields", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-1" });
      const saveButton = await renderLoadedTab();
      selectEditor("zed");

      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(useProjectSettingsStore.getState().settings?.preferredEditor).toEqual({
          id: "zed",
          customCommand: undefined,
          customTemplate: undefined,
        });
      });
      expect(useProjectSettingsStore.getState().settings?.devServerCommand).toBe("npm run dev");
      expect(useProjectSettingsStore.getState().settings?.preferredImageViewer).toEqual({
        mode: "os",
      });
    });

    it("leaves the cached settings untouched when the save rejects", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-1" });
      setConfigMock.mockRejectedValue(new Error("setConfig blew up"));
      const saveButton = await renderLoadedTab();
      selectEditor("zed");

      fireEvent.click(saveButton);

      await screen.findByText(/setConfig blew up|Failed to save editor preference/i);
      // Asserting the whole object, not just the absent preference — wiping the
      // cache outright would satisfy a `?.preferredEditor` check.
      expect(useProjectSettingsStore.getState().settings).toEqual(SEEDED_SETTINGS);
      expect(useProjectSettingsStore.getState().projectId).toBe("proj-1");
    });

    it("leaves the cached settings untouched when the store holds a different project", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-2" });
      const saveButton = await renderLoadedTab();
      selectEditor("zed");

      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(setConfigMock).toHaveBeenCalledTimes(1);
      });
      expect(useProjectSettingsStore.getState().settings).toEqual(SEEDED_SETTINGS);
      expect(useProjectSettingsStore.getState().projectId).toBe("proj-2");
    });

    it("invalidates the projectClient settings cache so the next read is not stale", async () => {
      // The cache entry expires 500ms after it is written, so with a real clock
      // a slow runner would refetch anyway and the test would pass regardless.
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        ipcGetSettings
          .mockResolvedValueOnce({ runCommands: [], preferredEditor: { id: "vscode" } })
          .mockResolvedValue({ runCommands: [], preferredEditor: { id: "zed" } });
        const saveButton = await renderLoadedTab();

        // Prime the per-projectId cache the way another reader would, and
        // confirm the second read really is served from it.
        const first = await projectClient.getSettings("proj-1");
        expect(first.preferredEditor).toEqual({ id: "vscode" });
        expect(ipcGetSettings).toHaveBeenCalledTimes(1);
        await projectClient.getSettings("proj-1");
        expect(ipcGetSettings).toHaveBeenCalledTimes(1);

        selectEditor("zed");
        fireEvent.click(saveButton);
        await waitFor(() => {
          expect(setConfigMock).toHaveBeenCalledTimes(1);
        });

        const afterSave = await projectClient.getSettings("proj-1");
        expect(ipcGetSettings).toHaveBeenCalledTimes(2);
        expect(afterSave.preferredEditor).toEqual({ id: "zed" });
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
