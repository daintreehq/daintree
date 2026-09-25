import type { HostId, HostPlatform } from "@shared/types/remoteHosts";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { PlatformGlyph } from "./PlatformGlyph";
import { clientPlatform } from "./hostModel";
import { useOtherHostTargets, type HostProjectRef } from "./hostProjects";
import { isNewWindowClick, switchToHost } from "./hostSwitching";

function matchesQuery(project: HostProjectRef, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLocaleLowerCase();
  return (
    project.name.toLocaleLowerCase().includes(needle) ||
    project.path.toLocaleLowerCase().includes(needle)
  );
}

/** One project another host lists, as a row of the switcher. */
export interface OtherHostProjectOption {
  hostId: HostId;
  hostName: string;
  platform: HostPlatform | null;
  project: HostProjectRef;
}

/** The listbox the other-host rows live in, named by the switcher input's `aria-controls`. */
export const OTHER_HOSTS_LIST_ID = "project-switcher-other-hosts-list";

export function otherHostOptionId(index: number): string {
  return `project-other-host-option-${index}`;
}

/**
 * The other-host projects matching `query`, flat and in the order they are
 * drawn: the switcher's arrow keys walk them as the tail of its results.
 * Empty for anyone with no remote host, or where Remote Hosts doesn't exist.
 */
export function useOtherHostProjectOptions(query: string): OtherHostProjectOption[] {
  const supported = isRemoteHostsSupported();
  const targets = useOtherHostTargets(clientPlatform());
  if (!supported) return [];
  const trimmed = query.trim();
  return targets.flatMap((target) =>
    (target.projects ?? [])
      .filter((project) => matchesQuery(project, trimmed))
      .map((project) => ({
        hostId: target.hostId,
        hostName: target.name,
        platform: target.platform,
        project,
      }))
  );
}

/** Switch the window (or a new one) to the option's host and project together. */
export function openOtherHostProject(option: OtherHostProjectOption, newWindow: boolean): void {
  void switchToHost(option.hostId, newWindow, option.project.id);
}

/**
 * The project switcher's "Other hosts" band: the projects of every other
 * connected host, grouped by host. Choosing one switches the window to that
 * host and project together. Its rows take part in the switcher's roving
 * selection rather than the tab order, the same as every other result, so
 * `activeIndex` is the switcher's cursor when it sits in this band. Renders
 * nothing when there are no options.
 */
export function OtherHostsSection({
  options,
  activeIndex,
  onChosen,
}: {
  options: OtherHostProjectOption[];
  activeIndex: number | null;
  onChosen: () => void;
}) {
  if (options.length === 0) return null;

  const groups: Array<{ first: number; items: OtherHostProjectOption[] }> = [];
  options.forEach((option, index) => {
    const last = groups[groups.length - 1];
    if (last && last.items[0]!.hostId === option.hostId) last.items.push(option);
    else groups.push({ first: index, items: [option] });
  });

  return (
    <section
      className="px-1 py-1 border-t border-border-divider"
      data-testid="project-switcher-other-hosts"
    >
      <h3
        id="project-switcher-other-hosts"
        className="px-2.5 py-1.5 text-2xs font-bold tracking-wider uppercase text-text-secondary"
      >
        Other hosts
      </h3>
      <div id={OTHER_HOSTS_LIST_ID} role="listbox" aria-labelledby="project-switcher-other-hosts">
        {groups.map(({ first, items }) => {
          const target = items[0]!;
          return (
            <div key={target.hostId} role="group" aria-label={target.hostName}>
              <div
                className="flex items-center gap-1.5 px-2.5 pt-1 pb-0.5 text-2xs text-text-secondary"
                aria-hidden="true"
              >
                <PlatformGlyph platform={target.platform} size={10} />
                <span className="truncate">{target.hostName}</span>
              </div>
              {items.map((option, offset) => {
                const index = first + offset;
                const project = option.project;
                return (
                  <div
                    key={project.id}
                    id={otherHostOptionId(index)}
                    role="option"
                    aria-selected={index === activeIndex}
                    data-host-id={option.hostId}
                    className={cn(
                      PALETTE_ROW_CLASS,
                      "flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-sm cursor-pointer",
                      "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary"
                    )}
                    aria-label={`${project.name} on ${option.hostName}`}
                    onClick={(event) => {
                      onChosen();
                      openOtherHostProject(option, isNewWindowClick(event));
                    }}
                  >
                    {project.emoji && (
                      <span className="shrink-0 leading-none" aria-hidden="true">
                        {project.emoji}
                      </span>
                    )}
                    <span className="truncate font-medium">{project.name}</span>
                    <span className="ml-auto min-w-0 truncate text-2xs text-text-secondary">
                      {project.path}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
