import { useRef } from "react";
import { MoreHorizontal } from "lucide-react";
import { MemoryStick } from "@/components/icons";
import { SidebarFooterGlyph } from "@/components/Layout/SidebarFooterGlyph";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useSleepIdleProjects, type IdleProject } from "@/hooks/useSleepIdleProjects";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  useSystemMemoryNoticeStore,
  type SystemMemoryNotice,
} from "@/store/systemMemoryNoticeStore";

const ACTION_CLASS = cn(
  "flex shrink-0 items-center px-3 text-2xs font-medium text-text-secondary transition-colors",
  "hover:bg-overlay-soft hover:text-text-primary",
  "focus-visible:bg-overlay-medium focus-visible:text-text-primary",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
);

/**
 * High system memory use, as one ambient line at the top of the sidebar
 * footer (#13101). It used to be a grid bar that stayed until dismissed, and on
 * a machine that runs hot it came back every episode — too loud for a reading
 * Daintree didn't cause and can't fix.
 *
 * Tier-1 chrome: neutral glyph and secondary text, never an accent or a status
 * colour, no dismiss. It states what was measured and nothing else (#12462),
 * clears itself on recovery, and follows the footer's polarity — the reading on
 * the left, its controls on the right.
 *
 * Besides the diagnosis it offers to sleep idle background projects (#13223),
 * the one relief Daintree itself can give: their terminals stop and their
 * sessions keep for the reopen. Both sit behind one menu button (#13229): as
 * two text buttons they took most of the row and truncated the reading.
 */
export function SidebarMemoryNotice() {
  const notice = useSystemMemoryNoticeStore((s) => s.notice);
  if (!notice) return null;
  // Split so the project and stats subscriptions live only while a notice does.
  return <MemoryNoticeRow notice={notice} />;
}

function MemoryNoticeRow({ notice }: { notice: SystemMemoryNotice }) {
  const { action } = notice;
  const sleep = useSleepIdleProjects();
  const canSleep = sleep.idleProjects.length > 0;
  // A picked action runs once the menu has handed focus back to its trigger.
  // Run straight from the item, a confirmation or diagnostic panel that opens
  // during the menu's exit animation has its focus pulled back to the trigger,
  // and the confirmation captures no opener to return to on cancel.
  const pendingActionRef = useRef<(() => void) | null>(null);

  return (
    <div data-sidebar-memory-notice="" className="flex min-h-7 w-full shrink-0 items-stretch">
      <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-4 pr-2">
        <SidebarFooterGlyph>
          <MemoryStick className="h-3 w-3 text-text-secondary" aria-hidden="true" />
        </SidebarFooterGlyph>
        <TruncatedTooltip content={notice.detail} side="top" contentClassName="max-w-xs">
          <span
            role="status"
            aria-atomic="true"
            className="min-w-0 truncate text-2xs font-medium text-text-secondary"
          >
            {notice.reading}
          </span>
        </TruncatedTooltip>
      </div>
      {(canSleep || action) && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) pendingActionRef.current = null;
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-sidebar-memory-menu=""
                  aria-label="Memory actions"
                  className={ACTION_CLASS}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Memory actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            side="top"
            align="end"
            onCloseAutoFocus={() => {
              const run = pendingActionRef.current;
              pendingActionRef.current = null;
              // A microtask, so it lands after the restoration this event drives.
              if (run) queueMicrotask(run);
            }}
          >
            {action && (
              <DropdownMenuItem
                data-sidebar-memory-action=""
                aria-label={action.label}
                onSelect={() => {
                  pendingActionRef.current = () => void action.onClick();
                }}
              >
                Ask agent about memory
              </DropdownMenuItem>
            )}
            {canSleep && (
              <DropdownMenuItem
                data-sidebar-memory-sleep=""
                onSelect={() => {
                  pendingActionRef.current = () => void sleep.openPreview();
                }}
              >
                Sleep idle projects
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {sleep.preview && (
        <SleepIdleProjectsDialog
          projects={sleep.preview}
          isSleeping={sleep.isSleeping}
          onClose={sleep.closePreview}
          onConfirm={sleep.confirm}
        />
      )}
    </div>
  );
}

function SleepIdleProjectsDialog({
  projects,
  isSleeping,
  onClose,
  onConfirm,
}: {
  projects: IdleProject[];
  isSleeping: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const waitingAgentCount = projects.reduce((sum, p) => sum + p.waitingAgentCount, 0);
  const terminalCount = projects.reduce((sum, p) => sum + p.terminalCount, 0);
  const single = projects.length === 1;
  return (
    <ConfirmDialog
      isOpen={true}
      onClose={onClose}
      title={
        single
          ? `Sleep '${projects[0]!.name}'?`
          : `Sleep ${pluralize(projects.length, "idle project")}?`
      }
      confirmLabel={single ? "Sleep project" : "Sleep projects"}
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      isConfirmLoading={isSleeping}
      variant="default"
    >
      <div className="space-y-3">
        <ul data-sleep-idle-projects="" className="space-y-2">
          {projects.map((project) => (
            <li key={project.id}>
              <div className="text-sm font-medium">{project.name}</div>
              <div className="mt-1 font-mono text-xs text-text-secondary">{project.path}</div>
            </li>
          ))}
        </ul>
        <Callout
          severity="warning"
          title={single ? "Its terminals will be stopped" : "Their terminals will be stopped"}
        >
          {(terminalCount > 0 || waitingAgentCount > 0) && (
            <div>
              {terminalCount > 0 && <div>• {pluralize(terminalCount, "terminal")}</div>}
              {waitingAgentCount > 0 && (
                <div>• {pluralize(waitingAgentCount, "waiting agent")}</div>
              )}
            </div>
          )}
        </Callout>
        <div className="text-xs text-text-secondary">
          The layout, terminal scrollback, and agent sessions come back when you reopen{" "}
          {single ? "the project" : "each project"}.
        </div>
      </div>
    </ConfirmDialog>
  );
}
