import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "./index.css";
import App from "./App";
import { applyDefaultAppTheme } from "./theme/applyAppTheme";
import { ensureTerminalFontLoaded } from "./config/terminalFont";
import { initStoreOrchestrator } from "./store/rendererStoreOrchestrator";

applyDefaultAppTheme(document.documentElement);

const cleanupOrchestrator = initStoreOrchestrator();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupOrchestrator();
  });
}

ensureTerminalFontLoaded().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
