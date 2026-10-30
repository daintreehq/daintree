import { ExternalLink, RefreshCw, XCircle } from "lucide-react";
import { PaneState, PaneStateActions } from "@/components/ui/PaneState";
import { Button } from "@/components/ui/button";

// Fills the page placeholder in place of the skeleton once a tab's restore has
// given up. The tab keeps its URL, so both ways out land on the same page.
export function PortalTabRestoreError({
  url,
  onRetry,
  onOpenExternal,
}: {
  url: string;
  onRetry: () => void;
  onOpenExternal: () => void;
}) {
  return (
    <PaneState
      live="alert"
      className="bg-surface-sidebar"
      icon={<XCircle className="text-status-error" />}
      title="Couldn't restore this page"
      description={<span className="break-all">{url}</span>}
    >
      <PaneStateActions>
        <Button onClick={onRetry} variant="subtle" size="sm">
          <RefreshCw />
          Retry
        </Button>
        <Button onClick={onOpenExternal} variant="ghost" size="sm">
          <ExternalLink />
          Open in external browser
        </Button>
      </PaneStateActions>
    </PaneState>
  );
}
