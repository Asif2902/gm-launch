import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";

// Self-hosted rather than linked from Google Fonts: this is a static SPA that should deploy
// anywhere and make no third-party request on load. Variable weights, so both families cost one
// file each regardless of how many weights the UI uses.
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Opt into the v7 behaviours now — both are already correct for this app, and taking them
        early means the eventual upgrade is a version bump rather than a migration. */}
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
