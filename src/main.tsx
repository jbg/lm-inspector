import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./goose/styles.css";
import "./app.css";

// goose dark mode: the .dark class on a root element switches the palette.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", media.matches);
applyTheme();
media.addEventListener("change", applyTheme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
