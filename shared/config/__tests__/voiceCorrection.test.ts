import { describe, expect, it } from "vitest";
import {
  buildCorrectionSystemPrompt,
  buildMicroCorrectionSystemPrompt,
  CORE_CORRECTION_PROMPT,
  MICRO_CORRECTION_PROMPT,
} from "../voiceCorrection.js";

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

  it("uses target wording for whole-passage cleanup", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("CURRENT TARGET");
    expect(CORE_CORRECTION_PROMPT).toContain("<target>");
    expect(CORE_CORRECTION_PROMPT).toContain("full dictated passage");
  });

  it("includes an explicit idempotency instruction", () => {
    expect(CORE_CORRECTION_PROMPT).toMatch(/return it character-for-character/i);
  });

  it("allows paragraph cleanup without rewriting the passage", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("Add natural paragraph breaks");
    expect(CORE_CORRECTION_PROMPT).toContain("do not turn it into polished prose");
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

  it("instructs LLM to convert standalone paragraph voice commands to newlines", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("new paragraph");
    expect(CORE_CORRECTION_PROMPT).toContain("next paragraph");
    expect(CORE_CORRECTION_PROMPT).toContain("start a new paragraph");
    expect(CORE_CORRECTION_PROMPT).toContain("\\n\\n");
  });

  it("instructs LLM to convert standalone line break voice commands to newlines", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("new line");
    expect(CORE_CORRECTION_PROMPT).toContain("next line");
    expect(CORE_CORRECTION_PROMPT).toContain("line break");
    expect(CORE_CORRECTION_PROMPT).toContain("\\n");
  });

  it("scopes voice commands to standalone formatting instructions only", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("standalone");
    expect(CORE_CORRECTION_PROMPT).toMatch(/not.+part of a.+sentence/i);
  });
});

