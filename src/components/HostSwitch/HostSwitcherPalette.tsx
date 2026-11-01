import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_HOST_ID, type HostRecentUse } from "@shared/types/remoteHosts";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { isMac } from "@/lib/platform";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { deferPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";
import { useHostMetricsStore, type HostMetricsHistory } from "@/store/hostMetricsStore";
import { getViewHostId } from "@/hooks/useHostConnection";
import { useHostFigures } from "@/components/Hosts/hostList";
import {
  buildHostMenuRows,
  clientPlatform,
  hostLinkTone,
  orderHostRowsByRecency,
  type HostMenuRow,
} from "@/components/Hosts/hostModel";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import { logWarn } from "@/utils/logger";
import { HostSwitcherHeader, HostSwitcherRow } from "./HostSwitcherRow";

export const HOST_SWITCHER_PALETTE_ID: PaletteId = "host-switcher";

const FUSE_OPTIONS = { keys: ["name"], threshold: 0.4, ignoreLocation: true };

// This machine plus the host list's 64: every host stays reachable by arrow keys.
const MAX_ROWS = 65;

const NO_HISTORY: HostMetricsHistory = new Map();

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
        label: isStayingPut(row)
          ? "to stay here"
          : row.isCurrent
            ? "to reconnect"
            : hostLinkTone(row) === "offline"
              ? "to connect and switch"
              : "to switch",
      }}
      hints={[{ keys: [isMac() ? "⌘" : "Ctrl", "↵"], label: "in a new window" }]}
    />
  );
}

const EMPTY_HISTORY: readonly never[] = [];
const EMPTY_ROWS: HostMenuRow[] = [];

/**
 * Read once per opening, so the order never moves under the cursor. Null
 * until the answer is in; a failed read orders by what the list knows.
 */
function useRecentHosts(isOpen: boolean): readonly HostRecentUse[] | null {
  const [recents, setRecents] = useState<readonly HostRecentUse[] | null>(null);
  useEffect(() => {
    if (!isOpen) {
      setRecents(null);
      return;
    }
    let live = true;
    const settle = (entries: readonly HostRecentUse[]) => {
      if (live) setRecents(entries);
    };
    const api = window.electron?.remoteHosts;
    if (!api?.listRecent) {
      settle([]);
    } else {
      api
        .listRecent()
        .then((entries) => settle(entries ?? []))
        .catch((error: unknown) => {
          logWarn("[Hosts] Couldn't read recent hosts", { error });
          settle([]);
        });
    }
    return () => {
      live = false;
    };
  }, [isOpen]);
  return recents;
}

/**
 * "Switch host…" (#13268): every host this machine can drive, the window's own
 * first and the rest by when a window here last landed on them. Live hosts
 * show what their agents were observed doing and their load in columns; hosts
 * with no link say what the link last saw instead. Picking a host moves this
 * window there; Cmd/Ctrl-click opens it in a new window instead.
 */
export function HostSwitcherPalette() {
  const isOpen = usePaletteStore((s) => s.activePaletteId === HOST_SWITCHER_PALETTE_ID);
  // Load, round trips and sparklines are followed only while the switcher is
  // open: closed, it stays mounted and must not wake for each of them.
  const hostList = useHostFigures(isOpen);
  const currentHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const recents = useRecentHosts(isOpen);
  const history = useHostMetricsStore((s) => (isOpen ? s.history : NO_HISTORY));

  // Every input to the order is fixed for an opening (the recency read, the
  // window's host, names), so rows update in place and never move.
  const rows = useMemo(
    () =>
      orderHostRowsByRecency(
        buildHostMenuRows(hostList.hosts, {
          localPlatform: clientPlatform(),
          currentHostId,
          localSummary: hostList.localSummary,
        }),
        recents ?? []
      ),
    [hostList, currentHostId, recents]
  );
  // Nothing listed until the order is known: a frame of the old order would
  // show a row jumping as soon as the read lands.
  const ordered = recents === null ? EMPTY_ROWS : rows;

  // Rendered "now" for last-seen times: per opening, not per frame.
  const now = useMemo(() => (isOpen ? Date.now() : 0), [isOpen]);

  const palette = useSearchablePalette<HostMenuRow>({
    items: ordered,
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
    // Nor before the recency read lands, which would reorder the rows under it.
    if (placedForOpening.current || query !== "" || recents === null) return;
    // Not settled until another host is listed: opened before the host list
    // arrives, the only row is this one.
    const firstElsewhere = results.findIndex((row) => !row.isCurrent);
    if (firstElsewhere < 0) return;
    placedForOpening.current = true;
    setSelectedIndex(firstElsewhere);
  }, [isOpen, query, results, recents, setSelectedIndex]);

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

  const pickAt = useCallback(
    (index: number, newWindow: boolean) => {
      const row = results[index];
      if (!row) return;
      setSelectedIndex(index);
      pick(row, newWindow);
    },
    [results, pick, setSelectedIndex]
  );

  const renderItem = useCallback(
    (
      row: HostMenuRow,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => {
      const summary = hostLinkTone(row) === "live" ? (row.summary ?? null) : null;
      return (
        <HostSwitcherRow
          key={row.hostId}
          row={row}
          summary={summary}
          history={history.get(row.hostId) ?? EMPTY_HISTORY}
          index={index}
          isSelected={isSelected}
          onHover={onHoverIndex}
          onPick={pickAt}
          now={now}
        />
      );
    },
    [history, pickAt, now]
  );

  return (
    <SearchablePalette<HostMenuRow>
      tier="overview"
      isLoading={recents === null}
      isOpen={isOpen}
      query={query}
      results={results}
      totalResults={palette.totalResults}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={() => {
        // Before the rows arrive there is nothing to move to; placement still owed.
        if (recents !== null) placedForOpening.current = true;
        palette.selectPrevious();
      }}
      onSelectNext={() => {
        // Before the rows arrive there is nothing to move to; placement still owed.
        if (recents !== null) placedForOpening.current = true;
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
      beforeList={results.length > 0 ? <HostSwitcherHeader /> : undefined}
      label="Switch host"
      ariaLabel="Switch host"
      searchPlaceholder="Search hosts"
      itemIdPrefix="host-switcher"
      emptyMessage="No hosts match"
    />
  );
}
