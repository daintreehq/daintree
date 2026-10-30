import type { ProjectTemplatePreview } from "@shared/types/plugin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Skeleton, SkeletonHint, SkeletonText } from "@/components/ui/Skeleton";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";

interface ProjectTemplateFileListProps {
  /** `null` while the template's files are still being read. */
  preview: ProjectTemplatePreview | null;
  /** Past the loading gate, so a quick read never flashes a placeholder. */
  showLoading: boolean;
  /** Read the files again, offered when the last read failed rather than the template refused. */
  onRetry?: () => void;
}

const KIND_LABEL = {
  instructions: "Instructions",
  "project-plugin": "Project plugin",
} as const;

/**
 * Every file a project template will write (#13825), listed before anything is
 * written. The list is the whole of it — the copy writes exactly these paths —
 * so it is bounded by the viewport, never by the data. Instruction files and
 * project-plugin files are marked, since those are the ones that change what an
 * agent or Daintree does in the new project.
 */
export function ProjectTemplateFileList({
  preview,
  showLoading,
  onRetry,
}: ProjectTemplateFileListProps) {
  if (preview === null) {
    // `immediate`: the caller's gate has already held this back past 400ms.
    return showLoading ? (
      <div className="space-y-2">
        <Skeleton label="Reading the template's files">
          <SkeletonText lines={3} lineHeightClassName="h-3" immediate />
        </Skeleton>
        <SkeletonHint firstThreshold={5_000} className="text-xs text-text-secondary" />
      </div>
    ) : null;
  }

  if (preview.status === "unusable") {
    return (
      <Callout
        severity="error"
        role="alert"
        action={
          preview.retryable && onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          ) : undefined
        }
      >
        <p>Can't use this template. {preview.reason}</p>
      </Callout>
    );
  }

  const hasProjectPlugin = preview.files.some((file) => file.kind === "project-plugin");
  const label = `${pluralize(preview.files.length, "file")} to write`;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={SECTION_LABEL_CLASS}>Files</h3>
        <span className="text-2xs text-text-secondary tabular-nums">
          {pluralize(preview.files.length, "file")} · {formatBytes(preview.totalBytes)}
        </span>
      </div>
      {/* Scrollable with no focusable children, so the region itself is the
          tab stop (WCAG 2.1.1); the fades say the list continues. */}
      <ScrollShadow
        className="max-h-[168px] rounded-[var(--radius-md)] border border-border-default"
        scrollClassName="px-3 py-2 scroll-py-6"
        compact
        tabIndex={0}
        role="region"
        aria-label={label}
        data-testid="project-template-files"
      >
        <ul className="space-y-1">
          {preview.files.map((file) => (
            <li key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 break-all font-mono text-text-primary">
                {file.path}
              </span>
              {file.kind !== "file" && (
                <Badge size="xs" tone="outline">
                  {KIND_LABEL[file.kind]}
                </Badge>
              )}
              <span className="shrink-0 text-2xs text-text-secondary tabular-nums">
                {formatBytes(file.size)}
              </span>
            </li>
          ))}
        </ul>
      </ScrollShadow>
      <p className="text-xs text-text-secondary">
        Files are copied as they are. Nothing in the template runs and nothing is installed.
        {hasProjectPlugin &&
          " Its project plugin stays off until you trust it when the project first opens."}
      </p>
    </div>
  );
}
