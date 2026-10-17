import { useCallback, useEffect, useState } from "react";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import type { HostProjectSummary } from "@shared/types/ipc/remoteHosts";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { PathTail } from "@/components/ui/PathTail";
import { Button } from "@/components/ui/button";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { logWarn } from "@/utils/logger";
import { useHostList } from "@/components/Hosts/hostList";
import { clientPlatform, localHostLabel } from "@/components/Hosts/hostModel";
import { isNewWindowClick, switchToHost } from "@/components/Hosts/hostSwitching";
import { matchesTokens, queryTokens } from "@/components/Hosts/hostProjectSearch";
import { HostAddProjectDialog } from "@/components/Hosts/Overview/HostAddProjectDialog";

// Past this the list says how many it isn't showing; the rest stay a search away.
const MAX_RESULTS = 100;

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; projects: HostProjectSummary[] }
  | { status: "failed" };

function useHostName(hostId: HostId): string {
  const hostList = useHostList();
  if (hostId === LOCAL_HOST_ID) return localHostLabel(clientPlatform());
  return hostList.hosts.find((entry) => entry.descriptor.id === hostId)?.descriptor.name ?? hostId;
}

/**
 * A host's project list, for a switch to a host that had no project of this
 * machine's to return to. Picking a project switches the window to it there;
 * Cmd/Ctrl-click opens it in a new window instead.
 */
export function HostProjectPicker({ hostId, onClose }: { hostId: HostId; onClose: () => void }) {
  const hostName = useHostName(hostId);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // An empty host's way in: a folder already there, or a clone made there.
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electron.remoteHosts
      .listHostProjects({ hostId })
      .then((projects) => {
        if (!cancelled) setLoad({ status: "loaded", projects });
      })
      .catch((error: unknown) => {
        logWarn("[Hosts] Couldn't list a host's projects for the switch", { error });
        if (!cancelled) setLoad({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, attempt]);

  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  const projects = load.status === "loaded" ? load.projects : [];
  // The host's name counts as a field, as it does in the switcher's Other
  // hosts band, so a query naming project and host means the same in both.
  const filterProjects = useCallback(
    (items: HostProjectSummary[], query: string) => {
      const tokens = queryTokens(query);
      return items.filter((project) =>
        matchesTokens(tokens, [project.name, project.path, hostName])
      );
    },
    [hostName]
  );
  const {
    query,
    results,
    totalResults,
    selectedIndex,
    setQuery,
    selectPrevious,
    selectNext,
    setSelectedIndex,
  } = useSearchablePalette<HostProjectSummary>({
    items: projects,
    filterFn: filterProjects,
    maxResults: MAX_RESULTS,
    getItemId: (project) => project.id,
  });

  const open = useCallback(
    (project: HostProjectSummary, newWindow: boolean) => {
      onClose();
      void switchToHost(hostId, newWindow, project.id);
    },
    [hostId, onClose]
  );

  const handleConfirm = useCallback(
    (newWindow: boolean) => {
      const project = results[selectedIndex];
      if (project) open(project, newWindow);
      // A failed list has nothing to pick; Enter asks again.
      else if (load.status === "failed") retry();
    },
    [results, selectedIndex, open, load.status, retry]
  );

  const startAdding = useCallback(() => setAdding(true), []);

  const renderItem = useCallback(
    (
      project: HostProjectSummary,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => (
      <button
        key={project.id}
        id={`host-project-picker-${index}`}
        type="button"
        tabIndex={-1}
        role="option"
        aria-selected={isSelected}
        data-project-id={project.id}
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => onHoverIndex(index)}
        onClick={(event) => {
          setSelectedIndex(index);
          open(project, isNewWindowClick(event));
        }}
        className={cn(
          PALETTE_ROW_CLASS,
          "flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-left text-sm",
          "text-text-secondary hover:text-text-primary"
        )}
      >
        {project.emoji && (
          <span className="shrink-0 leading-none" aria-hidden="true">
            {project.emoji}
          </span>
        )}
        <span className="shrink-0 truncate font-medium text-text-primary max-w-[60%]">
          {project.name}
        </span>
        {/* The folder end is what tells two clones apart, so the start gives way. */}
        <PathTail className="ml-auto min-w-0 text-xs text-text-secondary">{project.path}</PathTail>
      </button>
    ),
    [open, setSelectedIndex]
  );

  const emptyMessage =
    load.status === "failed"
      ? `Couldn't list the projects on ${hostName}.`
      : `${hostName} has no projects yet.`;

  // Another window on the same empty host would only offer this list again.
  if (adding) {
    return (
      <HostAddProjectDialog
        hostId={hostId}
        hostName={hostName}
        // Backing out of adding one returns to the list it was offered from.
        onClose={() => setAdding(false)}
        onOpened={(result) => {
          onClose();
          void switchToHost(result.hostId, false, result.projectId);
        }}
      />
    );
  }

  return (
    <SearchablePalette<HostProjectSummary>
      tier="command"
      isOpen
      isLoading={load.status === "loading"}
      query={query}
      results={results}
      totalResults={totalResults}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={handleConfirm}
      onClose={onClose}
      onHoverIndex={setSelectedIndex}
      getItemId={(project) => project.id}
      renderItem={renderItem}
      label={`Projects on ${hostName}`}
      ariaLabel={`Open a project on ${hostName}`}
      searchPlaceholder={`Search projects on ${hostName}`}
      itemIdPrefix="host-project-picker"
      emptyMessage={emptyMessage}
      // A failure typed over is still a failure, not "no matches".
      noMatchMessage={load.status === "failed" ? emptyMessage : undefined}
      noMatchContent={
        load.status === "failed" ? (
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        ) : undefined
      }
      emptyContent={
        load.status === "failed" ? (
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        ) : load.status === "loaded" && projects.length === 0 ? (
          <Button size="sm" variant="outline" onClick={startAdding}>
            Add project on {hostName}…
          </Button>
        ) : undefined
      }
    />
  );
}
