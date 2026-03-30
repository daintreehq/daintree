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
    // The fallback chain should be: worktree path → project path → homeDir → ""
    expect(content).toContain('activeWorktree?.path ?? currentProject?.path ?? homeDir ?? ""');
  });

  it("includes homeDir in useMemo dependency array", async () => {
    const content = await readFile(HOOK_PATH, "utf-8");
    expect(content).toContain("[activeWorktree, currentProject, homeDir]");
  });
});
