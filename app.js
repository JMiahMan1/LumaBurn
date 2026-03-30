import {
  applyLineStyleToPolylines,
  buildSvgMarkupFromPolylines,
  DEFAULT_DEVICE_TIMEOUT_MS,
  DEVICE_ACTIVITY_LIMIT,
  buildDiscoveryCandidates,
  buildFrameLines,
  buildGcodeFromPolylines,
  buildQueuedCommandVariants,
  buildRunFileCommands,
  canUseControllerFileRun,
  optimizePolylines,
  dedupeStrings,
  estimateJobFromPolylines,
  gcodeToQueueLines,
  inspectDeviceResponse,
  normalizeDevicePath,
  normalizeDeviceUrl,
  parseGcodeGeometry,
  parseLightBurnGeometry,
  stripLikelySvgBackgroundRect,
} from "./lumaburn-core.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const PROJECT_VERSION = 3;
const MACHINE_PROFILE_STORAGE_KEY = "lumaburn.machineProfiles";
const DEVICE_PROFILE_STORAGE_KEY = "lumaburn.deviceProfiles";
const DEFAULT_MACHINE_PROFILE_STORAGE_KEY = "lumaburn.defaultMachineProfileId";
const DEFAULT_DEVICE_PROFILE_STORAGE_KEY = "lumaburn.defaultDeviceProfileId";
const WORKSPACE_STORAGE_KEY = "lumaburn.workspace";
const CANVAS_GUTTER = { left: 40, right: 12, top: 38, bottom: 36 };

const MACHINE_PRESETS = [
  { id: "longer-ray5-20w", name: "Longer Ray5 20W", bedWidth: 400, bedHeight: 400, travelSpeed: 4000, frameSpeed: 5000, laserMax: 1000, sampleStep: 0.8, originMode: "lower-left", safeZ: 0 },
  { id: "ortur-master-3", name: "Ortur Laser Master 3", bedWidth: 400, bedHeight: 400, travelSpeed: 5000, frameSpeed: 6000, laserMax: 1000, sampleStep: 0.7, originMode: "lower-left", safeZ: 0 },
  { id: "xtool-d1-pro", name: "xTool D1 Pro 20W", bedWidth: 430, bedHeight: 390, travelSpeed: 4500, frameSpeed: 5500, laserMax: 1000, sampleStep: 0.7, originMode: "lower-left", safeZ: 0 },
];

const MATERIAL_PRESETS = [
  { id: "none", name: "No Material Preset", feed: 1800, power: 65, passes: 1, mode: "line", airAssist: false },
  { id: "3mm-birch-cut", name: "3mm Birch Cut", feed: 420, power: 100, passes: 2, mode: "line", airAssist: true },
  { id: "3mm-basswood-cut", name: "3mm Basswood Cut", feed: 500, power: 95, passes: 2, mode: "line", airAssist: true },
  { id: "acrylic-black-score", name: "Black Acrylic Score", feed: 1500, power: 28, passes: 1, mode: "score", airAssist: false },
  { id: "leather-engrave", name: "Leather Engrave", feed: 2200, power: 35, passes: 1, mode: "fill", airAssist: false },
];

const DEMO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 150">
  <g id="frame">
    <rect x="16" y="16" width="188" height="118" rx="12" fill="none" stroke="#111" stroke-width="3" />
    <path d="M32 108 C72 76 140 76 188 108" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" />
  </g>
  <g id="logo">
    <path d="M58 95 L84 36 L109 95 Z" fill="none" stroke="#111" stroke-width="3"/>
    <circle cx="84" cy="68" r="16" fill="none" stroke="#111" stroke-width="3"/>
  </g>
  <g id="wordmark">
    <path d="M129 47 H148 V54 H136 V64 H146 V71 H136 V87 H129 Z" fill="#111"/>
    <path d="M154 47 H161 L171 72 L181 47 H188 V87 H181 V61 L173 80 H169 L161 61 V87 H154 Z" fill="#111"/>
  </g>
