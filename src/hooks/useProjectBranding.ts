import { useState, useEffect, useRef } from "react";
import { useProjectStore } from "../store/projectStore";
import { projectClient } from "@/clients";

interface UseProjectBrandingReturn {
  projectIconSvg: string | undefined;
  isLoading: boolean;
}

export function useProjectBranding(projectId?: string): UseProjectBrandingReturn {
  const currentProject = useProjectStore((state) => state.currentProject);
  const targetId = projectId || currentProject?.id;

  const [projectIconSvg, setProjectIconSvg] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);

  const latestTargetIdRef = useRef(targetId);
  latestTargetIdRef.current = targetId;

  useEffect(() => {
    if (!targetId) {
      setProjectIconSvg(undefined);
      return;
    }

    const fetchBranding = async () => {
      setIsLoading(true);
      const requestedProjectId = targetId;

      try {
        const data = await projectClient.getSettings(requestedProjectId);
        if (requestedProjectId === latestTargetIdRef.current) {
          setProjectIconSvg(data.projectIconSvg);
        }
      } catch {
        if (requestedProjectId === latestTargetIdRef.current) {
          setProjectIconSvg(undefined);
        }
      } finally {
        if (requestedProjectId === latestTargetIdRef.current) {
          setIsLoading(false);
        }
      }
    };

    void fetchBranding();
  }, [targetId]);

  return { projectIconSvg, isLoading };
}
