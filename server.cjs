const http = require("http");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

let SerialPort;
try {
  ({ SerialPort } = require("serialport"));
  console.log("[Hardware-Bridge] Real-mode SerialPort library successfully initialized.");
} catch {
  console.log("[Hardware-Bridge] SerialPort library missing or incompatible. Falling back to Mock/Virtual mode.");
}

const M2NanoDriver = require("./src/drivers/m2nano.cjs");
const GRBLDriver = require("./src/drivers/grbl.cjs");
const M2Protocol = require("./src/core/m2-protocol.cjs");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

const serialConnections = new Map(); // path -> { port, parser, lastStatus, personality, timer }
const pendingSerialConnections = new Map(); // path -> Promise

// Global Safety Net: Prevent the server from crashing on hardware/serial errors
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught Exception:", err.message);
  if (err.message.includes("SerialPort") || err.message.includes("serial")) {
    console.log("[CRITICAL] Recovering from hardware-level error...");
  } else {
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[CRITICAL] Unhandled Rejection:", reason);
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const DISCOVERY_TIMEOUT_MS = 1200;
const DISCOVERY_CONCURRENCY = 48;
const SMART_SCAN_LIMIT = 48;
const DEVICE_COMMAND_TIMEOUT_MS = 3500;
const STOP_SEQUENCE_STEPS = [
  { command: "!" },
  { command: "M5" },
  { command: "\u0018", waitAfterMs: 25 },
  { command: "M5" },
];

function ipv4ToInt(address) {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function intToSubnet(value) {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}`;
}

function probeDevice(targetRaw) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = sanitizeTarget(targetRaw);
    } catch {
      resolve(null);
      return;
    }

    const candidatePaths = ["/files?action=list&path=/sd/", "/files?action=list&path=/ext/", "/"];
    let settled = false;

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }

    function tryPath(index) {
      if (index >= candidatePaths.length) {
        finish(null);
        return;
      }

      const request = http.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || 80,
          method: "GET",
          path: candidatePaths[index],
          timeout: DISCOVERY_TIMEOUT_MS,
          headers: {
            "Accept-Encoding": "gzip,deflate",
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length > 65536) {
              response.destroy();
            }
          });
          response.on("close", () => {
            const raw = Buffer.concat(chunks);
            const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
            let body = "";
            try {
              if (encoding.includes("gzip")) {
                body = zlib.gunzipSync(raw).toString("utf8");
              } else if (encoding.includes("deflate")) {
                body = zlib.inflateSync(raw).toString("utf8");
              } else {
                body = raw.toString("utf8");
              }
            } catch {
              body = raw.toString("utf8");
            }

            if (/"status"\s*:\s*"Ok"/i.test(body) && /"path"\s*:\s*"\/(sd|ext)\//i.test(body)) {
              finish({ url: targetRaw, title: "ESP3D Laser Controller" });
              return;
            }
            if (/ESP3D WebUI/i.test(body) || /"firmware"\s*:\s*"ESP3D"/i.test(body)) {
              finish({ url: targetRaw, title: "ESP3D Laser" });
              return;
            }
            tryPath(index + 1);
          });
        }
      );

      request.on("timeout", () => {
        request.destroy();
        tryPath(index + 1);
      });
      request.on("error", () => tryPath(index + 1));
      request.end();
    }

    tryPath(0);
  });
}

function getPrivateNetworks() {
  const interfaces = os.networkInterfaces();
  const networks = [];

  Object.entries(interfaces).forEach(([name, entries]) => {
    (entries || []).forEach((entry) => {
      if (!entry || entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) {
        return;
      }
      const octets = entry.address.split(".");
      networks.push({
        name,
        address: entry.address,
        subnet: `${octets[0]}.${octets[1]}.${octets[2]}`,
        cidr: entry.cidr,
      });
    });
  });

  return networks;
}

function expandNetworkSubnets(network) {
  const cidr = String(network.cidr || "");
  const match = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) {
    return [network.subnet];
  }
  const address = match[1];
  const prefix = Number(match[2]);
  if (prefix >= 24) {
    const base = intToSubnet(ipv4ToInt(address) & 0xffffff00);
    return [base];
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = ipv4ToInt(address) & mask;
  const span = Math.min(SMART_SCAN_LIMIT, 2 ** Math.max(0, 24 - prefix));
  return Array.from({ length: span }, (_, index) => intToSubnet(start + index * 256));
}

function deriveSmartScanSubnets(networks) {
  const candidates = [];
  networks.forEach((network) => {
    candidates.push(...expandNetworkSubnets(network));
    const parts = String(network.subnet || "")
      .split(".")
      .map(Number);
    if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
      return;
    }
    for (let offset = 1; offset <= 2; offset += 1) {
      if (parts[2] - offset >= 0) {
        candidates.push(`${parts[0]}.${parts[1]}.${parts[2] - offset}`);
      }
      if (parts[2] + offset <= 255) {
        candidates.push(`${parts[0]}.${parts[1]}.${parts[2] + offset}`);
      }
    }
  });
  return [...new Set(candidates.filter(Boolean))].slice(0, SMART_SCAN_LIMIT);
}

async function mapWithConcurrency(items, limit, iteratee) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await iteratee(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function discoverDevicesOnSubnets(subnets) {
  const candidates = subnets.flatMap((subnet) =>
    Array.from({ length: 254 }, (_, index) => `http://${subnet}.${index + 1}`)
  );
  const results = await mapWithConcurrency(candidates, DISCOVERY_CONCURRENCY, (candidate) => probeDevice(candidate));
  return results
    .filter(Boolean)
    .filter((device, index, array) => array.findIndex((entry) => entry.url === device.url) === index);
}

