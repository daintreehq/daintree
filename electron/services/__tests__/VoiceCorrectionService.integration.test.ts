import { afterEach, describe, expect, it } from "vitest";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// Note: VoiceCorrectionService aborts fetch requests via AbortSignal.timeout (7s
// for correct(), 3s for correctWord()). If the API exceeds that, the caller falls
// back to raw input. Integration tests can therefore fail due to latency, not bugs.
describe("VoiceCorrectionService integration", () => {
  let svc: VoiceCorrectionService;

  afterEach(() => {
    svc = undefined!;
  });

  it.skipIf(!OPENAI_API_KEY)(
    "returns a corrected response from the OpenAI API",
    async () => {
      svc = new VoiceCorrectionService();

      const result = await svc.correct(
        { rawText: "um so we need to like update the racked component" },
        {
          model: "gpt-4o-mini",
          apiKey: OPENAI_API_KEY,
          customDictionary: ["React", "Daintree"],
        }
      );

      expect(result).toBeTruthy();
      expect(result.confirmedText.length).toBeGreaterThan(0);

      // The correction should mention React (phonetic fix for "racked")
      expect(result.confirmedText.toLowerCase()).toContain("react");

      // Filler words should be removed
      expect(result.confirmedText.toLowerCase()).not.toMatch(/\bum\b/);

      console.log("Raw:      ", "um so we need to like update the racked component");
      console.log("Corrected:", result.confirmedText);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "returns text unchanged when transcription is already correct",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "The server is running on port 3000.";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-4o-mini",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      expect(result).toBeTruthy();
      expect(result.confirmedText.toLowerCase()).toContain("server");
      expect(result.confirmedText.toLowerCase()).toContain("port 3000");

      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "respects custom dictionary terms",
    async () => {
      svc = new VoiceCorrectionService();

      const result = await svc.correct(
        { rawText: "we need to update the daintree work tree dashboard" },
        {
          model: "gpt-4o-mini",
          apiKey: OPENAI_API_KEY,
          customDictionary: ["Daintree", "Worktree"],
        }
      );

      expect(result).toBeTruthy();
      expect(result.confirmedText).toContain("Daintree");

      console.log("Raw:      ", "we need to update the daintree work tree dashboard");
      console.log("Corrected:", result.confirmedText);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-mini: corrects technical terms and removes fillers",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "um so we need to like update the racked component";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5-mini",
          apiKey: OPENAI_API_KEY,
          customDictionary: ["React", "Daintree"],
        }
      );

      console.log("Model:    ", "gpt-5-mini");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result).toBeTruthy();
      expect(result.confirmedText).toContain("React");
      expect(result.confirmedText.toLowerCase()).not.toMatch(/\bum\b/);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-mini: output contains no preamble, quotes, or explanatory text",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "the type script compiler is throwing errors on the racked component";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5-mini",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5-mini");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result.confirmedText).not.toMatch(
        /^(here is|here's|the corrected|corrected:|sure[,!])/i
      );
      expect(result.confirmedText).not.toMatch(/^["'`]/);
      expect(result.confirmedText).not.toContain("```");
      expect(result.confirmedText.toLowerCase()).toContain("typescript");
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-mini: returns already-correct input verbatim (idempotency)",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "The TypeScript compiler is throwing errors on the React component.";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5-mini",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5-mini");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result.confirmedText.toLowerCase()).toContain("typescript");
      expect(result.confirmedText.toLowerCase()).toContain("react");
      expect(result.confirmedText.toLowerCase()).toContain("compiler");
      expect(result.confirmedText).not.toMatch(/^(here is|the corrected)/i);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: corrects technical terms and removes fillers",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "um so we need to like update the racked component";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5-nano",
          apiKey: OPENAI_API_KEY,
          customDictionary: ["React", "Daintree"],
        }
      );

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result).toBeTruthy();
      expect(result.confirmedText).toContain("React");
      expect(result.confirmedText.toLowerCase()).not.toMatch(/\bum\b/);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: output contains no preamble, quotes, or explanatory text",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "the type script compiler is throwing errors on the racked component";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5-nano",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result.confirmedText).not.toMatch(
        /^(here is|here's|the corrected|corrected:|sure[,!])/i
      );
      expect(result.confirmedText).not.toMatch(/^["'`]/);
      expect(result.confirmedText).not.toContain("```");
      expect(result.confirmedText.toLowerCase()).toContain("typescript");
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: returns already-correct input verbatim (idempotency)",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "The TypeScript compiler is throwing errors on the React component.";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5-nano",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result.confirmedText.toLowerCase()).toContain("typescript");
      expect(result.confirmedText.toLowerCase()).toContain("react");
      expect(result.confirmedText.toLowerCase()).toContain("compiler");
      expect(result.confirmedText).not.toMatch(/^(here is|the corrected)/i);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: handles paragraph-length input (multi-clause)",
    async () => {
      svc = new VoiceCorrectionService();

      const input =
        "um so the type script compiler is throwing errors and we need to fix the racked component, also the tail wind styles are broken and the zoo stand store needs updating";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5-nano",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result).toBeTruthy();
      expect(result.confirmedText).toContain("TypeScript");
      expect(result.confirmedText).toContain("React");
      expect(result.confirmedText).toContain("Tailwind");
      expect(result.confirmedText).toContain("Zustand");
      expect(result.confirmedText).not.toMatch(/^(here is|the corrected)/i);
    },
    20_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "raw API call to diagnose response shape",
    async () => {
      const input = "um the type script compiler is throwing errors on the racked component";

      for (const config of [
        { model: "gpt-5-mini", effort: "medium" },
        { model: "gpt-5-nano", effort: "low" },
        { model: "gpt-5-nano", effort: "minimal" },
      ]) {
        const start = Date.now();
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              {
                role: "system",
                content:
                  "You correct speech-to-text transcription errors. Fix phonetic errors, punctuation, and casing. Output ONLY the corrected text.",
              },
              { role: "user", content: `Correct this sentence:\n${input}` },
            ],
            reasoning_effort: config.effort,
            max_completion_tokens: 1024,
          }),
        });
        const elapsed = Date.now() - start;

        const data = await response.json();
        console.log(`\n--- ${config.model} effort=${config.effort} (${elapsed}ms) ---`);
        console.log("Status:", response.status);
        console.log("Response:", JSON.stringify(data, null, 2));
      }
    },
    30_000
  );
});