</svg>`;

const initialMachine = MACHINE_PRESETS[0];

const state = {
  documentName: "No SVG Loaded",
  artworkViewBox: { x: 0, y: 0, width: 400, height: 400 },
  sourceDefsMarkup: "",
  machine: {
    presetId: initialMachine.id,
    materialPresetId: "none",
    bedWidth: initialMachine.bedWidth,
    bedHeight: initialMachine.bedHeight,
    travelSpeed: initialMachine.travelSpeed,
    frameSpeed: initialMachine.frameSpeed,
    laserMax: initialMachine.laserMax,
    sampleStep: initialMachine.sampleStep,
    originMode: initialMachine.originMode,
    safeZ: initialMachine.safeZ,
    airAssist: false,
    showGrid: true,
    showToolpath: false,
    snapEnabled: true,
    snapStep: 5,
    arrayCols: 2,
    arrayRows: 2,
    arrayGapX: 12,
    arrayGapY: 12,
    jobHeader: "; LumaBurn G-code\nG21 ; millimeters\nG90 ; absolute positioning\nM5",
    jobFooter: "M5\nG0 X0 Y0",
  },
  device: createDefaultDeviceState(),
  operationLayers: [],
  objects: [],
  selectedObjectIds: [],
  selectedOperationLayerId: "",
  dragSession: null,
  machineProfiles: [],
  deviceProfiles: [],
  defaultMachineProfileId: "",
  defaultDeviceProfileId: "",
  selectedMachineProfileId: "",
  selectedDeviceProfileId: "",
  generatedGcode: "",
  interactionMode: "select",
  activeRightTab: "assign",
};

let workspaceSaveTimer = 0;

const elements = {
  fileInput: document.querySelector("#svg-input"),
  projectInput: document.querySelector("#project-input"),
  saveProjectButton: document.querySelector("#save-project-button"),
  exportButton: document.querySelector("#export-button"),
  frameButton: document.querySelector("#frame-button"),
  demoButton: document.querySelector("#demo-button"),
  resetWorkspaceButton: document.querySelector("#reset-workspace-button"),
  centerButton: document.querySelector("#center-button"),
  homeButton: document.querySelector("#home-button"),
  duplicateButton: document.querySelector("#duplicate-button"),
  arrayButton: document.querySelector("#array-button"),
  deleteButton: document.querySelector("#delete-button"),
  groupButton: document.querySelector("#group-button"),
  ungroupButton: document.querySelector("#ungroup-button"),
  assignOperationButton: document.querySelector("#assign-operation-button"),
  moveUpButton: document.querySelector("#move-up-button"),
  moveDownButton: document.querySelector("#move-down-button"),
  toggleAllButton: document.querySelector("#toggle-all-button"),
  addOperationButton: document.querySelector("#add-operation-button"),
  machinePreset: document.querySelector("#machine-preset"),
  machineProfile: document.querySelector("#machine-profile"),
  materialPreset: document.querySelector("#material-preset"),
  bedWidth: document.querySelector("#bed-width"),
  bedHeight: document.querySelector("#bed-height"),
  travelSpeed: document.querySelector("#travel-speed"),
  laserMax: document.querySelector("#laser-max"),
  sampleStep: document.querySelector("#sample-step"),
  originMode: document.querySelector("#origin-mode"),
  safeZ: document.querySelector("#safe-z"),
  frameSpeed: document.querySelector("#frame-speed"),
  airAssist: document.querySelector("#air-assist"),
  showToolpath: document.querySelector("#show-toolpath"),
  toggleGridButton: document.querySelector("#toggle-grid-button"),
  toggleSnapButton: document.querySelector("#toggle-snap-button"),
  toolbarCenterButton: document.querySelector("#toolbar-center-button"),
  toolbarHomeButton: document.querySelector("#toolbar-home-button"),
  toolbarSaveWorkspaceButton: document.querySelector("#toolbar-save-workspace-button"),
  toolbarDeleteWorkspaceButton: document.querySelector("#toolbar-delete-workspace-button"),
  saveMachineProfileButton: document.querySelector("#save-machine-profile-button"),
  deleteMachineProfileButton: document.querySelector("#delete-machine-profile-button"),
  defaultMachineProfileButton: document.querySelector("#default-machine-profile-button"),
  deviceUrl: document.querySelector("#device-url"),
  deviceProfile: document.querySelector("#device-profile"),
  deviceName: document.querySelector("#device-name"),
  deviceUploadPath: document.querySelector("#device-upload-path"),
  deviceScanRange: document.querySelector("#device-scan-range"),
  deviceScanButton: document.querySelector("#device-scan-button"),
  deviceConnectButton: document.querySelector("#device-connect-button"),
  deviceUploadButton: document.querySelector("#device-upload-button"),
  deviceStreamButton: document.querySelector("#device-stream-button"),
  deviceFrameButton: document.querySelector("#device-frame-button"),
  deviceUnlockButton: document.querySelector("#device-unlock-button"),
  deviceHomeButton: document.querySelector("#device-home-button"),
  devicePauseButton: document.querySelector("#device-pause-button"),
  deviceResumeButton: document.querySelector("#device-resume-button"),
  deviceStopButton: document.querySelector("#device-stop-button"),
  saveDeviceProfileButton: document.querySelector("#save-device-profile-button"),
  deleteDeviceProfileButton: document.querySelector("#delete-device-profile-button"),
  defaultDeviceProfileButton: document.querySelector("#default-device-profile-button"),
  deviceCommand: document.querySelector("#device-command"),
  deviceCommandButton: document.querySelector("#device-command-button"),
  deviceStateLabel: document.querySelector("#device-state-label"),
  deviceStateDetail: document.querySelector("#device-state-detail"),
  deviceDiscovery: document.querySelector("#device-discovery"),
  deviceFilesMeta: document.querySelector("#device-files-meta"),
  deviceFiles: document.querySelector("#device-files"),
  deviceActivity: document.querySelector("#device-activity"),
  rightTabButtons: [...document.querySelectorAll("[data-right-tab]")],
  rightPanels: [...document.querySelectorAll("[data-right-panel]")],
  operationHelp: document.querySelector("#operation-help"),
  objectSelectionSummary: document.querySelector("#object-selection-summary"),
  snapStep: document.querySelector("#snap-step"),
  snapEnabled: document.querySelector("#snap-enabled"),
  arrayCols: document.querySelector("#array-cols"),
  arrayRows: document.querySelector("#array-rows"),
  arrayGapX: document.querySelector("#array-gap-x"),
  arrayGapY: document.querySelector("#array-gap-y"),
  jobHeader: document.querySelector("#job-header"),
  jobFooter: document.querySelector("#job-footer"),
  gcodePreview: document.querySelector("#gcode-preview"),
  canvas: document.querySelector("#editor-canvas"),
  canvasPanel: document.querySelector(".canvas-panel"),
  canvasStage: document.querySelector(".canvas-stage"),
  selectModeButton: document.querySelector("#select-mode-button"),
  workspaceHint: document.querySelector("#workspace-hint"),
  layerList: document.querySelector("#layer-list"),
  layerCount: document.querySelector("#layer-count"),
  objectList: document.querySelector("#object-list"),
  objectCount: document.querySelector("#object-count"),
  documentName: document.querySelector("#document-name"),
  status: document.querySelector("#status-text"),
  selectionCount: document.querySelector("#selection-count"),
  inspectorEmpty: document.querySelector("#inspector-empty"),
  inspectorFields: document.querySelector("#inspector-fields"),
  inspectorSelectionSummary: document.querySelector("#inspector-selection-summary"),
  inspectorObjectSummary: document.querySelector("#inspector-object-summary"),
  inspectorOperationSummary: document.querySelector("#inspector-operation-summary"),
  inspectorObjectBlock: document.querySelector("#inspector-object-block"),
  inspectorOperationBlock: document.querySelector("#inspector-operation-block"),
  measurementRoot: document.querySelector("#measurement-root"),
  layerName: document.querySelector("#layer-name"),
  assignOperationSelect: document.querySelector("#assign-operation-select"),
  operationName: document.querySelector("#operation-name"),
  layerMode: document.querySelector("#layer-mode"),
  lineStyle: document.querySelector("#line-style"),
  dashLength: document.querySelector("#dash-length"),
  gapLength: document.querySelector("#gap-length"),
  layerX: document.querySelector("#layer-x"),
  layerY: document.querySelector("#layer-y"),
  layerScale: document.querySelector("#layer-scale"),
  layerWidth: document.querySelector("#layer-width"),
  layerHeight: document.querySelector("#layer-height"),
  layerRotation: document.querySelector("#layer-rotation"),
  layerFeed: document.querySelector("#layer-feed"),
  layerPower: document.querySelector("#layer-power"),
  layerPasses: document.querySelector("#layer-passes"),
  layerColor: document.querySelector("#layer-color"),
  layerEnabled: document.querySelector("#layer-enabled"),
  layerAirAssist: document.querySelector("#layer-air-assist"),
  statEnabled: document.querySelector("#stat-enabled"),
  statCutDistance: document.querySelector("#stat-cut-distance"),
  statTravelDistance: document.querySelector("#stat-travel-distance"),
  statRuntime: document.querySelector("#stat-runtime"),
};

function initialize() {
  loadProfilesFromStorage();
  state.operationLayers = defaultOperationLayers();
  state.selectedOperationLayerId = state.operationLayers[0].id;
  populateMenus();
  bindMachineControls();
  bindButtons();
  bindInspector();
  bindCanvasInteraction();
  bindKeyboardShortcuts();
  applyStartupProfiles();
  restoreWorkspaceFromStorage();
  if (state.selectedDeviceProfileId) applySavedDeviceProfile(state.selectedDeviceProfileId);
  render();
  window.addEventListener("beforeunload", persistWorkspaceNow);
  window.addEventListener("pagehide", handlePageHide);
  initializeDeviceDiscovery();
}

function defaultOperationLayers() {
  return [
    createOperationLayer("Cut 1", "#ca5b31"),
    createOperationLayer("Score 1", "#2f6b45", { mode: "score", power: 35, feed: 1800 }),
    createOperationLayer("Fill 1", "#22618d", { mode: "fill", power: 40, feed: 2200 }),
  ];
}

function createDefaultMachineState() {
  return {
    presetId: initialMachine.id,
    materialPresetId: "none",
    bedWidth: initialMachine.bedWidth,
    bedHeight: initialMachine.bedHeight,
    travelSpeed: initialMachine.travelSpeed,
    frameSpeed: initialMachine.frameSpeed,
    laserMax: initialMachine.laserMax,
    sampleStep: initialMachine.sampleStep,
    originMode: initialMachine.originMode,
    safeZ: initialMachine.safeZ,
    airAssist: false,
    showGrid: true,
    showToolpath: false,
    snapEnabled: true,
    snapStep: 5,
    arrayCols: 2,
    arrayRows: 2,
    arrayGapX: 12,
    arrayGapY: 12,
    jobHeader: "; LumaBurn G-code\nG21 ; millimeters\nG90 ; absolute positioning\nM5",
    jobFooter: "M5\nG0 X0 Y0",
  };
}

function createDefaultDeviceState() {
  return {
    url: "",
    friendlyName: "",
    uploadPath: "/sd/",
    browsePath: "/sd/",
    storageMode: "",
    scanRange: "",
    stateLabel: "Disconnected",
    stateDetail: "Running in generator mode until a controller is discovered or entered manually.",
    files: [],
    discoveredSubnets: [],
    discoveryLog: [],
    networkAvailable: false,
    enabled: false,
    streaming: false,
    stopRequested: false,
    lastFileSummary: "No storage loaded.",
    activityLog: [],
    knownScanSubnets: [],
  };
}

function normalizeStoragePath(value, fallback = "/sd/") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return fallback;
  if (trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function normalizeSavedDeviceProfile(profile) {
  if (!profile || typeof profile !== "object" || typeof profile.id !== "string") return null;
  const device = profile.device && typeof profile.device === "object" ? profile.device : {};
  return {
    id: profile.id,
    name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : profile.id,
    device: {
      url: normalizeDeviceUrl(device.url || ""),
      friendlyName: String(device.friendlyName || "").trim(),
      uploadPath: normalizeStoragePath(device.uploadPath, "/sd/"),
      browsePath: normalizeStoragePath(device.browsePath || device.uploadPath, "/sd/"),
      scanRange: String(device.scanRange || "").trim(),
    },
  };
}

function workspaceSaveExists() {
  try {
    return Boolean(window.localStorage.getItem(WORKSPACE_STORAGE_KEY));
  } catch {
    return false;
  }
}

function detachSelectedDeviceProfile() {
  if (!state.selectedDeviceProfileId) return;
  state.selectedDeviceProfileId = "";
  if (elements.deviceProfile) elements.deviceProfile.value = "";
}

function createOperationLayer(name, color, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name,
    mode: "line",
    lineStyle: "continuous",
    dashLength: 3,
    gapLength: 1,
    power: 70,
    feed: 1800,
    passes: 1,
    airAssist: false,
    enabled: true,
    color,
    ...overrides,
  };
}

function populateMenus() {
  elements.machinePreset.innerHTML = MACHINE_PRESETS.map((preset) => `<option value="${preset.id}">${preset.name}</option>`).join("");
  elements.materialPreset.innerHTML = MATERIAL_PRESETS.map((preset) => `<option value="${preset.id}">${preset.name}</option>`).join("");
  populateProfileMenus();
}

function populateProfileMenus() {
  elements.machineProfile.innerHTML = [`<option value="">No saved profile</option>`, ...state.machineProfiles.map((profile) => `<option value="${escapeAttribute(profile.id)}">${escapeHtml(profile.name)}</option>`)].join("");
  elements.deviceProfile.innerHTML = [`<option value="">No saved profile</option>`, ...state.deviceProfiles.map((profile) => `<option value="${escapeAttribute(profile.id)}">${escapeHtml(profile.name)}</option>`)].join("");
}

function bindMachineControls() {
  elements.machinePreset.addEventListener("change", () => applyMachinePreset(elements.machinePreset.value));
  elements.materialPreset.addEventListener("change", () => applyMaterialPreset(elements.materialPreset.value));
  elements.machineProfile.addEventListener("change", () => { state.selectedMachineProfileId = elements.machineProfile.value; applySavedMachineProfile(elements.machineProfile.value); });
  elements.deviceProfile.addEventListener("change", () => {
    state.selectedDeviceProfileId = elements.deviceProfile.value;
    if (elements.deviceProfile.value) applySavedDeviceProfile(elements.deviceProfile.value);
    else {
      setStatus("Using manual device settings.");
      render();
    }
  });

  [["bedWidth", elements.bedWidth], ["bedHeight", elements.bedHeight], ["travelSpeed", elements.travelSpeed], ["laserMax", elements.laserMax], ["sampleStep", elements.sampleStep], ["safeZ", elements.safeZ], ["frameSpeed", elements.frameSpeed], ["snapStep", elements.snapStep], ["arrayCols", elements.arrayCols], ["arrayRows", elements.arrayRows], ["arrayGapX", elements.arrayGapX], ["arrayGapY", elements.arrayGapY]].forEach(([key, input]) => {
    input.addEventListener("input", () => {
      state.machine[key] = Number(input.value);
      render();
    });
  });

  elements.originMode.addEventListener("change", () => { state.machine.originMode = elements.originMode.value; render(); });
  elements.airAssist.addEventListener("change", () => { state.machine.airAssist = elements.airAssist.checked; render(); });
  elements.showToolpath.addEventListener("change", () => { state.machine.showToolpath = elements.showToolpath.checked; render(); });
  elements.snapEnabled.addEventListener("change", () => { state.machine.snapEnabled = elements.snapEnabled.checked; });
  elements.deviceUrl.addEventListener("input", () => {
    detachSelectedDeviceProfile();
    state.device.url = normalizeDeviceUrl(elements.deviceUrl.value.trim());
    state.device.enabled = Boolean(state.device.url);
    render();
  });
  elements.deviceName.addEventListener("input", () => {
    detachSelectedDeviceProfile();
    state.device.friendlyName = elements.deviceName.value.trim();
  });
  elements.deviceUploadPath.addEventListener("input", () => {
    detachSelectedDeviceProfile();
    state.device.uploadPath = normalizeStoragePath(elements.deviceUploadPath.value, "/");
  });
  elements.deviceScanRange.addEventListener("input", () => {
    detachSelectedDeviceProfile();
    state.device.scanRange = elements.deviceScanRange.value.trim();
  });
  elements.jobHeader.addEventListener("input", () => { state.machine.jobHeader = elements.jobHeader.value; updateGcodePreview(); });
  elements.jobFooter.addEventListener("input", () => { state.machine.jobFooter = elements.jobFooter.value; updateGcodePreview(); });
  elements.fileInput.addEventListener("change", handleArtworkImport);
  elements.projectInput.addEventListener("change", handleProjectImport);
}

function bindButtons() {
  elements.exportButton.addEventListener("click", exportGcode);
  elements.frameButton.addEventListener("click", exportFrameGcode);
  elements.demoButton.addEventListener("click", () => loadSvgDocument(DEMO_SVG, "demo-artwork.svg"));
  elements.resetWorkspaceButton.addEventListener("click", resetWorkspace);
  elements.saveProjectButton.addEventListener("click", saveProjectFile);
  elements.centerButton.addEventListener("click", centerSelectionOnBed);
  elements.homeButton.addEventListener("click", homeSelectionOnBed);
  elements.duplicateButton.addEventListener("click", duplicateSelection);
  elements.arrayButton.addEventListener("click", makeArrayFromSelection);
  elements.deleteButton.addEventListener("click", deleteSelection);
  elements.groupButton.addEventListener("click", groupSelection);
  elements.ungroupButton.addEventListener("click", ungroupSelection);
  elements.assignOperationButton.addEventListener("click", () => assignSelectedObjectsToOperation(elements.assignOperationSelect.value));
  elements.addOperationButton.addEventListener("click", addOperationLayer);
  elements.moveUpButton.addEventListener("click", () => moveOperationLayer(-1));
  elements.moveDownButton.addEventListener("click", () => moveOperationLayer(1));
  elements.toggleAllButton.addEventListener("click", toggleAllOperationLayers);
  elements.deviceConnectButton.addEventListener("click", refreshDeviceFiles);
  elements.deviceScanButton.addEventListener("click", scanNetworkForDevices);
  elements.deviceUploadButton.addEventListener("click", uploadCurrentJobToDevice);
  elements.deviceStreamButton.addEventListener("click", streamCurrentJobToDevice);
  elements.deviceFrameButton.addEventListener("click", streamFrameToDevice);
  elements.deviceUnlockButton.addEventListener("click", () => sendManualDeviceCommand("$X"));
  elements.deviceHomeButton.addEventListener("click", () => sendManualDeviceCommand("$H"));
  elements.devicePauseButton.addEventListener("click", () => sendManualDeviceCommand("!"));
  elements.deviceResumeButton.addEventListener("click", () => sendManualDeviceCommand("~"));
  elements.deviceCommandButton.addEventListener("click", () => sendManualDeviceCommand(elements.deviceCommand.value.trim()));
  elements.saveMachineProfileButton.addEventListener("click", saveMachineProfile);
  elements.deleteMachineProfileButton.addEventListener("click", deleteSelectedMachineProfile);
  elements.defaultMachineProfileButton.addEventListener("click", setDefaultMachineProfile);
  elements.saveDeviceProfileButton.addEventListener("click", saveDeviceProfile);
  elements.deleteDeviceProfileButton.addEventListener("click", deleteSelectedDeviceProfile);
  elements.defaultDeviceProfileButton.addEventListener("click", setDefaultDeviceProfile);
  elements.deviceStopButton.addEventListener("click", stopDeviceJob);
  elements.deviceFiles.addEventListener("click", onDeviceFileActionClick);
  elements.selectModeButton.addEventListener("click", () => {
    state.interactionMode = "select";
    elements.canvas.focus();
    render();
    setStatus("Select / Move mode active.");
  });
  elements.toggleGridButton.addEventListener("click", () => {
    state.machine.showGrid = !state.machine.showGrid;
    render();
    setStatus(state.machine.showGrid ? "Grid shown." : "Grid hidden.");
  });
  elements.toggleSnapButton.addEventListener("click", () => {
    state.machine.snapEnabled = !state.machine.snapEnabled;
    render();
    setStatus(state.machine.snapEnabled ? "Snap enabled." : "Snap disabled.");
  });
  elements.toolbarCenterButton.addEventListener("click", centerSelectionOnBed);
  elements.toolbarHomeButton.addEventListener("click", homeSelectionOnBed);
  elements.toolbarSaveWorkspaceButton.addEventListener("click", saveWorkspaceSnapshot);
  elements.toolbarDeleteWorkspaceButton.addEventListener("click", deleteSavedWorkspaceSnapshot);
  elements.rightTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeRightTab = button.getAttribute("data-right-tab") || "assign";
      render();
    });
  });
}

function resetWorkspace() {
  state.documentName = "No SVG Loaded";
  state.artworkViewBox = { x: 0, y: 0, width: 400, height: 400 };
  state.sourceDefsMarkup = "";
  state.machine = createDefaultMachineState();
  state.operationLayers = defaultOperationLayers();
  state.objects = [];
  state.selectedObjectIds = [];
  state.selectedOperationLayerId = state.operationLayers[0].id;
  state.dragSession = null;
  state.generatedGcode = "";
  state.interactionMode = "select";
  window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  render();
  setStatus("Workspace reset.");
}

function saveWorkspaceSnapshot() {
  persistWorkspaceNow();
  render();
  setStatus("Workspace saved to this browser.");
}

function deleteSavedWorkspaceSnapshot() {
  if (!workspaceSaveExists()) {
    setStatus("No saved workspace to delete.");
    return;
  }
  window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  render();
  setStatus("Saved workspace deleted.");
}

function bindInspector() {
  elements.layerName.addEventListener("input", () => {
    const node = primarySelectedObject();
    if (node) {
      node.name = elements.layerName.value;
      render();
    }
  });
  [["x", elements.layerX], ["y", elements.layerY], ["scale", elements.layerScale], ["rotation", elements.layerRotation]].forEach(([key, input]) => {
    input.addEventListener("input", () => {
      const value = Number(input.value);
      const node = primarySelectedObject();
      if (!node) return;
      node[key] = value;
      render();
    });
  });
  elements.layerWidth.addEventListener("input", () => resizeSelectedObjectToDimension("width", elements.layerWidth.value));
  elements.layerHeight.addEventListener("input", () => resizeSelectedObjectToDimension("height", elements.layerHeight.value));
  elements.assignOperationSelect.addEventListener("change", () => {
    const operationId = elements.assignOperationSelect.value;
    state.selectedOperationLayerId = operationId;
    if (selectedObjects().length) assignSelectedObjectsToOperation(operationId);
    else render();
  });
  elements.operationName.addEventListener("input", () => updateSelectedOperationLayer((layer) => { layer.name = elements.operationName.value; }));
  elements.layerMode.addEventListener("change", () => updateSelectedOperationLayer((layer) => { layer.mode = elements.layerMode.value; }));
  elements.lineStyle.addEventListener("change", () => updateSelectedOperationLayer((layer) => { layer.lineStyle = elements.lineStyle.value; }));
  elements.dashLength.addEventListener("input", () => updateSelectedOperationLayer((layer) => { layer.dashLength = Number(elements.dashLength.value); }));
  elements.gapLength.addEventListener("input", () => updateSelectedOperationLayer((layer) => { layer.gapLength = Number(elements.gapLength.value); }));
  elements.layerFeed.addEventListener("input", () => updateSelectedOperationLayer((layer) => { layer.feed = Number(elements.layerFeed.value); }));
  elements.layerPower.addEventListener("input", () => updateSelectedOperationLayer((layer) => { layer.power = Number(elements.layerPower.value); }));
  elements.layerPasses.addEventListener("input", () => updateSelectedOperationLayer((layer) => { layer.passes = Number(elements.layerPasses.value); }));
  elements.layerColor.addEventListener("input", () => updateSelectedOperationLayer((layer) => { layer.color = elements.layerColor.value; }));
  elements.layerEnabled.addEventListener("change", () => updateSelectedOperationLayer((layer) => { layer.enabled = elements.layerEnabled.checked; }));
  elements.layerAirAssist.addEventListener("change", () => updateSelectedOperationLayer((layer) => { layer.airAssist = elements.layerAirAssist.checked; }));
}

function bindCanvasInteraction() {
  elements.canvas.addEventListener("mousedown", onCanvasMouseDown);
  elements.canvas.addEventListener("dragstart", (event) => event.preventDefault());
  elements.canvas.addEventListener("selectstart", (event) => event.preventDefault());
}

function bindKeyboardShortcuts() {
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (state.interactionMode !== "select") return;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    if (document.activeElement === elements.canvas || state.selectedObjectIds.length) event.preventDefault();
    const step = getKeyboardNudgeStep(event.shiftKey);
    if (event.key === "ArrowUp") { nudgeSelection(0, -step); event.preventDefault(); }
    if (event.key === "ArrowDown") { nudgeSelection(0, step); event.preventDefault(); }
    if (event.key === "ArrowLeft") { nudgeSelection(-step, 0); event.preventDefault(); }
    if (event.key === "ArrowRight") { nudgeSelection(step, 0); event.preventDefault(); }
  }, { capture: true });
}

function applyMachinePreset(presetId) {
  const preset = MACHINE_PRESETS.find((item) => item.id === presetId);
  if (!preset) return;
  state.machine = { ...state.machine, presetId: preset.id, bedWidth: preset.bedWidth, bedHeight: preset.bedHeight, travelSpeed: preset.travelSpeed, frameSpeed: preset.frameSpeed, laserMax: preset.laserMax, sampleStep: preset.sampleStep, originMode: preset.originMode, safeZ: preset.safeZ };
  render();
  setStatus(`Applied machine preset: ${preset.name}.`);
}

function applyMaterialPreset(presetId) {
  const preset = MATERIAL_PRESETS.find((item) => item.id === presetId);
  if (!preset) return;
  state.machine.materialPresetId = preset.id;
  updateSelectedOperationLayer((layer) => {
    layer.feed = preset.feed;
    layer.power = preset.power;
    layer.passes = preset.passes;
    layer.mode = preset.mode;
    layer.airAssist = preset.airAssist;
  });
  render();
  setStatus(`Applied material preset: ${preset.name}.`);
}

async function handleArtworkImport(event) {
  const [file] = event.target.files ?? [];
  if (!file) return;
  try {
    const text = await file.text();
    const extension = String(file.name.split(".").pop() || "").toLowerCase();
    if (extension === "svg") {
      loadSvgDocument(text, file.name);
      return;
    }
    if (["gc", "gcode"].includes(extension)) {
      loadGcodeDocument(text, file.name);
      return;
    }
    if (["lbrn", "lbrn2"].includes(extension)) {
      loadLightBurnDocument(text, file.name);
      return;
    }
    setStatus(`Unsupported artwork file: ${file.name}. Import .svg, .gc, .gcode, .lbrn, or .lbrn2.`);
  } finally {
    elements.fileInput.value = "";
  }
}

async function handleProjectImport(event) {
  const [file] = event.target.files ?? [];
  if (!file) return;
  try {
    restoreProject(JSON.parse(await file.text()), file.name);
    setStatus(`Loaded project: ${file.name}.`);
  } catch {
    setStatus("Project file is invalid.");
  }
  elements.projectInput.value = "";
}

function loadSvgDocument(svgText, name) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    if (doc.querySelector("parsererror")) throw new Error("The SVG could not be parsed.");
    const root = doc.documentElement;
    const viewBox = root.viewBox?.baseVal;
    const sourceDefs = [...root.querySelectorAll("defs, style, linearGradient, radialGradient, pattern, clipPath, mask, symbol, marker, filter")];
    const width = viewBox?.width || numberFromLength(root.getAttribute("width")) || 400;
    const height = viewBox?.height || numberFromLength(root.getAttribute("height")) || 400;
    state.documentName = name;
    state.artworkViewBox = { x: viewBox?.x || 0, y: viewBox?.y || 0, width, height };
    state.sourceDefsMarkup = sourceDefs.map((node) => node.outerHTML).join("");

    if (!state.operationLayers.length) {
      state.operationLayers = defaultOperationLayers();
      state.selectedOperationLayerId = state.operationLayers[0].id;
    }

    const artworkBounds = { minX: viewBox?.x || 0, minY: viewBox?.y || 0, width, height };
    let topLevelGraphics = filterImportGraphics([...root.children], artworkBounds);
    if (!topLevelGraphics.length) {
      const nestedGraphics = filterImportGraphics(
        [...root.querySelectorAll("g, path, rect, circle, ellipse, line, polyline, polygon, use, text, image")].map((node) => node.cloneNode(true)),
        artworkBounds,
      );
      if (nestedGraphics.length) topLevelGraphics = nestedGraphics;
    }
    if (topLevelGraphics.length === 1 && topLevelGraphics[0].tagName === "g" && !topLevelGraphics[0].hasAttribute("transform")) {
      const directChildren = filterImportGraphics([...topLevelGraphics[0].children], artworkBounds);
      if (directChildren.length) topLevelGraphics = directChildren;
    }
    if (!topLevelGraphics.length) throw new Error("No supported SVG graphics were found in this file.");
    const baseScale = Math.min((state.machine.bedWidth * 0.72) / width, (state.machine.bedHeight * 0.72) / height, 1.6);
    const offsetX = (state.machine.bedWidth - width * baseScale) / 2 - (viewBox?.x || 0) * baseScale;
    const offsetY = (state.machine.bedHeight - height * baseScale) / 2 - (viewBox?.y || 0) * baseScale;
    const operationLayerId = state.operationLayers[0].id;
    const rootNode = {
      id: crypto.randomUUID(),
      name: stripExtension(name) || "Imported SVG",
      type: "group",
      markup: "",
      x: offsetX,
      y: offsetY,
      scale: baseScale,
      rotation: 0,
      operationLayerId,
      children: topLevelGraphics.map((node) => createSceneNodeFromDom(node, operationLayerId, { x: 0, y: 0, scale: 1, rotation: 0 }, artworkBounds)),
      sourceBounds: {
        minX: artworkBounds.minX,
        minY: artworkBounds.minY,
        width,
        height,
        centerX: artworkBounds.minX + width / 2,
        centerY: artworkBounds.minY + height / 2,
      },
    };
    state.objects = [rootNode];
    state.selectedObjectIds = state.objects[0] ? [state.objects[0].id] : [];
    state.interactionMode = "select";
    elements.canvas.focus();
    render();
    setStatus(`Loaded ${countObjects(state.objects)} SVG objects from ${name}.`);
  } catch (error) {
    setStatus(error.message);
  }
}

function loadGcodeDocument(gcodeText, name) {
  try {
    const parsed = parseGcodeGeometry(gcodeText, state.machine);
    if (!parsed.polylines.length || !parsed.bounds) throw new Error("No burn geometry was found in this G-code file.");
    loadPolylineDocument(parsed.polylines, parsed.bounds, name, "Imported G-code");
    setStatus(`Loaded ${parsed.polylines.length} toolpath segment${parsed.polylines.length === 1 ? "" : "s"} from ${name}.`);
  } catch (error) {
    setStatus(error.message);
  }
}

function loadLightBurnDocument(sourceText, name) {
  try {
    const parsed = parseLightBurnGeometry(sourceText);
    if (!parsed.polylines.length || !parsed.bounds) throw new Error("No supported LightBurn geometry was found in this file.");
    loadPolylineDocument(parsed.polylines, parsed.bounds, name, "Imported LightBurn");
    setStatus(`Loaded ${parsed.polylines.length} LightBurn shape${parsed.polylines.length === 1 ? "" : "s"} from ${name}.`);
  } catch (error) {
    setStatus(error.message);
  }
}

function loadPolylineDocument(polylines, bounds, name, fallbackLabel) {
  if (!state.operationLayers.length) {
    state.operationLayers = defaultOperationLayers();
    state.selectedOperationLayerId = state.operationLayers[0].id;
  }
  const width = Math.max(0.001, numericOr(bounds?.width, 1));
  const height = Math.max(0.001, numericOr(bounds?.height, 1));
  state.documentName = name;
  state.artworkViewBox = {
    x: numericOr(bounds?.minX ?? bounds?.x, 0),
    y: numericOr(bounds?.minY ?? bounds?.y, 0),
    width,
    height,
  };
  state.sourceDefsMarkup = "";
  const baseScale = Math.min((state.machine.bedWidth * 0.72) / width, (state.machine.bedHeight * 0.72) / height, 1.6);
  const offsetX = (state.machine.bedWidth - width * baseScale) / 2 - state.artworkViewBox.x * baseScale;
  const offsetY = (state.machine.bedHeight - height * baseScale) / 2 - state.artworkViewBox.y * baseScale;
  const operationLayerId = state.operationLayers[0].id;
  const markup = `<g>${buildSvgMarkupFromPolylines(polylines)}</g>`;
  state.objects = [createImportedSceneNodeFromMarkup(
    markup,
    stripExtension(name) || fallbackLabel,
    operationLayerId,
    { x: offsetX, y: offsetY, scale: baseScale, rotation: 0 },
    {
      minX: state.artworkViewBox.x,
      minY: state.artworkViewBox.y,
      width,
      height,
      centerX: state.artworkViewBox.x + width / 2,
      centerY: state.artworkViewBox.y + height / 2,
    },
  )];
  state.selectedObjectIds = state.objects[0] ? [state.objects[0].id] : [];
  state.interactionMode = "select";
  elements.canvas.focus();
  render();
}

function createSceneNodeFromDom(domNode, operationLayerId, transform = { x: 0, y: 0, scale: 1, rotation: 0 }, artworkBounds = state.artworkViewBox) {
  const isContainer = isExplodableSvgGroup(domNode);
  const children = isContainer
    ? filterImportGraphics([...domNode.children], artworkBounds).map((child) => createSceneNodeFromDom(child, operationLayerId, { x: 0, y: 0, scale: 1, rotation: 0 }, artworkBounds))
    : [];
  return {
    id: crypto.randomUUID(),
    name: domNode.getAttribute("id") || domNode.getAttribute("inkscape:label") || prettyNodeName(domNode.tagName),
    type: isContainer ? "group" : domNode.tagName,
    markup: domNode.outerHTML,
    x: transform.x,
    y: transform.y,
    scale: transform.scale,
    rotation: transform.rotation,
    operationLayerId,
    children,
    sourceBounds: measureMarkup(domNode.outerHTML),
  };
}

function filterImportGraphics(nodes, artworkBounds) {
  return (Array.isArray(nodes) ? nodes : [])
    .filter(isGraphicNode)
    .filter((node) => !isLikelyBackgroundRect(node, artworkBounds));
}

function isLikelyBackgroundRect(node, artworkBounds = state.artworkViewBox) {
  if (!node || node.tagName !== "rect" || node.hasAttribute("stroke") || node.hasAttribute("transform")) return false;
  const fill = String(node.getAttribute("fill") || "").trim().toLowerCase();
  if (!["#fff", "#ffffff", "white", "rgb(255,255,255)", "rgb(255, 255, 255)"].includes(fill)) return false;
  const opacity = numericOr(node.getAttribute("opacity"), 1) * numericOr(node.getAttribute("fill-opacity"), 1);
  if (opacity < 0.99) return false;
  const x = numberFromLength(node.getAttribute("x"));
  const y = numberFromLength(node.getAttribute("y"));
  const width = numberFromLength(node.getAttribute("width"));
  const height = numberFromLength(node.getAttribute("height"));
  const minX = numericOr(artworkBounds?.minX ?? artworkBounds?.x, 0);
  const minY = numericOr(artworkBounds?.minY ?? artworkBounds?.y, 0);
  const boundsWidth = Math.max(0, numericOr(artworkBounds?.width, 0));
  const boundsHeight = Math.max(0, numericOr(artworkBounds?.height, 0));
  const tolerance = 0.02;
  return Math.abs(x - minX) <= tolerance
    && Math.abs(y - minY) <= tolerance
    && Math.abs(width - boundsWidth) <= tolerance
    && Math.abs(height - boundsHeight) <= tolerance;
}

function isExplodableSvgGroup(domNode) {
  if (!["g", "svg"].includes(domNode.tagName)) return false;
  const unsafeAttributes = ["transform", "style", "class", "clip-path", "mask", "filter", "opacity", "fill", "stroke", "stroke-width"];
  if (unsafeAttributes.some((name) => domNode.hasAttribute(name))) return false;
  return [...domNode.children].some(isGraphicNode);
}

function createImportedSceneNode(domNode, operationLayerId, transform = { x: 0, y: 0, scale: 1, rotation: 0 }) {
  return {
    id: crypto.randomUUID(),
    name: domNode.getAttribute("id") || domNode.getAttribute("inkscape:label") || prettyNodeName(domNode.tagName),
    type: ["g", "svg"].includes(domNode.tagName) ? "group" : domNode.tagName,
    markup: domNode.outerHTML,
    x: transform.x,
    y: transform.y,
    scale: transform.scale,
    rotation: transform.rotation,
    operationLayerId,
    children: [],
    sourceBounds: measureMarkup(domNode.outerHTML),
  };
}

function createImportedSceneNodeFromMarkup(markup, name, operationLayerId, transform = { x: 0, y: 0, scale: 1, rotation: 0 }, sourceBounds = measureMarkup(markup)) {
  return {
    id: crypto.randomUUID(),
    name,
    type: "group",
    markup,
    x: transform.x,
    y: transform.y,
    scale: transform.scale,
    rotation: transform.rotation,
    operationLayerId,
    children: [],
    sourceBounds,
  };
}

function restoreProject(project, name) {
  if (!project || !project.machine || !Array.isArray(project.objects) || !Array.isArray(project.operationLayers)) throw new Error("Invalid project.");
  state.documentName = project.documentName || stripExtension(name);
  state.artworkViewBox = project.artworkViewBox || state.artworkViewBox;
  state.sourceDefsMarkup = project.sourceDefsMarkup || "";
  state.machine = { ...state.machine, ...project.machine };
  state.operationLayers = project.operationLayers;
  state.objects = normalizeSceneNodes(project.objects, state.operationLayers[0]?.id || "");
  state.selectedObjectIds = Array.isArray(project.selectedObjectIds)
    ? project.selectedObjectIds.filter((id) => Boolean(findNodeById(id, state.objects)))
    : [];
  state.selectedOperationLayerId = project.selectedOperationLayerId || state.operationLayers[0]?.id || "";
  render();
}

function saveProjectFile() {
  downloadText(`${stripExtension(state.documentName) || "lumaburn-project"}.json`, JSON.stringify({
    version: PROJECT_VERSION,
    documentName: state.documentName,
    artworkViewBox: state.artworkViewBox,
    sourceDefsMarkup: state.sourceDefsMarkup,
    machine: state.machine,
    operationLayers: state.operationLayers,
    objects: state.objects,
    selectedObjectIds: state.selectedObjectIds,
    selectedOperationLayerId: state.selectedOperationLayerId,
  }, null, 2));
  setStatus("Saved project JSON.");
}

function isGraphicNode(node) {
  return ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "use", "text", "image"].includes(node.tagName);
}

function render() {
  syncControls();
  renderCanvas();
  renderOperations();
  renderObjectTree();
  renderInspector();
  updateGcodePreview();
  renderStats();
  scheduleWorkspacePersist();
}

function syncControls() {
  populateProfileMenus();
  const selectedNodes = selectedObjects();
  const primaryNode = primarySelectedObject();
  const assignedLayerNames = dedupeStrings(selectedNodes.map((node) => effectiveOperationLayerForNode(node)?.operationLayer?.name).filter(Boolean));
  const viewport = canvasViewport();
  elements.documentName.textContent = state.documentName;
  elements.selectionCount.textContent = `${selectedNodes.length} selected`;
  elements.canvasPanel.style.aspectRatio = "";
  elements.canvasStage.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  elements.toggleGridButton.textContent = state.machine.showGrid ? "Hide Grid" : "Show Grid";
  elements.toggleSnapButton.textContent = state.machine.snapEnabled ? "Snap On" : "Snap Off";
  elements.machinePreset.value = state.machine.presetId;
  elements.machineProfile.value = state.selectedMachineProfileId;
  elements.materialPreset.value = state.machine.materialPresetId;
  elements.bedWidth.value = String(state.machine.bedWidth);
  elements.bedHeight.value = String(state.machine.bedHeight);
  elements.travelSpeed.value = String(state.machine.travelSpeed);
  elements.laserMax.value = String(state.machine.laserMax);
  elements.sampleStep.value = String(state.machine.sampleStep);
  elements.originMode.value = state.machine.originMode;
  elements.safeZ.value = String(state.machine.safeZ);
  elements.frameSpeed.value = String(state.machine.frameSpeed);
  elements.airAssist.checked = state.machine.airAssist;
  elements.showToolpath.checked = state.machine.showToolpath;
  elements.snapStep.value = String(state.machine.snapStep);
  elements.snapEnabled.checked = state.machine.snapEnabled;
  elements.arrayCols.value = String(state.machine.arrayCols);
  elements.arrayRows.value = String(state.machine.arrayRows);
  elements.arrayGapX.value = String(state.machine.arrayGapX);
  elements.arrayGapY.value = String(state.machine.arrayGapY);
  elements.jobHeader.value = state.machine.jobHeader;
  elements.jobFooter.value = state.machine.jobFooter;
  elements.deviceUrl.value = state.device.url;
  elements.deviceProfile.value = state.selectedDeviceProfileId;
  elements.deviceName.value = state.device.friendlyName;
  elements.deviceUploadPath.value = state.device.uploadPath;
  elements.deviceScanRange.value = state.device.scanRange;
  elements.deviceStateLabel.textContent = state.device.stateLabel;
  elements.deviceStateDetail.textContent = state.device.stateDetail;
  elements.deviceFilesMeta.textContent = state.device.lastFileSummary;
  elements.toolbarDeleteWorkspaceButton.disabled = !workspaceSaveExists();
  elements.rightTabButtons.forEach((button) => {
    const tab = button.getAttribute("data-right-tab");
    const active = tab === state.activeRightTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  elements.rightPanels.forEach((panel) => {
    const panelTab = panel.getAttribute("data-right-panel");
    panel.hidden = panelTab !== state.activeRightTab;
  });
  elements.selectModeButton.classList.toggle("button-primary", state.interactionMode === "select");
  elements.selectModeButton.classList.toggle("button-ghost", state.interactionMode !== "select");
  elements.workspaceHint.textContent = state.selectedObjectIds.length
    ? primaryNode
      ? `Selected: ${primaryNode.name}. Drag the item to move it, or drag the bottom-right handle to resize it live.`
      : "Selection active. Drag the item to move it, or drag the bottom-right handle to resize it live."
    : "Click objects to select. Drag to move. Shift-click to multi-select. Arrow keys nudge by 1 mm.";
  elements.operationHelp.textContent = selectedNodes.length
    ? `Selected ${selectedNodes.length} object${selectedNodes.length === 1 ? "" : "s"}. Click an operation row or a colored dot in the object list to assign it.`
    : "Select artwork, then click an operation row or a colored dot in the object list to assign it.";
  elements.objectSelectionSummary.textContent = selectedNodes.length
    ? selectedNodes.length === 1 && primaryNode
      ? `Selected ${primaryNode.name} · ${assignedLayerNames.length ? `Operation: ${assignedLayerNames.join(", ")}` : "No operation assigned"}`
      : `Selected ${selectedNodes.length} objects · ${assignedLayerNames.length ? `Operations: ${assignedLayerNames.join(", ")}` : "No operation assigned"}`
    : "No objects selected.";
  elements.assignOperationButton.disabled = !selectedNodes.length;
  elements.layerCount.textContent = String(state.operationLayers.length);
  elements.objectCount.textContent = String(countObjects(state.objects));
  syncAssignOperationSelect();
  syncDeviceControls();
  renderDiscoveryLog();
  renderDeviceFiles();
  renderDeviceActivity();
}

function syncAssignOperationSelect() {
  elements.assignOperationSelect.innerHTML = state.operationLayers.map((layer) => `<option value="${escapeAttribute(layer.id)}">${escapeHtml(layer.name)}</option>`).join("");
  const selectedLayerId = effectiveOperationLayerForNode(primarySelectedObject())?.operationLayerId
    || state.selectedOperationLayerId
    || state.operationLayers[0]?.id
    || "";
  elements.assignOperationSelect.value = selectedLayerId;
}

function syncDeviceControls() {
  const enabled = state.device.networkAvailable && state.device.enabled;
  const canRunFromController = controllerCanAutostartJobs();
  elements.deviceStreamButton.textContent = canRunFromController ? "Run Job" : "Upload Job";
  elements.deviceStreamButton.title = canRunFromController
    ? "Upload the G-code to controller storage and start it there so the controller owns the run."
    : "This controller path supports upload-only from the app. Start the uploaded file directly on the controller.";
  [elements.deviceConnectButton, elements.deviceUploadButton, elements.deviceStreamButton, elements.deviceFrameButton, elements.deviceUnlockButton, elements.deviceHomeButton, elements.devicePauseButton, elements.deviceResumeButton, elements.deviceCommandButton].forEach((button) => {
    button.disabled = !enabled || state.device.streaming;
  });
  elements.deviceCommand.disabled = !enabled || state.device.streaming;
  elements.deviceScanButton.disabled = !state.device.networkAvailable || state.device.streaming;
  elements.deleteMachineProfileButton.disabled = !state.selectedMachineProfileId;
  elements.deleteDeviceProfileButton.disabled = !state.selectedDeviceProfileId;
}

function renderDiscoveryLog() {
  elements.deviceDiscovery.innerHTML = state.device.discoveryLog.length ? state.device.discoveryLog.map((entry) => escapeHtml(entry)).join("<br />") : "Network discovery has not run yet.";
}

function renderDeviceFiles() {
  if (!state.device.files.length) {
    elements.deviceFiles.innerHTML = "No files found on the active device storage path.";
    elements.deviceFiles.classList.add("empty-state");
    return;
  }
  const canRunFromController = controllerCanAutostartJobs();
  elements.deviceFiles.classList.remove("empty-state");
  elements.deviceFiles.innerHTML = state.device.files.map((file) => `
    <div class="file-item">
      <div>
        <strong>${escapeHtml(file.name || file.shortname || "Unnamed file")}</strong>
        <span>${escapeHtml(file.size || "")}</span>
      </div>
      <div class="file-actions">
        <span>${escapeHtml(file.time || "")}</span>
        <button class="mini-button" data-device-action="run" data-device-file="${escapeAttribute(file.name || file.shortname || "")}" ${canRunFromController ? "" : "disabled title=\"This controller path supports upload-only from the app. Start the file directly on the controller.\""}>Run</button>
        <button class="mini-button" data-device-action="delete" data-device-file="${escapeAttribute(file.name || file.shortname || "")}">Delete</button>
      </div>
    </div>
  `).join("");
}

function renderDeviceActivity() {
  if (!state.device.activityLog.length) {
    elements.deviceActivity.innerHTML = "No controller activity yet.";
    elements.deviceActivity.classList.add("empty-state");
    return;
  }
  elements.deviceActivity.classList.remove("empty-state");
  elements.deviceActivity.innerHTML = state.device.activityLog.map((entry) => `
    <div class="activity-item ${escapeAttribute(entry.level)}">
      <div class="activity-head">
        <strong>${escapeHtml(entry.message)}</strong>
        <span class="activity-meta">${escapeHtml(entry.time)}</span>
      </div>
      ${entry.detail ? `<p>${escapeHtml(entry.detail)}</p>` : ""}
    </div>
  `).join("");
}

function renderOperations() {
  const hasSelection = selectedObjects().length > 0;
  elements.layerList.innerHTML = state.operationLayers.map((layer) => `
    <button type="button" class="layer-item operation-item${layer.id === state.selectedOperationLayerId ? " active" : ""}${layer.enabled ? "" : " disabled"}${hasSelection ? " assign-ready" : ""}" data-operation-id="${layer.id}" style="--operation-color:${escapeAttribute(layer.color)}">
      <div class="layer-topline">
        <strong>${escapeHtml(layer.name)}</strong>
        <span class="layer-chip"><span class="layer-color" style="background:${escapeAttribute(layer.color)}"></span>${escapeHtml(layer.mode)}</span>
      </div>
      <div class="layer-meta">${layer.enabled ? "Enabled" : "Disabled"} · ${layer.feed} mm/min · ${layer.power}% · ${layer.passes} pass${hasSelection ? " · Click to assign selected objects" : ""}</div>
    </button>
  `).join("");
  [...elements.layerList.querySelectorAll("[data-operation-id]")].forEach((button) => {
    button.addEventListener("click", () => {
      const operationId = button.getAttribute("data-operation-id");
      state.selectedOperationLayerId = operationId;
      state.activeRightTab = "edit";
      if (selectedObjects().length) {
        assignSelectedObjectsToOperation(operationId);
        const operation = operationLayerById(operationId);
        setStatus(`Assigned selected objects to ${operation?.name || "operation"}.`);
        return;
      }
      render();
    });
  });
}

function renderObjectTree() {
  elements.objectList.innerHTML = renderObjectNodes(state.objects, 0);
  [...elements.objectList.querySelectorAll("[data-object-id]")].forEach((button) => {
    button.addEventListener("click", (event) => {
      selectObject(button.getAttribute("data-object-id"), event.metaKey || event.ctrlKey);
      state.activeRightTab = "edit";
      render();
    });
  });
  [...elements.objectList.querySelectorAll("[data-assign-object-id][data-assign-operation-id]")].forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const objectId = button.getAttribute("data-assign-object-id");
      const operationId = button.getAttribute("data-assign-operation-id");
      const node = findNodeById(objectId);
      const operation = operationLayerById(operationId);
      if (!node || !operation) return;
      applyOperationToNode(node, operationId);
      state.selectedObjectIds = [objectId];
      state.selectedOperationLayerId = operationId;
      render();
      setStatus(`Assigned ${node.name} to ${operation.name}.`);
    });
  });
}

function renderObjectNodes(nodes, depth, inheritedOperationLayerId = "") {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const children = nodeChildren(node);
    const effectiveOperationLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);
    const operationLayer = operationLayerById(effectiveOperationLayerId) || state.operationLayers[0] || null;
    const effectiveOperationIds = collectEffectiveOperationLayerIds(node, inheritedOperationLayerId);
    const hasMixedOperations = effectiveOperationIds.length > 1;
    const operationColor = hasMixedOperations ? "#6f6f6f" : operationLayer?.color || "#ca5b31";
    const operationLabel = hasMixedOperations
      ? "Mixed operations"
      : operationLayer?.name || "No operation";
    const operationSourceLabel = hasMixedOperations
      ? `${effectiveOperationIds.length} active ops`
      : node.operationLayerId
        ? "Direct"
        : children.length
          ? "Inherited by children"
          : "Inherited";
    const quickAssign = state.operationLayers.map((layer) => `
      <button
        type="button"
        class="operation-dot${layer.id === effectiveOperationLayerId && !hasMixedOperations ? " current" : ""}"
        title="Assign to ${escapeAttribute(layer.name)}"
        aria-label="Assign ${escapeAttribute(node.name)} to ${escapeAttribute(layer.name)}"
        data-assign-object-id="${escapeAttribute(node.id)}"
        data-assign-operation-id="${escapeAttribute(layer.id)}"
        style="--dot-color:${escapeAttribute(layer.color)}"
      ></button>
    `).join("");
    return `
    <div class="object-card" style="margin-left:${depth * 14}px">
      <button type="button" class="layer-item object-item${state.selectedObjectIds.includes(node.id) ? " active" : ""}" data-object-id="${node.id}" style="--object-operation-color:${escapeAttribute(operationColor)}">
        <div class="layer-topline">
          <strong>${escapeHtml(node.name)}</strong>
          <span class="layer-chip"><span class="layer-color" style="background:${escapeAttribute(operationColor)}"></span>${escapeHtml(node.type)}</span>
        </div>
        <div class="layer-meta">${state.selectedObjectIds.includes(node.id) ? "Selected · " : ""}${escapeHtml(operationLabel)} · ${escapeHtml(operationSourceLabel)} · ${children.length ? `${children.length} child` : "leaf"}</div>
      </button>
      <div class="object-operation-dots" aria-label="Operation shortcuts">
        ${quickAssign}
      </div>
    </div>
    ${children.length ? renderObjectNodes(children, depth + 1, effectiveOperationLayerId) : ""}
  `;
  }).join("");
}

function renderInspector() {
  const nodes = selectedObjects();
  const primaryNode = primarySelectedObject();
  const selectionOperation = effectiveOperationLayerForNode(primaryNode)?.operationLayer || null;
  const operationLayer = selectionOperation || operationLayerById(state.selectedOperationLayerId) || state.operationLayers[0] || null;
  const hasObjectSelection = Boolean(primaryNode);
  const hasOperationContext = Boolean(operationLayer);
  const hasInspectorContext = hasObjectSelection || hasOperationContext;
  elements.inspectorSelectionSummary.textContent = primaryNode
    ? nodes.length <= 1 ? `Editing ${primaryNode.name}` : `Editing ${primaryNode.name} · primary of ${nodes.length} selected`
    : operationLayer ? `No object selected. Editing operation ${operationLayer.name}.` : "No object selected.";
  elements.inspectorEmpty.classList.toggle("hidden", hasInspectorContext);
  elements.inspectorFields.classList.toggle("hidden", !hasInspectorContext);
  if (!hasInspectorContext) {
    elements.inspectorEmpty.textContent = "Click an object on the canvas or in the Objects list to edit size and placement.";
    elements.inspectorObjectSummary.textContent = "Select one object to edit placement and size";
    elements.inspectorOperationSummary.textContent = "Laser output settings";
    return;
  }
  const node = primaryNode;
  const objectEditable = Boolean(node);
  const nodeContext = node ? findNodeContextById(node.id) : null;
  const bounds = objectEditable ? objectWorldBounds(node, nodeContext?.parentTransform) : null;
  const effectiveSelection = effectiveOperationLayerForNode(node);
  const operationSource = objectEditable && effectiveSelection
    ? ` · ${effectiveSelection.direct ? "direct" : "inherited"}`
    : "";
  elements.inspectorObjectBlock.classList.toggle("inactive", !objectEditable);
  elements.inspectorOperationBlock.classList.toggle("inactive", !hasOperationContext);
  elements.inspectorObjectSummary.textContent = objectEditable
    ? `${node.name} · exact selected part`
    : "Select one object to edit placement and size";
  elements.inspectorOperationSummary.textContent = operationLayer
    ? `${operationLayer.name}${operationSource} · ${operationLayer.mode} · ${operationLayer.power}% @ ${operationLayer.feed} mm/min`
    : "Laser output settings";
  elements.layerName.disabled = !objectEditable;
  elements.layerX.disabled = !objectEditable;
  elements.layerY.disabled = !objectEditable;
  elements.layerScale.disabled = !objectEditable;
  elements.layerRotation.disabled = !objectEditable;
  elements.layerName.value = objectEditable ? node.name : "";
  elements.assignOperationSelect.value = operationLayer?.id || "";
  elements.operationName.value = operationLayer?.name || "";
  elements.layerX.value = objectEditable ? formatCompact(node.x) : "";
  elements.layerY.value = objectEditable ? formatCompact(node.y) : "";
  elements.layerScale.value = objectEditable ? round(node.scale, 2).toFixed(2) : "";
  elements.layerWidth.disabled = !objectEditable;
  elements.layerHeight.disabled = !objectEditable;
  elements.layerWidth.value = bounds ? formatCompact(bounds.width) : "";
  elements.layerHeight.value = bounds ? formatCompact(bounds.height) : "";
  elements.layerRotation.value = objectEditable ? String(round(node.rotation, 1)) : "";
  elements.layerMode.value = operationLayer?.mode || "line";
  elements.lineStyle.value = operationLayer?.lineStyle || "continuous";
  elements.dashLength.value = String(operationLayer?.dashLength ?? 3);
  elements.gapLength.value = String(operationLayer?.gapLength ?? 1);
  const allowDashedLine = (operationLayer?.mode || "line") !== "fill";
  elements.lineStyle.disabled = !allowDashedLine;
  const dashedActive = allowDashedLine && elements.lineStyle.value === "dashed";
  elements.dashLength.disabled = !dashedActive;
  elements.gapLength.disabled = !dashedActive;
  elements.layerFeed.value = String(operationLayer?.feed || 1800);
  elements.layerPower.value = String(operationLayer?.power || 70);
  elements.layerPasses.value = String(operationLayer?.passes || 1);
  elements.layerColor.value = normalizeColor(operationLayer?.color || "#ca5b31");
  elements.layerEnabled.checked = Boolean(operationLayer?.enabled);
  elements.layerAirAssist.checked = Boolean(operationLayer?.airAssist);
}

function renderCanvas() {
  elements.canvas.innerHTML = "";
  const viewBox = canvasViewport();
  elements.canvas.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  elements.canvas.setAttribute("preserveAspectRatio", "xMinYMin meet");
  appendSvgMarkup(elements.canvas, state.sourceDefsMarkup);
  renderBedSurface();
  if (state.machine.showGrid) renderGrid();
  renderBedOutline();
  renderBedGuides();
  renderOrigin();
  state.objects.forEach((node) => elements.canvas.appendChild(renderCanvasNode(node, true)));
  renderInteractionOverlay();
  renderSelectionOverlay();
}

function renderBedSurface() {
  const defs = createSvg("defs");
  const gradient = createSvg("linearGradient", {
    id: "bed-surface-gradient",
    x1: "0%",
    y1: "0%",
    x2: "0%",
    y2: "100%",
  });
  gradient.appendChild(createSvg("stop", { offset: "0%", "stop-color": "#fffdf8" }));
  gradient.appendChild(createSvg("stop", { offset: "100%", "stop-color": "#f8f1e6" }));
  defs.appendChild(gradient);
  elements.canvas.appendChild(defs);
  elements.canvas.appendChild(createSvg("rect", {
    x: 0,
    y: 0,
    width: state.machine.bedWidth,
    height: state.machine.bedHeight,
    rx: 2.5,
    class: "bed-surface",
    fill: "url(#bed-surface-gradient)",
  }));
}

function renderCanvasNode(node, isTopLevel = false) {
  const effectiveOperation = effectiveOperationLayerForNode(node);
  const children = nodeChildren(node);
  const wrapper = createSvg("g", {
    transform: composeTransform(node),
    "data-object-id": node.id,
    class: `artwork${state.selectedObjectIds.includes(node.id) ? " selected" : ""}`,
    "pointer-events": "bounding-box",
    ...(isTopLevel ? { "data-workspace-object-id": node.id } : {}),
  });
  if (isTopLevel) {
    wrapper.addEventListener("mousedown", (event) => startObjectInteraction(event, node.id));
  }
  if (children.length) {
    children.forEach((child) => wrapper.appendChild(renderCanvasNode(child, false)));
  } else {
    appendSvgMarkup(wrapper, node.markup);
    const operationLayer = effectiveOperation?.operationLayer || state.operationLayers[0] || null;
    const dashPattern = operationLayer?.mode !== "fill" && operationLayer?.lineStyle === "dashed"
      ? `${Math.max(0.1, Number(operationLayer.dashLength) || 3)} ${Math.max(0, Number(operationLayer.gapLength) || 1)}`
      : null;
    [wrapper.firstElementChild, ...wrapper.querySelectorAll("*")].forEach((el) => {
      if (!(el instanceof SVGElement)) return;
      el.setAttribute("vector-effect", "non-scaling-stroke");
      el.setAttribute("pointer-events", "none");
      const stroke = operationLayer?.color || "#161616";
      if (el.tagName === "image") return;
      el.style.strokeDasharray = dashPattern || "none";
      el.style.strokeDashoffset = "0";
      if (dashPattern) {
        el.setAttribute("stroke-dasharray", dashPattern);
      } else {
        el.removeAttribute("stroke-dasharray");
        el.removeAttribute("stroke-dashoffset");
      }
      const existingStroke = el.getAttribute("stroke");
      const existingFill = el.getAttribute("fill");
      if (!existingStroke && (!existingFill || existingFill === "none")) {
        el.setAttribute("stroke", stroke);
        el.setAttribute("stroke-width", el.getAttribute("stroke-width") || (operationLayer?.mode === "score" ? "0.8" : "1"));
      }
      if ((operationLayer?.mode || "line") === "fill" && (!existingFill || existingFill === "none")) {
        el.setAttribute("fill", colorToAlpha(stroke, 0.18));
      }
    });
  }
  if (state.machine.showToolpath && !children.length) {
    renderToolpathPreview(node, wrapper);
  }
  return wrapper;
}

function renderSelectionOverlay() {
  const overlay = createSvg("g", { class: "selection-overlay" });
  const viewBox = canvasViewport();
  const primaryNode = primarySelectedObject();
  selectedObjects().forEach((node) => {
    const context = findNodeContextById(node.id);
    const b = context ? objectWorldBounds(node, context.parentTransform) : objectWorldBounds(node);
    const operationColor = effectiveOperationLayerForNode(node)?.operationLayer?.color || "#ca5b31";
    overlay.appendChild(createSvg("rect", {
      x: b.x,
      y: b.y,
      width: Math.max(0.5, b.width),
      height: Math.max(0.5, b.height),
      class: "selection-outline",
      fill: "none",
      stroke: operationColor,
      "stroke-width": 1,
      "stroke-dasharray": "4 3",
      "pointer-events": "none",
    }));
    overlay.appendChild(createSvg("text", {
      x: b.x + 4,
      y: Math.max(viewBox.y + 12, b.y - 6),
      class: "canvas-hud selection-dimensions",
      fill: "#7a3a22",
      "pointer-events": "none",
    }, `${formatCompact(b.width)} × ${formatCompact(b.height)} mm`));
    if (primaryNode?.id === node.id) {
      overlay.appendChild(createSvg("path", {
        d: `M ${b.x + b.width - 14} ${b.y + b.height} L ${b.x + b.width} ${b.y + b.height} L ${b.x + b.width} ${b.y + b.height - 14}`,
        class: "resize-corner",
        stroke: operationColor,
        "stroke-width": 2.4,
        fill: "none",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "pointer-events": "none",
      }));
      const handle = createSvg("rect", {
        x: b.x + b.width - 8,
        y: b.y + b.height - 8,
        width: 16,
        height: 16,
        rx: 4,
        class: "resize-handle",
        fill: "transparent",
        stroke: operationColor,
        "stroke-width": 2.6,
        "data-resize-object-id": node.id,
      });
      handle.addEventListener("mousedown", (event) => startResizeInteraction(event, node.id));
      overlay.appendChild(handle);
      overlay.appendChild(createSvg("path", {
        d: `M ${b.x + b.width - 3} ${b.y + b.height + 1} L ${b.x + b.width + 3} ${b.y + b.height - 5} M ${b.x + b.width - 1} ${b.y + b.height + 5} L ${b.x + b.width + 5} ${b.y + b.height - 1}`,
        class: "resize-glyph",
        stroke: operationColor,
        "stroke-width": 1.8,
        fill: "none",
        "stroke-linecap": "round",
        "pointer-events": "none",
      }));
    }
  });
  elements.canvas.appendChild(overlay);
}

function renderInteractionOverlay() {
  const overlay = createSvg("g", { class: "interaction-overlay" });
  flattenNodes(state.objects).forEach((node) => {
    const context = findNodeContextById(node.id);
    const b = context ? objectWorldBounds(node, context.parentTransform) : objectWorldBounds(node);
    const hitbox = createSvg("rect", {
      x: b.x,
      y: b.y,
      width: Math.max(6, b.width),
      height: Math.max(6, b.height),
      class: "object-hitbox",
      "data-object-id": node.id,
      "data-hitbox-for": node.id,
    });
    hitbox.addEventListener("mousedown", (event) => startObjectInteraction(event, node.id));
    overlay.appendChild(hitbox);
  });
  elements.canvas.appendChild(overlay);
}

function renderToolpathPreview(node, wrapper) {
  const leaves = collectLeafEntries([node]);
  leaves.forEach((entry) => {
    if (!entry.operationLayer.enabled) return;
    applyLineStyleToPolylines(
      extractLeafGeometry(entry.node, entry.transform, entry.operationLayer),
      entry.operationLayer,
    ).forEach((polyline) => {
      wrapper.appendChild(createSvg("polyline", {
        points: polyline.map((p) => `${format(p.x)},${format(p.y)}`).join(" "),
        fill: "none",
        stroke: colorToAlpha(entry.operationLayer.color, 0.18),
        "stroke-width": 0.8,
        "stroke-dasharray": entry.operationLayer.mode === "fill" ? "2 1" : "none",
        "pointer-events": "none",
      }));
    });
  });
}

function renderGrid() {
  const grid = createSvg("g", { class: "canvas-grid" });
  for (let x = 0; x <= state.machine.bedWidth; x += 10) {
    const major = x % 100 === 0;
    const mid = !major && x % 50 === 0;
    grid.appendChild(createSvg("line", {
      x1: x,
      y1: 0,
      x2: x,
      y2: state.machine.bedHeight,
      stroke: major ? "rgba(122,58,34,0.42)" : mid ? "rgba(122,58,34,0.24)" : "rgba(22,22,22,0.11)",
      "stroke-width": major ? 1.2 : mid ? 0.85 : 0.45,
    }));
  }
  for (let y = 0; y <= state.machine.bedHeight; y += 10) {
    const major = y % 100 === 0;
    const mid = !major && y % 50 === 0;
    grid.appendChild(createSvg("line", {
      x1: 0,
      y1: y,
      x2: state.machine.bedWidth,
      y2: y,
      stroke: major ? "rgba(122,58,34,0.42)" : mid ? "rgba(122,58,34,0.24)" : "rgba(22,22,22,0.11)",
      "stroke-width": major ? 1.2 : mid ? 0.85 : 0.45,
    }));
  }
  elements.canvas.appendChild(grid);
}

function renderBedOutline() {
  elements.canvas.appendChild(createSvg("rect", {
    x: 0.75,
    y: 0.75,
    width: Math.max(0, state.machine.bedWidth - 1.5),
    height: Math.max(0, state.machine.bedHeight - 1.5),
    rx: 2,
    fill: "none",
    stroke: "rgba(22,22,22,0.68)",
    "stroke-width": 1.8,
  }));
}

function renderBedGuides() {
  const guideGroup = createSvg("g", { class: "bed-guides" });
  guideGroup.appendChild(createSvg("text", {
    x: 0,
    y: -18,
    class: "canvas-hud bed-label",
    fill: "#5e5a55",
  }, `Bed ${formatCompact(state.machine.bedWidth)} x ${formatCompact(state.machine.bedHeight)} mm`));
  guideGroup.appendChild(createSvg("text", {
    x: 0,
    y: -8,
    class: "canvas-hud bed-label",
    fill: "#5e5a55",
  }, `Ray5 job origin: ${state.machine.originMode === "lower-left" ? "lower-left" : "upper-left"} home`));
  renderBedRulers(guideGroup);
  elements.canvas.appendChild(guideGroup);
}

function renderBedRulers(group) {
  const lowerLeft = state.machine.originMode === "lower-left";
  const rulerOffset = 8;
  const baselineY = lowerLeft ? state.machine.bedHeight + rulerOffset : -rulerOffset;
  const baselineX = -rulerOffset;
  const xTextY = lowerLeft ? baselineY + 10 : baselineY - 6;
  group.appendChild(createSvg("line", {
    x1: 0,
    y1: baselineY,
    x2: state.machine.bedWidth,
    y2: baselineY,
    stroke: "rgba(122,58,34,0.75)",
    "stroke-width": 0.9,
  }));
  group.appendChild(createSvg("line", {
    x1: baselineX,
    y1: 0,
    x2: baselineX,
    y2: state.machine.bedHeight,
    stroke: "rgba(122,58,34,0.75)",
    "stroke-width": 0.9,
  }));
  for (let x = 0; x <= state.machine.bedWidth; x += 10) {
    const major = x % 100 === 0;
    const mid = !major && x % 50 === 0;
    const tick = major ? 10 : mid ? 7 : 4;
    group.appendChild(createSvg("line", {
      x1: x,
      y1: baselineY,
      x2: x,
      y2: lowerLeft ? baselineY - tick : baselineY + tick,
      stroke: major ? "rgba(122,58,34,0.9)" : "rgba(94,90,84,0.6)",
      "stroke-width": major ? 1 : 0.7,
    }));
    if (major) {
      group.appendChild(createSvg("text", {
        x,
        y: x === 0 ? xTextY : xTextY,
        class: "canvas-hud ruler-label",
        fill: "rgba(122,58,34,0.95)",
        "text-anchor": x === 0 ? "start" : "middle",
      }, `${x}`));
    }
  }
  for (let y = 0; y <= state.machine.bedHeight; y += 10) {
    const major = y % 100 === 0;
    const mid = !major && y % 50 === 0;
    const tick = major ? 10 : mid ? 7 : 4;
    group.appendChild(createSvg("line", {
      x1: baselineX,
      y1: y,
      x2: baselineX + tick,
      y2: y,
      stroke: major ? "rgba(122,58,34,0.9)" : "rgba(94,90,84,0.6)",
      "stroke-width": major ? 1 : 0.7,
    }));
    if (major) {
      const label = lowerLeft ? state.machine.bedHeight - y : y;
      group.appendChild(createSvg("text", {
        x: baselineX - 4,
        y: y + 2,
        class: "canvas-hud ruler-label",
        fill: "rgba(122,58,34,0.95)",
        "text-anchor": "end",
      }, `${label}`));
    }
  }
}

function renderOrigin() {
  const lowerLeft = state.machine.originMode === "lower-left";
  const originX = 0;
  const originY = lowerLeft ? state.machine.bedHeight : 0;
  const labelY = lowerLeft ? originY - 10 : originY + 18;
  const origin = createSvg("g", { class: "machine-origin" });
  origin.appendChild(createSvg("line", { x1: originX, y1: originY, x2: originX + 16, y2: originY, stroke: "#ca5b31", "stroke-width": 1.8, "stroke-linecap": "round" }));
  origin.appendChild(createSvg("line", { x1: originX, y1: originY, x2: originX, y2: lowerLeft ? originY - 16 : originY + 16, stroke: "#ca5b31", "stroke-width": 1.8, "stroke-linecap": "round" }));
  origin.appendChild(createSvg("circle", { cx: originX, cy: originY, r: 3.8, fill: "#ca5b31" }));
  origin.appendChild(createSvg("text", { x: originX + 20, y: labelY, class: "canvas-hud origin-label", fill: "#7a3a22" }, "Home 0,0"));
  elements.canvas.appendChild(origin);
}

function onCanvasMouseDown(event) {
  if (event.button !== 0) return;
  elements.canvas.focus();
  if (state.interactionMode !== "select") return;
  const target = event.target.closest("[data-object-id]");
  if (!target) {
    state.selectedObjectIds = [];
    render();
    return;
  }
  startObjectInteraction(event, target.getAttribute("data-object-id"));
}

function onCanvasMouseMove(event) {
  if (!state.dragSession) return;
  if ((event.buttons & 1) !== 1) {
    onCanvasMouseUp();
    return;
  }
  const point = eventToSvgPoint(event);
  const dx = point.x - state.dragSession.startPoint.x;
  const dy = point.y - state.dragSession.startPoint.y;
  if (!state.dragSession.active && Math.hypot(dx, dy) < 2) return;
  state.dragSession.active = true;
  event.preventDefault();
  if (state.dragSession.kind === "resize") {
    updateLiveResize(point);
    render();
    return;
  }
  state.dragSession.origins.forEach((origin) => {
    const node = findNodeById(origin.id);
    if (!node) return;
    node.x = round(origin.x + dx, 2);
    node.y = round(origin.y + dy, 2);
  });
  updateLiveWorkspaceDuringDrag();
}

function onCanvasMouseUp() {
  if (!state.dragSession) return;
  window.removeEventListener("mousemove", onCanvasMouseMove);
  window.removeEventListener("mouseup", onCanvasMouseUp);
  window.removeEventListener("blur", onCanvasMouseUp);
  if (state.dragSession.active) render();
  state.dragSession = null;
}

function startObjectInteraction(event, objectId) {
  if (!objectId) return;
  event.preventDefault();
  event.stopPropagation();
  elements.canvas.focus();
  const previousSelection = state.selectedObjectIds.join(",");
  selectObject(objectId, event.metaKey || event.ctrlKey);
  if (state.selectedObjectIds.join(",") !== previousSelection) {
    state.activeRightTab = "edit";
    render();
  }
  const point = eventToSvgPoint(event);
  state.dragSession = {
    kind: "move",
    startPoint: point,
    origins: selectedWorkspaceObjects().map((node) => ({ id: node.id, x: node.x, y: node.y })),
    active: false,
  };
  window.addEventListener("mousemove", onCanvasMouseMove);
  window.addEventListener("mouseup", onCanvasMouseUp);
  window.addEventListener("blur", onCanvasMouseUp);
  refreshSelectionUi();
}

function startResizeInteraction(event, objectId) {
  if (!objectId) return;
  event.preventDefault();
  event.stopPropagation();
  elements.canvas.focus();
  selectObject(objectId, false);
  state.activeRightTab = "edit";
  const node = findNodeById(objectId);
  const context = node ? findNodeContextById(node.id) : null;
  const bounds = node && context ? objectWorldBounds(node, context.parentTransform) : null;
  if (!node || !context || !bounds || bounds.width <= 0 || bounds.height <= 0) {
    render();
    return;
  }
  const point = eventToSvgPoint(event);
  state.dragSession = {
    kind: "resize",
    objectId,
    startPoint: point,
    startBounds: bounds,
    startScale: node.scale,
    startX: node.x,
    startY: node.y,
    sourceBounds: node.sourceBounds,
    active: false,
  };
  window.addEventListener("mousemove", onCanvasMouseMove);
  window.addEventListener("mouseup", onCanvasMouseUp);
  window.addEventListener("blur", onCanvasMouseUp);
  render();
}

function eventToSvgPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const viewBox = elements.canvas.viewBox.baseVal;
  return {
    x: viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.width,
    y: viewBox.y + ((event.clientY - rect.top) / rect.height) * viewBox.height,
  };
}

function updateLiveResize(point) {
  if (!state.dragSession || state.dragSession.kind !== "resize") return;
  const node = findNodeById(state.dragSession.objectId);
  if (!node) return;
  const nextWidth = Math.max(2, point.x - state.dragSession.startBounds.x);
  const nextHeight = Math.max(2, point.y - state.dragSession.startBounds.y);
  const widthRatio = nextWidth / Math.max(0.001, state.dragSession.startBounds.width);
  const heightRatio = nextHeight / Math.max(0.001, state.dragSession.startBounds.height);
  const ratio = Math.max(0.05, Math.max(widthRatio, heightRatio));
  const nextScale = round(Math.max(0.01, state.dragSession.startScale * ratio), 4);
  node.scale = nextScale;
  node.x = round(state.dragSession.startX + state.dragSession.sourceBounds.minX * (state.dragSession.startScale - nextScale), 2);
  node.y = round(state.dragSession.startY + state.dragSession.sourceBounds.minY * (state.dragSession.startScale - nextScale), 2);
}

function selectObject(id, additive = false) {
  if (!additive) {
    state.selectedObjectIds = [id];
    return;
  }
  state.selectedObjectIds = state.selectedObjectIds.includes(id) ? state.selectedObjectIds.filter((item) => item !== id) : [...state.selectedObjectIds, id];
}

function selectedObjects() {
  return state.selectedObjectIds.map(findNodeById).filter(Boolean);
}

function primarySelectedObject() {
  const primaryId = state.selectedObjectIds.at(-1);
  return primaryId ? findNodeById(primaryId) : null;
}

function selectWorkspaceObject(id, additive = false) {
  const topLevel = topLevelNodeForId(id);
  if (!topLevel) return;
  const existing = state.selectedObjectIds.filter((item) => state.objects.some((node) => node.id === item));
  const nextSelection = existing.includes(topLevel.id)
    ? existing.filter((item) => item !== topLevel.id)
    : [...existing, topLevel.id];
  state.selectedObjectIds = additive ? nextSelection : [topLevel.id];
}

function selectedWorkspaceObjects() {
  return dedupeStrings(state.selectedObjectIds.map((id) => topLevelNodeForId(id)?.id))
    .map((id) => findNodeById(id))
    .filter(Boolean);
}

function selectedWorkspaceObjectsOrAll() {
  const selected = selectedWorkspaceObjects();
  return selected.length ? selected : state.objects;
}

function selectedObjectBounds() {
  return selectedObjects()
    .map((node) => {
      const context = findNodeContextById(node.id);
      return context ? objectWorldBounds(node, context.parentTransform) : null;
    })
    .filter(Boolean);
}

function resizeSelectedObjectToDimension(dimension, value) {
  const node = primarySelectedObject();
  if (!node) return;
  const nextSize = Number(value);
  if (!Number.isFinite(nextSize) || nextSize <= 0) return;
  const context = findNodeContextById(node.id);
  const bounds = context ? objectWorldBounds(node, context.parentTransform) : objectWorldBounds(node);
  const currentSize = dimension === "width" ? bounds.width : bounds.height;
  if (!Number.isFinite(currentSize) || currentSize <= 0) return;
  const factor = nextSize / currentSize;
  node.scale = round(Math.max(0.01, node.scale * factor), 4);
  render();
}

function refreshSelectionUi() {
  elements.selectionCount.textContent = `${selectedObjects().length} selected`;
  elements.workspaceHint.textContent = state.selectedObjectIds.length
    ? "Drag the selected item to move it, or drag the bottom-right handle to resize it live. Shift + Arrow moves 10x."
    : "Click objects to select. Drag to move. Shift-click to multi-select. Arrow keys nudge by the active grid step.";
  renderObjectTree();
  renderInspector();
}

function updateLiveWorkspaceDuringDrag() {
  selectedWorkspaceObjects().forEach((node) => {
    const wrapper = elements.canvas.querySelector(`[data-workspace-object-id="${CSS.escape(node.id)}"]`);
    if (wrapper) wrapper.setAttribute("transform", composeTransform(node));
  });
  state.objects.forEach((node) => {
    const hitbox = elements.canvas.querySelector(`[data-hitbox-for="${CSS.escape(node.id)}"]`);
    if (!hitbox) return;
    const bounds = objectWorldBounds(node);
    hitbox.setAttribute("x", String(bounds.x));
    hitbox.setAttribute("y", String(bounds.y));
    hitbox.setAttribute("width", String(Math.max(6, bounds.width)));
    hitbox.setAttribute("height", String(Math.max(6, bounds.height)));
  });
  const previousOverlay = elements.canvas.querySelector(".selection-overlay");
  if (previousOverlay) previousOverlay.remove();
  renderSelectionOverlay();
}

function nodeChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function numericOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSourceBounds(bounds) {
  const minX = numericOr(bounds?.minX, 0);
  const minY = numericOr(bounds?.minY, 0);
  const width = Math.max(0.001, numericOr(bounds?.width, 1));
  const height = Math.max(0.001, numericOr(bounds?.height, 1));
  return {
    minX,
    minY,
    width,
    height,
    centerX: numericOr(bounds?.centerX, minX + width / 2),
    centerY: numericOr(bounds?.centerY, minY + height / 2),
  };
}

function normalizeSceneNode(node, fallbackOperationLayerId = "") {
  if (!node || typeof node !== "object") return null;
  const children = nodeChildren(node)
    .map((child) => normalizeSceneNode(child, fallbackOperationLayerId))
    .filter(Boolean);
  const sourceBounds = normalizeSourceBounds(node.sourceBounds);
  const markup = typeof node.markup === "string"
    ? stripLikelySvgBackgroundRect(node.markup, sourceBounds)
    : "";
  if (!markup && !children.length) return null;
  return {
    id: typeof node.id === "string" && node.id ? node.id : crypto.randomUUID(),
    name: typeof node.name === "string" && node.name ? node.name : "Imported Object",
    type: typeof node.type === "string" && node.type ? node.type : (children.length ? "group" : "path"),
    markup,
    x: numericOr(node.x, 0),
    y: numericOr(node.y, 0),
    scale: Math.max(0.001, numericOr(node.scale, 1)),
    rotation: numericOr(node.rotation, 0),
    operationLayerId: typeof node.operationLayerId === "string" && node.operationLayerId ? node.operationLayerId : fallbackOperationLayerId,
    children,
    sourceBounds,
  };
}

function normalizeSceneNodes(nodes, fallbackOperationLayerId = "") {
  return (Array.isArray(nodes) ? nodes : [])
    .map((node) => normalizeSceneNode(node, fallbackOperationLayerId))
    .filter(Boolean);
}

function findNodeById(id, nodes = state.objects) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.id === id) return node;
    const child = findNodeById(id, nodeChildren(node));
    if (child) return child;
  }
  return null;
}

function findNodeContextById(
  id,
  nodes = state.objects,
  parentTransform = { x: 0, y: 0, scale: 1, rotation: 0 },
  inheritedOperationLayerId = "",
  topLevelNode = null,
) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const effectiveOperationLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);
    const currentTopLevelNode = topLevelNode || node;
    if (node.id === id) {
      return {
        node,
        parentTransform,
        effectiveOperationLayerId,
        topLevelNode: currentTopLevelNode,
        direct: Boolean(node.operationLayerId),
      };
    }
    const nested = findNodeContextById(
      id,
      nodeChildren(node),
      combineTransforms(parentTransform, node),
      effectiveOperationLayerId,
      currentTopLevelNode,
    );
    if (nested) return nested;
  }
  return null;
}

function topLevelNodeForId(id) {
  return findNodeContextById(id)?.topLevelNode || null;
}

function flattenNodes(nodes, results = []) {
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    results.push(node);
    const children = nodeChildren(node);
    if (children.length) flattenNodes(children, results);
  });
  return results;
}

function findParentArray(id, nodes = state.objects) {
  const currentNodes = Array.isArray(nodes) ? nodes : [];
  for (const node of currentNodes) {
    const children = nodeChildren(node);
    if (children.some((child) => child.id === id)) return children;
    const nested = findParentArray(id, children);
    if (nested) return nested;
  }
  return currentNodes.some((node) => node.id === id) ? currentNodes : null;
}

function addOperationLayer() {
  const name = window.prompt("Operation name:", `Cut ${state.operationLayers.length + 1}`);
  if (!name) return;
  const op = createOperationLayer(name, defaultOperationColor(state.operationLayers.length));
  state.operationLayers.push(op);
  state.selectedOperationLayerId = op.id;
  render();
}

function moveOperationLayer(direction) {
  const index = state.operationLayers.findIndex((layer) => layer.id === state.selectedOperationLayerId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.operationLayers.length) return;
  const [layer] = state.operationLayers.splice(index, 1);
  state.operationLayers.splice(target, 0, layer);
  render();
}

function toggleAllOperationLayers() {
  const enable = state.operationLayers.some((layer) => !layer.enabled);
  state.operationLayers.forEach((layer) => { layer.enabled = enable; });
  render();
}

function updateSelectedOperationLayer(mutator) {
  const layerId = elements.assignOperationSelect.value || state.selectedOperationLayerId;
  const layer = operationLayerById(layerId);
  if (!layer) return;
  mutator(layer);
  state.selectedOperationLayerId = layer.id;
  render();
}

function operationLayerById(id) {
  return state.operationLayers.find((layer) => layer.id === id) || null;
}

function resolveOperationLayerId(explicitOperationLayerId, inheritedOperationLayerId = "") {
  return explicitOperationLayerId || inheritedOperationLayerId || state.operationLayers[0]?.id || "";
}

function effectiveOperationLayerForNodeId(id) {
  const context = findNodeContextById(id);
  if (!context) return null;
  return {
    direct: context.direct,
    operationLayerId: context.effectiveOperationLayerId,
    operationLayer: operationLayerById(context.effectiveOperationLayerId) || state.operationLayers[0] || null,
  };
}

function effectiveOperationLayerForNode(node) {
  return node ? effectiveOperationLayerForNodeId(node.id) : null;
}

function collectEffectiveOperationLayerIds(node, inheritedOperationLayerId = "") {
  const effectiveOperationLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);
  const children = nodeChildren(node);
  if (!children.length) return effectiveOperationLayerId ? [effectiveOperationLayerId] : [];
  return dedupeStrings(children.flatMap((child) => collectEffectiveOperationLayerIds(child, effectiveOperationLayerId)));
}

function assignSelectedObjectsToOperation(operationLayerId) {
  if (!operationLayerId) return;
  selectedObjects().forEach((node) => applyOperationToNode(node, operationLayerId));
  state.selectedOperationLayerId = operationLayerId;
  render();
}

function applyOperationToNode(node, operationLayerId) {
  node.operationLayerId = operationLayerId;
}

function groupSelection() {
  if (state.selectedObjectIds.length < 2) {
    setStatus("Select at least two sibling objects to group.");
    return;
  }
  const parentArrays = dedupeStrings(state.selectedObjectIds.map((id) => String(findParentArray(id))));
  if (parentArrays.length !== 1) {
    setStatus("Only sibling objects can be grouped in one action.");
    return;
  }
  const parentArray = findParentArray(state.selectedObjectIds[0]);
  const selected = parentArray.filter((node) => state.selectedObjectIds.includes(node.id));
  if (selected.length < 2) {
    setStatus("Only sibling objects can be grouped in one action.");
    return;
  }
  const insertionIndex = parentArray.findIndex((node) => node.id === selected[0].id);
  const group = {
    id: crypto.randomUUID(),
    name: `Group ${selected[0].name}`,
    type: "group",
    markup: "",
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    operationLayerId: selected[0].operationLayerId,
    children: selected.map(structuredClone),
    sourceBounds: unionBounds(selected.map((node) => objectWorldBounds(node))),
  };
  const remaining = parentArray.filter((node) => !state.selectedObjectIds.includes(node.id));
  remaining.splice(insertionIndex, 0, group);
  replaceArrayContents(parentArray, remaining);
  state.selectedObjectIds = [group.id];
  render();
}

function ungroupSelection() {
  const groups = selectedObjects().filter((node) => nodeChildren(node).length);
  if (!groups.length) {
    setStatus("Select a grouped object to ungroup.");
    return;
  }
  const promotedIds = [];
  groups.forEach((group) => {
    const parentArray = findParentArray(group.id);
    const index = parentArray.findIndex((node) => node.id === group.id);
    const promoted = explodeGroupNode(group);
    promotedIds.push(...promoted.map((node) => node.id));
    parentArray.splice(index, 1, ...promoted);
  });
  state.selectedObjectIds = promotedIds;
  render();
  setStatus(`Ungrouped selection into ${promotedIds.length} editable part${promotedIds.length === 1 ? "" : "s"}.`);
}

function flattenChildTransform(group, child) {
  child.x = group.x + child.x * group.scale;
  child.y = group.y + child.y * group.scale;
  child.scale *= group.scale;
  child.rotation += group.rotation;
  return child;
}

function explodeGroupNode(group) {
  const descendants = nodeChildren(group).map((child) => flattenChildTransform(group, structuredClone(child)));
  return descendants.flatMap((child) => nodeChildren(child).length ? explodeGroupNode(child) : [child]);
}

function centerSelectionOnBed() {
  const nodes = selectedWorkspaceObjectsOrAll();
  const bounds = selectionBounds(nodes);
  if (!bounds) return setStatus("Import or select objects to center.");
  const dx = (state.machine.bedWidth - bounds.width) / 2 - bounds.x;
  const dy = (state.machine.bedHeight - bounds.height) / 2 - bounds.y;
  nodes.forEach((node) => { node.x = snap(node.x + dx); node.y = snap(node.y + dy); });
  render();
  setStatus("Selection centered on bed.");
}

function homeSelectionOnBed() {
  const nodes = selectedWorkspaceObjectsOrAll();
  const bounds = selectionBounds(nodes);
  if (!bounds) return setStatus("Import or select objects to home.");
  const dx = -bounds.x;
  const dy = state.machine.originMode === "lower-left"
    ? state.machine.bedHeight - (bounds.y + bounds.height)
    : -bounds.y;
  nodes.forEach((node) => {
    node.x = snap(node.x + dx);
    node.y = snap(node.y + dy);
  });
  render();
  setStatus(state.machine.originMode === "lower-left"
    ? "Selection moved to machine home at the lower-left corner."
    : "Selection moved to machine home at the upper-left corner.");
}

function duplicateSelection() {
  const items = selectedObjects().map((node) => offsetNode(structuredClone(node), 10, 10));
  if (!items.length) return setStatus("Select objects to duplicate.");
  const parentArray = findParentArray(state.selectedObjectIds[0]);
  parentArray.push(...items);
  state.selectedObjectIds = items.map((item) => item.id = crypto.randomUUID());
  render();
}

function makeArrayFromSelection() {
  const items = selectedObjects();
  if (!items.length) return setStatus("Select objects to array.");
  const bounds = selectionBounds();
  const parentArray = findParentArray(state.selectedObjectIds[0]);
  const clones = [];
  for (let row = 0; row < state.machine.arrayRows; row += 1) {
    for (let col = 0; col < state.machine.arrayCols; col += 1) {
      if (row === 0 && col === 0) continue;
      items.forEach((node) => clones.push(offsetNode(structuredClone(node), col * (bounds.width + state.machine.arrayGapX), row * (bounds.height + state.machine.arrayGapY))));
    }
  }
  parentArray.push(...clones);
  render();
}

function deleteSelection() {
  if (!state.selectedObjectIds.length) return setStatus("Select objects to delete.");
  state.selectedObjectIds.forEach((id) => {
    const parentArray = findParentArray(id);
    const index = parentArray.findIndex((node) => node.id === id);
    if (index >= 0) parentArray.splice(index, 1);
  });
  state.selectedObjectIds = [];
  render();
}

function offsetNode(node, dx, dy) {
  node.id = crypto.randomUUID();
  node.x = snap(node.x + dx);
  node.y = snap(node.y + dy);
  node.children = nodeChildren(node).map((child) => offsetNode(child, 0, 0));
  return node;
}

function updateGcodePreview() {
  const gcode = generateGcode({ previewOnly: true });
  state.generatedGcode = gcode;
  elements.gcodePreview.value = gcode.split("\n").slice(0, 220).join("\n");
}

function collectOperationPolylines() {
  return state.operationLayers.map((operationLayer) => {
    const rawPolylines = collectLeafEntries(state.objects)
      .filter((entry) => entry.operationLayer.id === operationLayer.id)
      .flatMap((entry) => extractLeafGeometry(entry.node, entry.transform, operationLayer));
    const polylines = optimizePolylines(rawPolylines, {
      joinTolerance: Math.max(0.05, state.machine.sampleStep * 0.75),
      simplifyTolerance: 0.001,
    });
    return { operationLayer, polylines };
  });
}

function generateGcode({ previewOnly = false } = {}) {
  return buildGcodeFromPolylines({
    machine: state.machine,
    operationLayers: state.operationLayers,
    operations: collectOperationPolylines(),
    previewOnly,
  });
}

function collectLeafEntries(nodes, parentTransform = { x: 0, y: 0, scale: 1, rotation: 0 }, results = [], inheritedOperationLayerId = "") {
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    const transform = combineTransforms(parentTransform, node);
    const effectiveOperationLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);
    const children = nodeChildren(node);
    if (children.length) {
      collectLeafEntries(children, transform, results, effectiveOperationLayerId);
    } else {
      results.push({
        node,
        transform,
        operationLayer: operationLayerById(effectiveOperationLayerId) || state.operationLayers[0],
      });
    }
  });
  return results;
}

function extractLeafGeometry(node, transform, operationLayer) {
  elements.measurementRoot.innerHTML = "";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${state.artworkViewBox.width} ${state.artworkViewBox.height}`);
  const wrapper = document.createElementNS(SVG_NS, "g");
  appendSvgMarkup(svg, state.sourceDefsMarkup);
  appendSvgMarkup(wrapper, node.markup);
  svg.appendChild(wrapper);
  elements.measurementRoot.appendChild(svg);
  const shapes = [];
  collectGeometryNodes(wrapper, shapes);
  return shapes.flatMap((shape) => sampleShape(shape, node, transform, operationLayer)).filter((polyline) => polyline.length > 1);
}

