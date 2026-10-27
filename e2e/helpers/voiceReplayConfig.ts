import { allFixtureTerms } from "./voiceReplayFixtures";

export type ReplayProvider = "openai" | "deepgram" | "grok";

const REPLAY_PROVIDERS: readonly ReplayProvider[] = ["openai", "deepgram", "grok"];

/** The env var each provider's key is read from. */
export const PROVIDER_KEY_VARIABLE: Readonly<Record<ReplayProvider, string>> = {
  openai: "OPENAI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  grok: "XAI_API_KEY",
};

/**
 * Chromium's default microphone processing (echo cancellation, noise
 * suppression and automatic gain, since the app asks for no constraints), or
 * all three off, merged into the app's own request by the capture wrapper.
 */
export type MicProcessing = "default" | "off";

const MIC_PROCESSING: readonly MicProcessing[] = ["default", "off"];

/** One arm of the benchmark: a provider, the settings it runs with, and the dictionary it starts with. */
export interface ReplayConfig {
  id: string;
  provider: ReplayProvider;
  /** Applied over `REPLAY_BASE_SETTINGS`; only `REPLAY_TUNABLE_SETTINGS` may appear. */
  settings: Record<string, unknown>;
  dictionary: string[];
  micProcessing: MicProcessing;
}

/**
 * Settings every session runs with. Correction, file-link resolution and
 * spoken paragraph commands all rewrite the transcript, and the benchmark
 * scores what the provider heard. Learning stays off so one session's draft
 * can't change the next one's dictionary.
 */
export const REPLAY_BASE_SETTINGS: Readonly<Record<string, unknown>> = {
  enabled: true,
  language: "en",
  correctionEnabled: false,
  paragraphingStrategy: "manual",
  resolveFileLinks: false,
  learnFromCorrections: false,
  recordingMode: "toggle",
  deviceId: "",
};

/**
 * The only settings a custom configuration may change. The app rewrites any
 * `transcriptionModel` to its one supported model, and the OpenAI delay tier
 * and segmentation aren't settings (`npm run perf voice-tuning` compares
 * those), so a config naming them would run unchanged and report a difference
 * that isn't there: they are refused. Microphone processing is varied by
 * `micProcessing`, beside the settings.
 */
export const REPLAY_TUNABLE_SETTINGS: ReadonlySet<string> = new Set(["language"]);

const DEFAULT_MIC = { micProcessing: "default" } as const;

export const REPLAY_PRESETS: Readonly<Record<string, Omit<ReplayConfig, "id">>> = {
  openai: { provider: "openai", settings: {}, dictionary: [], ...DEFAULT_MIC },
  deepgram: { provider: "deepgram", settings: {}, dictionary: [], ...DEFAULT_MIC },
  grok: { provider: "grok", settings: {}, dictionary: [], ...DEFAULT_MIC },
  "openai+terms": {
    provider: "openai",
    settings: {},
    dictionary: allFixtureTerms(),
    ...DEFAULT_MIC,
  },
  "deepgram+terms": {
    provider: "deepgram",
    settings: {},
    dictionary: allFixtureTerms(),
    ...DEFAULT_MIC,
  },
  "grok+terms": { provider: "grok", settings: {}, dictionary: allFixtureTerms(), ...DEFAULT_MIC },
  "openai+mic-off": { provider: "openai", settings: {}, dictionary: [], micProcessing: "off" },
};

export const DEFAULT_REPLAY_CONFIGS = ["openai", "deepgram", "grok"];

function validate(config: unknown, where: string): ReplayConfig {
  if (typeof config !== "object" || config === null) throw new Error(`${where}: not an object`);
  const {
    id,
    provider,
    settings = {},
    dictionary = [],
    micProcessing = "default",
  } = config as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) throw new Error(`${where}: missing id`);
  if (!REPLAY_PROVIDERS.includes(provider as ReplayProvider)) {
    throw new Error(
      `${where} (${id}): provider must be ${REPLAY_PROVIDERS.map((p) => `"${p}"`).join(", ")}`
    );
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error(`${where} (${id}): settings must be an object`);
  }
  const refused = Object.keys(settings).filter((key) => !REPLAY_TUNABLE_SETTINGS.has(key));
  if (refused.length > 0) {
    throw new Error(
      `${where} (${id}): can't vary ${refused.join(", ")}; tunable settings are ${[
        ...REPLAY_TUNABLE_SETTINGS,
      ].join(", ")}`
    );
  }
  if (!Array.isArray(dictionary) || dictionary.some((term) => typeof term !== "string")) {
    throw new Error(`${where} (${id}): dictionary must be a list of terms`);
  }
  if (!MIC_PROCESSING.includes(micProcessing as MicProcessing)) {
    throw new Error(
      `${where} (${id}): micProcessing must be ${MIC_PROCESSING.map((m) => `"${m}"`).join(" or ")}`
    );
  }
  return {
    id,
    provider: provider as ReplayProvider,
    settings: settings as Record<string, unknown>,
    dictionary,
    micProcessing: micProcessing as MicProcessing,
  };
}

/**
 * The configurations a run asks for: preset names from `VOICE_REPLAY_CONFIGS`
 * (comma-separated), plus every entry of the JSON array in
 * `VOICE_REPLAY_CONFIG_FILE`. Ids must be unique, since results are keyed by them.
 */
export function resolveReplayConfigs(
  env: Record<string, string | undefined>,
  readFile: (file: string) => string
): ReplayConfig[] {
  const names = (env.VOICE_REPLAY_CONFIGS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const file = env.VOICE_REPLAY_CONFIG_FILE?.trim();
  const configs: ReplayConfig[] = [];
  for (const name of names.length > 0 || file ? names : DEFAULT_REPLAY_CONFIGS) {
    const preset = REPLAY_PRESETS[name];
    if (!preset) {
      throw new Error(
        `unknown config "${name}"; presets are ${Object.keys(REPLAY_PRESETS).join(", ")}`
      );
    }
    configs.push({ id: name, ...preset, dictionary: [...preset.dictionary] });
  }
  if (file) {
    const parsed = JSON.parse(readFile(file)) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of configs`);
    parsed.forEach((entry, index) => configs.push(validate(entry, `${file}[${index}]`)));
  }
  const seen = new Set<string>();
  for (const { id } of configs) {
    if (seen.has(id)) throw new Error(`config id "${id}" appears twice`);
    seen.add(id);
  }
  return configs;
}

/** The app reads keys from these env vars ahead of its stored settings, so keys never touch a config file. */
export function providerKeyEnv(
  provider: ReplayProvider,
  env: Record<string, string | undefined>
): Record<string, string> | null {
  if (provider === "openai") {
    const key = (env.OPENAI_API_KEY || env.WHISPER_API_KEY)?.trim();
    return key ? { WHISPER_API_KEY: key } : null;
  }
  const variable = PROVIDER_KEY_VARIABLE[provider];
  const key = env[variable]?.trim();
  return key ? { [variable]: key } : null;
}
