/**
 * useSemanticWorkerLifecycle - Manages semantic analysis service lifecycle.
 */

import { useEffect } from "react";
import { semanticAnalysisService } from "../../services/SemanticAnalysisService";
import { isElectronAvailable } from "../useElectron";

export function useSemanticWorkerLifecycle() {
  useEffect(() => {
    if (!isElectronAvailable()) return;

    semanticAnalysisService.initialize().catch((error) => {
      console.warn("[useSemanticWorkerLifecycle] Failed to initialize semantic analysis service:", error);
    });

    return () => {
      semanticAnalysisService.dispose();
    };
  }, []);
}
