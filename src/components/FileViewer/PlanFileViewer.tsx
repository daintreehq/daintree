import { AppDialog } from "@/components/ui/AppDialog";
import { CodeViewer } from "./CodeViewer";
import { usePlanFileContent } from "@/hooks/usePlanFileContent";
import { FileText } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";

interface PlanFileViewerProps {
  isOpen: boolean;
  filePath: string | undefined;
  rootPath: string;
  onClose: () => void;
}

export function PlanFileViewer({ isOpen, filePath, rootPath, onClose }: PlanFileViewerProps) {
  const { status, content, errorCode } = usePlanFileContent(isOpen, filePath, rootPath);

  const fileName = filePath ?? "Plan";
  const isGone = status === "error" && errorCode === "NOT_FOUND";

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="4xl" maxHeight="max-h-[85vh]">
      <AppDialog.Header className="py-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
          <AppDialog.Title className="text-sm font-medium">{fileName}</AppDialog.Title>
        </div>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.BodyScroll className="p-0">
        {(!filePath || isGone) && (
          <div className="flex flex-col items-center justify-center h-48 gap-2 text-center px-6">
            <FileText className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No plan file found in this worktree.</p>
            <p className="text-xs text-muted-foreground/60">
              Create a <span className="font-mono">TODO.md</span>,{" "}
              <span className="font-mono">PLAN.md</span>, <span className="font-mono">plan.md</span>
              , or <span className="font-mono">TASKS.md</span> file to get started.
            </p>
          </div>
        )}

        {filePath && !isGone && status === "loading" && (
          <div className="flex items-center justify-center h-48">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Spinner size="lg" />
              <span>Loading plan...</span>
            </div>
          </div>
        )}

        {filePath && !isGone && status === "error" && (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <p className="text-sm text-muted-foreground">Plan file could not be read.</p>
          </div>
        )}

        {filePath && status === "loaded" && content !== null && (
          <CodeViewer content={content} filePath={fileName} className="min-h-[200px]" />
        )}
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}
