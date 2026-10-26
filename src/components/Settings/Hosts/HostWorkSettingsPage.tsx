import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { getAgentConfig } from "@shared/config/agentRegistry";
import {
  IDLE_THRESHOLD_MINUTES,
  LEAK_RESTART_THRESHOLD_MB,
  type HostSettingKey,
  type HostSettingValue,
  type HostSettingsSnapshot,
  type HostSettingsUpdateResult,
} from "@shared/types/hostSettings";
import type { ResumeOnRestart } from "@shared/types/agentSettings";
import type { IdleShellThresholdMinutes } from "@shared/types/ipc/idleBackgroundAutoClose";
import { isSensitiveEnvKey } from "@shared/utils/envVars";
import { canopyLocalOn, canopyStopOn } from "@/components/Canopy/canopyTerms";
import { clientErrorText } from "@/utils/clientAppError";
import { SettingsSection } from "../SettingsSection";
import {
  SettingsActions,
  SettingsDependents,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsRow,
} from "../SettingsGroup";
import { SettingsNumberInput } from "../SettingsNumberInput";
import { SettingsPresetGroup } from "../SettingsPresetGroup";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsSwitch } from "../SettingsSwitch";
import { EnvVarRow, validateEnvRows, type EnvVarDraft } from "../EnvVarRow";

interface HostWorkSettingsPageProps {
  hostId: string;
  hostName: string;
  connected: boolean;
  /** This Daintree's version: what a host lacking a setting updates to. */
  shellVersion?: string;
}

const NO_DEFAULT = "__none__";

const AGENT_OPTIONS = [
  { value: NO_DEFAULT, label: "None" },
  ...BUILT_IN_AGENT_IDS.map((id) => ({ value: id, label: getAgentConfig(id)?.name ?? id })),
];

const RESUME_OPTIONS = [
  { value: "always", label: "Always" },
  { value: "on-focus", label: "On focus" },
  { value: "never", label: "Never" },
] as const satisfies readonly { value: ResumeOnRestart; label: string }[];

const IDLE_SHELL_OPTIONS = [
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 240, label: "4h" },
  { value: 480, label: "8h" },
] as const satisfies readonly { value: IdleShellThresholdMinutes; label: string }[];

