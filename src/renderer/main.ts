import "./app.css";
import App from "./App.svelte";
import { mount } from "svelte";

const target = document.getElementById("app");

if (!target) {
  throw new Error("Renderer root element was not found.");
}

mount(App, { target });