function collectGeometryNodes(node, shapes) {
  [...node.children].forEach((child) => {
    if (child instanceof SVGGeometryElement) shapes.push(child);
    if (child.children.length) collectGeometryNodes(child, shapes);
  });
}

function sampleShape(shape, node, transform, operationLayer) {
  if (operationLayer.mode === "fill") {
    if (typeof shape.isPointInFill !== "function") return [];
    const bbox = shape.getBBox();
    const hatchStep = Math.max(state.machine.sampleStep * 3, 1);
    const segments = [];
    for (let y = bbox.y; y <= bbox.y + bbox.height; y += hatchStep) {
      let active = [];
      const samples = [];
      for (let x = bbox.x; x <= bbox.x + bbox.width; x += state.machine.sampleStep) samples.push(x);
      if (Math.round((y - bbox.y) / hatchStep) % 2 === 1) samples.reverse();
      samples.forEach((x) => {
        if (shape.isPointInFill(createSvgPoint(x, y))) {
          active.push(transformPointByTransform(x, y, node.sourceBounds, transform));
        } else if (active.length) {
          if (active.length > 1) segments.push(dedupePolyline(active));
          active = [];
        }
      });
      if (active.length > 1) segments.push(dedupePolyline(active));
    }
    return segments;
  }
  const total = shape.getTotalLength?.();
  if (!total || !Number.isFinite(total)) return [];
  const step = Math.max(state.machine.sampleStep / Math.max(transform.scale, 0.0001), 0.25);
  const polyline = [];
  for (let distance = 0; distance <= total; distance += step) {
    const point = shape.getPointAtLength(Math.min(distance, total));
    polyline.push(transformPointByTransform(point.x, point.y, node.sourceBounds, transform));
  }
  const end = shape.getPointAtLength(total);
  polyline.push(transformPointByTransform(end.x, end.y, node.sourceBounds, transform));
  return [dedupePolyline(polyline)];
}

