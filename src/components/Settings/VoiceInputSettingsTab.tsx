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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import type { VoiceInputSettings, MicPermissionStatus } from "@shared/types";

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

const DEFAULT_SETTINGS: VoiceInputSettings = {
  enabled: false,
  apiKey: "",
  language: "en",
  customDictionary: [],
};

type LoadState = "loading" | "ready" | "error";
type ApiKeyValidation = "idle" | "testing" | "valid" | "invalid";

export function VoiceInputSettingsTab() {
  const [settings, setSettings] = useState<VoiceInputSettings>(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyValidation, setApiKeyValidation] = useState<ApiKeyValidation>("idle");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
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

  useEffect(() => {
    if (apiKeyValidation !== "valid" && apiKeyValidation !== "invalid") return;
    const timer = setTimeout(() => {
      setApiKeyValidation("idle");
      setApiKeyError(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [apiKeyValidation]);

  const update = (patch: Partial<VoiceInputSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electron?.voiceInput?.setSettings(patch).catch(() => setSettings(prev));
      return next;
    });
  };

  const handleTestApiKey = useCallback(async () => {
    const key = apiKeyInput.trim() || settings.apiKey;
    if (!key) return;

    setApiKeyValidation("testing");
    setApiKeyError(null);

    try {
      const result = await window.electron?.voiceInput?.validateApiKey(key);
      if (result?.valid) {
        setApiKeyValidation("valid");
      } else {
        setApiKeyValidation("invalid");
        setApiKeyError(result?.error || "Invalid API key");
      }
    } catch {
      setApiKeyValidation("invalid");
      setApiKeyError("Failed to validate API key");
    }
  }, [apiKeyInput, settings.apiKey]);

  const handleSaveApiKey = useCallback(async () => {
    const key = apiKeyInput.trim();
    if (!key) return;

    setApiKeyValidation("testing");
    setApiKeyError(null);

    try {
      const result = await window.electron?.voiceInput?.validateApiKey(key);
      if (result?.valid) {
        update({ apiKey: key });
        setApiKeyInput("");
        setApiKeyValidation("valid");
      } else {
        setApiKeyValidation("invalid");
        setApiKeyError(result?.error || "Invalid API key");
      }
    } catch {
      setApiKeyValidation("invalid");
      setApiKeyError("Failed to validate API key");
    }
  }, [apiKeyInput]);

  const handleClearApiKey = useCallback(() => {
    update({ apiKey: "" });
    setApiKeyInput("");
    setApiKeyValidation("idle");
    setApiKeyError(null);
  }, []);

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
        subtitle="Dictate commands using your microphone via OpenAI Realtime API"
        isEnabled={settings.enabled}
        onChange={() => update({ enabled: !settings.enabled })}
        ariaLabel="Toggle voice input"
      />

      {settings.enabled && (
        <>
          {/* API Key Section */}
          <SettingsSection
            icon={Key}
            title="OpenAI API Key"
            description="Required for transcription via the OpenAI Realtime API. Your key is stored locally and never shared."
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-canopy-text">
                  {settings.apiKey ? (
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
                    type={showApiKey ? "text" : "password"}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={settings.apiKey ? "Enter new key to replace" : "sk-..."}
                    className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 pr-10 font-mono text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:ring-1 focus:ring-canopy-accent"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={apiKeyValidation === "testing"}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-canopy-text/40 hover:text-canopy-text/70"
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  >
                    {showApiKey ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <Button
                  onClick={handleTestApiKey}
                  disabled={
                    apiKeyValidation === "testing" || (!apiKeyInput.trim() && !settings.apiKey)
                  }
                  variant="outline"
                  size="sm"
                  className="min-w-[70px] text-canopy-text border-canopy-border hover:bg-canopy-border"
                >
                  {apiKeyValidation === "testing" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <>
                      <FlaskConical />
                      Test
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleSaveApiKey}
                  disabled={apiKeyValidation === "testing" || !apiKeyInput.trim()}
                  size="sm"
                  className="min-w-[70px]"
                >
                  {apiKeyValidation === "testing" ? <Loader2 className="animate-spin" /> : "Save"}
                </Button>
                {settings.apiKey && (
                  <Button
                    onClick={handleClearApiKey}
                    variant="outline"
                    size="sm"
                    className="text-status-error border-canopy-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
                  >
                    Clear
                  </Button>
                )}
              </div>

              {apiKeyValidation === "valid" && (
                <p className="text-xs text-status-success flex items-center gap-1">
                  <Check className="w-3 h-3" />
                  API key is valid
                </p>
              )}
              {apiKeyValidation === "invalid" && (
                <p className="text-xs text-status-error flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {apiKeyError || "Invalid API key"}
                </p>
              )}
            </div>

            <div className="mt-4 space-y-3 rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4">
              <h4 className="text-sm font-medium text-canopy-text">Get an API Key</h4>
              <p className="text-xs text-canopy-text/60">
                Create an OpenAI API key with access to the Realtime API. Voice input uses the{" "}
                <code className="text-canopy-text bg-canopy-bg px-1 rounded">gpt-4o-realtime</code>{" "}
                model for low-latency transcription.
              </p>
              <Button
                onClick={() =>
                  window.electron?.system?.openExternal("https://platform.openai.com/api-keys")
                }
                variant="outline"
                size="sm"
                className="text-canopy-text border-canopy-border hover:bg-canopy-border"
              >
                <ExternalLink />
                Open OpenAI Dashboard
              </Button>
            </div>
          </SettingsSection>

          {/* Microphone Permission */}
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

          {/* Language */}
          <SettingsSection
            icon={Globe}
            title="Language"
            description="Select the primary language for transcription. Setting a language reduces latency and improves accuracy."
          >
            <select
              value={settings.language}
              onChange={(e) => update({ language: e.target.value })}
              className="w-full max-w-xs bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-2 text-sm text-canopy-text focus:outline-none focus:ring-1 focus:ring-canopy-accent"
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </SettingsSection>

          {/* Custom Dictionary */}
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
                <BookText className="w-4 h-4 text-canopy-text/70" aria-hidden="true" />
                Custom Dictionary
              </h4>
              <p className="text-xs text-canopy-text/50 mb-4">
                Add domain-specific terms, project names, and technical abbreviations to improve
                transcription accuracy.
              </p>
            </div>

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
                  No custom terms added. Terms like project names, framework abbreviations, or
                  domain-specific vocabulary help the transcription model understand your speech.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
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

  // unknown status (e.g. Linux, or failed to check)
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
