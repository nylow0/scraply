import "@testing-library/svelte/vitest";

// jsdom does not implement modal dialogs; packaged Electron tests cover focus and Escape.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
