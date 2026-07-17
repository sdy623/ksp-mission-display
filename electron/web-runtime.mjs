import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const LOOPBACK = "127.0.0.1";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function clientFileForRequest(clientDir, rawUrl) {
  if (!rawUrl) return null;

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://kmd.local").pathname);
  } catch {
    return null;
  }

  if (pathname === "/" || pathname.includes("\0")) return null;

  const candidate = path.resolve(clientDir, `.${pathname}`);
  const clientPrefix = `${path.resolve(clientDir)}${path.sep}`;
  if (!candidate.startsWith(clientPrefix)) return null;

  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

function serveClientFile(clientDir, request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const filePath = clientFileForRequest(clientDir, request.url);
  if (!filePath) return false;

  const size = statSync(filePath).size;
  const extension = path.extname(filePath).toLowerCase();
  const cacheControl = filePath.startsWith(`${path.join(clientDir, "assets")}${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600";

  response.writeHead(200, {
    "Cache-Control": cacheControl,
    "Content-Length": String(size),
    "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });

  if (request.method === "HEAD") {
    response.end();
  } else {
    const stream = createReadStream(filePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }
  return true;
}

function proxyToVinext(request, response, innerPort) {
  const upstream = http.request(
    {
      hostname: LOOPBACK,
      port: innerPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `${LOOPBACK}:${innerPort}` },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", (error) => {
    console.error("[kmd] Local web proxy failed", error);
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("KSP Mission Display local server unavailable");
  });
  request.pipe(upstream);
}

export async function startDesktopWebServer({ standaloneRoot, host = LOOPBACK, port = 3000 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid web server port: ${port}`);
  }

  const outDir = path.join(standaloneRoot, "dist");
  const clientDir = path.join(outDir, "client");
  const rscEntry = path.join(outDir, "server", "index.js");
  if (!existsSync(rscEntry)) throw new Error(`Packaged renderer is missing: ${rscEntry}`);

  const requiredRuntimePackages = ["react", "react-dom", "scheduler"];
  const missingRuntimePackages = requiredRuntimePackages.filter(
    (packageName) => !existsSync(path.join(standaloneRoot, "node_modules", packageName, "package.json")),
  );
  if (missingRuntimePackages.length > 0) {
    throw new Error(
      `Packaged renderer dependencies are missing: ${missingRuntimePackages.join(", ")}. ` +
        `Expected them under ${path.join(standaloneRoot, "node_modules")}`,
    );
  }

  const vinext = await startProdServer({
    port: 0,
    host: LOOPBACK,
    outDir,
    purpose: "KMD renderer",
  });

  const server = http.createServer((request, response) => {
    if (serveClientFile(clientDir, request, response)) return;
    proxyToVinext(request, response, vinext.port);
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await closeServer(vinext.server);
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`[kmd] Desktop web server listening on http://${host}:${actualPort}`);

  return {
    port: actualPort,
    async close() {
      await Promise.all([closeServer(server), closeServer(vinext.server)]);
    },
  };
}
