import { FolderOpen, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CanopyIcon } from "@/components/icons";
import { useProjectStore } from "@/store/projectStore";

export function WelcomeScreen() {
  const addProject = useProjectStore((state) => state.addProject);
  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);
  const isLoading = useProjectStore((state) => state.isLoading);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 animate-in fade-in duration-500">
      <div className="max-w-sm w-full flex flex-col items-center text-center">
        <div className="mb-8">
          <CanopyIcon className="h-20 w-20 text-white/80" />
        </div>

        <h1 className="text-2xl font-semibold text-canopy-text tracking-tight mb-3">
          Welcome to Canopy
        </h1>

        <p className="text-sm text-canopy-text/60 leading-relaxed font-medium mb-2">
          Canopy is a habitat for your AI agents.
        </p>

        <p className="text-xs text-canopy-text/40 leading-relaxed mb-10 max-w-xs">
          Open an existing folder or create a new project to get started.
        </p>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          <Button
            size="lg"
            onClick={() => void addProject()}
            disabled={isLoading}
            className="w-full"
          >
            <FolderOpen />
            Open Folder
          </Button>

          <Button
            size="lg"
            variant="outline"
            onClick={openCreateFolderDialog}
            disabled={isLoading}
            className="w-full"
          >
            <FolderPlus />
            Create Project
          </Button>
        </div>
      </div>
    </div>
  );
}
