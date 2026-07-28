import { describe, it, expect } from "vitest";
import { KeybindingContributionSchema } from "../plugin.js";

const base = { actionId: "acme.plugin.action", combo: "Cmd+Shift+9" };

function scopeError(scope: string): string | undefined {
  const result = KeybindingContributionSchema.safeParse({ ...base, scope });
  if (result.success) return undefined;
  return result.error.issues.map((i) => i.message).join("\n");
}

describe("KeybindingContributionSchema scope", () => {
  it("accepts every live scope and an omitted one", () => {
    expect(KeybindingContributionSchema.safeParse(base).success).toBe(true);
    for (const scope of ["global", "portal", "worktreeGrid", "dev-preview"]) {
      expect(KeybindingContributionSchema.safeParse({ ...base, scope }).success).toBe(true);
    }
  });

  it("rejects the removed scopes with migration hints", () => {
    expect(scopeError("terminal")).toContain('when: "terminalFocused"');
    expect(scopeError("modal")).toContain('when: "modalOpen"');
    expect(scopeError("worktreeList")).toContain("not bindable");
  });

  it("rejects unknown scopes with the default enum error", () => {
    const message = scopeError("galaxy");
    expect(message).toBeDefined();
    expect(message).not.toContain("was removed");
  });
});
