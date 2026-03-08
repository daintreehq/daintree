import { afterEach, describe, expect, it } from "vitest";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// Note: VoiceCorrectionService has an internal 5 second timeout. If the API
// exceeds that, correct() falls back to raw input. Integration tests that assert
// on corrected content can therefore fail due to API latency rather than a bug.
// Tests using gpt-5-nano with reasoning_effort: "low" are typically fast (<2s).
describe("VoiceCorrectionService integration", () => {
  let svc: VoiceCorrectionService;

  afterEach(() => {
    svc?.resetHistory();
  });

  it.skipIf(!OPENAI_API_KEY)(
    "returns a corrected response from the OpenAI API",
    async () => {
      svc = new VoiceCorrectionService();

      const result = await svc.correct("um so we need to like update the racked component", {
        model: "gpt-4o-mini",
        apiKey: OPENAI_API_KEY,
        customDictionary: ["React", "Canopy"],
      });

      // Should get something back that's not the raw input
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);

      // The correction should mention React (phonetic fix for "racked")
      expect(result.toLowerCase()).toContain("react");

      // Filler words should be removed
      expect(result.toLowerCase()).not.toMatch(/\bum\b/);

      console.log("Raw:      ", "um so we need to like update the racked component");
      console.log("Corrected:", result);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "returns text unchanged when transcription is already correct",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "The server is running on port 3000.";
      const result = await svc.correct(input, {
        model: "gpt-4o-mini",
        apiKey: OPENAI_API_KEY,
        customDictionary: [],
      });

      expect(result).toBeTruthy();
      // Should be very similar to the input (maybe minor punctuation changes)
      expect(result.toLowerCase()).toContain("server");
      expect(result.toLowerCase()).toContain("port 3000");

      console.log("Raw:      ", input);
      console.log("Corrected:", result);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "respects custom dictionary terms",
    async () => {
      svc = new VoiceCorrectionService();

      const result = await svc.correct("we need to update the canopy work tree dashboard", {
        model: "gpt-4o-mini",
        apiKey: OPENAI_API_KEY,
        customDictionary: ["Canopy", "Worktree"],
      });

      expect(result).toBeTruthy();
      // Should preserve the dictionary terms with correct casing
      expect(result).toContain("Canopy");

      console.log("Raw:      ", "we need to update the canopy work tree dashboard");
      console.log("Corrected:", result);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: corrects technical terms and removes fillers",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "um so we need to like update the racked component";
      const result = await svc.correct(input, {
        model: "gpt-5-nano",
        apiKey: OPENAI_API_KEY,
        customDictionary: ["React", "Canopy"],
      });

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result);

      expect(result).toBeTruthy();
      expect(result).toContain("React");
      expect(result.toLowerCase()).not.toMatch(/\bum\b/);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: output contains no preamble, quotes, or explanatory text",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "the type script compiler is throwing errors on the racked component";
      const result = await svc.correct(input, {
        model: "gpt-5-nano",
        apiKey: OPENAI_API_KEY,
        customDictionary: [],
      });

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result);

      // Must not start with preamble phrases
      expect(result).not.toMatch(/^(here is|here's|the corrected|corrected:|sure[,!])/i);
      // Must not be wrapped in quotes
      expect(result).not.toMatch(/^["'`]/);
      // Must not contain markdown code fences
      expect(result).not.toContain("```");
      // Content should be present
      expect(result.toLowerCase()).toContain("typescript");
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: returns already-correct input verbatim (idempotency)",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "The TypeScript compiler is throwing errors on the React component.";
      const result = await svc.correct(input, {
        model: "gpt-5-nano",
        apiKey: OPENAI_API_KEY,
        customDictionary: [],
      });

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result);

      // Already correct input should be returned verbatim or nearly verbatim
      expect(result.toLowerCase()).toContain("typescript");
      expect(result.toLowerCase()).toContain("react");
      expect(result.toLowerCase()).toContain("compiler");
      // Should not add new content or explanations
      expect(result).not.toMatch(/^(here is|the corrected)/i);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5-nano: handles paragraph-length input (multi-clause)",
    async () => {
      svc = new VoiceCorrectionService();

      // Simulates a paragraph-level input as planned in #2672
      const input =
        "um so the type script compiler is throwing errors and we need to fix the racked component, also the tail wind styles are broken and the zoo stand store needs updating";
      const result = await svc.correct(input, {
        model: "gpt-5-nano",
        apiKey: OPENAI_API_KEY,
        customDictionary: [],
      });

      console.log("Model:    ", "gpt-5-nano");
      console.log("Raw:      ", input);
      console.log("Corrected:", result);

      expect(result).toBeTruthy();
      expect(result).toContain("TypeScript");
      expect(result).toContain("React");
      expect(result).toContain("Tailwind");
      expect(result).toContain("Zustand");
      // No preamble
      expect(result).not.toMatch(/^(here is|the corrected)/i);
    },
    20_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "raw API call to diagnose response shape",
    async () => {
      const input = "um the type script compiler is throwing errors on the racked component";

      for (const config of [
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
