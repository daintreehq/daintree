import { useState, useEffect, useRef } from "react";
import { Mic, Eye, EyeOff, Plus, X, AlertCircle } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import type { VoiceInputSettings } from "@shared/types";

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

export function VoiceInputSettingsTab() {
  const [settings, setSettings] = useState<VoiceInputSettings>(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [showApiKey, setShowApiKey] = useState(false);
  const [micPermission, setMicPermission] = useState<"granted" | "denied" | "prompt" | "unknown">(
    "unknown"
  );
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

    // Check mic permission status
    if (navigator.permissions) {
      navigator.permissions
        .query({ name: "microphone" as PermissionName })
        .then((result) => {
          setMicPermission(result.state as "granted" | "denied" | "prompt");
          result.onchange = () => {
            setMicPermission(result.state as "granted" | "denied" | "prompt");
          };
        })
        .catch(() => setMicPermission("unknown"));
    }
  }, []);

  const update = (patch: Partial<VoiceInputSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.electron?.voiceInput?.setSettings(patch).catch(() => setSettings(prev));
      return next;
    });
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

  if (loadState === "loading") {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (loadState === "error") {
    return (
      <div className="text-sm text-canopy-text/60">
        Could not load voice input settings. Restart Canopy and try again.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={Mic}
        title="Voice Input"
        description="Dictate commands and messages using your microphone. Audio is sent to the OpenAI Realtime API for transcription. Opt-in only — requires an OpenAI API key."
      >
        <ToggleRow
          id="voice-enabled"
          label="Enable voice input"
          description="Show the microphone button in the hybrid terminal input bar"
          checked={settings.enabled}
          onChange={(v) => update({ enabled: v })}
        />
      </SettingsSection>

      {settings.enabled && (
        <>
          <SettingsSection
            icon={Mic}
            title="OpenAI API Key"
            description="Voice input uses the OpenAI Realtime API. Provide your API key to enable transcription. The key is stored locally and never shared."
          >
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={settings.apiKey}
                    onChange={(e) => update({ apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="w-full rounded-lg border border-divider bg-canopy-sidebar/30 px-3 py-2 pr-10 font-mono text-sm text-canopy-text placeholder:text-canopy-text/30 focus:border-canopy-accent/50 focus:outline-none focus:ring-1 focus:ring-canopy-accent/30"
                    autoComplete="off"
                    spellCheck={false}
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
              </div>
              {!settings.apiKey && (
                <p className="flex items-center gap-1.5 text-xs text-yellow-400/80">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  An API key is required to use voice input.
                </p>
              )}
            </div>
          </SettingsSection>

          <SettingsSection
            icon={Mic}
            title="Language"
            description="Select the primary language you'll be speaking. Providing a language reduces transcription latency."
          >
            <select
              value={settings.language}
              onChange={(e) => update({ language: e.target.value })}
              className="w-48 rounded-lg border border-divider bg-canopy-sidebar/30 px-3 py-2 text-sm text-canopy-text focus:border-canopy-accent/50 focus:outline-none focus:ring-1 focus:ring-canopy-accent/30"
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </SettingsSection>

          <SettingsSection
            icon={Mic}
            title="Custom Dictionary"
            description="Add domain-specific terms, project names, and technical abbreviations to improve transcription accuracy. These are sent as context to the Realtime API."
          >
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {settings.customDictionary.map((word) => (
                  <span
                    key={word}
                    className="inline-flex items-center gap-1 rounded border border-divider bg-canopy-sidebar/30 px-2 py-0.5 text-xs text-canopy-text"
                  >
                    {word}
                    <button
                      type="button"
                      onClick={() => removeDictionaryWord(word)}
                      className="text-canopy-text/40 hover:text-canopy-text/80"
                      aria-label={`Remove ${word}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
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
                  className="flex-1 rounded-lg border border-divider bg-canopy-sidebar/30 px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/30 focus:border-canopy-accent/50 focus:outline-none focus:ring-1 focus:ring-canopy-accent/30"
                />
                <button
                  type="button"
                  onClick={addDictionaryWord}
                  disabled={!newDictionaryWord.trim()}
                  className="flex items-center gap-1.5 rounded-lg border border-divider bg-canopy-sidebar/30 px-3 py-2 text-sm text-canopy-text hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </button>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            icon={Mic}
            title="Microphone Permission"
            description="Canopy needs microphone access to capture audio for transcription."
          >
            <MicPermissionStatus status={micPermission} />
          </SettingsSection>
        </>
      )}
    </div>
  );
}

interface ToggleRowProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({ id, label, description, checked, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-start gap-3">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 mt-0.5 rounded border-divider bg-canopy-sidebar text-canopy-accent focus:ring-canopy-accent focus:ring-2"
      />
      <div className="flex-1">
        <label htmlFor={id} className="text-sm font-medium text-canopy-text cursor-pointer">
          {label}
        </label>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
  );
}

function MicPermissionStatus({ status }: { status: "granted" | "denied" | "prompt" | "unknown" }) {
  if (status === "granted") {
    return (
      <p className="text-sm text-canopy-text/70">
        <span className="inline-block h-2 w-2 rounded-full bg-green-400 mr-1.5 align-middle" />
        Microphone access granted
      </p>
    );
  }
  if (status === "denied") {
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-sm text-yellow-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Microphone access denied
        </p>
        <p className="text-xs text-canopy-text/60">
          Open System Preferences → Privacy & Security → Microphone and enable access for Canopy.
        </p>
      </div>
    );
  }
  return (
    <p className="text-sm text-canopy-text/50">
      Permission will be requested when you start recording.
    </p>
  );
}
