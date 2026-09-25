import { lazy, Suspense } from "react";
import { isRemoteWindow } from "@/hooks/useHostPlatform";

const UploadConfirmHost = lazy(() =>
  import("./UploadConfirmHost").then((module) => ({ default: module.UploadConfirmHost }))
);

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
