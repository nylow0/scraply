import "@fontsource-variable/plus-jakarta-sans";
import "./app.css";
import App from "./App.svelte";
import { mount } from "svelte";

if (import.meta.env.DEV && import.meta.env.VITE_SCRAPLY_BROWSER_DEV === "1") {
  const { installBrowserApi } = await import("./browser-api");
  installBrowserApi();
}

const target = document.getElementById("app");

if (!target) {
  throw new Error("Renderer root element was not found.");
}

mount(App, { target });
