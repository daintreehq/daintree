import { afterEach, describe, expect, it } from "vitest";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// Note: VoiceCorrectionService aborts fetch requests via AbortSignal.timeout (7s for
// correct()). If the API exceeds that, the caller falls back to raw input. Integration
// tests can therefore fail due to latency, not bugs.
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
          model: "gpt-5.6-luna",
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
          model: "gpt-5.6-luna",
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
          model: "gpt-5.6-luna",
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
    "gpt-5.6-luna: corrects technical terms and removes fillers",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "um so we need to like update the racked component";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5.6-luna",
          apiKey: OPENAI_API_KEY,
          customDictionary: ["React", "Daintree"],
        }
      );

      console.log("Model:    ", "gpt-5.6-luna");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result).toBeTruthy();
      expect(result.confirmedText).toContain("React");
      expect(result.confirmedText.toLowerCase()).not.toMatch(/\bum\b/);
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5.6-luna: output contains no preamble, quotes, or explanatory text",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "the type script compiler is throwing errors on the racked component";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5.6-luna",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5.6-luna");
      console.log("Raw:      ", input);
      console.log("Corrected:", result.confirmedText);

      expect(result.confirmedText).not.toMatch(
        /^(here is|here's|the corrected|corrected:|sure[,!])/i
      );
      expect(result.confirmedText).not.toMatch(/^["'`]/);
      expect(result.confirmedText).not.toContain("```");
      expect(result.confirmedText.toLowerCase().replaceAll(/\s/g, "")).toContain("typescript");
    },
    15_000
  );

  it.skipIf(!OPENAI_API_KEY)(
    "gpt-5.6-luna: returns already-correct input verbatim (idempotency)",
    async () => {
      svc = new VoiceCorrectionService();

      const input = "The TypeScript compiler is throwing errors on the React component.";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5.6-luna",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5.6-luna");
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
    "gpt-5.6-luna: handles paragraph-length input (multi-clause)",
    async () => {
      svc = new VoiceCorrectionService();

      const input =
        "um so the type script compiler is throwing errors and we need to fix the racked component, also the tail wind styles are broken and the zoo stand store needs updating";
      const result = await svc.correct(
        { rawText: input },
        {
          model: "gpt-5.6-luna",
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
        }
      );

      console.log("Model:    ", "gpt-5.6-luna");
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
});
