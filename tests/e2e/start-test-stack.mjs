import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopWebServer } from "../../electron/web-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakePort = 18021;
const webPort = 13013;
const pythonPath = [
  path.join(projectRoot, "backend", ".deps"),
  path.join(projectRoot, "backend", "dist", "kmd-backend", "_internal"),
  path.join(projectRoot, "backend"),
  process.env.PYTHONPATH,
].filter(Boolean).join(path.delimiter);
const logs = [];

const projectPython = path.join(projectRoot, ".venv", "Scripts", "python.exe");
const fallbackPython = path.join(process.env.LOCALAPPDATA ?? "", "miniconda3", "envs", "ksp", "python.exe");
const python = process.env.KMD_PYTHON ?? (existsSync(projectPython) ? projectPython : fallbackPython);
if (!existsSync(python)) throw new Error("Python 3.11 fake-backend interpreter not found. Set KMD_PYTHON.");

const fake = spawn(python, [
  "-m", "uvicorn", "kmd.fake_server:app",
  "--host", "127.0.0.1", "--port", String(fakePort), "--log-level", "warning",
], {
  cwd: projectRoot,
  env: { ...process.env, PYTHONPATH: pythonPath },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
fake.stdout.on("data", (chunk) => logs.push(chunk.toString()));
fake.stderr.on("data", (chunk) => logs.push(chunk.toString()));

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fake.exitCode !== null) throw new Error(`Fake backend exited early (${fake.exitCode})\n${logs.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fake backend did not become ready\n${logs.join("")}`);
}

await waitFor(`http://127.0.0.1:${fakePort}/health`);
process.env.KMD_BACKEND_URL = `http://127.0.0.1:${fakePort}`;
const runtime = await startDesktopWebServer({
  standaloneRoot: path.join(projectRoot, "dist", "standalone"),
  host: "127.0.0.1",
  port: webPort,
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.close();
  fake.kill();
  process.exit(0);
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
process.on("uncaughtException", async (error) => {
  console.error(error);
  await close();
});

await new Promise(() => {});
