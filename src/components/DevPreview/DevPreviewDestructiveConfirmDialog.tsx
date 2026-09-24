import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PathSegments } from "@/components/ui/PathSegments";
import {
  Bone,
  MissingValue,
  PreviewFrame,
  PreviewNote,
  PreviewNotice,
  PreviewSectionHeading,
  PreviewSkeleton,
  PreviewSummary,
  SummaryRow,
} from "@/components/Git/GitOperationPreview";
import { formatBytes } from "@/lib/formatBytes";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type {
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
  DevPreviewDirMeta,
} from "@shared/types/ipc/devPreview";

export type DevPreviewDestructiveTier = "restartAndClearCache" | "reinstallAndRestart";

interface DevPreviewDestructiveConfirmDialogProps {
  panelId: string;
  projectId: string | undefined;
  tier: DevPreviewDestructiveTier | null;
  isOpen: boolean;
  /** The confirmed operation is running: the primary shows progress and Cancel locks. */
  isConfirming?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

type SizesState = "pending" | "failed" | DevPreviewDestructivePreviewSizes;

function pathSeparator(cwd: string): string {
  return cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
}

function joinNodeModulesPath(cwd: string): string {
  const sep = pathSeparator(cwd);
  return cwd.endsWith(sep) ? `${cwd}node_modules` : `${cwd}${sep}node_modules`;
}

export function DevPreviewDestructiveConfirmDialog({
  panelId,
  projectId,
  tier,
  isOpen,
  isConfirming = false,
  onClose,
  onConfirm,
}: DevPreviewDestructiveConfirmDialogProps) {
  const [meta, setMeta] = useState<DevPreviewDestructivePreviewMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<SizesState>("pending");
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen || !projectId || !tier) {
      setMeta(null);
      setMetaError(null);
      setSizes("pending");
      return;
    }

    const requestId = ++requestIdRef.current;
    setMeta(null);
    setMetaError(null);
    setSizes("pending");

    safeFireAndForget(
      window.electron.devPreview
        .getDestructivePreviewMeta({ panelId, projectId })
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setMeta(result);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          setMetaError(formatErrorMessage(err, "The dev server's folder couldn't be read."));
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
          // Non-blocking: sizes inform the decision, the directory list gates it.
          if (requestIdRef.current !== requestId) return;
          setSizes("failed");
        }),
      { context: "DevPreviewDestructiveConfirmDialog: load sizes" }
    );
  }, [isOpen, panelId, projectId, tier]);

  if (!tier) return null;

  const copy = describe(tier, meta);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      variant="destructive"
      hasPreview={true}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      confirmDisabled={!meta}
      isConfirmLoading={isConfirming}
      hint={
        metaError
          ? "Needs a readable project folder"
          : !meta
            ? "Checking what this deletes…"
            : undefined
      }
      onConfirm={onConfirm}
    >
      {/* Ahead of the frame, not after it: as the body's last child it took
          the frame's place in `space-y` and pushed a gap under it. */}
      <p className="sr-only" role="status" data-testid="dev-preview-destructive-status">
        {settledAnnouncement(tier, meta, sizes)}
      </p>
      <PreviewFrame>
        {metaError && (
          <PreviewNotice
            tone="error"
            title="Couldn't read the dev server's folder"
            testId="dev-preview-destructive-meta-error"
          >
            {metaError}
          </PreviewNotice>
        )}
        {!metaError &&
          (tier === "restartAndClearCache" ? (
            <CacheDirsPreview meta={meta} sizes={sizes} />
          ) : (
            <NodeModulesPreview meta={meta} sizes={sizes} />
          ))}
      </PreviewFrame>
    </ConfirmDialog>
  );
}

interface TierCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * The paragraph and the button follow what the preview found. A cache clear
 * that finds nothing only restarts, and a reinstall with no node_modules only
 * installs — saying "will be deleted" there made the user reconcile the copy
 * against a list that contradicted it.
 */
