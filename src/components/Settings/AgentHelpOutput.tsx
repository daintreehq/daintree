import { useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import { Button } from "@/components/ui/button";
import { Copy, RefreshCw, TriangleAlert } from "lucide-react";
import { agentHelpClient } from "@/clients";

import type { AgentHelpResult } from "@shared/types/ipc/agent";
import type { AgentAvailabilityState } from "@shared/types";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { sanitizeErrorText } from "@/utils/errorText";
import { logError } from "@/utils/logger";

interface AgentHelpOutputProps {
  agentId: string;
  agentName: string;
  availability: AgentAvailabilityState;
}

export function AgentHelpOutput({ agentId, agentName, availability }: AgentHelpOutputProps) {
  const [helpResult, setHelpResult] = useState<AgentHelpResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const loadGenRef = useRef(0);

  useEffect(() => {
    loadGenRef.current += 1;
    setHelpResult(null);
    setError(null);
    setIsCopied(false);
    setIsLoading(false);
  }, [agentId, availability]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const loadHelp = async (refresh = false) => {
    const gen = ++loadGenRef.current;
    setIsLoading(true);
    setError(null);

    if (!isAgentInstalled(availability)) {
      setIsLoading(false);
      return;
    }

    try {
      const result = await agentHelpClient.get({ agentId, refresh });
      if (loadGenRef.current !== gen) return;
      setHelpResult(result);
    } catch (err) {
      if (loadGenRef.current !== gen) return;
      setError(formatErrorMessage(err, "Failed to load help output"));
    } finally {
      if (loadGenRef.current === gen) setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!helpResult) return;

    const textToCopy = sanitizeErrorText(
      [helpResult.stdout, helpResult.stderr].filter(Boolean).join("\n\n")
    );

    try {
      await navigator.clipboard.writeText(textToCopy);

      if (!isMountedRef.current) return;

      setIsCopied(true);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setIsCopied(false);
        }
        copyTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      logError("Failed to copy to clipboard", err);
    }
  };

  const installed = isAgentInstalled(availability);

  const renderOutput = () => {
    if (!helpResult) return null;

    const cleanStdout = sanitizeErrorText(helpResult.stdout);
    const cleanStderr = sanitizeErrorText(helpResult.stderr);
    const hasError = helpResult.exitCode !== 0 || helpResult.timedOut;

    return (
      <div>
        {hasError && (
          <p className="flex items-center gap-1.5 px-4 pt-3 text-xs text-text-secondary">
            <TriangleAlert
              className="h-3.5 w-3.5 shrink-0 text-status-warning"
              aria-hidden="true"
            />
            {helpResult.timedOut
              ? "The help command timed out"
              : `The help command exited with code ${helpResult.exitCode}`}
          </p>
        )}
        {/* Focusable and named so a keyboard user can reach and scroll the output, and
            Tab carries on past it. */}
        <div
          className="relative max-h-80 overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          tabIndex={0}
          role="region"
          aria-label={`${agentName} help output`}
        >
          <pre className="px-4 py-3 text-xs font-mono text-text-primary whitespace-pre select-text">
            {cleanStdout}
            {cleanStderr && (
              <>
                {cleanStdout && "\n\n"}
                {cleanStderr}
              </>
            )}
          </pre>
          {helpResult.truncated && (
            <div className="settings-card sticky bottom-0 px-4 py-2 border-t border-border-subtle text-xs text-text-secondary">
              Output truncated (exceeded size limit)
            </div>
          )}
        </div>
      </div>
    );
  };

  const loadButton = (label: string) => (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void loadHelp(!!helpResult)}
      disabled={isLoading}
    >
      <RefreshCw aria-hidden="true" />
      {label}
    </Button>
  );

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <div className="px-4 py-3 space-y-2 animate-pulse-delayed" aria-hidden="true">
        <div className="h-3 bg-overlay-medium rounded-sm w-3/4" />
        <div className="h-3 bg-overlay-medium rounded-sm w-1/2" />
        <div className="h-3 bg-overlay-medium rounded-sm w-5/6" />
        <div className="h-3 bg-overlay-medium rounded-sm w-2/3" />
        <div className="h-3 bg-overlay-medium rounded-sm w-1/3" />
      </div>
    );
  } else if (error) {
    body = (
      <SettingsEmptyRow action={installed ? loadButton("Retry") : undefined}>
        <span role="alert" className="flex items-start gap-1.5">
          <TriangleAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <span>Couldn&apos;t run the help command: {error}</span>
        </span>
      </SettingsEmptyRow>
    );
  } else if (helpResult) {
    body = renderOutput();
  } else if (installed) {
    body = (
      <SettingsEmptyRow action={loadButton("Load")}>
        Runs {agentName}&apos;s help command and shows what it prints
      </SettingsEmptyRow>
    );
  }

  return (
    <SettingsSection
      title="Help output"
      description={`The flags ${agentName} accepts, as its own --help prints them`}
      action={
        installed && helpResult ? (
          <>
            {loadButton("Refresh")}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleCopy()}
              disabled={isLoading}
            >
              <Copy aria-hidden="true" />
              {isCopied ? "Copied!" : "Copy"}
            </Button>
          </>
        ) : undefined
      }
    >
      <p role="status" className="sr-only">
        {isLoading ? "Loading help output" : helpResult ? "Help output loaded" : ""}
      </p>
      {body && <SettingsGroup>{body}</SettingsGroup>}
    </SettingsSection>
  );
}
