import { useCanopyStore } from "@/store/canopyStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/** The pop-out this renderer last took up, so a second ask for the same one only answers again. */
let takenId: number | null = null;

async function takePopOut(): Promise<void> {
  const api = window.electron.canopyWindow;
  const pending = await api.peekPopOut();
  if (pending === null) return;
  if (takenId !== pending.id) {
    takenId = pending.id;
    useCanopyStore.getState().receivePopOut(pending.popOut);
  }
  // The dialog it came from closes on this answer, and only on it.
  await api.acknowledgePopOut(pending.id);
}

/**
 * Takes up a dialog popped out into this window (#16338): asked for now, since
 * one may be waiting from before the window booted, and again whenever main
 * says one is. Returns how to stop listening.
 */
export function receiveCanopyPopOuts(): () => void {
  const take = () => safeFireAndForget(takePopOut(), { context: "Taking up Canopy's dialog" });
  const stop = window.electron.canopyWindow.onPopOutWaiting(take);
  take();
  return stop;
}
