import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneRoot = path.join(projectRoot, "dist", "standalone");
const files = [
  [path.join(projectRoot, "electron", "standalone-server.mjs"), path.join(standaloneRoot, "server.js")],
  [path.join(projectRoot, "electron", "web-runtime.mjs"), path.join(standaloneRoot, "web-runtime.mjs")],
];

await mkdir(standaloneRoot, { recursive: true });
for (const [source, destination] of files) await copyFile(source, destination);
console.log(`[kmd] Prepared Windows-safe standalone server: ${standaloneRoot}`);
