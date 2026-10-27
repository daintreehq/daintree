import { useCallback, useState, useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { Eye, EyeOff, XCircle, ExternalLink, ChevronRight, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "./SettingsSection";
import { VoiceDictionaryPage } from "./VoiceDictionaryPage";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSelect } from "./SettingsSelect";
import { CodexIcon } from "@/components/icons/brands/CodexIcon";
import { DeepgramIcon } from "@/components/icons/brands/DeepgramIcon";
import { GrokIcon } from "@/components/icons/brands/GrokIcon";
import { MicTestRow } from "./MicTestRow";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import { SettingsChoicebox } from "./SettingsChoicebox";
import { SettingsTextarea } from "./SettingsTextarea";
import { SettingsInput } from "./SettingsInput";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
  SettingsRowActions,
} from "./SettingsGroup";
import { LastDictationTermsSection } from "./LastDictationTerms";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { dispatchVoiceInputSettingsChanged } from "@/lib/voiceInputSettingsEvents";
import { logWarn } from "@/utils/logger";
import { useAudioDevices, SYSTEM_DEFAULT_VALUE } from "@/hooks/useAudioDevices";
import { isSpecificMicId } from "@/services/voiceMicDevices";
import { useTabLoad } from "@/hooks";
import { useEffectiveCombo, useKeybindingDisplay } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { KbdChord } from "@/components/ui/Kbd";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";
import { VOICE_LANGUAGES } from "@shared/config/voiceLanguages";
import {
  correctionInstructionsFor,
  VOICE_CLEANUP_AI_MODEL,
  VOICE_CLEANUP_MODELS,
} from "@shared/config/voiceCorrection";
import {
  VOICE_CLEANUP_KEY_FIELD,
  hasCleanupKey,
  hasTranscriptionKey,
  transcriptionKeyField,
  transcriptionKeyIssuer,
  type VoiceApiKeyField,
} from "@shared/config/voiceProviders";
import type {
  VoiceInputSettings,
  VoiceInputSettingsPatch,
  VoiceCorrectionModel,
  VoiceDictionaryEntry,
  VoiceDictionaryState,
  MicPermissionStatus,
  VoiceParagraphingStrategy,
  VoiceTranscriptionProvider,
  VoiceRecordingMode,
} from "@shared/types";

const PROVIDER_OPTIONS = [
  { value: "openai" as const, label: "OpenAI", icon: CodexIcon },
  { value: "deepgram" as const, label: "Deepgram", icon: DeepgramIcon },
  { value: "grok" as const, label: "Grok", icon: GrokIcon },
];

const RECOGNITION_HINTS_PRIVACY =
  "Recognition hints go with the audio: your dictionary, project, host and worktree names, the branch, and identifiers from terminal output.";

const PROVIDER_PRIVACY: Record<VoiceTranscriptionProvider, string> = {
  openai: `OpenAI receives your audio over an encrypted connection, keeps it for up to 30 days for abuse monitoring, and doesn't train on it. ${RECOGNITION_HINTS_PRIVACY}`,
  deepgram: `Deepgram receives your audio over an encrypted connection and, by default, may keep audio and transcripts to improve its models. ${RECOGNITION_HINTS_PRIVACY}`,
  grok: `xAI receives your audio over an encrypted connection, keeps it for up to 30 days for abuse auditing unless your team turns on Zero Data Retention, and doesn't train on it without permission. ${RECOGNITION_HINTS_PRIVACY}`,
};

// What each model is better at, from the cleanup benchmark (#14793).
const CLEANUP_MODEL_COPY: Record<VoiceCorrectionModel, { label: string; description: string }> = {
  "gpt-6.1-terra": {
    label: "GPT-6.1 Terra (default)",
    description:
      "Catches more misheard names and words that only make sense in context. Costs about seven times as much, still well under a tenth of a cent a cleanup.",
  },
  "gpt-6-luna": {
    label: "GPT-6 Luna",
    description:
      "Cheaper, and better at writing out dictated paths and symbols. Misses more misheard names.",
  },
};

const CLEANUP_MODEL_CHOICES = VOICE_CLEANUP_MODELS.map((value) => ({
  value,
  ...CLEANUP_MODEL_COPY[value],
}));

