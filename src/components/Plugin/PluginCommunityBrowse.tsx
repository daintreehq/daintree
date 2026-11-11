import { useId, useMemo, useState } from "react";
import { AlertTriangle, OctagonAlert, RefreshCw } from "lucide-react";
import type {
  BuiltInPluginCapability,
  PluginCatalogFailure,
  PluginCatalogListing,
} from "@shared/types/plugin";
import { describeCatalogRepo } from "@shared/utils/pluginInstallSource";
import { displaySafeText } from "@shared/utils/displaySafeText";
import { systemClient } from "@/clients/systemClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { pluralize } from "@/lib/pluralize";
import { CAPABILITY_META } from "./capabilityMeta";
import { usePluginCatalogBrowse } from "./usePluginCatalogBrowse";

/** What each listing is, and isn't: the catalog's review covers provenance, never safety. */
export const COMMUNITY_LISTING_NOTE =
  "Community listing, reviewed for its source and bytes. Not a Daintree endorsement, and not checked for safety.";

const UNAVAILABLE_COPY: Record<PluginCatalogFailure, { title: string; description: string }> = {
  "not-published": {
    title: "Check back for community plugins",
    description: "The community catalog isn't published yet. Your installed plugins aren't affected.",
  },
  unreachable: {
    title: "Connect to browse community plugins",
    description: "Couldn't reach the community catalog. Your installed plugins aren't affected.",
  },
  invalid: {
    title: "Try browsing again later",
    description: "The community catalog couldn't be read. Your installed plugins aren't affected.",
  },
};

/** A name this build knows gets its label; anything else is shown as written, never dropped. */
function capabilityMeta(name: string) {
  return Object.hasOwn(CAPABILITY_META, name)
    ? CAPABILITY_META[name as BuiltInPluginCapability]
    : undefined;
}

function matchesQuery(listing: PluginCatalogListing, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    listing.id,
    describeCatalogRepo(listing.repo),
    ...listing.capabilities,
    ...listing.capabilities.map((c) => capabilityMeta(c)?.label ?? ""),
  ]
    .join("\n")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function ListingCapabilities({ capabilities }: { capabilities: readonly string[] }) {
  if (capabilities.length === 0) {
    return <p className="text-2xs text-text-secondary">No capabilities declared</p>;
  }
  return (
    <ul aria-label="Capabilities" className="flex flex-wrap gap-1">
      {capabilities.map((name) => {
        const meta = capabilityMeta(name);
        // The risk tiers the install preview draws, at badge size.
        const glyph =
          meta?.severity === "danger" ? (
            <OctagonAlert aria-hidden="true" className="text-status-danger" />
          ) : meta?.severity === "warning" ? (
            <AlertTriangle aria-hidden="true" className="text-status-warning" />
          ) : null;
        return (
          <li key={name}>
            <Badge size="xs" title={meta ? `${meta.description} (${name})` : name}>
              {glyph}
              {meta ? meta.label : <span className="font-mono">{displaySafeText(name)}</span>}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function ListingCard({
  listing,
  installedVersion,
  installDisabled,
  onInstall,
  onViewInstalled,
}: {
  listing: PluginCatalogListing;
  installedVersion: string | undefined;
  installDisabled: boolean;
  onInstall: () => void;
  onViewInstalled: () => void;
}) {
  const idBase = useId();
  const installed = installedVersion !== undefined;
  return (
    <li aria-labelledby={`${idBase}-name`}>
      <Card padding="md" className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <span
              id={`${idBase}-name`}
              className="text-sm font-medium text-text-primary break-all"
            >
              {listing.id}
            </span>
            <span className="text-2xs text-text-secondary tabular-nums">v{listing.version}</span>
            {installed && (
              <Badge size="xs" data-testid="community-listing-installed">
                {installedVersion === listing.version
                  ? "Installed"
                  : `Installed v${installedVersion}`}
              </Badge>
            )}
          </div>
          <Button
            variant="link"
            onClick={() => void systemClient.openExternal(listing.repo)}
            className="whitespace-normal break-all text-left text-2xs"
            aria-label={`Open ${describeCatalogRepo(listing.repo)} in browser`}
          >
            {describeCatalogRepo(listing.repo)}
          </Button>
          <p className="text-2xs text-text-secondary">{COMMUNITY_LISTING_NOTE}</p>
          <ListingCapabilities capabilities={listing.capabilities} />
        </div>
        {installed ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onViewInstalled}
            aria-label={`View installed ${listing.id}`}
          >
            View installed
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onInstall}
            disabled={installDisabled}
            aria-label={`Install ${listing.id}`}
          >
            Install
          </Button>
        )}
      </Card>
    </li>
  );
}

function RetryButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} loading={loading}>
      <RefreshCw />
      Retry
    </Button>
  );
}

