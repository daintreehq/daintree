import { useId, useRef, type KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { SearchField } from "@/components/ui/SearchField";
import { Spinner } from "@/components/ui/Spinner";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { formatHostConnection, sshTargetOf } from "@shared/types/remoteHosts";
import type { DiscoveredHost, NetbirdPeerStatus } from "@shared/types/ipc/remoteHosts";

const SOURCE_LABEL: Record<DiscoveredHost["source"], string> = {
  tailscale: "Tailnet",
  netbird: "NetBird",
  bonjour: "Local network",
  manual: "Entered",
  wsl: "WSL",
};

/** NetBird's own word for a peer that isn't connected; a connected peer needs none. */
const NETBIRD_STATUS: Record<NetbirdPeerStatus, string | null> = {
  connected: null,
  connecting: "Connecting",
  idle: "Idle",
  disconnected: "Disconnected",
};

/** Only what discovery saw: NetBird never reports an OS, so its rows name none. */
function platformName(host: DiscoveredHost): string | null {
  return host.platform === "darwin" ? "macOS" : host.platform === "linux" ? "Linux" : null;
}

function membership(host: DiscoveredHost): string | null {
  if (host.alreadyAdded) return "Added";
  return host.knownMachine ? "Added as another account" : null;
}

const ROW_NAME = "add-host-machine";

interface AddHostDiscoveryProps {
  discovered: DiscoveredHost[] | null;
  error: string | null;
  /** The scan is still out past the loading gate: say so on the status line. */
  showLooking: boolean;
  /** A scan is running over a list already shown. */
  rescanning: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  /** Above this many machines the list gets a filter. */
  filterThreshold: number;
  matches: (host: DiscoveredHost, needle: string) => boolean;
  /** The SSH target the dialog will check; a row is chosen when it names it. */
  target: string;
  disabled: boolean;
  onPick: (host: DiscoveredHost) => void;
  onRescan: () => void;
  /** Enter in the filter with one pickable match left. */
  onPickOnlyMatch: (host: DiscoveredHost) => void;
  /** The filter mounts when results land; it takes the keyboard unless a target is being typed. */
  autoFocusFilter: boolean;
}

export function AddHostDiscovery({
  discovered,
  error,
  showLooking,
  rescanning,
  query,
  onQueryChange,
  filterThreshold,
  matches,
  target,
  disabled,
  onPick,
  onRescan,
  onPickOnlyMatch,
  autoFocusFilter,
}: AddHostDiscoveryProps) {
  const headingId = useId();
  const lookAgainRef = useRef<HTMLButtonElement>(null);
  const scanning = rescanning || (discovered === null && error === null);
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  // A query in play keeps its field, so a rescan that shrinks the list can't strand it unclearable.
  const filterable = discovered !== null && (discovered.length > filterThreshold || trimmed !== "");
  const shown =
    discovered === null
      ? []
      : needle
        ? discovered.filter((host) => matches(host, needle))
        : discovered;
  // Two rows can share a name when two networks each see one; the source tells them apart.
  const nameCounts = new Map<string, number>();
  for (const host of shown) {
    const key = host.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const only = shown.length === 1 ? shown[0]! : null;
    if (!only || only.alreadyAdded || disabled) return;
    event.preventDefault();
    onPickOnlyMatch(only);
  };

  const count =
    discovered === null || discovered.length === 0
      ? null
      : trimmed
        ? `${shown.length} of ${discovered.length}`
        : pluralize(discovered.length, "machine");

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex min-h-7 items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-medium text-text-primary">
          Machines on your networks
          {count && <span className="ml-2 font-normal text-text-secondary">{count}</span>}
        </h3>
        {(discovered !== null || error !== null || rescanning) && (
          <Button
            ref={lookAgainRef}
            variant="outline"
            size="sm"
            onClick={onRescan}
            loading={rescanning}
            disabled={disabled}
          >
            {!rescanning && <RefreshCw aria-hidden="true" />}
            Look again
          </Button>
        )}
      </div>
      {filterable && (
        <SearchField
          fieldClassName="mb-2"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onClear={() => onQueryChange("")}
          onKeyDown={onFilterKeyDown}
          autoFocus={autoFocusFilter}
          placeholder="Filter by name or address"
          aria-label="Filter machines"
          spellCheck={false}
          autoCapitalize="off"
        />
      )}
      {error !== null && (
        <Callout
          severity="error"
          role="alert"
          className="mb-2"
          title="Couldn't look for machines"
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => {
                onRescan();
                // Retry goes with the error it answers; the keyboard carries on from
                // Look again, which stays through the scan and answers the next one.
                requestAnimationFrame(() => lookAgainRef.current?.focus());
              }}
            >
              <RefreshCw aria-hidden="true" />
              Retry
            </Button>
          }
        >
          <p className="select-text">{error}</p>
        </Callout>
      )}
      {discovered === null ? (
        error === null && (
          // Holds its line from the start, so nothing jumps when it shows.
          <p
            className={cn(
              "flex min-h-8 items-center gap-2 text-sm text-text-secondary",
              !showLooking && "invisible"
            )}
            aria-hidden={!showLooking}
          >
            <Spinner size="sm" /> Looking for Macs and Linux machines
          </p>
        )
      ) : discovered.length === 0 ? (
        <p className="text-sm text-text-secondary">
          Nothing answered on your tailnet, NetBird or local network. Enter an SSH target above, or
          look again once the machine is awake.
        </p>
      ) : shown.length === 0 ? (
        <p role="status" className="text-sm text-text-secondary">
          No machines match &quot;{trimmed}&quot;. Enter its SSH target above if it isn&apos;t
          listed.
        </p>
      ) : (
        <ScrollShadow
          compact
          // Four and a half rows: the half row says there's more below.
          className="max-h-[15rem] rounded-[var(--radius-lg)] border border-border-default"
        >
          <div
            role="radiogroup"
            aria-labelledby={headingId}
            className="divide-y divide-border-subtle"
            data-testid="add-host-discovered"
          >
            {shown.map((host, index) => {
              const rowId = `${headingId}-${index}`;
              const address = sshTargetOf(host.connection) ?? "";
              const checked = target === address;
              const platform = platformName(host);
              const member = membership(host);
              const status = host.netbirdStatus ? NETBIRD_STATUS[host.netbirdStatus] : null;
              const source = SOURCE_LABEL[host.source];
              const shared = (nameCounts.get(host.name.toLowerCase()) ?? 0) > 1;
              const unavailable = host.alreadyAdded || disabled;
              return (
                <label
                  key={`${host.source}:${formatHostConnection(host.connection)}`}
                  data-known-machine={host.knownMachine && !host.alreadyAdded ? "" : undefined}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 transition-colors duration-150",
                    "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
                    host.alreadyAdded ? "cursor-default" : "cursor-pointer",
                    checked ? "bg-overlay-selected" : !unavailable && "hover:bg-overlay-soft"
                  )}
                >
                  <input
                    type="radio"
                    name={ROW_NAME}
                    value={address}
                    checked={checked}
                    disabled={unavailable}
                    onChange={() => onPick(host)}
                    aria-label={shared ? `${host.name}, ${source}` : host.name}
                    aria-describedby={`${rowId}-address ${rowId}-route`}
                    // The row draws the focus ring; the control's own is neutralised the way RadioChoice does it.
                    className="shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-transparent"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm font-medium",
                        host.alreadyAdded ? "text-text-secondary" : "text-text-primary"
                      )}
                    >
                      {host.name}
                    </span>
                    <span
                      id={`${rowId}-address`}
                      className="block truncate text-xs text-text-secondary select-text"
                    >
                      {address}
                      {platform && ` · ${platform}`}
                    </span>
                  </span>
                  <span
                    id={`${rowId}-route`}
                    className="shrink-0 text-right text-xs text-text-secondary"
                  >
                    <span className="block">{source}</span>
                    {(member ?? status) && (
                      <span className={cn("block", member && "text-text-primary")}>
                        {[member, status].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </ScrollShadow>
      )}
      {/* No role: the filter's no-match line stays the dialog's one status. Every scan
          says it started, so its result is heard even when the count hasn't changed. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {scanning
          ? "Looking for machines"
          : discovered === null
            ? ""
            : discovered.length === 0
              ? "No machines found"
              : `${pluralize(discovered.length, "machine")} found`}
      </p>
    </section>
  );
}
