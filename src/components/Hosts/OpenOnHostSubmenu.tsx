import { Check, Server } from "lucide-react";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
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
import { useOtherHostTargets, useProjectPresence, type OtherHostTarget } from "./hostProjects";
import { isNewWindowClick } from "./hostSwitching";

/**
 * Opens the switch dialog, which matches the project on the host by its
 * remotes, checks the branch fresh, and offers its worktree or the clone.
 */
async function openOnHost(
  hostId: string,
  projectId: string,
  newWindow: boolean,
  source: MenuActionSourceValue
): Promise<void> {
  const result = await actionService.dispatch(
    "project.openOnHost",
    { hostId, projectId, newWindow },
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
  presence,
}: {
  target: OtherHostTarget;
  projectId: string;
  /** Undefined while the host is being asked. */
  presence: HostProjectPresence | undefined;
}) {
  const source = useMenuActionSource();
  const has = (presence?.projects?.length ?? 0) > 0;
  const unknown = presence !== undefined && presence.projects === null;
  return (
    <ContextMenuItem
      disabled={!target.reachable}
      data-host-id={target.hostId}
      data-presence={!presence ? "asking" : unknown ? "unknown" : has ? "has" : "clone"}
      aria-label={
        !target.reachable
          ? `${target.name}, not connected`
          : has
            ? `${target.name}, has this repository`
            : presence && !unknown
              ? `${target.name}, clone`
              : target.name
      }
      onClick={(event) => {
        void openOnHost(target.hostId, projectId, isNewWindowClick(event), source);
      }}
    >
      <span className="mr-2 flex w-3.5 shrink-0 justify-center text-text-secondary">
        <PlatformGlyph platform={target.platform} />
      </span>
      <span className="truncate">{target.name}</span>
      <ContextMenuMeta>
        {!target.reachable ? (
          "not connected"
        ) : has ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : presence && !unknown ? (
          "clone"
        ) : null}
      </ContextMenuMeta>
    </ContextMenuItem>
  );
}

/**
 * "Open on…" for a project row: every other host, marked where the host has
 * a registered project sharing a remote with this one (the same repository,
 * whatever it is called there), "clone" where it has none. Every choice goes
 * through the switch dialog. Renders nothing for anyone with no remote host.
 */
export function OpenOnHostSubmenu({ projectId }: { projectId: string }) {
  const supported = isRemoteHostsSupported();
  const targets = useOtherHostTargets(clientPlatform());
  const presence = useProjectPresence(
    projectId,
    supported ? targets.filter((target) => target.reachable).map((target) => target.hostId) : []
  );
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
              presence={presence.get(target.hostId)}
            />
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
