import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AgentCliCopy } from "@shared/types/ipc/system";
import { cliAvailabilityClient } from "@/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import { logError } from "@/utils/logger";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";

function versionText(version: string | null | undefined, showChecking: boolean): string | null {
  if (version === undefined) return showChecking ? "Checking version…" : null;
  return version === null ? "No version reported" : `Reports ${version}`;
}

export function AgentCliCopiesSection({
  agentId,
  launchPath,
  isActive,
  isRefreshing,
  onRefresh,
}: {
  agentId: string;
  /** The path launches start: `undefined` until detection details are in, `null` if there is none. */
  launchPath: string | null | undefined;
  /** Reading the copies runs each of them, so only while this page is on screen. */
  isActive: boolean;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [loaded, setLoaded] = useState<{
    copies: AgentCliCopy[];
    launchPath: string | null | undefined;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const latestRequest = useRef(0);
  // Copies are read where the agents run, so a remote window names that host.
  const remoteHostName = useRemoteHostName();
  const showChecking = useDeferredLoading(isLoading, UI_INLINE_LOADING_GATE_MS);

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    setIsLoading(true);
    try {
      const copies = await cliAvailabilityClient.getCopies(agentId);
      if (request !== latestRequest.current) return;
      setLoaded({ copies, launchPath });
      setFailed(false);
    } catch (error) {
      if (request !== latestRequest.current) return;
      logError("[AgentCliCopiesSection] Failed to read CLI copies", error);
      setFailed(true);
    } finally {
      if (request === latestRequest.current) setIsLoading(false);
    }
  }, [agentId, launchPath]);

  // Anything still on its way answers a page that has moved on.
  const abandonRequests = useCallback(() => {
    latestRequest.current++;
  }, []);

  // Waits for the launch path rather than reading once without it and again with it.
  useEffect(() => {
    if (isActive && launchPath !== undefined) void load();
    return abandonRequests;
  }, [isActive, launchPath, load, abandonRequests]);

  const handleRecheck = async () => {
    const before = latestRequest.current;
    await onRefresh();
    // Left the page meanwhile, or a new launch path has already started the read.
    if (latestRequest.current === before) await load();
  };

  // A list read for another launch path says the wrong copy launches, so it gives
  // way to the path alone, whose version takes a probe to read.
  const current =
    loaded && loaded.launchPath === launchPath && loaded.copies.length > 0 ? loaded.copies : null;
  const rows: (Omit<AgentCliCopy, "version"> & { version?: string | null })[] =
    current ?? (launchPath ? [{ path: launchPath, launches: true }] : []);

  const where = remoteHostName === null ? "" : ` on ${remoteHostName}`;
  const description =
    rows.length > 1
      ? `${pluralize(rows.length, "copy", "copies")} found${where}. Daintree launches the marked one.`
      : remoteHostName !== null
        ? `Found${where}`
        : undefined;

  return (
    <SettingsSection
      id="agents-cli-copies"
      title="Detected CLI"
      description={description}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleRecheck()}
          disabled={isRefreshing}
        >
          <SpinningIcon icon={RefreshCw} active={isRefreshing} size={14} />
          Re-check
        </Button>
      }
    >
      <SettingsGroup>
        {rows.map((copy) => (
          <SettingsRow
            key={copy.path}
            label={<span className="font-mono text-xs break-all select-text">{copy.path}</span>}
            labelText={copy.path}
            description={versionText(copy.version, showChecking)}
            control={copy.launches ? <Badge>Launches</Badge> : undefined}
          />
        ))}
        {rows.length === 0 && !failed && (
          <SettingsEmptyRow>
            {isLoading || launchPath === undefined
              ? "Checking for copies…"
              : "No copies found. Re-check after installing."}
          </SettingsEmptyRow>
        )}
        {failed && (
          <SettingsEmptyRow
            action={
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            Couldn't read the copies of this CLI
          </SettingsEmptyRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
