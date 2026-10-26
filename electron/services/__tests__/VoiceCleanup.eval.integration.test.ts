import { describe, expect, it } from "vitest";
import { VoiceCorrectionService } from "../VoiceCorrectionService.js";
import { VOICE_DICTATION_AI_MODEL } from "../../../shared/config/voiceCorrection.js";
import { DICTATED_PROMPTS } from "./fixtures/dictatedPrompts.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// Case and prose punctuation are style; words, their order and the line
// layout are the cleanup being judged.
function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[,;:!?"“”()]/g, " ")
        .replace(/\.(?=\s|$)/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

// Runs the whole cleanup, guard included, against the real model:
// `npm run test:integration -- VoiceCleanup.eval`.
describe.skipIf(!OPENAI_API_KEY)("dictated prompt cleanup eval", () => {
  const service = new VoiceCorrectionService();

  it.each(DICTATED_PROMPTS.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, { raw, expected }) => {
      const result = await service.correct(
        { rawText: raw, reason: "stop" },
        {
          model: VOICE_DICTATION_AI_MODEL,
          apiKey: OPENAI_API_KEY,
          customDictionary: [],
          language: "en",
        }
      );

      expect(expected.map(normalize)).toContain(normalize(result.confirmedText));
    },
    30_000
  );
});
