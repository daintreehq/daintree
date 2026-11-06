import { beforeEach, describe, expect, it, vi } from "vitest";

const project = vi.hoisted(() => ({
  state: {
    presetsByAgent: {} as Record<string, unknown[]>,
    hydratedProjectId: null as string | null,
  },
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({ settings: { agents: {} } }) },
}));
vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: () => ({ ccrPresetsByAgent: { codex: [] } }) },
}));
vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: { getState: () => project.state },
}));

import { readPresetWriteSources } from "../agentPresetSources";

describe("readPresetWriteSources (#16047)", () => {
  beforeEach(() => {
    project.state = {
      presetsByAgent: { codex: [{ id: "team", name: "Team" }] },
      hydratedProjectId: "p1",
    };
  });

  it("counts repository presets only when the loaded snapshot is the caller's project", () => {
    expect(readPresetWriteSources("p1").projectPresetsByAgent).toEqual({
      codex: [{ id: "team", name: "Team" }],
    });
    expect(readPresetWriteSources("p2").projectPresetsByAgent).toBeUndefined();
    expect(readPresetWriteSources(undefined).projectPresetsByAgent).toBeUndefined();
    project.state = { ...project.state, hydratedProjectId: null };
    expect(readPresetWriteSources("p1").projectPresetsByAgent).toBeUndefined();
  });
});
