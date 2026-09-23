import type { ScopeKind } from "./scopeUtils";

interface ScopeBannerProps {
  scopeKind: ScopeKind;
  scopeLabel: string;
}

export function ScopeBanner({ scopeKind, scopeLabel }: ScopeBannerProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-text-secondary">Editing:</span>
      <span className="text-text-primary font-medium" data-testid="scope-banner-label">
        {scopeLabel}
      </span>
      {scopeKind === "ccr" && (
        <span
          data-testid="preset-badge-auto"
          className="text-3xs text-text-secondary bg-overlay-subtle px-1.5 py-0.5 rounded-[var(--radius-sm)]"
        >
          auto
        </span>
      )}
      {scopeKind === "project" && (
        <span
          data-testid="preset-badge-project"
          className="text-3xs text-text-secondary bg-overlay-subtle px-1.5 py-0.5 rounded-[var(--radius-sm)]"
        >
          project
        </span>
      )}
      {scopeKind === "custom" && (
        <span
          data-testid="preset-badge-custom"
          className="text-3xs text-status-info bg-status-info/10 px-1.5 py-0.5 rounded-[var(--radius-sm)]"
        >
          custom
        </span>
      )}
    </div>
  );
}
