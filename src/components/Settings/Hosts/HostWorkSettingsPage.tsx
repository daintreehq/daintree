import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { getAgentConfig } from "@shared/config/agentRegistry";
import {
  LEAK_RESTART_THRESHOLD_MB,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsSnapshot,
  type HostSettingsUpdateResult,
} from "@shared/types/hostSettings";
import { isResumeOnRestart, type ResumeOnRestart } from "@shared/types/agentSettings";
import {
  isIdleShellThresholdMinutes,
  type IdleShellThresholdMinutes,
} from "@shared/types/ipc/idleBackgroundAutoClose";
import { isSecretEnvEntry } from "@/utils/secretDetection";
import { canopyLocalOn, canopyStopOn } from "@/components/Canopy/canopyTerms";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { clientErrorText } from "@/utils/clientAppError";
import { SettingsSection } from "../SettingsSection";
import { SettingsLoadErrorBanner } from "../SettingsLoadErrorBanner";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsActions,
  SettingsDependents,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsRow,
} from "../SettingsGroup";
import { SettingsNumberInput } from "../SettingsNumberInput";
import { SettingsPresetGroup, type SettingsPresetOption } from "../SettingsPresetGroup";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsSwitch } from "../SettingsSwitch";
import { EnvVarRow, validateEnvRows, type EnvVarDraft } from "../EnvVarRow";
import { hostEnvDrafts } from "./hostEnvDrafts";
import {
  IDLE_BACKGROUND_THRESHOLD_PRESETS,
  IDLE_SHELL_THRESHOLD_PRESETS,
  IDLE_TERMINAL_THRESHOLD_PRESETS,
  thresholdOptionsWith,
} from "../idleThresholdPresets";

interface HostWorkSettingsPageProps {
  hostId: string;
  hostName: string;
  connected: boolean;
  /** This Daintree's version: what a host lacking a setting updates to. */
  shellVersion?: string;
  /** Whether a reading is shown, for the link status above the page. */
  onReadingChange?: (hasReading: boolean) => void;
  /** Counts the closes held by this host's unsaved environment edit; 0 for none. */
  closeHeld?: number;
}

const NO_DEFAULT = "__none__";
const ENV_KEY = "globalEnvironmentVariables";

const AGENT_OPTIONS = [
  { value: NO_DEFAULT, label: "None" },
  ...BUILT_IN_AGENT_IDS.map((id) => ({ value: id, label: getAgentConfig(id)?.name ?? id })),
];

const RESUME_OPTIONS = [
  { value: "always", label: "Always" },
  { value: "on-focus", label: "On focus" },
  { value: "never", label: "Never" },
] as const satisfies readonly { value: ResumeOnRestart; label: string }[];

/** Where a change's outcome is shown: its setting's row, or one of the two Canopy rows. */
type RowSlot = HostSettingKey | "canopyReading";

/** The row names, for the status a screen reader hears when a change lands or fails. */
const ROW_LABELS: Partial<Record<RowSlot, string>> = {
  canopyMode: "Show Canopy",
  canopyReading: "Read agent terminals",
  "agentDefaults.defaultAgent": "Default agent",
  "agentSettings.resumeOnRestart": "Resume agents after restart",
  "agentSettings.globalUseAltScreen": "Use alt-screen mode",
  globalEnvironmentVariables: "Environment",
  "sessionRestore.enabled": "Restore live projects",
  "terminalConfig.resourceMonitoringEnabled": "Resource monitoring",
  "terminalConfig.memoryLeakDetectionEnabled": "Memory leak detection",
  "terminalConfig.memoryLeakAutoRestartThresholdMb": "Auto-restart threshold",
  "idleTerminalNotify.enabled": "Notify me about idle terminals",
  "idleTerminalNotify.thresholdMinutes": "Remind after",
  "idleBackgroundAutoClose.enabled": "Close idle projects automatically",
  "idleBackgroundAutoClose.thresholdMinutes": "Close after",
  "idleBackgroundAutoClose.includeIdleShells": "Include projects with idle terminals",
  "idleBackgroundAutoClose.idleShellThresholdMinutes": "Sleep after",
};

const LEAK_RANGE_ERROR = `Enter a value from ${LEAK_RESTART_THRESHOLD_MB.min.toLocaleString()} to ${LEAK_RESTART_THRESHOLD_MB.max.toLocaleString()} MB`;

