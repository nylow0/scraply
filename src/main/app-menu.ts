import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { IPC_CHANNELS } from "../shared/ipc";
type Command = "new-research" | "settings" | "toggle-sidebar" | "back" | "forward" | "export-research";

// The menu bar is never shown; the menu exists so its accelerators work (Ctrl+N, Ctrl+B, Alt+Left, zoom).
export function installApplicationMenu(window: BrowserWindow) {
  const command = (label: string, action: Command, accelerator?: string): MenuItemConstructorOptions => ({
    label, ...(accelerator ? { accelerator } : {}), click: () => window.webContents.send(IPC_CHANNELS.APP_COMMAND, action),
  });
  const template: MenuItemConstructorOptions[] = [
    { label: "File", submenu: [
      command("New research", "new-research", "CmdOrCtrl+N"),
      command("Export research JSON", "export-research", "CmdOrCtrl+Shift+E"),
      { type: "separator" }, command("Settings", "settings", "CmdOrCtrl+,"),
      { type: "separator" }, { role: "close" },
    ] },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ] },
    { label: "View", submenu: [
      command("Toggle sidebar", "toggle-sidebar", "CmdOrCtrl+B"),
      command("Back", "back", "Alt+Left"), command("Forward", "forward", "Alt+Right"),
      { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  window.setMenuBarVisibility(false);
}