const DEFAULT_SETTINGS: VoiceInputSettings = {
  enabled: false,
  openaiApiKey: "",
  deepgramApiKey: "",
  xaiApiKey: "",
  language: "en",
  dictionary: [],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: true,
  correctionModel: VOICE_CLEANUP_AI_MODEL,
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  deviceLabel: "",
  organizationId: "",
  projectId: "",
  recordingMode: "tap-or-hold",
  suggestedDictionary: [],
  dismissedSuggestions: [],
  learnFromCorrections: true,
};

type SaveGroup = "setup" | "microphone" | "credentials" | "behavior" | "dictionary" | "correction";

type PatchKey = keyof VoiceInputSettingsPatch;

// Keys report their own save outcome in the key row, so they never raise a section banner.
const SAVE_GROUP_BY_KEY: Partial<Record<PatchKey, SaveGroup>> = {
  openaiApiKey: "credentials",
  deepgramApiKey: "credentials",
  xaiApiKey: "credentials",
  deviceId: "microphone",
  deviceLabel: "microphone",
  language: "behavior",
  paragraphingStrategy: "behavior",
  recordingMode: "behavior",
  learnFromCorrections: "dictionary",
  correctionEnabled: "correction",
  correctionModel: "correction",
  correctionCustomInstructions: "correction",
  resolveFileLinks: "correction",
};

const SETTING_KEYS: readonly PatchKey[] = [
  "enabled",
  "openaiApiKey",
  "deepgramApiKey",
  "xaiApiKey",
  "language",
  "transcriptionProvider",
  "transcriptionModel",
  "correctionEnabled",
  "correctionModel",
  "correctionCustomInstructions",
  "paragraphingStrategy",
  "resolveFileLinks",
  "deviceId",
  "deviceLabel",
  "organizationId",
  "projectId",
  "recordingMode",
  "learnFromCorrections",
];

function patchedKeys(patch: VoiceInputSettingsPatch): PatchKey[] {
  return SETTING_KEYS.filter((key) => key in patch);
}

function saveGroupOf(patch: VoiceInputSettingsPatch): SaveGroup {
  for (const key of patchedKeys(patch)) {
    const group = SAVE_GROUP_BY_KEY[key];
    if (group) return group;
  }
  return "setup";
}

function copySetting<K extends PatchKey>(
  target: VoiceInputSettings,
  source: VoiceInputSettings,
  key: K
): void {
  target[key] = source[key];
}

const SETTING_LABEL: Partial<Record<PatchKey, string>> = {
  enabled: "Dictation",
  transcriptionProvider: "Transcription provider",
  organizationId: "Organization ID",
  projectId: "Project ID",
  deviceId: "Input device",
  language: "Language",
  paragraphingStrategy: "Paragraph breaks",
  recordingMode: "Recording mode",
  learnFromCorrections: "Learn words from corrections",
  correctionEnabled: "Clean up transcriptions",
  correctionModel: "Cleanup model",
  correctionCustomInstructions: "Custom instructions",
  resolveFileLinks: "Resolve file references",
};