function describe(tier: DevPreviewDestructiveTier, meta: DevPreviewDestructivePreviewMeta | null) {
  if (tier === "restartAndClearCache") {
    const nothingToClear = meta !== null && !meta.cacheDirs.some((d) => d.exists);
    return nothingToClear
      ? {
          title: "Restart dev server?",
          description:
            "There are no build caches to delete, so this only restarts the dev server. Source files and installed dependencies aren't touched.",
          confirmLabel: "Restart dev server",
        }
      : {
          title: "Clear cache and restart?",
          description:
            "The build caches below are deleted and the dev server restarts; the framework rebuilds them on the next start. Source files and installed dependencies aren't touched.",
          confirmLabel: "Clear cache",
        };
  }

  const pm = meta?.packageManager ?? "npm";
  // Only node_modules is deleted, but the install itself writes to the working
  // tree: it can rewrite the lockfile, or create one where there was none.
  const untouched = !meta
    ? "Source files aren't touched, though the install can update the lockfile."
    : meta.lockfileName
      ? `Source files aren't touched, though the install can update ${meta.lockfileName}.`
      : "Source files aren't touched, though the install writes a new lockfile.";
  if (meta && !meta.nodeModules.exists) {
    return {
      title: "Install dependencies?",
      description: `There's no node_modules to delete, so ${pm} installs every dependency, then the dev server restarts. This can take several minutes. ${untouched}`,
      confirmLabel: "Install dependencies",
    } satisfies TierCopy;
  }
  return {
    title: "Reinstall dependencies?",
    description:
      pm === "pnpm"
        ? `node_modules is deleted and re-linked from the pnpm store, then the dev server restarts. ${untouched}`
        : `node_modules is deleted and every dependency reinstalled, then the dev server restarts. This can take several minutes. ${untouched}`,
    confirmLabel: "Reinstall dependencies",
  } satisfies TierCopy;
}

/**
 * What a screen reader hears once the preview settles. The loading skeleton is
 * its own status region, but it unmounts when the metadata lands, so without a
 * region that outlives it the preview arrives — and the primary unlocks — in
 * silence. Metadata errors announce through the notice's own alert.
 */
function settledAnnouncement(
  tier: DevPreviewDestructiveTier,
  meta: DevPreviewDestructivePreviewMeta | null,
  sizes: SizesState
): string {
  if (!meta) return "";
  // An empty outcome is known the moment the metadata lands; there is no size
  // to wait for, so it never waits behind one.
  const present = meta.cacheDirs.filter((d) => d.exists);
  if (tier === "restartAndClearCache" && present.length === 0) {
    return "Preview ready. No build caches found.";
  }
  if (tier === "reinstallAndRestart" && !meta.nodeModules.exists) {
    return "Preview ready. node_modules isn't there.";
  }
  if (sizes === "pending") return "Preview ready. Measuring sizes.";
  if (sizes === "failed") return "Preview ready. Sizes couldn't be measured.";
  if (tier === "restartAndClearCache") {
    const total = cacheTotal(present, sizes);
    return typeof total === "number"
      ? `Preview ready. ${present.length} ${present.length === 1 ? "cache" : "caches"}, ${formatBytes(total)} in all.`
      : "Preview ready. Some sizes couldn't be measured.";
  }
  return typeof sizes.nodeModulesSizeBytes === "number"
    ? `Preview ready. node_modules is ${formatBytes(sizes.nodeModulesSizeBytes)}.`
    : "Preview ready. The size couldn't be measured.";
}

/** A full path, wrapping only between folders (see `PathSegments`). */
function PathValue({ path, testId }: { path: string; testId?: string }) {
  return (
    <span className="font-mono text-text-primary" data-testid={testId} title={path}>
      <PathSegments path={path} />
    </span>
  );
}

function SizeValue({ bytes, sizes }: { bytes: number | null | undefined; sizes: SizesState }) {
  if (typeof bytes === "number") {
    return <span className="tabular-nums text-text-primary">{formatBytes(bytes)}</span>;
  }
  if (sizes === "pending") return <Bone className="w-14" />;
  return <MissingValue label="Unknown" />;
}

function cacheTotal(present: DevPreviewDirMeta[], sizes: SizesState): number | null | undefined {
  if (sizes === "pending") return undefined;
  if (sizes === "failed") return null;
  let total = 0;
  for (const dir of present) {
    const size = sizes.cacheDirSizes[dir.relPath];
    if (typeof size !== "number") return null;
    total += size;
  }
  return total;
}

