import { useState } from "react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import { sshConnection, type HostId } from "@shared/types/remoteHosts";
import type { HostProbeResult } from "@shared/types/ipc/remoteHosts";
import { installLabel, platformLabel, SSH_TARGET_HINT } from "./hostLabels";

interface ChangeHostTargetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  hostId: HostId;
  hostName: string;
  currentTarget: string;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right text-text-primary select-text">{value}</span>
    </div>
  );
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/**
 * Re-point a host at another SSH target, deliberately: what answers there is
 * checked first, the change says what it does to the host's windows and
 * permissions, and only then is the host rebound. The new target may be
 * another machine, so nothing kept for the old one carries over and nothing
 * dials the new one until someone connects.
 */
export function ChangeHostTargetDialog({
  isOpen,
  onClose,
  hostId,
  hostName,
  currentTarget,
}: ChangeHostTargetDialogProps) {
  const [target, setTarget] = useState(currentTarget);
  const [probe, setProbe] = useState<HostProbeResult | null>(null);
  /** The exact target `probe` is about; an edit after the check needs another. */
  const [checked, setChecked] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = target.trim();
  const unchanged = next === currentTarget;
  const reviewed = probe !== null && checked === next && !unchanged;

  const check = () => {
    setChecking(true);
    setError(null);
    const asked = next;
    remoteHostsClient.probe(sshConnection(asked)).then(
      (result) => {
        setChecking(false);
        setProbe(result);
        setChecked(asked);
      },
      (err: unknown) => {
        setChecking(false);
        setError(errorText(err, "Couldn't check that target"));
      }
    );
  };

  const change = () => {
    setChanging(true);
    setError(null);
    remoteHostsClient.update({ hostId, connection: sshConnection(next) }).then(
      () => {
        setChanging(false);
        onClose();
      },
      (err: unknown) => {
        setChanging(false);
        setError(errorText(err, "Couldn't change the SSH target"));
      }
    );
  };

  const primary: DialogAction = reviewed
    ? {
        label: "Change target",
        onClick: change,
        intent: "destructive",
        disabled: changing,
        loading: changing,
      }
    : {
        label: "Check target",
        onClick: check,
        disabled: checking || next.length === 0 || unchanged,
        loading: checking,
      };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      hasPreview
      // Windows are moving and permissions clearing: it settles with the dialog in view.
      dismissible={!changing}
      data-testid="change-host-target-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Change SSH target for &apos;{hostName}&apos;?</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="space-y-4">
          <Line label="Current target" value={currentTarget} />
          <Field>
            <FieldLabel>New SSH target</FieldLabel>
            <Input
              value={target}
              disabled={checking || changing}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !reviewed && !checking && next && !unchanged) check();
              }}
            />
            <FieldDescription>{SSH_TARGET_HINT}</FieldDescription>
          </Field>
          {reviewed && probe && (
            <div data-testid="change-host-target-probe">
              <p className="text-sm font-medium text-text-primary">What answered at {checked}</p>
              <Line label="SSH" value={probe.reachable ? "Works" : "Didn't connect"} />
              {!probe.reachable && probe.sshError && (
                <pre className="mt-1 whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-secondary select-text">
                  {probe.sshError}
                </pre>
              )}
              {probe.reachable && (
                <>
                  <Line label="Platform" value={platformLabel(probe.platform, probe.arch)} />
                  <Line label="Installed" value={installLabel(probe.install)} />
                  <Line label="Host mode" value={probe.hostModeListening ? "Listening" : "Off"} />
                </>
              )}
            </div>
          )}
          {reviewed && (
            <p className="text-sm text-text-secondary">
              {`Windows showing ${hostName} return to this machine and its connection closes. Its plugin permissions, history and browser data on this device are cleared, since ${next} may be another machine. Nothing connects to ${next} until you connect. Projects and Daintree at ${currentTarget} keep running.`}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-status-error select-text">
            {error}
          </p>
        )}
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={primary}
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: changing }}
      />
    </AppDialog>
  );
}
