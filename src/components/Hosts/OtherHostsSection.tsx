import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { cn } from "@/lib/utils";
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

/**
 * The project switcher's "Other hosts" band: the projects of every other
 * connected host, grouped by host. Choosing one switches the window to that
 * host and project together. Renders nothing for anyone with no remote host,
 * or when no other host has listed anything.
 */
export function OtherHostsSection({ query, onChosen }: { query: string; onChosen: () => void }) {
  const supported = isRemoteHostsSupported();
  const targets = useOtherHostTargets(clientPlatform());
  if (!supported) return null;

  const trimmed = query.trim();
  const groups = targets
    .map((target) => ({
      target,
      projects: (target.projects ?? []).filter((p) => matchesQuery(p, trimmed)),
    }))
    .filter((group) => group.projects.length > 0);
  if (groups.length === 0) return null;

  return (
    <section
      className="px-1 py-1 border-t border-border-divider"
      aria-labelledby="project-switcher-other-hosts"
      data-testid="project-switcher-other-hosts"
    >
      <h3
        id="project-switcher-other-hosts"
        className="px-2.5 py-1.5 text-2xs font-bold tracking-wider uppercase text-text-secondary"
      >
        Other hosts
      </h3>
      {groups.map(({ target, projects }) => (
        <div key={target.hostId} role="group" aria-label={target.name}>
          <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-0.5 text-2xs text-text-secondary">
            <PlatformGlyph platform={target.platform} size={10} />
            <span className="truncate">{target.name}</span>
          </div>
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              data-host-id={target.hostId}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-sm",
                "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px]"
              )}
              aria-label={`${project.name} on ${target.name}`}
              onClick={(event) => {
                onChosen();
                void switchToHost(target.hostId, isNewWindowClick(event), project.id);
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
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}
