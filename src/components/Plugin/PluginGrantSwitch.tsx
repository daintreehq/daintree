import { useEffect, useRef, useState } from "react";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";

interface GrantSwitchSpec {
  label: string;
  description: string;
  read: (pluginId: string) => Promise<boolean>;
  write: (pluginId: string, enabled: boolean) => Promise<boolean>;
  /** What a failed "off" means, when it isn't "still on in memory, back after a restart". */
  offFailedText?: string;
}

const GRANT_SWITCHES = {
  "project-targeting": {
    label: "Allow project targeting",
    description:
      "Lets this plugin run actions in any open project, not just the one in front. Each targeted action is recorded in the plugin audit log.",
    read: (pluginId: string) => window.electron.pluginCapability.getProjectTargeting({ pluginId }),
    write: (pluginId: string, enabled: boolean) =>
      window.electron.pluginCapability.setProjectTargeting({ pluginId, enabled }),
  },
  "os-notifications": {
    label: "Allow OS notifications",
    description:
      "Lets this plugin's notifications also appear outside Daintree when you're away. Quiet hours and mute still apply.",
    read: (pluginId: string) => window.electron.pluginCapability.getOsNotifications({ pluginId }),
    write: (pluginId: string, enabled: boolean) =>
      window.electron.pluginCapability.setOsNotifications({ pluginId, enabled }),
  },
  // On by default, unlike the grants above: a note only annotates a delete the
  // user still decides. Off means the plugin isn't asked at all (#13805).
  "worktree-delete-notes": {
    label: "Show notes when deleting a worktree",
    description:
      "Lets this plugin add notes to the confirmation when you delete a worktree. Notes never stop a delete.",
    read: (pluginId: string) =>
      window.electron.pluginCapability.getWorktreeDeleteNotes({ pluginId }),
    write: (pluginId: string, enabled: boolean) =>
      window.electron.pluginCapability.setWorktreeDeleteNotes({ pluginId, enabled }),
    offFailedText: "Couldn't turn this off.",
  },
  "panel-attention": {
    label: "Show in attention views",
    description:
      "Lets this plugin's panels appear as their own rows in Pilot, the dock's Waiting and Unread pills and the sidebar's attention filters when it reports activity on them. They always sit below agents.",
    read: (pluginId: string) => window.electron.pluginCapability.getPanelAttention({ pluginId }),
    write: (pluginId: string, enabled: boolean) =>
      window.electron.pluginCapability.setPanelAttention({ pluginId, enabled }),
  },
} satisfies Record<string, GrantSwitchSpec>;

/**
 * A per-plugin grant the user turns on from the Plugin Manager: "Allow project
 * targeting" (#13119), "Allow OS notifications" (#13505) and "Show in attention
 * views" (#13821). Declaring the
 * capability only lets a plugin ask; this is the grant, off until the user
 * turns it on. Deliberately not a first-use prompt: the plugins that want them
 * orchestrate agents unattended, and a dialog at 3am would stall every launch
 * behind it. "Show notes when deleting a worktree" (#13805) shares the row but
 * starts on.
 */
export function PluginGrantSwitch({
  pluginId,
  grant,
}: {
  pluginId: string;
  grant: keyof typeof GRANT_SWITCHES;
}) {
  const { label, description, read, write, offFailedText }: GrantSwitchSpec = GRANT_SWITCHES[grant];
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  // The value a write failed to persist. Kept until a write succeeds: a failed
  // "off" is still revoked in memory but comes back after a restart, so a later
  // successful read must not quietly clear the warning.
  const [unsaved, setUnsaved] = useState<boolean | null>(null);
  // Only the latest request may settle the row, so a slow read can't overwrite
  // the result of a save that started after it.
  const requestSeq = useRef(0);
  const [readNonce, setReadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const seq = ++requestSeq.current;
    const current = () => !cancelled && seq === requestSeq.current;
    setBusy(true);
    read(pluginId)
      .then((value) => {
        if (!current()) return;
        setEnabled(value);
        setReadFailed(false);
      })
      .catch(() => {
        if (current()) setReadFailed(true);
      })
      .finally(() => {
        if (current()) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, read, readNonce]);

  const save = (next: boolean) => {
    const seq = ++requestSeq.current;
    setBusy(true);
    write(pluginId, next)
      .then((persisted) => {
        if (seq !== requestSeq.current) return;
        setEnabled(persisted);
        setUnsaved(null);
        setBusy(false);
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        setUnsaved(next);
        // Show what main has in force now rather than guessing.
        setReadNonce((n) => n + 1);
      });
  };

  const switchId = `plugin-${grant}-${pluginId}`;
  const descriptionId = `${switchId}-description`;
  const errorId = `${switchId}-error`;
  const errorText =
    unsaved === false
      ? (offFailedText ?? "Couldn't save turning this off, so it will be back on after a restart.")
      : unsaved === true
        ? "Couldn't turn this on."
        : readFailed
          ? "Couldn't read this setting."
          : null;

  return (
    <div className="flex items-start justify-between gap-3 pt-2 border-t border-border-default">
      <div className="min-w-0">
        <label htmlFor={switchId} className="block text-xs text-text-primary">
          {label}
        </label>
        <div id={descriptionId} className="text-2xs text-text-secondary">
          {description}
        </div>
        {errorText && (
          <div id={errorId} className="flex items-center gap-2 mt-0.5">
            <XCircle className="w-3 h-3 shrink-0 text-status-error" aria-hidden="true" />
            <span className="text-2xs text-text-secondary">{errorText}</span>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => (unsaved !== null ? save(unsaved) : setReadNonce((n) => n + 1))}
            >
              Retry
            </Button>
          </div>
        )}
      </div>
      <SettingsSwitch
        id={switchId}
        checked={enabled === true}
        onCheckedChange={save}
        disabled={enabled === null || busy}
        aria-describedby={errorText ? `${descriptionId} ${errorId}` : descriptionId}
        aria-invalid={unsaved !== null}
        data-testid={`plugin-${grant}-switch`}
      />
    </div>
  );
}
