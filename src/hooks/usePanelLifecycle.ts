import { useState, useEffect, useRef, useMemo } from "react";

export interface PanelLifecycle {
  mountedRef: React.MutableRefObject<boolean>;
  timeoutRef: React.MutableRefObject<NodeJS.Timeout | undefined>;
  isTrashing: boolean;
  setIsTrashing: (value: boolean) => void;
}

export function usePanelLifecycle(): PanelLifecycle {
  const [isTrashing, setIsTrashing] = useState(false);
  const mountedRef = useRef(true);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return useMemo(() => ({ mountedRef, timeoutRef, isTrashing, setIsTrashing }), [isTrashing]);
}
