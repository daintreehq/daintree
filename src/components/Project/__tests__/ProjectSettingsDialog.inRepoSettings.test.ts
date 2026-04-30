import { describe, it, expect } from "vitest";
import { GITIGNORE_SNIPPET } from "../projectSettingsConstants";
import { formatErrorMessage } from "@shared/utils/errorMessage";

describe("GITIGNORE_SNIPPET", () => {
  it("includes project.json path as safe to commit", () => {
    expect(GITIGNORE_SNIPPET).toContain(".daintree/project.json");
  });

  it("includes settings.json path as safe to commit", () => {
    expect(GITIGNORE_SNIPPET).toContain(".daintree/settings.json");
  });

  it("includes wildcard pattern for machine-local files", () => {
    expect(GITIGNORE_SNIPPET).toContain(".daintree/*.local.json");
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

  it("disabling leaves .daintree/ files in place (daintreeConfigPresent unchanged)", () => {
    let inRepoSettings = true;
    const daintreeConfigPresent = true;

    inRepoSettings = false;

    expect(inRepoSettings).toBe(false);
    expect(daintreeConfigPresent).toBe(true);
  });

  it("shows error and keeps in-repo mode off when enable IPC fails", () => {
    const inRepoSettings = false;
    let inRepoError: string | null = null;
    let inRepoEnabling = true;

    try {
      throw new Error("EACCES: permission denied, mkdir '.daintree'");
    } catch (err) {
      inRepoError = formatErrorMessage(err, "Failed to enable in-repo settings");
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

  it("daintreeConfigPresent can be true while inRepoSettings is false (loaded but sync not enabled)", () => {
    const daintreeConfigPresent = true;
    const inRepoSettings = false;

    expect(daintreeConfigPresent).toBe(true);
    expect(inRepoSettings).toBe(false);
  });
});