function CacheDirsPreview({
  meta,
  sizes,
}: {
  meta: DevPreviewDestructivePreviewMeta | null;
  sizes: SizesState;
}) {
  if (!meta) {
    return (
      <PreviewSkeleton
        label="Checking for build caches"
        testId="dev-preview-destructive-cache-skeleton"
      />
    );
  }

  const present = meta.cacheDirs.filter((d) => d.exists);
  const absent = meta.cacheDirs.filter((d) => !d.exists);
  const total = cacheTotal(present, sizes);

  return (
    <div data-testid="dev-preview-destructive-cache-preview">
      <PreviewSummary>
        <SummaryRow label="Folder">
          <PathValue path={meta.cwd} testId="dev-preview-destructive-cwd" />
        </SummaryRow>
        {present.length > 0 && (
          <SummaryRow label="Frees">
            <SizeValue bytes={total} sizes={sizes} />
          </SummaryRow>
        )}
      </PreviewSummary>

      {present.length === 0 ? (
        <PreviewNote testId="dev-preview-destructive-cache-none">
          No build caches found. Checked {absent.map((d) => d.relPath).join(", ")}.
        </PreviewNote>
      ) : (
        <>
          <PreviewSectionHeading label="Caches to delete" count={present.length} />
          <table
            className="w-full border-t border-tint/[0.08] text-left"
            aria-busy={sizes === "pending" || undefined}
          >
            <thead className="sr-only">
              <tr>
                <th scope="col">Directory</th>
                <th scope="col">Modified</th>
                <th scope="col">Size</th>
              </tr>
            </thead>
            <tbody>
              {present.map((dir) => (
                <tr
                  key={dir.relPath}
                  className="align-baseline"
                  data-testid="dev-preview-destructive-cache-row"
                  data-rel-path={dir.relPath}
                >
                  <td className="pl-3 pr-2 py-1 font-mono text-text-primary">{dir.relPath}</td>
                  <td className="w-full px-2 py-1 text-2xs text-text-secondary whitespace-nowrap">
                    {dir.mtimeMs ? formatRelativeTime(dir.mtimeMs) : <MissingValue />}
                  </td>
                  <td className="pl-2 pr-3 py-1 text-right whitespace-nowrap">
                    <SizeValue
                      bytes={
                        sizes === "pending" || sizes === "failed"
                          ? null
                          : sizes.cacheDirSizes[dir.relPath]
                      }
                      sizes={sizes}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {absent.length > 0 && (
            <p
              className="px-3 pt-1 pb-2 text-2xs text-text-secondary"
              data-testid="dev-preview-destructive-cache-absent"
            >
              Not found, skipped: {absent.map((d) => d.relPath).join(", ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function NodeModulesPreview({
  meta,
  sizes,
}: {
  meta: DevPreviewDestructivePreviewMeta | null;
  sizes: SizesState;
}) {
  if (!meta) {
    return (
      <PreviewSkeleton
        label="Checking node_modules"
        testId="dev-preview-destructive-reinstall-skeleton"
      />
    );
  }

  const exists = meta.nodeModules.exists;
  const isPnpm = meta.packageManager === "pnpm";
  const bytes = sizes === "pending" || sizes === "failed" ? null : sizes.nodeModulesSizeBytes;

  return (
    <PreviewSummary
      testId="dev-preview-destructive-reinstall-preview"
      busy={exists && sizes === "pending"}
    >
      {exists ? (
        <SummaryRow label="Deletes">
          <PathValue
            path={joinNodeModulesPath(meta.cwd)}
            testId="dev-preview-destructive-node-modules-path"
          />
        </SummaryRow>
      ) : (
        <>
          <SummaryRow label="Folder">
            <PathValue path={meta.cwd} testId="dev-preview-destructive-cwd" />
          </SummaryRow>
          <SummaryRow label="Deletes">
            <MissingValue label="Nothing, node_modules isn't there" />
          </SummaryRow>
        </>
      )}
      {exists && (
        <>
          <SummaryRow
            label="Size"
            aside={isPnpm && bytes !== null ? "the pnpm store keeps the files" : undefined}
          >
            <SizeValue bytes={bytes} sizes={sizes} />
          </SummaryRow>
          <SummaryRow label="Modified">
            {meta.nodeModules.mtimeMs ? (
              <span className="text-text-primary">
                {formatRelativeTime(meta.nodeModules.mtimeMs)}
              </span>
            ) : (
              <MissingValue />
            )}
          </SummaryRow>
        </>
      )}
      <SummaryRow label="Runs">
        <span
          className="font-mono text-text-primary"
          data-testid="dev-preview-destructive-install-cmd"
        >
          {meta.packageManager} install
        </span>
      </SummaryRow>
      <SummaryRow label="Lockfile">
        {meta.lockfileName ? (
          <span className="font-mono text-text-primary">{meta.lockfileName}</span>
        ) : (
          <MissingValue label="None, so versions resolve fresh from package.json" />
        )}
      </SummaryRow>
    </PreviewSummary>
  );
}
