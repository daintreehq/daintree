import { useCallback, useEffect, useState } from "react";
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

export interface LocalSpeechModelState {
  status: LocalSpeechModelStatus | null;
  /** The last read from main failed; `retry` reads again. */
  readFailed: boolean;
  retry: () => void;
}

/**
 * The status this view last heard, kept current by every push. Read from main
 * once `active` (on-device transcription is chosen), since that read checks
 * the installed files.
 */
export function useLocalSpeechModelStatus(active = true): LocalSpeechModelState {
  const [status, setStatus] = useState<LocalSpeechModelStatus | null>(getLocalModelStatus);
  const [readFailed, setReadFailed] = useState(false);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const unsubscribe = subscribeLocalModelStatus((next) => {
      setStatus(next);
      setReadFailed(false);
    });
    readLocalModelStatus()
      .then((read) => {
        if (!current) return;
        if (read) setStatus(read);
        setReadFailed(false);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setReadFailed(true);
        logWarn("Couldn't read the on-device model's status", {
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [active, reads]);
  const retry = useCallback(() => setReads((n) => n + 1), []);
  return { status, readFailed, retry };
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

/** What Delete takes away: the installed model, or what a download left. */
function deletable(status: LocalSpeechModelStatus | null): "model" | "download" | null {
  if (!status) return null;
  if (status.state === "ready") return "model";
  if (status.state === "failed") return "model";
  if (status.state === "absent" && status.receivedBytes > 0) return "download";
  return null;
}

export function LocalSpeechModelRow({
  model,
  dictating,
}: {
  model: LocalSpeechModelState;
  dictating: boolean;
}) {
  const { status, readFailed, retry } = model;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>, failed: string) => {
    setFailure(null);
    try {
      await action();
    } catch {
      setFailure(failed);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    await run(
      removeLocalModel,
      dictating ? "Stop dictating, then delete the model." : "Couldn't delete the model. Try again."
    );
    setRemoving(false);
    setConfirmOpen(false);
  };

  const state = status?.state ?? "checking";
  const size = formatBytes(status?.totalBytes ?? 0);
  const received = formatBytes(status?.receivedBytes ?? 0);
  const resumable = state === "absent" && (status?.receivedBytes ?? 0) > 0;
  const toDelete = deletable(status);

  return (
    <>
      <ConfirmDialog
        isOpen={confirmOpen}
        variant="destructive"
        onConfirm={() => void handleRemove()}
        onClose={() => setConfirmOpen(false)}
        isConfirmLoading={removing}
        title={
          toDelete === "download" ? "Delete the partial download?" : "Delete the on-device model?"
        }
        description={
          toDelete === "download"
            ? `The ${received} downloaded so far are deleted from this computer. A later download starts from the beginning.`
            : `Its ${size} are deleted from this computer. On-device dictation stops until you download it again.`
        }
        confirmLabel={toDelete === "download" ? "Delete download" : "Delete model"}
        zIndex="nested"
      />
      <SettingsRow
        id="voice-local-model"
        label="On-device model"
        layout="stacked"
        description={
          <span role="status">
            {readFailed && !status
              ? "Couldn't read the model's status."
              : describeLocalModel(status)}
          </span>
        }
        error={failure ?? undefined}
        control={({ disabled, descriptionId }) => {
          if (readFailed && !status) {
            return (
              <Button size="sm" variant="outline" onClick={retry} aria-describedby={descriptionId}>
                Retry
              </Button>
            );
          }
          if (state === "unsupported" || state === "checking") return null;
          if (state === "downloading") {
            return (
              <div className="flex flex-wrap items-center gap-3">
                <ProgressBar
                  className="min-w-0 flex-1 basis-48"
                  value={status?.receivedBytes ?? 0}
                  max={status?.totalBytes ?? 1}
                  label="On-device model download"
                  valueText={`${received} of ${size}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void run(cancelLocalModelDownload, "Couldn't cancel the download. Try again.")
                  }
                  aria-describedby={descriptionId}
                >
                  Cancel download
                </Button>
              </div>
            );
          }
          return (
            <div className="flex flex-wrap items-center gap-2">
              {state !== "ready" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void run(downloadLocalModel, "Couldn't start the download. Try again.")
                  }
                  disabled={disabled}
                  aria-describedby={descriptionId}
                >
                  {state === "failed"
                    ? "Retry"
                    : resumable
                      ? "Resume download"
                      : `Download ${size}`}
                </Button>
              )}
              {toDelete && (
                <Button
                  size="sm"
                  variant="ghost-danger"
                  onClick={() => setConfirmOpen(true)}
                  disabled={disabled || dictating}
                  loading={removing}
                  aria-describedby={descriptionId}
                >
                  {toDelete === "download" ? "Delete download" : "Delete model"}
                </Button>
              )}
            </div>
          );
        }}
      />
    </>
  );
}
