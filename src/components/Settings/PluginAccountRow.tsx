import { useCallback, useEffect, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { useHostConnection } from "@/hooks/useHostConnection";
import { useHostPlatform } from "@/hooks/useHostPlatform";
import { pluginViewHostId } from "@/components/Plugin/remotePluginView";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type {
  LoadedPluginInfo,
  PluginAccountContribution,
  PluginAccountUiStatus,
} from "@shared/types/plugin";
import { unavailableSecretStorageText, lockedSecretStorageText } from "./PluginSettingsForm";

/** The DOM id of a plugin's account row. */
export function pluginAccountRowId(pluginId: string): string {
  return `plugin-account-${pluginId}`;
}

interface PluginAccountRowProps {
  plugin: LoadedPluginInfo;
  account: PluginAccountContribution;
}

/**
 * The Connect / Disconnect row for a plugin's `contributes.account` (#13823).
 * The host runs the sign-in and keeps the tokens; this row only ever sees
 * whether the account is connected and the name the service reported.
 */
export function PluginAccountRow({ plugin, account }: PluginAccountRowProps) {
  const pluginId = plugin.instanceId;
  const [status, setStatus] = useState<PluginAccountUiStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waitingForBrowser, setWaitingForBrowser] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const { hostName } = useHostConnection();
  const { platform } = useHostPlatform();
  const remoteHostId = pluginViewHostId();

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    window.electron.plugin
      .getAccountStatus(pluginId)
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setLoadFailed(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadFailed(true);
        logError(`Failed to load the account status for ${pluginId}`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, reloadKey]);

  // A refresh the service refused disconnects the account from main; the
  // settings-changed event is how this row hears about it.
  useEffect(() => {
    const unsubscribe = window.electron.plugin.onSettingsChanged?.((payload) => {
      if (payload.pluginId === pluginId) refresh();
    });
    return () => unsubscribe?.();
  }, [pluginId, refresh]);

  const connect = async () => {
    setError(null);
    setBusy(true);
    setWaitingForBrowser(true);
    try {
      const result = await window.electron.plugin.connectAccount(pluginId);
      if (result.status === "connected") setStatus(result.account);
      else if (result.status === "failed") setError(result.message);
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't start the sign-in"));
    } finally {
      setBusy(false);
      setWaitingForBrowser(false);
    }
  };

  const cancel = () => {
    safeFireAndForget(window.electron.plugin.cancelAccountConnect(pluginId), {
      context: "Cancelling a plugin account sign-in",
    });
  };

  const saveToken = async () => {
    if (token.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      setStatus(await window.electron.plugin.setAccountToken(pluginId, token));
      setToken("");
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't save the token"));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    setBusy(true);
    try {
      await window.electron.plugin.disconnectAccount(pluginId);
      refresh();
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't disconnect the account"));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected === true;
  const secretHost = remoteHostId === null ? null : { name: hostName ?? remoteHostId, platform };
  const disabledReason =
    remoteHostId !== null && !connected
      ? `Connect from a window on ${hostName ?? remoteHostId} — signing in uses that machine's browser and keychain`
      : status?.secretTier === "unavailable" && !connected
        ? unavailableSecretStorageText(secretHost)
        : status?.secretTier === "locked" && !connected
          ? lockedSecretStorageText(secretHost, platform)
          : null;
  const disabled = status === null || disabledReason !== null;

  const description = loadFailed
    ? "Couldn't read this account's status"
    : connected
      ? status?.identity
        ? `Connected as ${status.identity}`
        : "Connected"
      : waitingForBrowser
        ? "Finish signing in in your browser…"
        : (account.description ??
          (account.kind === "oauth2"
            ? "Sign in through your browser. Daintree keeps the tokens in the OS keychain"
            : "Paste an API token. Daintree keeps it in the OS keychain"));

  const tokenField = account.kind === "token" && !connected;

  return (
    <SettingsGroup>
      <SettingsRow
        id={pluginAccountRowId(pluginId)}
        label={account.label}
        description={description}
        layout={tokenField ? "stacked" : "inline"}
        disabled={!connected && disabled}
        disabledReason={disabledReason ?? undefined}
        error={error ?? undefined}
        control={({ labelId, descriptionId, disabled: rowDisabled }) => {
          if (loadFailed) {
            return (
              <Button variant="outline" size="sm" onClick={refresh}>
                Retry
              </Button>
            );
          }
          if (connected) {
            return (
              <Button
                variant="ghost-danger"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDisconnect(true)}
              >
                Disconnect
              </Button>
            );
          }
          if (tokenField) {
            return (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveToken();
                }}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="API token"
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  disabled={rowDisabled || busy}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={rowDisabled || busy || token.trim() === ""}
                >
                  Connect
                </Button>
              </form>
            );
          }
          if (waitingForBrowser) {
            return (
              <Button variant="outline" size="sm" onClick={cancel}>
                Cancel
              </Button>
            );
          }
          return (
            <Button
              variant="outline"
              size="sm"
              aria-describedby={descriptionId}
              disabled={rowDisabled || busy}
              onClick={() => void connect()}
            >
              Connect
            </Button>
          );
        }}
      />
      <ConfirmDialog
        isOpen={confirmingDisconnect}
        variant="destructive"
        onConfirm={() => {
          setConfirmingDisconnect(false);
          void disconnect();
        }}
        onClose={() => setConfirmingDisconnect(false)}
        title={`Disconnect '${account.label}'?`}
        description={`Daintree forgets this account's tokens. ${plugin.manifest.displayName ?? plugin.manifest.name} can't use the service until you connect again.`}
        confirmLabel="Disconnect account"
        zIndex="nested"
      />
    </SettingsGroup>
  );
}
