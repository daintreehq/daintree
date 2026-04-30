import { useEffect, useState } from "react";
import { systemClient } from "@/clients";
import { logError } from "@/utils/logger";

export function useHomeDir() {
  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    systemClient
      .getHomeDir()
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