function exportGcode() {
  const gcode = generateGcode();
  if (gcode.startsWith("; No enabled")) return setStatus("No enabled geometry to export.");
  downloadText(preferredJobFilename(), gcode);
  setStatus("Exported G-code.");
}

function exportFrameGcode() {
  const bounds = selectionBounds();
  if (!bounds) return setStatus("Select objects to generate a frame.");
  downloadText(preferredJobFilename(`${stripExtension(state.documentName) || "lumaburn-job"}-frame`), `${buildFrameLines(bounds, state.machine).join("\n")}\n`);
  setStatus("Generated framing G-code.");
}

function renderStats() {
  const estimate = estimateJobFromPolylines({
    machine: state.machine,
    operationLayers: state.operationLayers,
    operations: collectOperationPolylines(),
  });
  elements.statEnabled.textContent = String(estimate.enabledLayers);
  elements.statCutDistance.textContent = `${formatCompact(estimate.cutDistance)} mm`;
  elements.statTravelDistance.textContent = `${formatCompact(estimate.travelDistance)} mm`;
  elements.statRuntime.textContent = formatDuration(estimate.runtimeSeconds);
}

function deviceStorageCandidates() {
  return dedupeStrings([state.device.browsePath || "/", "/ext/", "/sd/", state.device.storageMode === "direct" ? "/" : "", "/"]);
}

