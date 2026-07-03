import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");

describe("ContentGrid EmptyState — RecipeRunner integration", () => {
  it("identity hero stays compact and drops the large solid logo for a faded watermark", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    // Compact centered identity line retained…
    expect(content).toContain('"mb-6 flex flex-col items-center text-center"');
    // …but the large solid project logo block is gone, replaced by a
    // heavily-faded, non-interactive backdrop mark.
    expect(content).not.toContain('"relative group mb-4"');
    // Correctness invariant (not cosmetics): the backdrop mark is
    // non-interactive so it can never intercept launcher clicks.
    expect(content).toContain("pointer-events-none absolute inset-0");
  });

  it("renders RecipeRunner component instead of inline recipe list", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("<RecipeRunner");
    expect(content).toContain('from "./RecipeRunner/RecipeRunner"');
    expect(content).not.toContain('role="list"');
    expect(content).not.toContain("handleRunRecipe");
  });

  it("gates RecipeRunner on hasEverLaunchedAgent so first-run users don't see it", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("hasEverLaunchedAgent");
    expect(content).toContain("usePanelStore");
    expect(content).toContain("hasActiveWorktree && hasEverLaunchedAgent");
  });

  it("gates RotatingTip on hasEverLaunchedAgent — teaching content waits until after first launch", async () => {
    // Issue #6752 — first-run users (no agent ever launched) shouldn't see
    // shortcut-carousel teaching content. Returning users still see the
    // count-biased rotation polished by issue #6756.
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("<RotatingTip />");
    expect(content).toMatch(/hasActiveWorktree && hasEverLaunchedAgent &&[\s\S]*?<RotatingTip \/>/);
  });
});

describe("ContentGrid EmptyState — recipe-forward launcher composition", () => {
  it("composes recipes (hero), a single-line resume, and quick-launch actions", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("<RecipeRunner");
    expect(content).toContain("<ResumeSessionLine />");
    expect(content).toContain('from "./ResumeSessionLine"');
    expect(content).toContain("<LauncherQuickActions />");
    expect(content).toContain('from "./LauncherQuickActions"');
  });

  it("renders the project pulse as a collapsible strip, not the full always-open card", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("<ProjectPulseStrip");
    expect(content).not.toContain("<ProjectPulseCard");
    // Still honors the user's Settings hide toggle.
    expect(content).toContain("showProjectPulse && hasActiveWorktree && activeWorktreeId");
  });

  it("drops the three-row ResumeSessionsCard entirely", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).not.toContain("ResumeSessionsCard");
  });
});

describe("ContentGrid EmptyState — quiet no-worktree variants (issue #6935)", () => {
  it("accepts a hasWorktrees prop alongside hasActiveWorktree", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("hasWorktrees: boolean");
    expect(content).toMatch(/hasWorktrees,\s*\n/);
  });

  it("drops the AlertTriangle warning pill and View documentation CTA", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).not.toContain("AlertTriangle");
    expect(content).not.toContain("View documentation");
    expect(content).not.toContain("status-warning");
    expect(content).not.toContain("handleOpenHelp");
  });

  it("renders structured EmptyState with role=status / aria-live=polite for both empty variants", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('variant="zero-data"');
    expect(content).toContain('scale="canvas"');
    expect(content).toContain("<EmptyState");
  });

  it("branches empty state on hasWorktrees: select-worktree vs open-directory with button", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("Select a worktree");
    expect(content).toContain("Choose a worktree from the sidebar to open it in the canvas");
    expect(content).toContain("Open a project folder");
    expect(content).toContain("Worktrees let you work on multiple tasks in isolated environments");
    expect(content).toContain("Open folder…");
    expect(content).toContain('"project.add"');
  });

  it("gates the project-icon hero on hasActiveWorktree so empty states stay silent", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toMatch(
      /\{hasActiveWorktree && \(\s*\n\s*<div className="mb-6 flex flex-col items-center text-center"/
    );
  });
});

describe("ContentGrid EmptyState — initialization gate (issue #8645)", () => {
  it("accepts isWorktreeInitialized prop", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("isWorktreeInitialized: boolean");
  });

  it("guards no-worktree branch on isWorktreeInitialized to prevent cold-start copy flash", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("!hasActiveWorktree && !isWorktreeInitialized");
    expect(content).toContain("!hasActiveWorktree && isWorktreeInitialized && hasWorktrees");
    expect(content).toContain("!hasActiveWorktree && isWorktreeInitialized && !hasWorktrees");
  });

  it("does not render bare <p> with text-daintree-text/60 in the no-worktree branch", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    // The old bare <p> with diluted text color is gone — replaced by EmptyState
    const lines = content.split("\n");
    const noWorktreeSection = lines.filter(
      (line) => !line.includes("hasActiveWorktree") || line.includes("!hasActiveWorktree")
    );
    const hasOldPattern = noWorktreeSection.some(
      (line) =>
        line.includes("<p") && line.includes("text-daintree-text/60") && line.includes("max-w-md")
    );
    expect(hasOldPattern).toBe(false);
  });
});

describe("ContentGrid EmptyState — structured empty state integration (issue #8645)", () => {
  it("imports EmptyState, Button, FolderOpen, and actionService", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('from "@/components/ui/EmptyState"');
    expect(content).toContain('from "@/components/ui/button"');
    expect(content).toContain('from "@/services/ActionService"');
    expect(content).toContain("FolderOpen");
  });

  it("renders Button variant=outline size=sm for opening a directory", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('variant="outline"');
    expect(content).toContain('size="sm"');
    expect(content).toContain("Open folder…");
  });

  it("dispatches project.add via actionService with source: user", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain('actionService.dispatch("project.add"');
    expect(content).toContain('source: "user"');
  });

  it("uses FolderOpen icon in both zero-data variants", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    // FolderOpen should appear in both EmptyState renders (hasWorktrees + !hasWorktrees)
    const folderOpenCount = (content.match(/<FolderOpen \/>/g) || []).length;
    expect(folderOpenCount).toBe(2);
  });
});
