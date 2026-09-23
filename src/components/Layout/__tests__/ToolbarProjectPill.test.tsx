// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { activeWorkspaceIdentity, branchChipState } from "@/lib/workspaceIdentity";
import { ToolbarProjectPill } from "../ToolbarProjectPill";

type Case = {
  name: string;
  project?: { name: string; emoji: string; gitBacked?: boolean };
  scratch?: { name: string };
  branch?: string;
  detachedAt?: string;
};

const CASES: Case[] = [
  { name: "project on a branch", project: { name: "Daintree", emoji: "🌴" }, branch: "develop" },
  { name: "branch not yet arrived", project: { name: "Daintree", emoji: "🌴" } },
  {
    name: "detached HEAD",
    project: { name: "Daintree", emoji: "🌴" },
    detachedAt: "3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  },
  { name: "folder without git", project: { name: "Notes", emoji: "📝", gitBacked: false } },
  { name: "scratch", scratch: { name: "Scratch 3" } },
  { name: "nothing open" },
];

function renderCase(c: Case, open = false) {
  const identity = activeWorkspaceIdentity(c.project ?? null, c.scratch ?? null);
  const { container } = render(
    <ToolbarProjectPill
      workspaceIdentity={identity}
      emoji={c.project?.emoji}
      chipState={branchChipState(
        identity.kind,
        c.branch,
        c.project?.gitBacked ?? true,
        c.detachedAt !== undefined
      )}
      branchName={c.branch}
      headSha={c.detachedAt}
      isDropdownOpen={open}
    />
  );
  return {
    button: container.querySelector("button")!,
    chip: container.querySelector(".toolbar-project-chip"),
  };
}

describe("ToolbarProjectPill", () => {
  it("states its popup and open state in every stage, not only when a project is open", () => {
    for (const c of CASES) {
      for (const open of [false, true]) {
        const { button } = renderCase(c, open);
        expect(button.getAttribute("aria-haspopup"), c.name).toBeTruthy();
        expect(button.getAttribute("aria-expanded"), c.name).toBe(String(open));
      }
    }
  });

  it("never paints an empty slot: every mounted child carries content or a placeholder bone", () => {
    for (const c of CASES) {
      const { button } = renderCase(c);
      for (const child of Array.from(button.children)) {
        const hasText = (child.textContent ?? "").trim().length > 0;
        const isGlyph =
          child.tagName.toLowerCase() === "svg" || child.querySelector("svg") !== null;
        expect(hasText || isGlyph, `${c.name}: empty <${child.tagName}>`).toBe(true);
        expect(child.classList.contains("opacity-0"), `${c.name}: invisible child`).toBe(false);
      }
    }
  });

  it("shows the pending chip as a placeholder, hidden from assistive tech and carrying no branch", () => {
    const { chip } = renderCase(CASES[1]!);
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("aria-hidden")).toBe("true");
    expect((chip!.textContent ?? "").trim()).toBe("");
  });

  it("names a detached HEAD by its commit rather than waiting on a branch", () => {
    const { chip } = renderCase(CASES[2]!);
    expect(chip!.getAttribute("aria-hidden")).toBeNull();
    expect(chip!.textContent).toContain("3f9a2c1");
    expect(chip!.getAttribute("aria-label")).toContain("3f9a2c1");
  });

  it("mounts no chip where no branch can exist", () => {
    for (const c of CASES.slice(3)) {
      expect(renderCase(c).chip, c.name).toBeNull();
    }
  });
});