function outcomeError(result: HostSettingsUpdateResult): string | null {
  switch (result.outcome) {
    case "applied":
      return null;
    case "conflict":
      return `This changed on ${result.hostName} since it was read. Its current value is shown.`;
    case "not-applied":
      return `${result.hostName} didn't make the change.`;
    case "unconfirmed":
      // Said once the page has read the host again (or couldn't), in `change`.
      return null;
  }
}

function envRows(record: Record<string, string>): EnvVarDraft[] {
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ id: `env-${crypto.randomUUID()}`, key, value }));
}

function envRecord(rows: readonly EnvVarDraft[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) record[key] = row.value;
  }
  return record;
}

function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  );
}

function isEnvRecord(value: HostSettingValue | undefined): value is Record<string, string> {
  return typeof value === "object" && value !== null;
}

/**
 * "Saving…" beside a row's label, once its change has taken longer than a blink.
 * The region is there from the start and the words arrive later, so it is spoken.
 */
function SavingMark() {
  const shown = useDeferredLoading(true, UI_INLINE_LOADING_GATE_MS);
  return (
    <span role="status" className="text-xs font-normal text-text-secondary">
      {shown ? "Saving…" : ""}
    </span>
  );
}

/** Where a value will be while the host is being read: the row's shape, no made-up value. */
function ValueBone({ kind }: { kind: "switch" | "select" | "preset" }) {
  const size =
    kind === "switch"
      ? "h-5 w-9 rounded-full"
      : kind === "select"
        ? `h-8 ${SETTINGS_CONTROL_WIDTH.select} rounded-[var(--radius-md)]`
        : "h-7 w-36 rounded-[var(--radius-md)]";
  return <SkeletonBone className={size} />;
}

/**
 * A machine's work settings, read from it and changed on it by name (#14167,
 * #14706): no window or project there is needed, and nothing here changes
 * any other machine. Each change is made against the value shown, so one
 * made there meanwhile is reported, never written over. A setting the
 * machine's Daintree is too old to know shows as unavailable, with the update
 * that makes it editable.
 *
 * Changes are independent: each row marks its own write and keeps its own
 * failure, so one slow round trip never stills the rest of the page. A reading
 * outlives a dropped link, shown as last read and locked until the host is
 * back, so an unsaved environment edit isn't lost with it.
 */
