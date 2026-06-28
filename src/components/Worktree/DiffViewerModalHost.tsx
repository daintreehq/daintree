import { useEffect, useState } from "react";
import { useProjectStore } from "@/store";
import { FileDiffModal } from "./FileDiffModal";
import {
  consumePendingViewDiffRequest,
  parseViewDiffEvent,
  type ViewDiffRequest,
} from "./pendingViewDiffRequest";

/**
 * Event-driven host for the side-by-side diff viewer (`FileDiffModal`),
 * mirroring `FileViewerModalHost` for the read-only file view. Opens on a
 * `daintree:view-diff` CustomEvent — the surface the built-in `file.openDiff`
 * action (and, through it, plugins via `host.dispatch`) fires. Holds no store
 * state; a `daintree:view-diff` request supersedes whatever is open.
 */
export function DiffViewerModalHost() {
  const [request, setRequest] = useState<ViewDiffRequest | null>(null);
  const projectPath = useProjectStore((s) => s.currentProject?.path);

  useEffect(() => {
    const open = (next: ViewDiffRequest) => setRequest(next);

    const handleOpen = (e: Event) => {
      const parsed = parseViewDiffEvent(e);
      if (!parsed) return;
      // This event supersedes anything stashed for the mount replay below.
      consumePendingViewDiffRequest();
      open(parsed);
    };

    const controller = new AbortController();
    window.addEventListener("daintree:view-diff", handleOpen, { signal: controller.signal });

    // Replay a request dispatched before this lazy host mounted.
    const pending = consumePendingViewDiffRequest();
    if (pending) open(pending);

    return () => controller.abort();
  }, []);

  if (!request) return null;

  const worktreePath = request.worktreePath ?? projectPath ?? "";
  if (!worktreePath) return null;

  return (
    <FileDiffModal
      isOpen={true}
      filePath={request.path}
      status={request.status}
      worktreePath={worktreePath}
      onClose={() => setRequest(null)}
    />
  );
}
