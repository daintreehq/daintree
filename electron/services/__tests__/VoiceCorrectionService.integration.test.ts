import { afterEach, describe, expect, it } from "vitest";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

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
    "handles the configured correction model (gpt-5-nano)",
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
      // At minimum, the API should return *something* (even if uncorrected)
      expect(result.length).toBeGreaterThan(0);
    },
    15_000
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