// A settings save is retried through the current `update`, so the retry rolls back
// to what the page shows now. A dictionary change reads no page state, so it can
// carry its own retry.
type SaveFailure =
  | { group: SaveGroup; patch: VoiceInputSettingsPatch }
  | { group: "dictionary"; label: string; retry: () => void };

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
  settings: Pick<VoiceInputSettings, "transcriptionProvider" | VoiceApiKeyField>,
  micPermission: MicPermissionStatus
): string[] {
  const blockers: string[] = [];
  if (!hasTranscriptionKey(settings)) {
    blockers.push(`add your ${transcriptionKeyIssuer(settings.transcriptionProvider)} API key`);
  }
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

interface VoiceInputSettingsTabProps {
  /** False while the settings dialog shows another page; this one stays mounted. */
  isActive?: boolean;
}

export function VoiceInputSettingsTab({ isActive = true }: VoiceInputSettingsTabProps = {}) {
  const [settings, setSettings] = useState<VoiceInputSettings>(DEFAULT_SETTINGS);
  const [micPermission, setMicPermission] = useState<MicPermissionStatus>("unknown");
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  // A check that couldn't answer, said once in the row instead of a silent no-op.
  const [micNote, setMicNote] = useState<string | null>(null);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const manageDictionaryRef = useRef<HTMLButtonElement>(null);
  const returnFocusToManage = useRef<{ visible: boolean } | null>(null);

  const {
    devices,
    loading: devicesLoading,
    error: devicesError,
    complete: devicesComplete,
    refresh: refreshDevices,
  } = useAudioDevices();

  // A saved alias ("default", "communications") follows the system input,
  // so it reads as System default.
  const chosenMicId = isSpecificMicId(settings.deviceId) ? settings.deviceId : "";
  const chosenMicListed = devices.some((device) => device.value === chosenMicId);
  // Only a complete list says the mic is gone; until then it keeps its name.
  const chosenMicAway =
    chosenMicId !== "" && !chosenMicListed && devicesComplete && !devicesLoading && !devicesError;
  const chosenMicName = settings.deviceLabel || "Selected microphone";
  const micOptions =
    chosenMicId !== "" && !chosenMicListed
      ? [
          ...devices,
          {
            value: chosenMicId,
            label: chosenMicAway ? `${chosenMicName} (not connected)` : chosenMicName,
          },
        ]
      : devices;
  let micDescription = "The microphone dictation records from";
  if (devicesLoading && !devicesError) micDescription = "Detecting devices…";
  else if (chosenMicAway)
    micDescription = "Not connected, so dictation uses the system default until it's back";
  else if (chosenMicId === "")
    micDescription = "Follows the system input, so a headset that connects takes over";

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
        logWarn("Failed to check microphone permission", voiceErrorLogFields(err));
      });
  }, []);

  // Optimistic apply. A rejected save puts back the keys it touched (unless a later
  // change has already moved them) and parks the failure on the group it belongs to,
  // so the page never silently shows a value that did not persist.
  const update = async (patch: VoiceInputSettingsPatch): Promise<boolean> => {
    const previous = settings;
    const group = saveGroupOf(patch);
    // A key only counts as saved (or removed) once it has persisted: the row's chip
    // must never claim a state the store doesn't have.
    const optimistic = group !== "credentials";
    if (optimistic) setSettings((current) => ({ ...current, ...patch }));
    try {
      await window.electron?.voiceInput?.setSettings(patch);
      if (!optimistic) setSettings((current) => ({ ...current, ...patch }));
      dispatchVoiceInputSettingsChanged({ ...previous, ...patch });
      setSaveFailure((current) => (current?.group === group ? null : current));
      return true;
    } catch (err) {
      if (optimistic)
        setSettings((current) => {
          const reverted: VoiceInputSettings = { ...current };
          for (const key of patchedKeys(patch)) {
            // A mic's name goes back only with its id, so a failed save can't
            // pair one mic's id with another's name.
            const owner = key === "deviceLabel" && "deviceId" in patch ? "deviceId" : key;
            if (current[owner] === patch[owner]) copySetting(reverted, previous, key);
          }
          return reverted;
        });
      setSaveFailure({ group, patch });
      logWarn("Failed to save voice input settings", voiceErrorLogFields(err));
      return false;
    }
  };

  const saveError = (group: SaveGroup) => {
    if (saveFailure?.group !== group) return null;
    const failure = saveFailure;
    const label =
      "patch" in failure
        ? (patchedKeys(failure.patch)
            .map((key) => SETTING_LABEL[key])
            .find(Boolean) ?? "The setting")
        : failure.label;
    return (
      <SettingsLoadErrorBanner
        title="Couldn't save that change"
        message={`${label} is back to its previous value.`}
        onRetry={"patch" in failure ? () => void update(failure.patch) : failure.retry}
      />
    );
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
    setMicNote(null);
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
      else {
        if (rechecked) setMicPermission(rechecked);
        setMicNote("Couldn't open a microphone. Check one is connected, then re-check.");
      }
    } catch {
      // Non-fatal — the row keeps its last known status.
    } finally {
      setIsRequestingMic(false);
    }
  };

  const handleOpenMicSettings = async () => {
    setMicNote(null);
    const opened = await window.electron?.voiceInput?.openMicSettings().catch(() => false);
    if (opened === false) {
      setMicNote("Couldn't open the settings app. Open it yourself, then re-check.");
    }
  };

  const handleRefreshMicPermission = async () => {
    setMicNote(null);
    const status = await readMicPermission();
    if (status) setMicPermission(status);
    else setMicNote("Couldn't check microphone access. Try again in a moment.");
  };

  // Main owns the dictionary and its suggestion queue: each change is one
  // operation there, and the page shows what main holds afterwards, so a word
  // learned while the page is open survives a change made here. Not optimistic:
  // a failed change leaves the page as it was, with the banner and a retry.
  const changeDictionary = async (
    label: string,
    run: () => Promise<VoiceDictionaryState>,
    onSaved?: () => void
  ): Promise<boolean> => {
    try {
      const next = await run();
      setSettings((current) => ({
        ...current,
        dictionary: next.dictionary,
        suggestedDictionary: next.suggestedDictionary,
      }));
      setSaveFailure((current) => (current?.group === "dictionary" ? null : current));
      onSaved?.();
      return true;
    } catch (err) {
      setSaveFailure({
        group: "dictionary",
        label,
        retry: () => void changeDictionary(label, run, onSaved),
      });
      logWarn("Failed to change the voice dictionary", voiceErrorLogFields(err));
      return false;
    }
  };

  useSettingsTabValidation("voice", Boolean(loadError || saveFailure));

  // The Manage button unmounts while the dictionary page is open; hand focus back to it.
  useEffect(() => {
    const target = returnFocusToManage.current;
    if (dictionaryOpen || !target) return;
    returnFocusToManage.current = null;
    manageDictionaryRef.current?.focus({ focusVisible: target.visible } as FocusOptions);
  }, [dictionaryOpen]);

  const provider = settings.transcriptionProvider;
  const blockers = dictationBlockers(settings, micPermission);
  const dictationSubtitle =
    settings.enabled && blockers.length > 0
      ? `Can't start yet: ${blockers.join(" and ")}`
      : "Dictate into terminals and inputs using your microphone";
  const isLegacyKey = !!settings.openaiApiKey && !settings.openaiApiKey.startsWith("sk-proj-");
  const hasOpenAiKey = hasCleanupKey(settings);
  const spokenCommandsAvailable = settings.language === "en";
  const paragraphing = settings.paragraphingStrategy ?? "spoken-command";
  const effectiveParagraphing: VoiceParagraphingStrategy = spokenCommandsAvailable
    ? paragraphing
    : "manual";
  const recordingMode = settings.recordingMode ?? "tap-or-hold";
  const dictationShortcut = useKeybindingDisplay("voiceInput.toggle");
  const dictationCombo = useEffectiveCombo("voiceInput.toggle");
  const pauseCombo = useEffectiveCombo("voiceInput.togglePause");

  const coversCleanup = provider === "openai" && settings.correctionEnabled;

  // Exhaustive over the key fields, so a new provider's key can't fall into another's row.
  const keyRows: Record<VoiceApiKeyField, () => ReactNode> = {
    deepgramApiKey: () => (
      <ApiKeyRow
        key="deepgramApiKey"
        label="Deepgram API key"
        value={settings.deepgramApiKey}
        placeholder="Paste a Deepgram API key"
        onSave={(key) => update({ deepgramApiKey: key })}
        helpUrl="https://console.deepgram.com/"
        description={
          settings.deepgramApiKey
            ? "Stored locally in plain text. Set usage limits on your Deepgram account to cap exposure."
            : "Create one in the Deepgram console. Keys are stored locally in plain text."
        }
      />
    ),
    xaiApiKey: () => (
      <ApiKeyRow
        key="xaiApiKey"
        label="xAI API key"
        value={settings.xaiApiKey}
        placeholder="Paste an xAI API key"
        onSave={(key) => update({ xaiApiKey: key })}
        helpUrl="https://console.x.ai/"
        description={
          settings.xaiApiKey
            ? "Stored locally in plain text. Set a spending limit on your xAI team to cap exposure."
            : "Create one in the xAI console. Keys are stored locally in plain text."
        }
      />
    ),
    openaiApiKey: () => (
      <ApiKeyRow
        key="openaiApiKey"
        id="voice-stt-openai-key"
        label="OpenAI API key"
        value={settings.openaiApiKey}
        placeholder="Paste an OpenAI API key"
        onSave={(key) => update({ openaiApiKey: key })}
        onValidate={(key) => window.electron?.voiceInput?.validateApiKey(key)}
        helpUrl="https://platform.openai.com/api-keys"
        description={
          <>
            {coversCleanup && "This one key covers transcription and text cleanup. "}
            {isLegacyKey ? (
              <>
                This is a legacy user key. A Project API key (starts with{" "}
                <code className="font-mono">sk-proj-</code>) is scoped more tightly. Keys are stored
                locally in plain text, so set billing limits on your OpenAI account.
              </>
            ) : settings.openaiApiKey ? (
              "Stored locally in plain text. Set billing limits on your OpenAI account to cap exposure."
            ) : (
              <>
                Use a Project API key (starts with <code className="font-mono">sk-proj-</code>) for
                the best security. Keys are stored locally in plain text.
              </>
            )}
          </>
        }
      />
    ),
  };
  const keyRow = (field: VoiceApiKeyField) => keyRows[field]();

  if (dictionaryOpen) {
    return (
      <VoiceDictionaryPage
        entries={settings.dictionary}
        suggestions={settings.suggestedDictionary}
        onChange={changeDictionary}
        failure={saveError("dictionary")}
        onBack={(viaKeyboard) => {
          returnFocusToManage.current = { visible: viaKeyboard === true };
          setDictionaryOpen(false);
        }}
      />
    );
  }

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
              <SettingsSelect
                id="voice-provider"
                label="Transcription provider"
                description={PROVIDER_PRIVACY[provider]}
                options={PROVIDER_OPTIONS}
                value={provider}
                onValueChange={(v) =>
                  void update({ transcriptionProvider: v as VoiceTranscriptionProvider })
                }
                isModified={provider !== DEFAULT_SETTINGS.transcriptionProvider}
                onReset={() =>
                  void update({ transcriptionProvider: DEFAULT_SETTINGS.transcriptionProvider })
                }
              />

              {keyRow(transcriptionKeyField(provider))}

              {provider === "openai" && isLegacyKey && (
                <>
                  <SettingsInput
                    label="Organization ID"
                    description="Only needed if your legacy key belongs to more than one organization"
                    value={settings.organizationId}
                    onChange={(e) => void update({ organizationId: e.target.value })}
                    onBlur={(e) => void update({ organizationId: e.target.value.trim() })}
                    placeholder="org-…"
                    layout="inline"
                    controlWidth="wide"
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
                    placeholder="proj_…"
                    layout="inline"
                    controlWidth="wide"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </>
              )}
            </SettingsDependents>
          )}
        </SettingsGroup>

        {settings.enabled && saveError("microphone")}
        {settings.enabled && (
          <SettingsGroup label="Microphone">
            <MicPermissionRow
              status={micPermission}
              isRequesting={isRequestingMic}
              onRequest={handleRequestMicPermission}
              onOpenSettings={handleOpenMicSettings}
              onRefresh={handleRefreshMicPermission}
              note={micNote}
            />

            <SettingsSelect
              id="voice-input-device"
              label="Input device"
              description={
                <>
                  {micDescription}
                  {" · "}
                  <Button variant="link" onClick={refreshDevices}>
                    Refresh list
                  </Button>
                </>
              }
              error={devicesError ?? undefined}
              value={chosenMicId || SYSTEM_DEFAULT_VALUE}
              onValueChange={(v) =>
                void update(
                  v === SYSTEM_DEFAULT_VALUE
                    ? { deviceId: "", deviceLabel: "" }
                    : {
                        deviceId: v,
                        deviceLabel: devices.find((device) => device.value === v)?.label ?? "",
                      }
                )
              }
              options={micOptions}
              disabled={devicesLoading && devices.length <= 1}
              isModified={chosenMicId !== DEFAULT_SETTINGS.deviceId}
              onReset={() =>
                void update({
                  deviceId: DEFAULT_SETTINGS.deviceId,
                  deviceLabel: DEFAULT_SETTINGS.deviceLabel,
                })
              }
            />

            <MicTestRow
              deviceId={settings.deviceId}
              active={isActive}
              disabled={micPermission === "denied" || micPermission === "restricted"}
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
              options={VOICE_LANGUAGES.map(({ code, label }) => ({ value: code, label }))}
              isModified={settings.language !== DEFAULT_SETTINGS.language}
              onReset={() => void update({ language: DEFAULT_SETTINGS.language })}
            />

            {!spokenCommandsAvailable ? (
              <SettingsRow
                id="voice-paragraph-breaks"
                label="Paragraph breaks"
                description="Spoken commands need English. Press Shift+Enter to add a break yourself; Enter stops dictation and sends the prompt."
              />
            ) : (
              <SettingsPresetGroup
                id="voice-paragraph-breaks"
                label="Paragraph breaks"
                description={
                  effectiveParagraphing === "spoken-command"
                    ? 'Say "new paragraph" or "new line" to add a break, or end with "send it" to stop dictation and send a prompt of three or more words. Enter stops dictation and sends the prompt too.'
                    : "Spoken break commands are off. Press Shift+Enter to add a break yourself; Enter stops dictation and sends the prompt."
                }
                options={[
                  { value: "spoken-command" as const, label: "Spoken commands" },
                  { value: "manual" as const, label: "Enter only" },
                ]}
                value={effectiveParagraphing}
                onChange={(v) => void update({ paragraphingStrategy: v })}
                isModified={paragraphing !== "spoken-command"}
                onReset={() => void update({ paragraphingStrategy: "spoken-command" })}
              />
            )}

            <SettingsPresetGroup
              id="voice-recording-mode"
              label="Recording mode"
              description={recordingModeDescription(recordingMode, dictationShortcut)}
              options={[
                { value: "tap-or-hold" as const, label: "Tap or hold" },
                { value: "toggle" as const, label: "Toggle" },
                { value: "push-to-talk" as const, label: "Push to talk" },
              ]}
              value={recordingMode}
              onChange={(v: VoiceRecordingMode) => void update({ recordingMode: v })}
              isModified={recordingMode !== DEFAULT_SETTINGS.recordingMode}
              onReset={() => void update({ recordingMode: DEFAULT_SETTINGS.recordingMode })}
            />

            <SettingsRow
              id="voice-shortcuts"
              label="Shortcuts"
              layout="stacked"
              description="Enter and Escape are fixed while you dictate"
              control={
                <div className="space-y-2">
                  <ul className="space-y-1.5 text-xs text-text-secondary">
                    <ShortcutLine combo={dictationCombo} label="Start or stop dictation" />
                    <ShortcutLine combo={pauseCombo} label="Pause or resume" />
                    <ShortcutLine combo="Escape" label="Cancel and discard this dictation" />
                    <ShortcutLine combo="Enter" label="Stop dictation and send the prompt" />
                  </ul>
                  <Button
                    variant="link"
                    onClick={() =>
                      void actionService.dispatch(
                        "app.settings.openTab",
                        { tab: "keyboard" },
                        { source: "user" }
                      )
                    }
                  >
                    Change in Keyboard settings
                  </Button>
                </div>
              }
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
            entries={settings.dictionary}
            suggestionCount={settings.suggestedDictionary.length}
            learnFromCorrections={settings.learnFromCorrections}
            onLearnFromCorrectionsChange={(v) => void update({ learnFromCorrections: v })}
            onManage={() => setDictionaryOpen(true)}
            manageRef={manageDictionaryRef}
          />
        </SettingsSection>
      )}

      {settings.enabled && <LastDictationTermsSection />}

      {settings.enabled && (
        <SettingsSection
          title="AI text correction"
          description="When you stop dictating, the whole passage is corrected once by the cleanup model to fix technical terms, punctuation and filler words, resolve self-corrections, and lay out spoken lists. The text, the prompts you recently sent from the same terminal, the terminal's recent output with credential-like lines removed, the repository's package, folder and dependency names, and the worktree's issue or PR title are sent to OpenAI."
          id="voice-ai-correction"
        >
          {saveError("correction")}
          <SettingsGroup>
            <SettingsSwitchCard
              id="voice-ai-correction-enable"
              title="Clean up transcriptions"
              subtitle="Correct the passage automatically when you stop dictating"
              isEnabled={settings.correctionEnabled}
              onChange={() => void update({ correctionEnabled: !settings.correctionEnabled })}
              isModified={settings.correctionEnabled !== DEFAULT_SETTINGS.correctionEnabled}
              onReset={() => void update({ correctionEnabled: DEFAULT_SETTINGS.correctionEnabled })}
            />

            {settings.correctionEnabled && (
              <SettingsDependents>
                {coversCleanup ? (
                  <SettingsRow
                    label="OpenAI API key"
                    description="The key under Speech-to-text covers transcription and cleanup. There's nothing more to add."
                  />
                ) : (
                  keyRow(VOICE_CLEANUP_KEY_FIELD)
                )}
              </SettingsDependents>
            )}

            {settings.correctionEnabled && (
              <SettingsDependents
                disabled={!hasOpenAiKey}
                reason={
                  provider === "openai"
                    ? "Cleanup runs on OpenAI. Add the OpenAI API key under Speech-to-text to use it."
                    : "Cleanup runs on OpenAI. Add an OpenAI API key above to use it."
                }
              >
                <SettingsChoicebox
                  id="voice-cleanup-model"
                  label="Cleanup model"
                  description="Spoken rewrites of a selection use it too"
                  value={settings.correctionModel}
                  onChange={(model) => void update({ correctionModel: model })}
                  options={CLEANUP_MODEL_CHOICES}
                  isModified={settings.correctionModel !== DEFAULT_SETTINGS.correctionModel}
                  onReset={() => void update({ correctionModel: DEFAULT_SETTINGS.correctionModel })}
                />

                <SettingsSwitchCard
                  id="voice-resolve-file-links"
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

                <CorePromptRow model={settings.correctionModel} />
              </SettingsDependents>
            )}
          </SettingsGroup>
        </SettingsSection>
      )}
    </div>
  );
}

