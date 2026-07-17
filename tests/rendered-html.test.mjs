import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { startDesktopWebServer } from "../electron/web-runtime.mjs";

const templateRoot = new URL("../", import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let runtime;

// Keep the offline fallback assertion deterministic even when the user's real
// kRPC backend happens to be running on its normal port during the test.
process.env.KMD_BACKEND_URL = "http://127.0.0.1:1";

before(async () => {
  runtime = await startDesktopWebServer({
    standaloneRoot: path.join(projectRoot, "dist", "standalone"),
    host: "127.0.0.1",
    port: 0,
  });
});

after(async () => {
  await runtime?.close();
});

async function render(pathname) {
  return fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
    headers: { accept: "text/html" },
  });
}

test("server-renders mission creation as the application entry", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /KSP MISSION DISPLAY/i);
  assert.match(html, /CREATE FLIGHT MISSION/i);
  assert.match(html, /STAGE &amp; EVENT DEFINITIONS/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("server-renders all prototype surfaces", async () => {
  const cases = [
    ["/broadcast", /WAITING FOR KRPC/i],
    ["/mission-setup", /CREATE FLIGHT MISSION/i],
    ["/fdo", /ASCENT OPERATIONS/i],
    ["/mission-planner", /GEO SLOT INSERTION/i],
    ["/geo-window", /GEO SLOT INSERTION/i],
  ];

  for (const [pathname, expected] of cases) {
    const response = await render(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(await response.text(), expected);
  }
});

test("prototype source no longer contains the disposable starter", async () => {
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(new URL("app/_sites-preview", templateRoot)));
});

test("telemetry API marks the offline fallback instead of pretending kRPC is live", async () => {
  const response = await render("/api/telemetry?mission_profile=GEO_SLOT");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-kmd-telemetry-source"), "simulated-fallback");

  const snapshot = await response.json();
  assert.equal(snapshot.source, "simulated");
  assert.equal(snapshot.mission_profile, "GEO_SLOT");
  assert.equal(snapshot.quality.connection, "simulated");
});
