import { retargetRelaunch } from "../lifecycle/armRelaunch.js";
import { runningAppImage } from "../utils/appImage.js";
import { repointAppImageWrapper } from "./CliInstallService.js";

/**
 * Daintree's own files that name the AppImage it runs from, kept pointing at
 * it when the image moves: the armed relaunch's command, the daintree CLI
 * wrapper, and whatever registers a handler. electron-updater installs a
 * versioned AppImage (Daintree-1.2.0.AppImage) under the new version's name and
 * deletes the old file, so anything holding the old path launches nothing
 * afterwards.
 */

export interface AppImageRelocation {
  previous: string;
  next: string;
  /** The version now at `next`, when an update put it there; it isn't this process's. */
  version?: string;
}

type RelocationHandler = (relocation: AppImageRelocation) => void;

const handlers = new Set<RelocationHandler>();

/**
 * Registered for the rest of the process, never removed: the updater moves
 * the image during the install handoff, after the shutdown chain has already
 * torn down every service that might otherwise own the registration.
 */
export function onAppImageRelocated(handler: RelocationHandler): void {
  handlers.add(handler);
}

/**
 * Synchronous throughout: electron-updater emits the move from inside its
 * install, moments before the process quits, and a quit on the install-on-quit
 * path relaunches nothing that could finish the job. One failing step never
 * stops the rest.
 */
export function notifyAppImageRelocated(relocation: AppImageRelocation): void {
  try {
    retargetRelaunch(relocation.previous, relocation.next);
  } catch (error) {
    console.warn("[AppImage] Couldn't move the armed relaunch to the new image:", error);
  }
  try {
    repointAppImageWrapper(relocation.next, relocation.version);
  } catch (error) {
    console.warn("[AppImage] Couldn't repoint the daintree command:", error);
  }
  for (const handler of handlers) {
    try {
      handler(relocation);
    } catch (error) {
      console.warn("[AppImage] A relocation handler failed:", error);
    }
  }
}

/**
 * At startup: follow a move this process never saw, such as one made by an
 * older build's updater, which had no handlers to run.
 */
export function reconcileAppImageReferences(image: string | null = runningAppImage()): void {
  if (!image) return;
  try {
    repointAppImageWrapper(image);
  } catch (error) {
    console.warn("[AppImage] Couldn't repoint the daintree command:", error);
  }
}

export function resetAppImageRelocationHandlersForTests(): void {
  handlers.clear();
}