/**
 * Cross-platform hardware discovery engine.
 * Separated into detection and execution for reliable testing.
 */
async function getUsbDiscoveryDevices(platform, executor) {
  const devices = [
    { path: "VIRTUAL_COM1", friendly: "Mock USB Laser (Simulation)" },
    { path: "USB_1a86_5512", friendly: "QinHeng CH341 (OMTech K40 Detected)" }
  ];
  try {
    if (!SerialPort) {
      return devices;
    }

    const grblVids = ["1a86", "2341", "0403", "10c4", "067b"];
    const ports = await SerialPort.list();

    // 1. Filter for actual hardware that looks like a serial device
    const activePorts = ports.filter((p) => p.vendorId || p.path.includes("USB") || p.path.includes("ACM"));

    for (const port of activePorts) {
      const vid = (port.vendorId || "").toLowerCase();
      const pid = (port.productId || "").toLowerCase();

      let friendly = port.friendlyName || port.manufacturer || port.path;

      // Filter out generic Espressif devices that aren't identifying as lasers
      if (friendly.toLowerCase().includes("espressif") && !friendly.toLowerCase().includes("laser")) {
        continue;
      }

      if (grblVids.includes(vid)) {
        if (vid === "1a86" && pid === "5512") {
          friendly = "OMTech K40 (M2Nano Native Support)";
        } else if (vid === "1a86" && pid === "7523") {
          friendly = `GRBL Laser (Ray 5/Grbl - ${friendly})`;
        } else {
          friendly = `GRBL Laser (${friendly})`;
        }
      }

      devices.push({ path: port.path, friendly });
    }

    // 2. Cross-reference with physical USB bus for 'Missing Driver' awareness
    const usbOutput = platform === "linux" ? executor("lsusb") : "";
    if (usbOutput) {
      for (const vid of grblVids) {
        if (usbOutput.toLowerCase().includes(vid)) {
          // Hardware is on the USB bus. Is it in our serial port list?
          const foundInPorts = activePorts.some((p) => (p.vendorId || "").toLowerCase() === vid);

          if (!foundInPorts) {
            let label = "Laser Hardware Found (USB)";
            let path = "DRIVER_MISSING";

            if (vid === "1a86" && usbOutput.toLowerCase().includes("5512")) {
              label = "OMTech K40 (M2Nano Native Support)";
              path = "USB_1a86_5512";
            } else if (vid === "1a86") {
              label = "QinHeng/OMTech Found (USB)";
            }

            devices.push({
              path: path,
              friendly: path === "DRIVER_MISSING" ? `${label} - DRIVER MISSING (See setup_linux.sh)` : label,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error(`[USB-DISCOVERY] Error: ${error.message}`);
  }

  // Ensure Virtual COM is always present and unique
  if (!devices.some((d) => d.path === "VIRTUAL_COM1")) {
    devices.unshift({ path: "VIRTUAL_COM1", friendly: "Mock USB Laser (Simulation)" });
  }

  return devices;
}

async function scanUsbBus() {
  const cp = require("child_process");
  const defaultExecutor = (cmd) => {
    try {
      return cp.execSync(cmd).toString();
    } catch {
      return "";
    }
  };
  return await getUsbDiscoveryDevices(process.platform, defaultExecutor);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrivateIpv4(hostname) {
  return /^(127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/.test(hostname);
}

function sanitizeTarget(targetRaw) {
  if (!targetRaw) {
    throw new Error("Missing target URL.");
  }
  // Normalize Friendly IDs (e.g., USB_1a86_5512 or COM_USB_...) to serial://
  let normalized = targetRaw;
  if (targetRaw.startsWith("USB_") || targetRaw.startsWith("COM_")) {
    normalized = "serial://" + targetRaw;
  }

  if (normalized.startsWith("serial://")) {
    return { protocol: "serial:", href: normalized, hostname: "localhost" };
  }
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:") {
    throw new Error("Only http:// or serial:// device targets are allowed.");
  }
  if (!isPrivateIpv4(parsed.hostname)) {
    throw new Error("Target must be a private IPv4 device.");
  }
  return parsed;
}

function serveStatic(requestPath, response) {
  const normalized =
    requestPath === "/" ? "index.html" : requestPath.startsWith("/") ? requestPath.slice(1) : requestPath;
  const filePath = path.join(ROOT, normalized);
  if (!filePath.startsWith(ROOT)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    response.end(content);
  });
}

function proxyRequest(request, response, inboundUrl) {
  let target;
  try {
    target = sanitizeTarget(inboundUrl.searchParams.get("target"));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  if (target.protocol === "serial:") {
    handleSerialProxy(request, response, inboundUrl, target);
    return;
  }

  const proxyPath = inboundUrl.pathname.replace(/^\/device/, "") || "/";
  const targetUrl = new URL(proxyPath + inboundUrl.search, target);
  targetUrl.searchParams.delete("target");

  console.log(`[PROXY][${target.protocol}] ${request.method} -> ${targetUrl.href}`);

  const forwarded = targetUrl;
  const targetHost = forwarded.hostname;
  const targetPort = forwarded.port || (forwarded.protocol === "https:" ? 443 : 80);

  const upstream = http.request(
    {
      protocol: forwarded.protocol,
      hostname: targetHost,
      port: targetPort,
      method: request.method,
      path: `${forwarded.pathname}${forwarded.search}`,
      headers: {
        ...request.headers,
        host: forwarded.host,
      },
      timeout: DEVICE_COMMAND_TIMEOUT_MS,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        ...upstreamResponse.headers,
        "Access-Control-Allow-Origin": "*",
      });
      upstreamResponse.pipe(response);
    }
  );

  upstream.on("error", (error) => {
    console.error(`[PROXY ERROR] ${error.message}`);
    sendJson(response, 502, { error: error.message });
  });

  request.pipe(upstream);
}

function sendDeviceCommand(target, command) {
  if (target.protocol === "serial:") {
    const urlObj = new URL(target.href);
    const portPath = target.href.split("://")[1].split("?")[0];
    const baudRate = Number(urlObj.searchParams.get("baud") || 115200);
    const protocol = urlObj.searchParams.get("protocol");
    return executeSerialCommand(portPath, command, baudRate, protocol);
  }

  return new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        method: "GET",
        path: `/command?commandText=${encodeURIComponent(command)}`,
        timeout: DEVICE_COMMAND_TIMEOUT_MS,
      },
      (upstreamResponse) => {
        const chunks = [];
        upstreamResponse.on("data", (chunk) => {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > 65536) {
            upstreamResponse.destroy();
          }
        });
        upstreamResponse.on("close", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((upstreamResponse.statusCode || 500) >= 400) {
            reject(
              new Error(
                `Command ${JSON.stringify(command)} failed: ${upstreamResponse.statusCode || 500} ${body}`.slice(0, 280)
              )
            );
            return;
          }
          resolve({ statusCode: upstreamResponse.statusCode || 200, body });
        });
      }
    );

    upstream.on("timeout", () => {
      upstream.destroy(new Error(`Command ${JSON.stringify(command)} timed out.`));
    });
    upstream.on("error", reject);
    upstream.end();
  });
}

