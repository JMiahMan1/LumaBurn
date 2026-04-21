const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

// Start the internal expressive server which handles proxying to ESP3D devices
const { startServer } = require("./server.cjs");
startServer();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "LumaBurn",
    icon: path.join(__dirname, "assets", "icon.png"), // We will need an icon
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // We are loading from localhost so webSecurity is maintained, but
      // we don't need local file restrictions because the server serves it.
    },
  });

  // Since server.js starts on process.env.PORT or 8080
  const port = Number(process.env.PORT || 8080);
  mainWindow.loadURL(`http://localhost:${port}`);

  // Hide custom menu bar for a cleaner desktop feel
  mainWindow.setMenuBarVisibility(false);

  // Open external links in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Ensure single instance (skip when developing alongside an installed copy, e.g. /opt/LumaBurn)
const gotTheLock = process.env.LUMABURN_ALLOW_SECOND_INSTANCE === "1" || app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
