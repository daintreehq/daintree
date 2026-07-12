import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const GRID_PATH = resolve(__dirname, "../ContentGrid.tsx");
const CONTEXT_PATH = resolve(__dirname, "../useContentGridContext.tsx");
const DEFAULT_PATH = resolve(__dirname, "../ContentGridDefault.tsx");
const FLEET_PATH = resolve(__dirname, "../ContentGridFleetScope.tsx");
const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");

describe("ContentGrid emptyContent prop (issue #4254)", () => {
  it("ContentGridProps includes emptyContent prop", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toContain("emptyContent?: React.ReactNode");
  });

  it("renders emptyContent instead of EmptyState when provided", async () => {
    const content = await readFile(DEFAULT_PATH, "utf-8");
    // The grid should use nullish coalescing to prefer emptyContent over EmptyState
    expect(content).toContain("emptyContent ?? (");
    expect(content).toContain("<ContentGridEmptyState");
  });

  it("destructures emptyContent from props", async () => {
    const content = await readFile(GRID_PATH, "utf-8");
    expect(content).toMatch(/\{\s*className.*emptyContent.*\}\s*:\s*ContentGridProps/s);
  });
});

describe("ContentGrid richer project identity (issue #7472)", () => {
  it("ContentGridContext exposes project identity fields", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toContain("projectName: string | null");
    expect(content).toContain("projectEmoji: string | null");
    expect(content).toContain("activeWorktreeBranch: string | null");
    expect(content).toContain("activeWorktreeIsDetached: boolean");
    expect(content).toContain("activeWorktreeHead: string | null");
    expect(content).toContain("activeWorktreePath: string | null");
  });

  it("ContentGridContext populates project identity from current project and active worktree", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toContain("projectName: currentProject?.name ?? null");
    expect(content).toContain("projectEmoji: currentProject?.emoji ?? null");
    expect(content).toContain("activeWorktreePath: activeWorktree?.path ?? null");
  });

  it("ContentGridDefault threads project identity props to empty state", async () => {
    const content = await readFile(DEFAULT_PATH, "utf-8");
    expect(content).toContain("workspaceName={ctx.projectName}");
    expect(content).toContain("projectEmoji={ctx.projectEmoji}");
    expect(content).toContain("activeWorktreeBranch={ctx.activeWorktreeBranch}");
    expect(content).toContain("activeWorktreePath={ctx.activeWorktreePath}");
  });

  it("ContentGridFleetScope threads project identity props to empty state", async () => {
    const content = await readFile(FLEET_PATH, "utf-8");
    expect(content).toContain("workspaceName={ctx.projectName}");
    expect(content).toContain("activeWorktreeBranch={ctx.activeWorktreeBranch}");
    expect(content).toContain("activeWorktreePath={ctx.activeWorktreePath}");
  });

  it("ContentGridEmptyState formats path via shared utilities and useHomeDir", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('from "@/hooks/app/useHomeDir"');
    expect(content).toContain('formatPath, middleTruncate } from "@/utils/textParsing"');
    expect(content).toContain("useHomeDir()");
    expect(content).toContain("formatPath(activeWorktreePath, homeDir)");
    expect(content).toContain("middleTruncate(");
  });

  it("ContentGridEmptyState handles detached HEAD and surfaces the branch chip", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("detached at ");
    expect(content).toContain("activeWorktreeHead.slice(0, 7)");
    expect(content).toMatch(/import \{ .*GitBranch, Settings \} from "lucide-react"/);
    expect(content).toContain("<GitBranch ");
  });
});

describe("ContentGridEmptyState surfaces recipes pre-agent-launch (issue #8086)", () => {
  it("RecipeRunner is gated on the recipe store binding, not hasEverLaunchedAgent", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    // The previous double-gate that hid RecipeRunner until an agent had launched
    // must no longer apply to RecipeRunner. (That recipes appear on first run,
    // and wait for the store to settle, is asserted by rendering in
    // ContentGridEmptyState.workspace.test.tsx.)
    expect(content).not.toMatch(/hasEverLaunchedAgent && \(\s*<div[^>]*>\s*<RecipeRunner /);
  });

  it("subscribes to the recipe store for both projectId and loading state", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('from "@/store/recipeStore"');
    expect(content).toContain("useRecipeStore((state) => state.currentProjectId)");
    // The isLoading guard closes the flash window that opens between the
    // synchronous `set({ currentProjectId })` and the async recipe arrival.
    expect(content).toContain("useRecipeStore((state) => state.isLoading)");
  });
});
