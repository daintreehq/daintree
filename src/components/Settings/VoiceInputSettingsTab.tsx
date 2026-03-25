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
  ExternalLink,
  Sparkles,
  ChevronDown,
  ChevronUp,
  AlignLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { dispatchVoiceInputSettingsChanged } from "@/lib/voiceInputSettingsEvents";
import { CORE_CORRECTION_PROMPT } from "@shared/config/voiceCorrection";
import type {
  VoiceInputSettings,
  MicPermissionStatus,
  VoiceTranscriptionModel,
  VoiceCorrectionModel,
  VoiceParagraphingStrategy,
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
  correctionModel: "gpt-5-mini",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
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
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) setLoadState("error");
    }, 10_000);

    window.electron?.voiceInput
      ?.getSettings()
      .then((s) => {
        settled = true;
        clearTimeout(timer);
        setSettings(s);
        setLoadState("ready");
      })
      .catch(() => {
        settled = true;
        clearTimeout(timer);
        setLoadState("error");
      });

    window.electron?.voiceInput
      ?.checkMicPermission()
      .then((status) => {
        if (status) setMicPermission(status);
      })
      .catch(() => {});

    return () => clearTimeout(timer);
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
      {/* ── Speech-to-Text ── */}
      <SettingsSection
        icon={Mic}
        title="Speech-to-Text"
        description="Real-time transcription via Deepgram Nova. Requires a Deepgram API key and microphone access."
        id="voice-speech-to-text"
      >
        <SettingsSwitchCard
          icon={Mic}
          title="Voice Input"
          subtitle="Dictate commands using your microphone"
          isEnabled={settings.enabled}
          onChange={() => update({ enabled: !settings.enabled })}
          ariaLabel="Toggle voice input"
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

            <ApiKeyRow
              label="Deepgram API Key"
              value={settings.deepgramApiKey}
              placeholder="dg_..."
              onSave={(key) => update({ deepgramApiKey: key })}
              onValidate={(key) => window.electron?.voiceInput?.validateApiKey(key)}
              helpUrl="https://console.deepgram.com/project/api-keys"
              helpLabel="Get API key"
            />

            <SettingsRow label="Language" icon={Globe}>
              <select
                value={settings.language}
                onChange={(e) => update({ language: e.target.value })}
                className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors"
              >
                {LANGUAGES.map(({ code, label }) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </SettingsRow>

            <SettingsRow label="Transcription Model" icon={Mic}>
              <select
                value={settings.transcriptionModel}
                onChange={(e) =>
                  update({ transcriptionModel: e.target.value as VoiceTranscriptionModel })
                }
                className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors"
              >
                {TRANSCRIPTION_MODELS.map(({ value, label, description }) => (
                  <option key={value} value={value}>
                    {label} — {description}
                  </option>
                ))}
              </select>
            </SettingsRow>

            <ParagraphingStrategyRow
              value={settings.paragraphingStrategy ?? "spoken-command"}
              language={settings.language}
              onChange={(v) => update({ paragraphingStrategy: v })}
            />

            <DictionarySection
              words={settings.customDictionary}
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
          title="AI Text Correction"
          description="Post-process transcriptions with a GPT-5 reasoning model to fix technical terms, punctuation, and filler words. Optional."
          id="voice-ai-correction"
        >
          <SettingsSwitchCard
            icon={Sparkles}
            title="AI Text Correction"
            subtitle="Clean up transcriptions automatically after dictation"
            isEnabled={settings.correctionEnabled}
            onChange={() => update({ correctionEnabled: !settings.correctionEnabled })}
            ariaLabel="Toggle AI text correction"
          />

          {settings.correctionEnabled && (
            <div className="space-y-4">
              <ApiKeyRow
                label="OpenAI API Key"
                value={settings.correctionApiKey}
                placeholder="sk-..."
                onSave={(key) => update({ correctionApiKey: key })}
                onValidate={(key) => window.electron?.voiceInput?.validateCorrectionApiKey(key)}
                helpUrl="https://platform.openai.com/api-keys"
                helpLabel="Get API key"
              />

              <SettingsRow label="Correction Model" icon={Sparkles}>
                <select
                  value={settings.correctionModel}
                  onChange={(e) =>
                    update({ correctionModel: e.target.value as VoiceCorrectionModel })
                  }
                  className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors"
                >
                  {CORRECTION_MODELS.map(({ value, label, description }) => (
                    <option key={value} value={value}>
                      {label} — {description}
                    </option>
                  ))}
                </select>
              </SettingsRow>

              {settings.correctionApiKey && (
                <>
                  <CustomInstructionsRow
                    value={settings.correctionCustomInstructions}
                    onChange={(v) => update({ correctionCustomInstructions: v })}
                  />

                  <CorePromptViewer />

                  <p className="text-xs text-canopy-text/40">
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

// ── Shared row component ──

function SettingsRow({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: typeof Globe;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-canopy-text/70 flex items-center gap-2 shrink-0">
        <Icon className="w-3.5 h-3.5 text-canopy-text/50" aria-hidden="true" />
        {label}
      </label>
      {children}
    </div>
  );
}

// ── API key row ──

interface ApiKeyRowProps {
  label: string;
  value: string;
  placeholder: string;
  onSave: (key: string) => void;
  onValidate: (key: string) => Promise<{ valid: boolean; error?: string } | undefined> | undefined;
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
    if (validation !== "valid" && validation !== "invalid") return;
    const timer = setTimeout(() => {
      setValidation("idle");
      setValidationError(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [validation]);

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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm text-canopy-text/70 flex items-center gap-2">
          <Key className="w-3.5 h-3.5 text-canopy-text/50" aria-hidden="true" />
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
              className="text-xs text-canopy-accent hover:underline flex items-center gap-1"
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
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSave();
              }
            }}
            placeholder={value ? "Enter new key to replace" : placeholder}
            className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 pr-8 font-mono text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:border-canopy-accent transition-colors"
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
          onClick={() => void handleSave()}
          disabled={validation === "testing" || !keyInput.trim()}
          size="sm"
          variant="outline"
          className="text-canopy-text border-canopy-border hover:bg-canopy-border"
        >
          {validation === "testing" ? <Loader2 className="animate-spin w-3.5 h-3.5" /> : "Save"}
        </Button>
        {value && (
          <Button
            onClick={handleClear}
            variant="outline"
            size="sm"
            className="text-canopy-text/50 border-canopy-border hover:text-status-error hover:border-status-error/30"
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
  const appName = process.env.NODE_ENV === "development" ? "Electron" : "Canopy";

  const statusDisplay = (() => {
    switch (status) {
      case "granted":
        return {
          dot: "bg-status-success",
          text: "Microphone access granted",
          actions: (
            <button
              onClick={onRefresh}
              className="text-xs text-canopy-text/40 hover:text-canopy-text/70 transition-colors"
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
                className="text-xs text-canopy-accent hover:underline flex items-center gap-1"
              >
                Open {settingsLabel}
                <ExternalLink className="w-3 h-3" />
              </button>
              <button
                onClick={onRefresh}
                className="text-xs text-canopy-text/40 hover:text-canopy-text/70 transition-colors"
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
                  disabled={isRequesting}
                  className="text-canopy-text border-canopy-border hover:bg-canopy-border"
                >
                  {isRequesting ? (
                    <Loader2 className="animate-spin w-3.5 h-3.5" />
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5" />
                      Request
                    </>
                  )}
                </Button>
              )}
            </div>
          ),
        };
      default:
        return {
          dot: "bg-canopy-text/30",
          text: "Microphone status unknown",
          description: "Permission will be requested when you start recording.",
          actions: (
            <button
              onClick={onRefresh}
              className="text-xs text-canopy-text/40 hover:text-canopy-text/70 transition-colors"
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
          <Shield className="w-3.5 h-3.5 text-canopy-text/50" aria-hidden="true" />
          <span className="text-sm text-canopy-text/70">Microphone</span>
          <span className={cn("w-2 h-2 rounded-full shrink-0", statusDisplay.dot)} />
          <span className="text-xs text-canopy-text/50">{statusDisplay.text}</span>
        </div>
        {statusDisplay.actions}
      </div>
      {statusDisplay.description && (
        <p className="text-xs text-canopy-text/40 ml-[22px]">{statusDisplay.description}</p>
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

  return (
    <div className="space-y-1">
      <SettingsRow label="Paragraph Breaks" icon={AlignLeft}>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as VoiceParagraphingStrategy)}
          className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors"
        >
          <option value="spoken-command">Spoken commands</option>
          <option value="manual">Manual Enter only</option>
        </select>
      </SettingsRow>
      <p className="text-xs text-canopy-text/40 ml-[22px]">
        {isNonEnglish
          ? "Spoken commands require English. Manual Enter will be used for the selected language."
          : value === "spoken-command"
            ? 'Say "new paragraph" to insert a break. You can also press Enter to commit the current paragraph.'
            : "Press Enter to commit paragraph breaks. Spoken formatting commands are disabled."}
      </p>
    </div>
  );
}

// ── Dictionary section ──

function DictionarySection({
  words,
  newWord,
  onNewWordChange,
  onAdd,
  onRemove,
  inputRef,
}: {
  words: string[];
  newWord: string;
  onNewWordChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (word: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="space-y-2">
      <label className="text-sm text-canopy-text/70 flex items-center gap-2">
        <BookText className="w-3.5 h-3.5 text-canopy-text/50" aria-hidden="true" />
        Custom Dictionary
        <span className="text-xs tabular-nums text-canopy-text/30">
          {words.length > 0 && `${words.length}/100`}
        </span>
      </label>

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
          className="flex-1 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:border-canopy-accent transition-colors"
        />
        <Button
          onClick={onAdd}
          disabled={!newWord.trim()}
          size="sm"
          variant="outline"
          className="text-canopy-text border-canopy-border hover:bg-canopy-border"
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
              className="inline-flex items-center gap-1 rounded-full border border-canopy-border bg-canopy-bg px-2.5 py-0.5 text-xs text-canopy-text"
            >
              {word}
              <button
                type="button"
                onClick={() => onRemove(word)}
                className="text-canopy-text/30 hover:text-canopy-text/70 transition-colors"
                aria-label={`Remove ${word}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-canopy-text/40">
          Domain-specific terms sent to Deepgram to boost recognition accuracy.
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
    <div className="space-y-2">
      <label className="text-sm text-canopy-text/70">Custom Instructions</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder='e.g., "Always capitalize ProductName as one word"'
        className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-canopy-text placeholder:text-text-muted focus:outline-none focus:border-canopy-accent transition-colors resize-y"
        spellCheck={false}
      />
      <p className="text-xs text-canopy-text/40">
        Project-specific rules appended to the core correction prompt.
      </p>
    </div>
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
        className="flex items-center gap-1.5 text-xs text-canopy-text/40 hover:text-canopy-text/60 transition-colors"
      >
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Inspect core prompt
      </button>
      {expanded && (
        <pre className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-canopy-text/50 whitespace-pre-wrap overflow-y-auto max-h-48">
          {CORE_CORRECTION_PROMPT}
        </pre>
      )}
    </div>
  );
}
