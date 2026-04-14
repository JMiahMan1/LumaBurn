3722:async function deviceFetch(pathname, options = {}) {
3723-  if (!state.device.url) throw new Error("Set a controller URL first.");
3724-
3725-  let url;
3726-  if (state.device.bridgeActive) {
3727-    url = new URL(`/device${pathname}`, window.location.origin);
3728-    url.searchParams.set("target", state.device.url);
3729-  } else {
3730-    // Manual Mode: Talk directly to target (subject to browser CORS)
3731-    const base = state.device.url.includes("://") ? state.device.url : `http://${state.device.url}`;
3732-    try {
3733-      let finalPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
3734-      
3735-      // Translate Proxy-style commands to Native FluidNC/ESP32-Grbl commands
3736-      if (finalPath.startsWith("/command")) {
3737-        const urlObj = new URL(finalPath, "http://temp.internal");
3738-        const commandText = urlObj.searchParams.get("commandText");
3739-        if (commandText) {
3740-          finalPath = `/command?args=${encodeURIComponent(commandText)}`;
3741-        }
3742-      }
3743-      
3744-      url = new URL(finalPath, base);
3745-    } catch (e) {
3746-      throw new Error(`Invalid controller URL: ${state.device.url}`);
3747-    }
3748-  }
3749-  const controller = new AbortController();
3750-  const timeout = window.setTimeout(() => controller.abort(), DEFAULT_DEVICE_TIMEOUT_MS);
3751-  let response;
3752-  try {
3753-    response = await fetch(url, { ...options, signal: controller.signal });
3754-  } catch (error) {
3755-    if (error?.name === "AbortError") {
3756-      throw new Error(`Device request timed out after ${Math.round(DEFAULT_DEVICE_TIMEOUT_MS / 1000)}s.`);
3757-    }
3758-    throw error;
3759-  } finally {
3760-    window.clearTimeout(timeout);
3761-  }
3762-  if (!response.ok) {
3763-    const detail = await response.text();
3764-    throw new Error(`Device request failed: ${response.status} ${detail}`.slice(0, 280));
3765-  }
3766-  return response;
3767-}
3768-
3769-async function readDeviceResponseText(response, action, { requirePositive = false } = {}) {
3770-  const text = (await response.text()).trim();
3771-  const inspection = inspectDeviceResponse(text);
3772-  // If no text, and HTTP status was OK, we treat it as a success unless strictly requirePositive with text
3773-  if (!text) {
3774-    if (requirePositive) {
3775-      // For starting jobs, an empty 200 OK is often better than failing.
3776-      return { text: "", inspection: { ok: true, confidence: "medium", summary: "Empty success" } };
3777-    }
3778-    return { text, inspection };
3779-  }
3780-  if (!inspection.ok && (requirePositive || inspection.confidence !== "low")) {
3781-    throw new Error(`${action}: ${inspection.summary}`.slice(0, 280));
3782-  }
3783-  return { text, inspection };
3784-}
3785-
3786-async function refreshDeviceFiles() {
3787-  try {
3788-    pushDeviceActivity("info", "Loading controller files", state.device.url || "No controller URL set.");
3789-    setDeviceState("Connecting", `Listing files from ${state.device.url}...`);
3790-    const candidatePaths = deviceStorageCandidates();
3791-    const listings = [];
3792-    for (const pathValue of candidatePaths) {
3793-      try {
3794-        const nextPayload = await (await deviceFetch(`/files?action=list&path=${encodeURIComponent(pathValue)}`)).json();
3795-        listings.push({ requestedPath: pathValue, payload: nextPayload });
3796-      } catch {
3797-        // Keep probing other candidate paths.
3798-      }
3799-    }
3800-    const payload = chooseBestDeviceListing(listings);
3801-    if (!payload) throw new Error("The controller did not return a readable file listing.");
3802-    if (shouldPreserveCurrentDirectListing(payload)) {
3803-      setDeviceState("Connected", "Keeping direct-storage file list from the last verified upload.");
3804-      pushDeviceActivity("warn", "Ignored internal flash listing", "The controller returned its web UI filesystem instead of the job storage list.");
3805-      render();
3806-      setStatus("Kept the direct-storage file list instead of the controller web UI filesystem.");
3807-      return;
3808-    }
3809-    applyDeviceListing(payload);
3810-    setDeviceState("Connected", `${payload.status || "Ok"} · ${payload.used || "?"} used of ${payload.total || "?"} on ${state.device.browsePath}`);
3811-    pushDeviceActivity("info", "Controller file list loaded", state.device.lastFileSummary);
3812-    render();
3813-    setStatus(`Loaded ${state.device.files.length} device file${state.device.files.length === 1 ? "" : "s"} from ${state.device.browsePath}.`);
3814-  } catch (error) {
3815-    state.device.lastFileSummary = "Unable to load files from device storage.";
3816-    reportDeviceError("Load device files", error);
3817-  }
3818-}
3819-
3820-async function scanNetworkForDevices() {
3821-  try {
3822-    const subnets = buildDiscoveryCandidates({
3823-      manualScanRange: state.device.scanRange,
3824-      deviceUrl: state.device.url,
3825-      discoveredSubnets: state.device.discoveredSubnets,
3826-      networkSubnets: state.device.knownScanSubnets,
3827-    });
3828-    if (!subnets.length) throw new Error("No local subnet detected. Enter a manual IP or a custom scan range.");
3829-    state.device.discoveryLog = [];
3830-    pushDeviceActivity("info", "Starting network scan", `Scanning ${subnets.length} candidate subnet${subnets.length === 1 ? "" : "s"}.`);
3831-    setDeviceState("Scanning", `Scanning ${subnets.length} likely subnet${subnets.length === 1 ? "" : "s"} for a controller.`);
3832-    const response = await fetch(`/discover-many?subnets=${encodeURIComponent(subnets.join(","))}`);
3833-    if (!response.ok) throw new Error(`Network scan failed (${response.status}).`);
3834-    const payload = await response.json();
3835-    state.device.discoveryLog = subnets.map((subnet) => `Scanned ${subnet}.0/24`);
3836-    const [first] = payload.devices || [];
3837-    if (first?.url) {
3838-      state.device.url = normalizeDeviceUrl(first.url);
3839-      state.device.friendlyName = first.title || "Laser Controller";
3840-      state.device.enabled = true;
3841-      pushDeviceActivity("info", "Controller discovered", `${state.device.friendlyName} at ${first.url}`);
3842-      setDeviceState("Found", `Discovered ${state.device.friendlyName} at ${first.url}`);
3843-      render();
3844-      await refreshDeviceFiles();
3845-      return;
3846-    }
3847-    setDeviceState("Generator Only", "No controller found automatically. Enter a manual IP/friendly name or another scan range.");
3848-    pushDeviceActivity("warn", "No controller discovered", `Scanned ${subnets.length} candidate subnet${subnets.length === 1 ? "" : "s"}.`);
3849-  } catch (error) {
3850-    reportDeviceError("Network scan", error);
3851-  }
3852-}
3853-
3854-async function sendManualDeviceCommand(command) {
3855-  if (!command) return setStatus("Enter a command first.");
3856-  try {
3857-    pushDeviceActivity("info", "Sending command", command);
3858-    setDeviceState("Sending", `Command: ${command}`);
3859-    await readDeviceResponseText(await deviceFetch(`/command?commandText=${encodeURIComponent(command)}`), "Manual command");
3860-    elements.deviceCommand.value = "";
3861-    setDeviceState("Connected", `Last command sent: ${command}`);
3862-    setStatus(`Sent command: ${command}`);
3863-    pushDeviceActivity("info", "Command sent", command);
3864-  } catch (error) {
3865-    reportDeviceError("Manual command", error);
3866-  }
3867-}
3868-
3869-async function stopDeviceJob() {
3870-  try {
3871-    state.device.stopRequested = true;
3872-    state.device.streaming = false;
3873-    pushDeviceActivity("warn", "Stopping device job", "Issuing an emergency hold, laser-off, and reset burst while cancelling any local queued stream.");
3874-    setDeviceState("Stopping", "Issuing emergency stop commands and cancelling local streaming.");
3875-    const { inspection } = await readDeviceResponseText(
3876-      await deviceFetch("/stop"),
3877-      "Stop job",
3878-      { requirePositive: true },
3879-    );
3880-    const plan = inspection.data || { label: "Emergency stop burst", partial: false };
3881-    setDeviceState("Connected", "Stop command sent to controller.");
3882-    const detail = plan.partial ? `${plan.label} (with fallback errors)` : plan.label;
3883-    setStatus(plan.partial ? "Emergency stop sent with warnings." : "Emergency stop sent.");
3884-    pushDeviceActivity(plan.partial ? "warn" : "info", "Stop command sent", detail);
3885-  } catch (error) {
3886-    reportDeviceError("Stop job", error);
3887-  }
3888-}
3889-
3890-async function uploadCurrentJobToDevice() {
3891-  try { await ensureTextToPathReady(); } catch {}
3892-  const gcode = await generateGcode();
3893-  if (gcode.startsWith("; No enabled")) return setStatus("No enabled geometry to upload.");
3894-  try {
3895-    const filename = preferredJobFilename();
3896-    await uploadGcodeToDevice(filename, gcode);
3897-    setStatus(`Uploaded ${filename} to the controller.`);
3898-    pushDeviceActivity("info", "G-code uploaded", filename);
3899-    if (state.device.storageMode.toLowerCase() !== "direct") {
3900-      await refreshDeviceFiles();
3901-    } else {
3902-      render();
3903-    }
3904-  } catch (error) {
3905-    reportDeviceError("Upload G-code", error);
3906-  }
3907-}
3908-
3909-async function streamCurrentJobToDevice() {
3910-  try { await ensureTextToPathReady(); } catch {}
3911-  const gcode = await generateGcode();
3912-  if (gcode.startsWith("; No enabled")) return setStatus("No enabled geometry to run.");
3913-  const filename = preferredJobFilename();
3914-  try {
3915-    state.device.streaming = true;
3916-    state.device.stopRequested = false;
3917-    pushDeviceActivity("info", "Preparing device job", filename);
3918-    await uploadGcodeToDevice(filename, gcode, false);
3919-    if (!controllerCanAutostartJobs()) {
3920-      state.device.streaming = false;
3921-      setDeviceState("Uploaded", `Uploaded ${filename} to controller storage. Start it directly on the controller.`);
3922-      setStatus(`Uploaded ${filename} to controller storage. Start it directly on the controller.`);
3923-      pushDeviceActivity("warn", "Upload-only controller mode", `Uploaded ${filename}. This controller reports direct root storage, so the app will not attempt an unsafe remote start.`);
3924-      render();
3925-      return;
3926-    }
3927-    const fullPath = normalizeDevicePath(state.device.uploadPath, filename);
3928-    let startedByFileCommand = false;
3929-    for (const command of buildRunFileCommands(fullPath, { controllerFlavor: controllerRunFlavor() })) {
3930-      setDeviceState("Starting", `Attempting controller-side start: ${command}`);
3931-      try {
3932-        const result = await readDeviceResponseText(
3933-          await deviceFetch(`/command?commandText=${encodeURIComponent(command)}`),
3934-          "Controller-side stream start",
3935-          { requirePositive: false } // Relax check: some controllers just start without returning JSON
3936-        );
3937-        pushDeviceActivity("info", "Controller-side stream started", result.inspection.summary || command);
3938-        startedByFileCommand = true;
3939-        break;
3940-      } catch (error) {
3941-        pushDeviceActivity("warn", "Controller-side start attempt failed", error.message);
3942-      }
3943-    }
3944-
3945-    if (!startedByFileCommand) {
3946-      state.device.streaming = false;
3947-      await refreshDeviceFiles().catch(() => {});
3948-      throw new Error(`Uploaded ${filename} to ${fullPath}, but the controller did not acknowledge starting it. Start it directly from the controller. Browser-side fallback streaming is disabled for safety.`);
3949-    }
3950-
3951-    state.device.streaming = false;
3952-    setDeviceState("Running", `Controller is running ${filename} from device storage.`);
3953-    setStatus(`Started ${filename} from device storage.`);
3954-    pushDeviceActivity("info", "Controller-run job started", `${filename} on ${fullPath}`);
3955-    await refreshDeviceFiles();
3956-  } catch (error) {
3957-    state.device.streaming = false;
3958-    reportDeviceError("Stream job", error);
3959-  }
3960-}
3961-
3962-async function streamFrameToDevice() {
3963-  const bounds = selectionBounds();
3964-  if (!bounds) return setStatus("Select objects to stream a frame.");
3965-  await streamLinesToDevice(buildFrameLines(bounds, state.machine), "frame");
3966-}
3967-
3968-async function streamLinesToDevice(lines, label) {
3969-  try {
3970-    state.device.streaming = true;
3971-    state.device.stopRequested = false;
3972-    const commands = lines.filter(Boolean);
