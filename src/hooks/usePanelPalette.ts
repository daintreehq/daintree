import { useState, useCallback, useMemo } from "react";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { hasPanelComponent } from "@/registry/panelComponentRegistry";

export interface PanelKindOption {
  id: string;
  name: string;
  iconId: string;
  color: string;
  description?: string;
}

export interface UsePanelPaletteReturn {
  isOpen: boolean;
  availableKinds: PanelKindOption[];
  selectedIndex: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  selectPrevious: () => void;
  selectNext: () => void;
  selectKind: (kindId: string) => void;
  confirmSelection: () => PanelKindOption | null;
}

export function usePanelPalette(): UsePanelPaletteReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const availableKinds = useMemo<PanelKindOption[]>(() => {
    const allKindIds = getPanelKindIds();

    return allKindIds
      .filter((kindId) => {
        const config = getPanelKindConfig(kindId);
        if (!config) return false;
        if (config.hasPty) return false;
        if (!hasPanelComponent(kindId)) return false;
        return true;
      })
      .map((kindId) => {
        const config = getPanelKindConfig(kindId)!;
        return {
          id: kindId,
          name: config.name,
          iconId: config.iconId,
          color: config.color,
          description: undefined,
        };
      });
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
    setSelectedIndex(0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setSelectedIndex(0);
  }, []);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }, [isOpen, open, close]);

  const selectPrevious = useCallback(() => {
    setSelectedIndex((prev) => {
      if (prev === 0) return availableKinds.length - 1;
      return prev - 1;
    });
  }, [availableKinds.length]);

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => {
      if (prev === availableKinds.length - 1) return 0;
      return prev + 1;
    });
  }, [availableKinds.length]);

  const selectKind = useCallback(
    (kindId: string) => {
      const index = availableKinds.findIndex((k) => k.id === kindId);
      if (index !== -1) {
        setSelectedIndex(index);
      }
    },
    [availableKinds]
  );

  const confirmSelection = useCallback((): PanelKindOption | null => {
    if (availableKinds.length === 0) return null;
    const selected = availableKinds[selectedIndex];
    if (!selected) return null;
    close();
    return selected;
  }, [availableKinds, selectedIndex, close]);

  return {
    isOpen,
    availableKinds,
    selectedIndex,
    open,
    close,
    toggle,
    selectPrevious,
    selectNext,
    selectKind,
    confirmSelection,
  };
}
