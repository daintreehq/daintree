import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";
import {
  PLUGIN_WORKTREE_SETUP_STEP_LABEL_MAX,
  PLUGIN_WORKTREE_SETUP_STEP_MAX_TIMEOUT_MS,
  PLUGIN_WORKTREE_SETUP_STEP_MIN_TIMEOUT_MS,
  type PluginOrigin,
} from "../../../shared/types/plugin.js";

function parse(worktreeSetupSteps: unknown, origin: PluginOrigin = "user") {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.db",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: { worktreeSetupSteps },
  });
}

const PROVISION = { id: "provision-db", label: "Provision DB", timeoutMs: 120_000 };

describe("contributes.worktreeSetupSteps schema (#13807)", () => {
  it("accepts a step, leaves an undeclared timeout to the host default, and defaults to none", () => {
    expect(parse([PROVISION]).success).toBe(true);

    const noTimeout = parse([{ id: "seed", label: "Seed fixtures" }]);
    expect(noTimeout.success && noTimeout.data.contributes.worktreeSetupSteps).toEqual([
      { id: "seed", label: "Seed fixtures" },
    ]);

    const bare = getPluginManifestSchema("user").safeParse({ name: "acme.t", version: "1.0.0" });
    expect(bare.success && bare.data.contributes.worktreeSetupSteps).toEqual([]);
  });

  it("is available to a project plugin, which runs it for its own project", () => {
    expect(parse([PROVISION], "project").success).toBe(true);
  });

  it("rejects a timeout outside the bounds, or a fractional one", () => {
    expect(
      parse([{ ...PROVISION, timeoutMs: PLUGIN_WORKTREE_SETUP_STEP_MIN_TIMEOUT_MS - 1 }]).success
    ).toBe(false);
    expect(
      parse([{ ...PROVISION, timeoutMs: PLUGIN_WORKTREE_SETUP_STEP_MAX_TIMEOUT_MS + 1 }]).success
    ).toBe(false);
    expect(parse([{ ...PROVISION, timeoutMs: 1_500.5 }]).success).toBe(false);
  });

  it("rejects a blank or overlong label", () => {
    expect(parse([{ ...PROVISION, label: "   " }]).success).toBe(false);
    expect(
      parse([{ ...PROVISION, label: "x".repeat(PLUGIN_WORKTREE_SETUP_STEP_LABEL_MAX + 1) }]).success
    ).toBe(false);
  });

  it("rejects duplicate ids, unknown fields and more steps than the cap", () => {
    expect(parse([PROVISION, { ...PROVISION, label: "Again" }]).success).toBe(false);
    expect(parse([{ ...PROVISION, command: "make db" }]).success).toBe(false);
    const tooMany = Array.from(
      { length: MANIFEST_CONTRIBUTION_CAPS.worktreeSetupSteps + 1 },
      (_, i) => ({
        id: `step-${i}`,
        label: `Step ${i}`,
      })
    );
    expect(parse(tooMany).success).toBe(false);
  });
});
