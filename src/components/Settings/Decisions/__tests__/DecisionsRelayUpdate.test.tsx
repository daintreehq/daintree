// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsRelayCheck,
  DecisionsRelayVersions,
  DecisionsStatus,
} from "@shared/types/decisions";
import type { PanelInstance } from "@shared/types/panel";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { TooltipProvider } from "@/components/ui/tooltip";

const addPanel = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<string | null>>()
);
const view = vi.hoisted(() => ({
  remote: false,
  homeDir: "/home/me" as string | undefined,
  project: true,
  activeWorktreeId: "wt-1" as string | null,
}));

vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  return {
    usePanelStore: create(() => ({ panelsById: {} as Record<string, unknown>, addPanel })),
  };
});
vi.mock("@/hooks/app/useHomeDir", () => ({ useHomeDir: () => ({ homeDir: view.homeDir }) }));
vi.mock("@/hooks/useHostPlatform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useHostPlatform")>()),
  isRemoteWindow: () => view.remote,
}));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "workspace-1" }));
vi.mock("@/store/viewWorkspace", () => ({
  selectViewProject: () => (view.project ? { id: "workspace-1" } : undefined),
  selectViewScratch: () => undefined,
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: unknown) => unknown) => select({}),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (select: (state: unknown) => unknown) => select({}),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (select: (state: { activeWorktreeId: string | null }) => unknown) =>
    select({ activeWorktreeId: view.activeWorktreeId }),
}));

import { usePanelStore } from "@/store/panelStore";
import { DecisionsConnectionSection } from "../DecisionsConnectionSection";
import { getRelayUpdateRun, resetRelayUpdateRunForTests } from "../relayUpdate";

const ORIGIN = "https://decisions.example.workers.dev";
const DAINTREE: DecisionsRelayVersions = { protocolMin: 1, protocolMax: 1, workerVersion: "0.2.0" };
const CONNECTED: DecisionsStatus = { state: "connected", relayOrigin: ORIGIN };

const checkRelay = vi.fn<(url: string) => Promise<DecisionsRelayCheck>>();

function claimedAt(workerVersion: string): DecisionsRelayCheck {
  const relay = { ...DAINTREE, workerVersion };
  return {
    result: "claimed",
    origin: ORIGIN,
    compatibility: {
      relay,
      daintree: DAINTREE,
      diverges: workerVersion !== DAINTREE.workerVersion,
    },
  };
}

function setPanel(id: string, panel: Record<string, unknown> | undefined): void {
  usePanelStore.setState((state) => {
    const panelsById = { ...state.panelsById } as Record<string, PanelInstance>;
    if (panel) panelsById[id] = { id, kind: "terminal", ...panel } as unknown as PanelInstance;
    else delete panelsById[id];
    return { panelsById };
  });
}

function ui(status: DecisionsStatus, onClose?: SettingsTabClose) {
  return (
    <TooltipProvider>
      <DecisionsConnectionSection status={status} onClose={onClose} />
    </TooltipProvider>
  );
}

async function renderSection(status: DecisionsStatus = CONNECTED, onClose?: SettingsTabClose) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui(status, onClose));
  });
  return result;
}

function updateButton(): HTMLButtonElement {
  const row = document.getElementById("decisions-relay-update")!;
  return within(row).getByRole("button", { name: "Update relay" }) as HTMLButtonElement;
}

function outcomeRow(): HTMLElement | null {
  return document.getElementById("decisions-relay-update-outcome");
}

/** Presses Update relay with no Settings close, so the pane opens at once. */
async function startUpdate(): Promise<string> {
  await act(async () => {
    fireEvent.click(updateButton());
  });
  const run = getRelayUpdateRun();
  expect(run?.state).toBe("running");
  return run!.terminalId;
}

async function endPane(id: string, panel: Record<string, unknown> | undefined) {
  await act(async () => {
    setPanel(id, panel);
  });
}

