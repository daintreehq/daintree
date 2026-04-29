import { useState, useEffect } from "react";

export function useDeferredLoading(isPending: boolean, delay = 200): boolean {
  const [showLoader, setShowLoader] = useState(isPending && delay <= 0);

  useEffect(() => {
    if (!isPending) {
      setShowLoader(false);
      return;
    }
    if (delay <= 0) {
      setShowLoader(true);
      return;
    }
    const timer = setTimeout(() => setShowLoader(true), delay);
    return () => clearTimeout(timer);
  }, [isPending, delay]);

  return showLoader;
}
