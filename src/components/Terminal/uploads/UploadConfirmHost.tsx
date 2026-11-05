import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatBytes } from "@/lib/formatBytes";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { FolderUploadQuestion } from "./FolderUploadQuestion";
import {
  registerUploadConfirmHost,
  useUploadConfirmState,
  type UploadQuestion,
} from "./uploadConfirm";

function copyFor(question: Exclude<UploadQuestion, { kind: "folder" }>) {
  if (question.kind === "large") {
    return {
      title: `Send '${question.name}' to ${question.hostLabel}?`,
      description: `It's ${formatBytes(question.bytes)}, and nothing is inserted until it has finished uploading.`,
      confirmLabel: "Send file",
    };
  }
  return {
    title: `Replace '${question.name}'?`,
    description: `${question.folder} on ${question.hostLabel} already has a file with this name. Replacing it overwrites that file with the one you dropped.`,
    confirmLabel: "Replace file",
  };
}

/**
 * Answers the questions uploads ask. Mounted by every surface that can start
 * an upload in a remote window; only the first mounted one renders, so the
 * question appears once however many terminals are open.
 */
export function UploadConfirmHost() {
  const [token] = useState(() => Symbol("upload-confirm-host"));
  const remote = isRemoteWindow();
  useEffect(() => {
    if (!remote) return;
    return registerUploadConfirmHost(token);
  }, [remote, token]);
  const { lead, head } = useUploadConfirmState();
  if (!remote || lead !== token || !head) return null;
  if (head.question.kind === "folder") {
    return <FolderUploadQuestion key={head.id} question={head.question} onAnswer={head.answer} />;
  }
  const copy = copyFor(head.question);
  return (
    <ConfirmDialog
      key={head.id}
      isOpen
      variant={head.question.kind === "replace" ? "destructive" : "default"}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      onConfirm={() => head.answer(true)}
      onClose={() => head.answer(false)}
    />
  );
}
