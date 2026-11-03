import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance } from "@shared/types/panel";

const addPanel = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<string | null>>()
);
const notify = vi.hoisted(() =>
  vi.fn<(payload: { action?: { onClick: () => void }; context?: unknown }) => void>()
);
const windows = vi.hoisted(() => ({ on: false }));

vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  return {
    usePanelStore: create(() => ({ panelsById: {} as Record<string, unknown>, addPanel })),
  };
});
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isWindows: () => windows.on }));

import { usePanelStore } from "@/store/panelStore";
import {
  DECISIONS_UPDATE_CLI_VERSION,
  canUpdateRelayAt,
  getRelayUpdateRun,
  openRelayUpdateTerminal,
  relayUpdateCommand,
  resetRelayUpdateRunForTests,
  subscribeRelayUpdateRun,
  type RelayUpdateRequest,
} from "../relayUpdate";
import {
  isDecisionsUpdateTerminalId,
  isScreenNeverSaved,
} from "@shared/config/terminalScreenPersistence";

const ORIGIN = "https://decisions.example.workers.dev";

const REQUEST: RelayUpdateRequest = {
  cwd: "/home/me",
  worktreeId: "wt-1",
  origin: ORIGIN,
  fromVersion: "0.2.0",
  daintree: { protocolMin: 1, protocolMax: 1 },
};

function setPanel(id: string, panel: Record<string, unknown> | undefined): void {
  usePanelStore.setState((state) => {
    const panelsById = { ...state.panelsById } as Record<string, PanelInstance>;
    if (panel) panelsById[id] = { id, kind: "terminal", ...panel } as unknown as PanelInstance;
    else delete panelsById[id];
    return { panelsById };
  });
}

/** addPanel as the store does it: the pane is in the store, running, by the time its id resolves. */
async function addsRunningPane(options: Record<string, unknown>, id?: string): Promise<string> {
  const paneId = id ?? (options.requestedId as string);
  setPanel(paneId, { runtimeStatus: "running" });
  return paneId;
}

/** Opens an update whose pane exists, running, as addPanel leaves it. */
async function openRunning(): Promise<string> {
  addPanel.mockImplementation((options) => addsRunningPane(options));
  const id = await openRelayUpdateTerminal(REQUEST);
  expect(id).not.toBeNull();
  return id!;
}

describe("relay update command", () => {
  it("runs the pinned CLI's update against the relay, limited to this Daintree's protocols", () => {
    const argv = relayUpdateCommand(ORIGIN, { protocolMin: 1, protocolMax: 2 }, false)!.split(" ");

    expect(argv.slice(0, 4)).toEqual([
      "npx",
      "--yes",
      `@daintreehq/decisions-cli@${DECISIONS_UPDATE_CLI_VERSION}`,
      "update",
    ]);
    expect(argv[argv.indexOf("--url") + 1]).toBe(ORIGIN);
    expect(argv[argv.indexOf("--protocol") + 1]).toBe("1-2");
    // npx's own --yes only; the CLI keeps its confirmation, and gets no token, account or target.
    expect(argv.filter((arg) => arg.startsWith("-"))).toEqual(["--yes", "--url", "--protocol"]);
  });

  it("names a single protocol on its own", () => {
    const command = relayUpdateCommand(ORIGIN, { protocolMin: 2, protocolMax: 2 }, false)!;

    expect(command.split(" ").at(-1)).toBe("2");
  });

  it("runs npm's batch shim on Windows", () => {
    const posix = relayUpdateCommand(ORIGIN, REQUEST.daintree, false)!.split(" ");
    const win = relayUpdateCommand(ORIGIN, REQUEST.daintree, true)!.split(" ");

    expect(win[0]).toBe("npx.cmd");
    expect(win.slice(1)).toEqual(posix.slice(1));
  });

  it.each([
    ["plain http", "http://localhost:8787"],
    ["an IPv6 literal", "https://[::1]:8787"],
    ["a path", "https://decisions.example.workers.dev/x"],
    ["shell syntax", "https://decisions.example.workers.dev;rm"],
    ["a space", "https://decisions example.dev"],
    ["a user name", "https://me@decisions.example.workers.dev"],
  ])("won't carry %s into the command", (_label, origin) => {
    expect(canUpdateRelayAt(origin)).toBe(false);
    expect(relayUpdateCommand(origin, REQUEST.daintree, false)).toBeNull();
  });

  it.each([
    [{ protocolMin: 0, protocolMax: 1 }],
    [{ protocolMin: 2, protocolMax: 1 }],
    [{ protocolMin: 1.5, protocolMax: 2 }],
  ])("won't pass a protocol range that isn't one: %o", (daintree) => {
    expect(relayUpdateCommand(ORIGIN, daintree, false)).toBeNull();
  });
});

