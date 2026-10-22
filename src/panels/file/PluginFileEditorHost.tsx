import { useEffect, useRef, useState } from "react";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import type { PluginFileEditorCandidate } from "@/registry/fileEditorRegistry";
import {
  openPluginFileDocument,
  type PluginFileDocumentHandle,
} from "@/services/plugin/pluginFileDocument";

export interface PluginFileEditorHostProps {
  panelId: string;
  projectId: string;
  filePath: string;
  fileName: string;
  rootPath: string;
  candidate: PluginFileEditorCandidate;
  /** The panel's disk-change signal, composed the same way Source mode's is. */
  changeTick: number | undefined;
}

/**
 * Mount a view-backed file editor (#13809) through the shared hosted-view path
 * — the same lazy `plugin://` import, activation, error boundary and "Try
 * again" every out-of-grid plugin view gets — with the host-owned document as
 * its `fileDocument` prop.
 *
 * Lives in its own chunk: FilePane imports it lazily, so neither the plugin
 * view loader nor the document controller is on the file panel's first-render
 * path. Callers key it by panel, file and editor, so swapping any of them
 * mounts a fresh view against the same host document.
 */
export default function PluginFileEditorHost({
  panelId,
  projectId,
  filePath,
  fileName,
  rootPath,
  candidate,
  changeTick,
}: PluginFileEditorHostProps) {
  const [handle] = useState<PluginFileDocumentHandle>(() =>
    openPluginFileDocument({
      panelId,
      projectId,
      filePath,
      fileName,
      rootPath,
      mode: candidate.editor.mode,
      maxBytes: candidate.editor.maxBytes,
    })
  );

  useEffect(() => handle.retain(), [handle]);

  // The first tick is the one the panel mounted with, not a change.
  const lastTick = useRef(changeTick);
  useEffect(() => {
    if (changeTick === lastTick.current) return;
    lastTick.current = changeTick;
    void handle.notifyDiskChange();
  }, [changeTick, handle]);

  return (
    <PluginHostedView
      source={{ from: "hosted", view: candidate.view }}
      host="fileEditor"
      mountId={`file-editor:${panelId}`}
      fileDocument={handle.document}
      className="h-full min-h-full w-full flex-1"
      testId="plugin-file-editor"
    />
  );
}
