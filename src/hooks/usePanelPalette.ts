import { useState, useCallback, useMemo } from "react";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { hasPanelComponent } from "@/registry/panelComponentRegistry";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";

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
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);

  const availableKinds = useMemo<PanelKindOption[]>(() => {
    const allKindIds = getPanelKindIds();

    const panelKinds = allKindIds
      .filter((kindId) => {
        if (kindId === "agent") return false;
        const config = getPanelKindConfig(kindId);
        if (!config) return false;
        if (config.showInPalette === false) return false;
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
          description: config.shortcut,
        };
      });

    const agentKinds = getEffectiveAgentIds()
      .map((agentId): PanelKindOption | null => {
        const agentConfig = getEffectiveAgentConfig(agentId);
        if (!agentConfig) return null;
        return {
          id: `agent:${agentId}`,
          name: agentConfig.name,
          iconId: agentConfig.iconId,
          color: agentConfig.color,
          description: agentConfig.shortcut ?? agentConfig.tooltip,
        };
      })
      .filter((agent): agent is PanelKindOption => agent !== null);

    return [...panelKinds, ...agentKinds];
  }, [userRegistry]);

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
    if (availableKinds.length === 0) return;
    setSelectedIndex((prev) => {
      if (prev === 0) return availableKinds.length - 1;
      return prev - 1;
    });
  }, [availableKinds.length]);

  const selectNext = useCallback(() => {
    if (availableKinds.length === 0) return;
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
