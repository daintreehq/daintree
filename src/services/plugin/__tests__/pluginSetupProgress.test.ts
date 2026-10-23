import { describe, expect, it } from "vitest";
import type { PluginSetupStepUiStatus } from "@shared/types/plugin";
import { buildPluginWhenContext } from "@shared/utils/pluginContextKeys";
import { resolvePluginSetupProgress } from "../pluginSetupProgress";

function step(
  id: string,
  check: PluginSetupStepUiStatus["check"],
  skipped = false
): PluginSetupStepUiStatus {
  return { id, title: id, description: null, check, action: null, skipped };
}

describe("resolvePluginSetupProgress (#13824)", () => {
  it("takes main's answer for observed steps and evaluates context steps here", () => {
    const steps = [
      step("connect", { kind: "observed", done: true }),
      step("team", { kind: "observed", done: false }),
      step("sync", { kind: "context", when: "acme.tracker.synced" }),
    ];

    const before = resolvePluginSetupProgress(steps, buildPluginWhenContext({}));
    expect(before.rows.map((row) => row.done)).toEqual([true, false, false]);
    expect(before).toMatchObject({ handled: 1, total: 3 });

    const after = resolvePluginSetupProgress(
      steps,
      buildPluginWhenContext({ "acme.tracker": { synced: true } })
    );
    expect(after.rows.map((row) => row.done)).toEqual([true, false, true]);
    expect(after.handled).toBe(2);
  });

  it("counts a skipped step as handled without calling it done", () => {
    const progress = resolvePluginSetupProgress(
      [step("team", { kind: "observed", done: false }, true)],
      {}
    );
    expect(progress.rows[0]?.done).toBe(false);
    expect(progress).toMatchObject({ handled: 1, total: 1 });
  });

  it("never treats a clause that doesn't parse as done", () => {
    const progress = resolvePluginSetupProgress(
      [step("sync", { kind: "context", when: "acme.tracker.synced &&" })],
      buildPluginWhenContext({ "acme.tracker": { synced: true } })
    );
    expect(progress.rows[0]?.done).toBe(false);
  });
});
