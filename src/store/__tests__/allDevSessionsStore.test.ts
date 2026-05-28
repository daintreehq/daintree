import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import {
  acquireAllDevSessions,
  useAllDevSessionsStore,
  _resetAllDevSessionsForTests,
} from "../allDevSessionsStore";

function makeSession(overrides: Partial<DevPreviewSessionState> = {}): DevPreviewSessionState {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    worktreeId: "wt-1",
    status: "running",
    url: "http://localhost:3000",
    predictedUrl: "http://localhost:3000",
    error: null,
    terminalId: "t-1",
    isRestarting: false,
    generation: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let pushCallback: ((payload: { sessions: DevPreviewSessionState[] }) => void) | null;
let unsubscribe: ReturnType<typeof vi.fn>;
let onAllSessionsChanged: ReturnType<typeof vi.fn>;
let getAllSessions: ReturnType<typeof vi.fn>;
let resolveGetAll: (value: DevPreviewSessionState[]) => void;

beforeEach(() => {
  pushCallback = null;
  unsubscribe = vi.fn();
  onAllSessionsChanged = vi.fn((cb: (payload: { sessions: DevPreviewSessionState[] }) => void) => {
    pushCallback = cb;
    return unsubscribe;
  });
  getAllSessions = vi.fn(
    () =>
      new Promise<DevPreviewSessionState[]>((resolve) => {
        resolveGetAll = resolve;
      })
  );
  (globalThis as unknown as { window: unknown }).window = {
    electron: { devPreview: { getAllSessions, onAllSessionsChanged } },
  };
});

afterEach(() => {
  _resetAllDevSessionsForTests();
  vi.restoreAllMocks();
});

describe("allDevSessionsStore", () => {
  it("hydrates from getAllSessions on first acquire", async () => {
    acquireAllDevSessions();
    expect(getAllSessions).toHaveBeenCalledTimes(1);
    expect(onAllSessionsChanged).toHaveBeenCalledTimes(1);

    resolveGetAll([makeSession()]);
    await vi.waitFor(() => {
      expect(useAllDevSessionsStore.getState().hydrated).toBe(true);
    });
    expect(useAllDevSessionsStore.getState().sessions).toHaveLength(1);
  });

  it("applies pushed snapshots", async () => {
    acquireAllDevSessions();
    resolveGetAll([]);
    await vi.waitFor(() => expect(useAllDevSessionsStore.getState().hydrated).toBe(true));

    pushCallback?.({ sessions: [makeSession({ panelId: "panel-9" })] });
    expect(useAllDevSessionsStore.getState().sessions[0]?.panelId).toBe("panel-9");
  });

  it("keeps a single subscription across overlapping acquires (StrictMode)", () => {
    const release1 = acquireAllDevSessions();
    const release2 = acquireAllDevSessions();
    expect(onAllSessionsChanged).toHaveBeenCalledTimes(1);
    expect(getAllSessions).toHaveBeenCalledTimes(1);

    release1();
    expect(unsubscribe).not.toHaveBeenCalled();

    release2();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores a hydrate that resolves after teardown", async () => {
    const release = acquireAllDevSessions();
    release();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    resolveGetAll([makeSession()]);
    await Promise.resolve();
    await Promise.resolve();

    expect(useAllDevSessionsStore.getState().sessions).toHaveLength(0);
    expect(useAllDevSessionsStore.getState().hydrated).toBe(false);
  });

  it("is idempotent when a release fires twice", () => {
    const release = acquireAllDevSessions();
    release();
    release();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
