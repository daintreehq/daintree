import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { formatBytes } from "@/lib/formatBytes";
import { logWarn } from "@/utils/logger";
import {
  cancelLocalModelDownload,
  downloadLocalModel,
  getLocalModelStatus,
  readLocalModelStatus,
  removeLocalModel,
  subscribeLocalModelStatus,
} from "@/clients/localSpeechModelClient";
import type { LocalSpeechModelStatus } from "@shared/types";
import { SettingsRow } from "./SettingsGroup";

const MODEL_NAME = "NVIDIA Nemotron 3.5 ASR";

/**
 * The status this view last heard, kept current by every push. Read from main
 * once `active` (on-device transcription is chosen), since that read checks
 * the installed files.
 */
export function useLocalSpeechModelStatus(active = true): LocalSpeechModelStatus | null {
  const [status, setStatus] = useState<LocalSpeechModelStatus | null>(getLocalModelStatus);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = subscribeLocalModelStatus(setStatus);
    readLocalModelStatus()
      .then((read) => {
        if (read) setStatus(read);
      })
      .catch((error: unknown) => {
        logWarn("Couldn't read the on-device model's status", {
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    return unsubscribe;
  }, [active]);
  return status;
}

export function describeLocalModel(status: LocalSpeechModelStatus | null): string {
  if (!status) return "Checking for the model…";
  const size = formatBytes(status.totalBytes);
  switch (status.state) {
    case "unsupported":
      return "This computer's processor can't run the on-device model.";
    case "checking":
      return "Checking the model's files…";
    case "ready":
      return `${MODEL_NAME}, ${size} on disk. Transcribes offline in every language this page offers.`;
    case "downloading":
      return `Downloading ${formatBytes(status.receivedBytes)} of ${size} from Hugging Face`;
    case "failed":
      return status.error ?? "The download failed.";
    case "absent":
      return status.receivedBytes > 0
        ? `${formatBytes(status.receivedBytes)} of ${size} downloaded. Resume to finish.`
        : `${MODEL_NAME} downloads once, ${size}, from Hugging Face. Your audio is never sent anywhere.`;
  }
}

export function LocalSpeechModelRow({ dictating }: { dictating: boolean }) {
  const status = useLocalSpeechModelStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    setRemoveFailed(false);
    try {
      await removeLocalModel();
    } catch {
      setRemoveFailed(true);
    } finally {
      setRemoving(false);
      setConfirmOpen(false);
    }
  };

  const state = status?.state ?? "checking";
  const size = formatBytes(status?.totalBytes ?? 0);
  const resumable = state === "absent" && (status?.receivedBytes ?? 0) > 0;

  return (
    <>
      <ConfirmDialog
        isOpen={confirmOpen}
        variant="destructive"
        onConfirm={() => void handleRemove()}
        onClose={() => setConfirmOpen(false)}
        isConfirmLoading={removing}
        title="Delete the on-device model?"
        description={`Its ${size} are deleted from this computer. On-device dictation stops until you download it again.`}
        confirmLabel="Delete model"
        zIndex="nested"
      />
      <SettingsRow
        id="voice-local-model"
        label="On-device model"
        layout="stacked"
        description={<span role="status">{describeLocalModel(status)}</span>}
        error={
          removeFailed
            ? dictating
              ? "Stop dictating, then delete the model."
              : "Couldn't delete the model. Try again."
            : undefined
        }
        control={({ disabled, descriptionId }) => {
          if (state === "unsupported" || state === "checking") return null;
          if (state === "downloading") {
            return (
              <div className="flex flex-wrap items-center gap-3">
                <ProgressBar
                  className="min-w-0 flex-1 basis-48"
                  value={status?.receivedBytes ?? 0}
                  max={status?.totalBytes ?? 1}
                  label="On-device model download"
                  valueText={`${formatBytes(status?.receivedBytes ?? 0)} of ${size}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void cancelLocalModelDownload()}
                  aria-describedby={descriptionId}
                >
                  Cancel download
                </Button>
              </div>
            );
          }
          if (state === "ready") {
            return (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost-danger"
                  onClick={() => setConfirmOpen(true)}
                  disabled={disabled || dictating}
                  loading={removing}
                  aria-describedby={descriptionId}
                >
                  Delete model
                </Button>
              </div>
            );
          }
          return (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void downloadLocalModel()}
                disabled={disabled}
                aria-describedby={descriptionId}
              >
                {state === "failed" ? "Retry" : resumable ? "Resume download" : `Download ${size}`}
              </Button>
            </div>
          );
        }}
      />
    </>
  );
}
