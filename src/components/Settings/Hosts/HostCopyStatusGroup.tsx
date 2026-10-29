import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { deviceOwnerPhrase } from "@/hooks/useSettingsOwner";
import {
  PORTABLE_SETTINGS_CATEGORIES,
  categoryOfSection,
  type PortableSettingsCategoryId,
} from "@shared/config/portableSettings";
import type { ConfigBundleSectionId } from "@shared/types/configBundle";
import type {
  SettingsCopyChangedLeaf,
  SettingsCopyLastCopy,
  SettingsCopyStatus,
} from "@shared/types/ipc/settingsCopy";
import type { HostId } from "@shared/types/remoteHosts";
import { clientErrorText } from "@/utils/clientAppError";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { pluralNoun, pluralize } from "@/lib/pluralize";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
  SettingsRowActions,
} from "../SettingsGroup";
import { NameList, StatusLine } from "./settingsCopyParts";
import { changePhrase, listPhrase } from "./settingsCopyPreview";
import { statusOf, type HostSettingsCopyStatusState } from "./useHostSettingsCopyStatus";

function categoryLabels(sections: readonly ConfigBundleSectionId[]): string[] {
  return PORTABLE_SETTINGS_CATEGORIES.filter((category) =>
    category.sections.some((section) => sections.includes(section))
  ).map((category) => category.label);
}

interface HostCopyDriftGroupProps {
  hostName: string;
  state: HostSettingsCopyStatusState;
  /** A copy is being previewed or applied. */
  busy: boolean;
  onRefresh: () => void;
  /** Preview exactly the categories that differ. */
  onPreview: (categories: PortableSettingsCategoryId[]) => void;
  /** That preview is on its way: its own button shows the wait. */
  previewing?: boolean;
}

/** A refresh or an undo answers in place: say so, politely, without moving focus. */
const LIVE = { "aria-live": "polite" } as const;

/** "Agent settings (2 overwrites, 1 new), Global recipes (2 new)" */
function differences(status: SettingsCopyStatus, ids: readonly PortableSettingsCategoryId[]) {
  return PORTABLE_SETTINGS_CATEGORIES.filter((category) => ids.includes(category.id))
    .map((category) => {
      const counts = status.changeCounts?.[category.id];
      return counts
        ? `${category.label} (${changePhrase(counts.update, counts.add)})`
        : category.label;
    })
    .join(", ");
}

/**
 * The top of a host's Copy settings (#13347): whether a copy from this Mac
 * would change anything there now, and in what, with the way to see each
 * setting one click away.
 */
export function HostCopyDriftGroup({
  hostName,
  state,
  busy,
  onRefresh,
  onPreview,
  previewing = false,
}: HostCopyDriftGroupProps) {
  const status = statusOf(state);
  // A host too old to say shows nothing at all, not an error and not "nothing".
  if (status !== null && !status.supported) return null;
  if (state.kind === "idle") return null;

  const loading = state.kind === "loading";
  const changed = status?.changes;
  const refresh = (
    <Button variant="outline" size="sm" onClick={onRefresh} loading={loading}>
      {state.kind === "error" ? "Retry" : "Refresh"}
    </Button>
  );
  const error = state.kind === "error" ? state.message : undefined;

  if (status === null) {
    return (
      <SettingsGroup label={`Compared with ${hostName}`} rootAttributes={LIVE}>
        <SettingsRow
          label={loading ? "Checking what differs…" : "Couldn't compare"}
          error={error}
          control={refresh}
        />
      </SettingsGroup>
    );
  }

  if (changed === null || changed === undefined) {
    return (
      <SettingsGroup label={`Compared with ${hostName}`} rootAttributes={LIVE}>
        <SettingsRow
          label="Too many settings to compare at once"
          description="Preview a few categories at a time below to see what differs"
          error={error}
          control={refresh}
        />
      </SettingsGroup>
    );
  }

  if (changed.length === 0) {
    return (
      <SettingsGroup label={`Compared with ${hostName}`} rootAttributes={LIVE}>
        <SettingsRow
          label={`${hostName} matches ${deviceOwnerPhrase()}`}
          description={`A copy would change nothing. Settings only ${hostName} has aren't counted`}
          error={error}
          control={refresh}
        />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup label={`Compared with ${hostName}`} rootAttributes={LIVE}>
      <SettingsRow
        layout="stacked"
        label={`${pluralize(changed.length, "category", "categories")} ${changed.length === 1 ? "differs" : "differ"} from ${deviceOwnerPhrase()}`}
        description={differences(status, changed)}
        error={error}
        control={
          <SettingsRowActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPreview([...changed])}
              disabled={!previewing && (busy || loading)}
              loading={previewing}
            >
              Preview {changed.length === 1 ? "it" : "these"}
            </Button>
            {refresh}
          </SettingsRowActions>
        }
      />
    </SettingsGroup>
  );
}

