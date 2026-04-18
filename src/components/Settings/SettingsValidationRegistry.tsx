import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SettingsTab } from "./SettingsDialog";

interface ValidationRegistryApi {
  setTabHasError: (tab: SettingsTab, hasError: boolean) => void;
  clearTab: (tab: SettingsTab) => void;
  tabsWithErrors: ReadonlySet<SettingsTab>;
}

const ValidationContext = createContext<ValidationRegistryApi | null>(null);
export { ValidationContext as SettingsValidationContext };

interface ProviderProps {
  children: ReactNode;
}

export function SettingsValidationProvider({ children }: ProviderProps) {
  const [tabsWithErrors, setTabsWithErrors] = useState<Set<SettingsTab>>(new Set());

  const setTabHasError = useCallback((tab: SettingsTab, hasError: boolean) => {
    setTabsWithErrors((prev) => {
      if (prev.has(tab) === hasError) return prev;
      const next = new Set(prev);
      if (hasError) {
        next.add(tab);
      } else {
        next.delete(tab);
      }
      return next;
    });
  }, []);

  const clearTab = useCallback((tab: SettingsTab) => {
    setTabsWithErrors((prev) => {
      if (!prev.has(tab)) return prev;
      const next = new Set(prev);
      next.delete(tab);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ setTabHasError, clearTab, tabsWithErrors }),
    [setTabHasError, clearTab, tabsWithErrors]
  );

  return <ValidationContext.Provider value={value}>{children}</ValidationContext.Provider>;
}

/**
 * Hook for tabs to report their validation error state to the settings sidebar.
 * Automatically clears the error state when the component unmounts.
 *
 * @param tab - The tab ID to report errors for
 * @param hasError - Whether the tab currently has validation errors
 */
export function useSettingsTabValidation(tab: SettingsTab, hasError: boolean) {
  const context = useContext(ValidationContext);

  if (!context) {
    throw new Error("useSettingsTabValidation must be used within a SettingsValidationProvider");
  }

  useEffect(() => {
    context.setTabHasError(tab, hasError);
    return () => {
      context.clearTab(tab);
    };
  }, [context, tab, hasError]);
}
