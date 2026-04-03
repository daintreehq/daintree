import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const HOOK_PATH = resolve(__dirname, "../useActiveWorktreeSync.ts");

describe("useActiveWorktreeSync homeDir fallback (issue #4254)", () => {
  it("imports useHomeDir", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain('import { useHomeDir } from "@/hooks/app/useHomeDir"');
  });

  it("calls useHomeDir inside the hook", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("const { homeDir } = useHomeDir()");
  });

  it("uses homeDir as fallback before empty string in defaultTerminalCwd", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    // When initialized: worktree path → project path → homeDir → ""
    expect(content).toContain('activeWorktree?.path ?? currentProject?.path ?? homeDir ?? ""');
    // When not initialized: project path → homeDir → "" (skips worktree which hasn't loaded)
    expect(content).toContain('currentProject?.path ?? homeDir ?? ""');
  });

  it("gates defaultTerminalCwd on isInitialized to prevent race condition", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("isInitialized");
    expect(content).toContain("const { worktrees, isInitialized } = useWorktrees()");
  });

  it("includes homeDir and isInitialized in useMemo dependency array", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("[activeWorktree, currentProject, homeDir, isInitialized]");
  });
});
