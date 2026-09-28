import type { UploadPreferences } from "@shared/types/ipc/fileTransfer";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { isCtrlVKey } from "@/services/terminalReservedKeys";
import { deriveTerminalChrome, type TerminalChromeInput } from "@/utils/terminalChrome";

/**
 * Ctrl+V in an agent terminal of a remote window. The agent CLI's own Ctrl+V
 * reads the clipboard of the machine it runs on, which is the host's, not the
 * one the user is sitting at. So when this machine's clipboard holds an
 * image, Daintree uploads it and types the host path, which the agent then
 * attaches just as if it had read the clipboard itself. With no image the key
 * goes through untouched. Input-layer only: no agent configuration changes.
 */

/** Pastes this machine's clipboard image into a terminal; "empty" when there is none. */
export type ClipboardImagePaster = () => Promise<"inserted" | "empty" | "failed">;

const pasters = new Map<string, ClipboardImagePaster>();

export function registerClipboardImagePaster(
  terminalId: string,
  paster: ClipboardImagePaster
): () => void {
  pasters.set(terminalId, paster);
  return () => {
    if (pasters.get(terminalId) === paster) pasters.delete(terminalId);
  };
}

export function getClipboardImagePaster(terminalId: string): ClipboardImagePaster | null {
  return pasters.get(terminalId) ?? null;
}

// Absent from the settings file means on, so the cache starts there.
let interceptCtrlVImages = true;
let loading: Promise<void> | null = null;

export function shouldInterceptCtrlVImages(): boolean {
  return interceptCtrlVImages;
}

/**
 * Whether this keydown is a Ctrl+V to take over: plain Ctrl+V, in an agent
 * terminal (never a shell, where it is "literal next"), in a window attached
 * to a remote host, with the setting on.
 */
export function isClipboardImageCtrlV(
  event: KeyboardEvent,
  identity: TerminalChromeInput
): boolean {
  return (
    isCtrlVKey(event) &&
    isRemoteWindow() &&
    interceptCtrlVImages &&
    deriveTerminalChrome(identity).isAgent
  );
}

/**
 * Re-read the device preference. The Settings dialog may change it from
 * another view, so callers refresh on mount and on window focus.
 */
export function refreshUploadPreferences(): Promise<void> {
  const fileTransfer = window.electron?.fileTransfer;
  if (!fileTransfer?.getUploadPreferences) return Promise.resolve();
  loading ??= fileTransfer
    .getUploadPreferences()
    .then((preferences) => {
      interceptCtrlVImages = preferences.interceptCtrlVImages;
    })
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function setInterceptCtrlVImages(enabled: boolean): Promise<UploadPreferences> {
  const preferences = await window.electron.fileTransfer.setUploadPreferences({
    interceptCtrlVImages: enabled,
  });
  interceptCtrlVImages = preferences.interceptCtrlVImages;
  return preferences;
}

/** @internal Tests only. */
export function _resetCtrlVImagePasteForTests(): void {
  pasters.clear();
  interceptCtrlVImages = true;
  loading = null;
}
