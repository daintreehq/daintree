import { describe, expect, it, vi } from "vitest";
import type { AgentPreset } from "../../../../shared/config/agentRegistry.js";
import { presetLaunchContent } from "../../../../shared/utils/agentPresetLaunchConsent.js";
import {
  gatePluginPresetLaunch,
  type PluginPresetLaunchCaller,
  type PluginPresetLaunchGateDeps,
  type PresetLaunchSources,
} from "../pluginPresetLaunchGate.js";

const zai: AgentPreset = {
  id: "zai",
  name: "Z.ai",
  args: ["--model", "glm"],
  env: { ANTHROPIC_AUTH_TOKEN: "sk-secret-value" },
  dangerousMode: "on",
  fallbacks: ["backup"],
  fallbackOnRateLimit: true,
};
const backup: AgentPreset = { id: "backup", name: "Backup" };

const caller: PluginPresetLaunchCaller = {
  pluginId: "digitalfrontier.beads",
  displayName: "Beads",
  declaredCapabilities: ["agent:launch-preset"],
  scopeKey: "global",
};

function makeDeps(sources: Partial<PresetLaunchSources> = {}) {
  const readSources = vi.fn(
    async (): Promise<PresetLaunchSources> => ({
      settings: { agents: { claude: { customPresets: [zai, backup] } } } as never,
      ccrPresets: undefined,
      projectPresets: undefined,
      ...sources,
    })
  );
  const ensurePresetLaunchAllowed = vi.fn<PluginPresetLaunchGateDeps["ensurePresetLaunchAllowed"]>(
    async () => {}
  );
  const deps: PluginPresetLaunchGateDeps = {
    readSources,
    ambientProjectId: () => "focused-project",
    ensurePresetLaunchAllowed,
  };
  return { deps, readSources, ensurePresetLaunchAllowed };
}

const launch = { agentId: "claude", presetId: "zai", prompt: "hello" };

describe("gatePluginPresetLaunch", () => {
  it("asks about the preset with what it turns on, and approves its exact content", async () => {
    const { deps, ensurePresetLaunchAllowed } = makeDeps();
    const result = await gatePluginPresetLaunch(caller, "agent.launch", launch, null, deps);

    expect(result.kind).toBe("approved");
    if (result.kind !== "approved") return;
    expect(result.approval.presetId).toBe("zai");
    expect(result.approval.agentId).toBe("claude");
    const [, , summary, fingerprint, , scopeKey] = ensurePresetLaunchAllowed.mock.calls[0]!;
    expect(scopeKey).toBe("global");
    expect(summary).toMatchObject({
      presetName: "Z.ai",
      source: "custom",
      args: ["--model", "glm"],
      dangerousMode: "on",
      skipsPermissions: true,
      envNames: ["ANTHROPIC_AUTH_TOKEN"],
      fallbackNames: ["Backup"],
      fallbackOnRateLimit: true,
    });
    // Env values never reach the dialog.
    expect(JSON.stringify(summary)).not.toContain("sk-secret-value");
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain("sk-secret-value");
  });

  it("reads the focused project's presets for an unbound dispatch and the target's otherwise", async () => {
    const { deps, readSources } = makeDeps();
    await gatePluginPresetLaunch(caller, "agent.launch", launch, null, deps);
    await gatePluginPresetLaunch(caller, "agent.launch", launch, "bound-project", deps);
    expect(readSources.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      "focused-project",
      "bound-project",
    ]);
  });

  it("fingerprints the source too: the same content from the repo is another grant", async () => {
    const custom = makeDeps();
    await gatePluginPresetLaunch(caller, "agent.launch", launch, null, custom.deps);
    const fromRepo = makeDeps({
      settings: { agents: {} } as never,
      projectPresets: [zai, backup],
    });
    const result = await gatePluginPresetLaunch(caller, "agent.launch", launch, "p", fromRepo.deps);

    const customCall = custom.ensurePresetLaunchAllowed.mock.calls[0]!;
    const repoCall = fromRepo.ensurePresetLaunchAllowed.mock.calls[0]!;
    expect(repoCall[2].source).toBe("project");
    expect(repoCall[3]).not.toBe(customCall[3]);
    // The launch is still held to the content itself.
    if (result.kind === "approved") {
      expect(result.approval.content).toBe(presetLaunchContent({ ...zai }));
    }
  });

  it("passes through, unasked, a plugin that doesn't declare the capability", async () => {
    const { deps, ensurePresetLaunchAllowed, readSources } = makeDeps();
    const result = await gatePluginPresetLaunch(
      { ...caller, declaredCapabilities: ["project:dispatch"] },
      "agent.launch",
      launch,
      null,
      deps
    );
    expect(result).toEqual({ kind: "pass" });
    expect(readSources).not.toHaveBeenCalled();
    expect(ensurePresetLaunchAllowed).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ["presetId: null", { ...launch, presetId: null }],
    ["a preset with env", { ...launch, env: { X: "1" } }],
    ["a preset with flags", { ...launch, agentLaunchFlags: ["--yolo"] }],
  ])("passes %s through to the renderer's refusal without asking", async (_label, args) => {
    const { deps, ensurePresetLaunchAllowed } = makeDeps();
    expect(await gatePluginPresetLaunch(caller, "agent.launch", args, null, deps)).toEqual({
      kind: "pass",
    });
    expect(ensurePresetLaunchAllowed).not.toHaveBeenCalled();
  });

  it("refuses a preset the agent doesn't have without asking anyone", async () => {
    const { deps, ensurePresetLaunchAllowed } = makeDeps();
    const result = await gatePluginPresetLaunch(
      caller,
      "agent.launch",
      { ...launch, presetId: "missing" },
      null,
      deps
    );
    expect(result.kind).toBe("refused");
    if (result.kind === "refused" && !result.result.ok) {
      expect(result.result.error.code).toBe("VALIDATION_ERROR");
    }
    expect(ensurePresetLaunchAllowed).not.toHaveBeenCalled();
  });

  it("lets a refused consent reject the dispatch", async () => {
    const { deps, ensurePresetLaunchAllowed } = makeDeps();
    ensurePresetLaunchAllowed.mockRejectedValueOnce(new Error("PERMISSION_REQUIRED: denied"));
    await expect(
      gatePluginPresetLaunch(caller, "agent.launch", launch, null, deps)
    ).rejects.toThrow(/PERMISSION_REQUIRED/);
  });
});
