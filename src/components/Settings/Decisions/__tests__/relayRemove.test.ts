// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addPanel = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<string | null>>()
);
const notify = vi.hoisted(() =>
  vi.fn<(payload: { message?: string; action?: { onClick: () => void } }) => void>()
);
const windows = vi.hoisted(() => ({ on: false }));

vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({ addPanel }) } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isWindows: () => windows.on }));

import {
  DECISIONS_REMOVE_CLI_VERSION,
  openRelayRemoveTerminal,
  relayRemoveCommand,
} from "../relayRemove";
import {
  isDecisionsRelayTerminalId,
  isDecisionsRemoveTerminalId,
  isScreenNeverSaved,
} from "@shared/config/terminalScreenPersistence";
import { isRelayRemovalTerminalId, parseRelayRemovalCommand } from "@shared/config/relayRemoval";

const ORIGIN = "https://relay.example.workers.dev";
const PLACEMENT = { cwd: "/home/me", worktreeId: "wt-1" };

describe("relay removal", () => {
  const startRelayRemoval = vi.fn();

  beforeEach(() => {
    addPanel.mockReset();
    notify.mockReset();
    startRelayRemoval.mockReset().mockResolvedValue({});
    windows.on = false;
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { decisions: { startRelayRemoval } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("runs a CLI release that has remove (0.3.0 or later)", () => {
    const [major, minor] = DECISIONS_REMOVE_CLI_VERSION.split(".").map(Number);
    expect(major! > 0 || minor! >= 3).toBe(true);
  });

  it("runs the pinned removal for the relay's origin and answers none of its prompts", () => {
    const argv = relayRemoveCommand(ORIGIN, false).split(" ");

    expect(argv).toEqual([
      "npx",
      "--yes",
      `@daintreehq/decisions-cli@${DECISIONS_REMOVE_CLI_VERSION}`,
      "remove",
      ORIGIN,
    ]);
  });

  it("builds only what the spawn handler will run under a removal id", () => {
    for (const windows of [false, true]) {
      const command = relayRemoveCommand(ORIGIN, windows);
      expect(parseRelayRemovalCommand(command)).toEqual(command.split(" "));
    }
    expect(parseRelayRemovalCommand(`npx --yes some-cli@1.0.0 remove ${ORIGIN}`)).toBeNull();
    expect(
      parseRelayRemovalCommand(
        `npx --yes @daintreehq/decisions-cli@${DECISIONS_REMOVE_CLI_VERSION} remove ${ORIGIN} --bucket x`
      )
    ).toBeNull();
    expect(
      parseRelayRemovalCommand(
        `npx --yes @daintreehq/decisions-cli@${DECISIONS_REMOVE_CLI_VERSION} remove http://localhost:8787`
      )
    ).toBeNull();
  });

  it("runs npm's batch shim on Windows", () => {
    const posix = relayRemoveCommand(ORIGIN, false).split(" ");
    const win = relayRemoveCommand(ORIGIN, true).split(" ");
    expect(win[0]).toBe("npx.cmd");
    expect(win.slice(1)).toEqual(posix.slice(1));
  });

  it.each([
    "http://localhost:8787",
    "https://relay.example.workers.dev:8443",
    "https://relay.example.workers.dev/path",
    "https://relay;rm -rf ~",
    "https://$(whoami).example.com",
    "https://localhost",
  ])("puts nothing a shell could read on the command line: refuses %s", (origin) => {
    expect(() => relayRemoveCommand(origin, false)).toThrow();
  });

  it("has main watch the pane's id before the pane opens, then opens it from home and keeps it", async () => {
    const order: string[] = [];
    startRelayRemoval.mockImplementation(async () => {
      order.push("watch");
      return {};
    });
    addPanel.mockImplementation(async () => {
      order.push("open");
      return "pane-1";
    });

    await expect(
      openRelayRemoveTerminal({ origin: ORIGIN, deleteLocalHistory: true }, PLACEMENT)
    ).resolves.toBe("pane-1");

    expect(order).toEqual(["watch", "open"]);
    const watched = startRelayRemoval.mock.calls[0]![0];
    const options = addPanel.mock.calls[0]![0];
    expect(watched).toEqual({
      terminalId: options.requestedId,
      origin: ORIGIN,
      deleteLocalHistory: true,
    });
    const id = String(options.requestedId);
    expect(isRelayRemovalTerminalId(id)).toBe(true);
    expect(isDecisionsRemoveTerminalId(id)).toBe(true);
    // Never replayed, restored or rerun, and its screen stays off disk.
    expect(isDecisionsRelayTerminalId(id)).toBe(true);
    expect(isScreenNeverSaved(id)).toBe(true);
    expect(options).toMatchObject({
      kind: "terminal",
      title: "Remove Decisions relay",
      cwd: "/home/me",
      worktreeId: "wt-1",
      location: "grid",
      focusPolicy: "take",
      exitBehavior: "keep",
      command: relayRemoveCommand(ORIGIN, false),
    });
  });

  it("starts each removal under a terminal id of its own", async () => {
    addPanel.mockResolvedValue("pane");
    await openRelayRemoveTerminal({ origin: ORIGIN, deleteLocalHistory: false }, PLACEMENT);
    await openRelayRemoveTerminal({ origin: ORIGIN, deleteLocalHistory: false }, PLACEMENT);
    const [first, second] = addPanel.mock.calls.map(([options]) => options.requestedId);
    expect(first).not.toBe(second);
  });

  it("opens no pane when main won't watch it, and says why", async () => {
    startRelayRemoval.mockRejectedValueOnce(new Error("Turn on Decisions to remove a relay"));

    await expect(
      openRelayRemoveTerminal({ origin: ORIGIN, deleteLocalHistory: false }, PLACEMENT)
    ).resolves.toBeNull();

    expect(addPanel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0].message).toContain("Turn on Decisions to remove a relay");
  });

  it("says the pane didn't open, and tries again under a new id when asked", async () => {
    addPanel.mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValueOnce("pane-2");

    await expect(
      openRelayRemoveTerminal({ origin: ORIGIN, deleteLocalHistory: false }, PLACEMENT)
    ).resolves.toBeNull();
    notify.mock.calls[0]![0].action!.onClick();

    await vi.waitFor(() => expect(addPanel).toHaveBeenCalledTimes(2));
    expect(startRelayRemoval).toHaveBeenCalledTimes(2);
    const ids = startRelayRemoval.mock.calls.map(([payload]) => payload.terminalId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
