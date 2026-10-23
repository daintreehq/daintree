import { useCallback, useEffect, useState } from "react";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
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
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    window.electron.plugin
      .getAccountBinding(pluginId)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) logError(`Failed to load the connection choice for ${pluginId}`, err);
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

  if (!status || status.choices.length < 2) return null;

  const choose = async (binding: PluginAccountBinding | null) => {
    setError(null);
    setSaving(true);
    try {
      setStatus(await window.electron.plugin.setAccountBinding(pluginId, binding));
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't change the connection"));
    } finally {
      setSaving(false);
    }
  };

  const selected = status.choices.find(
    (choice) => choiceValue(choice) === choiceValue(status.selected)
  );

  return (
    <SettingsGroup>
      <SettingsSelect
        label="Connection for this project"
        description={
          selected && !selected.connected
            ? plugin.origin === "project"
              ? "Not connected yet. Connect it below, or choose another"
              : "Not connected yet. Connect it in the plugin manager, or choose another"
            : "Which signed-in connection this project uses. Nothing is written to the repository"
        }
        value={choiceValue(status.selected)}
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
