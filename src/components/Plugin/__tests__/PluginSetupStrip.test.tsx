// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dispatch = vi.hoisted(() =>
  vi.fn(
    async (
      _id: string,
      _args?: unknown,
      _opts?: unknown
    ): Promise<
      { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
    > => ({ ok: true, result: undefined })
  )
);
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

let currentProjectId: string | null = "proj-1";
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: currentProjectId ? { id: currentProjectId } : null }),
}));

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: (
    selector: (s: {
      pluginMetaById: Map<string, { displayName: string }>;
      init: () => void;
    }) => unknown
  ) =>
    selector({
      pluginMetaById: new Map([["acme.linear", { displayName: "Linear" }]]),
      init: () => undefined,
    }),
}));

import { PluginKindSetupStrip, PluginSetupStrip } from "../PluginSetupStrip";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import type { PluginSetupStepUiStatus, PluginSetupUiStatus } from "@shared/types/plugin";
import { _resetPluginContextKeyStoreForTest } from "@/store/pluginContextKeyStore";

const getRequiredSettingsStatus = vi.fn();
let settingsListeners: Array<(payload: { pluginId: string }) => void> = [];

function announce(pluginId: string) {
  for (const listener of settingsListeners) listener({ pluginId });
}

beforeEach(() => {
  currentProjectId = "proj-1";
  vi.clearAllMocks();
  settingsListeners = [];
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      plugin: {
        getRequiredSettingsStatus,
        onSettingsChanged: (cb: (payload: { pluginId: string }) => void) => {
          settingsListeners.push(cb);
          return () => {
            settingsListeners = settingsListeners.filter((l) => l !== cb);
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("PluginSetupStrip", () => {
  it("names the plugin and opens the first missing setting", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey", "team"],
      unreadable: [],
      labels: {},
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    expect(strip.textContent).toContain("Linear needs setup");
    expect(getRequiredSettingsStatus).toHaveBeenCalledWith("acme.linear", "proj-1");

    fireEvent.click(screen.getByRole("button", { name: "Open plugin settings" }));
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: "acme.linear", key: "apiKey" },
      { source: "user" }
    );
  });

  it("goes away once the required setting is stored, and comes back if it is cleared", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await screen.findByTestId("plugin-setup-strip");

    getRequiredSettingsStatus.mockResolvedValue({ missing: [], unreadable: [], labels: {} });
    await act(async () => announce("acme.linear"));
    await waitFor(() => expect(screen.queryByTestId("plugin-setup-strip")).toBeNull());

    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    await act(async () => announce("acme.linear"));
    expect(await screen.findByTestId("plugin-setup-strip")).toBeTruthy();
  });

  it("ignores another plugin's settings changes", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await screen.findByTestId("plugin-setup-strip");

    await act(async () => announce("acme.other"));
    expect(getRequiredSettingsStatus).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when nothing is missing or the read fails", async () => {
    getRequiredSettingsStatus.mockRejectedValue(new Error("boom"));
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await waitFor(() => expect(getRequiredSettingsStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("plugin-setup-strip")).toBeNull();
  });

  it("says which required key it couldn't read, and opens it", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: [],
      unreadable: ["apiKey"],
      labels: { apiKey: "API key" },
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    // What was observed, not a guess that it is unset.
    expect(strip.textContent).toContain("Couldn't read API key");
    expect(strip.textContent).not.toContain("needs setup");
    fireEvent.click(screen.getByRole("button", { name: "Open plugin settings" }));
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: "acme.linear", key: "apiKey" },
      { source: "user" }
    );
  });

  it("puts an unset key ahead of an unreadable one", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["team"],
      unreadable: ["apiKey"],
      labels: { team: "Team", apiKey: "API key" },
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    expect(strip.textContent).toContain("Linear needs setup");
  });
});