function outcomeError(result: HostSettingsUpdateResult): string | null {
  switch (result.outcome) {
    case "applied":
      return null;
    case "conflict":
      return `This changed on ${result.hostName} since it was read. Its current value is shown.`;
    case "not-applied":
      return `${result.hostName} didn't make the change.`;
    case "unconfirmed":
      return `${result.hostName} didn't confirm the change. Refresh to see what it has now.`;
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
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

function isEnvRecord(value: HostSettingValue | undefined): value is Record<string, string> {
  return typeof value === "object" && value !== null;
}

/**
 * A machine's work settings, read from it and changed on it by name (#14167,
 * #14706): no window or project there is needed, and nothing here changes
 * any other machine. Each change is made against the value shown, so one
 * made there meanwhile is reported, never written over. A setting the
 * machine's Daintree is too old to know shows as unavailable, with the update
 * that makes it editable.
 */
export function HostWorkSettingsPage({
  hostId,
  hostName,
  connected,
  shellVersion,
}: HostWorkSettingsPageProps) {
  const [snapshot, setSnapshot] = useState<HostSettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: HostSettingKey; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCanopy, setConfirmCanopy] = useState(false);
  const [idleThreshold, setIdleThreshold] = useState("");
  const [sleepThreshold, setSleepThreshold] = useState("");
  const [leakThreshold, setLeakThreshold] = useState("");
  // A reply for a host this page no longer shows is dropped.
  const shownHost = useRef(hostId);
  useEffect(() => {
    shownHost.current = hostId;
  }, [hostId]);
  // One change at a time, set before any render: Enter and the blur after it
  // would otherwise send the same change twice against one revision.
  const inFlight = useRef(false);

  const load = useCallback((): Promise<void> => {
    const asked = hostId;
    return window.electron.hostSettings.read({ hostId }).then(
      (next) => {
        if (shownHost.current !== asked) return;
        setSnapshot(next);
        setLoadError(null);
      },
      (err: unknown) => {
        if (shownHost.current !== asked) return;
        setLoadError(clientErrorText(err, `Couldn't read settings on ${hostName}`));
      }
    );
  }, [hostId, hostName]);

  useEffect(() => {
    setSnapshot(null);
    setRowError(null);
    if (connected) void load();
  }, [connected, load]);

  const valueOf = (key: HostSettingKey): HostSettingValue | undefined =>
    snapshot?.settings.find((leaf) => leaf.key === key)?.value;
  const revisionOf = (key: HostSettingKey): string | undefined =>
    snapshot?.settings.find((leaf) => leaf.key === key)?.revision;

  useEffect(() => {
    const text = (key: HostSettingKey) => {
      const value = snapshot?.settings.find((leaf) => leaf.key === key)?.value;
      return typeof value === "number" ? String(value) : "";
    };
    setIdleThreshold(text("idleTerminalNotify.thresholdMinutes"));
    setSleepThreshold(text("idleBackgroundAutoClose.thresholdMinutes"));
    setLeakThreshold(text("terminalConfig.memoryLeakAutoRestartThresholdMb"));
  }, [snapshot]);

  /**
   * One change, made against the revision shown; the host's answer replaces
   * what is shown. When the answer can't be trusted for that (unconfirmed, or
   * a restarted host) the controls stay disabled until the host is read again.
   * Resolves true when the host applied it.
   */
  const change = (key: HostSettingKey, value: HostSettingValue): Promise<boolean> => {
    const leaf = snapshot?.settings.find((candidate) => candidate.key === key);
    if (!snapshot || !leaf || inFlight.current) return Promise.resolve(false);
    inFlight.current = true;
    setBusy(true);
    setRowError(null);
    const asked = hostId;
    const instanceId = snapshot.instanceId;
    const settle = (applied: boolean) => {
      inFlight.current = false;
      setBusy(false);
      return applied;
    };
    return window.electron.hostSettings
      .update({
        hostId,
        patch: { [key]: value },
        expect: { instanceId, revisions: { [key]: leaf.revision } },
      })
      .then(
        (result) => {
          if (shownHost.current !== asked) return settle(false);
          const error = outcomeError(result);
          if (error) setRowError({ key, text: error });
          const applied = result.outcome === "applied";
          if (result.outcome === "unconfirmed" || result.instanceId !== instanceId) {
            return load().then(() => settle(applied));
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
          return settle(applied);
        },
        (err: unknown) => {
          if (shownHost.current === asked) {
            setRowError({ key, text: clientErrorText(err, `Couldn't change this on ${hostName}`) });
          }
          return settle(false);
        }
      );
  };

  const unavailable = (key: HostSettingKey) => snapshot?.unavailable.includes(key) ?? false;
  const updateReason = shellVersion
    ? `Update Daintree on ${hostName} to ${shellVersion} or later to change this here`
    : `Update Daintree on ${hostName} to change this here`;
  const reasonFor = (key: HostSettingKey) => (unavailable(key) ? updateReason : undefined);
  const errorFor = (key: HostSettingKey) => (rowError?.key === key ? rowError.text : undefined);
  const lockedFor = (key: HostSettingKey) => busy || unavailable(key);

  const commitNumber = (
    key: HostSettingKey,
    text: string,
    bounds: { min: number; max: number },
    unit: string,
    reset: (value: string) => void
  ) => {
    const next = Number(text);
    const current = valueOf(key);
    if (!Number.isInteger(next) || next < bounds.min || next > bounds.max) {
      setRowError({ key, text: `Enter ${bounds.min} to ${bounds.max} ${unit}.` });
      if (typeof current === "number") reset(String(current));
      return;
    }
    if (next !== current) void change(key, next);
  };

  const switchRow = (
    key: HostSettingKey,
    label: string,
    description: string,
    checked: boolean,
    onChange: (next: boolean) => void = (next) => void change(key, next)
  ) => (
    <SettingsRow
      label={label}
      description={description}
      error={errorFor(key)}
      disabled={lockedFor(key)}
      disabledReason={reasonFor(key)}
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

  if (!connected || loadError || snapshot === null) {
    return (
      <SettingsSection
        title={`Settings on ${hostName}`}
        description={`Changed in Daintree on ${hostName} itself. Nothing here changes any other machine`}
      >
        <SettingsGroup>
          {!connected ? (
            <SettingsEmptyRow>Connect to {hostName} to see and change its settings</SettingsEmptyRow>
          ) : loadError ? (
            <SettingsRow
              label={`Couldn't read ${hostName}'s settings`}
              error={loadError}
              control={
                <Button variant="outline" size="sm" onClick={load}>
                  Retry
                </Button>
              }
            />
          ) : (
            <SettingsEmptyRow>Reading {hostName}'s settings…</SettingsEmptyRow>
          )}
        </SettingsGroup>
      </SettingsSection>
    );
  }

  const canopy = valueOf("canopyMode");
  // A host from before Canopy read locally has no model to name: it is updated before it is turned on.
  const canopyLocal = snapshot.settings.some((leaf) => leaf.key === "canopyModel");
  const canopyHidden = canopy === "hidden";
  const canopyOn = canopy === "on";
  const defaultAgent = valueOf("agentDefaults.defaultAgent");
  const resume = valueOf("agentSettings.resumeOnRestart");
  const idleOn = valueOf("idleTerminalNotify.enabled") === true;
  const monitoringOn = valueOf("terminalConfig.resourceMonitoringEnabled") === true;
  const leakOn = valueOf("terminalConfig.memoryLeakDetectionEnabled") === true;
  const sleepOn = valueOf("idleBackgroundAutoClose.enabled") === true;
  const sleepShells = valueOf("idleBackgroundAutoClose.includeIdleShells") === true;
  const shellThreshold = valueOf("idleBackgroundAutoClose.idleShellThresholdMinutes");

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Agents"
        description={`How agents start on ${hostName}. Nothing here changes any other machine`}
      >
        <SettingsGroup>
          <SettingsSelect
            label="Default agent"
            description={`The agent new terminals on ${hostName} start with`}
            value={typeof defaultAgent === "string" ? defaultAgent : NO_DEFAULT}
            onValueChange={(next) =>
              void change("agentDefaults.defaultAgent", next === NO_DEFAULT ? null : next)
            }
            options={AGENT_OPTIONS}
            disabled={busy}
            error={errorFor("agentDefaults.defaultAgent")}
          />
          <SettingsPresetGroup<ResumeOnRestart>
            label="Resume agents after restart"
            description={`What agent panes on ${hostName} do when Daintree there restarts`}
            options={RESUME_OPTIONS}
            value={typeof resume === "string" ? (resume as ResumeOnRestart) : null}
            onChange={(next) => void change("agentSettings.resumeOnRestart", next)}
            disabled={lockedFor("agentSettings.resumeOnRestart")}
            disabledReason={reasonFor("agentSettings.resumeOnRestart")}
          />
          {errorFor("agentSettings.resumeOnRestart") && (
            <SettingsRow
              label="Couldn't change how agents resume"
              error={errorFor("agentSettings.resumeOnRestart")}
            />
          )}
          {switchRow(
            "agentSettings.globalUseAltScreen",
            "Use alt-screen mode",
            "Render supported agents on the full-screen alternate buffer instead of inline",
            valueOf("agentSettings.globalUseAltScreen") === true
          )}
        </SettingsGroup>
      </SettingsSection>

      <HostEnvironmentSection
        key={revisionOf("globalEnvironmentVariables") ?? "none"}
        hostName={hostName}
        value={valueOf("globalEnvironmentVariables")}
        busy={busy}
        unavailableReason={reasonFor("globalEnvironmentVariables")}
        error={errorFor("globalEnvironmentVariables")}
        onSave={(record) => change("globalEnvironmentVariables", record)}
      />

      <SettingsSection title="Terminals" description={`How terminals on ${hostName} behave`}>
        <SettingsGroup>
          {switchRow(
            "sessionRestore.enabled",
            "Restore live projects",
            "Bring back every project that was running, not just the one each window was showing",
            valueOf("sessionRestore.enabled") === true
          )}
          {switchRow(
            "terminalConfig.resourceMonitoringEnabled",
            "Resource monitoring",
            "Show per-terminal CPU and memory in panel headers",
            monitoringOn
          )}
          <SettingsDependents
            disabled={!monitoringOn}
            reason="Turn on resource monitoring to detect memory leaks"
          >
            {switchRow(
              "terminalConfig.memoryLeakDetectionEnabled",
              "Memory leak detection",
              "Warn when a terminal's memory keeps growing, with options to restart it",
              leakOn
            )}
            <SettingsDependents
              disabled={!leakOn}
              reason={
                monitoringOn
                  ? "Turn on memory leak detection to restart terminals automatically"
                  : undefined
              }
            >
              <SettingsNumberInput
                label="Auto-restart threshold"
                description={`Restart a terminal once its memory passes this. ${LEAK_RESTART_THRESHOLD_MB.min.toLocaleString()}–${LEAK_RESTART_THRESHOLD_MB.max.toLocaleString()} MB`}
                suffix="MB"
                min={LEAK_RESTART_THRESHOLD_MB.min}
                max={LEAK_RESTART_THRESHOLD_MB.max}
                value={leakThreshold}
                onChange={(event) => setLeakThreshold(event.target.value)}
                onBlur={() =>
                  commitNumber(
                    "terminalConfig.memoryLeakAutoRestartThresholdMb",
                    leakThreshold,
                    LEAK_RESTART_THRESHOLD_MB,
                    "MB",
                    setLeakThreshold
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitNumber(
                      "terminalConfig.memoryLeakAutoRestartThresholdMb",
                      leakThreshold,
                      LEAK_RESTART_THRESHOLD_MB,
                      "MB",
                      setLeakThreshold
                    );
                  }
                }}
                disabled={lockedFor("terminalConfig.memoryLeakAutoRestartThresholdMb")}
                disabledReason={reasonFor("terminalConfig.memoryLeakAutoRestartThresholdMb")}
                error={errorFor("terminalConfig.memoryLeakAutoRestartThresholdMb")}
              />
            </SettingsDependents>
          </SettingsDependents>
          {switchRow(
            "idleTerminalNotify.enabled",
            "Alert about idle terminals",
            `${hostName} tells you about terminals left idle`,
            idleOn
          )}
          <SettingsDependents disabled={!idleOn} reason="Turn on idle alerts to set when they come">
            <SettingsNumberInput
              label="Alert after"
              description={`Minutes, ${IDLE_THRESHOLD_MINUTES.min} to ${IDLE_THRESHOLD_MINUTES.max}`}
              suffix="min"
              min={IDLE_THRESHOLD_MINUTES.min}
              max={IDLE_THRESHOLD_MINUTES.max}
              value={idleThreshold}
              onChange={(event) => setIdleThreshold(event.target.value)}
              onBlur={() =>
                commitNumber(
                  "idleTerminalNotify.thresholdMinutes",
                  idleThreshold,
                  IDLE_THRESHOLD_MINUTES,
                  "minutes",
                  setIdleThreshold
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitNumber(
                    "idleTerminalNotify.thresholdMinutes",
                    idleThreshold,
                    IDLE_THRESHOLD_MINUTES,
                    "minutes",
                    setIdleThreshold
                  );
                }
              }}
              disabled={busy}
              error={errorFor("idleTerminalNotify.thresholdMinutes")}
            />
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Idle projects"
        description={`Frees memory on ${hostName} from background projects nobody is using`}
      >
        <SettingsGroup>
          {switchRow(
            "idleBackgroundAutoClose.enabled",
            "Close idle projects automatically",
            "Background projects with no open terminals close, and reopen with their panels",
            sleepOn
          )}
          <SettingsDependents
            disabled={!sleepOn}
            reason="Turn on closing idle projects to choose when it happens"
          >
            <SettingsNumberInput
              label="Close after"
              description={`Minutes a background project with no open terminals sits idle, ${IDLE_THRESHOLD_MINUTES.min} to ${IDLE_THRESHOLD_MINUTES.max}`}
              suffix="min"
              min={IDLE_THRESHOLD_MINUTES.min}
              max={IDLE_THRESHOLD_MINUTES.max}
              value={sleepThreshold}
              onChange={(event) => setSleepThreshold(event.target.value)}
              onBlur={() =>
                commitNumber(
                  "idleBackgroundAutoClose.thresholdMinutes",
                  sleepThreshold,
                  IDLE_THRESHOLD_MINUTES,
                  "minutes",
                  setSleepThreshold
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitNumber(
                    "idleBackgroundAutoClose.thresholdMinutes",
                    sleepThreshold,
                    IDLE_THRESHOLD_MINUTES,
                    "minutes",
                    setSleepThreshold
                  );
                }
              }}
              disabled={lockedFor("idleBackgroundAutoClose.thresholdMinutes")}
              disabledReason={reasonFor("idleBackgroundAutoClose.thresholdMinutes")}
              error={errorFor("idleBackgroundAutoClose.thresholdMinutes")}
            />
            {switchRow(
              "idleBackgroundAutoClose.includeIdleShells",
              "Include projects with idle terminals",
              "Also sleeps projects whose shells and agents sit with nothing running",
              sleepShells
            )}
            <SettingsDependents
              disabled={!sleepShells}
              reason={
                sleepOn
                  ? "Include projects with idle terminals to choose when they sleep"
                  : undefined
              }
            >
              <SettingsPresetGroup<IdleShellThresholdMinutes>
                label="Sleep after"
                description="How long a project with terminals stays off screen with no terminal input or output"
                options={IDLE_SHELL_OPTIONS}
                value={
                  typeof shellThreshold === "number"
                    ? (shellThreshold as IdleShellThresholdMinutes)
                    : null
                }
                onChange={(next) =>
                  void change("idleBackgroundAutoClose.idleShellThresholdMinutes", next)
                }
                disabled={lockedFor("idleBackgroundAutoClose.idleShellThresholdMinutes")}
                disabledReason={reasonFor("idleBackgroundAutoClose.idleShellThresholdMinutes")}
              />
            </SettingsDependents>
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Canopy">
        <SettingsGroup>
          {switchRow(
            "canopyMode",
            "Show Canopy",
            `Its toolbar button, shortcut and command palette entry on ${hostName}. Hiding it also stops reading`,
            !canopyHidden,
            (show) => void change("canopyMode", show ? "unset" : "hidden")
          )}
          <SettingsDependents
            disabled={canopyHidden || (!canopyLocal && !canopyOn)}
            reason={
              canopyLocal
                ? "Show Canopy to turn it on"
                : `Update Daintree on ${hostName} to turn Canopy on there`
            }
          >
            <SettingsRow
              label="Read agent terminals"
              description="Downloads the model the first time. When off, Canopy lets the model go and deletes its readings there"
              disabled={busy}
              control={({ labelId, descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={canopyOn}
                  onCheckedChange={(on) => {
                    if (on) setConfirmCanopy(true);
                    else void change("canopyMode", "unset");
                  }}
                  disabled={disabled}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                />
              )}
            />
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
          void change("canopyMode", "on");
        }}
      />
    </div>
  );
}

