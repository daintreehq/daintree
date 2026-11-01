import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SETTINGS_CONTROL_WIDTH, SettingsRow } from "@/components/Settings/SettingsGroup";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";

/**
 * The picker's value for no group. Radix refuses an empty-string item value,
 * and group ids are minted as UUIDs, so the two can't collide.
 */
const NO_GROUP = "no-group";

/**
 * Project settings → General's "Group" row (#16036): which switcher group the
 * project is filed under, applied the moment it is picked.
 *
 * Always rendered, unlike the creation dialogs' field: someone looking for
 * groups in settings has to find the row before any group exists, and the
 * "New group…" button makes the first one from this project, the same step the
 * switcher's "Move to group" menu offers. A button rather than an entry in the
 * picker, because a picked entry closes the picker and hands focus back to its
 * trigger only after the new dialog has opened, leaving that dialog nothing to
 * return focus to.
 */
export function ProjectGroupSettingsRow({
  projectId,
  groupId,
}: {
  projectId: string;
  groupId: string | undefined;
}) {
  const groups = useProjectGroupsStore((state) => state.groups);
  const setProjectGroup = useProjectGroupsStore((state) => state.setProjectGroup);
  const openDialog = useProjectGroupsStore((state) => state.openDialog);

  useEffect(() => {
    useProjectGroupsStore.getState().init();
  }, []);

  // The pick shows until its move settles: the project's new group arrives on
  // the host's push, and without this the picker would flick back to the old
  // one for the length of the round trip.
  const [pending, setPending] = useState<{ groupId: string | null } | null>(null);
  const latestPick = useRef(0);

  const saved = groupId !== undefined && groups.some((g) => g.id === groupId) ? groupId : null;
  const shown = pending ? pending.groupId : saved;

  const choose = (next: string | null) => {
    if (next === shown) return;
    const pick = ++latestPick.current;
    setPending({ groupId: next });
    void setProjectGroup(projectId, next).finally(() => {
      if (latestPick.current === pick) setPending(null);
    });
  };

  return (
    <SettingsRow
      id="project-group"
      label="Group"
      description="Where the project switcher lists this project"
      control={({ labelId, descriptionId, disabled }) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {groups.length > 0 && (
            <Select
              value={shown ?? NO_GROUP}
              onValueChange={(next) => choose(next === NO_GROUP ? null : next)}
              disabled={disabled}
            >
              <SelectTrigger
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                className={SETTINGS_CONTROL_WIDTH.select}
                data-testid="project-settings-group"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>No group</SelectItem>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => openDialog({ kind: "create", projectId })}
          >
            <Plus />
            New group…
          </Button>
        </div>
      )}
    />
  );
}
