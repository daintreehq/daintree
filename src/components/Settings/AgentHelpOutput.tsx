import { useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import { Button } from "@/components/ui/button";
import { Copy, RefreshCw } from "lucide-react";
import { agentHelpClient } from "@/clients";

import type { AgentHelpResult } from "@shared/types/ipc/agent";
import type { AgentAvailabilityState } from "@shared/types";
import { isAgentInstalled, isAgentMissing } from "../../../shared/utils/agentAvailability";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { sanitizeErrorText } from "@/utils/errorText";
import { logError } from "@/utils/logger";

interface AgentHelpOutputProps {
  agentId: string;
  agentName: string;
  usageUrl?: string;
  availability: AgentAvailabilityState;
  isCliLoading?: boolean;
}

export function AgentHelpOutput({
  agentId,
  agentName,
  usageUrl,
  availability,
  isCliLoading,
}: AgentHelpOutputProps) {
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
  const showMissing = isAgentMissing(availability) && !isCliLoading;

  const renderOutput = () => {
    if (!helpResult) return null;

    const cleanStdout = sanitizeErrorText(helpResult.stdout);
    const cleanStderr = sanitizeErrorText(helpResult.stderr);
    const hasError = helpResult.exitCode !== 0 || helpResult.timedOut;

    return (
      <div>
        {hasError && (
          <p className="px-4 pt-3 text-xs text-status-warning">
            {helpResult.timedOut
              ? "Command timed out"
              : `Command exited with code ${helpResult.exitCode}`}
          </p>
        )}
        <div className="relative max-h-80 overflow-auto">
          <pre className="px-4 py-3 text-xs font-mono text-text-primary whitespace-pre-wrap break-words select-text">
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
  } else if (showMissing) {
    body = (
      <SettingsEmptyRow
        action={
          usageUrl ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.electron.system.openExternal(usageUrl)}
            >
              Install instructions
            </Button>
          ) : undefined
        }
      >
        CLI not found — {agentName} is not installed or not in your PATH
      </SettingsEmptyRow>
    );
  } else if (error) {
    body = (
      <SettingsEmptyRow action={installed ? loadButton("Retry") : undefined}>
        <span className="text-status-error">{error}</span>
      </SettingsEmptyRow>
    );
  } else if (helpResult) {
    body = renderOutput();
  } else if (installed) {
    body = (
      <SettingsEmptyRow action={loadButton("Load")}>
        Load the output of {agentName}&apos;s help command to see its flags
      </SettingsEmptyRow>
    );
  }

  return (
    <SettingsSection
      title="Help output"
      description={`Available CLI flags for ${agentName}`}
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
      {body && <SettingsGroup>{body}</SettingsGroup>}
    </SettingsSection>
  );
}
