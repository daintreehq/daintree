/**
 * Panel Component Registry
 *
 * Enables extensible panel types by providing a registry for panel components.
 * Built-in kinds (terminal, agent, browser) are registered at startup.
 * Extensions can register custom panel types at runtime.
 */
export {
  registerPanelComponent,
  getPanelComponent,
  hasPanelComponent,
  getRegisteredPanelKinds,
  renderPanelComponent,
  type PanelComponentProps,
  type PanelComponentRegistration,
} from "./panelComponentRegistry";

export { registerBuiltInPanelComponents } from "./builtInPanelRegistrations";
