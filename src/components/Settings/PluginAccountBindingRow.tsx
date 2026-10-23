import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import {
  pluginManifestIdFromInstanceKey,
  type LoadedPluginInfo,
  type PluginAccountBinding,
  type PluginAccountBindingChoice,
  type PluginAccountBindingUiStatus,
} from "@shared/types/plugin";

function choiceValue(binding: PluginAccountBinding): string {
  return `${binding.source}:${binding.connectionId}`;
}

function choiceLabel(choice: PluginAccountBindingChoice, plugin: LoadedPluginInfo): string {
  const where =
    choice.source === "machine"
      ? "this machine's"
      : plugin.origin === "project"
        ? "this project's"
        : null;
  const name = where ? `${choice.label} (${where})` : choice.label;
  return choice.identity ? `${name} · ${choice.identity}` : name;
}

/**
 * Which connection the open project uses for a plugin (#14102). Only a
 * reference is stored, in Daintree's own settings: the tokens stay with the
 * connection's owner, and choosing the machine's connection copies nothing
 * into the project. Hidden while there is only one choice.
 */
export function PluginAccountBindingRow({ plugin }: { plugin: LoadedPluginInfo }) {
  const pluginId = plugin.instanceId;
  const [status, setStatus] = useState<PluginAccountBindingUiStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reads and saves share one counter: only the newest answer is shown, so a
  // save that lands after another window's change can't put the old one back.
  const latest = useRef(0);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const request = ++latest.current;
    let cancelled = false;
    window.electron.plugin
      .getAccountBinding(pluginId)
      .then((next) => {
        if (cancelled || request !== latest.current) return;
        setStatus(next);
        setLoadFailed(false);
      })
      .catch((err: unknown) => {
        if (cancelled || request !== latest.current) return;
        setLoadFailed(true);
        logError(`Failed to load the connection choice for ${pluginId}`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, reloadKey]);

  // A machine connection belongs to the installed plugin, so its sign-ins
  // arrive under that id.
  useEffect(() => {
    const machineId = pluginManifestIdFromInstanceKey(pluginId);
    const unsubscribe = window.electron.plugin.onSettingsChanged?.((payload) => {
      if (payload.pluginId === pluginId || payload.pluginId === machineId) refresh();
    });
    return () => unsubscribe?.();
  }, [pluginId, refresh]);

  if (loadFailed && !status) {
    return (
      <SettingsLoadErrorBanner
        message="Couldn't read which connection this project uses"
        onRetry={refresh}
      />
    );
  }

  const selected = status?.choices.find(
    (choice) => choiceValue(choice) === choiceValue(status.selected)
  );
  // A choice the plugin no longer declares stays shown, so it can be replaced.
  const gone = status !== null && selected === undefined;
  if (!status || (status.choices.length < 2 && !gone)) return null;

  const choose = async (binding: PluginAccountBinding | null) => {
    const request = ++latest.current;
    setError(null);
    setSaving(true);
    try {
      const next = await window.electron.plugin.setAccountBinding(pluginId, binding);
      if (request === latest.current) setStatus(next);
    } catch (err) {
      if (request === latest.current) {
        setError(formatErrorMessage(err, "Couldn't change the connection"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup>
      <SettingsSelect
        label="Connection for this project"
        description={
          gone
            ? "The connection this project used is gone, so nothing is used. Choose another"
            : selected && !selected.connected
              ? plugin.origin === "project"
                ? "Not connected yet. Connect it below, or choose another"
                : "Not connected yet. Connect it in the plugin manager, or choose another"
              : "Which signed-in connection this project uses. Nothing is written to the repository"
        }
        value={gone ? "" : choiceValue(status.selected)}
        placeholder="Choose a connection"
        options={status.choices.map((choice) => ({
          value: choiceValue(choice),
          label: choiceLabel(choice, plugin),
        }))}
        onValueChange={(value) => {
          const choice = status.choices.find((c) => choiceValue(c) === value);
          if (choice) void choose({ connectionId: choice.connectionId, source: choice.source });
        }}
        isModified={status.binding !== null}
        onReset={() => void choose(null)}
        resetAriaLabel="Use the default connection"
        disabled={saving}
        error={error ?? undefined}
      />
    </SettingsGroup>
  );
}
