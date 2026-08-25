import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { logError } from "@/utils/logger";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { AssistantDiagnostics } from "@shared/types/ipc/assistantHostIpc";

/**
 * What the assistant is actually configured to do, in a form you can paste.
 *
 * The questions this answers are the ones that otherwise take a support thread: which
 * endpoint are turns really going to — not which one is SELECTED, since those came apart
 * once already — is that endpoint even a backend, and which engine build is this.
 *
 * Read on demand, not on mount: it spawns the engine for a version string and makes a
 * network request, and neither belongs in the cost of opening a settings tab.
 */

/** How long "Copied" stays up. */
const COPY_FLASH_MS = 1_500;

/** Past this, a wait has to say it is still going. Two 5s ceilings sit behind this read. */
const STILL_WORKING_MS = 5_000;

export function AssistantDiagnosticsPanel() {
  const [report, setReport] = useState<AssistantDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The 400ms gate.
   *
   * A read that beats it shows nothing — a spinner that appears and vanishes reads as a
   * glitch. There is no skeleton because there is nothing to hold a shape for until the
   * first read returns; the button carries the whole indication.
   */
  const showBusy = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);
  const stillWorking = useDeferredLoading(loading, STILL_WORKING_MS);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    // A new read invalidates the old one, so "Copied" must not survive it — otherwise it
    // claims THIS report was copied when only the previous one was.
    setCopied(false);
    setCopyFailed(false);
    try {
      setReport(await window.electron.assistantHost.diagnostics());
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't read the assistant's configuration"));
      logError("Assistant diagnostics failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const copy = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopyFailed(false);
      setCopied(true);
      // Held in a ref so a second copy cannot have the FIRST one's timer end its flash
      // early, and so an unmount does not set state on a gone component.
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setCopied(false), COPY_FLASH_MS);
    } catch (err) {
      // Never flash "Copied" over a clipboard that refused — and say so, rather than
      // leaving a button that looks like it worked.
      setCopied(false);
      setCopyFailed(true);
      logError("Failed to copy assistant diagnostics", err);
    }
  }, [report]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="subtle"
          size="sm"
          onClick={() => void run()}
          disabled={loading}
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", showBusy && "animate-spin")} />
          {report ? "Re-check" : "Check configuration"}
        </Button>
        {report && (
          <Button type="button" variant="subtle" size="sm" onClick={() => void copy()}>
            {copied ? (
              <Check className="w-3.5 h-3.5 mr-1.5 text-status-success" />
            ) : (
              <Copy className="w-3.5 h-3.5 mr-1.5" />
            )}
            {copied ? "Copied" : "Copy as JSON"}
          </Button>
        )}
      </div>

      {stillWorking && (
        <p className="text-xs text-daintree-text/50" role="status" aria-live="polite">
          Still working…
        </p>
      )}

      {copyFailed && (
        <p className="text-xs text-status-danger select-text" role="status" aria-live="polite">
          Couldn&apos;t reach the clipboard
        </p>
      )}

      {error && (
        <p className="text-xs text-status-danger select-text" role="status" aria-live="polite">
          {error}
        </p>
      )}

      {report && (
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs select-text"
          data-testid="assistant-diagnostics"
        >
          <Row label="Environment" value={report.environment.selected} />
          <Row
            label="Backend"
            value={report.environment.resolvedUrl}
            // Three answers, not two. A variable that was REFUSED explains why the
            // resolved origin is not what the user exported; calling that "overridden"
            // would explain it by pointing at the value that had nothing to do with it.
            note={
              report.environment.envOverride === "applied"
                ? "from DAINTREE_BACKEND_URL"
                : report.environment.envOverride === "refused"
                  ? "DAINTREE_BACKEND_URL is set but points off-box, so it was ignored"
                  : undefined
            }
          />
          <Row label="Reachable" value={describeBackend(report)} />
          {/* Path AND version. The version identifies the build; the path says WHICH
              binary produced it, which is the whole question when an override points
              somewhere unexpected. */}
          <Row
            label="Engine"
            value={report.engine.found ? report.engine.binaryPath : "not found"}
            note={
              report.engine.found
                ? (report.engine.version ?? "version unavailable")
                : report.engine.detail
            }
          />
          <Row label="Host protocol" value={String(report.hostProtocolVersion)} />
          <Row
            label="Platform"
            value={`${report.platform.os}/${report.platform.arch}`}
            note={report.platform.supported ? undefined : report.platform.unsupportedReason}
          />
        </dl>
      )}
    </div>
  );
}

/**
 * The backend line, which is the one worth reading carefully.
 *
 * A redirect or an HTML answer is reported as such rather than as a generic failure:
 * those specifically mean "this address is not the backend", which is a different
 * problem from a backend that is down, and the fix is in a different place.
 */
function describeBackend(report: AssistantDiagnostics): string {
  const { backend } = report;
  if (backend.reachable) return `yes — ${backend.version.serverVersion}`;
  switch (backend.code) {
    case "redirected":
      return `no — that address redirects (${backend.detail})`;
    case "not-a-backend":
      return `no — that address isn't the assistant backend (${backend.detail})`;
    case "http-error":
      return `no — the backend answered ${backend.detail}`;
    default:
      return `no — ${backend.detail}`;
  }
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <>
      <dt className="text-daintree-text/50">{label}</dt>
      <dd className="text-daintree-text break-all font-mono">
        {value}
        {note && <span className="ml-2 font-sans text-daintree-text/50">{note}</span>}
      </dd>
    </>
  );
}
