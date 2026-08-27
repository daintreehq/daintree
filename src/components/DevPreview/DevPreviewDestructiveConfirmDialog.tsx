import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatBytes } from "@/lib/formatBytes";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { cn } from "@/lib/utils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type {
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
  DevPreviewPackageManager,
} from "@shared/types/ipc/devPreview";

export type DevPreviewDestructiveTier = "restartAndClearCache" | "reinstallAndRestart";

interface DevPreviewDestructiveConfirmDialogProps {
  panelId: string;
  projectId: string | undefined;
  tier: DevPreviewDestructiveTier | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

function joinNodeModulesPath(cwd: string): string {
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}node_modules` : `${cwd}${sep}node_modules`;
}

const PACKAGE_MANAGER_LABELS: Record<DevPreviewPackageManager, string> = {
  npm: "npm",
  pnpm: "pnpm",
  yarn: "Yarn",
  bun: "Bun",
};

export function DevPreviewDestructiveConfirmDialog({
  panelId,
  projectId,
  tier,
  isOpen,
  onClose,
  onConfirm,
}: DevPreviewDestructiveConfirmDialogProps) {
  const [meta, setMeta] = useState<DevPreviewDestructivePreviewMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<DevPreviewDestructivePreviewSizes | null>(null);
  const [sizesPending, setSizesPending] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen || !projectId || !tier) {
      setMeta(null);
      setMetaError(null);
      setSizes(null);
      setSizesPending(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setMeta(null);
    setMetaError(null);
    setSizes(null);
    setSizesPending(true);

    safeFireAndForget(
      window.electron.devPreview
        .getDestructivePreviewMeta({ panelId, projectId })
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setMeta(result);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          setMetaError(formatErrorMessage(err, "Couldn't load directory preview"));
        }),
      { context: "DevPreviewDestructiveConfirmDialog: load meta" }
    );

    const skipNodeModules = tier === "restartAndClearCache";
    safeFireAndForget(
      window.electron.devPreview
        .getDestructivePreviewSizes({ panelId, projectId, skipNodeModules })
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setSizes(result);
        })
        .catch(() => {
          // Size errors are non-blocking — cells render as "—" / "Unknown".
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setSizesPending(false);
        }),
      { context: "DevPreviewDestructiveConfirmDialog: load sizes" }
    );
  }, [isOpen, panelId, projectId, tier]);

  if (!tier) return null;

  const isCacheTier = tier === "restartAndClearCache";
  const isPnpm = meta?.packageManager === "pnpm";

  const title = isCacheTier ? "Clear cache and restart?" : "Reinstall dependencies?";
  const description = isCacheTier
    ? "Framework build caches will be deleted, then the dev server respawns. Source files and installed dependencies are not affected."
    : isPnpm
      ? "node_modules will be deleted, then dependencies re-link from the pnpm store. Source files and git state are not affected."
      : "node_modules will be deleted and all dependencies will be reinstalled, then the dev server respawns. This can take several minutes. Source files and git state are not affected.";
  const confirmLabel = isCacheTier ? "Clear cache" : "Reinstall dependencies";

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      variant="destructive"
      hasPreview={true}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      confirmDisabled={!meta}
      onConfirm={onConfirm}
    >
      <PreviewBlock
        tier={tier}
        meta={meta}
        metaError={metaError}
        sizes={sizes}
        sizesPending={sizesPending}
      />
    </ConfirmDialog>
  );
}

interface PreviewBlockProps {
  tier: DevPreviewDestructiveTier;
  meta: DevPreviewDestructivePreviewMeta | null;
  metaError: string | null;
  sizes: DevPreviewDestructivePreviewSizes | null;
  sizesPending: boolean;
}

function PreviewBlock({ tier, meta, metaError, sizes, sizesPending }: PreviewBlockProps) {
  if (metaError) {
    return (
      <div
        className="rounded border border-status-error/30 bg-status-error/[0.06] px-3 py-2 text-xs text-status-error flex items-start gap-2"
        data-testid="dev-preview-destructive-meta-error"
      >
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{metaError}</span>
      </div>
    );
  }

  if (tier === "restartAndClearCache") {
    return <CacheDirsPreview meta={meta} sizes={sizes} sizesPending={sizesPending} />;
  }
  return <NodeModulesPreview meta={meta} sizes={sizes} sizesPending={sizesPending} />;
}

interface CacheDirsPreviewProps {
  meta: DevPreviewDestructivePreviewMeta | null;
  sizes: DevPreviewDestructivePreviewSizes | null;
  sizesPending: boolean;
}

function CacheDirsPreview({ meta, sizes, sizesPending }: CacheDirsPreviewProps) {
  const cacheDirs = meta?.cacheDirs ?? null;
  const presentCount = cacheDirs?.filter((d) => d.exists).length ?? 0;

  return (
    <div
      className="rounded border border-tint/[0.08] bg-tint/[0.04]"
      data-testid="dev-preview-destructive-cache-preview"
    >
      <div className="px-3 py-2 border-b border-tint/[0.08] flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
          Directories to delete
          {cacheDirs && (
            <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
              {presentCount} of {cacheDirs.length}
            </span>
          )}
        </span>
      </div>
      <ul className="divide-y divide-tint/[0.06]">
        {cacheDirs === null
          ? Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="px-3 py-1.5">
                <div
                  className="h-3.5 w-32 rounded bg-tint/[0.08] animate-pulse-delayed"
                  data-testid="dev-preview-destructive-cache-skeleton"
                />
              </li>
            ))
          : cacheDirs.map((dir) => {
              const size = sizes?.cacheDirSizes[dir.relPath];
              return (
                <li
                  key={dir.relPath}
                  className="px-3 py-1.5 flex items-baseline gap-2 text-xs"
                  data-testid="dev-preview-destructive-cache-row"
                  data-rel-path={dir.relPath}
                  data-exists={dir.exists ? "true" : "false"}
                >
                  <span
                    className={cn(
                      "font-mono shrink-0",
                      dir.exists ? "text-daintree-text/80" : "text-daintree-text/35 line-through"
                    )}
                  >
                    {dir.relPath}
                  </span>
                  {dir.exists ? (
                    <>
                      <span className="text-[10px] text-text-secondary shrink-0">
                        {dir.mtimeMs ? formatRelativeTime(dir.mtimeMs) : null}
                      </span>
                      <span className="ml-auto tabular-nums text-daintree-text/60 shrink-0">
                        {size !== undefined && size !== null ? (
                          formatBytes(size)
                        ) : sizesPending ? (
                          <span
                            className="inline-block h-3 w-12 rounded bg-tint/[0.1] animate-pulse-delayed align-middle"
                            data-testid="dev-preview-destructive-size-skeleton"
                          />
                        ) : (
                          <span className="text-daintree-text/35">—</span>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="ml-auto text-[10px] text-daintree-text/35 italic shrink-0">
                      not present
                    </span>
                  )}
                </li>
              );
            })}
      </ul>
    </div>
  );
}

interface NodeModulesPreviewProps {
  meta: DevPreviewDestructivePreviewMeta | null;
  sizes: DevPreviewDestructivePreviewSizes | null;
  sizesPending: boolean;
}

function NodeModulesPreview({ meta, sizes, sizesPending }: NodeModulesPreviewProps) {
  const nodeModules = meta?.nodeModules ?? null;
  const sizeBytes = sizes?.nodeModulesSizeBytes ?? null;
  const isPnpm = meta?.packageManager === "pnpm";
  const pmLabel = meta ? PACKAGE_MANAGER_LABELS[meta.packageManager] : null;

  return (
    <div
      className="rounded border border-tint/[0.08] bg-tint/[0.04] text-xs"
      data-testid="dev-preview-destructive-reinstall-preview"
    >
      <div className="px-3 py-2 border-b border-tint/[0.08]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
          What will happen
        </span>
      </div>
      <dl className="px-3 py-2 space-y-1.5">
        <Row label="Directory">
          {meta ? (
            <span
              className={cn(
                "font-mono break-all",
                nodeModules?.exists ? "text-daintree-text/80" : "text-daintree-text/35 line-through"
              )}
              data-testid="dev-preview-destructive-node-modules-path"
            >
              {joinNodeModulesPath(meta.cwd)}
            </span>
          ) : (
            <RowSkeleton width="w-48" />
          )}
        </Row>
        <Row label="Size">
          {nodeModules?.exists === false ? (
            <span className="text-[10px] text-daintree-text/35 italic">not present</span>
          ) : sizeBytes !== null ? (
            <span className="tabular-nums text-daintree-text/80">
              {formatBytes(sizeBytes)}
              {isPnpm && (
                <span className="ml-1.5 text-[10px] text-daintree-text/45 italic">
                  apparent — pnpm store files remain
                </span>
              )}
            </span>
          ) : sizesPending ? (
            <RowSkeleton width="w-20" />
          ) : (
            <span className="text-daintree-text/35">—</span>
          )}
        </Row>
        <Row label="Last modified">
          {nodeModules?.mtimeMs ? (
            <span className="text-daintree-text/70">{formatRelativeTime(nodeModules.mtimeMs)}</span>
          ) : meta ? (
            <span className="text-daintree-text/35">—</span>
          ) : (
            <RowSkeleton width="w-24" />
          )}
        </Row>
        <Row label="Install command">
          {pmLabel ? (
            <span
              className="font-mono text-daintree-text/80"
              data-testid="dev-preview-destructive-install-cmd"
            >
              {meta?.packageManager} install
            </span>
          ) : (
            <RowSkeleton width="w-20" />
          )}
        </Row>
        <Row label="Lockfile">
          {meta ? (
            meta.lockfileName ? (
              <span className="font-mono text-daintree-text/80">{meta.lockfileName}</span>
            ) : (
              <span className="text-[10px] text-daintree-text/45 italic">none — npm fallback</span>
            )
          ) : (
            <RowSkeleton width="w-32" />
          )}
        </Row>
      </dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-[10px] uppercase tracking-wider text-daintree-text/50 shrink-0 w-28">
        {label}
      </dt>
      <dd className="flex-1 min-w-0">{children}</dd>
    </div>
  );
}

function RowSkeleton({ width }: { width: string }) {
  return (
    <span
      className={cn("inline-block h-3.5 rounded bg-tint/[0.08] animate-pulse-delayed", width)}
      data-testid="dev-preview-destructive-row-skeleton"
    />
  );
}
