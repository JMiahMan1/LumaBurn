import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

process.env.LUMABURN_INCLUDE_VIRTUAL_SERIAL = "1";
const require = createRequire(import.meta.url);
const server = require("../server.cjs");

test("USB Discovery: Unified Detection (Async)", async (t) => {
  // Use the internal getUsbDiscoveryDevices with a simulated environment
  const devices = await server.getUsbDiscoveryDevices("linux", () => "");

  assert.ok(Array.isArray(devices), "Should return an array");
  assert.ok(
    devices.some((d) => d.path === "VIRTUAL_COM1"),
    "Should always include Virtual COM"
  );
  // We don't assert exact length here because it depends on the host environment's serialport listing
  // unless we perform a deeper monkey-patch of the required module.
});

test("USB Discovery: Failure Handling (Async)", async () => {
  const devices = await server.getUsbDiscoveryDevices("linux", () => {
    throw new Error("Fail");
  });
  assert.ok(
    devices.length >= 1,
    "With LUMABURN_INCLUDE_VIRTUAL_SERIAL, failure fallback should still list the virtual COM simulation"
  );
});
