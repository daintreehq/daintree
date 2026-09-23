import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronRight, ShieldBan, KeyRound, Wrench, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { KeepAwakeSection } from "@/components/Settings/KeepAwakeSection";
import { WindowOpeningSection } from "@/components/Settings/WindowOpeningSection";
import { SettingsSubtabBar, subtabPanelProps } from "./SettingsSubtabBar";
import { SettingsDependents, SettingsGroup } from "./SettingsGroup";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import { getAgentIds } from "@/config/agents";
import { AgentIdentityBlock, resolveIdentity } from "@/components/agents/AgentCard";
import { Button } from "@/components/ui/button";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import type {
  HibernationConfig,
  SessionRestoreConfig,
  IdleTerminalNotifyConfig,
  IdleBackgroundAutoCloseConfig,
  CliAvailability,
} from "@shared/types";
import {
  isAgentInstalled,
  isAgentReady,
  isAgentBlocked,
  isAgentUnauthenticated,
} from "../../../shared/utils/agentAvailability";
import { usePreferencesStore } from "@/store";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getBuildChannelLabel } from "@shared/config/distribution";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useDistributionStore } from "@/store/distributionStore";

const GENERAL_SUBTABS: SettingsSubtabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "hibernation", label: "Hibernation" },
  { id: "display", label: "Display" },
];

interface GeneralTabProps {
  appVersion: string;
  /** Human-readable running architecture (e.g. "Apple Silicon", "Intel (Rosetta)"). */
  buildArch?: string;
  onNavigateToAgents?: (agentId?: string) => void;
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
}

const CURATED_SHORTCUTS = [
  {
    category: "Agents",
    actionIds: [
      "panel.palette",
      ...LAUNCHABLE_AGENT_IDS.map((id) => `agent.${id}`),
      "agent.terminal",
      "terminal.inject",
    ],
  },
  {
    category: "Terminal",
    actionIds: [
      "nav.quickSwitcher",
      "terminal.new",
      "terminal.focusNext",
      "terminal.focusPrevious",
      "terminal.focusAlternate",
    ],
  },
  {
    category: "Panels",
    actionIds: ["panel.diagnosticsLogs", "panel.diagnosticsEvents"],
  },
];

const THRESHOLD_PRESETS = [
  { value: 12, label: "12h" },
  { value: 24, label: "24h" },
  { value: 48, label: "48h" },
  { value: 72, label: "72h" },
] as const;

const IDLE_TERMINAL_THRESHOLD_PRESETS = [
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 240, label: "4h" },
] as const;

const IDLE_BACKGROUND_THRESHOLD_PRESETS = [
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
] as const;

// Mirrors the electron-store defaults, so a row can say when it has moved off them.
const DEFAULT_HIBERNATION_THRESHOLD_HOURS = 24;
const DEFAULT_IDLE_TERMINAL_THRESHOLD_MINUTES = 60;
const DEFAULT_IDLE_BACKGROUND_THRESHOLD_MINUTES = 15;
const DEFAULT_UPDATE_CHANNEL = "stable";
const DEFAULT_SESSION_RESTORE_ENABLED = true;

const UPDATE_CHECK_REFRESH_INTERVAL_MS = 60_000;

const UPDATE_CHANNEL_OPTIONS = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
] as const satisfies readonly { value: "stable" | "nightly"; label: string }[];

interface ShortcutDisplay {
  actionId: string;
  key: string;
  description: string;
}

interface ShortcutCategory {
  category: string;
  shortcuts: ShortcutDisplay[];
}

