import { useEffect, useState } from "react";
import { systemClient } from "@/clients";

export function useHomeDir() {
  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);

  useEffect(() => {
    systemClient.getHomeDir().then(setHomeDir).catch(console.error);
  }, []);

  return { homeDir };
}