describe("relay update terminal", () => {
  beforeEach(() => {
    resetRelayUpdateRunForTests();
    usePanelStore.setState({ panelsById: {} });
    addPanel.mockReset();
    notify.mockReset();
    windows.on = false;
  });
  afterEach(() => {
    resetRelayUpdateRunForTests();
  });

  it("opens a focused, kept pane whose id runs the update once and keeps its screen off disk", async () => {
    addPanel.mockImplementation((options) => addsRunningPane(options, "pane-1"));

    await expect(openRelayUpdateTerminal(REQUEST)).resolves.toBe("pane-1");

    const options = addPanel.mock.calls[0]![0];
    expect(options).toMatchObject({
      kind: "terminal",
      cwd: "/home/me",
      worktreeId: "wt-1",
      location: "grid",
      exitBehavior: "keep",
      focusPolicy: "take",
      command: relayUpdateCommand(ORIGIN, REQUEST.daintree, false),
    });
    const id = options.requestedId as string;
    expect(isDecisionsUpdateTerminalId(id)).toBe(true);
    expect(isScreenNeverSaved(id)).toBe(true);
    expect(getRelayUpdateRun()).toMatchObject({
      state: "running",
      terminalId: "pane-1",
      origin: ORIGIN,
      fromVersion: "0.2.0",
    });
  });

  it("starts nothing for a relay the command can't name", async () => {
    await expect(
      openRelayUpdateTerminal({ ...REQUEST, origin: "http://localhost:8787" })
    ).resolves.toBeNull();

    expect(addPanel).not.toHaveBeenCalled();
    expect(getRelayUpdateRun()).toBeNull();
  });

  it("opens one pane at a time, however often it's asked", async () => {
    let resolve!: () => void;
    addPanel.mockImplementationOnce(
      (options) =>
        new Promise<string>((res) => (resolve = () => res(addsRunningPane(options, "pane-1"))))
    );

    const first = openRelayUpdateTerminal(REQUEST);
    await expect(openRelayUpdateTerminal(REQUEST)).resolves.toBeNull();
    resolve();
    await expect(first).resolves.toBe("pane-1");
    await expect(openRelayUpdateTerminal(REQUEST)).resolves.toBeNull();

    expect(addPanel).toHaveBeenCalledOnce();
  });

  it("follows nothing when the panel limit refused the pane", async () => {
    addPanel.mockResolvedValue(null);

    await expect(openRelayUpdateTerminal(REQUEST)).resolves.toBeNull();

    expect(getRelayUpdateRun()).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("says so, with a way to try again, when the pane couldn't be opened", async () => {
    addPanel
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementationOnce((options) => addsRunningPane(options, "pane-2"));

    await expect(openRelayUpdateTerminal(REQUEST)).resolves.toBeNull();

    expect(getRelayUpdateRun()).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
    notify.mock.calls[0]![0].action!.onClick();
    await vi.waitFor(() => expect(addPanel).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getRelayUpdateRun()).toMatchObject({ terminalId: "pane-2" }));
  });

  it("ends the run with the exit code its pane's shell ended with", async () => {
    const id = await openRunning();
    const seen = vi.fn();
    subscribeRelayUpdateRun(seen);

    setPanel(id, { runtimeStatus: "running", agentState: undefined });
    expect(getRelayUpdateRun()?.state).toBe("running");

    setPanel(id, { runtimeStatus: "exited", exitCode: 1 });

    expect(getRelayUpdateRun()).toMatchObject({
      state: "ended",
      end: { reason: "exited", exitCode: 1 },
    });
    expect(seen).toHaveBeenCalledOnce();
    // Nothing more is followed once it has ended.
    setPanel(id, undefined);
    expect(getRelayUpdateRun()).toMatchObject({ end: { reason: "exited", exitCode: 1 } });
  });

  it.each([
    ["closed", undefined],
    ["restarted, replacing its process", { runtimeStatus: "running", restartKey: 1 }],
  ])("ends the run when its pane is %s", async (_label, panel) => {
    const id = await openRunning();

    setPanel(id, panel);

    expect(getRelayUpdateRun()).toMatchObject({ state: "ended", end: { reason: "closed" } });
  });

  it("keeps following through a restart that was refused", async () => {
    const id = await openRunning();

    setPanel(id, { runtimeStatus: "running", isRestarting: true });
    setPanel(id, { runtimeStatus: "running", isRestarting: false });
    expect(getRelayUpdateRun()?.state).toBe("running");

    setPanel(id, { runtimeStatus: "exited", exitCode: 0 });
    expect(getRelayUpdateRun()).toMatchObject({ end: { reason: "exited", exitCode: 0 } });
  });

  it("keeps following through a spawn error the host later takes back", async () => {
    const id = await openRunning();

    setPanel(id, { runtimeStatus: "error", spawnStatus: "failed" });
    expect(getRelayUpdateRun()?.state).toBe("running");
    setPanel(id, { runtimeStatus: undefined });

    setPanel(id, { runtimeStatus: "exited", exitCode: 1 });
    expect(getRelayUpdateRun()).toMatchObject({ end: { reason: "exited", exitCode: 1 } });
  });

  it("measures a restart from the pane as it opened", async () => {
    addPanel.mockImplementation(async (options) => {
      const id = options.requestedId as string;
      setPanel(id, { runtimeStatus: "running", restartKey: 3 });
      return id;
    });
    const id = (await openRelayUpdateTerminal(REQUEST))!;

    setPanel(id, { runtimeStatus: "running", restartKey: 3 });
    expect(getRelayUpdateRun()?.state).toBe("running");

    setPanel(id, { runtimeStatus: "running", restartKey: 4 });
    expect(getRelayUpdateRun()).toMatchObject({ state: "ended", end: { reason: "closed" } });
  });

  it("ends at once when the pane had already exited by the time it was added", async () => {
    addPanel.mockImplementation(async (options) => {
      const id = options.requestedId as string;
      setPanel(id, { runtimeStatus: "exited", exitCode: 2 });
      return id;
    });

    await openRelayUpdateTerminal(REQUEST);

    expect(getRelayUpdateRun()).toMatchObject({
      state: "ended",
      end: { reason: "exited", exitCode: 2 },
    });
  });

  it("lets a new update start once the last has ended, as a newer run", async () => {
    const first = await openRunning();
    const firstRun = getRelayUpdateRun()!;
    setPanel(first, { runtimeStatus: "exited", exitCode: 0 });

    const second = await openRunning();

    expect(second).not.toBe(first);
    expect(getRelayUpdateRun()).toMatchObject({ state: "running", terminalId: second });
    expect(getRelayUpdateRun()!.id).toBeGreaterThan(firstRun.id);
    // The first pane's later changes no longer reach the new run.
    setPanel(first, undefined);
    expect(getRelayUpdateRun()?.state).toBe("running");
  });
});
