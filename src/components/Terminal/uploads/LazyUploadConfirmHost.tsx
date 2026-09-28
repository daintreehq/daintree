import { lazy, Suspense } from "react";
import { isRemoteWindow } from "@/hooks/useHostPlatform";

function loadUploadConfirmHost() {
  // Tested directly so a build without Remote Hosts (Windows) drops the dialog.
  if (__DAINTREE_REMOTE_HOSTS__) {
    return import("./UploadConfirmHost").then((module) => ({ default: module.UploadConfirmHost }));
  }
  return Promise.resolve({ default: () => null });
}

const UploadConfirmHost = lazy(loadUploadConfirmHost);

/**
 * The upload questions' home on a surface that can start an upload. A window
 * on this machine never uploads, so it never loads the dialog.
 */
export function LazyUploadConfirmHost() {
  if (!isRemoteWindow()) return null;
  return (
    <Suspense fallback={null}>
      <UploadConfirmHost />
    </Suspense>
  );
}