describe("PluginSetupStrip with a setup checklist (#13824)", () => {
  const getSetupStatus =
    vi.fn<(pluginId: string, projectId: string | null) => Promise<PluginSetupUiStatus>>();
  const setSetupStepSkipped =
    vi.fn<(pluginId: string, stepId: string, skipped: boolean) => Promise<void>>();
  let contextListeners: Array<
    (payload: { pluginId: string; keys: Record<string, unknown> | null }) => void
  > = [];

  const step = (
    id: string,
    check: PluginSetupStepUiStatus["check"],
    action: PluginSetupStepUiStatus["action"],
    skipped = false
  ): PluginSetupStepUiStatus => ({
    id,
    title: `Step ${id}`,
    description: null,
    check,
    action,
    skipped,
  });

  const STEPS = [
    step("connect", { kind: "observed", done: true }, { kind: "settings", key: null }),
    step("team", { kind: "observed", done: false }, { kind: "settings", key: "team" }),
    step(
      "sync",
      { kind: "context", when: "acme.linear.synced" },
      { kind: "command", actionId: "acme.linear.sync" }
    ),
  ];

  beforeEach(() => {
    _resetPluginContextKeyStoreForTest();
    contextListeners = [];
    getSetupStatus.mockResolvedValue({ steps: STEPS });
    setSetupStepSkipped.mockResolvedValue(undefined);
    getRequiredSettingsStatus.mockResolvedValue({ missing: [], unreadable: [], labels: {} });
    Object.assign(window.electron.plugin, {
      getSetupStatus,
      setSetupStepSkipped,
      onContextKeysChanged: (
        cb: (payload: { pluginId: string; keys: Record<string, unknown> | null }) => void
      ) => {
        contextListeners.push(cb);
        return () => {
          contextListeners = contextListeners.filter((l) => l !== cb);
        };
      },
    });
  });

  afterEach(() => {
    _resetPluginContextKeyStoreForTest();
  });

  async function openSteps() {
    fireEvent.click(await screen.findByRole("button", { name: "Setup steps" }));
    return screen.findByText("Step team");
  }

  it("shows progress over the declared steps and lists them in a popover", async () => {
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    await waitFor(() => expect(strip.textContent).toContain("Linear setup · 1 of 3"));
    expect(strip.textContent).not.toContain("needs setup");
    expect(getSetupStatus).toHaveBeenCalledWith("acme.linear", "proj-1");

    await openSteps();
    const connect = document.querySelector('[data-setup-step="connect"]');
    expect(connect?.textContent).toContain("Done");
    // A done step has nothing to skip.
    expect(screen.queryByRole("button", { name: "Skip: Step connect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip: Step team" })).toBeTruthy();
  });

  it("counts a context step as done once the plugin publishes the key", async () => {
    render(<PluginSetupStrip pluginId="acme.linear" />);
    const strip = await screen.findByTestId("plugin-setup-strip");
    await waitFor(() => expect(strip.textContent).toContain("1 of 3"));

    await act(async () => {
      for (const listener of contextListeners) {
        listener({ pluginId: "acme.linear", keys: { synced: true } });
      }
    });
    expect(strip.textContent).toContain("2 of 3");
    // Observed on this side alone: main wasn't asked again.
    expect(getSetupStatus).toHaveBeenCalledTimes(1);
  });

  it("opens a step's setting, and runs a step's command, from its row", async () => {
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();

    fireEvent.click(screen.getByRole("button", { name: "Open setting: Step team" }));
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: "acme.linear", key: "team" },
      { source: "user" }
    );
    // Out of the way once the action has gone through.
    await waitFor(() => expect(screen.queryByText("Step team")).toBeNull());

    await openSteps();
    fireEvent.click(screen.getByRole("button", { name: "Run: Step sync" }));
    expect(dispatch).toHaveBeenCalledWith("acme.linear.sync", undefined, { source: "user" });
    await waitFor(() => expect(screen.queryByText("Step team")).toBeNull());
  });

  it("stays open and says so on the row when a step's command fails, then retries from it (#15236)", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "Linear is offline." },
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();

    fireEvent.click(screen.getByRole("button", { name: "Run: Step sync" }));

    await waitFor(() =>
      expect(document.querySelector('[data-setup-step="sync"]')?.textContent).toContain(
        "Couldn't run this step: Linear is offline."
      )
    );
    expect(screen.getByText("Step team")).toBeTruthy();
    expect(document.querySelector('[data-setup-step="team"]')?.textContent).not.toContain(
      "Couldn't"
    );

    fireEvent.click(screen.getByRole("button", { name: "Run: Step sync" }));
    await waitFor(() => expect(screen.queryByText("Step team")).toBeNull());
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("runs a step once while its command is still answering (#15236)", async () => {
    let finish!: () => void;
    dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, result: undefined });
        })
    );
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();

    const run = screen.getByRole("button", { name: "Run: Step sync" });
    fireEvent.click(run);
    fireEvent.click(run);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Step team")).toBeTruthy();

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByText("Step team")).toBeNull());
  });

  it("steps aside without an error when the command stages a confirmation (#15236)", async () => {
    const { ConfirmationStagedError } = await import("@/services/actions/confirmationStaged");
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "Needs confirmation",
        details: new ConfirmationStagedError("Needs confirmation"),
      } as { code: string; message: string },
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();

    fireEvent.click(screen.getByRole("button", { name: "Run: Step sync" }));

    await waitFor(() => expect(screen.queryByText("Step team")).toBeNull());
    expect(screen.queryByText(/Couldn't run this step/)).toBeNull();
  });

  it("skips a step, and gives way to the required prompt once every step is handled", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();

    const skip = screen.getByRole("button", { name: "Skip: Step team" });
    skip.focus();
    fireEvent.click(skip);
    expect(setSetupStepSkipped).toHaveBeenCalledWith("acme.linear", "team", true);

    getSetupStatus.mockResolvedValue({
      steps: [
        STEPS[0]!,
        { ...STEPS[1]!, skipped: true },
        { ...STEPS[2]!, check: { kind: "observed", done: true } },
      ],
    });
    await act(async () => announce("acme.linear"));

    // Held while the popover is open, so the focused row isn't pulled out
    // from under the user; it shows the finished list instead.
    const strip = screen.getByTestId("plugin-setup-strip");
    await waitFor(() => expect(strip.textContent).toContain("Linear setup · 3 of 3"));
    expect(screen.getByRole("button", { name: "Undo skip: Step team" })).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByTestId("plugin-setup-strip").textContent).toContain("Linear needs setup")
    );
    // The trigger went with the checklist; focus moved to what replaced it.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Open plugin settings" })
      )
    );
  });

  it("never reopens the popover for another plugin, or on coming back", async () => {
    const { rerender } = render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();

    rerender(<PluginSetupStrip pluginId="acme.other" />);
    await waitFor(() => expect(getSetupStatus).toHaveBeenCalledWith("acme.other", "proj-1"));
    await screen.findByRole("button", { name: "Setup steps" });
    expect(screen.queryByText("Step team")).toBeNull();

    rerender(<PluginSetupStrip pluginId="acme.linear" />);
    await screen.findByRole("button", { name: "Setup steps" });
    expect(screen.queryByText("Step team")).toBeNull();
  });

  it("reports only the latest skip's failure", async () => {
    let rejectFirst!: (err: Error) => void;
    setSetupStepSkipped
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectFirst = reject;
          })
      )
      .mockResolvedValueOnce(undefined);
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();

    fireEvent.click(screen.getByRole("button", { name: "Skip: Step team" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip: Step team" }));
    await act(async () => rejectFirst(new Error("late")));
    expect(screen.queryByText("Couldn't save this choice")).toBeNull();
  });

  it("offers no skip with no project open, since a skip is remembered per project", async () => {
    currentProjectId = null;
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();
    expect(screen.queryByRole("button", { name: /^Skip/ })).toBeNull();
  });

  it("says when a skip couldn't be saved", async () => {
    setSetupStepSkipped.mockRejectedValue(new Error("disk full"));
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await openSteps();
    fireEvent.click(screen.getByRole("button", { name: "Skip: Step team" }));
    expect(await screen.findByText("Couldn't save this choice")).toBeTruthy();
  });

  it("draws the strip for a kind whose plugin declares setup steps", async () => {
    registerPanelKind({
      id: "acme.linear.shell",
      name: "Linear shell",
      iconId: "terminal",
      color: "#abcdef",
      hasPty: true,
      canRestart: false,
      canConvert: false,
      extensionId: "acme.linear",
      hasSetupSteps: true,
    });
    try {
      render(<PluginKindSetupStrip kind="acme.linear.shell" />);
      const strip = await screen.findByTestId("plugin-setup-strip");
      await waitFor(() => expect(strip.textContent).toContain("Linear setup · 1 of 3"));
    } finally {
      unregisterPanelKind("acme.linear.shell");
    }
  });
});