function deviceUploadCandidates() {
  return dedupeStrings([state.device.uploadPath || "/", "/ext/", state.device.browsePath || "/", "/sd/", state.device.storageMode === "direct" ? "/" : "", "/"]);
}

function preferredJobExtension() {
  return state.machine.presetId === "longer-ray5-20w" ? ".gc" : ".gcode";
}

function preferredJobFilename(baseName = stripExtension(state.documentName) || "lumaburn-job") {
  return `${baseName}${preferredJobExtension()}`;
}

function controllerRunFlavor() {
  return state.machine.presetId === "longer-ray5-20w" ? "grbl-embedded" : "";
}

function controllerCanAutostartJobs() {
  return controllerRunFlavor() === "grbl-embedded" || canUseControllerFileRun(state.device);
}

function isJobStorageFile(file) {
  const name = String(file?.name || file?.shortname || "").trim().toLowerCase();
  return [".gc", ".gcode", ".nc", ".lbrn", ".lbrn2"].some((suffix) => name.endsWith(suffix));
}

function parseStorageSizeLabel(value) {
  const match = String(value || "").trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = match[2].toUpperCase();
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] || 1;
  return amount * scale;
}

function isLikelyInternalFlashListing(listing) {
  const files = Array.isArray(listing?.files) ? listing.files : [];
  const totalBytes = parseStorageSizeLabel(listing?.total);
  if (files.some(isJobStorageFile)) return false;
  return String(listing?.path || "") === "/"
    && totalBytes > 0
    && totalBytes <= 32 * 1024 * 1024
    && files.every((file) => !isJobStorageFile(file));
}

