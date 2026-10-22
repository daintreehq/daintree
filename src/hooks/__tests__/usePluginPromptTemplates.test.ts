import { describe, expect, it } from "vitest";
import { selectPromptTemplatesForProject } from "../usePluginPromptTemplates";
import type { PluginPromptTemplate } from "@/store/pluginRuntimeStore";

function entry(pluginId: string, projectId: string | null): PluginPromptTemplate {
  return {
    key: `${pluginId}::t`,
    pluginId,
    pluginName: pluginId,
    projectId,
    template: { id: "t", title: "T", description: "d", body: "b", args: [] },
  };
}

describe("selectPromptTemplatesForProject", () => {
  const all = [entry("installed", null), entry("proj-a", "a"), entry("proj-b", "b")];

  it("offers installed templates everywhere and a project plugin's only in its project", () => {
    expect(selectPromptTemplatesForProject(all, "a").map((e) => e.pluginId)).toEqual([
      "installed",
      "proj-a",
    ]);
    expect(selectPromptTemplatesForProject(all, "b").map((e) => e.pluginId)).toEqual([
      "installed",
      "proj-b",
    ]);
  });

  it("offers no project plugin's templates to a view with no project", () => {
    expect(selectPromptTemplatesForProject(all, undefined).map((e) => e.pluginId)).toEqual([
      "installed",
    ]);
  });
});