describe("Decisions relay update", () => {
  beforeEach(() => {
    resetRelayUpdateRunForTests();
    usePanelStore.setState({ panelsById: {} });
    addPanel.mockReset();
    addPanel.mockImplementation(async (options) => {
      const id = options.requestedId as string;
      setPanel(id, { runtimeStatus: "running" });
      return id;
    });
    checkRelay.mockReset();
    Object.assign(view, {
      remote: false,
      homeDir: "/home/me",
      project: true,
      activeWorktreeId: "wt-1",
    });
    Object.defineProperty(window, "electron", {
      value: {
        decisions: {
          checkRelay,
          getSetupCheck: () => Promise.resolve(null),
          startSetupCheck: vi.fn(),
          cancelSetupCheck: () => Promise.resolve(null),
        },
        events: { on: () => () => {} },
      },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
    resetRelayUpdateRunForTests();
  });

  it("puts the update forward for a relay behind this Daintree, and points the prompt at it", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    await renderSection();

    expect(updateButton().dataset.variant).toBe("contrast");
    expect(updateButton().disabled).toBe(false);
    const versions = document.getElementById("decisions-relay-versions")!;
    expect(within(versions).getByText(/Update relay finds a release/)).toBeTruthy();
    expect(versions.textContent).not.toMatch(/never updates/);
  });

  it("still offers a look for a newer release when the versions match", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.2.0"));
    await renderSection();

    expect(updateButton().dataset.variant).toBe("outline");
    expect(updateButton().disabled).toBe(false);
  });

  it("isn't offered in a remote window, whose relay the Host updates", async () => {
    view.remote = true;
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    await renderSection();

    expect(document.getElementById("decisions-relay-update")).toBeNull();
    expect(screen.getByText(/Update it from Daintree on the Host/)).toBeTruthy();
  });

  it("waits for a check that reads the relay's version", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    await renderSection({ state: "reconnecting", relayOrigin: ORIGIN });

    expect(checkRelay).not.toHaveBeenCalled();
    expect(updateButton().disabled).toBe(true);
    expect(screen.getByText("Needs a check that reads the relay's version first")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check" }));
    });

    expect(updateButton().disabled).toBe(false);
  });

  it("needs a project open to show the update's pane", async () => {
    view.project = false;
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    await renderSection();

    expect(updateButton().disabled).toBe(true);
    expect(screen.getByText("Open a project to watch the update in a terminal")).toBeTruthy();
  });

  it("closes Settings, then runs the update for this relay with this Daintree's protocols", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    let afterClose: ((closed: boolean) => void) | undefined;
    const onClose = vi.fn<SettingsTabClose>(async (next) => {
      afterClose = next;
      return true;
    });
    await renderSection(CONNECTED, onClose);

    await act(async () => {
      fireEvent.click(updateButton());
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(addPanel).not.toHaveBeenCalled();

    await act(async () => {
      afterClose?.(true);
    });

    expect(addPanel).toHaveBeenCalledOnce();
    const command = addPanel.mock.calls[0]![0].command as string;
    expect(command).toContain(`update --url ${ORIGIN} --protocol 1`);
    expect(getRelayUpdateRun()).toMatchObject({ state: "running", fromVersion: "0.1.0" });
  });

  it("starts nothing when Settings stayed open", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    const onClose = vi.fn<SettingsTabClose>(async () => false);
    await renderSection(CONNECTED, onClose);

    await act(async () => {
      fireEvent.click(updateButton());
    });

    expect(addPanel).not.toHaveBeenCalled();
    expect(updateButton().disabled).toBe(false);
  });

  it("checks the relay again when the update ends, and shows the version it moved to", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    await renderSection();
    const pane = await startUpdate();

    expect(updateButton().disabled).toBe(true);
    expect(screen.getByText("An update is running in its terminal")).toBeTruthy();

    checkRelay.mockClear();
    checkRelay.mockResolvedValue(claimedAt("0.3.0"));
    await endPane(pane, { runtimeStatus: "exited", exitCode: 0 });

    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(within(outcomeRow()!).getByText("Relay updated to 0.3.0")).toBeTruthy();
    expect(screen.getByText(/The relay runs 0\.3\.0/)).toBeTruthy();
    expect(updateButton().disabled).toBe(false);
  });

  it("says a failed update failed, and leaves the connection as it was", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    await renderSection();
    const pane = await startUpdate();

    await endPane(pane, { runtimeStatus: "exited", exitCode: 1 });

    const row = outcomeRow()!;
    expect(within(row).getByText("The relay update failed")).toBeTruthy();
    expect(within(row).getByText(/still runs 0\.1\.0/)).toBeTruthy();
    const status = document.getElementById("decisions-connection-status")!;
    expect(within(status).getByText(`Connected to ${new URL(ORIGIN).host}`)).toBeTruthy();
  });

  it("checks again when its pane closes before the update ends, connected or not", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    const section = await renderSection();
    const pane = await startUpdate();
    await act(async () => {
      section.rerender(ui({ state: "reconnecting", relayOrigin: ORIGIN }));
    });

    checkRelay.mockClear();
    await endPane(pane, undefined);

    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(
      within(outcomeRow()!).getByText("The update's terminal closed before the update ended")
    ).toBeTruthy();
  });

  it("checks again, and says how the update went, each time Settings opens after it ended", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    const first = await renderSection();
    const pane = await startUpdate();
    first.unmount();

    // It ends while Settings is closed.
    setPanel(pane, { runtimeStatus: "exited", exitCode: 0 });
    checkRelay.mockReset();
    checkRelay.mockResolvedValue(claimedAt("0.3.0"));

    await renderSection({ state: "reconnecting", relayOrigin: ORIGIN });

    expect(checkRelay).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(within(outcomeRow()!).getByText("Relay updated to 0.3.0")).toBeTruthy();
  });

  it("shows no outcome until the check after the update has answered", async () => {
    checkRelay.mockResolvedValue(claimedAt("0.1.0"));
    await renderSection();
    const pane = await startUpdate();

    let answer!: (check: DecisionsRelayCheck) => void;
    checkRelay.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await endPane(pane, { runtimeStatus: "exited", exitCode: 0 });

    expect(outcomeRow()).toBeNull();

    await act(async () => {
      answer(claimedAt("0.3.0"));
    });

    expect(within(outcomeRow()!).getByText("Relay updated to 0.3.0")).toBeTruthy();
  });
});