/** Names the real binding, so a user who just finished setup knows what to press. */
export function recordingModeDescription(mode: VoiceRecordingMode, shortcut: string): string {
  const key = shortcut || "the dictation shortcut";
  const how =
    mode === "tap-or-hold"
      ? `Tap ${key} to start and again to stop, or hold it while you speak and let go to stop.`
      : mode === "toggle"
        ? `Press ${key} to start, and again to stop.`
        : `Hold ${key} to record. Releasing it stops without submitting.`;
  return shortcut ? how : `${how} No shortcut is assigned yet.`;
}

// ── API key row ──

type KeyStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "saved"; verified: boolean }
  | { kind: "invalid"; message: string }
  | { kind: "save-failed" }
  | { kind: "removing" }
  | { kind: "removed" }
  | { kind: "remove-failed" };

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
  const removing = status.kind === "removing";
  const busy = testing || removing;
  const savedId = useId();

  const handleSave = async () => {
    const key = keyInput.trim();
    // One credential operation at a time, so a result always describes the one the user ran.
    if (!key || busy) return;
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

  // Confirmed like every other stored credential (forge tokens, plugin secrets):
  // the key isn't recoverable from Daintree once its copy is gone.
  const [isRemoveConfirmOpen, setIsRemoveConfirmOpen] = useState(false);

  const handleRemove = async () => {
    if (busy) return;
    setStatus({ kind: "removing" });
    setStatus((await onSave("")) ? { kind: "removed" } : { kind: "remove-failed" });
    setIsRemoveConfirmOpen(false);
  };

  const statusLine =
    status.kind === "saved" ? (
      <>
        <CheckCircle2
          className={cn(
            "w-3.5 h-3.5 shrink-0",
            // Green only for a key the provider actually accepted.
            status.verified ? "text-status-success" : "text-text-secondary"
          )}
          aria-hidden="true"
        />
        {status.verified
          ? "Key checked and saved"
          : "Key saved. It's checked the first time you dictate."}
      </>
    ) : status.kind === "invalid" ? (
      <>
        <XCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        {status.message}
      </>
    ) : status.kind === "removed" ? (
      <>
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        Key removed
      </>
    ) : status.kind === "remove-failed" ? (
      <>
        <XCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        Couldn't remove the key. It's still saved, so you can try again.
      </>
    ) : status.kind === "save-failed" ? (
      <>
        <XCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        Couldn't save the key. It's still in the field, so you can try Save again.
      </>
    ) : null;

  return (
    <>
      <ConfirmDialog
        isOpen={isRemoveConfirmOpen}
        variant="destructive"
        onConfirm={() => void handleRemove()}
        onClose={() => setIsRemoveConfirmOpen(false)}
        isConfirmLoading={removing}
        title={`Remove the ${label}?`}
        description="Daintree's copy is deleted. Dictation through this provider stops until you add a key again."
        confirmLabel="Remove key"
        zIndex="nested"
      />
      <SettingsRow
        id={id}
        label={label}
        description={description}
        layout="stacked"
        accessory={
          value ? (
            <span
              id={savedId}
              className="rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-1.5 py-0.5 font-mono text-2xs text-text-secondary"
            >
              Saved · {maskApiKey(value)}
            </span>
          ) : (
            <span id={savedId} className="text-xs text-text-secondary">
              Not set
            </span>
          )
        }
        control={({ labelId, descriptionId, disabled }) => (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-64">
                <Input
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  aria-labelledby={labelId}
                  aria-describedby={[savedId, descriptionId, statusId].filter(Boolean).join(" ")}
                  aria-invalid={status.kind === "invalid" ? true : undefined}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (status.kind !== "idle" && !busy) {
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
                  className="pr-9 font-mono placeholder:font-sans"
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={disabled || busy}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 [&_svg]:size-3.5"
                  aria-label="Show API key"
                  pressed={showKey}
                >
                  {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              </div>
              <Button
                onClick={() => void handleSave()}
                disabled={disabled || busy || !keyInput.trim()}
                loading={testing}
                size="sm"
                variant="contrast"
              >
                {onValidate ? "Check and save" : "Save"}
              </Button>
              {value ? (
                <Button
                  onClick={() => setIsRemoveConfirmOpen(true)}
                  variant="ghost-danger"
                  size="sm"
                  disabled={disabled || testing}
                  loading={removing}
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
    </>
  );
}

function ShortcutLine({ combo, label }: { combo: string | undefined; label: string }) {
  return (
    <li className="flex items-baseline gap-3">
      <span className="w-28 shrink-0">
        {combo ? (
          <KbdChord shortcut={combo} density="bare" foreground="primary" />
        ) : (
          <span>Not set</span>
        )}
      </span>
      <span>{label}</span>
    </li>
  );
}

// ── Microphone permission row ──

interface MicPermissionRowProps {
  status: MicPermissionStatus;
  isRequesting: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  note?: string | null;
}

function MicPermissionRow({
  status,
  isRequesting,
  onRequest,
  onOpenSettings,
  onRefresh,
  note,
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
          actions: null,
        };
      case "denied":
      case "restricted": {
        // Linux opens whichever sound settings app the desktop has.
        const settingsLabel = isWindows
          ? "Windows Settings"
          : isMac
            ? "System Settings"
            : "sound settings";
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

  const denied = status === "denied" || status === "restricted";
  return (
    <SettingsRow
      id="voice-mic-access"
      label="Microphone access"
      layout={denied ? "stacked" : "inline"}
      description={
        <span role="status" className="flex items-start gap-2">
          <span
            className={cn("status-mark mt-1 w-2 h-2 rounded-full shrink-0", statusDisplay.dot)}
            aria-hidden="true"
          />
          <span>
            {statusDisplay.text}
            {note ? ` ${note}` : ""}
          </span>
        </span>
      }
      control={
        denied ? (
          <SettingsRowActions>{statusDisplay.actions}</SettingsRowActions>
        ) : (
          statusDisplay.actions
        )
      }
    />
  );
}

// ── Dictionary group ──

function DictionaryGroup({
  entries,
  suggestionCount,
  learnFromCorrections,
  onLearnFromCorrectionsChange,
  onManage,
  manageRef,
}: {
  entries: VoiceDictionaryEntry[];
  suggestionCount: number;
  learnFromCorrections: boolean;
  onLearnFromCorrectionsChange: (v: boolean) => void;
  onManage: () => void;
  manageRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const rules = entries.reduce((total, entry) => total + entry.heardAs.length, 0);
  const summary = [
    pluralize(entries.length, "term"),
    pluralize(rules, "heard-as phrase"),
    pluralize(suggestionCount, "pending suggestion"),
  ].join(" · ");

  return (
    <SettingsGroup>
      <SettingsSwitchCard
        id="voice-learn-words"
        title="Learn words from corrections"
        subtitle="Suggest dictionary terms when you fix a mishearing before sending"
        isEnabled={learnFromCorrections}
        onChange={() => onLearnFromCorrectionsChange(!learnFromCorrections)}
        isModified={learnFromCorrections !== DEFAULT_SETTINGS.learnFromCorrections}
        onReset={() => onLearnFromCorrectionsChange(DEFAULT_SETTINGS.learnFromCorrections)}
      />

      <SettingsRow
        label="Terms"
        description={summary}
        control={
          <Button ref={manageRef} size="sm" variant="outline" onClick={onManage}>
            Manage dictionary
            <ChevronRight aria-hidden="true" />
          </Button>
        }
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

function CorePromptRow({ model }: { model: string }) {
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
              className={cn("transition-transform duration-150 ease-out", expanded && "rotate-90")}
            />
            {expanded ? "Hide core prompt" : "Inspect core prompt"}
          </Button>
          {expanded && (
            <pre className="bg-surface-canvas border border-border-default rounded-[var(--radius-md)] px-3 py-2 text-xs font-mono text-text-secondary whitespace-pre-wrap overflow-y-auto max-h-48 select-text">
              {correctionInstructionsFor(model).core}
            </pre>
          )}
        </div>
      }
    />
  );
}