function shouldPreserveCurrentDirectListing(nextListing) {
  return state.device.storageMode.toLowerCase() === "direct"
    && state.device.files.some(isJobStorageFile)
    && isLikelyInternalFlashListing(nextListing);
}

function scoreDeviceListing(listing, requestedPath = "") {
  if (!listing || listing.status !== "Ok") return Number.NEGATIVE_INFINITY;
  const files = Array.isArray(listing.files) ? listing.files : [];
  const jobFiles = files.filter(isJobStorageFile).length;
  const internalFlashPenalty = isLikelyInternalFlashListing(listing) ? -1000 : 0;
  const directBonus = String(listing.mode || "").toLowerCase() === "direct" ? 400 : 0;
  const rootBonus = String(listing.path || "") === "/" ? 60 : 0;
  const requestedMatchBonus = String(listing.path || "") === String(requestedPath || "") ? 20 : 0;
  const fileCountBonus = Math.min(files.length, 200);
  const jobFileBonus = jobFiles * 50;
  const sizeBonus = Math.min(parseStorageSizeLabel(listing.total) / (1024 ** 3), 16) * 10;
  return internalFlashPenalty + directBonus + rootBonus + requestedMatchBonus + fileCountBonus + jobFileBonus + sizeBonus;
}

function chooseBestDeviceListing(listings) {
  return (Array.isArray(listings) ? listings : [])
    .filter((entry) => entry?.payload?.status === "Ok")
    .sort((a, b) => scoreDeviceListing(b.payload, b.requestedPath) - scoreDeviceListing(a.payload, a.requestedPath))[0]?.payload || null;
}

