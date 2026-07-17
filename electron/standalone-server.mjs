#!/usr/bin/env node

import { startDesktopWebServer } from "./web-runtime.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

startDesktopWebServer({
  standaloneRoot: import.meta.dirname,
  host,
  port,
})
  .then((runtime) => {
    const shutdown = () => void runtime.close();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })
  .catch((error) => {
    console.error("[kmd] Failed to start standalone desktop server");
    console.error(error);
    process.exit(1);
  });
