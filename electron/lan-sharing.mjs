const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function parseBooleanSetting(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

export function isPrivateIpv4(address) {
  if (typeof address !== "string") return false;
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function privateLanAddresses(interfaces) {
  const addresses = [];
  for (const records of Object.values(interfaces ?? {})) {
    for (const record of records ?? []) {
      const ipv4 = record.family === "IPv4" || record.family === 4;
      if (ipv4 && !record.internal && isPrivateIpv4(record.address)) addresses.push(record.address);
    }
  }
  return [...new Set(addresses)].sort((left, right) => left.localeCompare(right));
}

export function lanDisplayUrls(interfaces, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  return privateLanAddresses(interfaces).map((address) => `http://${address}:${port}`);
}

export function withoutLanSwitches(args) {
  return args.filter((argument) => argument !== "--lan" && argument !== "--no-lan");
}