function applyDeviceListing(listing) {
  const resolvedBrowsePath = listing.path || state.device.browsePath || "/";
  state.device.browsePath = resolvedBrowsePath;
  if (
    !state.device.uploadPath
    || state.device.uploadPath === "/sd/"
    || (String(listing.mode || state.device.storageMode || "").toLowerCase() === "direct" && resolvedBrowsePath === "/")
  ) {
    state.device.uploadPath = resolvedBrowsePath;
  }
  state.device.storageMode = String(listing.mode || state.device.storageMode || "");
  state.device.files = Array.isArray(listing.files) ? listing.files : [];
  state.device.lastFileSummary = `${state.device.files.length} file${state.device.files.length === 1 ? "" : "s"} on ${state.device.browsePath} · uploads via ${state.device.uploadPath || "/"} · ${listing.used || "?"} used of ${listing.total || "?"}`;
}

function pushDeviceActivity(level, message, detail = "") {
  const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  state.device.activityLog = [{ level, message, detail, time: timestamp }, ...state.device.activityLog].slice(0, DEVICE_ACTIVITY_LIMIT);
  renderDeviceActivity();
}

function reportDeviceError(action, error) {
  const detail = error instanceof Error ? error.message : String(error);
  pushDeviceActivity("error", `${action} failed`, detail);
  setDeviceState("Error", detail);
  setStatus(`${action} failed.`);
}

async function deviceFetch(pathname, options = {}) {
  if (!state.device.networkAvailable) throw new Error("Network device features are unavailable. The app is running as a G-code generator.");
  if (!state.device.url) throw new Error("Set a controller URL first.");
  const url = new URL(`/device${pathname}`, window.location.origin);
  url.searchParams.set("target", state.device.url);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DEFAULT_DEVICE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Device request timed out after ${Math.round(DEFAULT_DEVICE_TIMEOUT_MS / 1000)}s.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Device request failed: ${response.status} ${detail}`.slice(0, 280));
  }
  return response;
}

async function readDeviceResponseText(response, action, { requirePositive = false } = {}) {
  const text = (await response.text()).trim();
  const inspection = inspectDeviceResponse(text);
  if (!text && !requirePositive) return { text, inspection };
  if (!inspection.ok && (requirePositive || inspection.confidence !== "low")) {
    throw new Error(`${action}: ${inspection.summary}`.slice(0, 280));
  }
  return { text, inspection };
}

async function refreshDeviceFiles() {
  try {
    pushDeviceActivity("info", "Loading controller files", state.device.url || "No controller URL set.");
    setDeviceState("Connecting", `Listing files from ${state.device.url}...`);
    const candidatePaths = deviceStorageCandidates();
    const listings = [];
    for (const pathValue of candidatePaths) {
      try {
        const nextPayload = await (await deviceFetch(`/files?action=list&path=${encodeURIComponent(pathValue)}`)).json();
        listings.push({ requestedPath: pathValue, payload: nextPayload });
      } catch {
        // Keep probing other candidate paths.
      }
    }
    const payload = chooseBestDeviceListing(listings);
    if (!payload) throw new Error("The controller did not return a readable file listing.");
    if (shouldPreserveCurrentDirectListing(payload)) {
      setDeviceState("Connected", "Keeping direct-storage file list from the last verified upload.");
      pushDeviceActivity("warn", "Ignored internal flash listing", "The controller returned its web UI filesystem instead of the job storage list.");
      render();
      setStatus("Kept the direct-storage file list instead of the controller web UI filesystem.");
      return;
    }
    applyDeviceListing(payload);
    setDeviceState("Connected", `${payload.status || "Ok"} · ${payload.used || "?"} used of ${payload.total || "?"} on ${state.device.browsePath}`);
    pushDeviceActivity("info", "Controller file list loaded", state.device.lastFileSummary);
    render();
    setStatus(`Loaded ${state.device.files.length} device file${state.device.files.length === 1 ? "" : "s"} from ${state.device.browsePath}.`);
  } catch (error) {
    state.device.lastFileSummary = "Unable to load files from device storage.";
    reportDeviceError("Load device files", error);
  }
}

async function scanNetworkForDevices() {
  try {
    const subnets = buildDiscoveryCandidates({
      manualScanRange: state.device.scanRange,
      deviceUrl: state.device.url,
      discoveredSubnets: state.device.discoveredSubnets,
      networkSubnets: state.device.knownScanSubnets,
    });
    if (!subnets.length) throw new Error("No local subnet detected. Enter a manual IP or a custom scan range.");
    state.device.discoveryLog = [];
    pushDeviceActivity("info", "Starting network scan", `Scanning ${subnets.length} candidate subnet${subnets.length === 1 ? "" : "s"}.`);
    setDeviceState("Scanning", `Scanning ${subnets.length} likely subnet${subnets.length === 1 ? "" : "s"} for a controller.`);
    const response = await fetch(`/discover-many?subnets=${encodeURIComponent(subnets.join(","))}`);
    if (!response.ok) throw new Error(`Network scan failed (${response.status}).`);
    const payload = await response.json();
    state.device.discoveryLog = subnets.map((subnet) => `Scanned ${subnet}.0/24`);
    const [first] = payload.devices || [];
    if (first?.url) {
      state.device.url = normalizeDeviceUrl(first.url);
      state.device.friendlyName = first.title || "Laser Controller";
      state.device.enabled = true;
      pushDeviceActivity("info", "Controller discovered", `${state.device.friendlyName} at ${first.url}`);
      setDeviceState("Found", `Discovered ${state.device.friendlyName} at ${first.url}`);
      render();
      await refreshDeviceFiles();
      return;
    }
    setDeviceState("Generator Only", "No controller found automatically. Enter a manual IP/friendly name or another scan range.");
    pushDeviceActivity("warn", "No controller discovered", `Scanned ${subnets.length} candidate subnet${subnets.length === 1 ? "" : "s"}.`);
  } catch (error) {
    reportDeviceError("Network scan", error);
  }
}

async function sendManualDeviceCommand(command) {
  if (!command) return setStatus("Enter a command first.");
  try {
    pushDeviceActivity("info", "Sending command", command);
    setDeviceState("Sending", `Command: ${command}`);
    await readDeviceResponseText(await deviceFetch(`/command?commandText=${encodeURIComponent(command)}`), "Manual command");
    elements.deviceCommand.value = "";
    setDeviceState("Connected", `Last command sent: ${command}`);
    setStatus(`Sent command: ${command}`);
    pushDeviceActivity("info", "Command sent", command);
  } catch (error) {
    reportDeviceError("Manual command", error);
  }
}

async function stopDeviceJob() {
  try {
    state.device.stopRequested = true;
    state.device.streaming = false;
    pushDeviceActivity("warn", "Stopping device job", "Issuing an emergency hold, laser-off, and reset burst while cancelling any local queued stream.");
    setDeviceState("Stopping", "Issuing emergency stop commands and cancelling local streaming.");
    const { inspection } = await readDeviceResponseText(
      await deviceFetch("/stop"),
      "Stop job",
      { requirePositive: true },
    );
    const plan = inspection.data || { label: "Emergency stop burst", partial: false };
    setDeviceState("Connected", "Stop command sent to controller.");
    const detail = plan.partial ? `${plan.label} (with fallback errors)` : plan.label;
    setStatus(plan.partial ? "Emergency stop sent with warnings." : "Emergency stop sent.");
    pushDeviceActivity(plan.partial ? "warn" : "info", "Stop command sent", detail);
  } catch (error) {
    reportDeviceError("Stop job", error);
  }
}

async function uploadCurrentJobToDevice() {
  const gcode = generateGcode();
  if (gcode.startsWith("; No enabled")) return setStatus("No enabled geometry to upload.");
  try {
    const filename = preferredJobFilename();
    await uploadGcodeToDevice(filename, gcode);
    setStatus(`Uploaded ${filename} to the controller.`);
    pushDeviceActivity("info", "G-code uploaded", filename);
    if (state.device.storageMode.toLowerCase() !== "direct") {
      await refreshDeviceFiles();
    } else {
      render();
    }
  } catch (error) {
    reportDeviceError("Upload G-code", error);
  }
}

async function streamCurrentJobToDevice() {
  const gcode = generateGcode();
  if (gcode.startsWith("; No enabled")) return setStatus("No enabled geometry to run.");
  const filename = preferredJobFilename();
  try {
    state.device.streaming = true;
    state.device.stopRequested = false;
    pushDeviceActivity("info", "Preparing device job", filename);
    await uploadGcodeToDevice(filename, gcode, false);
    if (!controllerCanAutostartJobs()) {
      state.device.streaming = false;
      setDeviceState("Uploaded", `Uploaded ${filename} to controller storage. Start it directly on the controller.`);
      setStatus(`Uploaded ${filename} to controller storage. Start it directly on the controller.`);
      pushDeviceActivity("warn", "Upload-only controller mode", `Uploaded ${filename}. This controller reports direct root storage, so the app will not attempt an unsafe remote start.`);
      render();
      return;
    }
    const fullPath = normalizeDevicePath(state.device.uploadPath, filename);
    let startedByFileCommand = false;
    for (const command of buildRunFileCommands(fullPath, { controllerFlavor: controllerRunFlavor() })) {
      setDeviceState("Starting", `Attempting controller-side start: ${command}`);
      try {
        const result = await readDeviceResponseText(
          await deviceFetch(`/command?commandText=${encodeURIComponent(command)}`),
          "Controller-side stream start",
          { requirePositive: true }
        );
        pushDeviceActivity("info", "Controller-side stream started", result.inspection.summary || command);
        startedByFileCommand = true;
        break;
      } catch (error) {
        pushDeviceActivity("warn", "Controller-side start attempt failed", error.message);
      }
    }

    if (!startedByFileCommand) {
      state.device.streaming = false;
      await refreshDeviceFiles().catch(() => {});
      throw new Error(`Uploaded ${filename} to ${fullPath}, but the controller did not acknowledge starting it. Start it directly from the controller. Browser-side fallback streaming is disabled for safety.`);
    }

    state.device.streaming = false;
    setDeviceState("Running", `Controller is running ${filename} from device storage.`);
    setStatus(`Started ${filename} from device storage.`);
    pushDeviceActivity("info", "Controller-run job started", `${filename} on ${fullPath}`);
    await refreshDeviceFiles();
  } catch (error) {
    state.device.streaming = false;
    reportDeviceError("Stream job", error);
  }
}

async function streamFrameToDevice() {
  const bounds = selectionBounds();
  if (!bounds) return setStatus("Select objects to stream a frame.");
  await streamLinesToDevice(buildFrameLines(bounds, state.machine), "frame");
}

async function streamLinesToDevice(lines, label) {
  try {
    state.device.streaming = true;
    state.device.stopRequested = false;
    const commands = lines.filter(Boolean);
    if (!commands.length) throw new Error(`No ${label} lines were generated.`);
    pushDeviceActivity("info", `Streaming ${label}`, `${commands.length} command line${commands.length === 1 ? "" : "s"} queued.`);
    setDeviceState("Streaming", `Sending ${label} to ${state.device.url}`);
    let transportMode = null;
    for (let index = 0; index < commands.length; index += 1) {
      if (state.device.stopRequested) {
        state.device.streaming = false;
        setDeviceState("Stopped", `Stopped ${label} after ${index} of ${commands.length} lines.`);
        setStatus(`Stopped ${label} stream.`);
        pushDeviceActivity("warn", `${label.charAt(0).toUpperCase() + label.slice(1)} stream stopped`, `${index} of ${commands.length} lines were sent before stop was requested.`);
        return;
      }
      const line = commands[index];
      const variants = transportMode ? [transportMode === "esp500" ? `[ESP500] ${line}` : line] : buildQueuedCommandVariants(line);
      let sent = false;
      let lastError = null;
      for (const variant of variants) {
        try {
          await readDeviceResponseText(
            await deviceFetch(`/command?commandText=${encodeURIComponent(variant)}`),
            `Stream ${label} line ${index + 1}`
          );
          transportMode = variant.startsWith("[ESP500]") ? "esp500" : "raw";
          sent = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sent) throw lastError || new Error(`Unable to send ${label} line ${index + 1}.`);
      if ((index + 1) % 20 === 0 || index === commands.length - 1) {
        setDeviceState("Streaming", `Sent ${index + 1} of ${commands.length} ${label} lines.`);
      }
      await delay(55);
    }
    state.device.streaming = false;
    state.device.stopRequested = false;
    setDeviceState("Connected", `Finished streaming ${label}.`);
    setStatus(`Streamed ${label} to the controller.`);
    pushDeviceActivity("info", `${label.charAt(0).toUpperCase() + label.slice(1)} stream completed`, `${commands.length} lines sent via ${transportMode || "raw"} mode.`);
  } catch (error) {
    state.device.streaming = false;
    state.device.stopRequested = false;
    reportDeviceError(`Stream ${label}`, error);
  }
}

async function uploadGcodeToDevice(filename, gcode, updateStatus = true) {
  const blob = new Blob([gcode], { type: "text/plain" });
  let lastError = null;
  for (const pathValue of deviceUploadCandidates()) {
    const formData = new FormData();
    formData.append("myfiles[]", blob, filename);
    formData.append("file", blob, filename);
    if (updateStatus) setDeviceState("Uploading", `Uploading ${filename} to ${pathValue}`);
    try {
      const response = await deviceFetch(`/upload?path=${encodeURIComponent(pathValue)}`, { method: "POST", body: formData });
      const result = await readDeviceResponseText(response, "Upload G-code");
      let listing = result.inspection?.data && Array.isArray(result.inspection.data.files)
        ? result.inspection.data
        : null;
      if (!deviceListingContainsFilename(listing, filename)) {
        listing = await verifyDeviceUpload(pathValue, filename);
      }
      if (!listing || !deviceListingContainsFilename(listing, filename)) {
        throw new Error(`Upload verification failed for ${pathValue}; ${filename} was not listed by the controller.`);
      }
      if (result.inspection?.data?.mode) state.device.storageMode = String(result.inspection.data.mode);
      if (listing?.mode) state.device.storageMode = String(listing.mode);
      applyDeviceListing({ ...listing, mode: listing?.mode || state.device.storageMode });
      pushDeviceActivity("info", "Upload target confirmed", pathValue);
      return listing;
    } catch (error) {
      lastError = error;
      pushDeviceActivity("warn", "Upload target rejected", `${pathValue}: ${error.message}`);
    }
  }
  throw lastError || new Error("Unable to upload to any known controller path.");
}

function deviceListingContainsFilename(listing, filename) {
  return (Array.isArray(listing?.files) ? listing.files : []).some((file) => {
    const candidate = String(file?.name || file?.shortname || "").trim().toLowerCase();
    return candidate === filename.toLowerCase();
  });
}

async function verifyDeviceUpload(pathValue, filename) {
  const candidatePaths = dedupeStrings([pathValue, "/", state.device.browsePath || "/", state.device.uploadPath || "/"]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const candidatePath of candidatePaths) {
      try {
        const listing = await (await deviceFetch(`/files?action=list&path=${encodeURIComponent(candidatePath)}`)).json();
        if (listing?.status === "Ok" && deviceListingContainsFilename(listing, filename)) {
          return listing;
        }
      } catch {
        // Try the next candidate path.
      }
    }
    await delay(250);
  }
  return null;
}

async function onDeviceFileActionClick(event) {
  const target = event.target.closest("[data-device-action]");
  if (!target) return;
  const action = target.getAttribute("data-device-action");
  const filename = target.getAttribute("data-device-file");
  if (action === "run") await runDeviceFile(filename);
  if (action === "delete") await deleteDeviceFile(filename);
}

async function runDeviceFile(filename) {
  try {
    if (!controllerCanAutostartJobs()) {
      throw new Error("This controller path does not support safe autonomous file-run commands. Choose a storage-backed path such as /sd/ or /ext/.");
    }
    const fullPath = normalizeDevicePath(state.device.browsePath || state.device.uploadPath, filename);
    setDeviceState("Starting", `Requesting local run for ${filename}`);
    pushDeviceActivity("info", "Starting device file", filename);
    let started = false;
    for (const command of buildRunFileCommands(fullPath, { controllerFlavor: controllerRunFlavor() })) {
      try {
        await readDeviceResponseText(
          await deviceFetch(`/command?commandText=${encodeURIComponent(command)}`),
          `Run device file ${filename}`,
          { requirePositive: true }
        );
        started = true;
        break;
      } catch (error) {
        pushDeviceActivity("warn", "Run-file attempt failed", error.message);
      }
    }
    if (!started) throw new Error(`The controller did not acknowledge starting ${filename}.`);
    setStatus(`Requested local file run: ${filename}`);
    pushDeviceActivity("info", "Device file start requested", filename);
  } catch (error) {
    reportDeviceError(`Run ${filename}`, error);
  }
}

async function deleteDeviceFile(filename) {
  try {
      await readDeviceResponseText(
      await deviceFetch(`/files?action=delete&path=${encodeURIComponent(state.device.browsePath || state.device.uploadPath)}&filename=${encodeURIComponent(filename)}`),
      `Delete ${filename}`
    );
    setStatus(`Deleted ${filename} from ${state.device.browsePath || state.device.uploadPath}.`);
    pushDeviceActivity("info", "Device file deleted", filename);
    if (state.device.storageMode.toLowerCase() === "direct" && state.device.files.length) {
      state.device.files = state.device.files.filter((file) => {
        const candidate = String(file?.name || file?.shortname || "").trim().toLowerCase();
        return candidate !== filename.toLowerCase();
      });
      state.device.lastFileSummary = `${state.device.files.length} file${state.device.files.length === 1 ? "" : "s"} on ${state.device.browsePath} · uploads via ${state.device.uploadPath || "/"} · direct storage cached`;
      render();
      return;
    }
    await refreshDeviceFiles();
  } catch (error) {
    reportDeviceError(`Delete ${filename}`, error);
  }
}

function setDeviceState(label, detail) {
  state.device.stateLabel = label;
  state.device.stateDetail = detail;
  render();
}

function handlePageHide() {
  if (!state.device.url || !state.device.streaming) return;
  state.device.stopRequested = true;
  try {
    fetch(`/device/stop?target=${encodeURIComponent(state.device.url)}`, {
      method: "GET",
      keepalive: true,
      cache: "no-store",
    }).catch(() => {});
  } catch {
    // Best-effort only.
  }
}

async function initializeDeviceDiscovery() {
  try {
    const response = await fetch("/network-info");
    if (!response.ok) throw new Error(`Network info unavailable (${response.status}).`);
    const payload = await response.json();
    state.device.networkAvailable = true;
    state.device.discoveredSubnets = [...new Set((payload.networks || []).map((network) => network.subnet))];
    state.device.knownScanSubnets = Array.isArray(payload.scanSubnets) ? payload.scanSubnets : [];
    state.device.scanRange = state.device.scanRange || state.device.discoveredSubnets[0] || state.device.knownScanSubnets[0] || "";
    if (state.device.url) {
      state.device.discoveryLog = [`Saved controller target: ${state.device.url}`];
      pushDeviceActivity("info", "Checking saved controller", state.device.url);
      setDeviceState("Connecting", `Checking saved controller at ${state.device.url}`);
      await refreshDeviceFiles();
      return;
    }
    if (state.device.discoveredSubnets.length || state.device.knownScanSubnets.length) {
      state.device.discoveryLog = [
        `Detected interfaces: ${state.device.discoveredSubnets.join(", ") || "none"}`,
        `Smart scan plan: ${buildDiscoveryCandidates({
          manualScanRange: state.device.scanRange,
          discoveredSubnets: state.device.discoveredSubnets,
          networkSubnets: state.device.knownScanSubnets,
        }).slice(0, 8).join(", ")}${state.device.knownScanSubnets.length > 8 ? " ..." : ""}`,
      ];
      pushDeviceActivity("info", "Local networks detected", state.device.discoveryLog.join(" | "));
      render();
      await scanNetworkForDevices();
    } else {
      state.device.lastFileSummary = "No controller connected. Generator-only mode is active.";
      setDeviceState("Generator Only", "No private subnets detected. Enter a manual IP or scan range if needed.");
    }
  } catch {
    state.device.networkAvailable = false;
    state.device.enabled = false;
    state.device.discoveryLog = ["Network communication is unavailable in this launch mode."];
    state.device.lastFileSummary = "Device file browser disabled. Generator-only mode is active.";
    pushDeviceActivity("warn", "Network proxy unavailable", "Device features are disabled in this launch mode.");
    setDeviceState("Generator Only", "No network proxy is available. Device controls are disabled and LumaBurn will run as a G-code generator.");
  }
}

function saveMachineProfile() {
  const name = window.prompt("Machine profile name:", "Shop Machine");
  if (!name) return;
  const profile = { id: slugifyName(name), name, machine: structuredClone(state.machine) };
  upsertProfile(state.machineProfiles, profile);
  persistProfiles();
  state.selectedMachineProfileId = profile.id;
  render();
}

function saveDeviceProfile() {
  const name = window.prompt("Device profile name:", state.device.friendlyName || "Laser Controller");
  if (!name) return;
  const profile = normalizeSavedDeviceProfile({
    id: slugifyName(name),
    name,
    device: {
      url: state.device.url,
      friendlyName: state.device.friendlyName,
      uploadPath: state.device.uploadPath,
      browsePath: state.device.browsePath || state.device.uploadPath,
      scanRange: state.device.scanRange,
    },
  });
  if (!profile) return;
  upsertProfile(state.deviceProfiles, profile);
  persistProfiles();
  state.selectedDeviceProfileId = profile.id;
  setStatus(`Saved device profile: ${profile.name}.`);
  render();
}

function setDefaultMachineProfile() {
  if (!state.selectedMachineProfileId) return;
  state.defaultMachineProfileId = state.selectedMachineProfileId;
  persistProfiles();
  setStatus("Default machine profile saved.");
}

function setDefaultDeviceProfile() {
  if (!state.selectedDeviceProfileId) return;
  state.defaultDeviceProfileId = state.selectedDeviceProfileId;
  persistProfiles();
  setStatus("Default device profile saved.");
}

function applySavedMachineProfile(profileId) {
  const profile = state.machineProfiles.find((item) => item.id === profileId);
  if (!profile) return;
  state.machine = { ...state.machine, ...structuredClone(profile.machine) };
  state.selectedMachineProfileId = profile.id;
  render();
}

function applySavedDeviceProfile(profileId) {
  const profile = state.deviceProfiles.find((item) => item.id === profileId);
  if (!profile) {
    state.selectedDeviceProfileId = "";
    render();
    return;
  }
  const runtimeDeviceState = {
    discoveredSubnets: state.device.discoveredSubnets,
    discoveryLog: state.device.discoveryLog,
    activityLog: state.device.activityLog,
    knownScanSubnets: state.device.knownScanSubnets,
    networkAvailable: state.device.networkAvailable,
    stateLabel: state.device.stateLabel,
    stateDetail: state.device.stateDetail,
    lastFileSummary: state.device.lastFileSummary,
  };
  state.device = {
    ...createDefaultDeviceState(),
    ...structuredClone(profile.device),
    ...runtimeDeviceState,
    uploadPath: normalizeStoragePath(profile.device.uploadPath, "/sd/"),
    browsePath: normalizeStoragePath(profile.device.browsePath || profile.device.uploadPath, "/sd/"),
    files: [],
    streaming: false,
    enabled: Boolean(profile.device.url),
  };
  state.selectedDeviceProfileId = profile.id;
  setStatus(`Loaded device profile: ${profile.name}.`);
  render();
}

function deleteSelectedMachineProfile() {
  if (!state.selectedMachineProfileId) return;
  state.machineProfiles = state.machineProfiles.filter((profile) => profile.id !== state.selectedMachineProfileId);
  if (state.defaultMachineProfileId === state.selectedMachineProfileId) state.defaultMachineProfileId = "";
  state.selectedMachineProfileId = "";
  persistProfiles();
  render();
}

function deleteSelectedDeviceProfile() {
  if (!state.selectedDeviceProfileId) return;
  state.deviceProfiles = state.deviceProfiles.filter((profile) => profile.id !== state.selectedDeviceProfileId);
  if (state.defaultDeviceProfileId === state.selectedDeviceProfileId) state.defaultDeviceProfileId = "";
  state.selectedDeviceProfileId = "";
  persistProfiles();
  setStatus("Device profile deleted.");
  render();
}

function loadProfilesFromStorage() {
  state.machineProfiles = readStoredProfiles(MACHINE_PROFILE_STORAGE_KEY);
  state.deviceProfiles = readStoredProfiles(DEVICE_PROFILE_STORAGE_KEY)
    .map(normalizeSavedDeviceProfile)
    .filter(Boolean);
  state.defaultMachineProfileId = window.localStorage.getItem(DEFAULT_MACHINE_PROFILE_STORAGE_KEY) || "";
  state.defaultDeviceProfileId = window.localStorage.getItem(DEFAULT_DEVICE_PROFILE_STORAGE_KEY) || "";
}

function persistProfiles() {
  window.localStorage.setItem(MACHINE_PROFILE_STORAGE_KEY, JSON.stringify(state.machineProfiles));
  window.localStorage.setItem(DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(state.deviceProfiles));
  window.localStorage.setItem(DEFAULT_MACHINE_PROFILE_STORAGE_KEY, state.defaultMachineProfileId);
  window.localStorage.setItem(DEFAULT_DEVICE_PROFILE_STORAGE_KEY, state.defaultDeviceProfileId);
}

function readStoredProfiles(key) {
  try { return JSON.parse(window.localStorage.getItem(key) || "[]"); } catch { return []; }
}

function upsertProfile(collection, profile) {
  const index = collection.findIndex((item) => item.id === profile.id);
  if (index >= 0) collection.splice(index, 1, profile);
  else collection.push(profile);
}

function applyStartupProfiles() {
  if (state.machineProfiles.length === 1 && !state.defaultMachineProfileId) {
    state.defaultMachineProfileId = state.machineProfiles[0].id;
  }
  if (state.deviceProfiles.length === 1 && !state.defaultDeviceProfileId) {
    state.defaultDeviceProfileId = state.deviceProfiles[0].id;
  }
  const machineProfileId = state.defaultMachineProfileId || state.machineProfiles[0]?.id || "";
  const deviceProfileId = state.defaultDeviceProfileId || state.deviceProfiles[0]?.id || "";
  if (machineProfileId) applySavedMachineProfile(machineProfileId);
  if (deviceProfileId) applySavedDeviceProfile(deviceProfileId);
}

function restoreWorkspaceFromStorage() {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return;
    const workspace = JSON.parse(raw);
    if (!workspace || !Array.isArray(workspace.objects) || !Array.isArray(workspace.operationLayers)) return;
    state.documentName = workspace.documentName || state.documentName;
    state.artworkViewBox = workspace.artworkViewBox || state.artworkViewBox;
    state.sourceDefsMarkup = workspace.sourceDefsMarkup || "";
    state.machine = { ...state.machine, ...(workspace.machine || {}) };
    state.operationLayers = workspace.operationLayers.length ? workspace.operationLayers : state.operationLayers;
    state.objects = normalizeSceneNodes(workspace.objects, state.operationLayers[0]?.id || "");
    state.selectedObjectIds = Array.isArray(workspace.selectedObjectIds)
      ? workspace.selectedObjectIds.filter((id) => Boolean(findNodeById(id, state.objects)))
      : [];
    state.selectedOperationLayerId = workspace.selectedOperationLayerId || state.operationLayers[0]?.id || "";
    state.selectedMachineProfileId = workspace.selectedMachineProfileId || state.selectedMachineProfileId;
    state.selectedDeviceProfileId = workspace.selectedDeviceProfileId || state.selectedDeviceProfileId;
    state.interactionMode = workspace.interactionMode || "select";
  } catch {
    window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }
}

function scheduleWorkspacePersist() {
  window.clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = window.setTimeout(persistWorkspaceNow, 140);
}

function persistWorkspaceNow() {
  const snapshot = {
    version: PROJECT_VERSION,
    documentName: state.documentName,
    artworkViewBox: state.artworkViewBox,
    sourceDefsMarkup: state.sourceDefsMarkup,
    machine: state.machine,
    operationLayers: state.operationLayers,
    objects: state.objects,
    selectedObjectIds: state.selectedObjectIds,
    selectedOperationLayerId: state.selectedOperationLayerId,
    selectedMachineProfileId: state.selectedMachineProfileId,
    selectedDeviceProfileId: state.selectedDeviceProfileId,
    interactionMode: state.interactionMode,
  };
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
}

function nudgeSelection(dx, dy) {
  const nodes = selectedWorkspaceObjects();
  if (!nodes.length) return;
  nodes.forEach((node) => {
    node.x = round(node.x + dx, 2);
    node.y = round(node.y + dy, 2);
  });
  render();
}

function getKeyboardNudgeStep(useLargeStep) {
  const base = state.machine.snapEnabled ? Math.max(1, Number(state.machine.snapStep) || 1) : 1;
  return useLargeStep ? base * 10 : base;
}

function canvasViewport() {
  return {
    x: -CANVAS_GUTTER.left,
    y: -CANVAS_GUTTER.top,
    width: state.machine.bedWidth + CANVAS_GUTTER.left + CANVAS_GUTTER.right,
    height: state.machine.bedHeight + CANVAS_GUTTER.top + CANVAS_GUTTER.bottom,
  };
}

function measureMarkup(markup) {
  elements.measurementRoot.innerHTML = "";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${state.artworkViewBox.width} ${state.artworkViewBox.height}`);
  const group = document.createElementNS(SVG_NS, "g");
  appendSvgMarkup(svg, state.sourceDefsMarkup);
  appendSvgMarkup(group, markup);
  svg.appendChild(group);
  elements.measurementRoot.appendChild(svg);
  const target = group.firstElementChild || group;
  const box = target.getBBox();
  return { minX: box.x, minY: box.y, width: box.width || 1, height: box.height || 1, centerX: box.x + box.width / 2, centerY: box.y + box.height / 2 };
}

