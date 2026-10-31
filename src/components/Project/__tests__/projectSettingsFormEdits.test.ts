import { describe, expect, it } from "vitest";
import type { ProjectSettings } from "@/types";
import {
  applyFormEdits,
  toFormOwnedSettings,
  type ProjectSettingsFormValues,
} from "../projectSettingsFormEdits";

const formValues: ProjectSettingsFormValues = {
  runCommands: [],
  environmentVariables: [],
  excludedPaths: [],
  projectIconSvg: undefined,
  defaultWorktreeRecipeId: undefined,
  devServerCommand: "",
  devServerLoadTimeout: undefined,
  turbopackEnabled: true,
  daintreeMcpTier: "off",
  daintreeMcpSkipConfirmations: false,
  commandOverrides: [],
  copyTreeSettings: {},
  branchPrefixMode: "none",
  branchPrefixCustom: "",
  forgeRemote: undefined,
  forgeProviderOverride: null,
  issueProviderOverride: null,
  worktreePathPattern: "",
  terminalShell: undefined,
  terminalShellArgs: undefined,
  terminalDefaultCwd: undefined,
  terminalScrollback: undefined,
  notificationOverrides: {},
  resourceEnvironments: undefined,
  activeResourceEnvironment: undefined,
  defaultWorktreeMode: undefined,
};

function withEnv(...entries: Array<[string, string]>): ProjectSettingsFormValues {
  return {
    ...formValues,
    environmentVariables: entries.map(([key, value]) => ({ id: key, key, value })),
  };
}

describe("applyFormEdits", () => {
  it("deletes a variable named after an Object.prototype member", () => {
    const baseline = toFormOwnedSettings(withEnv(["constructor", "a"], ["toString", "b"]), null);
    const draft = toFormOwnedSettings(withEnv(), baseline);
    const stored: ProjectSettings = {
      runCommands: [],
      environmentVariables: { constructor: "a", toString: "b", KEPT: "c" },
    };

    expect(applyFormEdits(stored, baseline, draft).environmentVariables).toEqual({ KEPT: "c" });
  });

  it("adds a variable named after an Object.prototype member", () => {
    const baseline = toFormOwnedSettings(withEnv(), null);
    const draft = toFormOwnedSettings(withEnv(["hasOwnProperty", "x"]), baseline);
    const stored: ProjectSettings = { runCommands: [], environmentVariables: { KEPT: "c" } };

    expect(applyFormEdits(stored, baseline, draft).environmentVariables).toEqual({
      KEPT: "c",
      hasOwnProperty: "x",
    });
  });

  it("clears a record once its last key is deleted", () => {
    const baseline = toFormOwnedSettings(withEnv(["ONLY", "a"]), null);
    const draft = toFormOwnedSettings(withEnv(), baseline);
    const stored: ProjectSettings = { runCommands: [], environmentVariables: { ONLY: "a" } };

    expect(applyFormEdits(stored, baseline, draft).environmentVariables).toBeUndefined();
  });

  it("leaves a field alone once an edit is reverted to its baseline", () => {
    const baseline = toFormOwnedSettings({ ...formValues, devServerCommand: "npm run dev" }, null);
    const draft = toFormOwnedSettings({ ...formValues, devServerCommand: "npm run dev" }, baseline);
    const stored: ProjectSettings = { runCommands: [], devServerCommand: "pnpm dev" };

    expect(applyFormEdits(stored, baseline, draft).devServerCommand).toBe("pnpm dev");
  });
});
