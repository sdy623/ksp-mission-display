import assert from "node:assert/strict";
import test from "node:test";
import {
  isPrivateIpv4,
  lanDisplayUrls,
  parseBooleanSetting,
  privateLanAddresses,
  withoutLanSwitches,
} from "../electron/lan-sharing.mjs";

test("LAN preference parsing is explicit and rejects ambiguous input", () => {
  assert.equal(parseBooleanSetting("1"), true);
  assert.equal(parseBooleanSetting("ON"), true);
  assert.equal(parseBooleanSetting("false"), false);
  assert.equal(parseBooleanSetting("0"), false);
  assert.equal(parseBooleanSetting("maybe"), null);
  assert.equal(parseBooleanSetting(undefined), null);
});

test("only RFC1918 IPv4 interfaces are advertised", () => {
  assert.equal(isPrivateIpv4("10.4.5.6"), true);
  assert.equal(isPrivateIpv4("172.31.2.3"), true);
  assert.equal(isPrivateIpv4("192.168.1.20"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("127.0.0.1"), false);
  assert.equal(isPrivateIpv4("203.0.113.4"), false);

  const interfaces = {
    Ethernet: [
      { family: "IPv4", internal: false, address: "192.168.1.20" },
      { family: "IPv6", internal: false, address: "fe80::1" },
    ],
    WiFi: [
      { family: 4, internal: false, address: "10.0.0.8" },
      { family: "IPv4", internal: false, address: "192.168.1.20" },
    ],
    Loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
  };
  assert.deepEqual(privateLanAddresses(interfaces), ["10.0.0.8", "192.168.1.20"]);
  assert.deepEqual(lanDisplayUrls(interfaces, 3011), [
    "http://10.0.0.8:3011",
    "http://192.168.1.20:3011",
  ]);
});

test("relaunch strips transient LAN command-line overrides", () => {
  assert.deepEqual(withoutLanSwitches([".", "--lan", "--inspect", "--no-lan"]), [".", "--inspect"]);
});
