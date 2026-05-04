import type { ScopeKind } from "./scopeUtils";

interface ScopeBannerProps {
  scopeKind: ScopeKind;
  scopeLabel: string;
}

export function ScopeBanner({ scopeKind, scopeLabel }: ScopeBannerProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-daintree-text/50">Editing:</span>
      <span className="text-daintree-text font-medium" data-testid="scope-banner-label">
        {scopeLabel}
      </span>
      {scopeKind === "ccr" && (
        <span
          data-testid="preset-badge-auto"
          className="text-[10px] text-daintree-text/40 bg-daintree-text/10 px-1.5 py-0.5 rounded"
        >
          auto
        </span>
      )}
      {scopeKind === "project" && (
        <span
          data-testid="preset-badge-project"
          className="text-[10px] text-daintree-text/40 bg-daintree-text/10 px-1.5 py-0.5 rounded"
        >
          project
        </span>
      )}
      {scopeKind === "custom" && (
        <span
          data-testid="preset-badge-custom"
          className="text-[10px] text-status-info bg-status-info/10 px-1.5 py-0.5 rounded"
        >
          custom
        </span>
      )}
    </div>
  );
}
