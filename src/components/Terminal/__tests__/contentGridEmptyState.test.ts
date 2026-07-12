import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const EMPTY_STATE_PATH = resolve(__dirname, "../ContentGridEmptyState.tsx");

describe("ContentGrid EmptyState — RecipeRunner integration", () => {
  it("identity is a centered stacked hero — mark above the name, one alignment axis", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    // Centered identity block…
    expect(content).toContain('"mb-6 flex flex-col items-center text-center"');
    // …with the mark stacked above the name (no left-aligned lockup, no
    // gear-overlaid logo wrapper from the pre-redesign layout)…
    expect(content).toContain("identityMark");
    expect(content).not.toContain('"relative group mb-4"');
    // …and no floating canvas watermark layer (it read as misplaced).
    expect(content).not.toContain("pointer-events-none absolute");
    // A near-invisible color-alpha mark must not return — the
    // `prefers-contrast: more` rescue rule for `text-daintree-text/*` forces
    // sub-0.1 alphas to a fully opaque silhouette. (The hero mark rides the
    // neutral `tint` idiom instead.)
    expect(content).not.toContain("text-daintree-text/[0");
  });

  it("renders RecipeRunner component instead of inline recipe list", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("<RecipeRunner");
    expect(content).toContain('from "./RecipeRunner/RecipeRunner"');
    expect(content).not.toContain('role="list"');
    expect(content).not.toContain("handleRunRecipe");
  });

  it("derives hasEverLaunchedAgent from the panel store to gate teaching content", async () => {
    // RecipeRunner itself is deliberately NOT gated on hasEverLaunchedAgent
    // (recipes are the launcher hero; see the CLAUDE.md recipe-gating gotcha) —
    // the flag only gates teaching content like RotatingTip.
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("hasEverLaunchedAgent");
    expect(content).toContain("usePanelStore");
  });

  // The gating behaviour these once asserted against the source text now lives in
  // ContentGridEmptyState.workspace.test.tsx, which renders the component: tips
  // wait for the first launch (#6752) and are withheld from scratches entirely.
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
  });

  it("drops the three-row ResumeSessionsCard entirely", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).not.toContain("ResumeSessionsCard");
  });
});

describe("ContentGrid EmptyState — quiet no-worktree variants (issue #6935)", () => {
  it("accepts a hasWorktrees prop alongside the launch-target gate", async () => {
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

  // The identity hero is gated on having a launch target — asserted by rendering
  // in ContentGridEmptyState.workspace.test.tsx rather than by matching source.
});

describe("ContentGrid EmptyState — initialization gate (issue #8645)", () => {
  it("accepts isWorktreeInitialized prop", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    expect(content).toContain("isWorktreeInitialized: boolean");
  });

  // The cold-start flash guard (silent until initialized, then the right copy
  // variant) is asserted by rendering in ContentGridEmptyState.workspace.test.tsx.

  it("does not render bare <p> with text-daintree-text/60 in the no-worktree branch", async () => {
    const content = await readFile(EMPTY_STATE_PATH, "utf-8");
    // The old bare <p> with diluted text color is gone — replaced by EmptyState
    const lines = content.split("\n");
    const noWorktreeSection = lines.filter(
      (line) => !line.includes("hasLaunchTarget") || line.includes("!hasLaunchTarget")
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
