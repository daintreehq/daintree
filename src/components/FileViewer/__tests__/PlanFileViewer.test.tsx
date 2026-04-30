// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { PlanFileViewer } from "../PlanFileViewer";

vi.mock("@/components/ui/AppDialog", () => {
  interface MockProps {
    isOpen: boolean;
    children: ReactNode;
    onClose: () => void;
  }
  interface SectionProps {
    children: ReactNode;
    className?: string;
  }

  const AppDialog = ({ isOpen, children }: MockProps) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;

  AppDialog.Header = ({ children, className }: SectionProps) => (
    <div className={className}>{children}</div>
  );
  AppDialog.Title = ({ children, className }: SectionProps) => (
    <h2 className={className}>{children}</h2>
  );
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.BodyScroll = ({ children, className }: SectionProps) => (
    <div className={className}>{children}</div>
  );

  return { AppDialog };
});

vi.mock("../CodeViewer", () => ({
  CodeViewer: ({ content }: { content: string; filePath: string; className?: string }) => (
    <div data-testid="code-viewer">{content}</div>
  ),
}));

const mockRead = vi.fn();
vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: (...args: unknown[]) => mockRead(...args),
  },
}));

describe("PlanFileViewer", () => {
  beforeEach(() => {
    mockRead.mockReset();
  });

  it("does not render dialog content when isOpen is false", () => {
    render(
      <PlanFileViewer isOpen={false} filePath="TODO.md" rootPath="/project" onClose={() => {}} />
    );
    expect(screen.queryByTestId("app-dialog")).toBeNull();
  });

  it("renders empty state when filePath is undefined", () => {
    render(
      <PlanFileViewer isOpen={true} filePath={undefined} rootPath="/project" onClose={() => {}} />
    );
    expect(screen.getByText(/No plan file found in this worktree/)).toBeDefined();
  });

  it("shows loading state initially when filePath is provided", () => {
    mockRead.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <PlanFileViewer isOpen={true} filePath="TODO.md" rootPath="/project" onClose={() => {}} />
    );
    expect(screen.getByText(/Loading plan/)).toBeDefined();
  });

  it("renders file content in CodeViewer after successful read", async () => {
    mockRead.mockResolvedValue({ content: "# My Plan\n- step 1" });

    render(
      <PlanFileViewer isOpen={true} filePath="TODO.md" rootPath="/project" onClose={() => {}} />
    );

    await waitFor(() => {
      const viewer = screen.getByTestId("code-viewer");
      expect(viewer).toBeDefined();
      expect(viewer.textContent).toContain("# My Plan");
      expect(viewer.textContent).toContain("- step 1");
    });
  });

  it("shows generic error state when read fails with non-NOT_FOUND code", async () => {
    mockRead.mockRejectedValue(
      Object.assign(new Error("File too large"), { name: "AppError", code: "FILE_TOO_LARGE" })
    );

    render(
      <PlanFileViewer isOpen={true} filePath="TODO.md" rootPath="/project" onClose={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Plan file could not be read/)).toBeDefined();
    });
  });

  it("shows empty state (not error) when NOT_FOUND is returned — plan file was deleted", async () => {
    mockRead.mockRejectedValue(
      Object.assign(new Error("File not found"), { name: "AppError", code: "NOT_FOUND" })
    );

    render(
      <PlanFileViewer isOpen={true} filePath="TODO.md" rootPath="/project" onClose={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getByText(/No plan file found in this worktree/)).toBeDefined();
    });
    expect(screen.queryByText(/Plan file could not be read/)).toBeNull();
  });

  it("shows the filename in the dialog title", async () => {
    mockRead.mockResolvedValue({ content: "content" });

    render(
      <PlanFileViewer isOpen={true} filePath="PLAN.md" rootPath="/project" onClose={() => {}} />
    );

    expect(screen.getByText("PLAN.md")).toBeDefined();
  });
});