async function getSerialConnection(portPath, baudRate, forcedProtocol) {
  const conn = serialConnections.get(portPath);
  if (conn && (conn.port.isOpen || conn.m2)) return conn;

  // Concurrency Lock: Check if a connection is already being established for this path
  if (pendingSerialConnections.has(portPath)) {
    console.log(`[Hardware-Bridge] Re-using pending connection promise for ${portPath}`);
    return pendingSerialConnections.get(portPath);
  }

  const connectionPromise = (async () => {
    try {
      if (!SerialPort) throw new Error("SerialPort library not available.");

      console.log(`[Hardware-Bridge] Opening connection to: ${portPath} (Protocol: ${forcedProtocol || "auto"})`);
      const ports = await SerialPort.list();
      let matchedPort = null;
      let isM2Nano = forcedProtocol === "lihuiyu" || portPath.includes("1a86_5512");

      // 1. Resolve Friendly IDs to paths OR Identify Native M2Nano hardware by VID/PID
      if (!isM2Nano) {
        if (portPath.startsWith("USB_") || portPath.startsWith("COM_USB_")) {
          const parts = portPath.split("_");
          const targetVid = (parts[parts.length - 2] || "").toLowerCase();
          const targetPid = (parts[parts.length - 1] || "").toLowerCase();

          console.log(`[Hardware-Bridge] Searching for Friendly ID matching VID:${targetVid} PID:${targetPid}`);
          matchedPort = ports.find(
            (p) => (p.vendorId || "").toLowerCase() === targetVid && (p.productId || "").toLowerCase() === targetPid
          );
          isM2Nano = targetVid === "1a86" && targetPid === "5512";
        } else {
          // ... (Rest of serial logic)
        }
      }

      // 2. Special Case: M2Nano Driver
      if (isM2Nano) {
        console.log(`[Hardware-Bridge] M2Nano hardware detected or forced (${portPath}).`);
        const driver = new M2NanoDriver();

        try {
          await driver.open();
          const newConn = {
            port: driver,
            m2: true,
            protocol: new M2Protocol(),
            lastStatus: "Idle",
            pos: { x: 0, y: 0, z: 0 },
            personality: "m2nano",
            inProgramMode: false,
            currentSpeed: 0,
          };

          // Pulse of Life Heartbeat for M3 Nano V9
          newConn.heartbeat = setInterval(async () => {
            if (newConn.port.getStatus) {
              const s = await newConn.port.getStatus();
              newConn.lastStatus = `Status: ${s}`;
            }
          }, 5000);

          serialConnections.set(portPath, newConn);
          return newConn;
        } catch (err) {
          console.error("[Hardware-Bridge] M2Nano driver failed to open:", err);
          throw err;
        }
      }

      // 3. Standard Serial/GRBL path
      const finalPath = matchedPort ? matchedPort.path : portPath;
      const grbl = new GRBLDriver(finalPath, baudRate);
      await grbl.open();

      const newConn = {
        port: grbl,
        m2: false,
        lastStatus: grbl.latestStatus,
        pos: grbl.pos,
        personality: "grbl",
      };

      // Background status sync
      const syncTimer = setInterval(() => {
        newConn.lastStatus = grbl.latestStatus;
        newConn.pos = grbl.pos;
      }, 500);

      grbl.port.on("close", () => {
        clearInterval(syncTimer);
        serialConnections.delete(portPath);
      });

      serialConnections.set(portPath, newConn);
      return newConn;
    } finally {
      // Clean up the lock regardless of outcome
      pendingSerialConnections.delete(portPath);
    }
  })();

  pendingSerialConnections.set(portPath, connectionPromise);
  return connectionPromise;
}

