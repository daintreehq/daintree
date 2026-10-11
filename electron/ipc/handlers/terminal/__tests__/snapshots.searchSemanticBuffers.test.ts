import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { getIpcDispatcher } from "../../../dispatcher.js";
import type { ClientEndpoint, ClientRef } from "../../../endpoint.js";
import { registerTerminalSnapshotHandlers } from "../snapshots.js";
import type { HandlerDependencies } from "../../../types.js";

const matches = [
  { terminalId: "mine", line: "token here", matchStart: 0, matchEnd: 5 },
  { terminalId: "theirs", line: "token there", matchStart: 0, matchEnd: 5 },
  { terminalId: "nobodys", line: "token", matchStart: 0, matchEnd: 5 },
];
const owners: Record<string, string | null> = { mine: "proj-1", theirs: "proj-2", nobodys: null };

function remoteView(projectId: string | null): ClientEndpoint {
  return {
    endpointId: "remote:s:v",
    clientId: "shell",
    projectId,
    kind: "remote-view",
    handle: -3,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  } as unknown as ClientEndpoint;
}
const client: ClientRef = {
  clientId: "shell",
  clientName: "s",
  platform: "darwin",
  kind: "remote",
};

describe("terminal:search-semantic-buffers", () => {
  const ptyClient = {
    searchSemanticBuffersAsync: vi.fn(async () => matches),
    getTerminalProjectId: (id: string) => owners[id] ?? null,
  };
  const dispose = registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
  // The plain envelope, as security setup installs it for real.
  getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, run) => {
    try {
      return { ok: true, data: await run() } as never;
    } catch (error) {
      return { ok: false, error } as never;
    }
  });

  it("finds only the remote view's own project's terminals", async () => {
    const envelope = await getIpcDispatcher().invokeForEndpoint(
      { endpoint: remoteView("proj-1"), client },
      CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS,
      ["token", false]
    );
    if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
    expect(envelope.data).toEqual([matches[0]]);
    const none = await getIpcDispatcher().invokeForEndpoint(
      { endpoint: remoteView(null), client },
      CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS,
      ["token", false]
    );
    expect(none.ok && none.data).toEqual([]);
  });

  it("finds every terminal for this machine's own window", async () => {
    const call = (
      ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }
    ).mock.calls.find((c) => c[0] === CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS);
    const handler = call?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    const result = await handler(
      { sender: { id: 7 }, senderFrame: { url: "app://daintree" } },
      "token",
      false
    );
    const data =
      (result as { ok?: boolean; data?: unknown }).ok !== undefined
        ? (result as { data: unknown }).data
        : result;
    expect(data).toEqual(matches);
    dispose?.();
  });
});