describe("PluginKindSetupStrip", () => {
  afterEach(() => {
    unregisterPanelKind("acme.linear.shell");
  });

  function registerKind(hasRequiredSettings: boolean) {
    registerPanelKind({
      id: "acme.linear.shell",
      name: "Linear shell",
      iconId: "terminal",
      color: "#abcdef",
      hasPty: true,
      canRestart: false,
      canConvert: false,
      extensionId: "acme.linear",
      ...(hasRequiredSettings ? { hasRequiredSettings: true } : {}),
    });
  }

  it("draws the strip for a kind whose plugin requires settings", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    registerKind(true);
    render(<PluginKindSetupStrip kind="acme.linear.shell" />);
    expect(await screen.findByTestId("plugin-setup-strip")).toBeTruthy();
    expect(getRequiredSettingsStatus).toHaveBeenCalledWith("acme.linear", "proj-1");
  });

  it("draws nothing, and reads nothing, for a built-in or unrequired kind", () => {
    registerKind(false);
    render(<PluginKindSetupStrip kind="acme.linear.shell" />);
    render(<PluginKindSetupStrip kind="terminal" />);
    expect(screen.queryByTestId("plugin-setup-strip")).toBeNull();
    expect(getRequiredSettingsStatus).not.toHaveBeenCalled();
  });
});