export function HostWorkSettingsPage({
  hostId,
  hostName,
  connected,
  shellVersion,
  onReadingChange,
  closeHeld = 0,
}: HostWorkSettingsPageProps) {
  const [snapshot, setSnapshot] = useState<HostSettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<RowSlot, string>>>({});
  /** Changes on their way, by setting: the value asked for and the row that asked. */
  const [pending, setPending] = useState<
    ReadonlyMap<HostSettingKey, { value: HostSettingValue; slot: RowSlot }>
  >(() => new Map());
  const [announcement, setAnnouncement] = useState("");
  const [confirmCanopy, setConfirmCanopy] = useState(false);
  const [leakDraft, setLeakDraft] = useState<string | null>(null);
  /** Read since the link last came up: a reading from before a drop is shown, not trusted. */
  const [fresh, setFresh] = useState(false);
  // An unsaved environment edit left on this host earlier in this open of Settings,
  // taken once so the form stays put through a Discard made before any reading.
  const [keptEnvDraft] = useState(() => hostEnvDrafts.get(hostId));
  // A reply for a host this page no longer shows is dropped.
  const shownHost = useRef(hostId);
  useEffect(() => {
    shownHost.current = hostId;
  }, [hostId]);
  // One change per setting at a time, set before any render: Enter and the blur
  // after it would otherwise send the same change twice against one revision.
  const inFlight = useRef(new Set<HostSettingKey>());

  /** Resolves true when the host answered with its settings. */
  const load = useCallback((): Promise<boolean> => {
    const asked = hostId;
    return window.electron.hostSettings.read({ hostId }).then(
      (next) => {
        if (shownHost.current !== asked) return false;
        setSnapshot(next);
        setLoadError(null);
        setFresh(true);
        return true;
      },
      (err: unknown) => {
        if (shownHost.current !== asked) return false;
        setLoadError(clientErrorText(err, `Couldn't read settings on ${hostName}`));
        return false;
      }
    );
  }, [hostId, hostName]);

  // Read on every connect. A reading taken before a drop stays on screen, locked,
  // until the fresh one replaces it.
  useEffect(() => {
    if (connected) void load();
    else setFresh(false);
  }, [connected, load]);

  useEffect(() => {
    onReadingChange?.(snapshot !== null);
  }, [snapshot, onReadingChange]);
  useEffect(() => () => onReadingChange?.(false), [onReadingChange]);

  const leafOf = (key: HostSettingKey) => snapshot?.settings.find((leaf) => leaf.key === key);
  const valueOf = (key: HostSettingKey): HostSettingValue | undefined => {
    const asked = pending.get(key);
    return asked ? asked.value : leafOf(key)?.value;
  };
  const ready = snapshot !== null;
  const live = connected && ready && fresh;
  const reading = connected && !ready && loadError === null;

  const retryRead = () => {
    setLoadError(null);
    void load();
  };

  const clearError = (slot: RowSlot) =>
    setErrors((current) => {
      if (!(slot in current)) return current;
      const next = { ...current };
      delete next[slot];
      return next;
    });

  /**
   * One change, made against the revision shown (or `expectRevision`, the one
   * an edit was started from); the host's answer replaces what is shown. When
   * the answer can't be trusted for that (unconfirmed, or a restarted host) the
   * page reads the host again. Resolves with the outcome.
   */
  const change = (
    key: HostSettingKey,
    value: HostSettingValue,
    slot: RowSlot = key,
    expectRevision?: string
  ): Promise<HostSettingsUpdateResult["outcome"] | "failed" | "skipped"> => {
    const leaf = leafOf(key);
    // Only against a reading taken since the link came up: an older one may be out of date.
    if (!snapshot || !leaf || !live || inFlight.current.has(key)) {
      return Promise.resolve("skipped");
    }
    inFlight.current.add(key);
    setPending((current) => new Map(current).set(key, { value, slot }));
    clearError(slot);
    const asked = hostId;
    const instanceId = snapshot.instanceId;
    const label = ROW_LABELS[slot] ?? "Setting";
    const settle = () => {
      inFlight.current.delete(key);
      setPending((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    };
    return window.electron.hostSettings
      .update({
        hostId,
        patch: { [key]: value },
        expect: { instanceId, revisions: { [key]: expectRevision ?? leaf.revision } },
      })
      .then(
        (result) => {
          if (shownHost.current !== asked) {
            settle();
            return "skipped" as const;
          }
          // The environment form says what a conflict means for the edit it keeps.
          const error =
            key === ENV_KEY && result.outcome === "conflict" ? null : outcomeError(result);
          if (error) setErrors((current) => ({ ...current, [slot]: error }));
          setAnnouncement(
            error ? `${label}: ${error}` : result.outcome === "applied" ? `${label} saved` : ""
          );
          if (result.outcome === "unconfirmed" || result.instanceId !== instanceId) {
            return load().then((verified) => {
              if (result.outcome === "unconfirmed") {
                // Only a fresh reading earns "its current value is shown".
                const text = verified
                  ? `${result.hostName} didn't confirm the change. Its current value is shown.`
                  : `${result.hostName} didn't confirm the change, and its current value couldn't be read.`;
                setErrors((current) => ({ ...current, [slot]: text }));
                setAnnouncement(`${label}: ${text}`);
              }
              settle();
              return result.outcome;
            });
          }
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  settings: current.settings.map(
                    (old) => result.settings.find((fresh) => fresh.key === old.key) ?? old
                  ),
                }
              : current
          );
          settle();
          return result.outcome;
        },
        (err: unknown) => {
          if (shownHost.current === asked) {
            const text = clientErrorText(err, `Couldn't change this on ${hostName}`);
            setErrors((current) => ({ ...current, [slot]: text }));
            setAnnouncement(`${label}: ${text}`);
          }
          settle();
          return "failed" as const;
        }
      );
  };

  const unavailable = (key: HostSettingKey) => snapshot?.unavailable.includes(key) ?? false;
  const updateReason = shellVersion
    ? `Needs Daintree ${shellVersion} or later on this host`
    : "Needs a newer Daintree on this host";
  const savingMark = (slot: RowSlot) =>
    [...pending.values()].some((entry) => entry.slot === slot) ? <SavingMark /> : undefined;

  /** A setting this host's Daintree doesn't have: its name and why, never a made-up value. */
  const unavailableRow = (label: string, description: ReactNode) => (
    <SettingsRow label={label} description={description} disabled disabledReason={updateReason} />
  );

  const placeholderRow = (
    label: string,
    description: ReactNode,
    kind: "switch" | "select" | "preset"
  ) => (
    <SettingsRow
      label={label}
      description={description}
      // A value only has a place held while it is on its way; one that can't be read
      // isn't drawn at all, so a failed or offline page never looks like a loading one.
      control={reading ? <ValueBone kind={kind} /> : undefined}
    />
  );

  const switchRow = ({
    key,
    label,
    description,
    checked = valueOf(key) === true,
    onChange = (next) => void change(key, next),
  }: {
    key: HostSettingKey;
    label: string;
    description: ReactNode;
    checked?: boolean;
    onChange?: (next: boolean) => void;
  }) => {
    if (!ready) return placeholderRow(label, description, "switch");
    if (unavailable(key)) return unavailableRow(label, description);
    return (
      <SettingsRow
        label={label}
        description={description}
        accessory={savingMark(key)}
        error={errors[key]}
        disabled={!live}
        control={({ labelId, descriptionId, disabled }) => (
          <SettingsSwitch
            checked={checked}
            onCheckedChange={onChange}
            disabled={disabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
          />
        )}
      />
    );
  };

  const presetRow = <T extends string | number>({
    key,
    label,
    description,
    options,
    value,
  }: {
    key: HostSettingKey;
    label: string;
    description: string;
    options: readonly SettingsPresetOption<T>[];
    value: T | null;
  }) => {
    if (!ready) return placeholderRow(label, description, "preset");
    if (unavailable(key)) return unavailableRow(label, description);
    return (
      <SettingsPresetGroup<T>
        label={label}
        description={description}
        options={options}
        value={value}
        onChange={(next) => void change(key, next)}
        disabled={!live}
        error={errors[key]}
        status={savingMark(key)}
      />
    );
  };

  const leakKey = "terminalConfig.memoryLeakAutoRestartThresholdMb";
  const commitLeak = () => {
    if (leakDraft === null) return;
    const next = Number(leakDraft);
    if (
      !Number.isInteger(next) ||
      next < LEAK_RESTART_THRESHOLD_MB.min ||
      next > LEAK_RESTART_THRESHOLD_MB.max
    ) {
      // The entry stays as typed beside what's wrong with it, until it's fixed.
      setErrors((current) => ({ ...current, [leakKey]: LEAK_RANGE_ERROR }));
      return;
    }
    if (next === valueOf(leakKey)) {
      setLeakDraft(null);
      clearError(leakKey);
      return;
    }
    void change(leakKey, next).then((outcome) => {
      if (outcome !== "skipped") setLeakDraft(null);
    });
  };

  const minutesOf = (key: HostSettingKey) => {
    const value = valueOf(key);
    return typeof value === "number" ? value : null;
  };

  const canopy = valueOf("canopyMode");
  // A host from before Canopy read locally has no model to name: it is updated before it is turned on.
  const canopyLocal = snapshot?.settings.some((leaf) => leaf.key === "canopyModel") ?? false;
  const canopyHidden = canopy === "hidden";
  const canopyOn = canopy === "on";
  const defaultAgent = valueOf("agentDefaults.defaultAgent");
  const resume = valueOf("agentSettings.resumeOnRestart");
  const leakValue = valueOf(leakKey);
  const shellThreshold = valueOf("idleBackgroundAutoClose.idleShellThresholdMinutes");
  /** A dependent is held off only by a parent that is known, there, and off. */
  const parentOff = (key: HostSettingKey) => ready && !unavailable(key) && valueOf(key) !== true;

  return (
    <>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {reading && <Skeleton label={`Reading ${hostName}'s settings`} className="sr-only" />}
      <div className="space-y-8">
        {loadError && (
          <SettingsLoadErrorBanner
            title={`Couldn't read ${hostName}'s settings`}
            message={loadError}
            onRetry={retryRead}
          />
        )}

        <SettingsSection title="Agents">
          <SettingsGroup>
            {!ready ? (
              placeholderRow("Default agent", "The agent new terminals start with", "select")
            ) : unavailable("agentDefaults.defaultAgent") ? (
              unavailableRow("Default agent", "The agent new terminals start with")
            ) : (
              <SettingsSelect
                label="Default agent"
                description="The agent new terminals start with"
                value={typeof defaultAgent === "string" ? defaultAgent : NO_DEFAULT}
                onValueChange={(next) =>
                  void change("agentDefaults.defaultAgent", next === NO_DEFAULT ? null : next)
                }
                options={AGENT_OPTIONS}
                disabled={!live}
                error={errors["agentDefaults.defaultAgent"]}
                status={savingMark("agentDefaults.defaultAgent")}
              />
            )}
            {presetRow<ResumeOnRestart>({
              key: "agentSettings.resumeOnRestart",
              label: "Resume agents after restart",
              description: "What agent panes do when Daintree restarts",
              options: RESUME_OPTIONS,
              value: isResumeOnRestart(resume) ? resume : null,
            })}
            {switchRow({
              key: "agentSettings.globalUseAltScreen",
              label: "Use alt-screen mode",
              description:
                "Render supported agents on the full-screen alternate buffer instead of inline",
            })}
          </SettingsGroup>
        </SettingsSection>

        {!ready && !keptEnvDraft ? (
          <SettingsSection title="Environment" description={ENV_DESCRIPTION}>
            <SettingsGroup>
              {reading ? (
                [0, 1].map((row) => (
                  <div key={row} className="flex items-center gap-3 py-3 pl-4 pr-12">
                    <SkeletonBone className="h-8 flex-[2] rounded-[var(--radius-md)]" />
                    <SkeletonBone className="h-8 flex-[3] rounded-[var(--radius-md)]" />
                  </div>
                ))
              ) : (
                <SettingsEmptyRow>Not read yet</SettingsEmptyRow>
              )}
            </SettingsGroup>
          </SettingsSection>
        ) : unavailable(ENV_KEY) ? (
          <SettingsSection title="Environment" description={ENV_DESCRIPTION}>
            <SettingsGroup>{unavailableRow("Variables", undefined)}</SettingsGroup>
          </SettingsSection>
        ) : (
          <HostEnvironmentSection
            hostId={hostId}
            closeHeld={closeHeld}
            canSave={live}
            hostName={hostName}
            // Before a reading, a kept edit stands on the set it was started from, so
            // it can still be seen and discarded while the host can't be reached.
            value={ready ? leafOf(ENV_KEY)?.value : (keptEnvDraft?.base.record ?? undefined)}
            revision={ready ? leafOf(ENV_KEY)?.revision : keptEnvDraft?.base.revision}
            connected={connected}
            saving={pending.has(ENV_KEY)}
            error={errors[ENV_KEY]}
            onSave={(record, baseRevision) => change(ENV_KEY, record, ENV_KEY, baseRevision)}
          />
        )}

        <SettingsSection title="Terminals">
          <SettingsGroup>
            {switchRow({
              key: "sessionRestore.enabled",
              label: "Restore live projects",
              description:
                "Bring back every project that was running, not just the one each window was showing",
            })}
            {switchRow({
              key: "terminalConfig.resourceMonitoringEnabled",
              label: "Resource monitoring",
              description: "Show per-terminal CPU and memory in panel headers",
            })}
            <SettingsDependents
              disabled={parentOff("terminalConfig.resourceMonitoringEnabled")}
              reason="Turn on resource monitoring to detect memory leaks"
            >
              {switchRow({
                key: "terminalConfig.memoryLeakDetectionEnabled",
                label: "Memory leak detection",
                description:
                  "Warn when a terminal's memory keeps growing, with options to restart it",
              })}
              <SettingsDependents
                disabled={parentOff("terminalConfig.memoryLeakDetectionEnabled")}
                reason={
                  parentOff("terminalConfig.resourceMonitoringEnabled")
                    ? undefined
                    : "Turn on memory leak detection to restart terminals automatically"
                }
              >
                {!ready ? (
                  placeholderRow("Auto-restart threshold", LEAK_DESCRIPTION, "preset")
                ) : unavailable(leakKey) ? (
                  unavailableRow("Auto-restart threshold", LEAK_DESCRIPTION)
                ) : (
                  <SettingsNumberInput
                    label="Auto-restart threshold"
                    description={LEAK_DESCRIPTION}
                    suffix="MB"
                    min={LEAK_RESTART_THRESHOLD_MB.min}
                    max={LEAK_RESTART_THRESHOLD_MB.max}
                    step={1024}
                    value={leakDraft ?? (typeof leakValue === "number" ? String(leakValue) : "")}
                    onChange={(event) => setLeakDraft(event.target.value)}
                    onBlur={commitLeak}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitLeak();
                    }}
                    // Held as sent while it is on its way; focus stays, so nothing typed is lost.
                    readOnly={pending.has(leakKey)}
                    disabled={!live}
                    error={errors[leakKey]}
                    status={savingMark(leakKey)}
                  />
                )}
              </SettingsDependents>
            </SettingsDependents>
            {switchRow({
              key: "idleTerminalNotify.enabled",
              label: "Notify me about idle terminals",
              description:
                "A reminder when terminals in background projects go quiet, offering to put the project to sleep — nothing sleeps on its own",
            })}
            <SettingsDependents
              disabled={parentOff("idleTerminalNotify.enabled")}
              reason="Turn on idle terminal reminders to choose when they appear"
            >
              {presetRow<number>({
                key: "idleTerminalNotify.thresholdMinutes",
                label: "Remind after",
                description: "How long background terminals stay quiet before the reminder",
                options: thresholdOptionsWith(
                  IDLE_TERMINAL_THRESHOLD_PRESETS,
                  minutesOf("idleTerminalNotify.thresholdMinutes")
                ),
                value: minutesOf("idleTerminalNotify.thresholdMinutes"),
              })}
            </SettingsDependents>
          </SettingsGroup>
        </SettingsSection>

        <SettingsSection
          title="Idle projects"
          description="Frees memory from background projects nobody is using"
        >
          <SettingsGroup>
            {switchRow({
              key: "idleBackgroundAutoClose.enabled",
              label: "Close idle projects automatically",
              description:
                "Background projects with no open terminals close, and reopen with their panels",
            })}
            <SettingsDependents
              disabled={parentOff("idleBackgroundAutoClose.enabled")}
              reason="Turn on closing idle projects to choose when it happens"
            >
              {presetRow<number>({
                key: "idleBackgroundAutoClose.thresholdMinutes",
                label: "Close after",
                description:
                  "How long a background project with no open terminals sits idle before it closes",
                options: thresholdOptionsWith(
                  IDLE_BACKGROUND_THRESHOLD_PRESETS,
                  minutesOf("idleBackgroundAutoClose.thresholdMinutes")
                ),
                value: minutesOf("idleBackgroundAutoClose.thresholdMinutes"),
              })}
              {switchRow({
                key: "idleBackgroundAutoClose.includeIdleShells",
                label: "Include projects with idle terminals",
                description:
                  "Also sleeps projects whose shells and agents sit with nothing running",
              })}
              <SettingsDependents
                disabled={parentOff("idleBackgroundAutoClose.includeIdleShells")}
                reason={
                  parentOff("idleBackgroundAutoClose.enabled")
                    ? undefined
                    : "Include projects with idle terminals to choose when they sleep"
                }
              >
                {presetRow<IdleShellThresholdMinutes>({
                  key: "idleBackgroundAutoClose.idleShellThresholdMinutes",
                  label: "Sleep after",
                  description:
                    "How long a project with terminals stays off screen with no terminal input or output",
                  options: IDLE_SHELL_THRESHOLD_PRESETS,
                  value: isIdleShellThresholdMinutes(shellThreshold) ? shellThreshold : null,
                })}
              </SettingsDependents>
            </SettingsDependents>
          </SettingsGroup>
        </SettingsSection>

        <SettingsSection title="Canopy">
          <SettingsGroup>
            {switchRow({
              key: "canopyMode",
              label: "Show Canopy",
              description:
                "Its toolbar button, shortcut and command palette entry. Hiding it also stops reading",
              checked: !canopyHidden,
              onChange: (show) => void change("canopyMode", show ? "unset" : "hidden"),
            })}
            <SettingsDependents
              disabled={
                ready && !unavailable("canopyMode") && (canopyHidden || (!canopyLocal && !canopyOn))
              }
              reason={
                canopyLocal ? "Show Canopy to turn it on" : `${updateReason} to turn Canopy on`
              }
            >
              {!ready ? (
                placeholderRow("Read agent terminals", CANOPY_READ_DESCRIPTION, "switch")
              ) : unavailable("canopyMode") ? (
                unavailableRow("Read agent terminals", CANOPY_READ_DESCRIPTION)
              ) : (
                <SettingsRow
                  label="Read agent terminals"
                  description={CANOPY_READ_DESCRIPTION}
                  accessory={savingMark("canopyReading")}
                  error={errors.canopyReading}
                  disabled={!live}
                  control={({ labelId, descriptionId, disabled }) => (
                    <SettingsSwitch
                      checked={canopyOn}
                      onCheckedChange={(on) => {
                        if (on) setConfirmCanopy(true);
                        else void change("canopyMode", "unset", "canopyReading");
                      }}
                      disabled={disabled}
                      aria-labelledby={labelId}
                      aria-describedby={descriptionId}
                    />
                  )}
                />
              )}
            </SettingsDependents>
          </SettingsGroup>
        </SettingsSection>

        <ConfirmDialog
          isOpen={confirmCanopy}
          onClose={() => setConfirmCanopy(false)}
          variant="default"
          title={`Turn Canopy on for '${hostName}'?`}
          description={`${canopyLocalOn(hostName)} ${canopyStopOn(hostName)}`}
          confirmLabel="Turn Canopy on"
          onConfirm={() => {
            setConfirmCanopy(false);
            void change("canopyMode", "on", "canopyReading");
          }}
        />
      </div>
    </>
  );
}

