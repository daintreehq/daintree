/**
 * #12060: the fleet palette groups runs by the pty-host's copy of `worktreeId`,
 * and nothing re-stamps that copy after spawn. This channel is the hop that
 * carries a cross-worktree move to it.
 *
 * The contract these specs pin is the one the issue is explicit about: there is
 * no silent fallback. `null` is the ONLY way to say "this run now has no
 * worktree", a malformed payload is dropped rather than guessed at, and nothing
 * here substitutes a project root, the active worktree, or the previous id for
 * a value that failed validation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn(() => false),
}));

vi.mock("../../../../window/portDistribution.js", () => ({
  distributeTerminalWorkerPortToView: vi.fn(() => ({ token: "port-token" })),
  releaseTerminalWorkerPort: vi.fn(),
}));

const emitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../services/events.js", () => ({
  events: { emit: emitMock, on: vi.fn(() => vi.fn()), off: vi.fn() },
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";

const updateWorktreeId = vi.fn();

function buildDeps(): HandlerDependencies {
  return {
    ptyClient: {
      updateWorktreeId,
      getTerminalAsync: vi.fn(() => Promise.resolve(null)),
    },
    windowRegistry: { getByWindowId: () => undefined },
  } as unknown as HandlerDependencies;
}

/** Deliver a payload on the worktree channel exactly as the preload would. */
function send(payload: unknown): void {
  const call = ipcMainMock.on.mock.calls.find(
    ([channel]) => channel === CHANNELS.TERMINAL_UPDATE_WORKTREE_ID
  );
  if (!call) throw new Error("worktree-update handler was never registered");
  const registered = call[1] as (event: unknown, payload: unknown) => void;
  registered({ sender: { id: 1 } }, payload);
}

describe("terminal:update-worktree-id", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    dispose = registerTerminalIOHandlers(buildDeps());
  });

  it("re-files a run onto a real worktree id", () => {
    send({ id: "t1", worktreeId: "/repo/.worktrees/feature" });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", "/repo/.worktrees/feature");
  });

  it("forwards the id verbatim rather than canonicalizing the path", () => {
    // A worktree id is a path, and the same path has more than one spelling.
    // Re-deriving one here would file the run under an id the renderer does not
    // recognize as the worktree the user dragged it to.
    const id = "/Repo/../repo/.worktrees/feature/";
    send({ id: "t1", worktreeId: id });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", id);
  });

  it("treats null as an explicit clear", () => {
    // The one path that really leaves a panel with no worktree: undoing a
    // dock-to-grid move deletes the id the pane adopted on its way to the grid.
    send({ id: "t1", worktreeId: null });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", null);
  });

  it.each([
    ["a missing field", { id: "t1" }],
    ["undefined", { id: "t1", worktreeId: undefined }],
    ["an empty string", { id: "t1", worktreeId: "" }],
    ["whitespace only", { id: "t1", worktreeId: "   " }],
    ["a number", { id: "t1", worktreeId: 7 }],
    ["an object", { id: "t1", worktreeId: { path: "/repo" } }],
    ["a blank terminal id", { id: "", worktreeId: "/repo" }],
    ["a non-string terminal id", { id: 3, worktreeId: "/repo" }],
    ["no payload at all", undefined],
  ])("drops %s instead of guessing at it", (_label, payload) => {
    send(payload);

    expect(updateWorktreeId).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("announces the change so the palette regroups before the next poll", () => {
    send({ id: "t1", worktreeId: "/repo" });

    expect(emitMock).toHaveBeenCalledWith(
      "terminal:worktree-changed",
      expect.objectContaining({ id: "t1" })
    );
  });

  it("unhooks the listener on teardown so a re-register cannot double-apply", () => {
    // A leaked listener would apply every move twice — harmless for a set, but
    // it would also emit two fleet recomputes per drag.
    const listener = ipcMainMock.on.mock.calls.find(
      ([channel]) => channel === CHANNELS.TERMINAL_UPDATE_WORKTREE_ID
    )?.[1];

    dispose();

    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      CHANNELS.TERMINAL_UPDATE_WORKTREE_ID,
      listener
    );
  });
});
