import { useEffect, useRef, useState } from "react";
import { SECTION_SETTINGS } from "@/components/Settings/settingsSectionOwners";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { pluginClient } from "@/clients/pluginClient";
import { useProjectStore } from "@/store/projectStore";
import { UNKNOWN_PROJECT_LABEL } from "@/lib/notificationSourceLabel";
import type { PluginNotificationSilence } from "@shared/types/ipc/maps";

/**
 * The way back from "Silence <Plugin>" in a notification's menu (#13818):
 * every plugin whose toasts and notifications main holds back, each with an
 * Unsilence. One change at a time, so each answer from main is the whole list.
 */
export function SilencedPluginsSection() {
  const [silences, setSilences] = useState<PluginNotificationSilence[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedUnsilence, setFailedUnsilence] = useState<PluginNotificationSilence | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  // Only the latest request may settle the list, so a slow read can't put back
  // a plugin an Unsilence that started after it already took out.
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const seq = ++requestSeq.current;
    Promise.resolve()
      .then(() => pluginClient.getNotificationSilences())
      .then((next) => {
        if (cancelled || seq !== requestSeq.current) return;
        setSilences(next);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled && seq === requestSeq.current) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadNonce]);

  const unsilence = (silence: PluginNotificationSilence) => {
    if (pending !== null) return;
    const seq = ++requestSeq.current;
    setPending(silence.pluginId);
    pluginClient
      .setNotificationSilenced(silence.pluginId, false)
      .then((next) => {
        if (seq !== requestSeq.current) return;
        setSilences(next);
        setFailedUnsilence(null);
      })
      .catch(() => {
        if (seq === requestSeq.current) setFailedUnsilence(silence);
      })
      .finally(() => {
        if (seq === requestSeq.current) setPending(null);
      });
  };

  return (
    <SettingsSection
      title="Silenced plugins"
      settings={SECTION_SETTINGS.pluginSilences}
      description="A silenced plugin's toasts and notifications are held back before they reach any window"
    >
      {loadFailed && (
        <SettingsLoadErrorBanner
          title="Couldn't load silenced plugins"
          message="The list of plugins you silenced couldn't be read."
          onRetry={() => setLoadNonce((n) => n + 1)}
        />
      )}
      {failedUnsilence && (
        <SettingsLoadErrorBanner
          title={`Couldn't unsilence ${failedUnsilence.name}`}
          message="Its notifications are still held back."
          onRetry={() => unsilence(failedUnsilence)}
        />
      )}
      {/* A list that couldn't be read isn't an empty one: the banner says so. */}
      {!(loadFailed && silences === null) && (
        <SettingsGroup>
          {silences && silences.length > 0 ? (
            silences.map((silence) => (
              <SilencedPluginRow
                key={silence.pluginId}
                silence={silence}
                busy={pending !== null}
                onUnsilence={() => unsilence(silence)}
              />
            ))
          ) : (
            <SettingsEmptyRow>
              Silence a plugin from the menu on one of its notifications to hold the rest back
            </SettingsEmptyRow>
          )}
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}

function SilencedPluginRow({
  silence,
  busy,
  onUnsilence,
}: {
  silence: PluginNotificationSilence;
  busy: boolean;
  onUnsilence: () => void;
}) {
  const projectName = useProjectStore((s) =>
    silence.projectId ? s.projects.find((p) => p.id === silence.projectId)?.name : undefined
  );
  const scope = silence.projectId
    ? `In ${projectName ?? UNKNOWN_PROJECT_LABEL.toLowerCase()}`
    : "In every project";
  return (
    <SettingsRow
      label={silence.name}
      description={scope}
      rootAttributes={{ "data-testid": `silenced-plugin-${silence.pluginId}` }}
      control={({ disabled }) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          aria-label={`Unsilence ${silence.name}`}
          onClick={onUnsilence}
        >
          Unsilence
        </Button>
      )}
    />
  );
}
