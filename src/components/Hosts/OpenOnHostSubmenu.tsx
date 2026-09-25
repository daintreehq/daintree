import { Check, Server } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuMeta,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { notify } from "@/lib/notify";
import { useMenuActionSource, type MenuActionSourceValue } from "@/components/ui/menu-source";
import { logWarn } from "@/utils/logger";
import { actionService } from "@/services/ActionService";
import { PlatformGlyph } from "./PlatformGlyph";
import { clientPlatform } from "./hostModel";
import { findSameNamedProject, useOtherHostTargets, type OtherHostTarget } from "./hostProjects";
import { isNewWindowClick, switchToHost } from "./hostSwitching";

/** Opens the switch dialog, which shows what the host has and offers the clone. */
async function openByCloning(
  hostId: string,
  projectId: string,
  source: MenuActionSourceValue
): Promise<void> {
  const result = await actionService.dispatch(
    "project.openOnHost",
    { hostId, projectId },
    { source }
  );
  if (result.ok) return;
  logWarn("[Hosts] Opening a project on another host failed", { error: result.error });
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    context: { eventKind: "connectivity" },
    title: "Couldn't open project on host",
    message: "The host switch dialog couldn't open. Try again from the host menu.",
  });
}

function TargetItem({
  target,
  projectId,
  projectName,
}: {
  target: OtherHostTarget;
  projectId: string;
  projectName: string;
}) {
  const existing = findSameNamedProject(target, projectName);
  const source = useMenuActionSource();
  return (
    <ContextMenuItem
      disabled={!target.reachable}
      data-host-id={target.hostId}
      aria-label={
        !target.reachable
          ? `${target.name}, not connected`
          : existing
            ? `${target.name}, has a project named ${existing.name}`
            : `${target.name}, clone`
      }
      onClick={(event) => {
        if (existing) {
          void switchToHost(target.hostId, isNewWindowClick(event), existing.id);
          return;
        }
        void openByCloning(target.hostId, projectId, source);
      }}
    >
      <span className="mr-2 flex w-3.5 shrink-0 justify-center text-text-secondary">
        <PlatformGlyph platform={target.platform} />
      </span>
      <span className="truncate">{target.name}</span>
      <ContextMenuMeta>
        {!target.reachable ? (
          "not connected"
        ) : existing ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          "clone"
        )}
      </ContextMenuMeta>
    </ContextMenuItem>
  );
}

/**
 * "Open on…" for a project row: every other host, marked where the host lists
 * a project of the same name, "clone" everywhere else. Renders nothing for
 * anyone with no remote host.
 */
export function OpenOnHostSubmenu({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const supported = isRemoteHostsSupported();
  const targets = useOtherHostTargets(clientPlatform());
  if (!supported || targets.length === 0) return null;

  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Server className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          Open on…
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-48">
          {targets.map((target) => (
            <TargetItem
              key={target.hostId}
              target={target}
              projectId={projectId}
              projectName={projectName}
            />
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
