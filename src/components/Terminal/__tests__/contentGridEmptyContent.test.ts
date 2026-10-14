import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CONTEXT_PATH = resolve(__dirname, "../useContentGridContext.tsx");
const DEFAULT_PATH = resolve(__dirname, "../ContentGridDefault.tsx");
const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");

describe("ContentGrid emptyContent prop (issue #4254)", () => {
  it("renders emptyContent instead of EmptyState when provided", async () => {
    const content = await readFile(DEFAULT_PATH, "utf-8");
    // The grid should use nullish coalescing to prefer emptyContent over EmptyState
    expect(content).toContain("emptyContent ?? (");
    expect(content).toContain("<ContentGridEmptyState");
  });
});

describe("ContentGrid richer project identity (issue #7472)", () => {
  it("ContentGridContext populates project identity from current project and active worktree", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toContain("projectName: currentProject?.name ?? null");
    expect(content).toContain("projectEmoji: currentProject?.emoji ?? null");
    expect(content).toContain("activeWorktreePath: activeWorktree?.path ?? null");
  });

  // Both grids thread the workspace identity into the empty state; that the
  // empty state then renders name, branch and path is asserted by rendering in
  // ContentGridEmptyState.workspace.test.tsx rather than by matching prop
  // spelling here (a rename would otherwise force a tautological edit).

  it("ContentGridEmptyState formats path via shared utilities and useHomeDir", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('from "@/hooks/app/useHomeDir"');
    expect(content).toMatch(/formatPath, middleTruncatePath[^}]*\} from "@\/utils\/textParsing"/);
    expect(content).toContain("useHomeDir()");
    expect(content).toContain("formatPath(activeWorktreePath, homeDir)");
    expect(content).toContain("middleTruncatePath(");
  });

  it("ContentGridEmptyState handles detached HEAD with the commit glyph the toolbar pill uses", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("detached at ");
    expect(content).toContain("shortSha(activeWorktreeHead)");
    expect(content).toMatch(/isDetachedLabel \? GitCommitHorizontal : GitBranch/);
    expect(content).toContain("<BranchGlyph ");
  });
});
