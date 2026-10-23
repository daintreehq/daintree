import { describe, expect, it } from "vitest";
import {
  collectPluginManifestAssets,
  describePluginManifestAsset,
} from "../pluginManifestAssets.js";

function byField(manifest: unknown) {
  return new Map(collectPluginManifestAssets(manifest).map((asset) => [asset.field, asset]));
}

describe("collectPluginManifestAssets", () => {
  it("tolerates manifests that never passed the schema", () => {
    for (const manifest of [null, 42, "plugin", [], { main: 7, contributes: [] }]) {
      expect(collectPluginManifestAssets(manifest)).toEqual([]);
    }
    expect(
      collectPluginManifestAssets({
        contributes: { tours: [null, { chapters: "nope" }], assistantKnowledge: { skills: [1] } },
      })
    ).toEqual([]);
  });

  it("requires tour scene modules and treats only local narration as optional", () => {
    const assets = byField({
      contributes: {
        tours: [
          {
            componentPath: "./dist/tour.js",
            chapters: [
              { audioUrl: "./tours/intro.ogg" },
              { audioUrl: "https://cdn.example.com/a.ogg" },
              { audioUrl: null },
            ],
          },
        ],
      },
    });
    expect(assets.get("tours[0].componentPath")).toMatchObject({
      path: "dist/tour.js",
      required: true,
      module: true,
    });
    expect(assets.get("tours[0].chapters[0].audioUrl")).toMatchObject({
      path: "tours/intro.ogg",
      required: false,
      module: false,
    });
    expect(assets.has("tours[0].chapters[1].audioUrl")).toBe(false);
    expect(assets.has("tours[0].chapters[2].audioUrl")).toBe(false);
  });

  it("resolves an Assistant knowledge skill to the SKILL.md inside its directory", () => {
    const assets = byField({
      contributes: {
        assistantKnowledge: {
          instructions: "notes.md",
          skills: [
            { id: "a", path: "./skills/a/" },
            { id: "root", path: "." },
          ],
          references: [{ id: "r", path: "docs/r.md" }],
        },
      },
    });
    const skill = assets.get("assistantKnowledge.skills[0].path")!;
    expect(skill.path).toBe("skills/a/SKILL.md");
    expect(describePluginManifestAsset(skill)).toBe(
      'assistantKnowledge.skills[0].path "./skills/a/" (expected skills/a/SKILL.md)'
    );
    expect(assets.get("assistantKnowledge.skills[1].path")?.path).toBe("SKILL.md");
    expect(assets.get("assistantKnowledge.instructions")?.path).toBe("notes.md");
    expect(assets.get("assistantKnowledge.references[0].path")?.path).toBe("docs/r.md");
  });

  it("collects custom icons from every field the host loads them from, and nothing else", () => {
    const assets = byField({
      contributes: {
        panels: [{ iconId: "./icons/p.svg", toolbar: [{ iconId: "./icons/t.svg" }] }],
        processTools: [{ iconId: "terminal" }],
        views: [
          { componentPath: "dist/a.js", location: "sidebar", iconId: "./icons/s.svg" },
          { componentPath: "dist/b.js", location: "panel", iconId: "./icons/ignored.svg" },
        ],
      },
    });
    expect(assets.get("panels[0].iconId")?.path).toBe("icons/p.svg");
    expect(assets.get("panels[0].toolbar[0].iconId")?.path).toBe("icons/t.svg");
    expect(assets.get("views[0].iconId")?.path).toBe("icons/s.svg");
    expect(assets.has("views[1].iconId")).toBe(false);
    expect(assets.has("processTools[0].iconId")).toBe(false);
  });

  it("requires a plugin-relative agent command but not one looked up on PATH", () => {
    const assets = byField({
      contributes: { agents: [{ command: "./bin/agent" }, { command: "acme-agent" }] },
    });
    expect(assets.get("agents[0].command")).toMatchObject({ path: "bin/agent", required: true });
    expect(assets.has("agents[1].command")).toBe(false);
  });

  it("requires a plugin-relative MCP server command but not a PATH or settings one", () => {
    const assets = byField({
      contributes: {
        mcpServers: [
          { command: "./bin/server" },
          { command: "node", args: ["./dist/server.js"] },
          { command: "./${settings:serverPath}" },
        ],
      },
    });
    expect(assets.get("mcpServers[0].command")?.path).toBe("bin/server");
    expect(assets.has("mcpServers[1].command")).toBe(false);
    expect(assets.has("mcpServers[2].command")).toBe(false);
  });

  it("reads deprecated experimental_views only when views is absent", () => {
    expect(
      byField({ contributes: { experimental_views: [{ componentPath: "dist/v.js" }] } }).has(
        "experimental_views[0].componentPath"
      )
    ).toBe(true);
    const both = byField({
      contributes: {
        views: [{ componentPath: "dist/v.js" }],
        experimental_views: [{ componentPath: "dist/old.js" }],
      },
    });
    expect(both.has("views[0].componentPath")).toBe(true);
    expect(both.has("experimental_views[0].componentPath")).toBe(false);
  });
});
