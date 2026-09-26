import "@fontsource-variable/plus-jakarta-sans";
import "./app.css";
import App from "./App.svelte";
import { mount } from "svelte";

if (import.meta.env.DEV && import.meta.env.VITE_SCRAPLY_BROWSER_DEV === "1") {
  const { installBrowserApi } = await import("./browser-api");
  installBrowserApi();
}

// Focus rings are for keyboard navigation. Chromium also draws one when a dialog or panel opened with the mouse
// hands focus back to its trigger after Escape, and on every clicked text field. The last way the user moved
// around is kept on <html> so app.css can hide rings while it is the pointer; Tab and arrow keys bring them back.
const navigationKeys = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
window.addEventListener("pointerdown", () => { document.documentElement.dataset.input = "pointer"; }, { capture: true });
window.addEventListener("keydown", (event) => {
  if (navigationKeys.has(event.key)) document.documentElement.dataset.input = "keyboard";
}, { capture: true });

const target = document.getElementById("app");

if (!target) {
  throw new Error("Renderer root element was not found.");
}

mount(App, { target });
