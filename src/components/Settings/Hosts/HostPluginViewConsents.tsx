import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import type { PluginViewConsentEntry } from "@shared/types/ipc/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { clientErrorText } from "@/utils/clientAppError";

interface HostPluginViewConsentsProps {
  hostId: string;
  hostName: string;
}

/** The plugin's name without the project prefix a project plugin's instance id carries. */
function pluginLabel(pluginId: string): string {
  const parts = pluginId.split("__");
  return parts[parts.length - 1] ?? pluginId;
}

type ListState =
  | { status: "loading" }
  | { status: "loaded"; plugins: PluginViewConsentEntry[] }
  /** `plugins` is the last list read, kept while a later read failed. */
  | { status: "failed"; message: string; plugins: PluginViewConsentEntry[] | null };

/**
 * The host plugins this computer was asked about running the view code of:
 * the ones allowed, and the ones refused this run. Resetting forgets the
 * answer, so the plugin asks again before its view next loads.
 */
export function HostPluginViewConsents({ hostId, hostName }: HostPluginViewConsentsProps) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [resetErrors, setResetErrors] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState<ReadonlySet<string>>(() => new Set());
  // Read before React commits, so a second press can't start a second reset.
  const resettingRef = useRef(new Set<string>());
  // Only the latest read lands: an older one finishing late would bring back a reset row.
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    remoteHostsClient.listPluginViewConsents(hostId).then(
      (plugins) => {
        if (seq === loadSeq.current) setList({ status: "loaded", plugins });
      },
      (err: unknown) => {
        if (seq !== loadSeq.current) return;
        setList((prev) => ({
          status: "failed",
          message: clientErrorText(err, "Couldn't load plugin views"),
          plugins: prev.status === "loading" ? null : prev.plugins,
        }));
      }
    );
  }, [hostId]);

  useEffect(() => {
    load();
    return () => {
      loadSeq.current += 1;
    };
  }, [load]);

  const reset = (pluginId: string) => {
    if (resettingRef.current.has(pluginId)) return;
    resettingRef.current.add(pluginId);
    setResetting(new Set(resettingRef.current));
    setResetErrors(({ [pluginId]: _previous, ...rest }) => rest);
    const settle = () => {
      resettingRef.current.delete(pluginId);
      setResetting(new Set(resettingRef.current));
    };
    remoteHostsClient.resetPluginViewConsent(hostId, pluginId).then(
      () => {
        settle();
        load();
      },
      (err: unknown) => {
        settle();
        const why = clientErrorText(err, "");
        setResetErrors((prev) => ({
          ...prev,
          [pluginId]: why ? `Couldn't reset it: ${why}` : "Couldn't reset it",
        }));
      }
    );
  };

  const plugins = list.status === "loading" ? null : list.plugins;

  return (
    <SettingsSection
      title="Plugin views"
      description={`Plugins from ${hostName} you were asked about running on this computer. A view already open keeps running until its window reloads.`}
    >
      {/* Nothing is claimed about the list until it has been read. */}
      {list.status !== "loading" && (
        <SettingsGroup>
          {list.status === "failed" && (
            <SettingsRow
              label="Couldn't load plugin views"
              description={<span role="alert">{list.message}</span>}
              control={
                <Button variant="outline" size="sm" onClick={load}>
                  Retry
                </Button>
              }
            />
          )}
          {list.status === "loaded" && list.plugins.length === 0 && (
            <SettingsEmptyRow>
              No plugin from {hostName} has asked to run its view here
            </SettingsEmptyRow>
          )}
          {plugins?.map(({ pluginId, state }) => {
            const label = pluginLabel(pluginId);
            const failed = resetErrors[pluginId];
            const pending = resetting.has(pluginId);
            return (
              <SettingsRow
                key={pluginId}
                label={label}
                description={
                  state === "allowed"
                    ? "Allowed. A changed plugin asks again."
                    : "Blocked until Daintree restarts here"
                }
                error={failed ? <span role="alert">{failed}</span> : undefined}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => reset(pluginId)}
                    disabled={pending}
                    loading={pending}
                    aria-label={
                      failed
                        ? `Retry resetting the plugin view for ${label}`
                        : `Reset the plugin view for ${label}`
                    }
                  >
                    {failed ? "Retry" : "Reset"}
                  </Button>
                }
              />
            );
          })}
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}
