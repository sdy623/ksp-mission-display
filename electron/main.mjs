import { app, BrowserWindow, clipboard, dialog, Menu, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lanDisplayUrls, parseBooleanSetting, withoutLanSwitches } from "./lan-sharing.mjs";
import { startDesktopWebServer } from "./web-runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK = "127.0.0.1";
const BACKEND_PORT = Number.parseInt(process.env.KMD_BACKEND_PORT || "8021", 10);
const DEFAULT_WEB_PORT = 3011;
const START_PATH = process.env.KMD_START_PATH || "/mission-setup";
const SMOKE_TEST = process.env.KMD_SMOKE_TEST === "1";
const SCREENSHOT_PATH = process.env.KMD_SCREENSHOT_PATH || null;
const LAN_ENV_VALUE = parseBooleanSetting(process.env.KMD_EXPOSE_LAN);
const LAN_ENV_LOCKED = LAN_ENV_VALUE !== null;
const childProcesses = new Set();
const webRuntimes = new Set();

let mainWindow = null;
let shuttingDown = false;
let exposeLan = false;
let webPort = null;

if (SMOKE_TEST) {
  const smokeUserData =
    process.env.KMD_SMOKE_USER_DATA || path.join(os.tmpdir(), "ksp-mission-display-smoke", String(process.pid));
  app.setPath("userData", path.resolve(smokeUserData));
}

