import { useCallback, useState } from "react";

export function useWorktreeOverview() {
  const [isWorktreeOverviewOpen, setIsWorktreeOverviewOpen] = useState(false);

  const toggleWorktreeOverview = useCallback(() => {
    setIsWorktreeOverviewOpen((prev) => !prev);
  }, []);

  const openWorktreeOverview = useCallback(() => {
    setIsWorktreeOverviewOpen(true);
  }, []);

  const closeWorktreeOverview = useCallback(() => {
    setIsWorktreeOverviewOpen(false);
  }, []);

  return {
    isWorktreeOverviewOpen,
    toggleWorktreeOverview,
    openWorktreeOverview,
    closeWorktreeOverview,
  };
}
