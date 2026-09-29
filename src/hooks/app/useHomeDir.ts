import { useEffect, useState } from "react";
import { systemClient } from "@/clients";
import { logError } from "@/utils/logger";

export function useHomeDir() {
  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    // Through a resolved promise so a missing bridge (a bare test render, a
    // torn-down view) lands in the catch instead of throwing from the effect.
    Promise.resolve()
      .then(() => systemClient.getHomeDir())
      .then((dir) => {
        if (!disposed) setHomeDir(dir);
      })
      .catch((err) => {
        if (!disposed) logError("Failed to fetch home directory", err);
      });
    return () => {
      disposed = true;
    };
  }, []);

  return { homeDir };
}
