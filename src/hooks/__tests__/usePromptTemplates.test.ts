import { describe, expect, it } from "vitest";
import type { PluginPromptTemplate } from "@/store/pluginRuntimeStore";
import type { PromptTemplateContribution } from "@shared/types/plugin";
import { mergePromptTemplates } from "../usePromptTemplates";

function contribution(id: string): PromptTemplateContribution {
  return { id, title: id, description: "d", body: "b", args: [] };
}

function plugin(instance: string, id: string): PluginPromptTemplate {
  return {
    key: `${instance}::${id}`,
    pluginId: instance,
    pluginName: "Acme CRM",
    projectId: null,
    template: contribution(id),
  };
}

describe("mergePromptTemplates", () => {
  it("puts the person's templates first and keeps the plugins' order", () => {
    const merged = mergePromptTemplates(
      [contribution("mine")],
      [plugin("acme", "z"), plugin("acme", "a")]
    );
    expect(merged.map((e) => e.template.id)).toEqual(["mine", "z", "a"]);
  });

  it("attributes a person's template to them and a plugin's to the plugin", () => {
    const [mine, theirs] = mergePromptTemplates([contribution("t")], [plugin("acme", "t")]);
    expect(mine).toMatchObject({ sourceName: "You", attribution: "Your template" });
    expect(theirs).toMatchObject({ sourceName: "Acme CRM", attribution: "From Acme CRM" });
  });

  it("keeps a file and a plugin template of the same id apart", () => {
    const [mine, theirs] = mergePromptTemplates([contribution("t")], [plugin("acme", "t")]);
    expect(mine?.key).not.toBe(theirs?.key);
  });

  it("leaves a plugin template's key as it was", () => {
    const [theirs] = mergePromptTemplates([], [plugin("acme", "t")]);
    expect(theirs?.key).toBe("acme::t");
  });
});