function objectWorldBounds(node, parentTransform = { x: 0, y: 0, scale: 1, rotation: 0 }) {
  const transform = combineTransforms(parentTransform, node);
  const children = nodeChildren(node);
  if (children.length) {
    return unionBounds(children.map((child) => objectWorldBounds(child, transform)));
  }
  const corners = [
    [node.sourceBounds.minX, node.sourceBounds.minY],
    [node.sourceBounds.minX + node.sourceBounds.width, node.sourceBounds.minY],
    [node.sourceBounds.minX + node.sourceBounds.width, node.sourceBounds.minY + node.sourceBounds.height],
    [node.sourceBounds.minX, node.sourceBounds.minY + node.sourceBounds.height],
  ].map(([x, y]) => transformPointByTransform(x, y, node.sourceBounds, transform));
  return { x: Math.min(...corners.map((p) => p.x)), y: Math.min(...corners.map((p) => p.y)), width: Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x)), height: Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y)) };
}

function selectionBounds(nodes = selectedWorkspaceObjects()) {
  const bounds = nodes.map((node) => objectWorldBounds(node));
  return bounds.length ? unionBounds(bounds) : null;
}

function unionBounds(bounds) {
  if (!bounds.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = bounds.flatMap((b) => [b.x, b.x + b.width]);
  const ys = bounds.flatMap((b) => [b.y, b.y + b.height]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function combineTransforms(parent, node) {
  return { x: parent.x + node.x * parent.scale, y: parent.y + node.y * parent.scale, scale: parent.scale * node.scale, rotation: parent.rotation + node.rotation };
}

function composeTransform(node) {
  const cx = node.sourceBounds.centerX * node.scale;
  const cy = node.sourceBounds.centerY * node.scale;
  return `translate(${node.x} ${node.y}) rotate(${node.rotation} ${cx} ${cy}) scale(${node.scale})`;
}

function transformPointByTransform(x, y, sourceBounds, transform) {
  const scaledX = x * transform.scale;
  const scaledY = y * transform.scale;
  const cx = sourceBounds.centerX * transform.scale;
  const cy = sourceBounds.centerY * transform.scale;
  const angle = (transform.rotation * Math.PI) / 180;
  const dx = scaledX - cx;
  const dy = scaledY - cy;
  return { x: transform.x + cx + dx * Math.cos(angle) - dy * Math.sin(angle), y: transform.y + cy + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

function createSvgPoint(x, y) {
  const point = elements.canvas.createSVGPoint();
  point.x = x;
  point.y = y;
  return point;
}

function createSvg(tag, attributes = {}, text = "") {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text) node.textContent = text;
  return node;
}

function appendSvgMarkup(target, markup) {
  if (!markup) return;
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, "image/svg+xml");
  const svg = parsed.documentElement;
  [...svg.childNodes].forEach((child) => target.appendChild(document.importNode(child, true)));
}

function countObjects(nodes) {
  return (Array.isArray(nodes) ? nodes : []).reduce((sum, node) => sum + 1 + countObjects(nodeChildren(node)), 0);
}

function replaceArrayContents(target, source) {
  target.splice(0, target.length, ...source);
}

function snap(value) {
  if (!state.machine.snapEnabled || state.machine.snapStep <= 0) return round(value, 1);
  return round(Math.round(value / state.machine.snapStep) * state.machine.snapStep, 1);
}

function dedupePolyline(polyline) {
  return polyline.filter((point, index) => !index || Math.hypot(point.x - polyline[index - 1].x, point.y - polyline[index - 1].y) > 0.05);
}

function colorToAlpha(hex, alpha) {
  const normalized = normalizeColor(hex).replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function normalizeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ca5b31";
}

function defaultOperationColor(index) {
  return ["#ca5b31", "#2f6b45", "#22618d", "#934d98", "#cf8b1d", "#7f4f24"][index % 6];
}

function prettyNodeName(tag) {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, "");
}

function numberFromLength(value) {
  const match = String(value || "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function format(value) {
  return round(value, 3).toFixed(3);
}

function formatCompact(value) {
  return round(value, 1).toFixed(1);
}

function formatDuration(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setStatus(message) {
  elements.status.textContent = message;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(String(value));
}

function slugifyName(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || crypto.randomUUID();
}

initialize();
