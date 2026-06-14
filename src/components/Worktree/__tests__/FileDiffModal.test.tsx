// @vitest-environment jsdom
import { render, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GitStatus } from "@shared/types";
import { FileDiffModal, _resetDiffCacheForTests } from "../FileDiffModal";
import { usePreferencesStore } from "@/store/preferencesStore";

// Capture the `diff` prop the lazy FileViewerModal receives so we can assert
// what `fetchDiff` resolves to for each dispatch outcome.
const { mockDispatch, capturedProps } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  capturedProps: {
    diff: undefined as string | undefined,
    restoreFocusTo: undefined as unknown,
    currentFileIndex: undefined as number | undefined,
    totalFileCount: undefined as number | undefined,
    onNavigateFile: undefined as ((delta: -1 | 1) => void) | undefined,
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

vi.mock("@/components/FileViewer/FileViewerModal", () => ({
  FileViewerModal: (props: {
    diff?: string;
    restoreFocusTo?: unknown;
    currentFileIndex?: number;
    totalFileCount?: number;
    onNavigateFile?: (delta: -1 | 1) => void;
  }) => {
    capturedProps.diff = props.diff;
    capturedProps.restoreFocusTo = props.restoreFocusTo;
    capturedProps.currentFileIndex = props.currentFileIndex;
    capturedProps.totalFileCount = props.totalFileCount;
    capturedProps.onNavigateFile = props.onNavigateFile;
    return <div data-testid="file-viewer-modal-stub" />;
  },
}));

vi.mock("@/hooks/useBranchForPath", () => ({
  useBranchForPath: () => "main",
}));

const baseProps = {
  isOpen: true,
  filePath: "src/index.ts",
  status: "modified" as GitStatus,
  worktreePath: "/repo",
  onClose: vi.fn(),
};

describe("FileDiffModal", () => {
  beforeEach(() => {
    _resetDiffCacheForTests();
    mockDispatch.mockReset();
    capturedProps.diff = undefined;
    capturedProps.restoreFocusTo = undefined;
    capturedProps.currentFileIndex = undefined;
    capturedProps.totalFileCount = undefined;
    capturedProps.onNavigateFile = undefined;
  });

  it("unwraps the { content } envelope and passes the diff string to the viewer", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "git.getFileDiff",
      { cwd: "/repo", filePath: "src/index.ts", status: "modified", ignoreWhitespace: false },
      { source: "user" }
    );
  });

  it("maps empty content to the NO_CHANGES sentinel", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("NO_CHANGES");
    });
  });

  it("maps a failed dispatch to the ERROR sentinel", async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("ERROR");
    });
  });

  it("maps a thrown dispatch error to the ERROR sentinel", async () => {
    mockDispatch.mockRejectedValue(new Error("boom"));
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("ERROR");
    });
  });

  it("threads focus-restore and file-stepping props through to the viewer (#9217)", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const ref = { current: document.createElement("div") };
    const onNavigateFile = vi.fn();
    render(
      <FileDiffModal
        {...baseProps}
        restoreFocusTo={ref}
        currentFileIndex={2}
        totalFileCount={5}
        onNavigateFile={onNavigateFile}
      />
    );
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(capturedProps.restoreFocusTo).toBe(ref);
    expect(capturedProps.currentFileIndex).toBe(2);
    expect(capturedProps.totalFileCount).toBe(5);
    expect(capturedProps.onNavigateFile).toBe(onNavigateFile);
  });

  it("purges stale cache entries when the ignore-whitespace preference toggles", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    act(() => {
      usePreferencesStore.getState().setDiffIgnoreWhitespace(true);
    });
    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    // Toggling back must hit git again: the entry built without the flag was
    // purged on the first toggle, not kept warm in the cache.
    act(() => {
      usePreferencesStore.getState().setDiffIgnoreWhitespace(false);
    });
    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledTimes(3);
    });
    expect(mockDispatch).toHaveBeenLastCalledWith(
      "git.getFileDiff",
      { cwd: "/repo", filePath: "src/index.ts", status: "modified", ignoreWhitespace: false },
      { source: "user" }
    );
  });
});
