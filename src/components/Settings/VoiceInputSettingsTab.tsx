import { useCallback, useState, useEffect, useRef } from "react";
import {
  Mic,
  Eye,
  EyeOff,
  Plus,
  X,
  Key,
  BookText,
  Shield,
  Check,
  AlertCircle,
  ExternalLink,
  Sparkles,
  ChevronRight,
  FileSearch,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsTextarea } from "./SettingsTextarea";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { dispatchVoiceInputSettingsChanged } from "@/lib/voiceInputSettingsEvents";
import { logWarn } from "@/utils/logger";
import { useAudioDevices, SYSTEM_DEFAULT_VALUE } from "@/hooks/useAudioDevices";
import { useTabLoad } from "@/hooks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { CORE_CORRECTION_PROMPT } from "@shared/config/voiceCorrection";
import type {
  VoiceInputSettings,
  SuggestedDictionaryEntry,
  MicPermissionStatus,
  VoiceCorrectionModel,
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

const CORRECTION_MODELS: {
  value: VoiceCorrectionModel;
  label: string;
  description: string;
}[] = [
  {
    value: "gpt-5-mini",
    label: "GPT-5 Mini",
    description: "Higher quality · recommended",
  },
  {
    value: "gpt-5-nano",
    label: "GPT-5 Nano",
    description: "Faster · lower cost",
  },
];

const TRANSCRIPTION_PROVIDERS: {
  value: VoiceTranscriptionProvider;
  label: string;
  description: string;
}[] = [
  {
    value: "openai",
    label: "OpenAI",
    description: "Realtime Whisper · spoken-command formatting",
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
  transcriptionModel: "gpt-realtime-whisper",
  correctionEnabled: false,
  correctionModel: "gpt-5-mini",
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

/**
 * Opens the mic just long enough to settle permission, then releases it. This is
 * the only way to request access on platforms without a native request API.
 */
async function probeMicCapture(): Promise<boolean> {
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return true;
  } catch {
    return false;
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

  const handleRequestMicPermission = async () => {
    setIsRequestingMic(true);
    try {
      // macOS settles this natively. Windows/Linux have no main-process request
      // API — a `true` there only means "clear to attempt capture", so the OS
      // status stays not-determined and getUserMedia below is the actual request.
      const canAttemptCapture = await window.electron?.voiceInput?.requestMicPermission();
      let status = await window.electron?.voiceInput?.checkMicPermission();

      if (canAttemptCapture && (!status || status === "not-determined")) {
        const captured = await probeMicCapture();
        const rechecked = await window.electron?.voiceInput?.checkMicPermission();
        // Windows can keep reporting not-determined even after capture succeeds;
        // trust what the attempt actually proved over an inconclusive status.
        status =
          rechecked && rechecked !== "not-determined"
            ? rechecked
            : captured
              ? "granted"
              : "denied";
      }

      if (status) setMicPermission(status);
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
    <div className="space-y-6">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      {/* ── Speech-to-Text ── */}
      <SettingsSection
        icon={Mic}
        title="Speech-to-text"
        description="Real-time transcription. Requires a provider API key and microphone access."
        id="voice-speech-to-text"
      >
        <SettingsSwitchCard
          icon={Mic}
          title="Voice input"
          subtitle="Dictate commands using your microphone"
          isEnabled={settings.enabled}
          onChange={() => update({ enabled: !settings.enabled })}
          ariaLabel="Toggle voice input"
          disabled={isLoading}
        />

        {settings.enabled && (
          <div className="space-y-4">
            <MicPermissionRow
              status={micPermission}
              isRequesting={isRequestingMic}
              onRequest={handleRequestMicPermission}
              onOpenSettings={handleOpenMicSettings}
              onRefresh={handleRefreshMicPermission}
            />

            <SettingsSelect
              label="Transcription provider"
              description="The backend that turns your speech into text"
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

            <div
              role="note"
              className="rounded-[var(--radius-md)] border border-daintree-border/60 bg-daintree-bg/40 p-3"
            >
              <p className="text-xs text-daintree-text/60 select-text">
                {settings.transcriptionProvider === "deepgram"
                  ? "Microphone audio is streamed over an encrypted connection to Deepgram for transcription using your API key. Deepgram does not retain streaming audio or transcripts by default."
                  : "Microphone audio is streamed over an encrypted connection to OpenAI for transcription using your API key. Audio is not used for model training. OpenAI may retain audio in abuse-monitoring logs for up to 30 days."}
              </p>
            </div>

            <div className="flex items-center justify-between">
              <SettingsSelect
                label="Microphone"
                description={
                  devicesError
                    ? devicesError
                    : devicesLoading
                      ? "Detecting devices..."
                      : "Select which microphone to use for dictation"
                }
                error={devicesError ?? undefined}
                value={settings.deviceId || SYSTEM_DEFAULT_VALUE}
                onValueChange={(v) => update({ deviceId: v === SYSTEM_DEFAULT_VALUE ? "" : v })}
                options={devices}
                disabled={devicesLoading && devices.length <= 1}
              />
              <button
                type="button"
                onClick={refreshDevices}
                className="mt-0.5 p-1.5 rounded-sm text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
                aria-label="Refresh microphone list"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>

            {settings.transcriptionProvider === "deepgram" ? (
              <>
                <ApiKeyRow
                  label="Deepgram API Key"
                  value={settings.deepgramApiKey}
                  placeholder="Deepgram API key"
                  onSave={(key) => update({ deepgramApiKey: key })}
                  helpUrl="https://console.deepgram.com/"
                  helpLabel="Get API key"
                />

                {settings.deepgramApiKey && (
                  <p className="text-xs text-daintree-text/50 mt-1">
                    Your API key is stored locally in plain text. Set usage limits on your Deepgram
                    account to cap exposure.
                  </p>
                )}
              </>
            ) : (
              <>
                <ApiKeyRow
                  label="OpenAI API Key"
                  value={settings.openaiApiKey}
                  placeholder="sk-..."
                  onSave={(key) => update({ openaiApiKey: key })}
                  onValidate={(key) => window.electron?.voiceInput?.validateApiKey(key)}
                  helpUrl="https://platform.openai.com/api-keys"
                  helpLabel="Get API key"
                />

                {(!settings.openaiApiKey || !settings.openaiApiKey.startsWith("sk-proj-")) && (
                  <p className="text-xs text-daintree-text/50">
                    Use a Project API key (starts with <code className="font-mono">sk-proj-</code>)
                    for the best security
                  </p>
                )}

                {settings.openaiApiKey && (
                  <p className="text-xs text-daintree-text/50 mt-1">
                    Your API key is stored locally in plain text. Set billing limits on your OpenAI
                    account to cap exposure.
                  </p>
                )}
              </>
            )}

            {settings.openaiApiKey && <AdvancedSection settings={settings} update={update} />}

            <SettingsSelect
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

            <DictionarySection
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
          </div>
        )}
      </SettingsSection>

      {/* ── AI Text Correction ── */}
      {settings.enabled && (
        <SettingsSection
          icon={Sparkles}
          title="AI text correction"
          description="Post-process transcriptions with a GPT-5 reasoning model to fix technical terms, punctuation, and filler words. Optional."
          id="voice-ai-correction"
        >
          <SettingsSwitchCard
            icon={Sparkles}
            title="AI text correction"
            subtitle="Clean up transcriptions automatically after dictation"
            isEnabled={settings.correctionEnabled}
            onChange={() => update({ correctionEnabled: !settings.correctionEnabled })}
            ariaLabel="Toggle AI text correction"
          />

          {settings.correctionEnabled && (
            <div className="space-y-4">
              <SettingsSelect
                label="Correction Model"
                value={settings.correctionModel}
                onValueChange={(v) => update({ correctionModel: v as VoiceCorrectionModel })}
                options={CORRECTION_MODELS.map(({ value, label, description }) => ({
                  value,
                  label,
                  description,
                }))}
              />

              {settings.openaiApiKey && (
                <>
                  <SettingsSwitchCard
                    icon={FileSearch}
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

                  <CorePromptViewer />

                  <p className="text-xs text-daintree-text/40">
                    Your project name and custom dictionary are included automatically. Prompt
                    caching keeps costs minimal.
                  </p>
                </>
              )}
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  );
}

// ── API key row ──

interface ApiKeyRowProps {
  label: string;
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
  label,
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm text-daintree-text/70 flex items-center gap-2">
          <Key className="w-3.5 h-3.5 text-daintree-text/50" aria-hidden="true" />
          {label}
        </label>
        <div className="flex items-center gap-2">
          {value ? (
            <span className="flex items-center gap-1 text-xs text-status-success">
              <Check className="w-3 h-3" />
              Configured
            </span>
          ) : (
            <button
              onClick={() => window.electron?.system?.openExternal(helpUrl)}
              className="text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline flex items-center gap-1"
            >
              {helpLabel}
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={showKey ? "text" : "password"}
            value={keyInput}
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
            className="w-full bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 pr-8 font-mono text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent transition-colors"
            autoComplete="new-password"
            spellCheck={false}
            disabled={validation === "testing"}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-daintree-text/40 hover:text-daintree-text/70"
            aria-label={showKey ? "Hide API key" : "Show API key"}
          >
            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <Button
          onClick={() => void handleSave()}
          disabled={!keyInput.trim()}
          loading={validation === "testing"}
          size="sm"
          variant="outline"
          className="text-daintree-text border-daintree-border hover:bg-daintree-border"
        >
          Save
        </Button>
        {value && (
          <Button
            onClick={handleClear}
            variant="outline"
            size="sm"
            className="text-daintree-text/50 border-daintree-border hover:text-status-error hover:border-status-error/30"
          >
            Clear
          </Button>
        )}
      </div>

      {validation === "valid" && (
        <p className="text-xs text-status-success flex items-center gap-1">
          <Check className="w-3 h-3" />
          API key is valid
        </p>
      )}
      {validation === "invalid" && (
        <p className="text-xs text-status-error flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {validationError || "Invalid API key"}
        </p>
      )}
    </div>
  );
}

// ── Advanced section (org/project ID for legacy keys) ──

function AdvancedSection({
  settings,
  update,
}: {
  settings: VoiceInputSettings;
  update: (patch: Partial<VoiceInputSettings>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLegacyKey = settings.openaiApiKey && !settings.openaiApiKey.startsWith("sk-proj-");

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-daintree-text/40 hover:text-daintree-text/60 transition-colors"
      >
        <ChevronRight
          data-animated-chevron
          className={cn("w-3.5 h-3.5 transition-transform duration-150", expanded && "rotate-90")}
        />
        Advanced
      </button>
      {expanded && (
        <div className="space-y-3">
          <p className="text-xs text-daintree-text/40">
            Only needed for legacy user keys (starts with <code className="font-mono">sk-</code>).
          </p>
          <div className="space-y-1.5">
            <label className="text-sm text-daintree-text/70 flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-daintree-text/50" aria-hidden="true" />
              Organization ID
            </label>
            <input
              type="text"
              value={settings.organizationId}
              onChange={(e) => update({ organizationId: e.target.value })}
              onBlur={(e) => update({ organizationId: e.target.value.trim() })}
              placeholder={isLegacyKey ? "org-..." : ""}
              disabled={!isLegacyKey}
              className="w-full bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 font-mono text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent transition-colors disabled:opacity-50"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-daintree-text/70 flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-daintree-text/50" aria-hidden="true" />
              Project ID
            </label>
            <input
              type="text"
              value={settings.projectId}
              onChange={(e) => update({ projectId: e.target.value })}
              onBlur={(e) => update({ projectId: e.target.value.trim() })}
              placeholder={isLegacyKey ? "proj_..." : ""}
              disabled={!isLegacyKey}
              className="w-full bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 font-mono text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent transition-colors disabled:opacity-50"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </div>
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
              className="text-xs text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
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
                className="text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline flex items-center gap-1"
              >
                Open {settingsLabel}
                <ExternalLink className="w-3 h-3" />
              </button>
              <button
                onClick={onRefresh}
                className="text-xs text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRequest}
                  loading={isRequesting}
                  className="text-daintree-text border-daintree-border hover:bg-daintree-border"
                >
                  <Mic className="w-3.5 h-3.5" />
                  Request
                </Button>
              )}
            </div>
          ),
        };
      default:
        return {
          dot: "bg-daintree-text/30",
          text: "Microphone status unknown",
          description: "Permission will be requested when you start recording.",
          actions: (
            <button
              onClick={onRefresh}
              className="text-xs text-daintree-text/40 hover:text-daintree-text/70 transition-colors"
            >
              Re-check
            </button>
          ),
        };
    }
  })();

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-daintree-text/50" aria-hidden="true" />
          <span className="text-sm text-daintree-text/70">Microphone</span>
          <span className={cn("w-2 h-2 rounded-full shrink-0", statusDisplay.dot)} />
          <span className="text-xs text-daintree-text/50">{statusDisplay.text}</span>
        </div>
        {statusDisplay.actions}
      </div>
      {statusDisplay.description && (
        <p className="text-xs text-daintree-text/40 ml-[22px]">{statusDisplay.description}</p>
      )}
    </div>
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
      label="Paragraph Breaks"
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

// ── Dictionary section ──

function DictionarySection({
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
    <div className="space-y-2">
      <label className="text-sm text-daintree-text/70 flex items-center gap-2">
        <BookText className="w-3.5 h-3.5 text-daintree-text/50" aria-hidden="true" />
        Custom Dictionary
        <span className="text-xs tabular-nums text-daintree-text/30">
          {words.length > 0 && `${words.length}/100`}
        </span>
      </label>

      <SettingsSwitchCard
        variant="compact"
        title="Learn words from corrections"
        subtitle="Suggest dictionary terms when you fix a mishearing before sending"
        isEnabled={learnFromCorrections}
        onChange={() => onLearnFromCorrectionsChange(!learnFromCorrections)}
        ariaLabel="Toggle learning words from corrections"
      />

      {suggestedWords.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-daintree-text/50">Suggested from corrections</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestedWords.map((entry) => (
              <span
                key={entry.word}
                className="inline-flex items-center gap-1.5 rounded-full border border-daintree-border bg-overlay-subtle px-2 py-0.5 text-xs text-daintree-text"
                title={entry.utterance ? `Heard as "${entry.utterance}"` : undefined}
              >
                {entry.word}
                <button
                  type="button"
                  onClick={() => onAcceptSuggestion(entry.word)}
                  className="inline-flex items-center gap-0.5 text-daintree-text/50 hover:text-daintree-text transition-colors"
                  aria-label={`Add ${entry.word} to dictionary`}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => onDismissSuggestion(entry.word)}
                  className="text-daintree-text/30 hover:text-daintree-text/70 transition-colors"
                  aria-label={`Dismiss ${entry.word}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={newWord}
          onChange={(e) => onNewWordChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder="Add term…"
          className="flex-1 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent transition-colors"
        />
        <Button
          onClick={onAdd}
          disabled={!newWord.trim()}
          size="sm"
          variant="outline"
          className="text-daintree-text border-daintree-border hover:bg-daintree-border"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {words.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {words.map((word) => (
            <span
              key={word}
              className="inline-flex items-center gap-1 rounded-full border border-daintree-border bg-daintree-bg px-2.5 py-0.5 text-xs text-daintree-text"
            >
              {word}
              <button
                type="button"
                onClick={() => onRemove(word)}
                className="text-daintree-text/30 hover:text-daintree-text/70 transition-colors"
                aria-label={`Remove ${word}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-daintree-text/40 select-text">
          Domain-specific terms sent to the transcription service to boost recognition accuracy.
        </p>
      )}
    </div>
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
      label="Custom Instructions"
      description="Project-specific rules appended to the core correction prompt."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      placeholder='e.g., "Always capitalize ProductName as one word"'
      spellCheck={false}
    />
  );
}

// ── Core prompt viewer ──

function CorePromptViewer() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-daintree-text/40 hover:text-daintree-text/60 transition-colors"
      >
        <ChevronRight
          data-animated-chevron
          className={cn("w-3.5 h-3.5 transition-transform duration-150", expanded && "rotate-90")}
        />
        Inspect core prompt
      </button>
      {expanded && (
        <pre className="bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-daintree-text/50 whitespace-pre-wrap overflow-y-auto max-h-48 select-text">
          {CORE_CORRECTION_PROMPT}
        </pre>
      )}
    </div>
  );
}
