import { Suspense, lazy, useEffect, useState } from "react";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useProjectStore } from "@/store";
import { useBranchForPath } from "@/hooks/useBranchForPath";
import { consumePendingViewFileRequest, parseViewFileEvent } from "./pendingViewFileRequest";

const LazyFileViewerModal = lazy(() =>
  import("./FileViewerModal").then((m) => ({ default: m.FileViewerModal }))
);

interface FileViewState {
  path: string;
  rootPath?: string;
  line?: number;
  col?: number;
}

export function FileViewerModalHost() {
  const [fileView, setFileView] = useState<FileViewState | null>(null);
  // Monotonic open counter — `Number(fileView != null)` would stay `[1]` while a
  // file is already open, so a crashed boundary would never reset when the user
  // opens a different file. The counter changes on every open event (#9918).
  const [openSeq, setOpenSeq] = useState(0);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectRootPath = currentProject?.path ?? "";
  const effectiveRootPath = fileView?.rootPath ?? projectRootPath;
  const branch = useBranchForPath(effectiveRootPath);

  useEffect(() => {
    const open = (request: { path: string; rootPath?: string; line?: number; col?: number }) => {
      setFileView(request);
      setOpenSeq((s) => s + 1);
    };

    const handleOpen = (e: Event) => {
      const request = parseViewFileEvent(e);
      if (!request) return;
      // This event supersedes anything stashed for the mount replay below.
      consumePendingViewFileRequest();
      open(request);
    };

    const controller = new AbortController();
    window.addEventListener("daintree:view-file", handleOpen, { signal: controller.signal });

    // Replay a request dispatched before this listener existed: this host lives
    // in a lazy chunk, so the first open right after hydration — and the
    // re-dispatch that resets a crashed boundary — can fire before mount.
    const pending = consumePendingViewFileRequest();
    if (pending) open(pending);

    return () => controller.abort();
  }, []);

  if (!fileView) return null;

  return (
    <ErrorBoundary variant="component" componentName="FileViewerModal" resetKeys={[openSeq]}>
      {/* Mirrors FileDiffModal's fallback: a Doherty-gated bone in a
          modal-shaped frame, so fast chunk loads show only the scrim. */}
      <Suspense
        fallback={
          <Skeleton
            label="Loading file viewer"
            className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-medium"
          >
            <SkeletonBone className="w-[min(80vw,720px)] h-[min(70vh,480px)]" />
          </Skeleton>
        }
      >
        <LazyFileViewerModal
          isOpen={true}
          filePath={fileView.path}
          rootPath={effectiveRootPath}
          branch={branch}
          initialLine={fileView.line}
          initialCol={fileView.col}
          onClose={() => setFileView(null)}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
