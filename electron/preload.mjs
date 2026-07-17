import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("kmdDesktop", Object.freeze({
  platform: process.platform,
  electron: process.versions.electron,
}));
