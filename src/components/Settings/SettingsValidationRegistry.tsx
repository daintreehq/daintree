import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SettingsTab } from "./SettingsDialog";

interface ValidationRegistryApi {
  setPublisherHasError: (tab: SettingsTab, publisher: symbol, hasError: boolean) => void;
  tabsWithErrors: ReadonlySet<SettingsTab>;
}

const ValidationContext = createContext<ValidationRegistryApi | null>(null);
export { ValidationContext as SettingsValidationContext };

interface ProviderProps {
  children: ReactNode;
}

export function SettingsValidationProvider({ children }: ProviderProps) {
  const [tabsWithErrors, setTabsWithErrors] = useState<Set<SettingsTab>>(new Set());
  // A tab has an error while at least one publisher reports one. Tracking
  // publishers individually keeps multiple hooks sharing a tab key (e.g.
  // CodeForgeSettingsTab + nested GitHubSettingsTab) from clobbering each other.
  const publishersByTab = useRef(new Map<SettingsTab, Set<symbol>>());

  const setPublisherHasError = useCallback(
    (tab: SettingsTab, publisher: symbol, hasError: boolean) => {
      const publishers = publishersByTab.current.get(tab);
      if (hasError) {
        if (publishers) {
          publishers.add(publisher);
        } else {
          publishersByTab.current.set(tab, new Set([publisher]));
        }
      } else if (publishers) {
        publishers.delete(publisher);
        if (publishers.size === 0) {
          publishersByTab.current.delete(tab);
        }
      }

      const tabHasError = publishersByTab.current.has(tab);
      setTabsWithErrors((prev) => {
        if (prev.has(tab) === tabHasError) return prev;
        const next = new Set(prev);
        if (tabHasError) {
          next.add(tab);
        } else {
          next.delete(tab);
        }
        return next;
      });
    },
    []
  );

  const value = useMemo(
    () => ({ setPublisherHasError, tabsWithErrors }),
    [setPublisherHasError, tabsWithErrors]
  );

  return <ValidationContext.Provider value={value}>{children}</ValidationContext.Provider>;
}

/**
 * Hook for tabs to report their validation error state to the settings sidebar.
 * Multiple components may report for the same tab; the sidebar shows an error
 * while any of them does. Each hook instance only ever clears its own
 * contribution, including on unmount.
 *
 * @param tab - The tab ID to report errors for
 * @param hasError - Whether the caller currently has validation errors
 */
export function useSettingsTabValidation(tab: SettingsTab, hasError: boolean) {
  const context = useContext(ValidationContext);

  if (!context) {
    throw new Error("useSettingsTabValidation must be used within a SettingsValidationProvider");
  }

  // Stable per-instance identity; deliberately not useId(), which can change
  // across Strict Mode renders (react#27103).
  const [publisherId] = useState(() => Symbol("settings-tab-validation"));
  const { setPublisherHasError } = context;

  useEffect(() => {
    setPublisherHasError(tab, publisherId, hasError);
    return () => {
      setPublisherHasError(tab, publisherId, false);
    };
  }, [setPublisherHasError, tab, publisherId, hasError]);
}
