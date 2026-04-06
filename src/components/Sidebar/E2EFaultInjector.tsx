import { useEffect, useState } from "react";

export function E2EFaultInjector() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const handler = () => setTick((t) => t + 1);
    window.addEventListener("__canopy_e2e_trigger_render__", handler);
    return () => window.removeEventListener("__canopy_e2e_trigger_render__", handler);
  }, []);

  if (window.__CANOPY_E2E_FAULT__?.renderError) {
    throw new Error("E2E_FAULT_INJECTION");
  }
  return null;
}
