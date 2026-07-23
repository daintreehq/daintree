import { afterEach, describe, expect, it } from "vitest";
import { VoiceTranscriptionService } from "../VoiceTranscriptionService.js";
import type { VoiceTranscriptionEvent } from "../VoiceTranscriptionService.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VoiceTranscriptionService integration", () => {
  let service: VoiceTranscriptionService;

  afterEach(() => {
    service?.destroy();
  });

  it.skipIf(!OPENAI_API_KEY)(
    "connects to OpenAI realtime and session config is accepted",
    async () => {
      service = new VoiceTranscriptionService();

      const events: VoiceTranscriptionEvent[] = [];
      service.onEvent((event) => events.push(event));

      const result = await service.start({
        enabled: true,
        openaiApiKey: OPENAI_API_KEY,
        deepgramApiKey: "",
        language: "en",
        customDictionary: [],
        transcriptionProvider: "openai",
        transcriptionModel: "gpt-realtime-whisper",
        correctionEnabled: false,
        correctionModel: "gpt-5.6-luna",
        correctionCustomInstructions: "",
        paragraphingStrategy: "spoken-command",
        resolveFileLinks: true,
        deviceId: "",
        organizationId: "",
        projectId: "",
        recordingMode: "toggle",
        suggestedDictionary: [],
        learnFromCorrections: true,
      });

      expect(result).toEqual({ ok: true });
      expect(events.some((e) => e.type === "status" && e.status === "recording")).toBe(true);

      // Wait for any async server errors (e.g. invalid session config)
      await delay(2000);

      const errors = events.filter((e) => e.type === "error");
      if (errors.length > 0) {
        const errEvent = errors[0] as { type: "error"; error: { message: string } };
        throw new Error(`Server returned error: ${errEvent.error.message}`);
      }

      service.stop();
      expect(events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    },
    15_000
  );
});
