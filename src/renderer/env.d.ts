/// <reference types="svelte" />
/// <reference types="vite/client" />

import type { ScraplyApi } from "../preload/index";

declare global {
  interface Window {
    scraply: ScraplyApi;
  }
}

export {};
