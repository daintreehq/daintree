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
import { useContext, type ContextType } from "react";
import type React from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorIntegrationTab } from "../EditorIntegrationTab";
import { SettingsFlushContext, SettingsFlushProvider } from "../SettingsFlushRegistry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import { cleanupProjectSettingsStore, useProjectSettingsStore } from "@/store/projectSettingsStore";
import { invalidateProjectSettingsCache, projectClient } from "@/clients/projectClient";
import type { Project, ProjectSettings } from "@shared/types/project";

const {
  getConfigMock,
  setConfigMock,
  setDefaultMock,
  clearProjectPreferenceMock,
  discoverMock,
  openInEditorMock,
} = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  setConfigMock: vi.fn(),
  setDefaultMock: vi.fn(),
  clearProjectPreferenceMock: vi.fn(),
  discoverMock: vi.fn(),
  openInEditorMock: vi.fn(),
}));

vi.mock("@/clients/editorClient", () => ({
  editorClient: {
    getConfig: getConfigMock,
    setConfig: setConfigMock,
    setDefault: setDefaultMock,
    clearProjectPreference: clearProjectPreferenceMock,
    discover: discoverMock,
  },
}));

// The real Select lazy-loads Radix; a native stand-in keeps "choose an editor" a
// plain change event while the component still owns the value and the handler.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select aria-label="Editor" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
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
  setDefaultMock.mockResolvedValue(undefined);
  clearProjectPreferenceMock.mockResolvedValue(undefined);
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
  return screen.getByRole("button", { name: "Test saved editor" });
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

  it("refuses to save a custom editor with no command, and says so on the field", async () => {
    const saveButton = await renderLoadedTab();
    selectEditor("custom");
    fireEvent.click(saveButton);

    const command = screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement;
    expect(await screen.findByText("Enter the command that opens your editor")).toBeTruthy();
    expect(command.getAttribute("aria-invalid")).toBe("true");
    expect(setConfigMock).not.toHaveBeenCalled();

    // The error belongs to the empty value; typing clears it.
    fireEvent.change(command, { target: { value: "nvim" } });
    expect(screen.queryByText("Enter the command that opens your editor")).toBeNull();
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

  it("keeps Save disabled until the draft differs from the saved preference", async () => {
    const saveButton = await renderLoadedTab();
    expect(saveButton.disabled).toBe(true);

    selectEditor("zed");
    expect(saveButton.disabled).toBe(false);

    selectEditor("vscode");
    expect(saveButton.disabled).toBe(true);
  });

  it("treats a project with no saved preference as unsaved", async () => {
    getConfigMock.mockResolvedValue({
      preferredEditor: null,
      discoveredEditors: [{ id: "zed", available: true, executablePath: "/usr/bin/zed" }],
    });
    useProjectStore.setState({ currentProject: TEST_PROJECT });
    render(
      <TooltipProvider>
        <EditorIntegrationTab />
      </TooltipProvider>
    );
    await screen.findByText(/Not saved yet/i);
    const saveButton = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    const testButton = screen.getByRole("button", {
      name: "Test saved editor",
    }) as HTMLButtonElement;
    expect(testButton.disabled).toBe(true);
  });

  // An inventory keeps the current choice and anything needing attention in view,
  // and discloses the healthy remainder with its paths.
  describe("detected editors inventory", () => {
    beforeEach(() => {
      getConfigMock.mockResolvedValue({
        preferredEditor: { id: "vscode" },
        discoveredEditors: [
          { id: "vscode", available: true, executablePath: "/usr/bin/code" },
          { id: "cursor", available: false },
          { id: "zed", available: true, executablePath: "/usr/bin/zed" },
          { id: "neovim", available: true, executablePath: "/usr/bin/nvim" },
          { id: "sublime", available: false },
        ],
      });
    });

    const entryIds = (root: ParentNode) =>
      Array.from(root.querySelectorAll("[data-editor-entry]")).map((el) =>
        el.getAttribute("data-editor-entry")
      );

    it("shows the summary, the selection and missing editors, and collapses the rest", async () => {
      await renderLoadedTab();

      expect(screen.getByText("3 of 5 found on this machine")).toBeTruthy();
      expect(entryIds(document)).toEqual(["vscode"]);
      expect(screen.getByText("/usr/bin/code")).toBeTruthy();
      expect(screen.queryByText("/usr/bin/zed")).toBeNull();
      expect(screen.getByText("Not found: Cursor, Sublime Text")).toBeTruthy();

      const toggle = screen.getByRole("button", { name: "Show 2 other found editors" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      const region = document.getElementById(toggle.getAttribute("aria-controls")!);
      expect(region).toBeTruthy();
      expect(entryIds(region!)).toEqual([]);

      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.textContent).toBe("Hide other found editors");
      expect(entryIds(region!)).toEqual(["zed", "neovim"]);
      expect(screen.getByText("/usr/bin/zed")).toBeTruthy();

      fireEvent.click(toggle);
      expect(entryIds(region!)).toEqual([]);
    });

    it("keeps an unavailable selection in view rather than folding it into the missing line", async () => {
      await renderLoadedTab();
      selectEditor("cursor");

      expect(entryIds(document)).toEqual(["cursor"]);
      expect(screen.getByText("Not found: Sublime Text")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Show 3 other found editors" })).toBeTruthy();
    });

    it("omits the disclosure when the selection is the only editor found", async () => {
      getConfigMock.mockResolvedValue({
        preferredEditor: { id: "vscode" },
        discoveredEditors: [
          { id: "vscode", available: true, executablePath: "/usr/bin/code" },
          { id: "zed", available: false },
        ],
      });
      await renderLoadedTab();

      expect(screen.getByText("/usr/bin/code")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /other found editor/ })).toBeNull();
    });
  });

  // The Test button has to launch the editor the preference names, which the
  // main process only resolves when it is told which project to look at (#12327).
  describe("Test button", () => {
    it("is disabled while the draft differs, since it opens the saved preference", async () => {
      const testButton = await renderTabForTestButton();
      expect(testButton.hasAttribute("disabled")).toBe(false);
      selectEditor("zed");
      expect(testButton.hasAttribute("disabled")).toBe(true);
    });

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

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Test saved editor" }).getAttribute("aria-busy")
        ).toBe("true")
      );
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

  // A project with no editor of its own follows this machine's default; Set
  // default changes that fallback without touching any project's choice (#16162).
  describe("flushed by a close", () => {
    const FOUND = [
      { id: "vscode", available: true, executablePath: "/usr/bin/code" },
      { id: "zed", available: true, executablePath: "/usr/bin/zed" },
    ];

    async function renderFlushable(config: Record<string, unknown> | Error, statusText: RegExp) {
      if (config instanceof Error) getConfigMock.mockRejectedValue(config);
      else getConfigMock.mockResolvedValue({ discoveredEditors: FOUND, ...config });
      useProjectStore.setState({ currentProject: TEST_PROJECT });
      let registry: ContextType<typeof SettingsFlushContext> = null;
      const Capture = () => {
        registry = useContext(SettingsFlushContext);
        return null;
      };
      render(
        <SettingsFlushProvider>
          <Capture />
          <TooltipProvider>
            <EditorIntegrationTab />
          </TooltipProvider>
        </SettingsFlushProvider>
      );
      await screen.findByText(statusText);
      return async () => {
        let failed: Array<{ tab: string; landOn: string }> = [];
        await act(async () => {
          failed = await registry!.flushAll();
        });
        return failed;
      };
    }

    const button = (name: string | RegExp) =>
      screen.getByRole("button", { name }) as HTMLButtonElement;

    function deferred() {
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("writes nothing over the default a project is only following, while Save still pins it", async () => {
      const flush = await renderFlushable(
        { preferredEditor: null, defaultEditor: { id: "zed" } },
        /Using default:/
      );

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();

      fireEvent.click(button(/^save$/i));
      await waitFor(() =>
        expect(setConfigMock).toHaveBeenCalledWith(
          expect.objectContaining({ editor: expect.objectContaining({ id: "zed" }) })
        )
      );
    });

    it("writes nothing over the editor picked automatically, even after picking it again", async () => {
      const flush = await renderFlushable(
        { preferredEditor: null, defaultEditor: null },
        /Not saved yet/
      );

      await expect(flush()).resolves.toEqual([]);
      selectEditor("zed");
      selectEditor("vscode");
      await expect(flush()).resolves.toEqual([]);

      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("writes nothing when a draft comes back to the saved choice", async () => {
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: null },
        /Saved:/
      );
      selectEditor("zed");
      selectEditor("vscode");

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("writes nothing over a custom editor saved without a template", async () => {
      const flush = await renderFlushable(
        {
          preferredEditor: { id: "custom", customCommand: "hx" },
          defaultEditor: null,
        },
        /Saved:/
      );

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("saves a chosen editor for the project and never as the default", async () => {
      const flush = await renderFlushable(
        { preferredEditor: null, defaultEditor: { id: "vscode" } },
        /Using default:/
      );
      selectEditor("zed");

      await expect(flush()).resolves.toEqual([]);

      expect(setConfigMock).toHaveBeenCalledTimes(1);
      expect(setConfigMock.mock.calls[0]![0]).toMatchObject({
        editor: { id: "zed" },
        projectId: "proj-1",
      });
      expect(setDefaultMock).not.toHaveBeenCalled();
      // Saved now, so the next close has nothing to do.
      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).toHaveBeenCalledTimes(1);
    });

    it("lands on the command row when a custom editor has no command", async () => {
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: null },
        /Saved:/
      );
      selectEditor("custom");

      const [failure] = await flush();

      expect(setConfigMock).not.toHaveBeenCalled();
      expect(screen.getByText("Enter the command that opens your editor")).toBeTruthy();
      const row = document.getElementById(failure!.landOn)!;
      expect(row.contains(screen.getByRole("textbox", { name: "Command" }))).toBe(true);
    });

    it("keeps the draft and its error when the save fails, and tries again on the next close", async () => {
      setConfigMock.mockRejectedValueOnce(new Error("disk full"));
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: null },
        /Saved:/
      );
      selectEditor("zed");

      const [failure] = await flush();

      expect(document.getElementById(failure!.landOn)).not.toBeNull();
      expect(await screen.findByText(/disk full/)).toBeTruthy();
      expect((screen.getByLabelText("Editor") as HTMLSelectElement).value).toBe("zed");

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).toHaveBeenCalledTimes(2);
    });

    it("writes nothing while the editor config failed to load", async () => {
      const flush = await renderFlushable(new Error("unreadable"), /unreadable/);
      selectEditor("zed");

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("writes nothing over a stored custom editor whose command only differs by whitespace", async () => {
      const flush = await renderFlushable(
        {
          preferredEditor: null,
          defaultEditor: { id: "custom", customCommand: " hx ", customTemplate: "{file}" },
        },
        /Using default:/
      );

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it.each([
      ["command", "Command", "nvim", { customCommand: "nvim", customTemplate: "{file}" }],
      [
        "template",
        "Arguments template",
        "{file}:{line}",
        { customCommand: "hx", customTemplate: "{file}:{line}" },
      ],
    ])(
      "saves an edit to a saved custom editor's %s alone",
      async (_field, label, value, expected) => {
        const flush = await renderFlushable(
          {
            preferredEditor: { id: "custom", customCommand: "hx", customTemplate: "{file}" },
            defaultEditor: null,
          },
          /Saved:/
        );
        fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });

        await expect(flush()).resolves.toEqual([]);

        expect(setConfigMock).toHaveBeenCalledWith({
          editor: { id: "custom", ...expected },
          projectId: "proj-1",
        });
      }
    );

    it("leaves a successful reset alone, rather than pinning the default back to the project", async () => {
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: { id: "zed" } },
        /Saved:/
      );

      fireEvent.click(button("Reset editor to default"));
      await screen.findByText(/Using default:/);
      expect((screen.getByLabelText("Editor") as HTMLSelectElement).value).toBe("zed");

      await expect(flush()).resolves.toEqual([]);
      await expect(flush()).resolves.toEqual([]);

      expect(clearProjectPreferenceMock).toHaveBeenCalledTimes(1);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("doesn't pin a draft to the project after sending it to the default", async () => {
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: null },
        /Saved:/
      );
      selectEditor("zed");
      fireEvent.click(button("Set default"));
      await screen.findByText("Saved for this project. Default on this machine: Zed");

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();

      // Back at the project's own choice there is nothing to write either.
      selectEditor("vscode");
      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();

      // A new choice after that is a new draft.
      selectEditor("custom");
      fireEvent.change(screen.getByRole("textbox", { name: "Command" }), {
        target: { value: "hx" },
      });
      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).toHaveBeenCalledTimes(1);
      expect(setConfigMock.mock.calls[0]![0]).toMatchObject({
        editor: { id: "custom", customCommand: "hx" },
        projectId: "proj-1",
      });
      expect(setDefaultMock).toHaveBeenCalledTimes(1);
    });

    it("doesn't turn a failed Set default into a project save", async () => {
      setDefaultMock.mockRejectedValueOnce(new Error("disk full"));
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: null },
        /Saved:/
      );
      selectEditor("zed");
      fireEvent.click(button("Set default"));
      expect(await screen.findByText(/disk full/)).toBeTruthy();

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it("doesn't save a draft over a reset the user asked for, even one that failed", async () => {
      clearProjectPreferenceMock.mockRejectedValueOnce(new Error("disk full"));
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: null },
        /Saved:/
      );
      selectEditor("zed");
      fireEvent.click(button("Reset editor to automatic selection"));
      expect(await screen.findByText(/disk full/)).toBeTruthy();

      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();
    });

    it.each([
      ["Save", () => button(/^save$/i), setConfigMock],
      ["Set default", () => button("Set default"), setDefaultMock],
      ["Reset", () => button("Reset editor to automatic selection"), clearProjectPreferenceMock],
    ] as const)(
      "reports the outcome of a %s still running, without starting another write",
      async (_name, control, write) => {
        const pending = deferred();
        write.mockImplementationOnce(() => pending.promise);
        const flush = await renderFlushable(
          { preferredEditor: { id: "vscode" }, defaultEditor: null },
          /Saved:/
        );
        selectEditor("zed");
        fireEvent.click(control());
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1));

        const flushing = flush();
        await act(async () => pending.reject(new Error("disk full")));
        const [failure] = await flushing;

        expect(failure?.landOn).toBe("editor-external");
        expect(write).toHaveBeenCalledTimes(1);
        const writes = [setConfigMock, setDefaultMock, clearProjectPreferenceMock];
        expect(writes.filter((w) => w !== write && w.mock.calls.length > 0)).toEqual([]);
      }
    );

    it.each([
      ["Save", () => button(/^save$/i), setConfigMock],
      ["Set default", () => button("Set default"), setDefaultMock],
    ] as const)(
      "waits for a %s still running and succeeds with it, without writing again",
      async (_name, control, write) => {
        const pending = deferred();
        write.mockImplementationOnce(() => pending.promise);
        const flush = await renderFlushable(
          { preferredEditor: { id: "vscode" }, defaultEditor: null },
          /Saved:/
        );
        selectEditor("zed");
        fireEvent.click(control());
        await waitFor(() => expect(write).toHaveBeenCalledTimes(1));

        let settled = false;
        const flushing = flush().then((failed) => {
          settled = true;
          return failed;
        });
        await act(async () => {});
        expect(settled).toBe(false);

        await act(async () => pending.resolve());

        await expect(flushing).resolves.toEqual([]);
        expect(setConfigMock.mock.calls.length + setDefaultMock.mock.calls.length).toBe(1);
      }
    );

    it("waits for a Save of the default a project was only following", async () => {
      const pending = deferred();
      setConfigMock.mockImplementationOnce(() => pending.promise);
      const flush = await renderFlushable(
        { preferredEditor: null, defaultEditor: { id: "zed" } },
        /Using default:/
      );
      fireEvent.click(button(/^save$/i));
      await waitFor(() => expect(setConfigMock).toHaveBeenCalledTimes(1));

      const flushing = flush();
      await act(async () => pending.reject(new Error("disk full")));

      expect((await flushing)[0]?.landOn).toBe("editor-external");
      expect(setConfigMock).toHaveBeenCalledTimes(1);
    });

    it("clears a missing command's error on Discard", async () => {
      const flush = await renderFlushable(
        { preferredEditor: { id: "custom", customCommand: "hx" }, defaultEditor: null },
        /Saved:/
      );
      const command = screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement;
      fireEvent.change(command, { target: { value: "" } });
      await flush();
      expect(screen.getByText("Enter the command that opens your editor")).toBeTruthy();

      fireEvent.click(button("Discard"));

      expect(command.value).toBe("hx");
      expect(screen.queryByText("Enter the command that opens your editor")).toBeNull();
      expect(command.getAttribute("aria-invalid")).toBeNull();
    });

    it("offers Discard only for a pending draft, and discarding leaves nothing to save", async () => {
      setConfigMock.mockRejectedValue(new Error("disk full"));
      const flush = await renderFlushable(
        { preferredEditor: { id: "vscode" }, defaultEditor: null },
        /Saved:/
      );
      expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();

      selectEditor("zed");
      await flush();
      expect(await screen.findByText(/disk full/)).toBeTruthy();

      fireEvent.click(button("Discard"));

      expect((screen.getByLabelText("Editor") as HTMLSelectElement).value).toBe("vscode");
      expect(screen.queryByText(/disk full/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
      setConfigMock.mockClear();
      await expect(flush()).resolves.toEqual([]);
      expect(setConfigMock).not.toHaveBeenCalled();
    });
  });

  describe("default editor", () => {
    const DISCOVERED = [
      { id: "vscode", available: true, executablePath: "/usr/bin/code" },
      { id: "antigravity-ide", available: true, executablePath: "/usr/bin/antigravity" },
      { id: "sublime", available: true, executablePath: "/usr/bin/subl" },
    ];

    async function renderWith(config: Record<string, unknown>, statusText: RegExp) {
      getConfigMock.mockResolvedValue({ discoveredEditors: DISCOVERED, ...config });
      useProjectStore.setState({ currentProject: TEST_PROJECT });
      render(
        <TooltipProvider>
          <EditorIntegrationTab />
        </TooltipProvider>
      );
      await screen.findByText(statusText);
    }

    const button = (name: string | RegExp) =>
      screen.getByRole("button", { name }) as HTMLButtonElement;
    const isOff = (el: HTMLButtonElement) => el.getAttribute("aria-disabled") === "true";

    it("starts a project on the default at the default, and says that's what it uses", async () => {
      await renderWith(
        { preferredEditor: null, defaultEditor: { id: "antigravity-ide" } },
        /Using default:/
      );

      expect((screen.getByLabelText("Editor") as HTMLSelectElement).value).toBe("antigravity-ide");
      expect(screen.getByText("Using the default on this machine: Antigravity IDE")).toBeTruthy();
      // The default is what a launch tries, so it can be tested; it is already the
      // default, so Set default has nothing to do; Save still pins it to the project.
      expect(isOff(button("Test saved editor"))).toBe(false);
      expect(isOff(button("Set default"))).toBe(true);
      expect(isOff(button(/^save$/i))).toBe(false);
      // Nothing saved for the project, so there is nothing to reset.
      expect(screen.queryByRole("button", { name: /Reset editor/ })).toBeNull();
    });

    it("sets the default without saving the project's editor or touching its cached settings", async () => {
      useProjectSettingsStore.setState({ settings: SEEDED_SETTINGS, projectId: "proj-1" });
      await renderWith({ preferredEditor: { id: "vscode" }, defaultEditor: null }, /Saved:/);
      expect(
        screen.getByText("Saved for this project. No default set on this machine")
      ).toBeTruthy();

      selectEditor("antigravity-ide");
      fireEvent.click(button("Set default"));

      await waitFor(() =>
        expect(setDefaultMock).toHaveBeenCalledWith({
          editor: { id: "antigravity-ide", customCommand: undefined, customTemplate: undefined },
        })
      );
      expect(
        await screen.findByText("Saved for this project. Default on this machine: Antigravity IDE")
      ).toBeTruthy();
      expect(setConfigMock).not.toHaveBeenCalled();
      // The project keeps its own choice. The draft went to the default, so nothing is
      // left for a close to keep, though Save can still pin it here.
      expect(screen.queryByText(/Unsaved changes/)).toBeNull();
      expect(isOff(button(/^save$/i))).toBe(false);
      expect(useProjectSettingsStore.getState().settings).toEqual(SEEDED_SETTINGS);
    });

    it("resets a saved project to the default by clearing its choice, not copying the default", async () => {
      useProjectSettingsStore.setState({
        settings: { ...SEEDED_SETTINGS, preferredEditor: { id: "vscode" } },
        projectId: "proj-1",
      });
      await renderWith(
        { preferredEditor: { id: "vscode" }, defaultEditor: { id: "antigravity-ide" } },
        /Saved:/
      );

      fireEvent.click(button("Reset editor to default"));

      await waitFor(() =>
        expect(clearProjectPreferenceMock).toHaveBeenCalledWith({ projectId: "proj-1" })
      );
      expect(await screen.findByText(/Using default:/)).toBeTruthy();
      expect((screen.getByLabelText("Editor") as HTMLSelectElement).value).toBe("antigravity-ide");
      expect(setConfigMock).not.toHaveBeenCalled();
      expect(setDefaultMock).not.toHaveBeenCalled();
      expect(useProjectSettingsStore.getState().settings?.preferredEditor).toBeUndefined();
      expect(useProjectSettingsStore.getState().settings?.devServerCommand).toBe("npm run dev");
    });

    it("names automatic selection as where a reset goes when no default is set", async () => {
      await renderWith({ preferredEditor: { id: "vscode" }, defaultEditor: null }, /Saved:/);

      fireEvent.click(button("Reset editor to automatic selection"));

      expect(await screen.findByText(/Not saved yet/)).toBeTruthy();
      expect(clearProjectPreferenceMock).toHaveBeenCalledWith({ projectId: "proj-1" });
    });

    it("keeps the project's saved choice when the reset fails, and says so", async () => {
      clearProjectPreferenceMock.mockRejectedValue(new Error("disk full"));
      await renderWith(
        { preferredEditor: { id: "vscode" }, defaultEditor: { id: "antigravity-ide" } },
        /Saved:/
      );

      fireEvent.click(button("Reset editor to default"));

      expect(await screen.findByText(/disk full|Failed to reset the editor/)).toBeTruthy();
      expect(screen.getByText(/Saved for this project/)).toBeTruthy();
    });

    it("asks for a command before setting a custom default", async () => {
      await renderWith({ preferredEditor: { id: "vscode" }, defaultEditor: null }, /Saved:/);
      selectEditor("custom");

      fireEvent.click(button("Set default"));

      expect(await screen.findByText("Enter the command that opens your editor")).toBeTruthy();
      expect(setDefaultMock).not.toHaveBeenCalled();
    });

    it("tests the default only while the draft is the default", async () => {
      await renderWith(
        { preferredEditor: null, defaultEditor: { id: "antigravity-ide" } },
        /Using default:/
      );
      selectEditor("sublime");
      expect(isOff(button("Test saved editor"))).toBe(true);
      expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
    });

    it("opens a custom default saved without a template as saved, not as an edit", async () => {
      await renderWith(
        { preferredEditor: null, defaultEditor: { id: "custom", customCommand: "hx" } },
        /Using default:/
      );

      expect(
        (screen.getByRole("textbox", { name: "Arguments template" }) as HTMLInputElement).value
      ).toBe("");
      expect(screen.queryByText(/Unsaved changes/)).toBeNull();
      expect(isOff(button("Set default"))).toBe(true);
      expect(isOff(button("Test saved editor"))).toBe(false);
    });

    it("refetches settings after a reset rather than serving the cleared choice from cache", async () => {
      // The cache entry expires 500ms after it is written; a frozen clock keeps it live.
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        ipcGetSettings
          .mockResolvedValueOnce({ runCommands: [], preferredEditor: { id: "vscode" } })
          .mockResolvedValue({ runCommands: [] });
        await renderWith(
          { preferredEditor: { id: "vscode" }, defaultEditor: { id: "antigravity-ide" } },
          /Saved:/
        );
        await projectClient.getSettings("proj-1");
        await projectClient.getSettings("proj-1");
        expect(ipcGetSettings).toHaveBeenCalledTimes(1);

        fireEvent.click(button("Reset editor to default"));
        await screen.findByText(/Using default:/);

        const afterReset = await projectClient.getSettings("proj-1");
        expect(ipcGetSettings).toHaveBeenCalledTimes(2);
        expect(afterReset.preferredEditor).toBeUndefined();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("holds every other write while one is in flight", async () => {
      let settle!: () => void;
      setConfigMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          })
      );
      await renderWith(
        { preferredEditor: { id: "vscode" }, defaultEditor: { id: "antigravity-ide" } },
        /Saved:/
      );
      selectEditor("sublime");
      fireEvent.click(button(/^save$/i));

      await waitFor(() => expect(setConfigMock).toHaveBeenCalledTimes(1));
      expect(isOff(button("Set default"))).toBe(true);
      expect(screen.queryByRole("button", { name: "Reset editor to default" })).toBeNull();

      await act(async () => {
        settle();
      });
      expect(await screen.findByText("Saved:", { exact: false })).toBeTruthy();
      expect(isOff(button("Set default"))).toBe(false);
    });

    it("keeps a save that lands after a project switch off the new project's page", async () => {
      let settle!: () => void;
      setConfigMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          })
      );
      await renderWith({ preferredEditor: null, defaultEditor: null }, /Not saved yet/);
      selectEditor("sublime");
      fireEvent.click(button(/^save$/i));
      await waitFor(() => expect(setConfigMock).toHaveBeenCalledTimes(1));

      getConfigMock.mockResolvedValue({
        preferredEditor: null,
        defaultEditor: null,
        discoveredEditors: DISCOVERED,
      });
      act(() => {
        useProjectStore.setState({
          currentProject: { ...TEST_PROJECT, id: "proj-2", name: "Other" },
        });
      });
      await waitFor(() => expect(getConfigMock).toHaveBeenCalledWith("proj-2"));
      await screen.findByText(/Not saved yet/);

      await act(async () => {
        settle();
      });

      expect(setConfigMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-1" }));
      expect(screen.queryByText(/Saved:/)).toBeNull();
      expect(screen.getByText(/Not saved yet/)).toBeTruthy();
    });
  });
});
