import { useCallback, useState } from "react";

export interface UseUnsavedChangesOptions {
  isDirty: boolean;
}

export function useUnsavedChanges({ isDirty }: UseUnsavedChangesOptions) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const onBeforeClose = useCallback(() => {
    if (!isDirty) return true;
    setIsConfirmOpen(true);
    return false;
  }, [isDirty]);

  const closeConfirm = useCallback(() => setIsConfirmOpen(false), []);

  return { onBeforeClose, isConfirmOpen, closeConfirm, isDirty };
}
