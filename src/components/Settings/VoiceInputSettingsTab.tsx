import { useState, useEffect, useRef, useCallback } from "react";
import {
  Mic,
  Eye,
  EyeOff,
  Plus,
  X,
  Key,
  Globe,
  BookText,
  Shield,
  Check,
  AlertCircle,
  Loader2,
  FlaskConical,
  ExternalLink,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { dispatchVoiceInputSettingsChanged } from "@/lib/voiceInputSettingsEvents";
import { CORE_CORRECTION_PROMPT } from "@shared/config/voiceCorrection";
import type {
  VoiceInputSettings,
  MicPermissionStatus,
  VoiceTranscriptionModel,
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

const TRANSCRIPTION_MODELS: {
  value: VoiceTranscriptionModel;
  label: string;
  description: string;
}[] = [
  {
    value: "nova-3",
    label: "Nova-3",
    description: "Latest · best accuracy · $0.0077/min",
  },
  {
    value: "nova-2",
    label: "Nova-2",
    description: "Stable fallback · $0.0043/min",
  },
];

const DEFAULT_SETTINGS: VoiceInputSettings = {
  enabled: false,
  deepgramApiKey: "",
  correctionApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionModel: "nova-3",
  correctionEnabled: false,
  correctionModel: "gpt-5-nano",
  correctionCustomInstructions: "",
};

type LoadState = "loading" | "ready" | "error";
type ApiKeyValidation = "idle" | "testing" | "valid" | "invalid";

export function VoiceInputSettingsTab() {
  const [settings, setSettings] = useState<VoiceInputSettings>(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [micPermission, setMicPermission] = useState<MicPermissionStatus>("unknown");
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  const [newDictionaryWord, setNewDictionaryWord] = useState("");
  const dictionaryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.electron?.voiceInput
      ?.getSettings()
      .then((s) => {
        setSettings(s);
        setLoadState("ready");
      })
      .catch(() => setLoadState("error"));

    window.electron?.voiceInput
      ?.checkMicPermission()
      .then((status) => {
        if (status) setMicPermission(status);
      })
      .catch(() => {});
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

  const handleRequestMicPermission = useCallback(async () => {
    setIsRequestingMic(true);
    try {
      await window.electron?.voiceInput?.requestMicPermission();
      const status = await window.electron?.voiceInput?.checkMicPermission();
      if (status) setMicPermission(status);
    } catch {
      // ignore
    } finally {
      setIsRequestingMic(false);
    }
  }, []);

  const handleOpenMicSettings = useCallback(() => {
    window.electron?.voiceInput?.openMicSettings();
  }, []);

  const handleRefreshMicPermission = useCallback(async () => {
    const status = await window.electron?.voiceInput?.checkMicPermission();
    if (status) setMicPermission(status);
  }, []);

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

  if (loadState === "loading") {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-canopy-text/60 text-sm">Loading voice input settings...</div>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-3">
        <div className="text-status-error text-sm">Could not load voice input settings.</div>
        <p className="text-xs text-canopy-text/50">Restart Canopy and try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSwitchCard
        icon={Mic}
        title="Voice Input"
        subtitle="Dictate commands using your microphone via Deepgram Nova-3"
        isEnabled={settings.enabled}
        onChange={() => update({ enabled: !settings.enabled })}
        ariaLabel="Toggle voice input"
      />

      {settings.enabled && (
        <>
          {/* ── Stage 1: Speech-to-Text ── */}
          <StageDivider label="Speech-to-Text" sublabel="Deepgram Nova" />

          <SettingsSection
            icon={Key}
            title="Deepgram API Key"
            description="Required for real-time transcription. Your key is stored locally and never shared."
          >
            <ApiKeyField
              value={settings.deepgramApiKey}
              placeholder="deepgram_..."
              onSave={(key) => update({ deepgramApiKey: key })}
              onValidate={(key) => window.electron?.voiceInput?.validateApiKey(key)}
              dashboardUrl="https://console.deepgram.com/project/api-keys"
              dashboardLabel="Open Deepgram Console"
              getInfoText="Create a Deepgram API key with Speech:read scope. Voice input uses Nova-3 for real-time streaming transcription."
            />
          </SettingsSection>

          <SettingsSection
            icon={Shield}
            title="Microphone Permission"
            description="Canopy needs microphone access to capture audio for transcription."
          >
            <MicPermissionCard
              status={micPermission}
              isRequesting={isRequestingMic}
              onRequest={handleRequestMicPermission}
              onOpenSettings={handleOpenMicSettings}
              onRefresh={handleRefreshMicPermission}
            />
          </SettingsSection>

          {/* Language + Model — compact single row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-canopy-text/70 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5" aria-hidden="true" />
                Language
              </label>
              <select
                value={settings.language}
                onChange={(e) => update({ language: e.target.value })}
                className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text focus:outline-none focus:ring-1 focus:ring-canopy-accent"
              >
                {LANGUAGES.map(({ code, label }) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-canopy-text/70 flex items-center gap-1.5">
                <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                Model
              </label>
              <select
                value={settings.transcriptionModel}
                onChange={(e) =>
                  update({ transcriptionModel: e.target.value as VoiceTranscriptionModel })
                }
                className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text focus:outline-none focus:ring-1 focus:ring-canopy-accent"
              >
                {TRANSCRIPTION_MODELS.map(({ value, label, description }) => (
                  <option key={value} value={value}>
                    {label} — {description}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Custom Dictionary */}
          <SettingsSection
            icon={BookText}
            title="Custom Dictionary"
            description="Domain-specific terms sent to Deepgram as keyterms to boost recognition accuracy (up to 100)."
          >
            <div className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-4">
              <div className="flex gap-2">
                <input
                  ref={dictionaryInputRef}
                  type="text"
                  value={newDictionaryWord}
                  onChange={(e) => setNewDictionaryWord(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addDictionaryWord();
                    }
                  }}
                  placeholder="Add term…"
                  className="flex-1 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:ring-1 focus:ring-canopy-accent"
                />
                <Button
                  onClick={addDictionaryWord}
                  disabled={!newDictionaryWord.trim()}
                  size="sm"
                  variant="outline"
                  className="text-canopy-text border-canopy-border hover:bg-canopy-border"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>

              {settings.customDictionary.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {settings.customDictionary.map((word) => (
                    <span
                      key={word}
                      className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg px-2.5 py-1 text-xs text-canopy-text"
                    >
                      {word}
                      <button
                        type="button"
                        onClick={() => removeDictionaryWord(word)}
                        className="text-canopy-text/40 hover:text-canopy-text/80 transition-colors"
                        aria-label={`Remove ${word}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-canopy-text/40">
                  No custom terms added yet. Add project names, framework abbreviations, or
                  domain-specific vocabulary.
                </p>
              )}
            </div>
          </SettingsSection>

          {/* ── Stage 2: AI Correction ── */}
          <StageDivider label="AI Text Correction" sublabel="Optional · OpenAI" />

          <AiCorrectionSection settings={settings} update={update} />
        </>
      )}
    </div>
  );
}

interface ApiKeyFieldProps {
  value: string;
  placeholder: string;
  onSave: (key: string) => void;
  onValidate: (key: string) => Promise<{ valid: boolean; error?: string } | undefined> | undefined;
  dashboardUrl: string;
  dashboardLabel: string;
  getInfoText: string;
}

function ApiKeyField({
  value,
  placeholder,
  onSave,
  onValidate,
  dashboardUrl,
  dashboardLabel,
  getInfoText,
}: ApiKeyFieldProps) {
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [validation, setValidation] = useState<ApiKeyValidation>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (validation !== "valid" && validation !== "invalid") return;
    const timer = setTimeout(() => {
      setValidation("idle");
      setValidationError(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [validation]);

  const handleTest = useCallback(async () => {
    const key = keyInput.trim() || value;
    if (!key) return;
    setValidation("testing");
    setValidationError(null);
    try {
      const result = await onValidate(key);
      if (result?.valid) {
        setValidation("valid");
      } else {
        setValidation("invalid");
        setValidationError(result?.error || "Invalid API key");
      }
    } catch {
      setValidation("invalid");
      setValidationError("Failed to validate API key");
    }
  }, [keyInput, value, onValidate]);

  const handleSave = useCallback(async () => {
    const key = keyInput.trim();
    if (!key) return;
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
  }, [keyInput, onSave, onValidate]);

  const handleClear = useCallback(() => {
    onSave("");
    setKeyInput("");
    setValidation("idle");
    setValidationError(null);
  }, [onSave]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-canopy-text">
          {value ? (
            <span className="flex items-center gap-1.5 text-status-success">
              <Check className="w-3 h-3" />
              API key configured
            </span>
          ) : (
            <span className="text-canopy-text/50">No API key set</span>
          )}
        </span>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={showKey ? "text" : "password"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={value ? "Enter new key to replace" : placeholder}
            className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 pr-10 font-mono text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:ring-1 focus:ring-canopy-accent"
            autoComplete="new-password"
            spellCheck={false}
            disabled={validation === "testing"}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-canopy-text/40 hover:text-canopy-text/70"
            aria-label={showKey ? "Hide API key" : "Show API key"}
          >
            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <Button
          onClick={handleTest}
          disabled={validation === "testing" || (!keyInput.trim() && !value)}
          variant="outline"
          size="sm"
          className="min-w-[70px] text-canopy-text border-canopy-border hover:bg-canopy-border"
        >
          {validation === "testing" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <>
              <FlaskConical />
              Test
            </>
          )}
        </Button>
        <Button
          onClick={handleSave}
          disabled={validation === "testing" || !keyInput.trim()}
          size="sm"
          className="min-w-[70px]"
        >
          {validation === "testing" ? <Loader2 className="animate-spin" /> : "Save"}
        </Button>
        {value && (
          <Button
            onClick={handleClear}
            variant="outline"
            size="sm"
            className="text-status-error border-canopy-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
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

      <div className="mt-4 space-y-3 rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4">
        <h4 className="text-sm font-medium text-canopy-text">Get an API Key</h4>
        <p className="text-xs text-canopy-text/60">{getInfoText}</p>
        <Button
          onClick={() => window.electron?.system?.openExternal(dashboardUrl)}
          variant="outline"
          size="sm"
          className="text-canopy-text border-canopy-border hover:bg-canopy-border"
        >
          <ExternalLink />
          {dashboardLabel}
        </Button>
      </div>
    </div>
  );
}

function StageDivider({ label, sublabel }: { label: string; sublabel: string }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <div className="h-px flex-1 bg-canopy-border" />
      <div className="text-center">
        <span className="text-xs font-semibold uppercase tracking-wider text-canopy-text/60">
          {label}
        </span>
        <span className="block text-[10px] text-canopy-text/35">{sublabel}</span>
      </div>
      <div className="h-px flex-1 bg-canopy-border" />
    </div>
  );
}

interface AiCorrectionSectionProps {
  settings: VoiceInputSettings;
  update: (patch: Partial<VoiceInputSettings>) => void;
}

function AiCorrectionSection({ settings, update }: AiCorrectionSectionProps) {
  const [corePromptExpanded, setCorePromptExpanded] = useState(false);

  return (
    <>
      <SettingsSwitchCard
        icon={Sparkles}
        title="AI Text Correction"
        subtitle="Post-process transcriptions with GPT-5 Nano to fix technical terms, punctuation, and filler words"
        isEnabled={settings.correctionEnabled}
        onChange={() => update({ correctionEnabled: !settings.correctionEnabled })}
        ariaLabel="Toggle AI text correction"
      />

      {settings.correctionEnabled && (
        <div className="space-y-4 pl-2 border-l-2 border-canopy-accent/20 ml-2">
          <SettingsSection
            icon={Key}
            title="OpenAI API Key"
            description="Required for correction via GPT-5 Nano. Independent of the Deepgram transcription key."
          >
            <ApiKeyField
              value={settings.correctionApiKey}
              placeholder="sk-..."
              onSave={(key) => update({ correctionApiKey: key })}
              onValidate={(key) => window.electron?.voiceInput?.validateCorrectionApiKey(key)}
              dashboardUrl="https://platform.openai.com/api-keys"
              dashboardLabel="Open OpenAI Dashboard"
              getInfoText="Create an OpenAI API key for GPT-5 Nano correction. This is optional — if no key is set, correction is skipped entirely."
            />
          </SettingsSection>

          {settings.correctionApiKey && (
            <>
              <div className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-3">
                <button
                  type="button"
                  onClick={() => setCorePromptExpanded((v) => !v)}
                  className="flex items-center justify-between w-full text-left"
                >
                  <h4 className="text-sm font-medium text-canopy-text">Core Prompt</h4>
                  {corePromptExpanded ? (
                    <ChevronUp className="w-4 h-4 text-canopy-text/40" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-canopy-text/40" />
                  )}
                </button>

                {corePromptExpanded ? (
                  <pre className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-canopy-text/60 whitespace-pre-wrap overflow-y-auto max-h-64">
                    {CORE_CORRECTION_PROMPT}
                  </pre>
                ) : (
                  <p className="text-xs text-canopy-text/40">
                    Corrects phonetic mistranscriptions, punctuation, homophones, and filler words
                    while preserving the speaker&apos;s original phrasing.
                  </p>
                )}
              </div>

              <div className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-3">
                <h4 className="text-sm font-medium text-canopy-text">Custom Instructions</h4>
                <p className="text-xs text-canopy-text/40">
                  Project-specific rules appended to the core prompt.
                </p>
                <textarea
                  value={settings.correctionCustomInstructions}
                  onChange={(e) => update({ correctionCustomInstructions: e.target.value })}
                  rows={3}
                  placeholder='e.g., "Always capitalize ProductName as one word" or "The acronym CMS refers to our Content Management System"'
                  className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-canopy-text placeholder:text-canopy-text/30 focus:outline-none focus:ring-1 focus:ring-canopy-accent resize-y"
                  spellCheck={false}
                />
              </div>

              <p className="text-xs text-canopy-text/40">
                Your project name and custom dictionary are included automatically. Prompt caching
                keeps costs minimal.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}

interface MicPermissionCardProps {
  status: MicPermissionStatus;
  isRequesting: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
}

function MicPermissionCard({
  status,
  isRequesting,
  onRequest,
  onOpenSettings,
  onRefresh,
}: MicPermissionCardProps) {
  const ua = navigator.userAgent;
  const isMac = ua.includes("Mac OS X");
  const isWindows = ua.includes("Windows");
  const appName = process.env.NODE_ENV === "development" ? "Electron" : "Canopy";

  if (status === "granted") {
    return (
      <div className="flex items-center justify-between p-3 rounded-[var(--radius-md)] bg-status-success/10 border border-status-success/20">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-status-success" />
          <span className="text-sm text-canopy-text">Microphone access granted</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onRefresh}
          className="text-canopy-text/50 hover:text-canopy-text"
        >
          Re-check
        </Button>
      </div>
    );
  }

  if (status === "denied" || status === "restricted") {
    const settingsPath = isMac
      ? `System Settings → Privacy & Security → Microphone → enable ${appName}`
      : isWindows
        ? "Windows Settings → Privacy & security → Microphone → allow desktop app access"
        : "your system audio settings";

    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
          <AlertCircle className="w-4 h-4 text-status-error shrink-0 mt-0.5" />
          <div>
            <span className="text-sm text-canopy-text">
              Microphone access {status === "restricted" ? "restricted" : "denied"}
            </span>
            <p className="text-xs text-canopy-text/60 mt-0.5">
              Open {settingsPath} to grant access.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenSettings}
            className="text-canopy-text border-canopy-border hover:bg-canopy-border"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open {isMac ? "System Settings" : isWindows ? "Windows Settings" : "System Settings"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            className="text-canopy-text/50 hover:text-canopy-text"
          >
            Re-check
          </Button>
        </div>
      </div>
    );
  }

  if (status === "not-determined") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border">
          <div className="w-2 h-2 rounded-full bg-status-warning" />
          <span className="text-sm text-canopy-text">Microphone permission not yet requested</span>
        </div>
        <div className="flex gap-2">
          {(isMac || isWindows) && (
            <Button size="sm" onClick={onRequest} disabled={isRequesting} className="min-w-[140px]">
              {isRequesting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <>
                  <Mic className="w-3.5 h-3.5" />
                  Request Permission
                </>
              )}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenSettings}
            className="text-canopy-text border-canopy-border hover:bg-canopy-border"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open {isMac ? "System Settings" : isWindows ? "Windows Settings" : "System Settings"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border">
        <div className="w-2 h-2 rounded-full bg-canopy-text/30" />
        <span className="text-sm text-canopy-text/70">
          Could not determine microphone permission status
        </span>
      </div>
      <p className="text-xs text-canopy-text/50">
        Microphone access will be requested when you start recording. If recording fails, check your
        system&apos;s audio settings to ensure microphone access is enabled.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenSettings}
          className="text-canopy-text border-canopy-border hover:bg-canopy-border"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open System Settings
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onRefresh}
          className="text-canopy-text/50 hover:text-canopy-text"
        >
          Re-check
        </Button>
      </div>
    </div>
  );
}
