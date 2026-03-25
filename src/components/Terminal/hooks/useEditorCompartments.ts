import { useRef } from "react";
import { Compartment } from "@codemirror/state";

export function useEditorCompartments() {
  const placeholderCompartmentRef = useRef(new Compartment());
  const keymapCompartmentRef = useRef(new Compartment());
  const editableCompartmentRef = useRef(new Compartment());
  const chipCompartmentRef = useRef(new Compartment());
  const tooltipCompartmentRef = useRef(new Compartment());
  const fileChipTooltipCompartmentRef = useRef(new Compartment());
  const imageChipTooltipCompartmentRef = useRef(new Compartment());
  const fileDropChipTooltipCompartmentRef = useRef(new Compartment());
  const diffChipTooltipCompartmentRef = useRef(new Compartment());
  const terminalChipTooltipCompartmentRef = useRef(new Compartment());
  const selectionChipTooltipCompartmentRef = useRef(new Compartment());
  const autoSizeCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());

  return {
    placeholderCompartmentRef,
    keymapCompartmentRef,
    editableCompartmentRef,
    chipCompartmentRef,
    tooltipCompartmentRef,
    fileChipTooltipCompartmentRef,
    imageChipTooltipCompartmentRef,
    fileDropChipTooltipCompartmentRef,
    diffChipTooltipCompartmentRef,
    terminalChipTooltipCompartmentRef,
    selectionChipTooltipCompartmentRef,
    autoSizeCompartmentRef,
    themeCompartmentRef,
  };
}
