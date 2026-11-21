import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FIELD_CONTROL_SIZE, FormRow } from "@/components/Worktree/views/WorktreeFormLayout";
import { cn } from "@/lib/utils";
import type { ProjectGroup } from "@shared/types/project";
import { ProjectGroupNameDialog } from "./ProjectGroupNameDialog";

/**
 * The picker's value for no group. Radix refuses an empty-string item value,
 * and group ids are minted as UUIDs, so the two can't collide.
 */
const NO_GROUP = "no-group";

/**
 * Which project group the new project is filed under, as a form row, shared by
 * the three dialogs that create a project.
 *
 * Always rendered, so the first group can be made here: while none exist the
 * row is only a quiet "New group…" button, and No group stays the default
 * either way. The button sits beside the picker rather than inside it because
 * the picker hands focus back to its trigger only after closing, by which time
 * the name dialog has opened with nothing to return focus to. A group made here
 * exists from then on, but the project joins it only when the dialog submits.
 */
export function ProjectGroupField({
  id,
  groups,
  value,
  onChange,
  onCreate,
  disabled,
}: {
  id: string;
  groups: ProjectGroup[];
  value: string | null;
  onChange: (groupId: string | null) => void;
  /** Makes a group from the name typed and chooses it. Rejects with the host's refusal. */
  onCreate: (name: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [isNaming, setIsNaming] = useState(false);
  // Each opening starts the name dialog over with an empty box.
  const [naming, setNaming] = useState(0);
  // Whether this opening made a group, read when its dialog closes: the picker
  // then shows the new group and takes focus, where a cancel goes back to the
  // button that opened it.
  const createdRef = useRef(false);

  return (
    <FormRow label="Group" htmlFor={groups.length > 0 ? id : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        {groups.length > 0 && (
          <Select
            value={value ?? NO_GROUP}
            onValueChange={(next) => onChange(next === NO_GROUP ? null : next)}
            disabled={disabled}
          >
            <SelectTrigger
              id={id}
              className={cn(FIELD_CONTROL_SIZE, "min-w-0 flex-1")}
              data-testid="project-group-field"
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
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          data-testid="project-group-new"
          onClick={() => {
            createdRef.current = false;
            setNaming((count) => count + 1);
            setIsNaming(true);
          }}
        >
          <Plus aria-hidden="true" />
          New group…
        </Button>
      </div>
      <ProjectGroupNameDialog
        key={naming}
        isOpen={isNaming}
        create={async (name) => {
          await onCreate(name);
          createdRef.current = true;
        }}
        onClose={() => setIsNaming(false)}
        restoreFocusTo={() => (createdRef.current ? document.getElementById(id) : null)}
      />
    </FormRow>
  );
}
