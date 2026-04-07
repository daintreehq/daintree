/**
 * Unified Panel Kind Registry
 *
 * Single registry combining panel metadata and components.
 * Built-in kinds are populated at module load time.
 * Extensions can register custom panel types at runtime via registerPanelKindDefinition.
 */
export {
  getPanelKindDefinition,
  getPanelKindDefinitions,
  registerPanelKindDefinition,
  type PanelKindDefinition,
  type PanelComponentProps,
} from "./panelKindRegistry";