/** How an `aria-disabled` button looks and acts unavailable while keeping focus. */
const UNAVAILABLE_BUTTON = "aria-disabled:opacity-50 aria-disabled:pointer-events-none";

const ENV_DESCRIPTION =
  "Injected into every new terminal in every project. A project variable with the same name overrides one of these.";
const LEAK_DESCRIPTION = `Restart a terminal automatically once its memory (RSS) passes this. ${LEAK_RESTART_THRESHOLD_MB.min.toLocaleString()}–${LEAK_RESTART_THRESHOLD_MB.max.toLocaleString()} MB.`;
const CANOPY_READ_DESCRIPTION =
  "Downloads the model the first time. When off, Canopy lets the model go and deletes its readings";

/**
 * The host's global variables, edited as a whole and saved explicitly against
 * the set the edit started from: a change made there meanwhile is reported,
 * never written over. The edit outlives a dropped link and a fresh reading;
 * one that brings a different set says so, and the next Save is made knowing it.
 */
function HostEnvironmentSection({
  hostId,
  closeHeld,
  canSave,
  hostName,
  value,
  revision,
  connected,
  saving,
  error,
  onSave,
}: {
  hostId: string;
  closeHeld: number;
  /** A reading taken since the link came up: a Save made against an older one may be stale. */
  canSave: boolean;
  hostName: string;
  value: HostSettingValue | undefined;
  revision: string | undefined;
  connected: boolean;
  saving: boolean;
  error: string | undefined;
  onSave: (
    record: Record<string, string>,
    baseRevision: string | undefined
  ) => Promise<HostSettingsUpdateResult["outcome"] | "failed" | "skipped">;
}) {
  const saved = isEnvRecord(value) ? value : null;
  // An edit left here when another machine was picked picks up where it was.
  const [rows, setRows] = useState<EnvVarDraft[]>(
    () => hostEnvDrafts.get(hostId)?.rows ?? (saved ? envRows(saved) : [])
  );
  /** The set the edit started from, and the revision a Save is made against. */
  const [base, setBase] = useState<{ record: Record<string, string> | null; revision?: string }>(
    () => hostEnvDrafts.get(hostId)?.base ?? { record: saved, revision }
  );
  const [movedUnder, setMovedUnder] = useState(
    () => hostEnvDrafts.get(hostId)?.movedUnder ?? false
  );
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [saveAttempted, setSaveAttempted] = useState(false);
  const actionsId = useId();

  const draft = envRecord(rows);
  // A value typed before its name isn't in the set yet, but it is still an edit to keep.
  const hasPartialRow = rows.some((row) => !row.key.trim() && row.value.trim() !== "");
  const dirty = base.record !== null && (!sameEnv(draft, base.record) || hasPartialRow);
  // A new reading: taken as it is when nothing is edited (or the edit is what it
  // now holds); otherwise the edit stays, and the next Save replaces the new set.
  if (revision !== base.revision) {
    if (!dirty || (saved !== null && sameEnv(draft, saved) && !hasPartialRow)) {
      setBase({ record: saved, revision });
      setRows(saved ? envRows(saved) : []);
      setMovedUnder(false);
    } else {
      setBase({ record: saved, revision });
      setMovedUnder(true);
    }
  }

  useEffect(() => {
    if (dirty) hostEnvDrafts.set(hostId, { rows, base, movedUnder });
    else hostEnvDrafts.delete(hostId);
  }, [dirty, rows, base, movedUnder, hostId]);

  // A held close lands here: the reason and both ways out, in view.
  useEffect(() => {
    if (closeHeld === 0) return;
    const frame = requestAnimationFrame(() => {
      const actions = document.getElementById(actionsId);
      actions?.scrollIntoView({ block: "nearest" });
      // Save when it can save; otherwise Discard, the one way out while the host is away.
      const way =
        actions?.querySelector<HTMLElement>('[data-host-env-save]:not([aria-disabled="true"])') ??
        actions?.querySelector<HTMLElement>('[data-host-env-discard]:not([aria-disabled="true"])');
      way?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [closeHeld, actionsId]);

  const rowErrors = saveAttempted ? validateEnvRows(rows) : {};
  const errorCount = Object.keys(rowErrors).length;
  // Offline, or until the host is read again, the edit is kept and shown but not added to.
  const locked = saving || saved === null || !canSave;
  const canSaveDraft = dirty && !locked;
  const canDiscard = dirty && !saving;

  const save = async () => {
    setSaveAttempted(true);
    if (Object.keys(validateEnvRows(rows)).length > 0) return;
    if ((await onSave(draft, base.revision)) === "applied") {
      setSaveAttempted(false);
      setMovedUnder(false);
    }
  };

  const discard = () => {
    if (!saved) return;
    setRows(envRows(saved));
    setBase({ record: saved, revision });
    setRevealed(new Set());
    setSaveAttempted(false);
    setMovedUnder(false);
  };

  const addButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={locked}
      onClick={() =>
        setRows((prev) => [...prev, { id: `env-${crypto.randomUUID()}`, key: "", value: "" }])
      }
    >
      <Plus aria-hidden="true" />
      Add variable
    </Button>
  );

  const status = error ? (
    <InlineError role="alert">{error}</InlineError>
  ) : errorCount > 0 ? (
    <InlineError>
      {errorCount === 1
        ? "Fix the name above to save"
        : `Fix the ${errorCount} names above to save`}
    </InlineError>
  ) : dirty && movedUnder ? (
    <InlineError role="alert">
      {`These changed on ${hostName} since you started editing. Save replaces them, Discard takes them`}
    </InlineError>
  ) : dirty && closeHeld > 0 ? (
    <InlineError role="alert">Save or discard these changes to close Settings</InlineError>
  ) : dirty && !connected ? (
    "Unsaved changes, kept until the host reconnects"
  ) : dirty && !canSave ? (
    "Unsaved changes, kept until its settings are read again"
  ) : dirty ? (
    "Unsaved changes"
  ) : (
    "Applies to new terminals"
  );

  return (
    <SettingsSection
      title="Environment"
      description={ENV_DESCRIPTION}
      action={rows.length > 0 ? addButton : undefined}
    >
      <SettingsGroup>
        {rows.length === 0 ? (
          <SettingsEmptyRow action={addButton}>
            Add a variable to set it in every new terminal
          </SettingsEmptyRow>
        ) : (
          rows.map((row, index) => (
            <EnvVarRow
              key={row.id}
              row={row}
              position={index + 1}
              error={rowErrors[row.id]}
              // Name or value, as the global editor masks; a reveal holds while the row is edited.
              sensitive={isSecretEnvEntry(row.key, row.value)}
              revealed={revealed.has(row.id)}
              onToggleReveal={() =>
                setRevealed((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  return next;
                })
              }
              onKeyChange={(key) =>
                setRows((prev) => prev.map((r, i) => (i === index ? { ...r, key } : r)))
              }
              onValueChange={(text) =>
                setRows((prev) => prev.map((r, i) => (i === index ? { ...r, value: text } : r)))
              }
              onDelete={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              valuePlaceholder="e.g. /usr/local/bin"
              disabled={locked}
            />
          ))
        )}
        {/* Unavailable rather than disabled: pressing Save or Discard makes the group
            clean and so turns them off, and a natively disabled button drops focus. */}
        <SettingsActions status={status} rootAttributes={{ id: actionsId }}>
          <Button
            variant="outline"
            size="sm"
            data-host-env-discard=""
            aria-disabled={!canDiscard || undefined}
            className={UNAVAILABLE_BUTTON}
            onClick={() => {
              if (canDiscard) discard();
            }}
          >
            Discard
          </Button>
          <Button
            variant="contrast"
            size="sm"
            data-host-env-save=""
            loading={saving}
            aria-disabled={!canSaveDraft || undefined}
            className={saving ? undefined : UNAVAILABLE_BUTTON}
            onClick={() => {
              if (canSaveDraft) void save();
            }}
          >
            Save
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsSection>
  );
}
