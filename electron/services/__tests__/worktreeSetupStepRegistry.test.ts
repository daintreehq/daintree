import { afterEach, describe, expect, it } from "vitest";
import {
  clearWorktreeSetupStepRegistry,
  getWorktreeSetupStepHandler,
  getWorktreeSetupSteps,
  isWorktreeSetupStepDeclared,
  registerWorktreeSetupStepHandler,
  registerWorktreeSetupSteps,
  unregisterWorktreeSetupStepHandler,
  unregisterWorktreeSetupStepHandlers,
  unregisterWorktreeSetupSteps,
} from "../worktreeSetupStepRegistry.js";
import { PLUGIN_WORKTREE_SETUP_STEP_DEFAULT_TIMEOUT_MS } from "../../../shared/types/plugin.js";

const meta = (name: string) => ({ pluginName: name, pluginVersion: "1.2.3" });

describe("worktreeSetupStepRegistry", () => {
  afterEach(() => clearWorktreeSetupStepRegistry());

  it("lists steps by plugin id, then in the order each manifest declares them", () => {
    registerWorktreeSetupSteps("zed", meta("Zed"), [{ id: "register", label: "Register" }]);
    registerWorktreeSetupSteps("acme", meta("Acme"), [
      { id: "seed", label: "Seed fixtures", timeoutMs: 5_000 },
      { id: "db", label: "Provision DB" },
    ]);

    expect(getWorktreeSetupSteps()).toEqual([
      {
        pluginId: "acme",
        pluginName: "Acme",
        pluginVersion: "1.2.3",
        stepId: "seed",
        label: "Seed fixtures",
        timeoutMs: 5_000,
      },
      {
        pluginId: "acme",
        pluginName: "Acme",
        pluginVersion: "1.2.3",
        stepId: "db",
        label: "Provision DB",
        timeoutMs: PLUGIN_WORKTREE_SETUP_STEP_DEFAULT_TIMEOUT_MS,
      },
      {
        pluginId: "zed",
        pluginName: "Zed",
        pluginVersion: "1.2.3",
        stepId: "register",
        label: "Register",
        timeoutMs: PLUGIN_WORKTREE_SETUP_STEP_DEFAULT_TIMEOUT_MS,
      },
    ]);
  });

  it("knows which step ids a plugin declared", () => {
    registerWorktreeSetupSteps("acme", meta("Acme"), [{ id: "db", label: "Provision DB" }]);
    expect(isWorktreeSetupStepDeclared("acme", "db")).toBe(true);
    expect(isWorktreeSetupStepDeclared("acme", "other")).toBe(false);
    expect(isWorktreeSetupStepDeclared("zed", "db")).toBe(false);
  });

  it("drops a plugin's declarations on unregister, and on an empty re-register", () => {
    registerWorktreeSetupSteps("acme", meta("Acme"), [{ id: "db", label: "Provision DB" }]);
    unregisterWorktreeSetupSteps("acme");
    expect(getWorktreeSetupSteps()).toEqual([]);

    registerWorktreeSetupSteps("acme", meta("Acme"), [{ id: "db", label: "Provision DB" }]);
    registerWorktreeSetupSteps("acme", meta("Acme"), []);
    expect(getWorktreeSetupSteps()).toEqual([]);
  });

  it("does not let a stale disposer remove the handler that replaced it", () => {
    const first = () => undefined;
    const second = () => undefined;
    registerWorktreeSetupStepHandler("acme", "db", first);
    registerWorktreeSetupStepHandler("acme", "db", second);

    unregisterWorktreeSetupStepHandler("acme", "db", first);
    expect(getWorktreeSetupStepHandler("acme", "db")).toBe(second);

    unregisterWorktreeSetupStepHandler("acme", "db", second);
    expect(getWorktreeSetupStepHandler("acme", "db")).toBeUndefined();
  });

  it("unbinds every handler a plugin bound, and no other plugin's", () => {
    const handler = () => undefined;
    registerWorktreeSetupStepHandler("acme", "db", handler);
    registerWorktreeSetupStepHandler("acme", "seed", handler);
    registerWorktreeSetupStepHandler("acme-extra", "db", handler);

    unregisterWorktreeSetupStepHandlers("acme");

    expect(getWorktreeSetupStepHandler("acme", "db")).toBeUndefined();
    expect(getWorktreeSetupStepHandler("acme", "seed")).toBeUndefined();
    expect(getWorktreeSetupStepHandler("acme-extra", "db")).toBe(handler);
  });
});
