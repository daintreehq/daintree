import { nativeImage, type NativeImage } from "electron";

/**
 * Reject oversized clipboard image writes before any native API call. Binary
 * (Uint8Array) payloads skip the IPC envelope budget check (see
 * electron/setup/security.ts) because containsBinary() skips the JSON-size
 * check for typed arrays, so this cap is the backstop against a hostile or
 * runaway caller exhausting the main-process heap below Mojo's 128 MiB
 * ceiling. 20 MiB comfortably covers a 6K-display PNG.
 *
 * Shared by the renderer IPC clipboard handler and the plugin host's
 * `host.clipboard.writeImage`, so a plugin and a renderer face the same limit.
 */
export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Decode raw PNG bytes into an Electron `NativeImage`, or `null` when the bytes
 * don't yield a usable image.
 *
 * Two details are easy to get wrong independently, which is why they live here
 * rather than being reimplemented per call site:
 *
 * 1. The `Buffer.from(view.buffer, byteOffset, byteLength)` triple. Passing
 *    just `pngData.buffer` would hand over the whole backing ArrayBuffer,
 *    which for a subarray view is the wrong bytes — silently, and only for
 *    callers whose data happens to be a view.
 * 2. `nativeImage.createFromBuffer` does not throw on malformed input; it
 *    returns an image for which `isEmpty()` is true. An emptiness check is the
 *    only available signal, so omitting it puts a blank image on the clipboard
 *    and reports success.
 *
 * Callers shape their own error for the `null` case — the IPC handler raises an
 * `AppError` with a user-facing message, the plugin host rejects with its
 * `VALIDATION:`-prefixed contract — so this returns rather than throws.
 */
export function decodeClipboardPng(pngData: Uint8Array): NativeImage | null {
  const buffer = Buffer.from(pngData.buffer, pngData.byteOffset, pngData.byteLength);
  const image = nativeImage.createFromBuffer(buffer);
  return image.isEmpty() ? null : image;
}
