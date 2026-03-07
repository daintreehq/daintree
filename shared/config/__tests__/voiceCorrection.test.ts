import { describe, expect, it } from "vitest";
import { buildCorrectionSystemPrompt, CORE_CORRECTION_PROMPT } from "../voiceCorrection.js";

describe("CORE_CORRECTION_PROMPT", () => {
  it("uses XML delimiters around the technical terms dictionary", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("<terms>");
    expect(CORE_CORRECTION_PROMPT).toContain("</terms>");
  });

  it("uses colon-separated dictionary entries with no arrow syntax", () => {
    expect(CORE_CORRECTION_PROMPT).not.toContain("->");
    expect(CORE_CORRECTION_PROMPT).toContain(": React");
    expect(CORE_CORRECTION_PROMPT).toContain(": TypeScript");
    expect(CORE_CORRECTION_PROMPT).toContain(": Next.js");
  });

  it("uses neutral segment wording for paragraph-level input compatibility", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("TEXT SEGMENT");
    expect(CORE_CORRECTION_PROMPT).toContain("text segment");
  });

  it("includes an explicit idempotency instruction", () => {
    expect(CORE_CORRECTION_PROMPT).toMatch(/return it character-for-character/i);
  });

  it("includes all expected technical term mappings", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("React");
    expect(CORE_CORRECTION_PROMPT).toContain("TypeScript");
    expect(CORE_CORRECTION_PROMPT).toContain("Next.js");
    expect(CORE_CORRECTION_PROMPT).toContain("GitHub");
    expect(CORE_CORRECTION_PROMPT).toContain("Kubernetes");
    expect(CORE_CORRECTION_PROMPT).toContain("Postgres");
    expect(CORE_CORRECTION_PROMPT).toContain("ESLint");
    expect(CORE_CORRECTION_PROMPT).toContain("Tailwind");
    expect(CORE_CORRECTION_PROMPT).toContain("Zustand");
  });

  it("is identified as a speech-to-text correction engine", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("speech-to-text correction engine");
  });
});

describe("buildCorrectionSystemPrompt", () => {
  it("guardrail uses positive then negative output framing", () => {
    const prompt = buildCorrectionSystemPrompt({});
    expect(prompt).toContain("plain text only");
    expect(prompt).toMatch(/no preamble|no quotes|no markdown|no explanations/);
  });

  it("guardrail requires immediate output (no preamble instruction)", () => {
    const prompt = buildCorrectionSystemPrompt({});
    expect(prompt).toMatch(/begin immediately with/i);
  });

  it("guardrail is always the last section of the prompt", () => {
    const prompt = buildCorrectionSystemPrompt({
      customInstructions: "Always use British spelling.",
    });
    const guardrailIdx = prompt.lastIndexOf("Begin immediately");
    const lastCharIdx = prompt.length - 1;
    // The guardrail must appear in the final ~200 characters of the prompt
    expect(guardrailIdx).toBeGreaterThan(lastCharIdx - 200);
  });

  it("places custom instructions before the guardrail", () => {
    const instructions = "Always use British spelling.";
    const prompt = buildCorrectionSystemPrompt({ customInstructions: instructions });
    const instructionsIdx = prompt.indexOf(instructions);
    const guardrailIdx = prompt.indexOf("Begin immediately");
    expect(instructionsIdx).toBeGreaterThan(-1);
    expect(guardrailIdx).toBeGreaterThan(instructionsIdx);
  });

  it("labels custom instructions as lower priority", () => {
    const prompt = buildCorrectionSystemPrompt({ customInstructions: "Do something." });
    expect(prompt).toContain("CUSTOM CONTEXT");
    expect(prompt).toContain("lower priority");
  });

  it("omits custom instructions section when none provided", () => {
    const prompt = buildCorrectionSystemPrompt({});
    expect(prompt).not.toContain("CUSTOM CONTEXT");
  });

  it("omits custom instructions section when value is whitespace only", () => {
    const prompt = buildCorrectionSystemPrompt({ customInstructions: "   \n  " });
    expect(prompt).not.toContain("CUSTOM CONTEXT");
  });

  it("includes project name in system prompt", () => {
    const prompt = buildCorrectionSystemPrompt({ projectName: "my-app" });
    expect(prompt).toContain("my-app");
  });

  it("includes custom dictionary terms as required terms", () => {
    const prompt = buildCorrectionSystemPrompt({ customDictionary: ["Canopy", "Worktree"] });
    expect(prompt).toContain("Canopy");
    expect(prompt).toContain("Worktree");
    expect(prompt).toContain("REQUIRED TERMS");
  });

  it("omits project section when no project context provided", () => {
    const prompt = buildCorrectionSystemPrompt({});
    expect(prompt).not.toContain("CURRENT PROJECT");
  });

  it("omits dynamic required terms section when custom dictionary is empty", () => {
    const prompt = buildCorrectionSystemPrompt({ customDictionary: [] });
    // The dynamic section header includes "(correct phonetic matches..." — distinct from
    // the "REQUIRED TERMS / CUSTOM DICTIONARY" label in the priority list
    expect(prompt).not.toContain("REQUIRED TERMS (correct phonetic matches");
  });

  it("excludes project directory from prompt when it matches project name", () => {
    const prompt = buildCorrectionSystemPrompt({
      projectName: "canopy",
      projectPath: "/Users/dev/canopy",
    });
    // Directory "canopy" equals project name, so Repository line should be omitted
    const projectSection = prompt.split("CURRENT PROJECT:")[1]?.split("\n\n")[0] ?? "";
    expect(projectSection).not.toContain("Repository:");
  });

  it("includes repository directory when it differs from project name", () => {
    const prompt = buildCorrectionSystemPrompt({
      projectName: "My App",
      projectPath: "/Users/dev/my-app-repo",
    });
    expect(prompt).toContain("my-app-repo");
  });
});
