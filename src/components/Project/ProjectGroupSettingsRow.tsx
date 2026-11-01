import { useEffect } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsRow,
  SettingsRowActions,
} from "@/components/Settings/SettingsGroup";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";

/**
 * The picker's value for no group. Radix refuses an empty-string item value,
 * and group ids are minted as UUIDs, so the two can't collide.
 */
const NO_GROUP = "no-group";

/**
 * Project settings → General's "Group" row (#16036): which switcher group the
 * project is filed under, applied the moment it is picked. What it shows comes
 * from the project itself, which the host pushes back after every move.
 *
 * Always rendered, unlike the creation dialogs' field: someone looking for
 * groups in settings has to find the row before any group exists, and
 * "New group…" makes the first one from this project, as the switcher's
 * "Move to group" menu does. It is a button rather than an entry in the picker
 * because the picker hands focus back to its trigger only after closing, by
 * which time the new dialog has opened with nothing to return focus to.
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

  const current = groupId !== undefined && groups.some((g) => g.id === groupId) ? groupId : null;

  return (
    <SettingsRow
      id="project-group"
      label="Group"
      description="Files this project under a heading in the project switcher"
      layout="stacked"
      control={({ labelId, descriptionId, disabled }) => (
        <SettingsRowActions>
          {groups.length > 0 && (
            <Select
              value={current ?? NO_GROUP}
              onValueChange={(value) => {
                const next = value === NO_GROUP ? null : value;
                if (next !== current) void setProjectGroup(projectId, next);
              }}
              disabled={disabled}
            >
              <SelectTrigger
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                className={SETTINGS_CONTROL_WIDTH.select}
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
        </SettingsRowActions>
      )}
    />
  );
}
