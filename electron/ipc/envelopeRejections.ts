import type { IpcMainInvokeEvent } from "electron";

/**
 * Observers for invokes the security wrapper's envelope check refused before
 * the channel's handler ran. A handler that meters its own rejections (the
 * plugin invoke path counts oversize args) would otherwise never see these.
 *
 * Kept apart from `setup/security.ts` so a handler can register without
 * importing the wrapper's own dependency graph.
 */
export type IpcEnvelopeRejectionObserver = (
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
  error: unknown
) => void;

const observers = new Map<string, IpcEnvelopeRejectionObserver>();

/** One observer per channel; registering again replaces it. Returns a remover. */
export function observeIpcEnvelopeRejections(
  channel: string,
  observer: IpcEnvelopeRejectionObserver
): () => void {
  observers.set(channel, observer);
  return () => {
    if (observers.get(channel) === observer) observers.delete(channel);
  };
}

/** Called by the security wrapper; an observer that throws must not change the rejection. */
export function notifyIpcEnvelopeRejected(
  channel: string,
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
  error: unknown
): void {
  const observer = observers.get(channel);
  if (!observer) return;
  try {
    observer(event, args, error);
  } catch {
    // Observation is best-effort.
  }
}
