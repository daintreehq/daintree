import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

const DATABASES = [{ id: "ledger", location: "local" }];
const KNOWLEDGE = {
  instructions: "./assistant/notes.md",
  skills: [{ id: "reconcile", path: "./skills/reconcile" }],
  references: [{ id: "schema", path: "assistant/schema.md" }],
};

function parse(
  assistantKnowledge: unknown,
  contributes: Record<string, unknown> = { databases: DATABASES },
  origin: "user" | "project" = "user"
) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.ledger",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: { ...contributes, assistantKnowledge },
  });
}

function errorMessages(result: ReturnType<typeof parse>): string[] {
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? issue.message
  );
}

describe("contributes.assistantKnowledge", () => {
  it("accepts instructions, skills and references beside the plugin's tools", () => {
    const result = parse(KNOWLEDGE);
    expect(result.success && result.data.contributes.assistantKnowledge).toEqual(KNOWLEDGE);
  });

  it("is left out of a manifest that doesn't declare it", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.ledger",
      version: "1.0.0",
    });
    expect(result.success && "assistantKnowledge" in result.data.contributes).toBe(false);
  });

  it("is allowed for a project plugin, whose tools are bound to its project", () => {
    expect(parse(KNOWLEDGE, { databases: DATABASES }, "project").success).toBe(true);
  });

  it("needs agent tools to describe", () => {
    expect(errorMessages(parse(KNOWLEDGE, {}))).toContain(
      "assistant_knowledge_requires_agent_tools"
    );
  });

  it("needs something to hand over", () => {
    expect(errorMessages(parse({}))).toContain(
      "assistantKnowledge must declare instructions, skills or references"
    );
  });

  it("refuses duplicate ids within a list", () => {
    expect(
      errorMessages(
        parse({
          references: [
            { id: "schema", path: "a.md" },
            { id: "schema", path: "b.md" },
          ],
        })
      )
    ).toContain("duplicate_contribution_id");
  });

  it.each([
    ["a non-Markdown instructions file", { instructions: "notes.txt" }],
    ["a non-Markdown reference", { references: [{ id: "schema", path: "schema.json" }] }],
    ["a path out of the plugin", { references: [{ id: "schema", path: "../schema.md" }] }],
    ["an absolute path", { skills: [{ id: "reconcile", path: "/etc/skills" }] }],
    ["a skill id Agent Skills can't name", { skills: [{ id: "Re_concile", path: "s" }] }],
    ["the reserved reference id", { references: [{ id: "instructions", path: "i.md" }] }],
    ["an unknown field", { ...KNOWLEDGE, prompt: "Replace Daintree's prompt." }],
  ])("refuses %s", (_label, knowledge) => {
    expect(parse(knowledge).success).toBe(false);
  });
});
