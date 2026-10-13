import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const residencyMock = vi.hoisted(() => ({
  isWorkspaceKeepResident: vi.fn(() => false),
  setWorkspaceKeepResident: vi.fn(),
}));

vi.mock("../../../services/workspaceResidency.js", () => residencyMock);

import { ipcMain } from "electron";
import { registerWorkspaceResidencyHandlers } from "../workspaceResidency.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const match = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match[1] as Handler;
}

const EVENT = {} as Electron.IpcMainInvokeEvent;
const WORKSPACE = "a".repeat(64);

let dispose: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  residencyMock.isWorkspaceKeepResident.mockReturnValue(false);
  dispose = registerWorkspaceResidencyHandlers();
});

afterEach(() => {
  dispose();
});

describe("workspace residency IPC (#12313)", () => {
  it("writes both directions of the grant", async () => {
    const set = getHandler("workspace-residency:set");

    await set(EVENT, { workspaceId: WORKSPACE, keepResident: true });
    expect(residencyMock.setWorkspaceKeepResident).toHaveBeenCalledWith(WORKSPACE, true);

    await set(EVENT, { workspaceId: WORKSPACE, keepResident: false });
    expect(residencyMock.setWorkspaceKeepResident).toHaveBeenCalledWith(WORKSPACE, false);
  });

  it("rejects a malformed payload at the boundary", async () => {
    const set = getHandler("workspace-residency:set");

    // Validated before the handler body, so a bad payload can never reach the
    // preference write — the grant is a user authority, and the one thing this
    // boundary must not do is take a write it cannot vouch for.
    await expect(set(EVENT, { workspaceId: "", keepResident: true })).rejects.toThrow(
      /IPC validation failed/
    );
    await expect(set(EVENT, { workspaceId: WORKSPACE, keepResident: "yes" })).rejects.toThrow(
      /IPC validation failed/
    );

    expect(residencyMock.setWorkspaceKeepResident).not.toHaveBeenCalled();
  });
});
