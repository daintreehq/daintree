import type { ComponentProps } from "react";
import type { UpdateCwdDialog } from "./UpdateCwdDialog";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { lazyWhenLoaded } from "@/lib/lazyWithPreload";

const LazyUpdateCwdDialog = lazyWhenLoaded(
  () => import("./UpdateCwdDialog"),
  (m) => m.UpdateCwdDialog
);

/**
 * The change-folder dialog, loaded the first time a terminal opens it. Kept
 * mounted from then on and handed `isOpen` unchanged, so a close still renders
 * closed: that is what calls off an attempt in flight, plays the exit, and
 * gives focus back to the terminal.
 */
export function UpdateCwdDialogGate(props: ComponentProps<typeof UpdateCwdDialog>) {
  const active = useKeepMounted(props.isOpen);
  return active ? <LazyUpdateCwdDialog {...props} /> : null;
}
