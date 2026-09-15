import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  ChevronRight,
  History,
  Moon,
  ShieldBan,
  KeyRound,
  Wrench,
  LayoutGrid,
  PanelBottom,
  Keyboard,
  Info,
  ExternalLink,
  RefreshCw,
  Gauge,
  Type,
  Bell,
  MemoryStick,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DaintreeIcon, Activity } from "@/components/icons";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SettingsSubtabBar, subtabPanelProps } from "./SettingsSubtabBar";
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
   */
  const systemStatusSummary = useMemo(() => {
    if (cliCheckFailed) return "Which agents are installed on this machine.";
    if (!cliAvailability) return "Checking which agents are installed on this machine.";
    const installed = getAgentIds().filter((id) => isAgentInstalled(cliAvailability[id]));
    if (installed.length === 0) return "Which agents are installed on this machine.";
    const attention = installed.filter((id) => !isAgentReady(cliAvailability[id]));
    if (attention.length === 0) {
      return installed.length === 1
        ? "1 agent installed and ready to use."
        : `All ${installed.length} installed agents are ready to use.`;
    }
    const ready = installed.length - attention.length;
    return `${ready} of ${installed.length} installed agents are ready — ${attention.length} need${attention.length === 1 ? "s" : ""} attention.`;
  }, [cliAvailability, cliCheckFailed]);
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
      if (!isMountedRef.current) return;
      if (!availabilityResult.ok) {
        throw new Error(availabilityResult.error.message);
      }
      setCliAvailability(availabilityResult.result as CliAvailability);
      setCliCheckFailed(false);
    } catch (error) {
      if (!isMountedRef.current) return;
      logError("[GeneralTab] Failed to load agent availability", error);
      setCliCheckFailed(true);
    } finally {
      clearTimeout(timeoutId);
      if (isMountedRef.current) setIsRecheckingAgents(false);
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

      <div {...subtabPanelProps("general", effectiveSubtab)} className="space-y-6">
        {effectiveSubtab === "overview" && (
          <>
            <SettingsSection
              icon={Info}
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
                    <div className="space-y-3">
                      {/* A list, not a stack of divs: eighteen agents is a collection, and a
                        screen-reader user gets the count and the position from the role. */}
                      <ul className="rounded-[var(--radius-md)] border border-border-default overflow-hidden">
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
                                    className="flex shrink-0 items-center gap-1.5 text-status-warning"
                                    aria-hidden="true"
                                  >
                                    <status.Icon className="w-3.5 h-3.5" />
                                    <span className="text-xs">{status.label}</span>
                                  </span>
                                )}
                                {/* The row has always navigated; nothing on it said so. A
                                    hover-only chevron answers that only after the user has
                                    already guessed, so it rests visible and lifts on hover. */}
                                <ChevronRight
                                  className="w-4 h-4 shrink-0 text-text-secondary opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                  aria-hidden="true"
                                />
                              </button>
                            </li>
                          );
                        })}
                      </ul>

                      {hiddenCount > 0 && onNavigateToAgents && (
                        <button
                          type="button"
                          onClick={() => onNavigateToAgents?.()}
                          className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
                        >
                          {`Daintree supports ${hiddenCount} more ${hiddenCount === 1 ? "agent" : "agents"} →`}
                        </button>
                      )}
                    </div>
                  );
                })()
              )}
            </SettingsSection>

            {(sessionRestoreConfig || sectionErrors.sessionRestore) && (
              <SettingsSection
                icon={History}
                title="Startup"
                description="What comes back when Daintree restarts."
                id="general-session-restore"
              >
                {sectionErrors.sessionRestore ? (
                  <SettingsLoadErrorBanner
                    message={sectionErrors.sessionRestore}
                    onRetry={() => setConfigRetryNonce((n) => n + 1)}
                  />
                ) : sessionRestoreConfig ? (
                  <SettingsSwitchCard
                    icon={History}
                    title="Restore live projects"
                    subtitle="Bring back every project that was running, not just the one each window was showing"
                    isEnabled={sessionRestoreConfig.enabled}
                    onChange={() => void handleSessionRestoreToggle()}
                    ariaLabel="Restore Live Projects Toggle"
                    disabled={isSessionRestoreSaving}
                  />
                ) : null}
              </SettingsSection>
            )}

            {updatesManagedByStore ? (
              <SettingsSection
                icon={RefreshCw}
                title="Updates"
                description="Updates are managed by the Microsoft Store on Windows."
                id="general-update-channel"
              >
                <SettingsSwitchCard
                  icon={RefreshCw}
                  title="Notify when a new version is available"
                  subtitle="Show an inbox notification with a link to the Microsoft Store"
                  isEnabled={storeUpdateNotificationsEnabled ?? true}
                  onChange={() => void handleStoreUpdateNotificationsToggle()}
                  ariaLabel="Toggle Microsoft Store update notifications"
                  disabled={storeUpdateNotificationsEnabled === null}
                />
              </SettingsSection>
            ) : (
              <SettingsSection
                icon={RefreshCw}
                title="Update channel"
                description="Choose between stable releases and nightly builds."
                id="general-update-channel"
              >
                {updateChannelLoadFailed ? (
                  <SettingsLoadErrorBanner
                    message="Couldn't load the update channel"
                    onRetry={() => setChannelRetryNonce((n) => n + 1)}
                  />
                ) : (
                  <>
                    <SettingsPresetGroup
                      label="Channel"
                      options={UPDATE_CHANNEL_OPTIONS}
                      value={updateChannel}
                      onChange={(ch) => void handleChannelChange(ch)}
                      disabled={updateChannel === null}
                    />
                    {updateChannel === "nightly" && (
                      <p className="text-xs text-status-warning">
                        Nightly builds may contain unstable features. You can switch back to stable
                        at any time.
                      </p>
                    )}
                  </>
                )}
                {lastUpdateCheck && (
                  <p className="text-xs text-text-secondary">
                    Last checked: {formatTimeAgo(lastUpdateCheck)}
                  </p>
                )}
              </SettingsSection>
            )}

            <SettingsSection
              icon={Keyboard}
              title="Quick reference"
              description="Common keyboard shortcuts. Edit all shortcuts in the Keyboard settings tab."
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
                              <kbd className="settings-kbd px-2 py-1 rounded border text-xs font-mono text-text-primary">
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
            {idleNotifyConfig && (
              <SettingsSection
                icon={Bell}
                title="Idle terminal notifications"
                description="Get a friendly reminder when terminals in background projects have been idle for a while. Doesn't kill anything — just lets you decide."
                id="general-idle-terminal-notify"
              >
                <SettingsSwitchCard
                  icon={Bell}
                  title="Notify me about idle terminals"
                  subtitle="Applies to background projects only — the active one is never flagged"
                  isEnabled={idleNotifyConfig.enabled}
                  onChange={handleIdleNotifyToggle}
                  ariaLabel="Idle Terminal Notifications Toggle"
                />

                {idleNotifyConfig.enabled && (
                  <SettingsPresetGroup
                    id="general-idle-terminal-threshold"
                    label="Idle threshold"
                    options={IDLE_TERMINAL_THRESHOLD_PRESETS}
                    value={idleNotifyConfig.thresholdMinutes}
                    onChange={(v) => handleIdleNotifyThresholdChange(v)}
                    description={
                      "A toast appears when background project terminals have been quiet this long, with options to close them or dismiss the reminder."
                    }
                  />
                )}
              </SettingsSection>
            )}
            {idleAutoCloseConfig && (
              <SettingsSection
                icon={MemoryStick}
                title="Auto-close idle projects"
                description="Reclaim memory from background projects that have no terminals and have been idle for a while. They stay in the switcher and reopen right where you left off."
                id="general-idle-background-auto-close"
              >
                <SettingsSwitchCard
                  icon={MemoryStick}
                  title="Close idle projects automatically"
                  subtitle="Only projects with no open terminals — panels are restored when you reopen them"
                  isEnabled={idleAutoCloseConfig.enabled}
                  onChange={handleIdleAutoCloseToggle}
                  ariaLabel="Auto-Close Idle Projects Toggle"
                />

                {idleAutoCloseConfig.enabled && (
                  <SettingsPresetGroup
                    id="general-idle-background-threshold"
                    label="Idle threshold"
                    options={IDLE_BACKGROUND_THRESHOLD_PRESETS}
                    value={idleAutoCloseConfig.thresholdMinutes}
                    onChange={(v) => handleIdleAutoCloseThresholdChange(v)}
                    description={
                      "Only projects with no terminals are auto-closed. The active project is never touched, and reopening a project restores its panels."
                    }
                  />
                )}
              </SettingsSection>
            )}
            {configError ? (
              <div className="p-4 rounded-[var(--radius-lg)] border border-[color-mix(in_oklab,var(--color-status-error)_50%,transparent)] bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)]">
                <p className="text-sm text-status-error">
                  Failed to load hibernation settings: {configError}
                </p>
              </div>
            ) : hibernationConfig ? (
              <SettingsSection
                icon={Moon}
                title="Auto-hibernation"
                description="Automatically stop terminals and servers for projects that have been inactive for a period of time. Reduces system resource usage."
                id="general-hibernation"
              >
                <SettingsSwitchCard
                  icon={Moon}
                  title="Hibernate inactive projects"
                  subtitle="Stops their terminals and dev servers; the project reopens where you left it"
                  isEnabled={hibernationConfig.enabled}
                  onChange={handleHibernationToggle}
                  ariaLabel="Auto-Hibernation Toggle"
                />

                {hibernationConfig.enabled && (
                  <SettingsPresetGroup
                    id="general-hibernation-threshold"
                    label="Inactivity threshold"
                    options={THRESHOLD_PRESETS}
                    value={hibernationConfig.inactiveThresholdHours}
                    onChange={(v) => handleThresholdChange(v)}
                    description={
                      "Projects idle longer than this will have their processes stopped automatically."
                    }
                  />
                )}
              </SettingsSection>
            ) : (
              <div className="text-sm text-text-secondary">Loading hibernation settings…</div>
            )}
          </>
        )}

        {effectiveSubtab === "display" && (
          <SettingsSection
            icon={Activity}
            title="Interface elements"
            description="Choose what Daintree shows while you work."
            id="general-project-pulse"
          >
            <SettingsSwitchCard
              icon={Activity}
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
              icon={Wrench}
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
              ariaLabel="Developer Tools Toggle"
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
              icon={LayoutGrid}
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
              ariaLabel="Grid Panel Agent Highlights Toggle"
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
              icon={PanelBottom}
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
              ariaLabel="Dock Item Agent Highlights Toggle"
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
              icon={Type}
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
              ariaLabel="Agent Task Titles Toggle"
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
              icon={Gauge}
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
              ariaLabel="Reduce UI Animations Toggle"
              isModified={reduceAnimations}
              onReset={() =>
                void actionService.dispatch(
                  "preferences.reduceAnimations.set",
                  { value: false },
                  { source: "user" }
                )
              }
            />
          </SettingsSection>
        )}
      </div>
    </div>
  );
}