describe("buildCorrectionSystemPrompt", () => {
  it("guardrail uses positive then negative output framing", () => {
    const prompt = buildCorrectionSystemPrompt({});
    expect(prompt).toContain("JSON object");
    expect(prompt).toMatch(/no_change|replace|Do not add explanation/i);
  });

  it("guardrail explicitly defines the no_change and replace contract", () => {
    const prompt = buildCorrectionSystemPrompt({});
    expect(prompt).toContain('"no_change"');
    expect(prompt).toContain('"replace"');
  });

  it("guardrail is always the last section of the prompt", () => {
    const prompt = buildCorrectionSystemPrompt({
      customInstructions: "Always use British spelling.",
    });
    const guardrailIdx = prompt.lastIndexOf("Return a JSON object");
    const lastCharIdx = prompt.length - 1;
    // The guardrail must appear near the end of the prompt, after the dynamic sections.
    expect(guardrailIdx).toBeGreaterThan(lastCharIdx - 320);
  });

  it("places custom instructions before the guardrail", () => {
    const instructions = "Always use British spelling.";
    const prompt = buildCorrectionSystemPrompt({ customInstructions: instructions });
    const instructionsIdx = prompt.indexOf(instructions);
    const guardrailIdx = prompt.indexOf("Return a JSON object");
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

  it("extracts directory name from Windows backslash path", () => {
    const prompt = buildCorrectionSystemPrompt({
      projectName: "My App",
      projectPath: "C:\\Users\\dev\\my-repo",
    });
    expect(prompt).toContain("my-repo");
    expect(prompt).not.toContain("C:\\Users\\dev\\my-repo");
  });

  it("omits Repository line when Windows path directory matches project name", () => {
    const prompt = buildCorrectionSystemPrompt({
      projectName: "canopy",
      projectPath: "C:\\Users\\dev\\canopy",
    });
    const projectSection = prompt.split("CURRENT PROJECT:")[1]?.split("\n\n")[0] ?? "";
    expect(projectSection).not.toContain("Repository:");
  });

  it("handles trailing separators in project path", () => {
    const prompt = buildCorrectionSystemPrompt({
      projectName: "My App",
      projectPath: "C:\\Users\\dev\\my-repo\\",
    });
    expect(prompt).toContain("my-repo");
    expect(prompt).not.toContain("C:\\Users\\dev\\my-repo\\");
  });

  it("handles mixed separators in project path", () => {
    const prompt = buildCorrectionSystemPrompt({
      projectName: "My App",
      projectPath: "C:\\Users/dev\\my-repo",
    });
    expect(prompt).toContain("my-repo");
  });
});

describe("MICRO_CORRECTION_PROMPT", () => {
  it("is a word-level correction engine", () => {
    expect(MICRO_CORRECTION_PROMPT).toContain("word-level correction engine");
  });

  it("references uncertain tags", () => {
    expect(MICRO_CORRECTION_PROMPT).toContain("<uncertain>");
  });

  it("includes technical terms dictionary", () => {
    expect(MICRO_CORRECTION_PROMPT).toContain("<terms>");
    expect(MICRO_CORRECTION_PROMPT).toContain("Zustand");
    expect(MICRO_CORRECTION_PROMPT).toContain("React");
  });

  it("describes adjacent word merging", () => {
    expect(MICRO_CORRECTION_PROMPT).toContain("zoo stand");
    expect(MICRO_CORRECTION_PROMPT).toContain("Zustand");
  });

  it("does not contain paragraph voice command handling", () => {
    expect(MICRO_CORRECTION_PROMPT).not.toContain("standalone");
    expect(MICRO_CORRECTION_PROMPT).not.toContain("next paragraph");
    expect(MICRO_CORRECTION_PROMPT).not.toContain("line break");
  });
});

describe("buildMicroCorrectionSystemPrompt", () => {
  it("includes the micro-correction core prompt", () => {
    const prompt = buildMicroCorrectionSystemPrompt({});
    expect(prompt).toContain("word-level correction engine");
  });

  it("includes guardrail at the end", () => {
    const prompt = buildMicroCorrectionSystemPrompt({});
    expect(prompt).toContain("no_change");
    expect(prompt).toContain("replace");
    expect(prompt).toContain("JSON object");
  });

  it("includes project name when provided", () => {
    const prompt = buildMicroCorrectionSystemPrompt({ projectName: "Canopy" });
    expect(prompt).toContain("Canopy");
    expect(prompt).toContain("CURRENT PROJECT");
  });

  it("includes custom dictionary as required terms", () => {
    const prompt = buildMicroCorrectionSystemPrompt({
      customDictionary: ["Canopy", "Worktree"],
    });
    expect(prompt).toContain("Canopy");
    expect(prompt).toContain("Worktree");
    expect(prompt).toContain("REQUIRED TERMS");
  });

  it("omits project section when no project context provided", () => {
    const prompt = buildMicroCorrectionSystemPrompt({});
    expect(prompt).not.toContain("CURRENT PROJECT");
  });

  it("does not include custom instructions (micro prompt is leaner)", () => {
    const prompt = buildMicroCorrectionSystemPrompt({
      customInstructions: "Always use British spelling.",
    });
    expect(prompt).not.toContain("CUSTOM CONTEXT");
  });

  it("guardrail is the last section", () => {
    const prompt = buildMicroCorrectionSystemPrompt({
      customDictionary: ["Test"],
    });
    const guardrailIdx = prompt.lastIndexOf("Return a JSON object");
    expect(guardrailIdx).toBeGreaterThan(prompt.length - 300);
  });

  it("extracts directory name from Windows backslash path", () => {
    const prompt = buildMicroCorrectionSystemPrompt({
      projectName: "My App",
      projectPath: "C:\\Users\\dev\\my-repo",
    });
    expect(prompt).toContain("my-repo");
    expect(prompt).not.toContain("C:\\Users\\dev\\my-repo");
  });

  it("omits Repository line when Windows path directory matches project name", () => {
    const prompt = buildMicroCorrectionSystemPrompt({
      projectName: "canopy",
      projectPath: "C:\\Users\\dev\\canopy",
    });
    const projectSection = prompt.split("CURRENT PROJECT:")[1]?.split("\n\n")[0] ?? "";
    expect(projectSection).not.toContain("Repository:");
  });

  it("handles trailing separators in project path", () => {
    const prompt = buildMicroCorrectionSystemPrompt({
      projectName: "My App",
      projectPath: "/Users/dev/my-repo/",
    });
    expect(prompt).toContain("my-repo");
    expect(prompt).not.toContain("/Users/dev/my-repo/");
  });
});