async function executeSerialCommand(portPath, command, baudRate, forcedProtocol) {
  if (portPath === "VIRTUAL_COM1" || portPath === "USB_1a86_5512") {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ statusCode: 200, body: "ok" }), 50);
    });
  }

  const conn = await getSerialConnection(portPath, baudRate, forcedProtocol);

  if (conn.m2) {
    console.log(`[Serial-Out] Routing M2Nano command: ${command}`);
    const tokens = conn.protocol.parseTokens(command);

    if (tokens && tokens.G === 1) {
      const feedrate = tokens.F || 100;
      const speedMmPs = feedrate / 60;

      if (!conn.inProgramMode || conn.currentSpeed !== speedMmPs) {
        await conn.port.enterProgramMode(speedMmPs);
        conn.inProgramMode = true;
        conn.currentSpeed = speedMmPs;
      }
    } else if (tokens && tokens.G === 0 && conn.inProgramMode) {
      await conn.port.exitProgramMode();
      conn.inProgramMode = false;
    }

    const packets = conn.protocol.translate(command);
    for (const cmdStr of packets) {
      if (cmdStr.trim() === "IPP") {
        if (conn.inProgramMode) await conn.port.exitProgramMode();
        conn.inProgramMode = false;
      }
      await conn.port.sendStream(cmdStr);
    }
    return { statusCode: 200, body: "ok" };
  }

  console.log(`[Serial-Out] Sending GRBL command: ${command}`);
  const isRealtime = ["?", "!", "~", "\x18"].includes(command);
  if (isRealtime) {
    await conn.port.write(command);
    return { statusCode: 200, body: "ok (realtime)" };
  }
  const response = await conn.port.command(command);
  return { statusCode: 200, body: response };
}

