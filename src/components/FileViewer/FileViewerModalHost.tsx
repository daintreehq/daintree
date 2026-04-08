import { Suspense, lazy, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { useProjectStore } from "@/store";
import { useBranchForPath } from "@/hooks/useBranchForPath";

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
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectRootPath = currentProject?.path ?? "";
  const effectiveRootPath = fileView?.rootPath ?? projectRootPath;
  const branch = useBranchForPath(effectiveRootPath);

  useEffect(() => {
    const handleOpen = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      const d = detail as { path?: unknown; rootPath?: unknown; line?: unknown; col?: unknown };
      if (typeof d?.path !== "string" || !d.path) return;
      setFileView({
        path: d.path,
        rootPath: typeof d.rootPath === "string" && d.rootPath ? d.rootPath : undefined,
        line: typeof d.line === "number" ? d.line : undefined,
        col: typeof d.col === "number" ? d.col : undefined,
      });
    };

    const controller = new AbortController();
    window.addEventListener("canopy:view-file", handleOpen, { signal: controller.signal });
    return () => controller.abort();
  }, []);

  if (!fileView) return null;

  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-medium">
          <Spinner size="xl" className="text-text-inverse" />
        </div>
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
  );
}
