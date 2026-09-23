import { useCallback, useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Eye, EyeOff, Plus, X, Check, AlertCircle, ExternalLink, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSelect } from "./SettingsSelect";
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

const TRANSCRIPTION_PROVIDERS: {
  value: VoiceTranscriptionProvider;
  label: string;
  description: string;
}[] = [
  {
    value: "openai",
    label: "OpenAI",
    description: "Live Transcribe · keyword biasing · spoken-command formatting",
  },
  {
    value: "deepgram",
    label: "Deepgram",
    description: "Nova-3 · server-side turn detection",
  },
];

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

type ApiKeyValidation = "idle" | "testing" | "valid" | "invalid";

type ConclusiveMicStatus = "granted" | "denied" | "restricted";

/** Only these settle the question; not-determined and unknown leave it open. */
function isConclusive(status: MicPermissionStatus | undefined): status is ConclusiveMicStatus {
  return status === "granted" || status === "denied" || status === "restricted";
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

  const update = (patch: Partial<VoiceInputSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electron?.voiceInput
        ?.setSettings(patch)
        .then(() => dispatchVoiceInputSettingsChanged(next))
        .catch(() => setSettings(prev));
      return next;
    });
  };

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
    update({ customDictionary: next });
    setNewDictionaryWord("");
    dictionaryInputRef.current?.focus();
  };

  const removeDictionaryWord = (word: string) => {
    update({ customDictionary: settings.customDictionary.filter((w) => w !== word) });
  };

  // Suggestions live in voiceInput settings, so accept/dismiss are plain
  // settings mutations through `update` — accept moves the word into the
  // confirmed dictionary, dismiss just drops it from the queue.
  const acceptSuggestion = (word: string) => {
    update({
      suggestedDictionary: settings.suggestedDictionary.filter((e) => e.word !== word),
      customDictionary: settings.customDictionary.includes(word)
        ? settings.customDictionary
        : [...settings.customDictionary, word],
    });
  };

  const dismissSuggestion = (word: string) => {
    update({ suggestedDictionary: settings.suggestedDictionary.filter((e) => e.word !== word) });
  };

  useSettingsTabValidation("voice", Boolean(loadError));

  return (
    <div className="space-y-8">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <SettingsSection
        title="Speech-to-text"
        description="Real-time transcription. Requires a provider API key and microphone access."
        id="voice-speech-to-text"
      >
        <SettingsGroup>
          <SettingsSwitchCard
            id="voice-enable"
            title="Dictation"
            subtitle="Dictate commands using your microphone"
            isEnabled={settings.enabled}
            onChange={() => update({ enabled: !settings.enabled })}
            ariaLabel="Toggle voice input"
            disabled={isLoading}
          />

          {settings.enabled && (
            <SettingsDependents>
              <MicPermissionRow
                status={micPermission}
                isRequesting={isRequestingMic}
                onRequest={handleRequestMicPermission}
                onOpenSettings={handleOpenMicSettings}
                onRefresh={handleRefreshMicPermission}
              />

              <SettingsSelect
                label="Microphone"
                description={
                  <>
                    {devicesError
                      ? devicesError
                      : devicesLoading
                        ? "Detecting devices…"
                        : "The input device used for dictation"}{" "}
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
                onValueChange={(v) => update({ deviceId: v === SYSTEM_DEFAULT_VALUE ? "" : v })}
                options={devices}
                disabled={devicesLoading && devices.length <= 1}
              />

              <SettingsSelect
                label="Transcription provider"
                description={
                  settings.transcriptionProvider === "deepgram"
                    ? "Microphone audio is streamed over an encrypted connection to Deepgram for transcription using your API key. Deepgram does not retain streaming audio or transcripts by default."
                    : "Microphone audio is streamed over an encrypted connection to OpenAI for transcription using your API key. Audio is not used for model training. OpenAI may retain audio in abuse-monitoring logs for up to 30 days."
                }
                value={settings.transcriptionProvider}
                onValueChange={(v) => {
                  // Narrow the select's string value to the union via a guard
                  // rather than an unsafe assertion.
                  if (v === "openai" || v === "deepgram") update({ transcriptionProvider: v });
                }}
                options={TRANSCRIPTION_PROVIDERS.map(({ value, label, description }) => ({
                  value,
                  label,
                  description,
                }))}
              />

              {settings.transcriptionProvider === "deepgram" ? (
                <ApiKeyRow
                  label="Deepgram API key"
                  value={settings.deepgramApiKey}
                  placeholder="Deepgram API key"
                  onSave={(key) => update({ deepgramApiKey: key })}
                  helpUrl="https://console.deepgram.com/"
                  helpLabel="Get API key"
                  description={
                    settings.deepgramApiKey
                      ? "Your API key is stored locally in plain text. Set usage limits on your Deepgram account to cap exposure."
                      : undefined
                  }
                />
              ) : (
                <ApiKeyRow
                  id="voice-stt-openai-key"
                  label="OpenAI API key"
                  value={settings.openaiApiKey}
                  placeholder="sk-..."
                  onSave={(key) => update({ openaiApiKey: key })}
                  onValidate={(key) => window.electron?.voiceInput?.validateApiKey(key)}
                  helpUrl="https://platform.openai.com/api-keys"
                  helpLabel="Get API key"
                  description={
                    <>
                      {(!settings.openaiApiKey ||
                        !settings.openaiApiKey.startsWith("sk-proj-")) && (
                        <span className="block">
                          Use a Project API key (starts with{" "}
                          <code className="font-mono">sk-proj-</code>) for the best security.
                        </span>
                      )}
                      {settings.openaiApiKey && (
                        <span className="block">
                          Your API key is stored locally in plain text. Set billing limits on your
                          OpenAI account to cap exposure.
                        </span>
                      )}
                    </>
                  }
                />
              )}

              {settings.openaiApiKey && <AdvancedRows settings={settings} update={update} />}

              <SettingsSelect
                id="voice-language"
                label="Language"
                value={settings.language}
                onValueChange={(v) => update({ language: v })}
                options={LANGUAGES.map(({ code, label }) => ({ value: code, label }))}
              />

              <ParagraphingStrategyRow
                value={settings.paragraphingStrategy ?? "spoken-command"}
                language={settings.language}
                onChange={(v) => update({ paragraphingStrategy: v })}
              />

              <RecordingModeRow
                value={settings.recordingMode ?? "toggle"}
                onChange={(v) => update({ recordingMode: v })}
              />
            </SettingsDependents>
          )}
        </SettingsGroup>
      </SettingsSection>

      {settings.enabled && (
        <SettingsSection
          title="Custom dictionary"
          description="Domain-specific terms sent to the transcription service to boost recognition accuracy."
          id="voice-custom-dictionary"
        >
          <DictionaryGroup
            words={settings.customDictionary}
            suggestedWords={settings.suggestedDictionary}
            learnFromCorrections={settings.learnFromCorrections}
            onLearnFromCorrectionsChange={(v) => update({ learnFromCorrections: v })}
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
          description="Post-process transcriptions with GPT-5.6 Luna to fix technical terms, punctuation, and filler words. Optional."
          id="voice-ai-correction"
        >
          <SettingsGroup>
            <SettingsSwitchCard
              id="voice-ai-correction-enable"
              title="Clean up transcriptions"
              subtitle="Correct each transcription automatically after dictation"
              isEnabled={settings.correctionEnabled}
              onChange={() => update({ correctionEnabled: !settings.correctionEnabled })}
              ariaLabel="Toggle AI text correction"
            />

            {settings.correctionEnabled && settings.openaiApiKey && (
              <SettingsDependents>
                <SettingsSwitchCard
                  title="Resolve file references"
                  subtitle={
                    'Voice commands like "link to the input component" insert @file references'
                  }
                  isEnabled={settings.resolveFileLinks}
                  onChange={() => update({ resolveFileLinks: !settings.resolveFileLinks })}
                  ariaLabel="Toggle file reference resolution from voice commands"
                />

                <CustomInstructionsRow
                  value={settings.correctionCustomInstructions}
                  onChange={(v) => update({ correctionCustomInstructions: v })}
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

interface ApiKeyRowProps {
  id?: string;
  label: string;
  description?: ReactNode;
  value: string;
  placeholder: string;
  onSave: (key: string) => void;
  /**
   * Remote key validation. When omitted (e.g. providers without a validation
   * endpoint), the key is saved without a remote check.
   */
  onValidate?: (key: string) => Promise<{ valid: boolean; error?: string } | undefined> | undefined;
  helpUrl: string;
  helpLabel: string;
}

function ApiKeyRow({
  id,
  label,
  description,
  value,
  placeholder,
  onSave,
  onValidate,
  helpUrl,
  helpLabel,
}: ApiKeyRowProps) {
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [validation, setValidation] = useState<ApiKeyValidation>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (validation !== "valid") return;
    const timer = setTimeout(() => {
      setValidation("idle");
      setValidationError(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [validation]);

  const handleSave = async () => {
    const key = keyInput.trim();
    if (!key) return;
    // Providers without a validation endpoint save the key directly.
    if (!onValidate) {
      onSave(key);
      setKeyInput("");
      setValidation("valid");
      return;
    }
    setValidation("testing");
    setValidationError(null);
    try {
      const result = await onValidate(key);
      if (result?.valid) {
        onSave(key);
        setKeyInput("");
        setValidation("valid");
      } else {
        setValidation("invalid");
        setValidationError(result?.error || "Invalid API key");
      }
    } catch {
      setValidation("invalid");
      setValidationError("Failed to validate API key");
    }
  };

  const handleClear = () => {
    onSave("");
    setKeyInput("");
    setValidation("idle");
    setValidationError(null);
  };

  return (
    <SettingsRow
      id={id}
      label={label}
      description={description}
      layout="stacked"
      accessory={
        !value ? (
          <button
            type="button"
            onClick={() => window.electron?.system?.openExternal(helpUrl)}
            className="ml-auto text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline flex items-center gap-1"
          >
            {helpLabel}
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </button>
        ) : undefined
      }
      control={({ labelId, disabled }) => (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? "text" : "password"}
                value={keyInput}
                aria-labelledby={labelId}
                onChange={(e) => {
                  setKeyInput(e.target.value);
                  if (validation === "invalid") {
                    setValidation("idle");
                    setValidationError(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSave();
                  }
                }}
                placeholder={value ? "Enter new key to replace" : placeholder}
                className="w-full bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 pr-8 font-mono text-sm text-text-primary placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent/40 transition-colors"
                autoComplete="new-password"
                spellCheck={false}
                disabled={disabled || validation === "testing"}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
                aria-label={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <Button
              onClick={() => void handleSave()}
              disabled={disabled || !keyInput.trim()}
              loading={validation === "testing"}
              size="sm"
              variant="outline"
            >
              Save
            </Button>
            {value && (
              <Button
                onClick={handleClear}
                variant="outline"
                size="sm"
                disabled={disabled}
                className="text-text-secondary hover:text-status-error"
              >
                Clear
              </Button>
            )}
          </div>

          {validation === "valid" && (
            <p className="text-xs text-status-success flex items-center gap-1">
              <Check className="w-3 h-3" aria-hidden="true" />
              API key is valid
            </p>
          )}
          {validation === "invalid" && (
            <p className="text-xs text-status-error flex items-center gap-1">
              <AlertCircle className="w-3 h-3" aria-hidden="true" />
              {validationError || "Invalid API key"}
            </p>
          )}
        </div>
      )}
    />
  );
}

// ── Advanced rows (org/project ID for legacy keys) ──

function AdvancedRows({
  settings,
  update,
}: {
  settings: VoiceInputSettings;
  update: (patch: Partial<VoiceInputSettings>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLegacyKey = !!settings.openaiApiKey && !settings.openaiApiKey.startsWith("sk-proj-");
  const legacyReason = "Only used with legacy user keys (starting with sk-)";

  return (
    <>
      <SettingsRow
        label="Organization and project IDs"
        description={
          <>
            Only needed for legacy user keys (starts with <code className="font-mono">sk-</code>)
          </>
        }
        control={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <ChevronRight
              data-animated-chevron
              aria-hidden="true"
              className={cn("transition-transform duration-150", expanded && "rotate-90")}
            />
            {expanded ? "Hide" : "Show"}
          </Button>
        }
      />
      {expanded && (
        <>
          <SettingsInput
            label="Organization ID"
            value={settings.organizationId}
            onChange={(e) => update({ organizationId: e.target.value })}
            onBlur={(e) => update({ organizationId: e.target.value.trim() })}
            placeholder={isLegacyKey ? "org-..." : ""}
            disabled={!isLegacyKey}
            disabledReason={legacyReason}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <SettingsInput
            label="Project ID"
            value={settings.projectId}
            onChange={(e) => update({ projectId: e.target.value })}
            onBlur={(e) => update({ projectId: e.target.value.trim() })}
            placeholder={isLegacyKey ? "proj_..." : ""}
            disabled={!isLegacyKey}
            disabledReason={legacyReason}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}
    </>
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
            <button
              onClick={onRefresh}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Re-check
            </button>
          ),
        };
      case "denied":
      case "restricted": {
        const settingsLabel = isMac
          ? "System Settings"
          : isWindows
            ? "Windows Settings"
            : "System Settings";
        const settingsPath = isMac
          ? `System Settings → Privacy & Security → Microphone → enable ${appName}`
          : isWindows
            ? "Windows Settings → Privacy & security → Microphone → allow desktop app access"
            : "your system audio settings";
        return {
          dot: "bg-status-error",
          text: `Microphone ${status === "restricted" ? "restricted" : "denied"}`,
          description: `Open ${settingsPath}`,
          actions: (
            <div className="flex gap-2">
              <button
                onClick={onOpenSettings}
                className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline flex items-center gap-1"
              >
                Open {settingsLabel}
                <ExternalLink className="w-3 h-3" />
              </button>
              <button
                onClick={onRefresh}
                className="text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                Re-check
              </button>
            </div>
          ),
        };
      }
      case "not-determined":
        return {
          dot: "bg-status-warning",
          text: "Microphone permission not yet requested",
          actions: (
            <div className="flex gap-2">
              {(isMac || isWindows) && (
                <Button size="sm" variant="outline" onClick={onRequest} loading={isRequesting}>
                  Request access
                </Button>
              )}
            </div>
          ),
        };
      default:
        return {
          dot: "bg-text-muted",
          text: "Microphone status unknown",
          description: "Permission will be requested when you start recording.",
          actions: (
            <button
              onClick={onRefresh}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Re-check
            </button>
          ),
        };
    }
  })();

  return (
    <SettingsRow
      label="Microphone access"
      accessory={
        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
          <span className={cn("w-2 h-2 rounded-full shrink-0", statusDisplay.dot)} />
          {statusDisplay.text}
        </span>
      }
      description={statusDisplay.description}
      control={statusDisplay.actions}
    />
  );
}

// ── Paragraphing strategy row ──

function ParagraphingStrategyRow({
  value,
  language,
  onChange,
}: {
  value: VoiceParagraphingStrategy;
  language: string;
  onChange: (v: VoiceParagraphingStrategy) => void;
}) {
  const isNonEnglish = value === "spoken-command" && language !== "en";

  const description = isNonEnglish
    ? "Spoken commands require English. Manual Enter will be used for the selected language."
    : value === "spoken-command"
      ? 'Say "new paragraph" to insert a break. You can also press Enter to commit the current paragraph.'
      : "Press Enter to commit paragraph breaks. Spoken formatting commands are disabled.";

  return (
    <SettingsSelect
      id="voice-paragraph-breaks"
      label="Paragraph breaks"
      description={description}
      value={value}
      onValueChange={(v) => onChange(v as VoiceParagraphingStrategy)}
      options={[
        { value: "spoken-command", label: "Spoken commands" },
        { value: "manual", label: "Manual Enter only" },
      ]}
    />
  );
}

// ── Recording mode row ──

function RecordingModeRow({
  value,
  onChange,
}: {
  value: VoiceRecordingMode;
  onChange: (v: VoiceRecordingMode) => void;
}) {
  const description =
    value === "toggle"
      ? "Press the dictation shortcut to start, press again to stop."
      : "Hold the dictation shortcut to record. Releasing the key stops recording without submitting.";

  return (
    <SettingsSelect
      label="Recording mode"
      description={description}
      value={value}
      onValueChange={(v) => onChange(v as VoiceRecordingMode)}
      options={[
        { value: "toggle", label: "Toggle" },
        { value: "push-to-talk", label: "Push to talk" },
      ]}
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
        ariaLabel="Toggle learning words from corrections"
      />

      {suggestedWords.length > 0 && (
        <SettingsRow
          label="Suggested from corrections"
          layout="stacked"
          control={
            <div className="flex flex-wrap gap-1.5">
              {suggestedWords.map((entry) => (
                <span
                  key={entry.word}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-overlay-subtle px-2 py-0.5 text-xs text-text-primary"
                  title={entry.utterance ? `Heard as "${entry.utterance}"` : undefined}
                >
                  {entry.word}
                  <button
                    type="button"
                    onClick={() => onAcceptSuggestion(entry.word)}
                    className="inline-flex items-center gap-0.5 text-text-secondary hover:text-text-primary transition-colors"
                    aria-label={`Add ${entry.word} to dictionary`}
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismissSuggestion(entry.word)}
                    className="text-text-secondary hover:text-text-primary transition-colors"
                    aria-label={`Dismiss ${entry.word}`}
                  >
                    <X className="h-2.5 w-2.5" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          }
        />
      )}

      <SettingsRow
        label="Terms"
        description={
          words.length > 0 ? `${words.length} of 100` : "Add product names, APIs, or jargon"
        }
        layout="stacked"
        control={({ labelId }) => (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={newWord}
                aria-labelledby={labelId}
                onChange={(e) => onNewWordChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onAdd();
                  }
                }}
                placeholder="Add term…"
                className="flex-1 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-text-primary placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent/40 transition-colors"
              />
              <Button onClick={onAdd} disabled={!newWord.trim()} size="sm" variant="outline">
                <Plus aria-hidden="true" />
                Add
              </Button>
            </div>

            {words.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {words.map((word) => (
                  <span
                    key={word}
                    className="inline-flex items-center gap-1 rounded-full border border-border-default bg-surface-canvas px-2.5 py-0.5 text-xs text-text-primary"
                  >
                    {word}
                    <button
                      type="button"
                      onClick={() => onRemove(word)}
                      className="text-text-secondary hover:text-text-primary transition-colors"
                      aria-label={`Remove ${word}`}
                    >
                      <X className="h-2.5 w-2.5" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
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
      description="Project-specific rules appended to the core correction prompt"
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
            className="-ml-2"
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
