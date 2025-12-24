import { useEffect, useCallback, useState } from "react";
import { useSidecarStore } from "@/store/sidecarStore";
import { actionService } from "@/services/ActionService";

export function useLinkDiscovery() {
  const discoveryComplete = useSidecarStore((s) => s.discoveryComplete);
  const setDiscoveredLinks = useSidecarStore((s) => s.setDiscoveredLinks);
  const markDiscoveryComplete = useSidecarStore((s) => s.markDiscoveryComplete);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    if (discoveryComplete) return;

    const runDiscovery = async () => {
      try {
        const result = await actionService.dispatch("cliAvailability.get", undefined, {
          source: "user",
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        const availability = result.result as any;
        setDiscoveredLinks(availability);
        markDiscoveryComplete();
      } catch (error) {
        console.error("Link discovery failed:", error);
        markDiscoveryComplete();
      }
    };

    runDiscovery();
  }, [discoveryComplete, setDiscoveredLinks, markDiscoveryComplete]);

  const rescan = useCallback(async () => {
    setIsScanning(true);
    try {
      const result = await actionService.dispatch("sidecar.links.rescan", undefined, {
        source: "user",
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      console.error("Link rescan failed:", error);
    } finally {
      setIsScanning(false);
    }
  }, []);

  return { rescan, isScanning };
}
