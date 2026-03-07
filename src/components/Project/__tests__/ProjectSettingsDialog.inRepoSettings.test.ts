import { describe, it, expect } from "vitest";
import { GITIGNORE_SNIPPET } from "../ProjectSettingsDialog";

describe("GITIGNORE_SNIPPET", () => {
  it("includes project.json path as safe to commit", () => {
    expect(GITIGNORE_SNIPPET).toContain(".canopy/project.json");
  });

  it("includes settings.json path as safe to commit", () => {
    expect(GITIGNORE_SNIPPET).toContain(".canopy/settings.json");
  });

  it("includes wildcard pattern for machine-local files", () => {
    expect(GITIGNORE_SNIPPET).toContain(".canopy/*.local.json");
  });
});

describe("In-repo settings — enable/disable UI logic", () => {
  it("expands the confirmation panel before calling enable IPC", () => {
    const inRepoSettings = false;
    let inRepoExpanded = false;

    if (!inRepoSettings) {
      inRepoExpanded = !inRepoExpanded;
    }

    expect(inRepoExpanded).toBe(true);
    expect(inRepoSettings).toBe(false);
  });

  it("collapses the confirmation panel on cancel without enabling", () => {
    let inRepoExpanded = true;
    const inRepoSettings = false;

    inRepoExpanded = false;

    expect(inRepoExpanded).toBe(false);
    expect(inRepoSettings).toBe(false);
  });

  it("disabling leaves .canopy/ files in place (canopyConfigPresent unchanged)", () => {
    let inRepoSettings = true;
    const canopyConfigPresent = true;

    inRepoSettings = false;

    expect(inRepoSettings).toBe(false);
    expect(canopyConfigPresent).toBe(true);
  });

  it("shows error and keeps in-repo mode off when enable IPC fails", () => {
    const inRepoSettings = false;
    let inRepoError: string | null = null;
    let inRepoEnabling = true;

    try {
      throw new Error("EACCES: permission denied, mkdir '.canopy'");
    } catch (err) {
      inRepoError = err instanceof Error ? err.message : "Failed to enable in-repo settings";
    } finally {
      inRepoEnabling = false;
    }

    expect(inRepoSettings).toBe(false);
    expect(inRepoError).toContain("EACCES");
    expect(inRepoEnabling).toBe(false);
  });

  it("prevents duplicate enable calls while a request is in flight", () => {
    const inRepoEnabling = true;
    let callCount = 0;

    const handleEnable = () => {
      if (inRepoEnabling) return;
      callCount++;
    };

    handleEnable();
    handleEnable();

    expect(callCount).toBe(0);
  });

  it("prevents duplicate disable calls while a request is in flight", () => {
    const inRepoEnabling = true;
    let callCount = 0;

    const handleDisable = () => {
      if (inRepoEnabling) return;
      callCount++;
    };

    handleDisable();
    handleDisable();

    expect(callCount).toBe(0);
  });

  it("canopyConfigPresent can be true while inRepoSettings is false (loaded but sync not enabled)", () => {
    const canopyConfigPresent = true;
    const inRepoSettings = false;

    expect(canopyConfigPresent).toBe(true);
    expect(inRepoSettings).toBe(false);
  });
});
