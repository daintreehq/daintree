import { getHostPlatform } from "@/hooks/useHostPlatform";
import { validateFolderName } from "@shared/utils/folderName";

/**
 * `validateFolderName` for a folder that will be created on this view's host,
 * which may not be the machine the renderer runs on: Linux bounds a name in
 * UTF-8 bytes where macOS and Windows count characters.
 */
export function validateHostFolderName(name: string): string | null {
  return validateFolderName(name, { platform: getHostPlatform() });
}
