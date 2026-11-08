import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AgentCliCopy } from "@shared/types/ipc/system";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { cliAvailabilityClient } from "@/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSection } from "./SettingsSection";

/** The default's radio value: every copy's is an absolute path, so never this. */
const DEFAULT_CHOICE = "";

const CHOICE_ROW_CLASS =
  "px-4 py-3 transition-colors has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary";

type CopyRow = Omit<AgentCliCopy, "version"> & { version?: string | null };

function versionText(version: string | null | undefined, showChecking: boolean): string | null {
  if (version === undefined) return showChecking ? "Checking version…" : null;
  return version === null ? "No version reported" : `Reports ${version}`;
}

export function AgentCliCopiesSection({
  agentId,
  launchPath,
  chosenPath,
  isActive,
  isRefreshing,
  onRefresh,
  onChosen,
}: {
  agentId: string;
  /** The path launches start: `undefined` until detection details are in, `null` if there is none. */
  launchPath: string | null | undefined;
  /** The copy chosen to launch, when one was. Launches start it or fail. */
  chosenPath?: string;
  /** Reading the copies runs each of them, so only while this page is on screen. */
  isActive: boolean;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
  /** After a choice landed, to read what the host now launches. */
  onChosen: () => Promise<void>;
}) {
  const [loaded, setLoaded] = useState<{
    copies: AgentCliCopy[];
    launchPath: string | null | undefined;
    chosenPath: string | undefined;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [chooseFailure, setChooseFailure] = useState<{ value: string; message: string } | null>(
    null
  );
  const latestRequest = useRef(0);
  const latestLaunch = useRef({ launchPath, chosenPath });
  const isOnPage = useRef(false);
  // Copies are read where the agents run, so a remote window names that host.
  const remoteHostName = useRemoteHostName();
  const showChecking = useDeferredLoading(isLoading, UI_INLINE_LOADING_GATE_MS);

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    setIsLoading(true);
    try {
      const copies = await cliAvailabilityClient.getCopies(agentId);
      if (request !== latestRequest.current) return;
      setLoaded({ copies, ...latestLaunch.current });
      setFailed(false);
    } catch (error) {
      if (request !== latestRequest.current) return;
      logError("[AgentCliCopiesSection] Failed to read CLI copies", error);
      setFailed(true);
    } finally {
      if (request === latestRequest.current) setIsLoading(false);
    }
  }, [agentId]);

  // Anything still on its way answers a page that has moved on.
  const leavePage = useCallback(() => {
    isOnPage.current = false;
    latestRequest.current++;
  }, []);

  // Waits for the launch path rather than reading once without it and again with it.
  useEffect(() => {
    isOnPage.current = isActive;
    latestLaunch.current = { launchPath, chosenPath };
    if (isActive && launchPath !== undefined) void load();
    return leavePage;
  }, [isActive, launchPath, chosenPath, load, leavePage]);

  const handleRecheck = async () => {
    await onRefresh();
    // Asked for what's there now, so even a read begun during the refresh won't do.
    if (isOnPage.current) await load();
  };

  // One at a time. The radios stay enabled meanwhile, since disabling the focused
  // one would drop keyboard focus out of the group.
  const choose = async (value: string) => {
    if (pending !== null) return;
    setPending(value);
    setChooseFailure(null);
    try {
      if (value === DEFAULT_CHOICE) await cliAvailabilityClient.resetCopy(agentId);
      else await cliAvailabilityClient.chooseCopy(agentId, value);
      await onChosen();
    } catch (error) {
      logError("[AgentCliCopiesSection] Failed to change the launching copy", error);
      setChooseFailure({
        value,
        message: formatErrorMessage(error, "Couldn't change which copy launches"),
      });
    } finally {
      setPending(null);
    }
  };

  // A list read for another launch path says the wrong copy launches, so it gives
  // way to the path alone, whose version takes a probe to read.
  const current =
    loaded &&
    loaded.launchPath === launchPath &&
    loaded.chosenPath === chosenPath &&
    loaded.copies.length > 0
      ? loaded.copies
      : null;
  const rows: CopyRow[] = current ?? (launchPath ? [{ path: launchPath, launches: true }] : []);
  // Only a choice to make, or one made, is worth a choice to show.
  const isChoosing = rows.length > 1 || chosenPath !== undefined;
  // A chosen copy that can't launch isn't among those found, but stays the choice.
  // One found again before detection caught up is already a row of its own.
  const chosenUnavailable =
    chosenPath !== undefined &&
    launchPath !== undefined &&
    launchPath !== chosenPath &&
    !rows.some((copy) => copy.path === chosenPath);
  const selected = pending ?? chosenPath ?? DEFAULT_CHOICE;

  const where = remoteHostName === null ? "" : ` on ${remoteHostName}`;
  const description = isChoosing
    ? `${pluralize(rows.length, "copy", "copies")} found${where}. Choose which one launches.`
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
      <SettingsGroup className={isChoosing ? "overflow-hidden" : undefined}>
        {isChoosing ? (
          <RadioChoiceGroup
            legend="Copy to launch"
            legendHidden
            className="space-y-0 divide-y divide-border-subtle"
          >
            <RadioChoiceRow
              bare
              name={`agent-cli-copy-${agentId}`}
              value={DEFAULT_CHOICE}
              checked={selected === DEFAULT_CHOICE}
              onChange={() => void choose(DEFAULT_CHOICE)}
              label="Default"
              description="Launches the first copy found"
              className={cn(
                CHOICE_ROW_CLASS,
                selected === DEFAULT_CHOICE ? "bg-overlay-selected" : "hover:bg-overlay-soft"
              )}
            />
            {chosenUnavailable && (
              <RadioChoiceRow
                bare
                name={`agent-cli-copy-${agentId}`}
                value={chosenPath}
                checked={selected === chosenPath}
                onChange={() => {}}
                label={chosenPath}
                description="Not available now. Launches fail until it's back or another copy is chosen."
                className={cn(
                  CHOICE_ROW_CLASS,
                  "wrap-anywhere",
                  selected === chosenPath ? "bg-overlay-selected" : "hover:bg-overlay-soft"
                )}
              />
            )}
            {rows.map((copy) => (
              <RadioChoiceRow
                key={copy.path}
                bare
                name={`agent-cli-copy-${agentId}`}
                value={copy.path}
                checked={selected === copy.path}
                onChange={() => void choose(copy.path)}
                label={copy.path}
                description={versionText(copy.version, showChecking)}
                details={copy.launches ? "Launches" : undefined}
                className={cn(
                  CHOICE_ROW_CLASS,
                  "wrap-anywhere",
                  selected === copy.path ? "bg-overlay-selected" : "hover:bg-overlay-soft"
                )}
              />
            ))}
          </RadioChoiceGroup>
        ) : (
          rows.map((copy) => (
            <SettingsRow
              key={copy.path}
              label={<span className="font-mono text-xs break-all select-text">{copy.path}</span>}
              labelText={copy.path}
              description={versionText(copy.version, showChecking)}
              control={copy.launches ? <Badge>Launches</Badge> : undefined}
            />
          ))
        )}
        {chooseFailure && (
          <SettingsEmptyRow
            action={
              <Button size="sm" variant="outline" onClick={() => void choose(chooseFailure.value)}>
                Retry
              </Button>
            }
          >
            {chooseFailure.message}
          </SettingsEmptyRow>
        )}
        {rows.length === 0 && !chosenUnavailable && !failed && (
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