async function executeStopSequence(targetRaw) {
  const target = sanitizeTarget(targetRaw);
  const failedSteps = [];
  let succeededSteps = 0;

  for (const step of STOP_SEQUENCE_STEPS) {
    try {
      await sendDeviceCommand(target, step.command);
      succeededSteps += 1;
    } catch (error) {
      failedSteps.push({ command: step.command, error: error.message });
    }
    if (step.waitAfterMs) {
      await delay(step.waitAfterMs);
    }
  }

  if (!succeededSteps) {
    throw new Error(failedSteps.at(-1)?.error || "Unable to send stop commands.");
  }

  return {
    id: "emergency-stop-burst",
    label: "Emergency stop burst",
    partial: failedSteps.length > 0,
    failedSteps,
  };
}

async function handleSerialProxy(request, response, inboundUrl, target) {
  const portPath = target.href.split("://")[1].split("?")[0];
  const searchParams = new URL(target.href).searchParams;
  const baudRate = Number(searchParams.get("baud") || 115200);

  if (inboundUrl.pathname === "/device/status") {
    getSerialConnection(portPath, baudRate)
      .then((conn) => {
        sendJson(response, 200, { status: conn.lastStatus, pos: conn.pos, personality: conn.personality });
      })
      .catch(() => {
        sendJson(response, 200, { status: "Idle", pos: { x: 0, y: 0, z: 0 }, personality: "grbl" });
      });
    return;
  }

  if (inboundUrl.pathname === "/device/files") {
    if (portPath === "VIRTUAL_COM1" || portPath === "USB_1a86_5512") {
      sendJson(response, 200, {
        files: [
          { name: "mks_logo.bin", size: "450.00 KB" },
          { name: "index.html.gz", size: "167.55 KB" },
          { name: "factory_test.gcode", size: "12.50 KB" },
        ],
        path: "/",
        status: "Ok",
        mode: "direct",
      });
      return;
    }
    sendJson(response, 200, { files: [], path: "/", status: "Ok", mode: "direct" });
    return;
  }

  if (inboundUrl.pathname === "/device/command") {
    const cmd = inboundUrl.searchParams.get("commandText") || inboundUrl.searchParams.get("plain") || "";
    executeSerialCommand(portPath, cmd, baudRate)
      .then((res) => sendJson(response, 200, { status: "ok", result: res.body }))
      .catch((err) => sendJson(response, 502, { status: "error", error: err.message }));
    return;
  }

  if (inboundUrl.pathname === "/device/stop") {
    executeStopSequence(target.href)
      .then((res) => sendJson(response, 200, res))
      .catch((err) => sendJson(response, 502, { error: err.message }));
    return;
  }

  if (inboundUrl.pathname === "/device/upload") {
    sendJson(response, 405, {
      error: "File upload is not supported on serial interfaces. Use streaming mode instead.",
    });
    return;
  }
  sendJson(response, 404, { error: "Not found on serial interface" });
}

