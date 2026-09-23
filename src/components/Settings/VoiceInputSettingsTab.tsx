import { useCallback, useState, useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { Eye, EyeOff, Plus, X, Check, AlertCircle, ExternalLink, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import { SettingsTextarea } from "./SettingsTextarea";
import { SettingsInput } from "./SettingsInput";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { dispatchVoiceInputSettingsChanged } from "@/lib/voiceInputSettingsEvents";
import { logWarn } from "@/utils/logger";
import { useAudioDevices, SYSTEM_DEFAULT_VALUE } from "@/hooks/useAudioDevices";
import { useTabLoad } from "@/hooks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { CORE_CORRECTION_PROMPT, VOICE_DICTATION_AI_MODEL } from "@shared/config/voiceCorrection";
import type {
  VoiceInputSettings,
  SuggestedDictionaryEntry,
  MicPermissionStatus,
  VoiceParagraphingStrategy,
  VoiceTranscriptionProvider,
  VoiceRecordingMode,
} from "@shared/types";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "ko", label: "Korean" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ru", label: "Russian" },
];

const PROVIDER_NAME: Record<VoiceTranscriptionProvider, string> = {
  openai: "OpenAI",
  deepgram: "Deepgram",
};

const PROVIDER_OPTIONS = [
  { value: "openai" as const, label: "OpenAI" },
  { value: "deepgram" as const, label: "Deepgram" },
];

const PROVIDER_PRIVACY: Record<VoiceTranscriptionProvider, string> = {
  openai:
    "Microphone audio is streamed over an encrypted connection to OpenAI for transcription using your API key. Audio is not used for model training. OpenAI may retain audio in abuse-monitoring logs for up to 30 days.",
  deepgram:
    "Microphone audio is streamed over an encrypted connection to Deepgram for transcription using your API key. Deepgram does not retain streaming audio or transcripts by default.",
};

const DICTIONARY_LIMIT = 100;

const DEFAULT_SETTINGS: VoiceInputSettings = {
  enabled: false,
  openaiApiKey: "",
  deepgramApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionModel: VOICE_DICTATION_AI_MODEL,
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [],
  learnFromCorrections: true,
};

type SaveGroup = "setup" | "behavior" | "dictionary" | "correction";

const SAVE_GROUP_BY_KEY: Partial<Record<keyof VoiceInputSettings, SaveGroup>> = {
  language: "behavior",
  paragraphingStrategy: "behavior",
  recordingMode: "behavior",
  customDictionary: "dictionary",
  suggestedDictionary: "dictionary",
  learnFromCorrections: "dictionary",
  correctionEnabled: "correction",
  correctionCustomInstructions: "correction",
  resolveFileLinks: "correction",
};

const SETTING_KEYS: readonly (keyof VoiceInputSettings)[] = [
  "enabled",
  "openaiApiKey",
  "deepgramApiKey",
  "language",
  "customDictionary",
  "transcriptionProvider",
  "transcriptionModel",
  "correctionEnabled",
  "correctionModel",
  "correctionCustomInstructions",
  "paragraphingStrategy",
  "resolveFileLinks",
  "deviceId",
  "organizationId",
  "projectId",
  "recordingMode",
  "suggestedDictionary",
  "learnFromCorrections",
];

function patchedKeys(patch: Partial<VoiceInputSettings>): (keyof VoiceInputSettings)[] {
  return SETTING_KEYS.filter((key) => key in patch);
}

function saveGroupOf(patch: Partial<VoiceInputSettings>): SaveGroup {
  for (const key of patchedKeys(patch)) {
    const group = SAVE_GROUP_BY_KEY[key];
    if (group) return group;
  }
  return "setup";
}

function copySetting<K extends keyof VoiceInputSettings>(
  target: VoiceInputSettings,
  source: VoiceInputSettings,
  key: K
): void {
  target[key] = source[key];
}

interface SaveFailure {
  group: SaveGroup;
  patch: Partial<VoiceInputSettings>;
}

type ConclusiveMicStatus = "granted" | "denied" | "restricted";

/** Only these settle the question; not-determined and unknown leave it open. */
function isConclusive(status: MicPermissionStatus | undefined): status is ConclusiveMicStatus {
  return status === "granted" || status === "denied" || status === "restricted";
}

/**
 * Enough of a stored key to recognise it by — its kind and last four characters — and
 * nothing a shoulder-surfer could use.
 */
export function maskApiKey(key: string): string {
  const tail = key.slice(-4);
  if (key.startsWith("sk-proj-")) return `sk-proj-…${tail}`;
  if (key.startsWith("sk-")) return `sk-…${tail}`;
  return `…${tail}`;
}

/**
 * What stands between the user and a working dictation session, as far as this page can
 * see it. Only observed facts: a key that is absent, a microphone the OS has refused. A
 * key that is present is not claimed to work.
 */
export function dictationBlockers(
  settings: Pick<VoiceInputSettings, "transcriptionProvider" | "openaiApiKey" | "deepgramApiKey">,
  micPermission: MicPermissionStatus
): string[] {
  const blockers: string[] = [];
  const key =
    settings.transcriptionProvider === "deepgram" ? settings.deepgramApiKey : settings.openaiApiKey;
  if (!key) blockers.push(`add a ${PROVIDER_NAME[settings.transcriptionProvider]} API key`);
  if (micPermission === "denied" || micPermission === "restricted") {
    blockers.push("allow microphone access");
  }
  return blockers;
}

/**
 * Opens the mic just long enough to settle permission, then releases it. This is
 * the only way to request access on platforms without a native request API.
 *
 * A refusal is the only outcome that means "denied" — a missing or busy device
 * fails too, and reporting that as a permission problem would send the user to
 * the privacy settings for a mic they don't have.
 */
async function probeMicCapture(): Promise<"granted" | "denied" | "unavailable"> {
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return "granted";
  } catch (err) {
    return err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "unavailable";
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export function VoiceInputSettingsTab() {
  const [settings, setSettings] = useState<VoiceInputSettings>(DEFAULT_SETTINGS);
  const [micPermission, setMicPermission] = useState<MicPermissionStatus>("unknown");
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  const [newDictionaryWord, setNewDictionaryWord] = useState("");
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const dictionaryInputRef = useRef<HTMLInputElement>(null);

  const {
    devices,
    loading: devicesLoading,
    error: devicesError,
    refresh: refreshDevices,
  } = useAudioDevices();

  const loadSettings = useCallback(async () => {
    const s = await window.electron?.voiceInput?.getSettings();
    // Merge over defaults so fields added after a settings blob was written
    // (e.g. suggestedDictionary, learnFromCorrections) are never undefined.
    if (s) setSettings({ ...DEFAULT_SETTINGS, ...s });
  }, []);

  const { isLoading, loadError, retryAction } = useTabLoad({
    initialize: loadSettings,
    errorMessage: "Couldn't load voice input settings",
    timeoutMessage: "Voice input settings took too long to load.",
  });

  useEffect(() => {
    window.electron?.voiceInput
      ?.checkMicPermission()
      .then((status) => {
        if (status) setMicPermission(status);
      })
      .catch((err) => {
        // Background probe — UI shows fallback "unknown" state.
        logWarn("Failed to check microphone permission", {
          error: formatErrorMessage(err, "Mic permission probe failed"),
        });
      });
  }, []);

  // Optimistic apply. A rejected save puts back the keys it touched (unless a later
  // change has already moved them) and parks the failure on the group it belongs to,
  // so the page never silently shows a value that did not persist.
  const update = async (patch: Partial<VoiceInputSettings>): Promise<boolean> => {
    const previous = settings;
    const group = saveGroupOf(patch);
    setSettings((current) => ({ ...current, ...patch }));
    try {
      await window.electron?.voiceInput?.setSettings(patch);
      dispatchVoiceInputSettingsChanged({ ...previous, ...patch });
      setSaveFailure((current) => (current?.group === group ? null : current));
      return true;
    } catch (err) {
      setSettings((current) => {
        const reverted: VoiceInputSettings = { ...current };
        for (const key of patchedKeys(patch)) {
          if (current[key] === patch[key]) copySetting(reverted, previous, key);
        }
        return reverted;
      });
      setSaveFailure({ group, patch });
      logWarn("Failed to save voice input settings", {
        error: formatErrorMessage(err, "Voice input save failed"),
      });
      return false;
    }
  };

  const saveError = (group: SaveGroup) =>
    saveFailure?.group === group ? (
      <SettingsLoadErrorBanner
        title="Couldn't save that change"
        message="The setting is back to its previous value."
        onRetry={() => void update(saveFailure.patch)}
      />
    ) : null;

  // Best-effort: a transient IPC failure is inconclusive, not an answer.
  const readMicPermission = async (): Promise<MicPermissionStatus | undefined> => {
    try {
      return await window.electron?.voiceInput?.checkMicPermission();
    } catch {
      return undefined;
    }
  };

  // Same: a failed preflight must not block the capture gate behind it.
  const runNativePreflight = async (): Promise<boolean | undefined> => {
    try {
      return await window.electron?.voiceInput?.requestMicPermission();
    } catch {
      return undefined;
    }
  };

  const handleRequestMicPermission = async () => {
    setIsRequestingMic(true);
    try {
      // macOS settles this natively. Windows/Linux have no main-process request
      // API — a `true` there only means "clear to attempt capture", so the OS
      // status stays unsettled and the capture probe below is the actual request.
      const canAttemptCapture = await runNativePreflight();

      const status = await readMicPermission();
      if (isConclusive(status)) {
        setMicPermission(status);
        return;
      }
      if (canAttemptCapture === false) {
        // Only macOS answers authoritatively, and it just refused — the OS status
        // simply hasn't caught up yet.
        setMicPermission("denied");
        return;
      }

      const probed = await probeMicCapture();
      const rechecked = await readMicPermission();
      // The OS can keep reporting not-determined (or unknown) even after capture
      // succeeds; trust what the attempt actually proved over an unsettled status.
      if (isConclusive(rechecked)) setMicPermission(rechecked);
      else if (probed !== "unavailable") setMicPermission(probed);
      else if (rechecked) setMicPermission(rechecked);
    } catch {
      // Non-fatal — the row keeps its last known status.
    } finally {
      setIsRequestingMic(false);
    }
  };

  const handleOpenMicSettings = () => {
    window.electron?.voiceInput?.openMicSettings();
  };

  const handleRefreshMicPermission = async () => {
    const status = await window.electron?.voiceInput?.checkMicPermission();
    if (status) setMicPermission(status);
  };

  const addDictionaryWord = () => {
    const word = newDictionaryWord.trim();
    if (!word || settings.customDictionary.includes(word)) return;
    const next = [...settings.customDictionary, word];
    void update({ customDictionary: next });
    setNewDictionaryWord("");
    dictionaryInputRef.current?.focus();
  };

  // The removed chip took focus with it; hand it to the field a keyboard user adds from.
  const removeDictionaryWord = (word: string) => {
    void update({ customDictionary: settings.customDictionary.filter((w) => w !== word) });
    dictionaryInputRef.current?.focus();
  };

  // Suggestions live in voiceInput settings, so accept/dismiss are plain
  // settings mutations through `update` — accept moves the word into the
  // confirmed dictionary, dismiss just drops it from the queue.
  const acceptSuggestion = (word: string) => {
    void update({
      suggestedDictionary: settings.suggestedDictionary.filter((e) => e.word !== word),
      customDictionary: settings.customDictionary.includes(word)
        ? settings.customDictionary
        : [...settings.customDictionary, word],
    });
    dictionaryInputRef.current?.focus();
  };

  const dismissSuggestion = (word: string) => {
    void update({
      suggestedDictionary: settings.suggestedDictionary.filter((e) => e.word !== word),
    });
    dictionaryInputRef.current?.focus();
  };

  useSettingsTabValidation("voice", Boolean(loadError || saveFailure));

  const provider = settings.transcriptionProvider;
  const blockers = dictationBlockers(settings, micPermission);
  const dictationSubtitle =
    settings.enabled && blockers.length > 0
      ? `Can't start yet: ${blockers.join(" and ")}`
      : "Dictate into terminals and inputs using your microphone";
  const isLegacyKey = !!settings.openaiApiKey && !settings.openaiApiKey.startsWith("sk-proj-");
  const hasOpenAiKey = !!settings.openaiApiKey;
  const spokenCommandsAvailable = settings.language === "en";
  const paragraphing = settings.paragraphingStrategy ?? "spoken-command";
  const effectiveParagraphing: VoiceParagraphingStrategy = spokenCommandsAvailable
    ? paragraphing
    : "manual";
  const recordingMode = settings.recordingMode ?? "toggle";

  const openAiKeyRow = (
    <ApiKeyRow
      id="voice-stt-openai-key"
      label="OpenAI API key"
      value={settings.openaiApiKey}
      placeholder="Paste an OpenAI API key"
      onSave={(key) => update({ openaiApiKey: key })}
      onValidate={(key) => window.electron?.voiceInput?.validateApiKey(key)}
      helpUrl="https://platform.openai.com/api-keys"
      description={
        isLegacyKey ? (
          <>
            This is a legacy user key. A Project API key (starts with{" "}
            <code className="font-mono">sk-proj-</code>) is scoped more tightly. Keys are stored
            locally in plain text, so set billing limits on your OpenAI account.
          </>
        ) : settings.openaiApiKey ? (
          "Stored locally in plain text. Set billing limits on your OpenAI account to cap exposure."
        ) : (
          <>
            Use a Project API key (starts with <code className="font-mono">sk-proj-</code>) for the
            best security.
          </>
        )
      }
    />
  );

  return (
    <div className="space-y-8">
      {loadError && (
        <SettingsLoadErrorBanner
          title="Couldn't load voice input settings"
          message={loadError}
          onRetry={retryAction}
        />
      )}

      <SettingsSection
        title="Speech-to-text"
        description="Real-time transcription with your own provider API key."
        id="voice-speech-to-text"
      >
        {saveError("setup")}
        <SettingsGroup>
          <SettingsSwitchCard
            id="voice-enable"
            title="Dictation"
            subtitle={dictationSubtitle}
            isEnabled={settings.enabled}
            onChange={() => void update({ enabled: !settings.enabled })}
            disabled={isLoading || Boolean(loadError)}
            disabledReason={
              loadError ? "Your saved setting couldn't be read. Retry above." : undefined
            }
          />

          {settings.enabled && (
            <SettingsDependents>
              <SettingsPresetGroup
                label="Transcription provider"
                description={PROVIDER_PRIVACY[provider]}
                options={PROVIDER_OPTIONS}
                value={provider}
                onChange={(v) => void update({ transcriptionProvider: v })}
              />

              {provider === "deepgram" ? (
                <ApiKeyRow
                  label="Deepgram API key"
                  value={settings.deepgramApiKey}
                  placeholder="Paste a Deepgram API key"
                  onSave={(key) => update({ deepgramApiKey: key })}
                  helpUrl="https://console.deepgram.com/"
                  description={
                    settings.deepgramApiKey
                      ? "Stored locally in plain text. Set usage limits on your Deepgram account to cap exposure."
                      : "Create one in the Deepgram console."
                  }
                />
              ) : (
                openAiKeyRow
              )}

              {provider === "openai" && isLegacyKey && (
                <>
                  <SettingsInput
                    label="Organization ID"
                    description="Only needed if your legacy key belongs to more than one organization"
                    value={settings.organizationId}
                    onChange={(e) => void update({ organizationId: e.target.value })}
                    onBlur={(e) => void update({ organizationId: e.target.value.trim() })}
                    placeholder="org-..."
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <SettingsInput
                    label="Project ID"
                    description="Bills transcription to one project instead of your default"
                    value={settings.projectId}
                    onChange={(e) => void update({ projectId: e.target.value })}
                    onBlur={(e) => void update({ projectId: e.target.value.trim() })}
                    placeholder="proj_..."
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </>
              )}
            </SettingsDependents>
          )}
        </SettingsGroup>

        {settings.enabled && (
          <SettingsGroup label="Microphone">
            <MicPermissionRow
              status={micPermission}
              isRequesting={isRequestingMic}
              onRequest={handleRequestMicPermission}
              onOpenSettings={handleOpenMicSettings}
              onRefresh={handleRefreshMicPermission}
            />

            <SettingsSelect
              label="Input device"
              description={
                <>
                  {devicesError
                    ? devicesError
                    : devicesLoading
                      ? "Detecting devices…"
                      : "The microphone dictation records from"}
                  {" · "}
                  <button
                    type="button"
                    onClick={refreshDevices}
                    className="text-text-secondary underline underline-offset-2 hover:text-text-primary transition-colors"
                  >
                    Refresh list
                  </button>
                </>
              }
              error={devicesError ?? undefined}
              value={settings.deviceId || SYSTEM_DEFAULT_VALUE}
              onValueChange={(v) => void update({ deviceId: v === SYSTEM_DEFAULT_VALUE ? "" : v })}
              options={devices}
              disabled={devicesLoading && devices.length <= 1}
            />
          </SettingsGroup>
        )}
      </SettingsSection>

      {settings.enabled && (
        <SettingsSection title="Behavior" id="voice-behavior">
          {saveError("behavior")}
          <SettingsGroup>
            <SettingsSelect
              id="voice-language"
              label="Language"
              description="The language you dictate in"
              value={settings.language}
              onValueChange={(v) => void update({ language: v })}
              options={LANGUAGES.map(({ code, label }) => ({ value: code, label }))}
              isModified={settings.language !== DEFAULT_SETTINGS.language}
              onReset={() => void update({ language: DEFAULT_SETTINGS.language })}
            />

            <SettingsPresetGroup
              id="voice-paragraph-breaks"
              label="Paragraph breaks"
              description={
                !spokenCommandsAvailable
                  ? "Spoken commands need English, so press Enter to start a new paragraph"
                  : effectiveParagraphing === "spoken-command"
                    ? 'Say "new paragraph", or press Enter to commit the current one'
                    : "Press Enter to start a new paragraph. Spoken formatting commands are off."
              }
              options={[
                {
                  value: "spoken-command" as const,
                  label: "Spoken commands",
                  disabled: !spokenCommandsAvailable,
                },
                { value: "manual" as const, label: "Enter only" },
              ]}
              value={effectiveParagraphing}
              onChange={(v) => void update({ paragraphingStrategy: v })}
              isModified={spokenCommandsAvailable && paragraphing !== "spoken-command"}
              onReset={() => void update({ paragraphingStrategy: "spoken-command" })}
            />

            <SettingsPresetGroup
              label="Recording mode"
              description={
                recordingMode === "toggle"
                  ? "Press the dictation shortcut to start, and again to stop"
                  : "Hold the dictation shortcut to record. Releasing it stops without submitting."
              }
              options={[
                { value: "toggle" as const, label: "Toggle" },
                { value: "push-to-talk" as const, label: "Push to talk" },
              ]}
              value={recordingMode}
              onChange={(v: VoiceRecordingMode) => void update({ recordingMode: v })}
              isModified={recordingMode !== DEFAULT_SETTINGS.recordingMode}
              onReset={() => void update({ recordingMode: DEFAULT_SETTINGS.recordingMode })}
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      {settings.enabled && (
        <SettingsSection
          title="Custom dictionary"
          description="Terms sent to the transcription service so it recognises your product names and jargon."
          id="voice-custom-dictionary"
        >
          {saveError("dictionary")}
          <DictionaryGroup
            words={settings.customDictionary}
            suggestedWords={settings.suggestedDictionary}
            learnFromCorrections={settings.learnFromCorrections}
            onLearnFromCorrectionsChange={(v) => void update({ learnFromCorrections: v })}
            onAcceptSuggestion={acceptSuggestion}
            onDismissSuggestion={dismissSuggestion}
            newWord={newDictionaryWord}
            onNewWordChange={setNewDictionaryWord}
            onAdd={addDictionaryWord}
            onRemove={removeDictionaryWord}
            inputRef={dictionaryInputRef}
          />
        </SettingsSection>
      )}

      {settings.enabled && (
        <SettingsSection
          title="AI text correction"
          description="Post-processes each transcription with GPT-5.6 Luna to fix technical terms, punctuation and filler words. The text is sent to OpenAI."
          id="voice-ai-correction"
        >
          {saveError("correction")}
          <SettingsGroup>
            <SettingsSwitchCard
              id="voice-ai-correction-enable"
              title="Clean up transcriptions"
              subtitle="Correct each transcription automatically after dictation"
              isEnabled={settings.correctionEnabled}
              onChange={() => void update({ correctionEnabled: !settings.correctionEnabled })}
            />

            {settings.correctionEnabled && provider === "deepgram" && (
              <SettingsDependents>{openAiKeyRow}</SettingsDependents>
            )}

            {settings.correctionEnabled && (
              <SettingsDependents
                disabled={!hasOpenAiKey}
                reason={
                  provider === "openai"
                    ? "Correction runs on OpenAI. Add the OpenAI API key above to use it."
                    : "Correction runs on OpenAI even while Deepgram transcribes. Add an OpenAI API key to use it."
                }
              >
                <SettingsSwitchCard
                  title="Resolve file references"
                  subtitle={
                    'Voice commands like "link to the input component" insert @file references'
                  }
                  isEnabled={settings.resolveFileLinks}
                  onChange={() => void update({ resolveFileLinks: !settings.resolveFileLinks })}
                  isModified={settings.resolveFileLinks !== DEFAULT_SETTINGS.resolveFileLinks}
                  onReset={() =>
                    void update({ resolveFileLinks: DEFAULT_SETTINGS.resolveFileLinks })
                  }
                />

                <CustomInstructionsRow
                  value={settings.correctionCustomInstructions}
                  onChange={(v) => void update({ correctionCustomInstructions: v })}
                />

                <CorePromptRow />
              </SettingsDependents>
            )}
          </SettingsGroup>
        </SettingsSection>
      )}
    </div>
  );
}

// ── API key row ──

type KeyStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "saved"; verified: boolean }
  | { kind: "invalid"; message: string }
  | { kind: "save-failed" };

interface ApiKeyRowProps {
  id?: string;
  label: string;
  description?: ReactNode;
  value: string;
  placeholder: string;
  /** Resolves once the key has persisted — `false` means it did not. */
  onSave: (key: string) => Promise<boolean>;
  /**
   * Remote key validation. When omitted (e.g. providers without a validation
   * endpoint), the key is saved without a remote check.
   */
  onValidate?: (key: string) => Promise<{ valid: boolean; error?: string } | undefined> | undefined;
  helpUrl: string;
}

/**
 * A secret the user brings. The row always says whether one is stored — masked to its
 * kind and last four characters — so a configured page and an empty one never look the
 * same. Save is the explicit exception to instant apply: the key is checked remotely
 * before it is kept, and the outcome stays on screen until the field is edited again.
 */
function ApiKeyRow({
  id,
  label,
  description,
  value,
  placeholder,
  onSave,
  onValidate,
  helpUrl,
}: ApiKeyRowProps) {
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [status, setStatus] = useState<KeyStatus>({ kind: "idle" });
  const statusId = useId();
  const testing = status.kind === "testing";

  const handleSave = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setStatus({ kind: "testing" });
    let verified = false;
    if (onValidate) {
      try {
        const result = await onValidate(key);
        if (!result?.valid) {
          setStatus({
            kind: "invalid",
            message: result?.error || "The provider rejected this key.",
          });
          return;
        }
        verified = true;
      } catch {
        setStatus({ kind: "invalid", message: "Couldn't reach the provider to check this key." });
        return;
      }
    }
    // Keep the draft until it has actually persisted, so a failed write can be retried.
    if (await onSave(key)) {
      setKeyInput("");
      setStatus({ kind: "saved", verified });
    } else {
      setStatus({ kind: "save-failed" });
    }
  };

  const handleRemove = async () => {
    setStatus({ kind: "idle" });
    await onSave("");
  };

  const statusLine =
    status.kind === "saved" ? (
      <>
        <Check className="w-3.5 h-3.5 shrink-0 text-status-success" aria-hidden="true" />
        {status.verified
          ? "Key checked and saved"
          : "Key saved. It's checked the first time you dictate."}
      </>
    ) : status.kind === "invalid" ? (
      <>
        <AlertCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        {status.message}
      </>
    ) : status.kind === "save-failed" ? (
      <>
        <AlertCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        Couldn't save the key. It's still in the field, so you can try Save again.
      </>
    ) : null;

  return (
    <SettingsRow
      id={id}
      label={label}
      description={description}
      layout="stacked"
      accessory={
        value ? (
          <span className="rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-1.5 py-0.5 font-mono text-2xs text-text-secondary">
            Saved · {maskApiKey(value)}
          </span>
        ) : (
          <span className="text-xs text-text-secondary">Not set</span>
        )
      }
      control={({ labelId, descriptionId, disabled }) => (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-64">
              <input
                type={showKey ? "text" : "password"}
                value={keyInput}
                aria-labelledby={labelId}
                aria-describedby={[descriptionId, statusId].filter(Boolean).join(" ")}
                aria-invalid={status.kind === "invalid" ? true : undefined}
                onChange={(e) => {
                  setKeyInput(e.target.value);
                  if (status.kind !== "idle" && status.kind !== "testing") {
                    setStatus({ kind: "idle" });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSave();
                  }
                }}
                placeholder={value ? "Paste a new key to replace the saved one" : placeholder}
                className="w-full bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 pr-9 font-mono text-sm text-text-primary placeholder:font-sans placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent/40 transition-colors"
                autoComplete="new-password"
                spellCheck={false}
                disabled={disabled || testing}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-secondary hover:text-text-primary transition-colors"
                aria-label={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
            <Button
              onClick={() => void handleSave()}
              disabled={disabled || !keyInput.trim()}
              loading={testing}
              size="sm"
              variant="contrast"
            >
              {onValidate ? "Check and save" : "Save"}
            </Button>
            {value ? (
              <Button
                onClick={() => void handleRemove()}
                variant="ghost-danger"
                size="sm"
                disabled={disabled || testing}
              >
                Remove key
              </Button>
            ) : (
              <Button
                onClick={() => window.electron?.system?.openExternal(helpUrl)}
                variant="ghost"
                size="sm"
              >
                Get a key
                <ExternalLink aria-hidden="true" />
              </Button>
            )}
          </div>

          <p
            id={statusId}
            role="status"
            aria-live="polite"
            className={cn(
              "flex items-start gap-1.5 text-xs text-text-primary",
              !statusLine && "sr-only"
            )}
          >
            {statusLine}
          </p>
        </div>
      )}
    />
  );
}

// ── Microphone permission row ──

interface MicPermissionRowProps {
  status: MicPermissionStatus;
  isRequesting: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
}

function MicPermissionRow({
  status,
  isRequesting,
  onRequest,
  onOpenSettings,
  onRefresh,
}: MicPermissionRowProps) {
  const ua = navigator.userAgent;
  const isMac = ua.includes("Mac OS X");
  const isWindows = ua.includes("Windows");
  const appName = process.env.NODE_ENV === "development" ? "Electron" : "Daintree";

  const statusDisplay = (() => {
    switch (status) {
      case "granted":
        return {
          dot: "bg-status-success",
          text: "Microphone access granted",
          actions: (
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              Re-check
            </Button>
          ),
        };
      case "denied":
      case "restricted": {
        const settingsLabel = isWindows ? "Windows Settings" : "System Settings";
        const settingsPath = isMac
          ? `Allow ${appName} under Privacy & Security → Microphone, then re-check.`
          : isWindows
            ? "Allow desktop apps under Privacy & security → Microphone, then re-check."
            : "Allow microphone access in your system audio settings, then re-check.";
        return {
          dot: "bg-status-error",
          text: `Microphone ${status === "restricted" ? "restricted" : "denied"}. ${settingsPath}`,
          actions: (
            <>
              <Button size="sm" variant="outline" onClick={onOpenSettings}>
                Open {settingsLabel}
                <ExternalLink aria-hidden="true" />
              </Button>
              <Button size="sm" variant="ghost" onClick={onRefresh}>
                Re-check
              </Button>
            </>
          ),
        };
      }
      case "not-determined":
        return {
          dot: "bg-status-warning",
          text: "Microphone permission not yet requested",
          actions:
            isMac || isWindows ? (
              <Button size="sm" variant="outline" onClick={onRequest} loading={isRequesting}>
                Request access
              </Button>
            ) : null,
        };
      default:
        return {
          dot: "bg-text-secondary",
          text: "Microphone status unknown. Permission is requested when you start recording.",
          actions: (
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              Re-check
            </Button>
          ),
        };
    }
  })();

  return (
    <SettingsRow
      label="Access"
      description={
        <span className="flex items-start gap-2">
          <span
            className={cn("status-mark mt-1 w-2 h-2 rounded-full shrink-0", statusDisplay.dot)}
            aria-hidden="true"
          />
          <span>{statusDisplay.text}</span>
        </span>
      }
      control={statusDisplay.actions}
    />
  );
}

// ── Dictionary group ──

function DictionaryGroup({
  words,
  suggestedWords,
  learnFromCorrections,
  onLearnFromCorrectionsChange,
  onAcceptSuggestion,
  onDismissSuggestion,
  newWord,
  onNewWordChange,
  onAdd,
  onRemove,
  inputRef,
}: {
  words: string[];
  suggestedWords: SuggestedDictionaryEntry[];
  learnFromCorrections: boolean;
  onLearnFromCorrectionsChange: (v: boolean) => void;
  onAcceptSuggestion: (word: string) => void;
  onDismissSuggestion: (word: string) => void;
  newWord: string;
  onNewWordChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (word: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <SettingsGroup>
      <SettingsSwitchCard
        title="Learn words from corrections"
        subtitle="Suggest dictionary terms when you fix a mishearing before sending"
        isEnabled={learnFromCorrections}
        onChange={() => onLearnFromCorrectionsChange(!learnFromCorrections)}
        isModified={learnFromCorrections !== DEFAULT_SETTINGS.learnFromCorrections}
        onReset={() => onLearnFromCorrectionsChange(DEFAULT_SETTINGS.learnFromCorrections)}
      />

      {suggestedWords.length > 0 && (
        <SettingsRow
          label="Suggested from corrections"
          description="Add a term to the dictionary, or dismiss it"
          layout="stacked"
          control={
            <ul className="flex flex-wrap gap-1.5">
              {suggestedWords.map((entry) => (
                <li
                  key={entry.word}
                  className="inline-flex items-center gap-0.5 rounded-full border border-border-default bg-overlay-subtle py-0.5 pl-2.5 pr-0.5 text-xs text-text-primary"
                  title={entry.utterance ? `Heard as "${entry.utterance}"` : undefined}
                >
                  <span className="mr-1">{entry.word}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="rounded-full"
                    onClick={() => onAcceptSuggestion(entry.word)}
                    aria-label={`Add ${entry.word} to dictionary`}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="rounded-full"
                    onClick={() => onDismissSuggestion(entry.word)}
                    aria-label={`Dismiss ${entry.word}`}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          }
        />
      )}

      <SettingsRow
        label="Terms"
        description={
          words.length > 0
            ? `${words.length} of ${DICTIONARY_LIMIT} terms`
            : "Add product names, APIs or jargon the transcription keeps getting wrong"
        }
        layout="stacked"
        control={({ labelId, descriptionId }) => (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={newWord}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                onChange={(e) => onNewWordChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onAdd();
                  }
                }}
                placeholder="Add a term…"
                className="flex-1 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent/40 transition-colors"
              />
              <Button onClick={onAdd} disabled={!newWord.trim()} size="sm" variant="outline">
                <Plus aria-hidden="true" />
                Add
              </Button>
            </div>

            {words.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {words.map((word) => (
                  <li
                    key={word}
                    className="inline-flex items-center gap-0.5 rounded-full border border-border-default bg-surface-canvas py-0.5 pl-2.5 pr-0.5 text-xs text-text-primary"
                  >
                    {word}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="rounded-full"
                      onClick={() => onRemove(word)}
                      aria-label={`Remove ${word}`}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      />
    </SettingsGroup>
  );
}

// ── Custom instructions row ──

function CustomInstructionsRow({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <SettingsTextarea
      rowId="voice-custom-instructions"
      label="Custom instructions"
      description="Your own rules, added to the core correction prompt in every project"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      placeholder='e.g., "Always capitalize ProductName as one word"'
      spellCheck={false}
    />
  );
}

// ── Core prompt row ──

function CorePromptRow() {
  const [expanded, setExpanded] = useState(false);

  return (
    <SettingsRow
      label="Core prompt"
      description="Your project name and custom dictionary are included automatically. Prompt caching keeps costs minimal."
      layout="stacked"
      control={
        <div className="space-y-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="-ml-3"
          >
            <ChevronRight
              data-animated-chevron
              aria-hidden="true"
              className={cn("transition-transform duration-150", expanded && "rotate-90")}
            />
            {expanded ? "Hide core prompt" : "Inspect core prompt"}
          </Button>
          {expanded && (
            <pre className="bg-surface-canvas border border-border-default rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-text-secondary whitespace-pre-wrap overflow-y-auto max-h-48 select-text">
              {CORE_CORRECTION_PROMPT}
            </pre>
          )}
        </div>
      }
    />
  );
}