/**
 * The community catalog in the plugin manager's wide pane (#16782): each
 * plugin's newest reviewed release, searchable, with its repository, its
 * capabilities and what the listing does and doesn't vouch for. Install starts
 * the catalog route's preview; nothing installs from here directly.
 *
 * Mounting it is what reads the catalog, so only an open Browse view fetches.
 * A catalog that can't be read is this view's own empty state; the installed
 * list beside it never depends on it.
 */
export function PluginCommunityBrowse({
  installedVersions,
  installDisabled,
  onInstall,
  onViewInstalled,
}: {
  /** Installed plugins by id, with their versions. Project plugins aren't installs. */
  installedVersions: ReadonlyMap<string, string>;
  installDisabled: boolean;
  onInstall: (listing: PluginCatalogListing) => void;
  onViewInstalled: (pluginId: string) => void;
}) {
  const { answer, refreshing, retry } = usePluginCatalogBrowse();
  const [query, setQuery] = useState("");
  const tokens = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);

  const result = answer?.kind === "result" ? answer.result : null;
  const listings = result?.status === "available" ? result.listings : null;
  const visible = useMemo(
    () => (listings ? listings.filter((listing) => matchesQuery(listing, tokens)) : []),
    [listings, tokens]
  );

  const header = (
    <div>
      <h3 className="text-lg font-semibold text-text-primary">Community plugins</h3>
      <p className="text-sm text-text-secondary mt-1">
        Plugins listed in the community catalog. Each one runs with full access to your machine,
        so install only what you trust.
      </p>
    </div>
  );

  if (answer === null) {
    return (
      <div className="space-y-6">
        {header}
        <Skeleton label="Loading community plugins" className="space-y-3">
          {[0, 1, 2].map((i) => (
            <SkeletonBone key={i} className="h-28 rounded-[var(--radius-lg)]" />
          ))}
        </Skeleton>
      </div>
    );
  }

  if (listings === null) {
    // A call that failed outright (a host too old to answer) reads like a
    // catalog that couldn't be read; the hook logged why.
    const copy = UNAVAILABLE_COPY[result?.status === "unavailable" ? result.failure : "invalid"];
    return (
      <div className="space-y-6">
        {header}
        <div className="flex justify-center pt-8">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            title={copy.title}
            description={copy.description}
            action={<RetryButton onClick={retry} loading={refreshing} />}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      {result?.status === "available" && result.stale && (
        <Callout
          severity="warning"
          size="compact"
          action={<RetryButton onClick={retry} loading={refreshing} />}
        >
          <p>
            Showing the catalog from <TimeAgo timestamp={result.fetchedAt} verbose />. It
            couldn&apos;t be refreshed, so it may be out of date.
          </p>
        </Callout>
      )}
      {listings.length === 0 ? (
        <div className="flex justify-center pt-8">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            title="Check back for community plugins"
            description="The community catalog doesn't list any plugins yet."
          />
        </div>
      ) : (
        <>
          <SearchField
            size="compact"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            placeholder="Search community plugins…"
            aria-label="Search community plugins"
          />
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {tokens.length > 0
              ? pluralize(visible.length, "community plugin matches", "community plugins match")
              : ""}
          </p>
          {visible.length === 0 ? (
            <div className="flex justify-center pt-8">
              <EmptyState
                variant="filtered-empty"
                scale="canvas"
                title="Try another search"
                description="No community plugin matches. Clear the search to see them all."
                action={
                  <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                }
              />
            </div>
          ) : (
            <ul role="list" aria-label="Community plugins" className="space-y-3">
              {visible.map((listing) => (
                <ListingCard
                  key={listing.id}
                  listing={listing}
                  installedVersion={installedVersions.get(listing.id)}
                  installDisabled={installDisabled}
                  onInstall={() => onInstall(listing)}
                  onViewInstalled={() => onViewInstalled(listing.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
