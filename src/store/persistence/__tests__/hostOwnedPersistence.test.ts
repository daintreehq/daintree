import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setDraftInputsMock, logErrorMock } = vi.hoisted(() => ({
  setDraftInputsMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock("@/clients", () => ({ projectClient: { setDraftInputs: setDraftInputsMock } }));
vi.mock("@/utils/logger", () => ({
  logError: logErrorMock,
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { initBuiltInPanelKinds } from "@/panels/registry";
import { PanelPersistence } from "../panelPersistence";
import { draftInputPersistence } from "../draftInputPersistence";
import { _resetHostOwnedWritesForTesting } from "../hostOwnedWrites";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import {
  _resetTerminalInputGateForTesting,
  setHostInputBlock,
  setLeaseInputBlock,
} from "@/services/terminal/inputGate";
import type { TerminalInstance, TabGroup } from "@/types";

initBuiltInPanelKinds();

const appError = (code: string) => new Error(`[AppError|${code}] refused`);
const disconnected = () => setHostInputBlock({ kind: "disconnected", hostName: "studio" });
const drivenElsewhere = () =>
  setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "laptop", projectId: "proj-1" });

const terminal = (id: string): TerminalInstance =>
  ({ id, title: id, cwd: "/p", cols: 80, rows: 24, location: "grid" }) as TerminalInstance;
const group = (id: string, panelIds: string[]): TabGroup =>
  ({ id, location: "grid", activeTabId: panelIds[0]!, panelIds }) as TabGroup;

function makeClient() {
  return {
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  setDraftInputsMock.mockResolvedValue(undefined);
  _resetTerminalInputGateForTesting();
  _resetHostOwnedWritesForTesting();
  useTerminalInputStore.setState({ draftInputs: new Map() });
});

afterEach(async () => {
  await draftInputPersistence.whenIdle();
  draftInputPersistence.clearProject("proj-1");
  _resetHostOwnedWritesForTesting();
  _resetTerminalInputGateForTesting();
});

describe("panel layout saves of a host-owned project", () => {
  it("a local view saves the panel list and reports a real failure as before", async () => {
    const client = makeClient();
    client.setTerminals.mockRejectedValueOnce(new Error("EACCES"));
    const persistence = new PanelPersistence(client as never, { debounceMs: 0 });
    persistence.save([terminal("a")], "proj-1");
    await drain();
    expect(client.setTerminals).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith("Failed to persist terminals", expect.any(Error));
  });

  it("sends no panel list or tab groups while another screen drives the project", async () => {
    drivenElsewhere();
    const client = makeClient();
    const persistence = new PanelPersistence(client as never, { debounceMs: 0 });
    persistence.save([terminal("a")], "proj-1");
    persistence.saveTabGroups(new Map([["g", group("g", ["a", "b"])]]), "proj-1");
    await drain();
    expect(client.setTerminals).not.toHaveBeenCalled();
    expect(client.setTabGroups).not.toHaveBeenCalled();
  });

  it("doesn't log a DRIVEN_ELSEWHERE refusal as a failure", async () => {
    const client = makeClient();
    client.setTerminals.mockRejectedValue(appError("DRIVEN_ELSEWHERE"));
    const persistence = new PanelPersistence(client as never, { debounceMs: 0 });
    persistence.save([terminal("a")], "proj-1");
    await drain();
    expect(client.setTerminals).toHaveBeenCalledTimes(1);
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("replays the latest layout lost to a disconnect once the link is back, diffed against the last acknowledged save", async () => {
    const client = makeClient();
    const persistence = new PanelPersistence(client as never, { debounceMs: 0 });
    persistence.primeProject("proj-1", []);
    let loseFirst!: (error: Error) => void;
    client.setTerminals.mockImplementationOnce(
      () => new Promise((_, reject) => (loseFirst = reject))
    );
    persistence.save([terminal("a")], "proj-1");
    await drain();
    // The link drops under the write in flight.
    disconnected();
    loseFirst(appError("HOST_DISCONNECTED"));
    persistence.save([terminal("a"), terminal("b")], "proj-1");
    await drain();
    expect(client.setTerminals).toHaveBeenCalledTimes(1);
    expect(logErrorMock).not.toHaveBeenCalled();

    setHostInputBlock(null);
    await drain();
    expect(client.setTerminals).toHaveBeenCalledTimes(2);
    const [, snapshots, changedIds] = client.setTerminals.mock.calls[1]!;
    expect((snapshots as Array<{ id: string }>).map((s) => s.id)).toEqual(["a", "b"]);
    expect(changedIds).toEqual(["a", "b"]);
  });

  it("drops a held layout when someone else takes the project over meanwhile", async () => {
    const client = makeClient();
    const persistence = new PanelPersistence(client as never, { debounceMs: 0 });
    disconnected();
    persistence.save([terminal("a")], "proj-1");
    persistence.saveTabGroups(new Map([["g", group("g", ["a", "b"])]]), "proj-1");
    await drain();
    drivenElsewhere();
    setHostInputBlock(null);
    await drain();
    expect(client.setTerminals).not.toHaveBeenCalled();
    expect(client.setTabGroups).not.toHaveBeenCalled();
  });
});

describe("panel layout saves superseded while held", () => {
  it("a layout held through a disconnect doesn't replay once the view went back to what the host has", async () => {
    const client = makeClient();
    const persistence = new PanelPersistence(client as never, { debounceMs: 0 });
    persistence.primeProject("proj-1", []);
    disconnected();
    persistence.save([terminal("a")], "proj-1");
    await drain();
    // The pane is closed again before the link returns: the host's empty list stands.
    persistence.save([], "proj-1");
    await drain();
    setHostInputBlock(null);
    await drain();
    expect(client.setTerminals).not.toHaveBeenCalled();
  });
});

describe("draft saves of a host-owned project", () => {
  it("sends nothing while another screen drives, and keeps the baseline for later", async () => {
    draftInputPersistence.primeProject("proj-1", {});
    drivenElsewhere();
    useTerminalInputStore.getState().setDraftInput("t1", "hello", "proj-1");
    draftInputPersistence.flushAll();
    await drain();
    expect(setDraftInputsMock).not.toHaveBeenCalled();
    expect(draftInputPersistence.getBaseline("proj-1")).toEqual({});
  });

  it("flushes what the view holds after a reconnect, not the text from when the link dropped", async () => {
    draftInputPersistence.primeProject("proj-1", {});
    useTerminalInputStore.getState().setDraftInput("t1", "hel", "proj-1");
    let loseFirst!: (error: Error) => void;
    setDraftInputsMock.mockImplementationOnce(
      () => new Promise((_, reject) => (loseFirst = reject))
    );
    draftInputPersistence.flushAll();
    await drain();
    disconnected();
    loseFirst(appError("OUTCOME_UNKNOWN"));
    await drain();
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(setDraftInputsMock).toHaveBeenCalledTimes(1);
    useTerminalInputStore.getState().setDraftInput("t1", "hello", "proj-1");

    setHostInputBlock(null);
    await drain();
    expect(setDraftInputsMock).toHaveBeenCalledTimes(2);
    const last = setDraftInputsMock.mock.calls.at(-1)!;
    expect(last[1]).toEqual({ t1: "hello" });
    expect(last[2]).toEqual(["t1"]);
    expect(draftInputPersistence.getBaseline("proj-1")).toEqual({ t1: "hello" });
  });
});
