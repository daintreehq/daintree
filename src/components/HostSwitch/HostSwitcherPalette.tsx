import { useCallback, useEffect, useMemo, useRef } from "react";
import { Check } from "lucide-react";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { isMac } from "@/lib/platform";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { deferPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
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

/** Picking the host this window is on only moves anything while its link is down. */
function isStayingPut(row: HostMenuRow): boolean {
  return row.isCurrent && (row.isLocal || row.connection?.status === "connected");
}

function footerFor(row: HostMenuRow | null) {
  if (!row) return null;
  return (
    <PaletteFooterHints
      primaryHint={{
        keys: ["↵"],
        label: isStayingPut(row) ? "to stay here" : row.isCurrent ? "to reconnect" : "to switch",
      }}
      hints={[{ keys: [isMac() ? "⌘" : "Ctrl", "↵"], label: "in a new window" }]}
    />
  );
}

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

  // Opens on the first host that isn't this one, as the project switcher opens
  // on the first project that isn't current: Enter straight away goes
  // somewhere rather than home. Once per opening, so a metrics update never
  // takes the cursor back from the user.
  const placedForOpening = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      placedForOpening.current = false;
      return;
    }
    // Placed already, or the user moved first: a host arriving late must not take the cursor.
    if (placedForOpening.current || query !== "") return;
    // Not settled until another host is listed: opened before the host list
    // arrives, the only row is this one.
    const firstElsewhere = results.findIndex((row) => !row.isCurrent);
    if (firstElsewhere < 0) return;
    placedForOpening.current = true;
    setSelectedIndex(firstElsewhere);
  }, [isOpen, query, results, setSelectedIndex]);

  const pick = useCallback(
    (row: HostMenuRow, newWindow: boolean) => {
      // Already here: nothing to move, and the keyboard goes back where it was.
      // A current host whose link is down is picked to bring it back.
      if (isStayingPut(row) && !newWindow) {
        close();
        return;
      }
      // A switch that lands hands the keyboard on (to the host's view, or to
      // its project list when it has nothing to return to), so focus isn't
      // put back on close. One that fails or is cancelled leaves this window
      // where it was, and the keyboard goes back to where it was too.
      let restore: (() => void) | null = null;
      let stayed = false;
      deferPaletteFocusRestore((restoreFocus) => {
        if (stayed) restoreFocus();
        else restore = restoreFocus;
      });
      close();
      void switchToHost(row.hostId, newWindow, undefined, {
        onStayed: () => {
          stayed = true;
          restore?.();
        },
      });
    },
    [close]
  );

  const handleConfirm = useCallback(
    (newWindow: boolean) => {
      const row = results[selectedIndex];
      if (row) pick(row, newWindow);
    },
    [results, selectedIndex, pick]
  );

  const renderItem = useCallback(
    (
      row: HostMenuRow,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => {
      const status = describeHostRowStatus(row);
      // The status line leads with the link's state when it isn't up; saying
      // it again beside the name only repeats it.
      const menuState = describeHostMenuState(row).state;
      const state = menuState && !status?.startsWith(menuState) ? menuState : null;
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
      onSelectPrevious={() => {
        placedForOpening.current = true;
        palette.selectPrevious();
      }}
      onSelectNext={() => {
        placedForOpening.current = true;
        palette.selectNext();
      }}
      onConfirm={handleConfirm}
      onClose={close}
      onHoverIndex={(index) => {
        placedForOpening.current = true;
        setSelectedIndex(index);
      }}
      getItemId={getRowId}
      renderItem={renderItem}
      getFooter={footerFor}
      label="Switch host"
      ariaLabel="Switch host"
      searchPlaceholder="Search hosts"
      itemIdPrefix="host-switcher"
      emptyMessage="No hosts match"
    />
  );
}
