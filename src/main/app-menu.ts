import { Menu, dialog, app, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { IPC_CHANNELS } from "../shared/ipc";
type Command = "new-research" | "settings" | "toggle-sidebar" | "back" | "forward" | "export-research";
let menus: Partial<Record<"File" | "Edit" | "View" | "Help", Menu>> = {};

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
    { label: "Help", submenu: [
      { label: "Keyboard shortcuts", click: () => { void dialog.showMessageBox(window, {
        type: "info", title: "Keyboard shortcuts", message: "Scraply shortcuts",
        detail: "Ctrl+N   New research\nCtrl+K   Find research\nCtrl+B   Toggle sidebar\nAlt+Left / Right   Back / Forward\nCtrl+,   Settings\nCtrl+Shift+E   Export research",
      }); } },
      { label: "About Scraply", click: () => { void dialog.showMessageBox(window, {
        type: "info", title: "About Scraply", message: `Scraply ${app.getVersion()}`, detail: "Local research and idea exploration.",
      }); } },
    ] },
  ];
  const menu = Menu.buildFromTemplate(template);
  menus = Object.fromEntries(menu.items.map((item) => [item.label, item.submenu]));
  Menu.setApplicationMenu(menu);
  window.setMenuBarVisibility(false);
}

export function showApplicationMenu(window: BrowserWindow, name: keyof typeof menus, x: number, y: number) {
  const zoom = window.webContents.getZoomFactor();
  menus[name]?.popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom) });
}
