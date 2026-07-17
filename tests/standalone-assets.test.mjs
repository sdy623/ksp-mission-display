import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Standalone server exited early (${child.exitCode})\n${logs.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Standalone server did not become ready\n${logs.join("")}`);
}

test("standalone package serves every browser asset on Windows", async (t) => {
  const port = await reservePort();
  const standaloneRoot = path.join(projectRoot, "dist", "standalone");
  const logs = [];
  const child = spawn(process.execPath, [path.join(standaloneRoot, "server.js")], {
    cwd: standaloneRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  t.after(() => child.kill());

  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(`${origin}/fdo`, child, logs);

  const page = await fetch(`${origin}/fdo`);
  assert.equal(page.status, 200);
  const html = await page.text();
  const assetPaths = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  const uniqueAssets = [...new Set(assetPaths)];

  assert.ok(uniqueAssets.some((asset) => asset.endsWith(".css")), "rendered page must reference CSS");
  assert.ok(uniqueAssets.some((asset) => asset.endsWith(".js")), "rendered page must reference JavaScript");

  for (const assetPath of uniqueAssets) {
    const response = await fetch(`${origin}${assetPath}`);
    assert.equal(response.status, 200, assetPath);
    assert.ok(Number(response.headers.get("content-length")) > 0, assetPath);
  }

  const cssPath = uniqueAssets.find((asset) => asset.endsWith(".css"));
  const css = await fetch(`${origin}${cssPath}`);
  assert.match(css.headers.get("content-type") ?? "", /^text\/css\b/i);
  assert.ok((await css.text()).length > 10_000, "compiled CSS should not be an empty placeholder");
});
