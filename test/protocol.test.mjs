import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sanitizeTarget, sendDeviceCommand } = require("../server.cjs");

test("Protocol Audit: Target Sanitization", () => {
  // Test IP Target
  const ipTarget = sanitizeTarget("http://192.168.1.10");
  assert.strictEqual(ipTarget.protocol, "http:");
  assert.strictEqual(ipTarget.hostname, "192.168.1.10");

  // Test USB/Serial Target
  const serialTarget = sanitizeTarget("serial://VIRTUAL_COM1");
  assert.strictEqual(serialTarget.protocol, "serial:");
  assert.strictEqual(serialTarget.href, "serial://VIRTUAL_COM1");

  // Test Security Rejection (Non-Private IP)
  assert.throws(() => sanitizeTarget("http://google.com"), /Target must be a private IPv4 device/);

  // Test Protocol Rejection
  assert.throws(() => sanitizeTarget("ftp://192.168.1.10"), /Only http:\/\/ or serial:\/\/ device targets are allowed/);
});

test("Protocol Audit: Branching Dispatcher", async (t) => {
  // We mock the internals by checking how they react to target types.
  // Note: Since we exported sendDeviceCommand, we can verify its protocol check.

  await t.test("Dispatches serial protocol correctly", async () => {
    const target = sanitizeTarget("serial://VIRTUAL_COM1");
    // This should call executeSerialCommand. In VIRTUAL mode, it returns 200/ok.
    const res = await sendDeviceCommand(target, "G21");
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("ok"));
  });

  await t.test("Rejects malformed targets in dispatcher", async () => {
    const target = { protocol: "ftp:", href: "ftp://192.168.1.10" };
    // This should naturally fail/throw if passed into the dispatcher because http module won't know ftp:
    try {
      await sendDeviceCommand(target, "G21");
      assert.fail("Should have failed with protocol error");
    } catch (err) {
      assert.ok(err.message.includes("Protocol") || err.message.includes("not supported"));
    }
  });
});
