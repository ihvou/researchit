import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ResearchitRoot from "./ResearchitRoot.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ResearchitRoot />
  </StrictMode>
);
