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
import {
  DEFAULT_PLUGIN_CONNECTION_ID,
  type LoadedPluginInfo,
  type PluginAccountContribution,
  type PluginAccountUiStatus,
  type PluginAccountVerification,
} from "@shared/types/plugin";
import { unavailableSecretStorageText, lockedSecretStorageText } from "./PluginSettingsForm";

/** The DOM id of a plugin's account row; the default connection keeps the id it always had. */
export function pluginAccountRowId(pluginId: string, connectionId?: string): string {
  return connectionId === undefined || connectionId === DEFAULT_PLUGIN_CONNECTION_ID
    ? `plugin-account-${pluginId}`
    : `plugin-account-${pluginId}-${connectionId}`;
}

interface PluginAccountRowProps {
  plugin: LoadedPluginInfo;
  account: PluginAccountContribution;
  /** Which declared connection this row is; `"default"` for `contributes.account`. */
  connectionId?: string;
}

/**
 * What the host last saw when it used the stored tokens. "Connected" only
 * says tokens are kept; this says whether the service still took them.
 */
function verificationText(verification: PluginAccountVerification): string {
  switch (verification.status) {
    case "ok":
      return "The service accepted it when last checked";
    case "rejected":
    case "unreachable":
      return verification.message ?? "The last check failed";
    default:
      return "Saved in the keychain, not checked against the service yet";
  }
}

/**
 * The Connect / Disconnect row for one of a plugin's connections (#13823,
 * #14102). The host runs the sign-in and keeps the tokens; this row only ever
 * sees whether the connection is stored, what the service last said about it,
 * and the name the service reported.
 */
export function PluginAccountRow({
  plugin,
  account,
  connectionId = DEFAULT_PLUGIN_CONNECTION_ID,
}: PluginAccountRowProps) {
  const pluginId = plugin.instanceId;
  const [status, setStatus] = useState<PluginAccountUiStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waitingForBrowser, setWaitingForBrowser] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [replacingToken, setReplacingToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const { hostName } = useHostConnection();
  const { platform } = useHostPlatform();
  const remoteHostId = pluginViewHostId();

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    window.electron.plugin
      .getAccountStatus(pluginId, connectionId)
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
  }, [pluginId, connectionId, reloadKey]);

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
      const result = await window.electron.plugin.connectAccount(pluginId, connectionId);
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
    safeFireAndForget(window.electron.plugin.cancelAccountConnect(pluginId, connectionId), {
      context: "Cancelling a plugin account sign-in",
    });
  };

  const saveToken = async () => {
    if (token.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      setStatus(await window.electron.plugin.setAccountToken(pluginId, token, connectionId));
      setToken("");
      setReplacingToken(false);
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
      await window.electron.plugin.disconnectAccount(pluginId, connectionId);
      refresh();
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't disconnect the account"));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setError(null);
    setTesting(true);
    try {
      const verification = await window.electron.plugin.testAccountConnection(
        pluginId,
        connectionId
      );
      setStatus((current) => (current ? { ...current, verification } : current));
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't test the connection"));
    } finally {
      setTesting(false);
    }
  };

  const connected = status?.connected === true;
  // A sign-in started from another window, or before this row was opened, is
  // still this account's: show it and let it be cancelled here.
  const signingIn = waitingForBrowser || (status?.pending === true && !connected);
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

  const verification = status?.verification;
  const connectedText = status?.identity ? `Connected as ${status.identity}` : "Connected";
  const description = loadFailed
    ? "Couldn't read this account's status"
    : signingIn
      ? "Finish signing in in your browser…"
      : connected
        ? verification
          ? `${connectedText}. ${verificationText(verification)}`
          : connectedText
        : verification?.status === "revoked"
          ? "The service ended this sign-in. Connect again to use it"
          : (account.description ??
            (account.kind === "oauth2"
              ? "Sign in through your browser. Daintree keeps the tokens in the OS keychain"
              : "Paste an API token. Daintree keeps it in the OS keychain"));

  const tokenField = account.kind === "token" && (!connected || replacingToken);

  return (
    <SettingsGroup>
      <SettingsRow
        id={pluginAccountRowId(pluginId, connectionId)}
        label={account.label}
        description={description}
        // Three actions once connected would squeeze the label, so they wrap under it.
        layout={tokenField || connected ? "stacked" : "inline"}
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
          if (connected && !tokenField && !signingIn) {
            return (
              <div className="flex items-center gap-2">
                {status?.testable && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || testing}
                    onClick={() => void test()}
                  >
                    {testing ? "Testing…" : "Test"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || testing || remoteHostId !== null}
                  onClick={() =>
                    account.kind === "token" ? setReplacingToken(true) : void connect()
                  }
                >
                  Reconnect
                </Button>
                <Button
                  variant="ghost-danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmingDisconnect(true)}
                >
                  Disconnect
                </Button>
              </div>
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
                  {replacingToken ? "Replace" : "Connect"}
                </Button>
                {replacingToken && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setReplacingToken(false);
                      setToken("");
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </form>
            );
          }
          if (signingIn) {
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
        description={`Daintree forgets this account's tokens. ${plugin.manifest.displayName ?? plugin.manifest.name} can't use the service until you connect again, in any project that uses this connection.`}
        confirmLabel="Disconnect account"
        zIndex="nested"
      />
    </SettingsGroup>
  );
}
