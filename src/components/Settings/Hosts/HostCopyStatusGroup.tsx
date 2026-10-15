import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PORTABLE_SETTINGS_CATEGORIES } from "@shared/config/portableSettings";
import type { ConfigBundleSectionId } from "@shared/types/configBundle";
import type { SettingsCopyLastCopy, SettingsCopyUndone } from "@shared/types/ipc/settingsCopy";
import type { HostId } from "@shared/types/remoteHosts";
import { clientErrorText } from "@/utils/clientAppError";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { pluralize } from "@/lib/pluralize";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import type { HostSettingsCopyStatusState } from "./useHostSettingsCopyStatus";

interface HostCopyStatusGroupProps {
  hostId: HostId;
  hostName: string;
  state: HostSettingsCopyStatusState;
  /** A copy is being previewed or applied: undo waits for it. */
  busy: boolean;
  onRefresh: () => void;
  onUndone: (lastCopy: SettingsCopyLastCopy) => void;
}

function categoryLabels(sections: readonly ConfigBundleSectionId[]): string[] {
  return PORTABLE_SETTINGS_CATEGORIES.filter((category) =>
    category.sections.some((section) => sections.includes(section))
  ).map((category) => category.label);
}

/** "Agents, Notifications · 12 applied · 2 skipped" */
function describeCopy(copy: SettingsCopyLastCopy): string {
  const applied = copy.sections.reduce((sum, section) => sum + section.applied, 0);
  const skipped = copy.sections.reduce((sum, section) => sum + section.skipped, 0);
  const parts = [
    categoryLabels(copy.sections.map((section) => section.section)).join(", "),
    `${applied} applied`,
    skipped > 0 ? `${skipped} skipped` : null,
  ];
  if (copy.undo === "unavailable") parts.push("Too large to keep an undo");
  if (copy.undone) {
    const restored = copy.undone.leaves.filter((leaf) => leaf.status === "restored").length;
    parts.push(
      `Undone ${formatRelativeTime(copy.undone.at)}, ${pluralize(restored, "setting")} restored`
    );
  }
  return parts.filter((part): part is string => !!part).join(" · ");
}

/**
 * The top of a host's Copy settings (#13347): what a copy from this computer
 * would change there now, the last copy it received and from where, and an
 * undo of that copy that leaves anything changed since alone.
 */
export function HostCopyStatusGroup({
  hostId,
  hostName,
  state,
  busy,
  onRefresh,
  onUndone,
}: HostCopyStatusGroupProps) {
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undone, setUndone] = useState<{ copyId: string; result: SettingsCopyUndone } | null>(null);

  const status =
    state.kind === "ready" ? state.status : state.kind === "loading" ? state.previous : null;
  // A host too old to say shows nothing at all, not an error and not "nothing".
  if (status !== null && !status.supported) return null;
  if (state.kind === "idle") return null;

  const loading = state.kind === "loading";
  const lastCopy = status?.lastCopy ?? null;
  const changed = status?.changes ?? [];

  const driftLabel =
    status === null
      ? loading
        ? "Checking what a copy would change…"
        : "Couldn't check what a copy would change"
      : `Copying from this computer would change ${pluralize(changed.length, "category", "categories")}`;
  const driftDescription =
    status === null
      ? undefined
      : changed.length === 0
        ? `${hostName} already has everything this computer would copy. Settings only ${hostName} has aren't counted`
        : PORTABLE_SETTINGS_CATEGORIES.filter((category) => changed.includes(category.id))
            .map((category) => category.label)
            .join(", ");

  const undo = () => {
    if (!lastCopy) return;
    const copyId = lastCopy.id;
    setUndoing(true);
    setUndoError(null);
    window.electron.settingsCopy.undo({ hostId, copyId }).then(
      (result) => {
        setUndoing(false);
        setConfirming(false);
        setUndone({ copyId, result: result.undone });
        onUndone(result.lastCopy);
      },
      (err: unknown) => {
        setUndoing(false);
        setConfirming(false);
        setUndoError(clientErrorText(err, `Couldn't undo the copy on ${hostName}`));
        onRefresh();
      }
    );
  };

  const shownUndo = undone && lastCopy?.id === undone.copyId ? undone.result : null;
  const leftAlone = (shownUndo?.leaves ?? []).filter(
    (leaf) => leaf.status === "edited" || leaf.status === "failed"
  );
  const toUndo = lastCopy?.changed ?? [];

  return (
    <SettingsGroup label={`Compared with ${hostName}`}>
      <SettingsRow
        label={driftLabel}
        description={driftDescription}
        error={state.kind === "error" ? state.message : undefined}
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            aria-busy={loading || undefined}
          >
            {state.kind === "error" ? "Retry" : "Refresh"}
          </Button>
        }
      />
      {lastCopy !== null && (
        <SettingsRow
          label={`Last copied from ${lastCopy.source || "another computer"} ${formatRelativeTime(lastCopy.at)}`}
          description={describeCopy(lastCopy)}
          error={undoError ?? undefined}
          control={
            lastCopy.undo === "available" ? (
              <Button
                variant="ghost-danger"
                size="sm"
                onClick={() => {
                  setUndoError(null);
                  setConfirming(true);
                }}
                disabled={busy || loading || undoing}
              >
                Undo last copy
              </Button>
            ) : undefined
          }
        />
      )}
      {leftAlone.map((leaf) => (
        <SettingsRow
          key={`${leaf.section}:${leaf.key}`}
          label={leaf.label}
          description={
            leaf.status === "edited"
              ? `Kept · Changed on ${hostName} since the copy`
              : "Couldn't restore · Still as the copy left it"
          }
        />
      ))}
      <ConfirmDialog
        isOpen={confirming && lastCopy !== null}
        onClose={() => {
          if (!undoing) setConfirming(false);
        }}
        variant="destructive"
        title={`Undo the last settings copy to '${hostName}'?`}
        description={`${pluralize(toUndo.length, "setting")} on ${hostName} go back to what they were before the copy from ${lastCopy?.source || "another computer"}. Any of them changed on ${hostName} since stays as it is.`}
        confirmLabel="Undo copy"
        onConfirm={undo}
        isConfirmLoading={undoing}
        hasPreview
      >
        {toUndo.length > 0 && (
          <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-text-secondary select-text">
            {toUndo.map((leaf) => (
              <li key={`${leaf.section}:${leaf.key}`}>{leaf.label}</li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    </SettingsGroup>
  );
}
