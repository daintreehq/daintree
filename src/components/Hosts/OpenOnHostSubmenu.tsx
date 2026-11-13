import { Check, Server } from "lucide-react";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
import {
  ContextMenuItem,
  ContextMenuMeta,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { PlatformGlyph } from "./PlatformGlyph";
import { clientPlatform } from "./hostModel";
import { useOtherHosts, useProjectPresence, type OtherHost } from "./hostProjects";
import { isNewWindowClick } from "./hostSwitching";
import { openProjectOnHost } from "./openProjectOnHost";

function TargetItem({
  target,
  projectId,
  presence,
}: {
  target: OtherHost;
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
        void openProjectOnHost(target.hostId, projectId, isNewWindowClick(event), source);
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
  const supported = isRemoteShellSupported();
  const targets = useOtherHosts(clientPlatform());
  const presence = useProjectPresence(
    projectId,
    supported ? targets.filter((target) => target.reachable).map((target) => target.hostId) : []
  );
  if (!supported || targets.length === 0) return null;

  // No separator of its own: it sits among the row's other "open" items.
  return (
    <>
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
