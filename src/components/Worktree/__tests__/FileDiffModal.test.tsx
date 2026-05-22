// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GitStatus } from "@shared/types";
import { FileDiffModal } from "../FileDiffModal";

// Capture the `diff` prop the lazy FileViewerModal receives so we can assert
// what `fetchDiff` resolves to for each dispatch outcome.
const { mockDispatch, capturedProps } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  capturedProps: { diff: undefined as string | undefined },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

vi.mock("@/components/FileViewer/FileViewerModal", () => ({
  FileViewerModal: (props: { diff?: string }) => {
    capturedProps.diff = props.diff;
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
    mockDispatch.mockReset();
    capturedProps.diff = undefined;
  });

  it("unwraps the { content } envelope and passes the diff string to the viewer", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "git.getFileDiff",
      { cwd: "/repo", filePath: "src/index.ts", status: "modified" },
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
});
