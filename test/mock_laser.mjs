import http from "http";

/**
 * Polymorphic Mock Laser Controller
 * Simulates MKS DLC32 (Ray 5), FluidNC (OMTech Polar Upgrades), and Generic Grbl.
 */

const PORT = process.env.MOCK_PORT || 0;

const state = {
  personality: "mks", // 'mks' or 'fluidnc'
  status: "Idle",
  files: [
    { name: "mks_logo.bin", size: "450.00 KB" },
    { name: "index.html.gz", size: "167.55 KB" },
    { name: "factory_test.gcode", size: "12.50 KB" },
  ],
  lastCommand: "",
  uploadCount: 0,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(`[MOCK][${state.personality}] ${req.method} ${req.url}`);

  // Personality Switching (Test Control)
  if (url.pathname.startsWith("/personality/")) {
    state.personality = url.pathname.split("/").pop();
    res.writeHead(200);
    res.end(JSON.stringify({ personality: state.personality }));
    return;
  }

  // File Listing
  const isMksList = url.pathname === "/files" && url.searchParams.get("action") === "list";
  const isFluidList = url.pathname === "/files" && url.searchParams.has("path") && !url.searchParams.has("action");

  if (isMksList || isFluidList) {
    const pathValue = url.searchParams.get("path") || "/";
    res.writeHead(200, { "Content-Type": "application/json" });

    // Ray 5 / MKS Reality: Files are typically on /sd/.
    const files = pathValue === "/" || pathValue === "" || pathValue === "/sd/" ? state.files : [];

    const response = {
      files: files,
      path: pathValue,
      status: "Ok",
    };
    res.end(JSON.stringify(response));
    return;
  }

  // Command Execution
  const mksCmd = url.pathname === "/command" && url.searchParams.get("commandText");
  const fluidCmd = url.pathname === "/command" && (url.searchParams.get("cmd") || url.searchParams.get("plain"));

  if (mksCmd || fluidCmd) {
    const cmd = mksCmd || fluidCmd;
    console.log(`   > EXEC: ${cmd}`);
    state.lastCommand = cmd;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  // Upload Simulation
  if (url.pathname === "/upload" && req.method === "POST") {
    state.uploadCount++;
    const filename = url.searchParams.get("filename") || "uploaded_file.gcode";
    if (!state.files.some((f) => f.name === filename)) {
      state.files.push({ name: filename, size: "1.00 KB" });
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  // Status (Standardized for LumaBurn proxy)
  if (url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const status =
      state.personality === "fluidnc"
        ? { status: { state: state.status }, pos: [0, 0, 0] }
        : { status: state.status, pos: { x: 0, y: 0, z: 0 }, files: state.files };
    res.end(JSON.stringify(status));
    return;
  }

  // Internal Audit
  if (url.pathname === "/test/audit") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }

  // Default
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h1>${state.personality.toUpperCase()} Simulator Active</h1>`);
});

server.listen(PORT, "127.0.0.1", () => {
  const actualPort = server.address().port;
  console.log(`Longer Ray 5 Mock listening at http://127.0.0.1:${actualPort}`);
});