export function GeneralTab({
  appVersion,
  buildArch,
  onNavigateToAgents,
  activeSubtab,
  onSubtabChange,
}: GeneralTabProps) {
  const effectiveSubtab =
    activeSubtab && GENERAL_SUBTABS.some((t) => t.id === activeSubtab) ? activeSubtab : "overview";

  // Build provenance from the running version — stable builds get no channel
  // badge. Distinct from the user-selected update-feed `updateChannel`.
  const buildChannelLabel = getBuildChannelLabel(appVersion);

  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [hibernationConfig, setHibernationConfig] = useState<HibernationConfig | null>(null);
  const [sessionRestoreConfig, setSessionRestoreConfig] = useState<SessionRestoreConfig | null>(
    null
  );
  const [isSessionRestoreSaving, setIsSessionRestoreSaving] = useState(false);
  const [idleNotifyConfig, setIdleNotifyConfig] = useState<IdleTerminalNotifyConfig | null>(null);
  const [isIdleNotifySaving, setIsIdleNotifySaving] = useState(false);
  const [idleAutoCloseConfig, setIdleAutoCloseConfig] =
    useState<IdleBackgroundAutoCloseConfig | null>(null);
  const [isIdleAutoCloseSaving, setIsIdleAutoCloseSaving] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [cliAvailability, setCliAvailability] = useState<CliAvailability | null>(null);
  const [cliCheckFailed, setCliCheckFailed] = useState(false);
  const [isRecheckingAgents, setIsRecheckingAgents] = useState(false);
  const availabilityRequestRef = useRef(0);
  /**
   * Per-section load errors. These used to be swallowed into a `logError` and the section
   * simply did not render, on the reasoning that a missing card beats a wrong explanation.
   * But a missing card IS an explanation — the user reads it as "this app has no such
   * setting" — and it is the wrong one. Each section now keeps its own message so it can
   * say what failed and offer a way back, without borrowing hibernation's wording.
   */
  const [sectionErrors, setSectionErrors] = useState<Record<string, string | null>>({});
  const [configRetryNonce, setConfigRetryNonce] = useState(0);

  /**
   * What the section header says about the roster. The old copy — "Agents ready to use on
   * your system." — was a fixed claim that sat above blocked agents, a failed probe and
   * even an empty machine. This reports what the probe actually returned, which is also
   * where the positive "everything is fine" answer now lives: labelling every healthy row
   * "Ready" would be fourteen repetitions of the same word, so the count says it once.
   *
   * Not memoised on purpose: `getAgentIds()` reads the live registry, which changes when a
   * plugin agent is added or removed, and the roster below reads it on every render. A memo
   * keyed only on availability let the two disagree.
   */
  const systemStatusSummary = (() => {
    if (cliCheckFailed) return "Which agents are installed on this machine";
    if (!cliAvailability) return "Checking which agents are installed on this machine";
    const installed = getAgentIds().filter((id) => isAgentInstalled(cliAvailability[id]));
    if (installed.length === 0) return "Which agents are installed on this machine";
    const attention = installed.filter((id) => !isAgentReady(cliAvailability[id]));
    if (attention.length === 0) {
      return installed.length === 1
        ? "1 agent installed and ready to use"
        : `All ${installed.length} installed agents are ready to use`;
    }
    const ready = installed.length - attention.length;
    return `${ready} of ${installed.length} installed agents are ready — ${attention.length} need${attention.length === 1 ? "s" : ""} attention`;
  })();
  const [shortcuts, setShortcuts] = useState<ShortcutCategory[]>([]);
  const [updateChannel, setUpdateChannel] = useState<"stable" | "nightly" | null>(null);
  const [updateChannelLoadFailed, setUpdateChannelLoadFailed] = useState(false);
  const [channelRetryNonce, setChannelRetryNonce] = useState(0);
  const [channelSaving, setChannelSaving] = useState(false);
  const [lastUpdateCheck, setLastUpdateCheck] = useState<number | null>(null);
  const [storeUpdateNotificationsEnabled, setStoreUpdateNotificationsEnabled] = useState<
    boolean | null
  >(null);
  const [storeUpdateSettingsSaving, setStoreUpdateSettingsSaving] = useState(false);
  const updatesManagedByStore = useDistributionStore((s) => s.isWindowsStore);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const showProjectPulse = usePreferencesStore((s) => s.showProjectPulse);
  const showDeveloperTools = usePreferencesStore((s) => s.showDeveloperTools);
  const showGridAgentHighlights = usePreferencesStore((s) => s.showGridAgentHighlights);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
  const reduceAnimations = usePreferencesStore((s) => s.reduceAnimations);

  useEffect(() => {
    setUpdateChannelLoadFailed(false);
    if (updatesManagedByStore) return;
    let cancelled = false;
    window.electron.update
      .getChannel()
      .then((ch) => {
        if (!cancelled) setUpdateChannel(ch);
      })
      .catch((error) => {
        // Never fall back to a channel here: an unknown channel must stay unknown,
        // or a nightly user sees "stable" selected as though it were authoritative.
        if (cancelled) return;
        setUpdateChannelLoadFailed(true);
        logError("Failed to get update channel", error);
      });
    return () => {
      cancelled = true;
    };
  }, [updatesManagedByStore, channelRetryNonce]);

  useEffect(() => {
    if (updatesManagedByStore) return;
    let cancelled = false;

    const loadLastCheck = () => {
      if (!window.electron.update?.getLastCheck) {
        return;
      }
      window.electron.update
        .getLastCheck()
        .then((ts) => {
          if (!cancelled) setLastUpdateCheck(ts);
        })
        .catch((error) => {
          if (!cancelled) logError("Failed to get last update check", error);
        });
    };

    loadLastCheck();
    const interval = setInterval(loadLastCheck, UPDATE_CHECK_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [updatesManagedByStore]);

  useEffect(() => {
    if (!updatesManagedByStore) return;
    if (!window.electron?.storeUpdate?.getSettings) {
      // Renderer running against an older preload (e.g. tests) — default visible.
      setStoreUpdateNotificationsEnabled(true);
      return;
    }
    let cancelled = false;
    window.electron.storeUpdate
      .getSettings()
      .then((result) => {
        if (!cancelled) setStoreUpdateNotificationsEnabled(result.enabled);
      })
      .catch((error) => {
        if (!cancelled) {
          logError("Failed to get store update notification settings", error);
          setStoreUpdateNotificationsEnabled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [updatesManagedByStore]);

  const handleStoreUpdateNotificationsToggle = async () => {
    if (storeUpdateSettingsSaving || storeUpdateNotificationsEnabled === null) return;
    if (!window.electron?.storeUpdate?.setSettings) return;
    const prev = storeUpdateNotificationsEnabled;
    const next = !prev;
    setStoreUpdateNotificationsEnabled(next);
    setStoreUpdateSettingsSaving(true);
    try {
      const result = await window.electron.storeUpdate.setSettings(next);
      if (isMountedRef.current) setStoreUpdateNotificationsEnabled(result.enabled);
    } catch (error) {
      logError("Failed to set store update notification settings", error);
      if (isMountedRef.current) setStoreUpdateNotificationsEnabled(prev);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Update notification preference couldn't be saved.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleStoreUpdateNotificationsToggle(),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) setStoreUpdateSettingsSaving(false);
    }
  };

  const handleChannelChange = async (channel: "stable" | "nightly") => {
    if (updatesManagedByStore) return;
    if (channelSaving || channel === updateChannel) return;
    const prev = updateChannel;
    setUpdateChannel(channel);
    setChannelSaving(true);
    try {
      const result = await window.electron.update.setChannel(channel);
      if (isMountedRef.current) setUpdateChannel(result);
    } catch (error) {
      logError("Failed to set update channel", error);
      if (isMountedRef.current) setUpdateChannel(prev);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Update channel couldn't be changed.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleChannelChange(channel),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) setChannelSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        setConfigError("Settings load timed out");
      }
    }, 10_000);

    actionService
      .dispatch("hibernation.getConfig", undefined, { source: "user" })
      .then((result) => {
        clearTimeout(timer);
        if (cancelled) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setHibernationConfig(result.result as HibernationConfig);
        setConfigError(null);
      })
      .catch((error) => {
        clearTimeout(timer);
        if (cancelled) return;
        logError("Failed to load hibernation config", error);
        setConfigError(formatErrorMessage(error, "Failed to load hibernation settings"));
      });

    actionService
      .dispatch("sessionRestore.getConfig", undefined, { source: "user" })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setSessionRestoreConfig(result.result as SessionRestoreConfig);
        setSectionErrors((prev) => ({ ...prev, sessionRestore: null }));
      })
      .catch((error) => {
        if (cancelled) return;
        logError("Failed to load session restore config", error);
        setSectionErrors((prev) => ({
          ...prev,
          sessionRestore: formatErrorMessage(error, "Couldn't load startup settings"),
        }));
      });

    actionService
      .dispatch("idleTerminalNotify.getConfig", undefined, { source: "user" })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setIdleNotifyConfig(result.result as IdleTerminalNotifyConfig);
        setSectionErrors((prev) => ({ ...prev, idleNotify: null }));
      })
      .catch((error) => {
        if (cancelled) return;
        logError("Failed to load idle terminal notify config", error);
        setSectionErrors((prev) => ({
          ...prev,
          idleNotify: formatErrorMessage(error, "Couldn't load idle notification settings"),
        }));
      });

    actionService
      .dispatch("idleBackgroundAutoClose.getConfig", undefined, { source: "user" })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setIdleAutoCloseConfig(result.result as IdleBackgroundAutoCloseConfig);
        setSectionErrors((prev) => ({ ...prev, idleAutoClose: null }));
      })
      .catch((error) => {
        if (cancelled) return;
        logError("Failed to load idle background auto-close config", error);
        setSectionErrors((prev) => ({
          ...prev,
          idleAutoClose: formatErrorMessage(error, "Couldn't load auto-close settings"),
        }));
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [configRetryNonce]);

  /**
   * Read agent availability. Extracted from the mount effect so the failure state can
   * offer a Retry that runs the same path, rather than making the user close and reopen
   * Settings to get another attempt.
   *
   * Deliberately does NOT wait on `agentSettings`: the list shows every installed agent
   * regardless of pin state (#5117), so gating the render on a second request only
   * widened the window where nothing was on screen and added a way for the whole section
   * to report failure because an unrelated read failed.
   */
  const loadAgentAvailability = useCallback(async (): Promise<void> => {
    const STATUS_TIMEOUT_MS = 15_000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // StrictMode mounts the effect twice, and Retry can overlap an in-flight read. Only the
    // newest request may write state, or a slow first failure lands on top of a later
    // success.
    const generation = ++availabilityRequestRef.current;
    const isCurrent = () => isMountedRef.current && availabilityRequestRef.current === generation;

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Agent status check timed out")),
        STATUS_TIMEOUT_MS
      );
    });

    setIsRecheckingAgents(true);
    try {
      const availabilityResult = await Promise.race([
        actionService.dispatch("cliAvailability.get", undefined, { source: "user" }),
        timeout,
      ]);
      if (!isCurrent()) return;
      if (!availabilityResult.ok) {
        throw new Error(availabilityResult.error.message);
      }
      setCliAvailability(availabilityResult.result as CliAvailability);
      setCliCheckFailed(false);
    } catch (error) {
      if (!isCurrent()) return;
      logError("[GeneralTab] Failed to load agent availability", error);
      setCliCheckFailed(true);
    } finally {
      clearTimeout(timeoutId);
      if (isCurrent()) setIsRecheckingAgents(false);
    }
  }, []);

  useEffect(() => {
    void loadAgentAvailability();
  }, [loadAgentAvailability]);

  useEffect(() => {
    let isMounted = true;

    const loadShortcuts = () => {
      const categories: ShortcutCategory[] = CURATED_SHORTCUTS.map((category) => {
        const shortcuts: ShortcutDisplay[] = category.actionIds
          .map((actionId) => {
            const binding = keybindingService.getBinding(actionId);
            const effectiveCombo = keybindingService.getEffectiveCombo(actionId);

            if (!binding || !effectiveCombo) {
              return null;
            }

            return {
              actionId,
              key: keybindingService.formatComboForDisplay(effectiveCombo),
              description: binding.description || actionId,
            };
          })
          .filter((s): s is ShortcutDisplay => s !== null);

        return {
          category: category.category,
          shortcuts,
        };
      }).filter((c) => c.shortcuts.length > 0);

      if (isMounted) {
        setShortcuts(categories);
      }
    };

    const unsubscribe = keybindingService.subscribe(loadShortcuts);

    keybindingService.loadOverrides().then(() => {
      if (isMounted) {
        loadShortcuts();
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);
  const handleHibernationToggle = async () => {
    if (!hibernationConfig || isSaving) return;
    const prev = hibernationConfig;
    setHibernationConfig({ ...prev, enabled: !prev.enabled });
    setIsSaving(true);
    try {
      const result = await actionService.dispatch(
        "hibernation.updateConfig",
        { enabled: !prev.enabled },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setHibernationConfig(result.result as HibernationConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      setHibernationConfig(prev);
      logError("Failed to update hibernation config", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Auto-hibernation couldn't be updated.",
        actions: [
          { label: "Try again", variant: "primary", onClick: () => void handleHibernationToggle() },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  const handleSessionRestoreToggle = async () => {
    if (!sessionRestoreConfig || isSessionRestoreSaving) return;
    const prev = sessionRestoreConfig;
    setSessionRestoreConfig({ enabled: !prev.enabled });
    setIsSessionRestoreSaving(true);
    try {
      const result = await actionService.dispatch(
        "sessionRestore.updateConfig",
        { enabled: !prev.enabled },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setSessionRestoreConfig(result.result as SessionRestoreConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      setSessionRestoreConfig(prev);
      logError("Failed to update session restore config", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Project restore couldn't be updated.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleSessionRestoreToggle(),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) {
        setIsSessionRestoreSaving(false);
      }
    }
  };

  const handleIdleNotifyToggle = async () => {
    if (!idleNotifyConfig || isIdleNotifySaving) return;
    const prev = idleNotifyConfig;
    setIdleNotifyConfig({ ...prev, enabled: !prev.enabled });
    setIsIdleNotifySaving(true);
    try {
      const result = await actionService.dispatch(
        "idleTerminalNotify.updateConfig",
        { enabled: !prev.enabled },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setIdleNotifyConfig(result.result as IdleTerminalNotifyConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      setIdleNotifyConfig(prev);
      logError("Failed to update idle terminal notify config", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Idle terminal notifications couldn't be updated.",
        actions: [
          { label: "Try again", variant: "primary", onClick: () => void handleIdleNotifyToggle() },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) {
        setIsIdleNotifySaving(false);
      }
    }
  };

  const handleIdleNotifyThresholdChange = async (value: number) => {
    if (!idleNotifyConfig || isIdleNotifySaving) return;
    const prev = idleNotifyConfig;
    setIdleNotifyConfig({ ...prev, thresholdMinutes: value });
    setIsIdleNotifySaving(true);
    try {
      const result = await actionService.dispatch(
        "idleTerminalNotify.updateConfig",
        { thresholdMinutes: value },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setIdleNotifyConfig(result.result as IdleTerminalNotifyConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      setIdleNotifyConfig(prev);
      logError("Failed to update idle terminal notify threshold", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Idle threshold couldn't be updated.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleIdleNotifyThresholdChange(value),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) {
        setIsIdleNotifySaving(false);
      }
    }
  };

  const handleIdleAutoCloseToggle = async () => {
    if (!idleAutoCloseConfig || isIdleAutoCloseSaving) return;
    const prev = idleAutoCloseConfig;
    setIdleAutoCloseConfig({ ...prev, enabled: !prev.enabled });
    setIsIdleAutoCloseSaving(true);
    try {
      const result = await actionService.dispatch(
        "idleBackgroundAutoClose.updateConfig",
        { enabled: !prev.enabled },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setIdleAutoCloseConfig(result.result as IdleBackgroundAutoCloseConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      setIdleAutoCloseConfig(prev);
      logError("Failed to update idle background auto-close config", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Auto-close for idle projects couldn't be updated.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleIdleAutoCloseToggle(),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) {
        setIsIdleAutoCloseSaving(false);
      }
    }
  };

  const handleIdleAutoCloseThresholdChange = async (value: number) => {
    if (!idleAutoCloseConfig || isIdleAutoCloseSaving) return;
    const prev = idleAutoCloseConfig;
    setIdleAutoCloseConfig({ ...prev, thresholdMinutes: value });
    setIsIdleAutoCloseSaving(true);
    try {
      const result = await actionService.dispatch(
        "idleBackgroundAutoClose.updateConfig",
        { thresholdMinutes: value },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setIdleAutoCloseConfig(result.result as IdleBackgroundAutoCloseConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      setIdleAutoCloseConfig(prev);
      logError("Failed to update idle background auto-close threshold", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Idle auto-close threshold couldn't be updated.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleIdleAutoCloseThresholdChange(value),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) {
        setIsIdleAutoCloseSaving(false);
      }
    }
  };

  const handleThresholdChange = async (value: number) => {
    if (!hibernationConfig || isSaving) return;
    const prev = hibernationConfig;
    setHibernationConfig({ ...prev, inactiveThresholdHours: value });
    setIsSaving(true);
    try {
      const result = await actionService.dispatch(
        "hibernation.updateConfig",
        { inactiveThresholdHours: value },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setHibernationConfig(result.result as HibernationConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      setHibernationConfig(prev);
      logError("Failed to update hibernation threshold", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Inactivity threshold couldn't be updated.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleThresholdChange(value),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSubtabBar
        subtabs={GENERAL_SUBTABS}
        activeId={effectiveSubtab}
        onChange={onSubtabChange}
        group="general"
        ariaLabel="General settings sections"
      />

      <div {...subtabPanelProps("general", effectiveSubtab)} className="space-y-8">
        {effectiveSubtab === "overview" && (
          <>
            <SettingsSection
              title="System status"
              description={systemStatusSummary}
              id="general-system-status"
            >
              {cliCheckFailed ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-status-error">
                    Couldn't check which agents are installed
                  </p>
                  <button
                    type="button"
                    onClick={() => void loadAgentAvailability()}
                    disabled={isRecheckingAgents}
                    className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline disabled:opacity-60"
                  >
                    {isRecheckingAgents ? "Checking…" : "Retry"}
                  </button>
                </div>
              ) : !cliAvailability ? (
                <div className="text-sm text-text-secondary">
                  Checking which agents are installed…
                </div>
              ) : (
                (() => {
                  const allAgentIds = getAgentIds();
                  const installed = allAgentIds.filter((id) =>
                    isAgentInstalled(cliAvailability[id])
                  );
                  // Anything wanting the user's attention sorts to the top; registry order
                  // is preserved inside each group so the roster does not reshuffle between
                  // visits. The rows a user can act on are why they opened this section.
                  const installedAgentIds = [
                    ...installed.filter((id) => !isAgentReady(cliAvailability[id])),
                    ...installed.filter((id) => isAgentReady(cliAvailability[id])),
                  ];
                  const hiddenCount = allAgentIds.length - installedAgentIds.length;

                  if (installedAgentIds.length === 0) {
                    return (
                      <div className="space-y-3">
                        <p className="text-sm text-text-secondary">
                          No agent CLIs found on this machine. Install one and Daintree will pick it
                          up.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              window.dispatchEvent(
                                new CustomEvent("daintree:open-agent-setup-wizard")
                              )
                            }
                          >
                            Run setup wizard
                          </Button>
                          {onNavigateToAgents && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onNavigateToAgents?.()}
                            >
                              Browse available agents
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className="rounded-[var(--radius-md)] border border-border-default overflow-hidden">
                      {/* A list, not a stack of divs: eighteen agents is a collection, and a
                        screen-reader user gets the count and the position from the role. */}
                      <ul>
                        {installedAgentIds.map((id, index) => {
                          const identity = resolveIdentity(id);
                          const name = identity?.name ?? id;
                          const ready = isAgentReady(cliAvailability[id]);
                          const unauthenticated = isAgentUnauthenticated(cliAvailability[id]);
                          const blocked = isAgentBlocked(cliAvailability[id]);
                          // Wording states what the probe saw, never what it implies: an
                          // `unauthenticated` agent is still launchable (isAgentLaunchable)
                          // because the CLI resolves credentials at runtime. "Login required"
                          // would send a user to fix something that may not be broken.
                          // Ready is the expected state, so it still gets no per-row chrome —
                          // labelling fourteen rows "Ready" is noise, and the section's summary
                          // line above already states how many are good. Only states needing the
                          // user's attention are called out. Each carries its own glyph: a blocked
                          // agent is installed but can't run, and reads distinctly from the
                          // authentication-needed case so the user doesn't waste time
                          // re-authenticating a binary that an endpoint security tool is blocking.
                          // Attention states are tested before `ready` so a probe that ever reports
                          // both still surfaces the problem rather than falling silent.
                          const status = blocked
                            ? { label: "Blocked", Icon: ShieldBan }
                            : unauthenticated
                              ? { label: "No credentials detected", Icon: KeyRound }
                              : ready
                                ? null
                                : { label: "Needs setup", Icon: Wrench };

                          return (
                            <li key={id}>
                              <button
                                type="button"
                                data-agent-row={id}
                                className={cn(
                                  "settings-list-item group flex w-full items-center gap-3 px-3 py-2 text-left",
                                  "cursor-pointer transition-colors",
                                  "hover:bg-[var(--settings-nav-hover-bg,var(--theme-overlay-hover))]",
                                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
                                  index > 0 && "border-t border-border-default"
                                )}
                                aria-label={`${name} — ${status ? status.label : "ready"}. Open agent settings`}
                                onClick={() => onNavigateToAgents?.(id)}
                              >
                                {identity ? (
                                  <AgentIdentityBlock
                                    Icon={identity.Icon}
                                    color={identity.color}
                                    name={name}
                                    description={identity.description}
                                    compact
                                    showDescription={false}
                                  />
                                ) : (
                                  <span className="flex-1 text-sm text-text-primary">{name}</span>
                                )}
                                {status && (
                                  <span
                                    data-agent-status={status.label}
                                    className="flex shrink-0 items-center gap-1.5"
                                    aria-hidden="true"
                                  >
                                    {/* Severity rides the glyph, never the prose. Status-coloured
                                        text was measured and rejected: the status tokens fail
                                        4.5:1 as body text on most themes, and the notification
                                        surfaces already carry warnings this way. */}
                                    <status.Icon className="w-3.5 h-3.5 text-status-warning" />
                                    <span className="text-xs text-text-secondary">
                                      {status.label}
                                    </span>
                                  </span>
                                )}
                                {/* The row has always navigated; nothing on it said so. A
                                    hover-only chevron answers that only after the user has
                                    already guessed, so it rests visible and brightens on
                                    hover. Solid tokens rather than an opacity ramp: dimming
                                    an icon with opacity is lint-banned here, and at 60% this
                                    one measured about 1.7:1 under forced-colors — well under
                                    the 3:1 floor for the only cue that the row is a link. */}
                                <ChevronRight
                                  className="w-4 h-4 shrink-0 text-text-secondary transition-colors group-hover:text-text-primary group-focus-visible:text-text-primary"
                                  aria-hidden="true"
                                />
                              </button>
                            </li>
                          );
                        })}
                      </ul>

                      {/* The roster's last row rather than a loose link under it: it
                          navigates exactly like the agent rows above, so it takes their shape. */}
                      {hiddenCount > 0 && onNavigateToAgents && (
                        <button
                          type="button"
                          onClick={() => onNavigateToAgents?.()}
                          className={cn(
                            "settings-list-item group flex w-full items-center gap-3 px-3 py-2 text-left",
                            "cursor-pointer transition-colors border-t border-border-default",
                            "hover:bg-[var(--settings-nav-hover-bg,var(--theme-overlay-hover))]",
                            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
                          )}
                        >
                          <span className="flex-1 text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                            {`Daintree supports ${hiddenCount} more ${hiddenCount === 1 ? "agent" : "agents"}`}
                          </span>
                          <ChevronRight
                            className="w-4 h-4 shrink-0 text-text-secondary transition-colors group-hover:text-text-primary group-focus-visible:text-text-primary"
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </div>
                  );
                })()
              )}
            </SettingsSection>

            {/* Rendered before the config arrives so the page keeps its shape; the
                row stays disabled until the stored value is known, so a click can't
                save over a value the user never saw. */}
            <SettingsSection
              title="Startup"
              description="What comes back when Daintree restarts"
              id="general-session-restore"
            >
              {sectionErrors.sessionRestore && (
                <SettingsLoadErrorBanner
                  message={sectionErrors.sessionRestore}
                  onRetry={() => setConfigRetryNonce((n) => n + 1)}
                />
              )}
              <SettingsGroup>
                <SettingsSwitchCard
                  title="Restore live projects"
                  subtitle="Bring back every project that was running, not just the one each window was showing"
                  isEnabled={sessionRestoreConfig?.enabled ?? DEFAULT_SESSION_RESTORE_ENABLED}
                  onChange={() => void handleSessionRestoreToggle()}
                  disabled={!sessionRestoreConfig || isSessionRestoreSaving}
                  isModified={
                    !!sessionRestoreConfig &&
                    sessionRestoreConfig.enabled !== DEFAULT_SESSION_RESTORE_ENABLED
                  }
                  onReset={() => void handleSessionRestoreToggle()}
                />
              </SettingsGroup>
            </SettingsSection>

            <WindowOpeningSection />

            <KeepAwakeSection />

            {updatesManagedByStore ? (
              <SettingsSection
                title="Updates"
                description="Updates are managed by the Microsoft Store on Windows"
                id="general-update-channel"
              >
                <SettingsGroup>
                  <SettingsSwitchCard
                    title="Notify when a new version is available"
                    subtitle="Show an inbox notification with a link to the Microsoft Store"
                    isEnabled={storeUpdateNotificationsEnabled ?? true}
                    onChange={() => void handleStoreUpdateNotificationsToggle()}
                    disabled={storeUpdateNotificationsEnabled === null}
                  />
                </SettingsGroup>
              </SettingsSection>
            ) : (
              <SettingsSection title="Updates" id="general-update-channel">
                {updateChannelLoadFailed ? (
                  <SettingsLoadErrorBanner
                    message="Couldn't load the update channel"
                    onRetry={() => setChannelRetryNonce((n) => n + 1)}
                  />
                ) : (
                  <SettingsGroup>
                    <SettingsPresetGroup<"stable" | "nightly">
                      label="Update channel"
                      description={
                        updateChannel === "nightly"
                          ? "Nightly builds may contain unstable features. You can switch back to stable at any time."
                          : "Stable releases, or nightly builds with the newest changes"
                      }
                      options={UPDATE_CHANNEL_OPTIONS}
                      value={updateChannel}
                      onChange={(ch) => void handleChannelChange(ch)}
                      disabled={updateChannel === null || channelSaving}
                      isModified={
                        updateChannel !== null && updateChannel !== DEFAULT_UPDATE_CHANNEL
                      }
                      onReset={() => void handleChannelChange(DEFAULT_UPDATE_CHANNEL)}
                    />
                  </SettingsGroup>
                )}
                {lastUpdateCheck && (
                  <p className="text-xs text-text-secondary">
                    Last checked: {formatTimeAgo(lastUpdateCheck)}
                  </p>
                )}
              </SettingsSection>
            )}

            <SettingsSection
              title="Quick reference"
              description="Common keyboard shortcuts — edit them all in Keyboard settings"
            >
              <button
                type="button"
                onClick={() => setIsShortcutsOpen(!isShortcutsOpen)}
                aria-expanded={isShortcutsOpen}
                aria-controls="keyboard-shortcuts-content"
                className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                <ChevronRight
                  data-animated-chevron
                  className={cn(
                    "w-3.5 h-3.5 transition-transform duration-150",
                    isShortcutsOpen && "rotate-90"
                  )}
                />
                <span>{isShortcutsOpen ? "Hide shortcuts" : "Show shortcuts"}</span>
              </button>

              {isShortcutsOpen && (
                <div id="keyboard-shortcuts-content" className="space-y-4">
                  {shortcuts.map((category) => (
                    <div key={category.category} className="space-y-2">
                      <h5 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                        {category.category}
                      </h5>
                      <dl className="space-y-1">
                        {category.shortcuts.map((shortcut) => (
                          <div
                            key={shortcut.actionId}
                            className="flex items-center justify-between text-sm py-1"
                          >
                            <dt className="text-text-primary">{shortcut.description}</dt>
                            <dd>
                              <kbd className="settings-kbd px-2 py-1 rounded-[var(--radius-sm)] border text-xs font-mono text-text-primary">
                                {shortcut.key}
                              </kbd>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </SettingsSection>

            {/* Identity sits at the FOOT of Overview, not the head of it. A user opens
              General to change something; the version and the website are what they came
              for least often, and as a banner they cost the whole first viewport. Kept in
              Settings rather than moved to a macOS About panel because Daintree ships on
              three platforms and only one of them has that panel. */}
            <div
              id="general-about"
              className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2 border-t border-border-default text-xs"
            >
              <DaintreeIcon size={16} className="shrink-0 text-text-secondary" />
              <span className="font-medium text-text-primary">Daintree</span>
              <span data-testid="about-version" className="text-text-secondary font-mono">
                v{appVersion}
              </span>
              {buildArch && (
                <span data-testid="about-build-arch" className="text-text-secondary font-mono">
                  {buildArch}
                </span>
              )}
              {buildChannelLabel && (
                <span
                  data-testid="about-build-channel"
                  className="text-3xs font-medium px-1.5 py-0.5 rounded-full bg-status-info/15 text-status-info leading-none"
                >
                  {buildChannelLabel}
                </span>
              )}
              <button
                onClick={() =>
                  void actionService.dispatch(
                    "system.openExternal",
                    { url: "https://daintree.org" },
                    { source: "user" }
                  )
                }
                className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors ml-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 rounded-[var(--radius-sm)]"
              >
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
                daintree.org
              </button>
            </div>
          </>
        )}

        {effectiveSubtab === "hibernation" && (
          <>
            {/* Every group renders before its config arrives. Until the stored value is
                known each switch shows the default, disabled, and each threshold shows no
                selection — a load error sits on the group it belongs to, with Retry. */}
            <SettingsSection title="Idle terminal notifications" id="general-idle-terminal-notify">
              {sectionErrors.idleNotify && (
                <SettingsLoadErrorBanner
                  message={sectionErrors.idleNotify}
                  onRetry={() => setConfigRetryNonce((n) => n + 1)}
                />
              )}
              <SettingsGroup>
                <SettingsSwitchCard
                  title="Notify me about idle terminals"
                  subtitle="A reminder when terminals in background projects go quiet — nothing is closed, and the active project is never flagged"
                  isEnabled={idleNotifyConfig?.enabled ?? true}
                  onChange={handleIdleNotifyToggle}
                  disabled={!idleNotifyConfig}
                  isModified={!!idleNotifyConfig && !idleNotifyConfig.enabled}
                  onReset={() => void handleIdleNotifyToggle()}
                />
                <SettingsDependents
                  disabled={!idleNotifyConfig?.enabled}
                  reason={
                    idleNotifyConfig
                      ? "Turn on idle terminal reminders to choose when they appear"
                      : undefined
                  }
                >
                  <SettingsPresetGroup<number>
                    id="general-idle-terminal-threshold"
                    label="Idle threshold"
                    description="How long background terminals stay quiet before the reminder, which offers to close them"
                    options={IDLE_TERMINAL_THRESHOLD_PRESETS}
                    value={idleNotifyConfig?.thresholdMinutes ?? null}
                    onChange={(v) => void handleIdleNotifyThresholdChange(v)}
                    disabled={isIdleNotifySaving}
                    isModified={
                      !!idleNotifyConfig &&
                      idleNotifyConfig.thresholdMinutes !== DEFAULT_IDLE_TERMINAL_THRESHOLD_MINUTES
                    }
                    onReset={() =>
                      void handleIdleNotifyThresholdChange(DEFAULT_IDLE_TERMINAL_THRESHOLD_MINUTES)
                    }
                  />
                </SettingsDependents>
              </SettingsGroup>
            </SettingsSection>
            {/* One section for the two ways Daintree frees a background project: closing
                it outright, or keeping it open with its processes stopped. They were two
                sections whose only row repeated the heading above it. */}
            <SettingsSection
              title="Background projects"
              description="Free memory and processes from projects you haven't used in a while"
            >
              {sectionErrors.idleAutoClose && (
                <SettingsLoadErrorBanner
                  message={sectionErrors.idleAutoClose}
                  onRetry={() => setConfigRetryNonce((n) => n + 1)}
                />
              )}
              <SettingsGroup id="general-idle-background-auto-close">
                <SettingsSwitchCard
                  title="Close idle projects automatically"
                  subtitle="Frees memory from background projects with no open terminals. They stay in the switcher and reopen with their panels."
                  isEnabled={idleAutoCloseConfig?.enabled ?? false}
                  onChange={handleIdleAutoCloseToggle}
                  disabled={!idleAutoCloseConfig}
                  isModified={!!idleAutoCloseConfig?.enabled}
                  onReset={() => void handleIdleAutoCloseToggle()}
                />
                <SettingsDependents
                  disabled={!idleAutoCloseConfig?.enabled}
                  reason={
                    idleAutoCloseConfig
                      ? "Turn on closing idle projects to choose when it happens"
                      : undefined
                  }
                >
                  <SettingsPresetGroup<number>
                    id="general-idle-background-threshold"
                    label="Idle threshold"
                    description="How long a background project sits idle before it closes — the active project is never touched"
                    options={IDLE_BACKGROUND_THRESHOLD_PRESETS}
                    value={idleAutoCloseConfig?.thresholdMinutes ?? null}
                    onChange={(v) => void handleIdleAutoCloseThresholdChange(v)}
                    disabled={isIdleAutoCloseSaving}
                    isModified={
                      !!idleAutoCloseConfig &&
                      idleAutoCloseConfig.thresholdMinutes !==
                        DEFAULT_IDLE_BACKGROUND_THRESHOLD_MINUTES
                    }
                    onReset={() =>
                      void handleIdleAutoCloseThresholdChange(
                        DEFAULT_IDLE_BACKGROUND_THRESHOLD_MINUTES
                      )
                    }
                  />
                </SettingsDependents>
              </SettingsGroup>
              {configError && (
                <SettingsLoadErrorBanner
                  title="Couldn't load hibernation settings"
                  message={configError}
                  onRetry={() => setConfigRetryNonce((n) => n + 1)}
                />
              )}
              <SettingsGroup id="general-hibernation">
                <SettingsSwitchCard
                  title="Hibernate inactive projects"
                  subtitle="Stops their terminals and dev servers to free resources; the project reopens where you left it"
                  isEnabled={hibernationConfig?.enabled ?? false}
                  onChange={handleHibernationToggle}
                  disabled={!hibernationConfig}
                  isModified={!!hibernationConfig?.enabled}
                  onReset={() => void handleHibernationToggle()}
                />
                <SettingsDependents
                  disabled={!hibernationConfig?.enabled}
                  reason={
                    hibernationConfig ? "Turn on hibernation to choose when it happens" : undefined
                  }
                >
                  <SettingsPresetGroup<number>
                    id="general-hibernation-threshold"
                    label="Inactivity threshold"
                    description="Projects idle longer than this have their processes stopped"
                    options={THRESHOLD_PRESETS}
                    value={hibernationConfig?.inactiveThresholdHours ?? null}
                    onChange={(v) => void handleThresholdChange(v)}
                    disabled={isSaving}
                    isModified={
                      !!hibernationConfig &&
                      hibernationConfig.inactiveThresholdHours !==
                        DEFAULT_HIBERNATION_THRESHOLD_HOURS
                    }
                    onReset={() => void handleThresholdChange(DEFAULT_HIBERNATION_THRESHOLD_HOURS)}
                  />
                </SettingsDependents>
              </SettingsGroup>
            </SettingsSection>
          </>
        )}

        {effectiveSubtab === "display" && (
          <SettingsSection
            title="Interface elements"
            description="What Daintree shows while you work"
            id="general-project-pulse"
          >
            <SettingsGroup>
              <SettingsSwitchCard
                title="Project pulse"
                subtitle="Show activity heatmap on the empty panel grid"
                isEnabled={showProjectPulse}
                onChange={() =>
                  void actionService.dispatch(
                    "preferences.showProjectPulse.set",
                    { show: !showProjectPulse },
                    { source: "user" }
                  )
                }
                ariaLabel="Project Pulse Toggle"
                isModified={!showProjectPulse}
                onReset={() =>
                  void actionService.dispatch(
                    "preferences.showProjectPulse.set",
                    { show: true },
                    { source: "user" }
                  )
                }
              />

              <SettingsSwitchCard
                id="general-developer-tools"
                title="Developer tools"
                subtitle="Show problems panel button in the toolbar"
                isEnabled={showDeveloperTools}
                onChange={() =>
                  void actionService.dispatch(
                    "preferences.showDeveloperTools.set",
                    { show: !showDeveloperTools },
                    { source: "user" }
                  )
                }
                isModified={showDeveloperTools}
                onReset={() =>
                  void actionService.dispatch(
                    "preferences.showDeveloperTools.set",
                    { show: false },
                    { source: "user" }
                  )
                }
              />

              <SettingsSwitchCard
                id="general-grid-agent-highlights"
                title="Grid panel agent highlights"
                subtitle="Show waiting and working state borders on grid panels. Failed state borders are always visible."
                isEnabled={showGridAgentHighlights}
                onChange={() =>
                  void actionService.dispatch(
                    "preferences.showGridAgentHighlights.set",
                    { show: !showGridAgentHighlights },
                    { source: "user" }
                  )
                }
                isModified={showGridAgentHighlights}
                onReset={() =>
                  void actionService.dispatch(
                    "preferences.showGridAgentHighlights.set",
                    { show: false },
                    { source: "user" }
                  )
                }
              />

              <SettingsSwitchCard
                id="general-dock-agent-highlights"
                title="Dock item agent highlights"
                subtitle="Show waiting state borders on dock items. Failed state borders are always visible."
                isEnabled={showDockAgentHighlights}
                onChange={() =>
                  void actionService.dispatch(
                    "preferences.showDockAgentHighlights.set",
                    { show: !showDockAgentHighlights },
                    { source: "user" }
                  )
                }
                isModified={showDockAgentHighlights}
                onReset={() =>
                  void actionService.dispatch(
                    "preferences.showDockAgentHighlights.set",
                    { show: false },
                    { source: "user" }
                  )
                }
              />

              <SettingsSwitchCard
                id="general-agent-task-titles"
                title="Agent task in terminal titles"
                subtitle="Show the agent's current task next to its name in tabs and panel headers"
                isEnabled={showAgentTaskTitles}
                onChange={() =>
                  void actionService.dispatch(
                    "preferences.showAgentTaskTitles.set",
                    { show: !showAgentTaskTitles },
                    { source: "user" }
                  )
                }
                isModified={!showAgentTaskTitles}
                onReset={() =>
                  void actionService.dispatch(
                    "preferences.showAgentTaskTitles.set",
                    { show: true },
                    { source: "user" }
                  )
                }
              />

              <SettingsSwitchCard
                id="general-reduce-animations"
                title="Reduce UI animations"
                subtitle="Minimize motion across the interface, independent of your OS reduce-motion setting"
                isEnabled={reduceAnimations}
                onChange={() =>
                  void actionService.dispatch(
                    "preferences.reduceAnimations.set",
                    { value: !reduceAnimations },
                    { source: "user" }
                  )
                }
                isModified={reduceAnimations}
                onReset={() =>
                  void actionService.dispatch(
                    "preferences.reduceAnimations.set",
                    { value: false },
                    { source: "user" }
                  )
                }
              />
            </SettingsGroup>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}