function logPath(name) {
  const directory = app.getPath("logs");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

function settingsPath() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

function readDesktopSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeDesktopSettings(settings) {
  const target = settingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function resolveLanSharing() {
  if (LAN_ENV_VALUE !== null) return LAN_ENV_VALUE;
  if (app.commandLine.hasSwitch("lan")) return true;
  if (app.commandLine.hasSwitch("no-lan")) return false;
  return readDesktopSettings().exposeLan === true;
}

function currentLanUrls() {
  return exposeLan && webPort ? lanDisplayUrls(os.networkInterfaces(), webPort) : [];
}

function relaunchWithLanPreference(enabled) {
  const settings = readDesktopSettings();
  writeDesktopSettings({ ...settings, exposeLan: enabled });
  const args = withoutLanSwitches(process.argv.slice(1));
  app.relaunch({ args });
  app.quit();
}

function installApplicationMenu() {
  const urls = currentLanUrls();
  const environmentNote = LAN_ENV_LOCKED ? " (controlled by KMD_EXPOSE_LAN)" : "";
  const template = [
    {
      label: "Server",
      submenu: [
        {
          label: `Expose display to local network${environmentNote}`,
          type: "checkbox",
          checked: exposeLan,
          enabled: !LAN_ENV_LOCKED,
          click: (item) => relaunchWithLanPreference(item.checked),
        },
        { type: "separator" },
        {
          label: "Show LAN address...",
          enabled: urls.length > 0,
          click: () => {
            const options = {
              type: "info",
              title: "KSP Mission Display LAN sharing",
              message: "Open one of these addresses on another device:",
              detail: `${urls.join("\n")}\n\nTelemetry API/WebSocket: port ${BACKEND_PORT}\nNo authentication is enabled; use only on a trusted network.`,
            };
            void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
          },
        },
        {
          label: "Copy LAN address",
          enabled: urls.length > 0,
          click: () => clipboard.writeText(urls.join("\n")),
        },
        { type: "separator" },
        {
          label: exposeLan ? "LAN sharing is ON (read-only telemetry)" : "LAN sharing is OFF",
          enabled: false,
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function spawnLogged(command, args, options, logName) {
  const output = fs.openSync(logPath(logName), "a");
  let outputClosed = false;
  const closeOutput = () => {
    if (outputClosed) return;
    outputClosed = true;
    fs.closeSync(output);
  };
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ["ignore", output, output],
    ...options,
  });
  childProcesses.add(child);
  child.once("exit", () => {
    childProcesses.delete(child);
    closeOutput();
  });
  child.once("error", () => {
    childProcesses.delete(child);
    closeOutput();
  });
  return child;
}

function httpReady(url, timeoutMs = 900) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode != null && response.statusCode < 500);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpReady(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function reservePort(preferredPort, host = LOOPBACK) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.once("error", reject);
      fallback.listen(0, host, () => {
        const address = fallback.address();
        const port = typeof address === "object" && address ? address.port : preferredPort;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(preferredPort, host, () => {
      server.close(() => resolve(preferredPort));
    });
  });
}

function appRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
}

function backendRoot() {
  return path.join(appRoot(), "backend");
}

function pythonCommand() {
  const candidates = [
    path.join(path.resolve(__dirname, ".."), ".venv", "Scripts", "python.exe"),
    process.env.KMD_PYTHON,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "miniconda3", "envs", "ksp", "python.exe")
      : null,
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local", "miniconda3", "envs", "ksp", "python.exe")
      : null,
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function startBackendIfNeeded() {
  const healthUrl = `http://${LOOPBACK}:${BACKEND_PORT}/health`;
  if (await httpReady(healthUrl)) {
    if (!exposeLan) return;
    const addresses = lanDisplayUrls(os.networkInterfaces(), BACKEND_PORT);
    const checks = await Promise.all(addresses.map((url) => httpReady(`${url}/health`)));
    if (addresses.length === 0 || checks.some(Boolean)) {
      return;
    }
    throw new Error(
      `Port ${BACKEND_PORT} is already used by a loopback-only telemetry backend. Stop that backend and restart KSP Mission Display to enable LAN sharing.`,
    );
  }

  const root = backendRoot();
  const frozenBackend = path.join(root, "kmd-backend.exe");
  const backendHost = exposeLan ? "0.0.0.0" : LOOPBACK;

  if (app.isPackaged) {
    if (!fs.existsSync(frozenBackend)) {
      throw new Error(`Packaged telemetry backend is missing: ${frozenBackend}`);
    }

    spawnLogged(
      frozenBackend,
      [],
      {
        cwd: root,
        env: {
          ...process.env,
          KMD_BACKEND_HOST: backendHost,
          KMD_BACKEND_PORT: String(BACKEND_PORT),
          // The desktop API must become ready even when KSP/kRPC is offline.
          // Telemetry WebSockets reconnect on demand after the UI is loaded.
          KMD_KRPC_AUTO_CONNECT: "0",
        },
      },
      "kmd-backend.log",
    );

    if (!(await waitForHttp(healthUrl, 20_000))) {
      throw new Error(`Packaged telemetry backend did not become ready: ${healthUrl}`);
    }
    return;
  }

  const python = pythonCommand();
  if (!python || !fs.existsSync(path.join(root, "kmd", "app.py"))) return;

  const dependencyRoot = path.join(root, ".deps");
  const pythonPath = [dependencyRoot, root, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(path.delimiter);

  spawnLogged(
    python,
    ["-m", "uvicorn", "kmd.app:app", "--host", backendHost, "--port", String(BACKEND_PORT)],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        KMD_BACKEND_HOST: backendHost,
        KMD_BACKEND_PORT: String(BACKEND_PORT),
        KMD_KRPC_AUTO_CONNECT: "0",
      },
    },
    "kmd-backend.log",
  );
}

async function startWebApplication() {
  const developmentUrl = process.env.ELECTRON_START_URL;
  if (developmentUrl) {
    if (!(await waitForHttp(developmentUrl, 20_000))) {
      throw new Error(`Development server did not become ready: ${developmentUrl}`);
    }
    return {
      windowUrl: new URL(START_PATH, developmentUrl).toString(),
      port: Number.parseInt(new URL(developmentUrl).port, 10) || 80,
    };
  }

  const standaloneRoot = path.join(process.resourcesPath, "standalone");
  const webHost = exposeLan ? "0.0.0.0" : LOOPBACK;
  const port = await reservePort(DEFAULT_WEB_PORT, webHost);
  const runtime = await startDesktopWebServer({ standaloneRoot, host: webHost, port });
  webRuntimes.add(runtime);
  const origin = `http://${LOOPBACK}:${runtime.port}`;

  if (!(await waitForHttp(origin, 20_000))) {
    throw new Error(`Packaged web server did not become ready: ${origin}`);
  }
  return {
    windowUrl: new URL(START_PATH, origin).toString(),
    port: runtime.port,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "KSP Mission Display",
    width: 1600,
    height: 1000,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: "#03080d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  if (!SMOKE_TEST) mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    if (target.hostname !== LOOPBACK && target.hostname !== "localhost") {
      event.preventDefault();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showStartupError(window, error) {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof Error ? error.stack || error.message : String(error);
  try {
    fs.appendFileSync(logPath("kmd-web.log"), `[${new Date().toISOString()}] ${details}\n`, "utf8");
  } catch {
    // The on-screen error remains available if the log directory is unavailable.
  }
  const html = `<!doctype html><meta charset="utf-8"><title>KMD startup error</title>
    <style>body{background:#03080d;color:#d8e8f0;font:14px Consolas,monospace;padding:48px}h1{color:#ffb245;font-size:22px}pre{white-space:pre-wrap;color:#ff8090;border:1px solid #492934;padding:18px}</style>
    <h1>KSP MISSION DISPLAY / STARTUP ERROR</h1><p>The desktop shell could not start its local display server.</p><pre>${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (SMOKE_TEST) {
    process.exitCode = 1;
    setTimeout(() => app.quit(), 100);
  } else {
    window.show();
  }
}

function stopChildren() {
  shuttingDown = true;
  for (const runtime of webRuntimes) void runtime.close();
  webRuntimes.clear();
  for (const child of childProcesses) {
    try {
      child.kill();
    } catch {
      // The process may have already exited.
    }
  }
  childProcesses.clear();
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    exposeLan = resolveLanSharing();
    installApplicationMenu();
    const window = createWindow();
    try {
      await startBackendIfNeeded();
      const webApplication = await startWebApplication();
      webPort = webApplication.port;
      installApplicationMenu();
      await window.loadURL(webApplication.windowUrl);
      if (SCREENSHOT_PATH) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const screenshot = await window.webContents.capturePage();
        fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
        fs.writeFileSync(SCREENSHOT_PATH, screenshot.toPNG());
        app.quit();
      } else if (SMOKE_TEST) {
        setTimeout(() => app.quit(), 300);
      }
    } catch (error) {
      showStartupError(window, error);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !shuttingDown) createWindow();
  });
  app.on("before-quit", stopChildren);
  app.on("window-all-closed", () => app.quit());
}