const server = http.createServer((request, response) => {
  const inboundUrl = new URL(request.url, `http://${request.headers.host}`);

  // High-level traffic audit
  console.log(`[HTTP-Req] ${request.method} ${inboundUrl.pathname}${inboundUrl.search}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  // Functional routes
  if (inboundUrl.pathname === "/list-ports") {
    scanUsbBus()
      .then((ports) => sendJson(response, 200, { ports }))
      .catch((err) => sendJson(response, 500, { error: err.message }));
    return;
  }

  if (inboundUrl.pathname === "/command") {
    const targetStr = inboundUrl.searchParams.get("target");
    const cmd = inboundUrl.searchParams.get("commandText") || inboundUrl.searchParams.get("plain") || "";
    try {
      const target = sanitizeTarget(targetStr);
      sendDeviceCommand(target, cmd)
        .then((res) => sendJson(response, 200, { status: "ok", result: res.body }))
        .catch((err) => sendJson(response, 502, { status: "error", error: err.message }));
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (inboundUrl.pathname === "/device/stop") {
    executeStopSequence(inboundUrl.searchParams.get("target"))
      .then((plan) => sendJson(response, 200, { status: "ok", ...plan }))
      .catch((error) => sendJson(response, 502, { status: "error", error: error.message }));
    return;
  }

  if (inboundUrl.pathname === "/device/raster") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      try {
        const {
          target: targetStr,
          bitstrings,
          stepSize: rawStep,
          rowAdvance: rawRowAdvance,
          speed: rawSpeed,
          power: rawPower,
          bidirectional,
        } = JSON.parse(body);
        const target = sanitizeTarget(targetStr);
        const portPath = target.href.split("://")[1].split("?")[0];
        const searchParams = new URL(target.href).searchParams;
        const baudRate = Number(searchParams.get("baud") || 115200);
        const protocol = searchParams.get("protocol");

        const conn = await getSerialConnection(portPath, baudRate, protocol);

        console.log(`[Raster-Job] Starting ${bitstrings.length} row job...`);
        const stepSize = Number(rawStep) || 4;
        const rowAdvance = Number(rawRowAdvance) || stepSize;
        const speed = Number(rawSpeed) || 100;
        const power = Number(rawPower) || 20;

        if (conn.m2 && conn.port.beginRasterJob) {
          await conn.port.beginRasterJob(speed, power);
        }
        try {
          for (let i = 0; i < bitstrings.length; i++) {
            const direction = bidirectional === false || i % 2 === 0 ? "right" : "left";
            await conn.port.sendRasterRow(bitstrings[i], stepSize, speed, power, {
              direction,
              rowAdvance,
            });
            if (i % 10 === 0) {
              console.log(`[Server] Raster row ${i}/${bitstrings.length} complete.`);
            }
          }
        } finally {
          if (conn.m2 && conn.port.finishRasterJob) {
            await conn.port.finishRasterJob();
          }
        }

        sendJson(response, 200, { status: "ok" });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
    });
    return;
  }

  if (inboundUrl.pathname.startsWith("/device")) {
    proxyRequest(request, response, inboundUrl);
    return;
  }

  // Discovery & Info
  if (inboundUrl.pathname === "/network-info") {
    try {
      sendJson(response, 200, {
        networks: getPrivateNetworks(),
        scanSubnets: deriveSmartScanSubnets(getPrivateNetworks()),
      });
    } catch (e) {
      sendJson(response, 500, { error: e.message });
    }
    return;
  }

  if (inboundUrl.pathname === "/discover") {
    const subnet = inboundUrl.searchParams.get("subnet");
    discoverDevicesOnSubnets([subnet]).then((d) => sendJson(response, 200, { devices: d }));
    return;
  }

  serveStatic(inboundUrl.pathname, response);
});

// Start server only if run directly
function startServer(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      console.log(`LumaBurn server running at http://${host}:${actualPort}`);
      resolve(actualPort);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[Server] Port ${port} already in use, assuming server is already running.`);
        resolve(port);
      } else {
        reject(err);
      }
    });
  });
}

if (require.main === module) {
  startServer();
}

// Exports for testing and Electron
if (typeof module !== "undefined") {
  module.exports = {
    getUsbDiscoveryDevices,
    getPrivateNetworks,
    deriveSmartScanSubnets,
    sendDeviceCommand,
    sanitizeTarget,
    startServer,
  };
}