/** "Gemini, removed", "New terminals start with, back to Codex", "Claude, restored" */
function undoLine(leaf: SettingsCopyChangedLeaf): string {
  if (leaf.kind === "add") return `${leaf.label}, removed`;
  if (leaf.from !== undefined) return `${leaf.label}, back to ${leaf.from}`;
  return leaf.kind === "update" ? `${leaf.label}, restored` : leaf.label;
}

/** The leaves an undo takes back, under the category each belongs to. */
function UndoList({ leaves }: { leaves: readonly SettingsCopyChangedLeaf[] }) {
  const groups = new Map<string, SettingsCopyChangedLeaf[]>();
  for (const leaf of leaves) {
    const label = categoryOfSection(leaf.section)?.label ?? leaf.section;
    groups.set(label, [...(groups.get(label) ?? []), leaf]);
  }
  return (
    <div className="max-h-56 space-y-3 overflow-y-auto text-xs select-text">
      {[...groups].map(([label, items]) => (
        <div key={label}>
          <div className="font-medium text-text-primary">{label}</div>
          <ul className="mt-1 space-y-0.5 text-text-secondary">
            {items.map((leaf) => (
              <li key={`${leaf.section}:${leaf.key}`}>{undoLine(leaf)}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function unavailableReason(copy: SettingsCopyLastCopy, hostName: string): string {
  if (copy.undoUnavailable === "too-large") {
    return `${hostName} couldn't keep the earlier values: there were too many to store`;
  }
  if (copy.undoUnavailable === "later-copy") {
    return `A later copy to ${hostName} didn't finish, so the earlier values were let go`;
  }
  return `${hostName} didn't keep the earlier values for this copy`;
}

interface HostLastCopyGroupProps {
  hostId: HostId;
  hostName: string;
  state: HostSettingsCopyStatusState;
  /** A copy is being previewed or applied: undo waits for it. */
  busy: boolean;
  onRefresh: () => void;
  onUndone: (lastCopy: SettingsCopyLastCopy) => void;
}

/**
 * The last copy the host received and from where (#13347), and an undo of it
 * that leaves anything changed since alone. Last in the section: the undo is a
 * reversal on another machine, not part of the copy flow above it.
 */
export function HostLastCopyGroup({
  hostId,
  hostName,
  state,
  busy,
  onRefresh,
  onUndone,
}: HostLastCopyGroupProps) {
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  // An undo answering after the page moved on (disconnected, closed) is dropped.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const status = statusOf(state);
  const lastCopy = status?.supported ? status.lastCopy : null;
  if (!lastCopy) return null;

  const source = lastCopy.source || "another computer";
  const applied = lastCopy.sections.reduce((sum, section) => sum + section.applied, 0);
  const skipped = lastCopy.sections.reduce((sum, section) => sum + section.skipped, 0);
  const toUndo = lastCopy.changed ?? [];
  // From the host's own record, so it is still there on reopening the page.
  const undoneLeaves = lastCopy.undone?.leaves ?? [];
  const restored = undoneLeaves.filter((leaf) => leaf.status === "restored").length;
  const kept = undoneLeaves.filter((leaf) => leaf.status === "edited").map((leaf) => leaf.label);
  const failed = undoneLeaves.filter((leaf) => leaf.status === "failed").map((leaf) => leaf.label);

  const undo = () => {
    const copyId = lastCopy.id;
    setUndoing(true);
    setUndoError(null);
    window.electron.settingsCopy.undo({ hostId, copyId }).then(
      (result) => {
        if (!live.current) return;
        setUndoing(false);
        setConfirming(false);
        onUndone(result.lastCopy);
      },
      (err: unknown) => {
        if (!live.current) return;
        setUndoing(false);
        setConfirming(false);
        setUndoError(clientErrorText(err, `Couldn't undo the copy on ${hostName}`));
        onRefresh();
      }
    );
  };

  return (
    <SettingsGroup
      label={`Last copy to ${hostName}`}
      rootAttributes={{ ...LIVE, "data-host-last-copy": "" }}
    >
      <SettingsRow
        label={`From ${source}`}
        // An undo that failed after the host had spent it has no undo row to sit on.
        error={lastCopy.undo === "available" ? undefined : (undoError ?? undefined)}
        description={
          <>
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span>{formatRelativeTime(lastCopy.at)}</span>
              <FactSeparator />
              <span>
                {pluralize(applied, "setting")} copied{skipped > 0 ? `, ${skipped} skipped` : ""}
              </span>
            </span>
            <span className="block">
              {listPhrase(categoryLabels(lastCopy.sections.map((section) => section.section)))}
            </span>
          </>
        }
      />
      {lastCopy.undo === "available" && (
        <SettingsRow
          label="Undo this copy"
          description={`Puts back the ${pluralize(toUndo.length || applied, "setting")} it changed. Settings changed on ${hostName} since then stay as they are`}
          error={undoError ?? undefined}
          control={
            <Button
              variant="ghost-danger"
              size="sm"
              onClick={() => {
                setUndoError(null);
                setConfirming(true);
              }}
              disabled={busy || state.kind === "loading" || undoing}
            >
              <RotateCcw aria-hidden="true" />
              Undo copy
            </Button>
          }
        />
      )}
      {lastCopy.undo === "unavailable" && (
        <SettingsRow
          label="Can't be undone"
          description={
            <StatusLine severity="info">{unavailableReason(lastCopy, hostName)}</StatusLine>
          }
        />
      )}
      {lastCopy.undo === "done" && !lastCopy.undone && (
        <SettingsRow
          label="Undo outcome unknown"
          description={
            <StatusLine severity="warning">
              {`${hostName} started the undo but didn't say how it went, so some settings may be put back and some not`}
            </StatusLine>
          }
        />
      )}
      {lastCopy.undo === "done" && lastCopy.undone && (
        <>
          <SettingsRow
            label={`${restored === 0 && failed.length > 0 ? "Undo failed" : failed.length > 0 ? "Partly undone" : "Undone"} ${formatRelativeTime(lastCopy.undone.at)}`}
            description={
              restored > 0 ? (
                <StatusLine severity={failed.length > 0 ? "warning" : "success"}>
                  {pluralize(restored, "setting")} put back
                </StatusLine>
              ) : (
                "Nothing was put back"
              )
            }
          />
          {(kept.length > 0 || failed.length > 0) && (
            <SettingsDependents>
              {kept.length > 0 && (
                <SettingsRow
                  label={`${pluralize(kept.length, "setting")} kept`}
                  description={
                    <>
                      <span className="block">
                        Changed on {hostName} since the copy, so left as{" "}
                        {pluralNoun(kept.length, "it is", "they are")}
                      </span>
                      <NameList names={kept} />
                    </>
                  }
                />
              )}
              {failed.length > 0 && (
                <SettingsRow
                  label={`${pluralize(failed.length, "setting")} couldn't be put back`}
                  description={<NameList names={failed} />}
                  error={`Couldn't confirm ${pluralNoun(failed.length, "it was", "they were")} put back. Check ${pluralNoun(failed.length, "it", "them")} on ${hostName}`}
                />
              )}
            </SettingsDependents>
          )}
        </>
      )}
      <ConfirmDialog
        isOpen={confirming}
        onClose={() => {
          if (!undoing) setConfirming(false);
        }}
        variant="destructive"
        title={`Undo the last copy to '${hostName}'?`}
        description={`${pluralize(toUndo.length, "setting")} on ${hostName} go back to how they were before the copy from ${source}. Any of them changed on ${hostName} since then stay as they are.`}
        confirmLabel="Undo copy"
        onConfirm={undo}
        isConfirmLoading={undoing}
        // A finished undo takes its button away: land on what is left of the
        // record, or the top of the section, never the app shell.
        restoreFocusTo={() =>
          document.querySelector<HTMLElement>("[data-host-last-copy] button") ??
          document.querySelector<HTMLElement>("#host-copy-settings button")
        }
        hasPreview
      >
        {toUndo.length > 0 && <UndoList leaves={toUndo} />}
      </ConfirmDialog>
    </SettingsGroup>
  );
}
