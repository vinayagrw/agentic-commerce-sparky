import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "@copilotkit/react-core/v2/styles.css";
import "./index.css";
import { PreferencesProvider } from "./shell/preferences";
import { router } from "./router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreferencesProvider>
      <RouterProvider router={router} />
    </PreferencesProvider>
  </StrictMode>,
);
