/**
 * Tests for resetAllStoresForProjectSwitch with skipTerminalStateReset option (Issue #4427).
 *
 * Verifies that when skipTerminalStateReset is true, terminal state is preserved
 * while all other stores are reset and side-effects still run.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const detachTerminalsForProjectSwitchMock = vi.fn();
const resetWithoutKillingMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      resetWithoutKilling: resetWithoutKillingMock,
      detachTerminalsForProjectSwitch: detachTerminalsForProjectSwitchMock,
    }),
  },
}));

const worktreeResetMock = vi.fn();
vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({ reset: worktreeResetMock }),
  },
}));

const cleanupWorktreeDataStoreMock = vi.fn();
vi.mock("../worktreeDataStore", () => ({
  cleanupWorktreeDataStore: cleanupWorktreeDataStoreMock,
}));

const recipeResetMock = vi.fn();
vi.mock("../recipeStore", () => ({
  useRecipeStore: { getState: () => ({ reset: recipeResetMock }) },
}));

const logsResetMock = vi.fn();
vi.mock("../logsStore", () => ({
  useLogsStore: { getState: () => ({ reset: logsResetMock }) },
}));

const eventResetMock = vi.fn();
vi.mock("../eventStore", () => ({
  useEventStore: { getState: () => ({ reset: eventResetMock }) },
}));

const focusResetMock = vi.fn();
vi.mock("../focusStore", () => ({
  useFocusStore: { getState: () => ({ reset: focusResetMock }) },
}));

const diagnosticsResetMock = vi.fn();
vi.mock("../diagnosticsStore", () => ({
  useDiagnosticsStore: { getState: () => ({ reset: diagnosticsResetMock }) },
}));

const errorResetMock = vi.fn();
vi.mock("../errorStore", () => ({
  useErrorStore: { getState: () => ({ reset: errorResetMock }) },
}));

const notificationResetMock = vi.fn();
vi.mock("../notificationStore", () => ({
  useNotificationStore: { getState: () => ({ reset: notificationResetMock }) },
}));

const cleanupNotesStoreMock = vi.fn();
vi.mock("../notesStore", () => ({
  cleanupNotesStore: cleanupNotesStoreMock,
}));

const resetNoteSearchCacheMock = vi.fn();
vi.mock("@/hooks/useNoteSearch", () => ({
  resetNoteSearchCache: resetNoteSearchCacheMock,
}));

const resetGitHubFilterStoreMock = vi.fn();
vi.mock("../githubFilterStore", () => ({
  resetGitHubFilterStore: resetGitHubFilterStoreMock,
}));

const workflowResetMock = vi.fn();
vi.mock("../workflowStore", () => ({
  useWorkflowStore: { getState: () => ({ reset: workflowResetMock }) },
}));

const clearHistoryMock = vi.fn();
vi.mock("../layoutUndoStore", () => ({
  useLayoutUndoStore: { getState: () => ({ clearHistory: clearHistoryMock }) },
}));

const voiceSetStateMock = vi.fn();
vi.mock("../voiceRecordingStore", () => ({
  useVoiceRecordingStore: { setState: voiceSetStateMock },
}));

const invalidateBrandingCacheMock = vi.fn();
vi.mock("../../hooks/useProjectBranding", () => ({
  invalidateBrandingCache: invalidateBrandingCacheMock,
}));

const resetForProjectSwitchMock = vi.fn();
vi.mock("../terminalInputStore", () => ({
  useTerminalInputStore: {
    getState: () => ({ resetForProjectSwitch: resetForProjectSwitchMock }),
  },
}));

const { resetAllStoresForProjectSwitch } = await import("../resetStores");

describe("resetAllStoresForProjectSwitch with skipTerminalStateReset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls detachTerminalsForProjectSwitch instead of resetWithoutKilling when skip is true", async () => {
    await resetAllStoresForProjectSwitch({
      skipTerminalStateReset: true,
      outgoingProjectId: "proj-1",
    });

    expect(detachTerminalsForProjectSwitchMock).toHaveBeenCalledOnce();
    expect(resetWithoutKillingMock).not.toHaveBeenCalled();
  });

  it("calls resetWithoutKilling when skip is false (default)", async () => {
    await resetAllStoresForProjectSwitch({
      outgoingProjectId: "proj-1",
    });

    expect(resetWithoutKillingMock).toHaveBeenCalledOnce();
    expect(detachTerminalsForProjectSwitchMock).not.toHaveBeenCalled();
  });

  it("still resets all other stores when skipTerminalStateReset is true", async () => {
    await resetAllStoresForProjectSwitch({
      skipTerminalStateReset: true,
      outgoingProjectId: "proj-1",
    });

    // All non-terminal stores should still be reset
    expect(worktreeResetMock).toHaveBeenCalledOnce();
    expect(cleanupWorktreeDataStoreMock).toHaveBeenCalledOnce();
    expect(recipeResetMock).toHaveBeenCalledOnce();
    expect(logsResetMock).toHaveBeenCalledOnce();
    expect(eventResetMock).toHaveBeenCalledOnce();
    expect(focusResetMock).toHaveBeenCalledOnce();
    expect(diagnosticsResetMock).toHaveBeenCalledOnce();
    expect(errorResetMock).toHaveBeenCalledOnce();
    expect(notificationResetMock).toHaveBeenCalledOnce();
    expect(cleanupNotesStoreMock).toHaveBeenCalledOnce();
    expect(resetNoteSearchCacheMock).toHaveBeenCalledOnce();
    expect(resetGitHubFilterStoreMock).toHaveBeenCalledOnce();
    expect(workflowResetMock).toHaveBeenCalledOnce();
    expect(clearHistoryMock).toHaveBeenCalledOnce();
    expect(invalidateBrandingCacheMock).toHaveBeenCalledOnce();
  });

  it("still runs terminal input reset when outgoingProjectId is provided", async () => {
    await resetAllStoresForProjectSwitch({
      skipTerminalStateReset: true,
      outgoingProjectId: "proj-1",
      preserveTerminalIds: new Set(["t1"]),
    });

    expect(resetForProjectSwitchMock).toHaveBeenCalledWith("proj-1", new Set(["t1"]));
  });
});
