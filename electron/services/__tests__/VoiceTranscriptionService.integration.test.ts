import { afterEach, describe, expect, it } from "vitest";
import { VoiceTranscriptionService } from "../VoiceTranscriptionService.js";
import type { VoiceTranscriptionEvent } from "../VoiceTranscriptionService.js";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? "";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VoiceTranscriptionService integration", () => {
  let service: VoiceTranscriptionService;

  afterEach(() => {
    service?.destroy();
  });

  it.skipIf(!DEEPGRAM_API_KEY)(
    "connects to Deepgram and session config is accepted",
    async () => {
      service = new VoiceTranscriptionService();

      const events: VoiceTranscriptionEvent[] = [];
      service.onEvent((event) => events.push(event));

      const result = await service.start({
        enabled: true,
        deepgramApiKey: DEEPGRAM_API_KEY,
        correctionApiKey: "",
        language: "en",
        customDictionary: [],
        transcriptionModel: "nova-3",
        correctionEnabled: false,
        correctionModel: "gpt-5-nano",
        correctionCustomInstructions: "",
      });

      expect(result).toEqual({ ok: true });
      expect(events.some((e) => e.type === "status" && e.status === "recording")).toBe(true);

      // Wait for any async server errors (e.g. invalid session config)
      await delay(2000);

      const errors = events.filter((e) => e.type === "error");
      if (errors.length > 0) {
        throw new Error(`Server returned error: ${(errors[0] as { message: string }).message}`);
      }

      service.stop();
      expect(events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    },
    15_000
  );
});
