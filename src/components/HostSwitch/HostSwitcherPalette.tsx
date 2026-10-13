import { useCallback, useEffect, useMemo } from "react";
import { Check } from "lucide-react";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { suppressPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";
import { getViewHostId } from "@/hooks/useHostConnection";
import { useHostList } from "@/components/Hosts/hostList";
import { PlatformGlyph } from "@/components/Hosts/PlatformGlyph";
import {
  buildHostMenuRows,
  clientPlatform,
  describeHostMenuState,
  describeHostRowMetrics,
  describeHostRowStatus,
  type HostMenuRow,
} from "@/components/Hosts/hostModel";
import { isNewWindowClick, switchToHost } from "@/components/Hosts/hostSwitching";

export const HOST_SWITCHER_PALETTE_ID: PaletteId = "host-switcher";

const FUSE_OPTIONS = { keys: ["name"], threshold: 0.4, ignoreLocation: true };

// This machine plus the host list's 64: every host stays reachable by arrow keys.
const MAX_ROWS = 65;

const getRowId = (row: HostMenuRow) => row.hostId;

/**
 * "Switch host…" (#13268): every host as a searchable list, each row saying a
 * little more than the chip's menu does — the link's state (or when an
 * unreachable host was last seen), its project count, what its agents were
 * observed doing, and rough load. Sparklines, forwards and versions stay in
 * the hosts overview. Picking a host moves this window there; Cmd/Ctrl-click
 * opens it in a new window instead.
 */
export function HostSwitcherPalette() {
  const isOpen = usePaletteStore((s) => s.activePaletteId === HOST_SWITCHER_PALETTE_ID);
  const hostList = useHostList();
  const currentHostId = getViewHostId() ?? LOCAL_HOST_ID;

  const rows = useMemo(
    () =>
      buildHostMenuRows(hostList.hosts, {
        localPlatform: clientPlatform(),
        currentHostId,
        localSummary: hostList.localSummary,
      }),
    [hostList, currentHostId]
  );

  const palette = useSearchablePalette<HostMenuRow>({
    items: rows,
    fuseOptions: FUSE_OPTIONS,
    paletteId: HOST_SWITCHER_PALETTE_ID,
    getItemId: getRowId,
    maxResults: MAX_ROWS,
    deferFiltering: false,
  });
  const { query, results, selectedIndex, setQuery, setSelectedIndex, close } = palette;

  useEffect(() => {
    if (isOpen) setQuery("");
  }, [isOpen, setQuery]);

  const pick = useCallback(
    (row: HostMenuRow, newWindow: boolean) => {
      // Already here: nothing to move, and the keyboard goes back where it was.
      if (row.isCurrent && !newWindow) {
        close();
        return;
      }
      // The switch hands the keyboard on (to the host's view, or to its
      // project list when it has nothing to return to); restoring focus from
      // the exit animation would take it back a beat later.
      suppressPaletteFocusRestore();
      close();
      void switchToHost(row.hostId, newWindow);
    },
    [close]
  );

  const handleConfirm = useCallback(() => {
    const row = results[selectedIndex];
    if (row) pick(row, false);
  }, [results, selectedIndex, pick]);

  const renderItem = useCallback(
    (
      row: HostMenuRow,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => {
      const { state } = describeHostMenuState(row);
      const status = describeHostRowStatus(row);
      const metrics = describeHostRowMetrics(row);
      return (
        <button
          key={row.hostId}
          id={`host-switcher-${row.hostId}`}
          type="button"
          tabIndex={-1}
          role="option"
          aria-selected={isSelected}
          aria-current={row.isCurrent ? "true" : undefined}
          data-host-id={row.hostId}
          onPointerDown={(event) => event.preventDefault()}
          onPointerMove={() => onHoverIndex(index)}
          onClick={(event) => {
            setSelectedIndex(index);
            pick(row, isNewWindowClick(event));
          }}
          className={cn(
            PALETTE_ROW_CLASS,
            "flex w-full min-w-0 items-start gap-2 rounded-[var(--radius-md)] px-3 py-2 text-left",
            "text-text-secondary"
          )}
        >
          <span className="flex h-5 w-3.5 shrink-0 items-center" aria-hidden="true">
            {row.isCurrent && <Check className="h-3.5 w-3.5 text-text-secondary" />}
          </span>
          <span className="flex h-5 shrink-0 items-center text-text-secondary">
            <PlatformGlyph platform={row.platform} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-3">
              <span className="min-w-0 truncate text-sm font-medium text-text-primary">
                {row.name}
              </span>
              {state && <span className="ml-auto shrink-0 text-xs">{state}</span>}
            </span>
            {(status || metrics) && (
              <span className="flex min-w-0 items-baseline gap-3 text-xs">
                {status && <span className="min-w-0 truncate">{status}</span>}
                {metrics && (
                  <span className="ml-auto shrink-0 whitespace-pre tabular-nums">{metrics}</span>
                )}
              </span>
            )}
          </span>
        </button>
      );
    },
    [pick, setSelectedIndex]
  );

  return (
    <SearchablePalette<HostMenuRow>
      tier="command"
      isOpen={isOpen}
      query={query}
      results={results}
      totalResults={palette.totalResults}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={palette.selectPrevious}
      onSelectNext={palette.selectNext}
      onConfirm={handleConfirm}
      onClose={close}
      onHoverIndex={setSelectedIndex}
      getItemId={getRowId}
      renderItem={renderItem}
      label="Switch host"
      ariaLabel="Switch host"
      searchPlaceholder="Search hosts"
      itemIdPrefix="host-switcher"
      emptyMessage="No hosts match"
    />
  );
}
