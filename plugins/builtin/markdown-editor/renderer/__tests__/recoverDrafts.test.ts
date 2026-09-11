// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchMock, setFileViewModeMock, projectState } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  setFileViewModeMock: vi.fn(),
  projectState: { currentProject: null as { id: string; path: string } | null },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ setFileViewMode: setFileViewModeMock }) },
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectState },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { subscribeRecoverDrafts } from "../recoverDrafts";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { CHANNELS, PUSH_CHANNELS, identityKey } from "../../shared/protocol";
import { createFakeMain, type FakeMain } from "./testHost";

const IDENTITY = { projectId: "p1", worktreePath: "/repo-wt", filePath: "/repo-wt/docs/plan.md" };

let main: FakeMain;
let uninstall: () => void;
let unsubscribe: () => void;

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  main = createFakeMain();
  uninstall = main.install();
  unsubscribe = subscribeRecoverDrafts();
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: { panelId: "panel-9" } });
  setFileViewModeMock.mockClear();
  projectState.currentProject = { id: "p1", path: "/repo" };
  useFileDocumentStore.setState({ byPanelId: {} });
});

afterEach(() => {
  unsubscribe();
  uninstall();
  vi.useRealTimers();
});

describe("recoverDrafts (#12323)", () => {
  it("ignores a request for another project", async () => {
    projectState.currentProject = { id: "other", path: "/x" };
    main.push(PUSH_CHANNELS.recoverDraft, { requestId: "r1", identity: IDENTITY });
    await flush();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("opens the panel in Edit mode and acknowledges once the draft's own document is loaded", async () => {
    main.push(PUSH_CHANNELS.recoverDraft, { requestId: "r1", identity: IDENTITY });
    await flush();
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.openPanel",
      { path: IDENTITY.filePath, rootPath: IDENTITY.worktreePath },
      { source: "plugin" }
    );
    expect(setFileViewModeMock).toHaveBeenCalledWith("panel-9", "edit");
    expect(main.calls.some((c) => c.channel === CHANNELS.recoverAck)).toBe(false);

    // The editor's controller publishes the projection for the recovered identity.
    useFileDocumentStore.getState().setFileDocument("panel-9", {
      identityKey: identityKey(IDENTITY),
      draftText: "draft",
      dirty: true,
      conflict: false,
      save: async () => true,
      discard: async () => {},
    });
    await flush();
    expect(main.calls.filter((c) => c.channel === CHANNELS.recoverAck)).toEqual([
      { channel: CHANNELS.recoverAck, args: { requestId: "r1" } },
    ]);
  });

  it("does not acknowledge when the panel ended up on a different document", async () => {
    main.push(PUSH_CHANNELS.recoverDraft, { requestId: "r2", identity: IDENTITY });
    await flush();
    useFileDocumentStore.getState().setFileDocument("panel-9", {
      identityKey: identityKey({ ...IDENTITY, worktreePath: null }),
      draftText: null,
      dirty: false,
      conflict: false,
      save: async () => true,
      discard: async () => {},
    });
    await flush(6000);
    expect(main.calls.some((c) => c.channel === CHANNELS.recoverAck)).toBe(false);
  });

  it("handles each request once even when main retries the broadcast", async () => {
    main.push(PUSH_CHANNELS.recoverDraft, { requestId: "r3", identity: IDENTITY });
    main.push(PUSH_CHANNELS.recoverDraft, { requestId: "r3", identity: IDENTITY });
    await flush();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
