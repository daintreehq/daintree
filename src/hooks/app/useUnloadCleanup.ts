import { useEffect } from "react";
import { cleanupWorktreeDataStore } from "@/store";

export function useUnloadCleanup() {
  useEffect(() => {
    const handleBeforeUnload = () => {
      cleanupWorktreeDataStore();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      cleanupWorktreeDataStore();
    };
  }, []);
}
