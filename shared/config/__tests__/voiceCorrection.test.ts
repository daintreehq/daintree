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

  it("gates custom-dictionary correction on context instead of forcing every phonetic match", () => {
    // ASR-level biasing now handles the terms, so the prompt must NOT force an
    // unconditional remap of every phonetically similar word.
    expect(CORE_CORRECTION_PROMPT).not.toContain("Always map phonetically similar words");
    expect(CORE_CORRECTION_PROMPT).toMatch(/only when the existing word does not fit the context/i);
  });

  it("is identified as a speech-to-text correction engine", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("speech-to-text correction engine");
  });

  it("keeps the static prefix long enough to clear OpenAI's prompt-cache floor", () => {
    // OpenAI's Responses API only caches a prefix of at least 1,024 tokens. This
    // floor is a character proxy for that token threshold: at a conservative ~4.4
    // chars/token for dense technical English, 4,800 chars maps to ~1,090 tokens,
    // keeping headroom above 1,024 even if a future edit compacts the prose. Guards
    // against accidental truncation that would silently drop the prefix below the
    // cache threshold (issue #9746).
    expect(CORE_CORRECTION_PROMPT.length).toBeGreaterThan(4800);
  });

  it("includes expanded domain-grouped phonetic mappings", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("npm");
    expect(CORE_CORRECTION_PROMPT).toContain("pnpm");
    expect(CORE_CORRECTION_PROMPT).toContain("Storybook");
    expect(CORE_CORRECTION_PROMPT).toContain("Vite");
    expect(CORE_CORRECTION_PROMPT).toContain("kubectl");
    expect(CORE_CORRECTION_PROMPT).toContain("Terraform");
    expect(CORE_CORRECTION_PROMPT).toContain("OAuth");
    expect(CORE_CORRECTION_PROMPT).toContain("gRPC");
    expect(CORE_CORRECTION_PROMPT).toContain("PyTorch");
    expect(CORE_CORRECTION_PROMPT).toContain("Anthropic");
    expect(CORE_CORRECTION_PROMPT).toContain("idempotent");
    expect(CORE_CORRECTION_PROMPT).toContain("regex");
  });

  it("includes few-shot correction examples that defer output format to the JSON schema", () => {
    expect(CORE_CORRECTION_PROMPT).toContain("EXAMPLES");
    expect(CORE_CORRECTION_PROMPT).toContain("Corrected:");
    // Examples must not instruct the model to emit plain text — the schema wins.
    expect(CORE_CORRECTION_PROMPT).toMatch(/always return the JSON object/i);
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

  it("includes custom dictionary terms as preferred (not forced) terms", () => {
    const prompt = buildCorrectionSystemPrompt({ customDictionary: ["Daintree", "Worktree"] });
    expect(prompt).toContain("Daintree");
    expect(prompt).toContain("Worktree");
    // ASR biasing handles these terms, so the dynamic section must prefer — not force — them.
    expect(prompt).toContain("PREFERRED TERMS");
    expect(prompt).not.toContain("correct phonetic matches to these exact forms");
  });

  it("omits project section when no project context provided", () => {
    const prompt = buildCorrectionSystemPrompt({});
    expect(prompt).not.toContain("CURRENT PROJECT");
  });

  it("omits dynamic preferred terms section when custom dictionary is empty", () => {
    const prompt = buildCorrectionSystemPrompt({ customDictionary: [] });
    // The dynamic section header starts with "PREFERRED TERMS (prefer these exact forms..." —
    // distinct from the "REQUIRED TERMS / CUSTOM DICTIONARY" label in the priority list, which
    // is always present in the core prompt.
    expect(prompt).not.toContain("PREFERRED TERMS (prefer these exact forms");
  });

  it("excludes project directory from prompt when it matches project name", () => {
    const prompt = buildCorrectionSystemPrompt({
      projectName: "daintree",
      projectPath: "/Users/dev/daintree",
    });
    // Directory "daintree" equals project name, so Repository line should be omitted
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
      projectName: "daintree",
      projectPath: "C:\\Users\\dev\\daintree",
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
