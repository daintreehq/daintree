/**
 * The on-device speech model: NVIDIA's Nemotron 3.5 ASR Streaming 0.6B
 * (OpenMDW-1.1), as onnx-community's INT4 ONNX export for 560 ms chunks,
 * pinned to one revision. Every file it loads is pinned by size and SHA-256;
 * nothing else is ever read from its folder.
 */
import { normalizeVoiceLanguage, VOICE_LANGUAGE_AUTO } from "../../../shared/config/voiceLanguages.js";

export interface LocalSpeechFileSpec {
  name: string;
  size: number;
  sha256: string;
}

export const LOCAL_SPEECH_MODEL = {
  id: "onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4",
  revision: "8364d9e2dd9da23789b480bdbba9e423717e42ee",
  files: [
    {
      name: "encoder.onnx",
      size: 2_677_548,
      sha256: "0b05217594ec0bda442e43a90a298ac2471a3bdcea9b169de34214e61a730e17",
    },
    {
      name: "encoder.onnx.data",
      size: 690_089_984,
      sha256: "2f27295855aeb99ab1f8cd2254418d9ad7a087ea8dbe85f5596b4d887ea7d630",
    },
    {
      name: "decoder.onnx",
      size: 4_696,
      sha256: "6a9f608dcbab71ebd81ffa4c198e82a5b6bb10f1c1830a94c752c5f543454df3",
    },
    {
      name: "decoder.onnx.data",
      size: 59_785_216,
      sha256: "e5fd55cbeeb268f9d383e2ee72735b9fbbb13aea4bc7cd38cb73b8e16f1366c7",
    },
    {
      name: "joint.onnx",
      size: 2_136,
      sha256: "e2c7d2fa40a243bf82eaca36c15698c52129de9361d2875d7f223f67fcd9482d",
    },
    {
      name: "joint.onnx.data",
      size: 37_830_656,
      sha256: "2e0fb1c060f3777a1a76e78d5589dd54f01505a06dffbd2588e315508b402c12",
    },
    {
      name: "vocab.txt",
      size: 64_024,
      sha256: "ca88922ac5a92c911b79985b69634d7a4c2ef604d61b71bbe2982210dd77cd43",
    },
  ] satisfies LocalSpeechFileSpec[],
} as const;

export const LOCAL_SPEECH_MODEL_BYTES: number = LOCAL_SPEECH_MODEL.files.reduce(
  (sum, file) => sum + file.size,
  0
);

/** The export's streaming geometry and the network sizes its tensors carry. */
export const LOCAL_SPEECH_GEOMETRY = {
  sampleRate: 16_000,
  /** 560 ms: what this export was built for. */
  chunkSamples: 8_960,
  /** Mel rows of the previous chunk the encoder sees again. */
  preEncodeCacheRows: 9,
  numMels: 128,
  layers: 24,
  hidden: 1_024,
  leftContext: 56,
  convContext: 8,
  decoderLayers: 2,
  decoderHidden: 640,
  vocabSize: 13_088,
  blankId: 13_087,
  maxSymbolsPerStep: 10,
} as const;

/**
 * The model's prompt ids for the languages Settings offers (from the base
 * model's `processor_config.json`). Auto-detect has its own id.
 */
const PROMPT_IDS: Record<string, number> = {
  [VOICE_LANGUAGE_AUTO]: 101,
  en: 0,
  es: 3,
  fr: 8,
  de: 9,
  ja: 10,
  zh: 4,
  ko: 14,
  pt: 13,
  it: 15,
  ru: 11,
};

/** The prompt id for a Settings language; one the model doesn't know is left to Auto-detect. */
export function localSpeechPromptId(language: unknown): number {
  return PROMPT_IDS[normalizeVoiceLanguage(language)] ?? PROMPT_IDS[VOICE_LANGUAGE_AUTO];
}