/**
 * The host's global variables, edited as a whole and saved explicitly against
 * the set that was read: a change made there meanwhile is reported, never
 * written over. Keyed by the reading's revision, so each new reading (a save
 * landing, a conflict's current set) starts the form from what the host has.
 */
function HostEnvironmentSection({
  hostName,
  value,
  busy,
  unavailableReason,
  error,
  onSave,
}: {
  hostName: string;
  value: HostSettingValue | undefined;
  busy: boolean;
  unavailableReason: string | undefined;
  error: string | undefined;
  onSave: (record: Record<string, string>) => Promise<boolean>;
}) {
  const saved = isEnvRecord(value) ? value : null;
  const [rows, setRows] = useState<EnvVarDraft[]>(() => (saved ? envRows(saved) : []));
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [saveAttempted, setSaveAttempted] = useState(false);
  const dirty = saved !== null && !sameEnv(envRecord(rows), saved);

  const rowErrors = saveAttempted ? validateEnvRows(rows) : {};
  const errorCount = Object.keys(rowErrors).length;
  const locked = busy || unavailableReason !== undefined || saved === null;

  const save = async () => {
    setSaveAttempted(true);
    if (Object.keys(validateEnvRows(rows)).length > 0) return;
    // Applied or not, the host's answer comes back as a new reading, which remounts this.
    if (await onSave(envRecord(rows))) setSaveAttempted(false);
  };

  const discard = () => {
    if (!saved) return;
    setRows(envRows(saved));
    setRevealed(new Set());
    setSaveAttempted(false);
  };

  const addButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={locked}
      onClick={() => setRows((prev) => [...prev, { id: `env-${crypto.randomUUID()}`, key: "", value: "" }])}
    >
      <Plus aria-hidden="true" />
      Add variable
    </Button>
  );

  const status = error ? (
    <InlineError role="alert">{error}</InlineError>
  ) : errorCount > 0 ? (
    <InlineError>
      {errorCount === 1 ? "Fix the name above to save" : `Fix the ${errorCount} names above to save`}
    </InlineError>
  ) : unavailableReason ? (
    unavailableReason
  ) : dirty ? (
    `Unsaved changes to ${hostName}'s variables`
  ) : (
    `Applies to new terminals on ${hostName}`
  );

  return (
    <SettingsSection
      title="Environment"
      description={`Injected into every new terminal in every project on ${hostName}. A project variable with the same name overrides one of these.`}
      action={rows.length > 0 ? addButton : undefined}
    >
      <SettingsGroup>
        {rows.length === 0 ? (
          <SettingsEmptyRow action={addButton}>
            Add a variable to set it in every new terminal on {hostName}
          </SettingsEmptyRow>
        ) : (
          rows.map((row, index) => (
            <EnvVarRow
              key={row.id}
              row={row}
              position={index + 1}
              error={rowErrors[row.id]}
              sensitive={isSensitiveEnvKey(row.key)}
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
            />
          ))
        )}
        <SettingsActions status={status}>
          <Button variant="outline" size="sm" onClick={discard} disabled={!dirty || busy}>
            Discard
          </Button>
          <Button
            variant="contrast"
            size="sm"
            onClick={() => void save()}
            loading={busy && dirty}
            disabled={!dirty || locked}
          >
            Save
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsSection>
  );
}
