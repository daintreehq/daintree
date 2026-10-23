import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { Button, Input, SettingsRow, Text } from "@daintreehq/plugin-ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { CHANNELS, type ConnectionStatus } from "../contracts";
import { call, useConnection } from "./data";

const WORKSPACE_SETTING = "providerWorkspace";

/**
 * Request Desk's settings section: rows only, under the host's own heading
 * and group, applied as they change with no Save. The root holds the one
 * control the setup step deep-links to; the Connection page holds the rest.
 * The view never holds a credential — this provider has none, and a real one
 * would keep its token in a `type: "secret"` setting the worker reads.
 */
export default function Settings({ pluginId, settingsContext }: PanelViewProps): ReactElement {
  const connection = useConnection(pluginId);
  const page = settingsContext?.page ?? null;
  const focus = settingsContext?.focus;
  const inputRef = useRef<HTMLInputElement>(null);
  const [workspace, setWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  // A deep link to the setting lands here. It is on the root only, so a page
  // answers false and the host falls back to showing the whole section.
  useEffect(() => {
    if (!focus || focus.key !== WORKSPACE_SETTING) return;
    if (page !== null || !inputRef.current) {
      focus.acknowledge(false);
      return;
    }
    inputRef.current.focus();
    focus.acknowledge(true);
  }, [focus, page]);

  const run = async (channel: string, args?: unknown) => {
    setBusy(true);
    try {
      await call<ConnectionStatus>(pluginId, channel, args);
      setTest(null);
      await connection.revalidate();
    } finally {
      setBusy(false);
    }
  };

  const status = connection.data;
  if (page === "connection") {
    return (
      <div className="divide-y divide-border-subtle">
        <SettingsRow
          label="Status"
          description={status?.connected ? `Connected to ${status.workspace}` : "Not connected"}
          control={
            <Button
              variant="outline"
              size="sm"
              loading={busy}
              onClick={async () =>
                setTest(
                  await call<{ ok: boolean; message: string }>(pluginId, CHANNELS.testConnection)
                )
              }
            >
              Test connection
            </Button>
          }
        />
        {test ? (
          <SettingsRow
            label="Last test"
            control={<Text tone={test.ok ? "success" : "danger"}>{test.message}</Text>}
          />
        ) : null}
        <SettingsRow
          label="Disconnect"
          description="Reports already built stay. New ones need a workspace."
          disabled={!status?.connected}
          control={
            <Button
              variant="ghost-danger"
              size="sm"
              disabled={!status?.connected || busy}
              onClick={() => void run(CHANNELS.disconnect)}
            >
              Disconnect
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="divide-y divide-border-subtle">
      <SettingsRow
        label="Report provider workspace"
        description={
          status?.connected
            ? `Connected to ${status.workspace}. Synthetic and offline: nothing leaves this machine.`
            : "Name any workspace. The synthetic provider accepts it offline."
        }
        control={({ labelId }) =>
          status?.connected ? (
            <Text>{status.workspace}</Text>
          ) : (
            <span className="flex gap-1.5">
              <Input
                ref={inputRef}
                value={workspace}
                onValueChange={setWorkspace}
                placeholder="Demo workspace"
                aria-labelledby={labelId}
              />
              <Button
                size="sm"
                loading={busy}
                onClick={() => void run(CHANNELS.connect, { workspace })}
              >
                Connect
              </Button>
            </span>
          )
        }
      />
    </div>
  );
}
