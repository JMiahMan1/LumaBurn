import {
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
  inspectDeviceResponse,
  normalizeDevicePath,
  normalizeDeviceUrl,
  parseGcodeGeometry,
  parseLightBurnGeometry,
} from './src/core/gcode.mjs';
import { convertSvgToNodes, nodeTreeToSvgString } from './svg-converter.mjs';
import { 
  combineTransforms,
  composeTransform,
  transformPointByTransform,
  normalizeSourceBounds,
  unionBounds,
  objectWorldBounds, 
  formatCompact, 
  numericOr,
  round, 
  parseTransform 
} from './src/core/math.mjs';
import { loadImageFromFile, ditherImageAtkinson, generateRasterGcode } from './src/core/raster.mjs';
import opentype from './node_modules/opentype.js/dist/opentype.module.js';


const SVG_NS = 'http://www.w3.org/2000/svg';
const PROJECT_VERSION = 3;

const TEXT_TO_PATH_FONT_URL = './assets/fonts/SpaceGrotesk-Regular.woff';
let textToPathFontPromise = null;
let textToPathFont = null;

async function loadTextToPathFont() {
  if (textToPathFontPromise) {return textToPathFontPromise;}
  textToPathFontPromise = (async () => {
    try {
      const response = await fetch(TEXT_TO_PATH_FONT_URL, { cache: 'force-cache' });
      if (!response.ok) {throw new Error(`Font load failed: ${response.status}`);}
      const buffer = await response.arrayBuffer();
      const font = opentype.parse(buffer);
      textToPathFont = font;
      return font;
    } catch (error) {
      console.warn('LumaBurn: Could not load remote font (CORS or offline). Text conversion will use browser fallback.', error);
      textToPathFont = null;
      return null;
    }
  })();
  return textToPathFontPromise;
}

function readSvgNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textAnchorOffset(textEl, advanceWidth) {
  const anchor = String(textEl.getAttribute('text-anchor') || '').toLowerCase();
  if (anchor === 'middle') {return -advanceWidth / 2;}
  if (anchor === 'end') {return -advanceWidth;}
  return 0;
}

function convertTextElementsToPaths(wrapper, font) {
  const texts = [...wrapper.querySelectorAll('text')];
  if (!texts.length) {return;}
  if (!font) {return;}

  texts.forEach((textEl) => {
    const text = textEl.textContent ?? '';
    if (!text.trim()) {
      textEl.remove();
      return;
    }

    // SVG <text x= y=> uses baseline y.
    const fontSize = readSvgNumber(textEl.getAttribute('font-size'), 24)
      || readSvgNumber(textEl.style?.fontSize, 24)
      || 24;
    const x = readSvgNumber(textEl.getAttribute('x'), 0);
    const y = readSvgNumber(textEl.getAttribute('y'), 0);

    const advance = font.getAdvanceWidth(text, fontSize);
    const x0 = x + textAnchorOffset(textEl, advance);
    const path = font.getPath(text, x0, y, fontSize);
    const d = path.toPathData(4);
    if (!d) {return;}

    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.setAttribute('d', d);
    // Preserve any local transforms on the <text>.
    const transform = textEl.getAttribute('transform');
    if (transform) {pathEl.setAttribute('transform', transform);}

    // Replace text with outline path.
    textEl.replaceWith(pathEl);
  });
}

async function ensureTextToPathReady() {
  await loadTextToPathFont();
}

// Feature flag for SVG conversion
const USE_NODE_TREE_CONVERSION = true; // Enable full node-tree conversion when ready

/**
 * Convert a node from the node-tree format to app's scene node format
 */
function convertNodeToSceneNode(node, operationLayerId, artworkBounds) {
  // Guard: this function takes exactly 3 arguments. Extra args are silently dropped by JS
  // which caused a bug where addBasicShape passed 8 args and operationLayerId received null.
  if (arguments.length > 3) {
    const err = `convertNodeToSceneNode called with ${arguments.length} args (expected 3). Check caller.`;
    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {throw new Error(err);}
    console.error('[LumaBurn]', err);
  }
  // artworkBounds must be an object (or null/undefined), not a number
  if (artworkBounds !== undefined && artworkBounds !== null && typeof artworkBounds !== 'object') {
    console.error('[LumaBurn] convertNodeToSceneNode: artworkBounds must be an object, got', typeof artworkBounds);
    artworkBounds = null;
  }
  // node.transform may be:
  //   - null/undefined (no transform)
  //   - a string e.g. "translate(10 20)" (legacy DOM path)
  //   - a structured object { matrix: {a,b,c,d,e,f} } (from convertSvgToNodes)
  let localX = 0, localY = 0, localScale = 1;
  const localRotation = 0;
  if (node.transform) {
    if (typeof node.transform === 'object' && node.transform.matrix) {
      // Structured transform from svg-converter.mjs
      const m = node.transform.matrix;
      localX = m.e || 0;
      localY = m.f || 0;
      localScale = m.a || 1; // approximate uniform scale from matrix.a
    } else if (typeof node.transform === 'string') {
      const parsed = parseTransform(node.transform);
      if (parsed?.matrix) {
        localX = parsed.matrix.e || 0;
        localY = parsed.matrix.f || 0;
        localScale = parsed.matrix.a || 1;
      }
    }
  }

  const tempNode = {
    id: node.id || crypto.randomUUID(),
    name: node.name || prettyNodeName(node.tagName),
    type: node.type || node.tagName,
    tagName: node.tagName || node.type,
    x: 0, y: 0, scaleX: 1, scaleY: 1, lockRatio: true, rotation: 0,
    operationLayerId: operationLayerId,
    children: []
  };

  switch (node.type) {
  case 'path':
    if (node.d) {tempNode.d = node.d;}
    break;
  case 'rect':
    if (node.width !== undefined) {tempNode.width = node.width;}
    if (node.height !== undefined) {tempNode.height = node.height;}
    if (node.x !== undefined) {tempNode.x = node.x;}
    if (node.y !== undefined) {tempNode.y = node.y;}
    if (node.rx !== undefined) {tempNode.rx = node.rx;}
    if (node.ry !== undefined) {tempNode.ry = node.ry;}
    break;
  case 'circle':
    if (node.cx !== undefined) {tempNode.cx = node.cx;}
    if (node.cy !== undefined) {tempNode.cy = node.cy;}
    if (node.r !== undefined) {tempNode.r = node.r;}
    break;
  case 'ellipse':
    if (node.cx !== undefined) {tempNode.cx = node.cx;}
    if (node.cy !== undefined) {tempNode.cy = node.cy;}
    if (node.rx !== undefined) {tempNode.rx = node.rx;}
    if (node.ry !== undefined) {tempNode.ry = node.ry;}
    break;
  case 'line':
    if (node.x1 !== undefined) {tempNode.x1 = node.x1;}
    if (node.y1 !== undefined) {tempNode.y1 = node.y1;}
    if (node.x2 !== undefined) {tempNode.x2 = node.x2;}
    if (node.y2 !== undefined) {tempNode.y2 = node.y2;}
    break;
  case 'polyline':
  case 'polygon':
    if (node.points) {tempNode.points = node.points;}
    break;
  case 'image':
    if (node.width !== undefined) {tempNode.width = node.width;}
    if (node.height !== undefined) {tempNode.height = node.height;}
    if (node.x !== undefined) {tempNode.x = node.x;}
    if (node.y !== undefined) {tempNode.y = node.y;}
    if (node.href) {tempNode.href = node.href;}
    break;
  case 'text':
    if (node.content !== undefined) {tempNode.content = node.content;}
    if (node.fontSize !== undefined) {tempNode.fontSize = node.fontSize;}
    if (node.fontFamily !== undefined) {tempNode.fontFamily = node.fontFamily;}
    break;
  }

  tempNode.style = node.style || {};
  tempNode.class = node.class || '';
  tempNode.attributes = node.attributes || {};
  
  const markup = node.type === 'group' || node.tagName === 'g' ? '' : nodeTreeToSvgString(tempNode);
  
  const sceneNode = {
    id: tempNode.id,
    name: tempNode.name,
    type: tempNode.type === 'g' ? 'group' : tempNode.type,
    markup: markup,
    x: localX,
    y: localY,
    scaleX: localScale,
    scaleY: localScale,
    lockRatio: true,
    rotation: localRotation,
    operationLayerId: operationLayerId,
    style: tempNode.style,
    class: tempNode.class,
    attributes: tempNode.attributes,
    children: [],
    sourceBounds: measureMarkup(markup)
  };

  if (node.children && node.children.length > 0) {
    sceneNode.children = node.children
      .map(child => convertNodeToSceneNode(child, '', artworkBounds))
      .filter(c => isSceneNodeVisible(c, artworkBounds));
  }

  return sceneNode;
}

function isSceneNodeVisible(node, artworkBounds) {
  const effectiveBounds = artworkBounds || state.artworkViewBox;
  
  const opacity = numericOr(node.style?.opacity ?? node.attributes?.opacity ?? node.opacity, 1) 
                * numericOr(node.style?.['fill-opacity'] ?? node.attributes?.['fill-opacity'], 1);
  if (opacity < 0.001) {return false;}

  // Aggressive check for guide/background rects
  if (node.type === 'rect' && isLikelyBackgroundRectFromSceneNode(node, effectiveBounds)) {
    return false;
  }

  if (node.type === 'group' || node.type === 'svg') {
    // A group is visible if it has at least one visible child.
    return Array.isArray(node.children) && node.children.some(c => isSceneNodeVisible(c, effectiveBounds));
  }
  
  if (['image', 'text'].includes(node.type)) {return true;}
  
  const fill = node.style?.fill || node.attributes?.fill || node.fill;
  const stroke = node.style?.stroke || node.attributes?.stroke || node.stroke;
  
  const hasFill = fill && fill !== 'none' && fill !== 'transparent';
  const hasStroke = stroke && stroke !== 'none' && stroke !== 'transparent';
  
  return hasFill || hasStroke;
}




const MACHINE_PROFILE_STORAGE_KEY = 'lumaburn.machineProfiles';
const DEVICE_PROFILE_STORAGE_KEY = 'lumaburn.deviceProfiles';
const DEFAULT_MACHINE_PROFILE_STORAGE_KEY = 'lumaburn.defaultMachineProfileId';
const DEFAULT_DEVICE_PROFILE_STORAGE_KEY = 'lumaburn.defaultDeviceProfileId';
const WORKSPACE_STORAGE_KEY = 'lumaburn.workspace';
const CANVAS_GUTTER = { left: 40, right: 12, top: 38, bottom: 36 };

const MACHINE_PRESETS = [
  { id: 'longer-ray5-20w', name: 'Longer Ray5 20W', bedWidth: 400, bedHeight: 400, travelSpeed: 4000, frameSpeed: 5000, laserMax: 1000, sampleStep: 0.8, originMode: 'lower-left', safeZ: 0 },
  { id: 'ortur-master-3', name: 'Ortur Laser Master 3', bedWidth: 400, bedHeight: 400, travelSpeed: 5000, frameSpeed: 6000, laserMax: 1000, sampleStep: 0.7, originMode: 'lower-left', safeZ: 0 },
  { id: 'xtool-d1-pro', name: 'xTool D1 Pro 20W', bedWidth: 430, bedHeight: 390, travelSpeed: 4500, frameSpeed: 5500, laserMax: 1000, sampleStep: 0.7, originMode: 'lower-left', safeZ: 0 },
];

const MATERIAL_PRESETS = [
  { id: 'none', name: 'No Material Preset', feed: 1800, power: 65, passes: 1, mode: 'line', airAssist: false },
  { id: '3mm-birch-cut', name: '3mm Birch Cut', feed: 420, power: 100, passes: 2, mode: 'line', airAssist: true },
  { id: '3mm-basswood-cut', name: '3mm Basswood Cut', feed: 500, power: 95, passes: 2, mode: 'line', airAssist: true },
  { id: 'acrylic-black-score', name: 'Black Acrylic Score', feed: 1500, power: 28, passes: 1, mode: 'score', airAssist: false },
  { id: 'leather-engrave', name: 'Leather Engrave', feed: 2200, power: 35, passes: 1, mode: 'fill', airAssist: false },
];
const DEMO_TUTORIAL = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 240 240" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <defs>
    <linearGradient id="metal" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ca5b31" stop-opacity="0.9" />
      <stop offset="100%" stop-color="#8f3217" stop-opacity="0.9" />
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="120%" height="120%">
      <feDropShadow dx="3" dy="5" stdDeviation="4" flood-opacity="0.15"/>
    </filter>
  </defs>

  <g transform="translate(10, 10)">
    <rect x="0" y="0" width="180" height="150" rx="12" fill="url(#metal)" stroke="#333" stroke-width="2" filter="url(#shadow)" />
    
    <g transform="translate(90, 75)">
      <circle cx="0" cy="0" r="35" fill="none" stroke="#fff" stroke-width="6" stroke-dasharray="8 6" />
      <path d="M -40,-40 L 40,40 M -40,40 L 40,-40" stroke="#fff" stroke-width="4" opacity="0.5" />
    </g>

    <text x="90" y="30" font-family="'Space Grotesk', sans-serif" font-weight="bold" font-size="18" fill="#fff" text-anchor="middle" letter-spacing="1">LUMABURN</text>
    <text x="90" y="45" font-family="'Space Grotesk', sans-serif" font-size="10" fill="#fff" opacity="0.8" text-anchor="middle">TINKERDRAFT ENGINE</text>

    <g transform="translate(10, 120)">
      <rect x="0" y="0" width="160" height="20" rx="4" fill="#151515" opacity="0.8" />
      <text x="80" y="14" font-family="sans-serif" font-size="8" font-weight="bold" fill="#fff" text-anchor="middle">1. Group Shapes  →  2. Toggle 'Hole'</text>
    </g>
  </g>
</svg>`;

const initialMachine = MACHINE_PRESETS[0];

const state = {
  documentName: 'No SVG Loaded',
  artworkViewBox: { x: 0, y: 0, width: 400, height: 400 },
  sourceDefsMarkup: '',
  machine: {
    presetId: initialMachine.id,
    materialPresetId: 'none',
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
    jobHeader: '; LumaBurn G-code\nG21 ; millimeters\nG90 ; absolute positioning\nM5',
    jobFooter: 'M5\nG0 X0 Y0',
  },
  device: createDefaultDeviceState(),
  operationLayers: [],
  objects: [],
  selectedObjectIds: [],
  selectedOperationLayerId: '',
  dragSession: null,
  machineProfiles: [],
  deviceProfiles: [],
  defaultMachineProfileId: '',
  defaultDeviceProfileId: '',
  selectedMachineProfileId: '',
  selectedDeviceProfileId: '',
  generatedGcode: '',
  interactionMode: 'select',
  activeRightTab: 'assign',
};

let workspaceSaveTimer = 0;

const elements = {
  fileInput: document.querySelector('#svg-input'),
  projectInput: document.querySelector('#project-input'),
  menuImport: document.querySelector('#menu-import'),
  menuLoadProject: document.querySelector('#menu-load-project'),
  menuSaveProject: document.querySelector('#menu-save-project'),
  menuExport: document.querySelector('#menu-export'),
  menuFrame: document.querySelector('#menu-frame'),
  menuDemo: document.querySelector('#menu-demo'),
  menuGroup: document.querySelector('#menu-group'),
  menuUngroup: document.querySelector('#menu-ungroup'),
  menuDuplicate: document.querySelector('#menu-duplicate'),
  menuDelete: document.querySelector('#menu-delete'),
  menuCenter: document.querySelector('#menu-center'),
  menuHome: document.querySelector('#menu-home'),
  menuReset: document.querySelector('#menu-reset'),
  duplicateButton: document.querySelector('#duplicate-button'),
  arrayButton: document.querySelector('#array-button'),
  deleteButton: document.querySelector('#delete-button'),
  addRectButton: document.querySelector('#add-rect-button'),
  addCircleButton: document.querySelector('#add-circle-button'),
  addTextButton: document.querySelector('#add-text-button'),
  groupButton: document.querySelector('#group-button'),
  ungroupButton: document.querySelector('#ungroup-button'),
  centerButton: document.querySelector('#center-button'),
  homeButton: document.querySelector('#home-button'),
  assignOperationButton: document.querySelector('#assign-operation-button'),
  moveUpButton: document.querySelector('#move-up-button'),
  moveDownButton: document.querySelector('#move-down-button'),
  toggleAllButton: document.querySelector('#toggle-all-button'),
  addOperationButton: document.querySelector('#add-operation-button'),
  statEnabled: document.querySelector('#stat-enabled'),
  statCutDistance: document.querySelector('#stat-cut-distance'),
  statTravelDistance: document.querySelector('#stat-travel-distance'),
  statRuntime: document.querySelector('#stat-runtime'),
  machinePreset: document.querySelector('#machine-preset'),
  machineProfile: document.querySelector('#machine-profile'),
  materialPreset: document.querySelector('#material-preset'),
  bedWidth: document.querySelector('#bed-width'),
  bedHeight: document.querySelector('#bed-height'),
  travelSpeed: document.querySelector('#travel-speed'),
  laserMax: document.querySelector('#laser-max'),
  sampleStep: document.querySelector('#sample-step'),
  originMode: document.querySelector('#origin-mode'),
  safeZ: document.querySelector('#safe-z'),
  frameSpeed: document.querySelector('#frame-speed'),
  airAssist: document.querySelector('#air-assist'),
  showToolpath: document.querySelector('#show-toolpath'),
  toggleGridButton: document.querySelector('#toggle-grid-button'),
  toggleSnapButton: document.querySelector('#toggle-snap-button'),
  toolbarCenterButton: document.querySelector('#toolbar-center-button'),
  toolbarHomeButton: document.querySelector('#toolbar-home-button'),
  toolbarSaveWorkspaceButton: document.querySelector('#toolbar-save-workspace-button'),
  toolbarDeleteWorkspaceButton: document.querySelector('#toolbar-delete-workspace-button'),
  saveMachineProfileButton: document.querySelector('#save-machine-profile-button'),
  deleteMachineProfileButton: document.querySelector('#delete-machine-profile-button'),
  defaultMachineProfileButton: document.querySelector('#default-machine-profile-button'),
  deviceUrl: document.querySelector('#device-url'),
  deviceProfile: document.querySelector('#device-profile'),
  deviceName: document.querySelector('#device-name'),
  deviceUploadPath: document.querySelector('#device-upload-path'),
  deviceScanRange: document.querySelector('#device-scan-range'),
  deviceScanButton: document.querySelector('#device-scan-button'),
  deviceConnectButton: document.querySelector('#device-connect-button'),
  deviceUploadButton: document.querySelector('#device-upload-button'),
  deviceStreamButton: document.querySelector('#device-stream-button'),
  deviceFrameButton: document.querySelector('#device-frame-button'),
  deviceUnlockButton: document.querySelector('#device-unlock-button'),
  deviceHomeButton: document.querySelector('#device-home-button'),
  devicePauseButton: document.querySelector('#device-pause-button'),
  deviceResumeButton: document.querySelector('#device-resume-button'),
  deviceStopButton: document.querySelector('#device-stop-button'),
  saveDeviceProfileButton: document.querySelector('#save-device-profile-button'),
  deleteDeviceProfileButton: document.querySelector('#delete-device-profile-button'),
  defaultDeviceProfileButton: document.querySelector('#default-device-profile-button'),
  deviceCommand: document.querySelector('#device-command'),
  deviceCommandButton: document.querySelector('#device-command-button'),
  deviceStateLabel: document.querySelector('#device-state-label'),
  deviceStateDetail: document.querySelector('#device-state-detail'),
  deviceDiscovery: document.querySelector('#device-discovery'),
  deviceFilesMeta: document.querySelector('#device-files-meta'),
  deviceFiles: document.querySelector('#device-files'),
  deviceActivity: document.querySelector('#device-activity'),
  rightTabButtons: [...document.querySelectorAll('[data-right-tab]')],
  rightPanels: [...document.querySelectorAll('[data-right-panel]')],
  operationHelp: document.querySelector('#operation-help'),
  objectSelectionSummary: document.querySelector('#object-selection-summary'),
  snapStep: document.querySelector('#snap-step'),
  snapEnabled: document.querySelector('#snap-enabled'),
  arrayCols: document.querySelector('#array-cols'),
  arrayRows: document.querySelector('#array-rows'),
  arrayGapX: document.querySelector('#array-gap-x'),
  arrayGapY: document.querySelector('#array-gap-y'),
  jobHeader: document.querySelector('#job-header'),
  jobFooter: document.querySelector('#job-footer'),
  gcodePreview: document.querySelector('#gcode-preview'),
  canvas: document.querySelector('#editor-canvas'),
  canvasPanel: document.querySelector('.canvas-panel'),
  canvasStage: document.querySelector('.canvas-stage'),
  selectModeButton: document.querySelector('#select-mode-button'),
  workspaceHint: document.querySelector('#workspace-hint'),
  layerList: document.querySelector('#layer-list'),
  layerCount: document.querySelector('#layer-count'),
  objectList: document.querySelector('#object-list'),
  objectCount: document.querySelector('#object-count'),
  documentName: document.querySelector('#document-name'),
  projectStatus: document.querySelector('#project-status'),
  statusText: document.querySelector('#status-text'),
  selectionCount: document.querySelector('#selection-count'),
  inspectorEmpty: document.querySelector('#inspector-empty'),
  inspectorFields: document.querySelector('#inspector-fields'),
  inspectorSelectionSummary: document.querySelector('#inspector-selection-summary'),
  inspectorObjectSummary: document.querySelector('#inspector-object-summary'),
  inspectorOperationSummary: document.querySelector('#inspector-operation-summary'),
  inspectorObjectBlock: document.querySelector('#inspector-object-block'),
  inspectorOperationBlock: document.querySelector('#inspector-operation-block'),
  inspectorLiveGeometryBlock: document.querySelector('#inspector-live-geometry-block'),
  layerLockRatio: document.querySelector('#layer-lock-ratio'),
  rectWidth: document.querySelector('#rect-width'),
  rectHeight: document.querySelector('#rect-height'),
  rectRx: document.querySelector('#rect-rx'),
  textContent: document.querySelector('#text-content'),
  liveRectWContainer: document.querySelector('#live-rect-w-container'),
  liveRectHContainer: document.querySelector('#live-rect-h-container'),
  liveRectRxContainer: document.querySelector('#live-rect-rx-container'),
  liveTextContentContainer: document.querySelector('#live-text-content-container'),
  measurementRoot: document.querySelector('#measurement-root'),
  layerName: document.querySelector('#layer-name'),
  layerX: document.querySelector('#layer-x'),
  layerY: document.querySelector('#layer-y'),
  layerWidth: document.querySelector('#layer-width'),
  layerHeight: document.querySelector('#layer-height'),
  layerScale: document.querySelector('#layer-scale'),
  layerRotation: document.querySelector('#layer-rotation'),
  btnSolid: document.querySelector('#btn-solid'),
  btnHole: document.querySelector('#btn-hole'),
  layerVisualThickness: document.querySelector('#layer-visual-thickness'),
  inspectorImageBlock: document.querySelector('#inspector-image-block'),
  imgBrightness: document.querySelector('#img-brightness'),
  imgContrast: document.querySelector('#img-contrast'),
  valBrightness: document.querySelector('#val-brightness'),
  valContrast: document.querySelector('#val-contrast'),
  imgFilterRed: document.querySelector('#img-filter feFuncR'),
  imgFilterGreen: document.querySelector('#img-filter feFuncG'),
  imgFilterBlue: document.querySelector('#img-filter feFuncB'),
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
  if (state.selectedDeviceProfileId) {applySavedDeviceProfile(state.selectedDeviceProfileId);}
  render();
  window.addEventListener('beforeunload', persistWorkspaceNow);
  window.addEventListener('pagehide', handlePageHide);
  initializeDeviceDiscovery();
}

function defaultOperationLayers() {
  return [
    createOperationLayer('Cut 1', '#ca5b31'),
    createOperationLayer('Score 1', '#2f6b45', { mode: 'score', power: 35, feed: 1800 }),
    createOperationLayer('Fill 1', '#22618d', { mode: 'fill', power: 40, feed: 2200 }),
  ];
}

function createDefaultMachineState() {
  return {
    presetId: initialMachine.id,
    materialPresetId: 'none',
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
    jobHeader: '; LumaBurn G-code\n$32=1 ; Ensure Laser Mode is active\nG21 ; millimeters\nG90 ; absolute positioning\nM5',
    jobFooter: 'M5\nG0 X0 Y0',
  };
}

function createDefaultDeviceState() {
  return {
    url: '',
    friendlyName: '',
    uploadPath: '/sd/',
    browsePath: '/sd/',
    storageMode: '',
    scanRange: '',
    stateLabel: 'Disconnected',
    stateDetail: 'Running in generator mode until a controller is discovered or entered manually.',
    files: [],
    discoveredSubnets: [],
    discoveryLog: [],
    bridgeActive: false,
    enabled: false,
    streaming: false,
    stopRequested: false,
    lastFileSummary: 'No storage loaded.',
    activityLog: [],
    knownScanSubnets: [],
  };
}

function normalizeStoragePath(value, fallback = '/sd/') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {return fallback;}
  if (trimmed === '/') {return '/';}
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function normalizeSavedDeviceProfile(profile) {
  if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string') {return null;}
  const device = profile.device && typeof profile.device === 'object' ? profile.device : {};
  return {
    id: profile.id,
    name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : profile.id,
    device: {
      url: normalizeDeviceUrl(device.url || ''),
      friendlyName: String(device.friendlyName || '').trim(),
      uploadPath: normalizeStoragePath(device.uploadPath, '/sd/'),
      browsePath: normalizeStoragePath(device.browsePath || device.uploadPath, '/sd/'),
      scanRange: String(device.scanRange || '').trim(),
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
  if (!state.selectedDeviceProfileId) {return;}
  state.selectedDeviceProfileId = '';
  if (elements.deviceProfile) {elements.deviceProfile.value = '';}
}

function createOperationLayer(name, color, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name,
    mode: 'line',
    lineStyle: 'continuous',
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
  elements.machinePreset.innerHTML = MACHINE_PRESETS.map((preset) => `<option value="${preset.id}">${preset.name}</option>`).join('');
  elements.materialPreset.innerHTML = MATERIAL_PRESETS.map((preset) => `<option value="${preset.id}">${preset.name}</option>`).join('');
  populateProfileMenus();
}

function populateProfileMenus() {
  elements.machineProfile.innerHTML = ['<option value="">No saved profile</option>', ...state.machineProfiles.map((profile) => `<option value="${escapeAttribute(profile.id)}">${escapeHtml(profile.name)}</option>`)].join('');
  elements.deviceProfile.innerHTML = ['<option value="">No saved profile</option>', ...state.deviceProfiles.map((profile) => `<option value="${escapeAttribute(profile.id)}">${escapeHtml(profile.name)}</option>`)].join('');
}

function bindMachineControls() {
  elements.machinePreset.addEventListener('change', () => applyMachinePreset(elements.machinePreset.value));
  elements.materialPreset.addEventListener('change', () => applyMaterialPreset(elements.materialPreset.value));
  elements.machineProfile.addEventListener('change', () => { state.selectedMachineProfileId = elements.machineProfile.value; applySavedMachineProfile(elements.machineProfile.value); });
  elements.deviceProfile.addEventListener('change', () => {
    state.selectedDeviceProfileId = elements.deviceProfile.value;
    if (elements.deviceProfile.value) {applySavedDeviceProfile(elements.deviceProfile.value);}
    else {
      setStatus('Using manual device settings.');
      render();
    }
  });

  [['bedWidth', elements.bedWidth], ['bedHeight', elements.bedHeight], ['travelSpeed', elements.travelSpeed], ['laserMax', elements.laserMax], ['sampleStep', elements.sampleStep], ['safeZ', elements.safeZ], ['frameSpeed', elements.frameSpeed], ['snapStep', elements.snapStep], ['arrayCols', elements.arrayCols], ['arrayRows', elements.arrayRows], ['arrayGapX', elements.arrayGapX], ['arrayGapY', elements.arrayGapY]].forEach(([key, input]) => {
    input.addEventListener('input', () => {
      state.machine[key] = Number(input.value);
      render();
    });
  });

  elements.originMode.addEventListener('change', () => { state.machine.originMode = elements.originMode.value; render(); });
  elements.airAssist.addEventListener('change', () => { state.machine.airAssist = elements.airAssist.checked; render(); });
  elements.showToolpath.addEventListener('change', () => { state.machine.showToolpath = elements.showToolpath.checked; render(); });
  elements.snapEnabled.addEventListener('change', () => { state.machine.snapEnabled = elements.snapEnabled.checked; });
  elements.deviceUrl.addEventListener('input', () => {
    detachSelectedDeviceProfile();
    state.device.url = normalizeDeviceUrl(elements.deviceUrl.value.trim());
    state.device.enabled = Boolean(state.device.url);
    render();
  });
  elements.deviceName.addEventListener('input', () => {
    detachSelectedDeviceProfile();
    state.device.friendlyName = elements.deviceName.value.trim();
  });
  elements.deviceUploadPath.addEventListener('input', () => {
    detachSelectedDeviceProfile();
    state.device.uploadPath = normalizeStoragePath(elements.deviceUploadPath.value, '/');
  });
  elements.deviceScanRange.addEventListener('input', () => {
    detachSelectedDeviceProfile();
    state.device.scanRange = elements.deviceScanRange.value.trim();
  });
  elements.jobHeader.addEventListener('input', () => { state.machine.jobHeader = elements.jobHeader.value; updateGcodePreview(); });
  elements.jobFooter.addEventListener('input', () => { state.machine.jobFooter = elements.jobFooter.value; updateGcodePreview(); });
  elements.fileInput.addEventListener('change', handleArtworkImport);
  elements.projectInput.addEventListener('change', handleProjectImport);
}

function showContextMenu(x, y) {
  const menu = document.getElementById('context-menu');
  if (!menu) {return;}
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  const menu = document.getElementById('context-menu');
  if (menu) {menu.classList.add('hidden');}
}

document.addEventListener('click', () => hideContextMenu());

function addBasicShape(type) {
  if (!state.operationLayers.length) {
    state.operationLayers = defaultOperationLayers();
    state.selectedOperationLayerId = state.operationLayers[0].id;
  }
  const operationLayerId = state.selectedOperationLayerId || state.operationLayers[0].id;
  const id = crypto.randomUUID();
  let node = null;
  let defaultSize = 50;
  
  if (type === 'rect') {
    node = { id, type: 'rect', tagName: 'rect', x: 0, y: 0, width: defaultSize, height: defaultSize, attributes: {}, style: { stroke:'#111', fill:'none', 'stroke-width':'2' }, transform: null };
  } else if (type === 'circle') {
    node = { id, type: 'circle', tagName: 'circle', cx: defaultSize/2, cy: defaultSize/2, r: defaultSize/2, attributes: {}, style: { stroke:'#111', fill:'none', 'stroke-width':'2' }, transform: null };
  } else if (type === 'text') {
    node = { id, type: 'text', tagName: 'text', content: 'LumaBurn', attributes: { 'font-size': '24', 'font-family': 'sans-serif', y: '24', stroke:'none' }, style: { fill: '#111' }, transform: null };
    defaultSize = 100;
  }

  const tempSceneNode = convertNodeToSceneNode(node, operationLayerId, {minX:0, minY:0, width:defaultSize, height:defaultSize});
  
  if (type === 'rect') {
    tempSceneNode.liveGeometry = { 
      type: 'rect', 
      rx: 0, 
      width: node.width || defaultSize, 
      height: node.height || defaultSize 
    };
  } else if (type === 'circle') {
    tempSceneNode.liveGeometry = { type: 'circle' };
  } else if (type === 'text') {
    tempSceneNode.liveGeometry = { type: 'text', content: 'LumaBurn' };
  }

  const bounds = measureMarkup(tempSceneNode.markup);
  if(bounds) {
    tempSceneNode.x = (state.machine.bedWidth - bounds.width) / 2 - bounds.minX;
    tempSceneNode.y = (state.machine.bedHeight - bounds.height) / 2 - bounds.minY;
    tempSceneNode.sourceBounds = bounds;
  } else {
    tempSceneNode.x = state.machine.bedWidth / 2 - defaultSize/2;
    tempSceneNode.y = state.machine.bedHeight / 2 - defaultSize/2;
  }
  
  if(!state.objects) {state.objects = [];}
  state.objects.push(tempSceneNode);
  state.selectedObjectIds = [tempSceneNode.id];
  state.interactionMode = 'select';
  if (type === 'text') {state.activeRightTab = 'edit';}
  elements.canvas.focus();
  render();
  if (type === 'text') {
    // After inspector renders, focus the text editor field for immediate editing.
    window.setTimeout(() => {
      const input = elements.liveGeometryContainer?.querySelector?.('.live-text-input');
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
    }, 0);
  }
  setStatus('Added shape.');
}

function bindButtons() {
  elements.menuImport?.addEventListener('click', () => elements.fileInput.click());
  elements.menuLoadProject?.addEventListener('click', () => elements.projectInput.click());
  elements.menuSaveProject?.addEventListener('click', saveProjectFile);
  elements.menuExport?.addEventListener('click', exportGcode);
  elements.menuFrame?.addEventListener('click', exportFrameGcode);
  elements.menuDemo?.addEventListener('click', () => loadSvgDocument(DEMO_TUTORIAL, 'tutorial.svg'));
  elements.menuReset?.addEventListener('click', resetWorkspace);
  
  elements.menuGroup?.addEventListener('click', groupSelection);
  elements.menuUngroup?.addEventListener('click', ungroupSelection);
  elements.menuDuplicate?.addEventListener('click', duplicateSelection);
  elements.menuDelete?.addEventListener('click', deleteSelection);
  
  elements.menuCenter?.addEventListener('click', centerSelectionOnBed);
  elements.menuHome?.addEventListener('click', homeSelectionOnBed);
  elements.duplicateButton.addEventListener('click', duplicateSelection);
  elements.arrayButton.addEventListener('click', makeArrayFromSelection);
  elements.deleteButton.addEventListener('click', deleteSelection);
  elements.addRectButton?.addEventListener('click', () => addBasicShape('rect'));
  elements.addCircleButton?.addEventListener('click', () => addBasicShape('circle'));
  elements.addTextButton?.addEventListener('click', () => addBasicShape('text'));
  elements.groupButton.addEventListener('click', groupSelection);
  elements.ungroupButton.addEventListener('click', ungroupSelection);

  document.getElementById('ctx-group')?.addEventListener('click', () => { groupSelection(); hideContextMenu(); });
  document.getElementById('ctx-ungroup')?.addEventListener('click', () => { ungroupSelection(); hideContextMenu(); });
  document.getElementById('ctx-flatten')?.addEventListener('click', () => { flattenAllGroups(); hideContextMenu(); });
  document.getElementById('ctx-duplicate')?.addEventListener('click', () => { duplicateSelection(); hideContextMenu(); });
  document.getElementById('ctx-delete')?.addEventListener('click', () => { deleteSelection(); hideContextMenu(); });

  document.getElementById('menu-flatten')?.addEventListener('click', (e) => { e.preventDefault(); flattenAllGroups(); });

  // Operation quick-assign from context menu
  const assignCtxOp = (modeName) => {
    const layer = state.operationLayers.find((l) => l.mode === modeName) || state.operationLayers[0];
    if (layer) {assignSelectedObjectsToOperation(layer.id);}
    hideContextMenu();
  };
  document.getElementById('ctx-op-cut')?.addEventListener('click', () => assignCtxOp('line'));
  document.getElementById('ctx-op-score')?.addEventListener('click', () => assignCtxOp('score'));
  document.getElementById('ctx-op-fill')?.addEventListener('click', () => assignCtxOp('fill'));

  elements.assignOperationButton.addEventListener('click', () => {
    if (state.selectedOperationLayerId) {assignSelectedObjectsToOperation(state.selectedOperationLayerId);}
  });
  elements.addOperationButton.addEventListener('click', addOperationLayer);
  elements.moveUpButton.addEventListener('click', () => moveOperationLayer(-1));
  elements.moveDownButton.addEventListener('click', () => moveOperationLayer(1));
  elements.toggleAllButton.addEventListener('click', toggleAllOperationLayers);
  elements.deviceConnectButton.addEventListener('click', refreshDeviceFiles);
  elements.deviceScanButton.addEventListener('click', scanNetworkForDevices);
  elements.deviceUploadButton.addEventListener('click', uploadCurrentJobToDevice);
  elements.deviceStreamButton.addEventListener('click', streamCurrentJobToDevice);
  elements.deviceFrameButton.addEventListener('click', streamFrameToDevice);
  elements.deviceUnlockButton.addEventListener('click', () => sendManualDeviceCommand('$X'));
  elements.deviceHomeButton.addEventListener('click', () => sendManualDeviceCommand('$H'));
  elements.devicePauseButton.addEventListener('click', () => sendManualDeviceCommand('M5\n!'));
  elements.deviceResumeButton.addEventListener('click', () => sendManualDeviceCommand('~'));
  elements.deviceCommandButton.addEventListener('click', () => sendManualDeviceCommand(elements.deviceCommand.value.trim()));
  elements.deviceStopButton.addEventListener('click', stopDeviceJob);
  elements.saveMachineProfileButton.addEventListener('click', () => {
    saveMachineProfile();
    render(); // Immediate feedback
  });
  elements.saveDeviceProfileButton.addEventListener('click', saveDeviceProfile);
  elements.deleteDeviceProfileButton.addEventListener('click', deleteSelectedDeviceProfile);
  elements.defaultDeviceProfileButton.addEventListener('click', setDefaultDeviceProfile);
  elements.deviceFiles.addEventListener('click', onDeviceFileActionClick);
  elements.selectModeButton.addEventListener('click', () => {
    state.interactionMode = 'select';
    elements.canvas.focus();
    render();
    setStatus('Select / Move mode active.');
  });
  elements.toggleGridButton.addEventListener('click', () => {
    state.machine.showGrid = !state.machine.showGrid;
    render();
    setStatus(state.machine.showGrid ? 'Grid shown.' : 'Grid hidden.');
  });
  elements.toggleSnapButton.addEventListener('click', () => {
    state.machine.snapEnabled = !state.machine.snapEnabled;
    render();
    setStatus(state.machine.snapEnabled ? 'Snap enabled.' : 'Snap disabled.');
  });
  elements.toolbarCenterButton.addEventListener('click', centerSelectionOnBed);
  elements.toolbarHomeButton.addEventListener('click', homeSelectionOnBed);
  elements.toolbarSaveWorkspaceButton.addEventListener('click', saveWorkspaceSnapshot);
  elements.toolbarDeleteWorkspaceButton.addEventListener('click', deleteSavedWorkspaceSnapshot);
  
  elements.centerButton.addEventListener('click', centerSelectionOnBed);
  elements.homeButton.addEventListener('click', homeSelectionOnBed);
  elements.defaultMachineProfileButton.addEventListener('click', setDefaultMachineProfile);
  elements.deleteMachineProfileButton.addEventListener('click', deleteSelectedMachineProfile);
  elements.rightTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.activeRightTab = button.getAttribute('data-right-tab') || 'assign';
      render();
    });
  });
}

function resetWorkspace() {
  state.documentName = 'No SVG Loaded';
  state.artworkViewBox = { x: 0, y: 0, width: 400, height: 400 };
  state.sourceDefsMarkup = '';
  state.machine = createDefaultMachineState();
  state.operationLayers = defaultOperationLayers();
  state.objects = [];
  state.selectedObjectIds = [];
  state.selectedOperationLayerId = state.operationLayers[0].id;
  state.dragSession = null;
  state.generatedGcode = '';
  state.interactionMode = 'select';
  window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  render();
  setStatus('Workspace reset.');
}

function saveWorkspaceSnapshot() {
  persistWorkspaceNow();
  render();
  setStatus('Workspace saved to this browser.');
}

function deleteSavedWorkspaceSnapshot() {
  if (!workspaceSaveExists()) {
    setStatus('No saved workspace to delete.');
    return;
  }
  window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  render();
  setStatus('Saved workspace deleted.');
}

function bindInspector() {
  elements.layerName.addEventListener('input', () => {
    const node = primarySelectedObject();
    if (node) {
      node.name = elements.layerName.value;
      render();
    }
  });
  [['x', elements.layerX], ['y', elements.layerY], ['rotation', elements.layerRotation]].forEach(([key, input]) => {
    input.addEventListener('input', () => {
      const value = Number(input.value);
      const node = primarySelectedObject();
      if (!node) {return;}
      node[key] = value;
      render();
    });
  });
  elements.layerScale.addEventListener('input', () => {
    const value = Math.max(0.01, Number(elements.layerScale.value) || 1);
    const node = primarySelectedObject();
    if (node) {
      node.scaleX = value;
      node.scaleY = value;
      render();
    }
  });
  elements.layerLockRatio.addEventListener('change', () => {
    const node = primarySelectedObject();
    if (node) { node.lockRatio = elements.layerLockRatio.checked; render(); }
  });
  elements.layerWidth.addEventListener('input', () => resizeSelectedObjectToDimension('width', elements.layerWidth.value));
  elements.layerHeight.addEventListener('input', () => resizeSelectedObjectToDimension('height', elements.layerHeight.value));
  elements.rectWidth.addEventListener('input', () => {
    const node = primarySelectedObject();
    if (node?.liveGeometry?.type === 'rect') {
      const val = Number(elements.rectWidth.value);
      node.liveGeometry.width = val;
      if (node.sourceBounds) {node.sourceBounds.width = val;}
      refreshLiveGeometryMarkup(node);
      renderCanvas();
    }
  });
  elements.rectHeight.addEventListener('input', () => {
    const node = primarySelectedObject();
    if (node?.liveGeometry?.type === 'rect') {
      const val = Number(elements.rectHeight.value);
      node.liveGeometry.height = val;
      if (node.sourceBounds) {node.sourceBounds.height = val;}
      refreshLiveGeometryMarkup(node);
      renderCanvas();
    }
  });
  elements.rectRx.addEventListener('input', () => {
    const node = primarySelectedObject();
    if (node?.liveGeometry?.type === 'rect') {
      node.liveGeometry.rx = Number(elements.rectRx.value);
      refreshLiveGeometryMarkup(node);
      renderCanvas();
    }
  });
  elements.textContent.addEventListener('input', () => {
    const node = primarySelectedObject();
    if (node?.liveGeometry?.type === 'text') {
      node.liveGeometry.content = elements.textContent.value;
      refreshLiveGeometryMarkup(node);
      renderCanvas();
    }
  });
  elements.btnSolid?.addEventListener('click', () => {
    const node = primarySelectedObject();
    if (node) { node.isHole = false; render(); }
  });
  elements.btnHole?.addEventListener('click', () => {
    const node = primarySelectedObject();
    if (node) { node.isHole = true; render(); }
  });
}
elements.opMode?.addEventListener('change', () => {
  const layer = activeOperationLayer();
  if (layer) { layer.mode = elements.opMode.value; render(); }
});
elements.opPower?.addEventListener('input', () => {
  const layer = activeOperationLayer();
  if (layer) { layer.power = Number(elements.opPower.value); render(); }
});
elements.opSpeed?.addEventListener('input', () => {
  const layer = activeOperationLayer();
  if (layer) { layer.feed = Number(elements.opSpeed.value); render(); }
});
elements.opPasses?.addEventListener('input', () => {
  const layer = activeOperationLayer();
  if (layer) { layer.passes = Number(elements.opPasses.value); render(); }
});
elements.opColor?.addEventListener('input', () => {
  const layer = activeOperationLayer();
  if (layer) { layer.color = elements.opColor.value; render(); }
});

elements.layerVisualThickness?.addEventListener('input', () => {
  const nodes = selectedObjects();
  nodes.forEach(n => { n.visualThickness = parseFloat(elements.layerVisualThickness.value); });
  render();
});

elements.imgBrightness?.addEventListener('input', () => {
  const nodes = selectedObjects().filter(n => n.type === 'image');
  const val = parseInt(elements.imgBrightness.value);
  nodes.forEach(n => { n.brightness = val; });
  elements.valBrightness.textContent = val > 0 ? `+${val}` : val;
  updateImageFilter();
  render();
});

elements.imgContrast?.addEventListener('input', () => {
  const nodes = selectedObjects().filter(n => n.type === 'image');
  const val = parseInt(elements.imgContrast.value);
  nodes.forEach(n => { n.contrast = val; });
  elements.valContrast.textContent = `${val}%`;
  updateImageFilter();
  render();
});

function updateImageFilter() {
  const node = primarySelectedObject();
  if (!node || node.type !== 'image' || !elements.imgFilterRed) {return;}
  const brightness = (node.brightness || 0) / 255;
  const contrast = (node.contrast !== undefined ? node.contrast : 100) / 100;
    
  // Brightness/Contrast mapping in feComponentTransfer
  // slope = contrast, intercept = (brightness - 0.5 * contrast + 0.5)
  const slope = contrast;
  const intercept = brightness - 0.5 * contrast + 0.5;
    
  [elements.imgFilterRed, elements.imgFilterGreen, elements.imgFilterBlue].forEach(f => {
    f.setAttribute('slope', slope);
    f.setAttribute('intercept', intercept);
  });
}

function activeOperationLayer() {
  const node = primarySelectedObject();
  if (node) {
    const layerId = resolveOperationLayerId(node.operationLayerId);
    return state.operationLayers.find(l => l.id === layerId);
  }
  return state.operationLayers.find(l => l.id === state.selectedOperationLayerId);
}

function bindCanvasInteraction() {
  elements.canvas.addEventListener('mousedown', onCanvasMouseDown);
  elements.canvas.addEventListener('dragstart', (event) => event.preventDefault());
  elements.canvas.addEventListener('selectstart', (event) => event.preventDefault());
  elements.canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY);
  });
}

function bindKeyboardShortcuts() {
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) {return;}
    const target = event.target;
    const inEditableField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    // Escape and Delete always fire unless typing in a form field
    if (!inEditableField) {
      if (event.key === 'Escape') {
        state.selectedObjectIds = [];
        state.activeRightTab = 'edit';
        render();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        // Only intercept Backspace for canvas/shortcut context — not browser navigation
        if (event.key === 'Backspace' && !state.selectedObjectIds.length) {return;}
        event.preventDefault();
        deleteSelection();
        return;
      }
    }
    if (inEditableField) {return;}

    // Advanced CAD Hotkeys
    if (event.key === 'Escape') {
      state.selectedObjectIds = [];
      state.activeRightTab = 'edit';
      render();
      return;
    }
    if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      state.selectedObjectIds = state.objects.map((n) => n.id);
      render();
      return;
    }
    if ((event.key === 'g' || event.key === 'G') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) {ungroupSelection();}
      else {groupSelection();}
      return;
    }
    if ((event.key === 'd' || event.key === 'D') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
      return;
    }

    if (state.interactionMode !== 'select') {return;}
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {return;}
    if (document.activeElement === elements.canvas || state.selectedObjectIds.length) {event.preventDefault();}
    const step = getKeyboardNudgeStep(event.shiftKey);
    if (event.key === 'ArrowUp') { nudgeSelection(0, -step); event.preventDefault(); }
    if (event.key === 'ArrowDown') { nudgeSelection(0, step); event.preventDefault(); }
    if (event.key === 'ArrowLeft') { nudgeSelection(-step, 0); event.preventDefault(); }
    if (event.key === 'ArrowRight') { nudgeSelection(step, 0); event.preventDefault(); }
  }, { capture: true });
}

function applyMachinePreset(presetId) {
  const preset = MACHINE_PRESETS.find((item) => item.id === presetId);
  if (!preset) {return;}
  state.machine = { ...state.machine, presetId: preset.id, bedWidth: preset.bedWidth, bedHeight: preset.bedHeight, travelSpeed: preset.travelSpeed, frameSpeed: preset.frameSpeed, laserMax: preset.laserMax, sampleStep: preset.sampleStep, originMode: preset.originMode, safeZ: preset.safeZ };
  render();
  setStatus(`Applied machine preset: ${preset.name}.`);
}

function applyMaterialPreset(presetId) {
  const preset = MATERIAL_PRESETS.find((item) => item.id === presetId);
  if (!preset) {return;}
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
  const files = event.target.files;
  if (!files || files.length === 0) {return;}
  
  const fileArray = Array.from(files);
  const svgFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.svg'));
  const otherFiles = fileArray.filter(f => !f.name.toLowerCase().endsWith('.svg'));
  
  try {
    // First, handle multiple SVGs batch import
    if (svgFiles.length > 1) {
      await importMultipleSvgs(svgFiles);
    } else if (svgFiles.length === 1) {
      // Single SVG still uses original loadSvgDocument
      const file = svgFiles[0];
      const text = await file.text();
      loadSvgDocument(text, file.name);
    }
    
    // Then handle non-SVG files individually
    for (const file of otherFiles) {
      try {
        const extension = String(file.name.split('.').pop() || '').toLowerCase();
        
        // Handle Raster Images
        if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
          const reader = new FileReader();
          reader.onload = (e) => {
            const dataUri = e.target.result;
            const img = new Image();
            img.onload = () => {
              // Convert to our standard scene node format
              const layerId = state.operationLayers[0].id;
              // Default import size is physical millimeters (e.g. 100px = 100mm, capped to bed size)
              const width = Math.min(img.width, state.machine?.bedWidth || 400);
              const height = (img.height / img.width) * width;
              
              const node = {
                id: crypto.randomUUID(),
                name: file.name,
                type: 'image',
                tagName: 'image',
                x: 0, y: 0, scaleX: 1, scaleY: 1, lockRatio: true, rotation: 0,
                operationLayerId: layerId,
                src: dataUri,
                sourceBounds: { minX: 0, minY: 0, width, height, centerX: width / 2, centerY: height / 2 },
                children: []
              };
              
              state.objects.push(node);
              state.selectedObjectIds = [node.id];
              setStatus(`Imported image: ${file.name}`);
              render();
            };
            img.src = dataUri;
          };
          reader.readAsDataURL(file);
          continue;
        }

        const text = await file.text();
        if (['gc', 'gcode'].includes(extension)) {
          loadGcodeDocument(text, file.name);
          continue;
        }
        if (['lbrn', 'lbrn2'].includes(extension)) {
          loadLightBurnDocument(text, file.name);
          continue;
        }
        setStatus(`Unsupported artwork file: ${file.name}. Import .svg, .png, .jpg, .gc, or .lbrn.`);
      } catch (e) {
        setStatus(`Error importing ${file.name}: ${e.message}`);
      }
    }
  } finally {
    elements.fileInput.value = '';
  }
}


async function handleProjectImport(event) {
  const [file] = event.target.files ?? [];
  if (!file) {return;}
  try {
    restoreProject(JSON.parse(await file.text()), file.name);
    setStatus(`Loaded project: ${file.name}.`);
  } catch {
    setStatus('Project file is invalid.');
  }
  elements.projectInput.value = '';
}

function loadSvgDocument(svgText, name) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {throw new Error('The SVG could not be parsed.');}
    const root = doc.documentElement;
    const viewBox = root.viewBox?.baseVal;
    const sourceDefs = [...root.querySelectorAll('defs, style, linearGradient, radialGradient, pattern, clipPath, mask, symbol, marker, filter')];
    const width = viewBox?.width || numberFromLength(root.getAttribute('width')) || 400;
    const height = viewBox?.height || numberFromLength(root.getAttribute('height')) || 400;
    state.documentName = name;
    state.artworkViewBox = { x: viewBox?.x || 0, y: viewBox?.y || 0, width, height };
    state.sourceDefsMarkup = sourceDefs.map((node) => node.outerHTML).join('');

    if (!state.operationLayers.length) {
      state.operationLayers = defaultOperationLayers();
      state.selectedOperationLayerId = state.operationLayers[0].id;
    }

    const operationLayerId = state.operationLayers[0].id;
    const artworkBounds = { minX: viewBox?.x || 0, minY: viewBox?.y || 0, width, height };
    let sceneChildNodes = [];
    
    if (USE_NODE_TREE_CONVERSION) {
      // Use new node-tree conversion
      const converted = convertSvgToNodes(root, { resolveUseElements: true });
      // Map and then filter out invisible/background nodes recursively
      sceneChildNodes = converted.nodes
        .map(node => convertNodeToSceneNode(node, ''))
        .filter(n => isSceneNodeVisible(n, artworkBounds));
    } else {
      let topLevelGraphics = filterImportGraphics([...root.children], artworkBounds);
      if (!topLevelGraphics.length) {
        const nestedGraphics = filterImportGraphics(
          [...root.querySelectorAll('g, path, rect, circle, ellipse, line, polyline, polygon, use, text, image')].map((node) => node.cloneNode(true)),
          artworkBounds,
        );
        if (nestedGraphics.length) {topLevelGraphics = nestedGraphics;}
      }
      if (topLevelGraphics.length === 1 && topLevelGraphics[0].tagName === 'g' && !topLevelGraphics[0].hasAttribute('transform')) {
        const directChildren = filterImportGraphics([...topLevelGraphics[0].children], artworkBounds);
        if (directChildren.length) {topLevelGraphics = directChildren;}
      }
      sceneChildNodes = topLevelGraphics.map((node) => createSceneNodeFromDom(node, '', { x: 0, y: 0, scale: 1, rotation: 0 }, artworkBounds));
    }

    if (sceneChildNodes.length === 0) {
      throw new Error('No supported graphic elements found in this SVG.');
    }

    // Calculate tight source bounds from filtered children
    const tightBounds = unionBounds(sceneChildNodes.map(n => objectWorldBounds(n)));
    const actualWidth = tightBounds.width;
    const actualHeight = tightBounds.height;

    // Scale and center based on actual content bounds for a tighter, more intuitive placement
    const baseScale = Math.min((state.machine.bedWidth * 0.72) / actualWidth, (state.machine.bedHeight * 0.72) / actualHeight, 1.6);
    const offsetX = (state.machine.bedWidth - actualWidth * baseScale) / 2 - tightBounds.x * baseScale;
    const offsetY = (state.machine.bedHeight - actualHeight * baseScale) / 2 - tightBounds.y * baseScale;

    const rootNode = {
      id: crypto.randomUUID(),
      name: stripExtension(name) || 'Imported SVG',
      type: 'group',
      markup: '',
      x: offsetX,
      y: offsetY,
      scaleX: baseScale,
      scaleY: baseScale,
      lockRatio: true,
      rotation: 0,
      operationLayerId,
      children: sceneChildNodes,
      sourceBounds: tightBounds,
    };
    state.objects.push(rootNode);
    state.selectedObjectIds = [rootNode.id];
    state.interactionMode = 'select';
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
    if (!parsed.polylines.length || !parsed.bounds) {throw new Error('No burn geometry was found in this G-code file.');}
    loadPolylineDocument(parsed.polylines, parsed.bounds, name, 'Imported G-code');
    setStatus(`Loaded ${parsed.polylines.length} toolpath segment${parsed.polylines.length === 1 ? '' : 's'} from ${name}.`);
  } catch (error) {
    setStatus(error.message);
  }
}

function loadLightBurnDocument(sourceText, name) {
  try {
    const parsed = parseLightBurnGeometry(sourceText);
    if (!parsed.polylines.length || !parsed.bounds) {throw new Error('No supported LightBurn geometry was found in this file.');}
    loadPolylineDocument(parsed.polylines, parsed.bounds, name, 'Imported LightBurn');
    setStatus(`Loaded ${parsed.polylines.length} LightBurn shape${parsed.polylines.length === 1 ? '' : 's'} from ${name}.`);
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
  state.sourceDefsMarkup = '';
  const baseScale = Math.min((state.machine.bedWidth * 0.72) / width, (state.machine.bedHeight * 0.72) / height, 1.6);
  const offsetX = (state.machine.bedWidth - width * baseScale) / 2 - state.artworkViewBox.x * baseScale;
  const offsetY = (state.machine.bedHeight - height * baseScale) / 2 - state.artworkViewBox.y * baseScale;
  const operationLayerId = state.operationLayers[0].id;
  const markup = `<g>${buildSvgMarkupFromPolylines(polylines)}</g>`;
  const newNode = createImportedSceneNodeFromMarkup(
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
  );
  state.objects.push(newNode);
  state.selectedObjectIds = [newNode.id];
  state.interactionMode = 'select';
  elements.canvas.focus();
  render();
}


async function importMultipleSvgs(files) {
  if (!state.operationLayers.length) {
    state.operationLayers = defaultOperationLayers();
    state.selectedOperationLayerId = state.operationLayers[0].id;
  }

  const newNodes = [];
  const fileArray = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.svg'));
  
  if (fileArray.length === 0) {return;}
  
  // Calculate grid layout
  const bedWidth = state.machine.bedWidth;
  const bedHeight = state.machine.bedHeight;
  const cols = Math.ceil(Math.sqrt(fileArray.length));
  const rows = Math.ceil(fileArray.length / cols);
  
  // Determine the maximum dimensions of all SVGs to calculate scaling
  const svgInfoArray = [];
  
  for (const file of fileArray) {
    try {
      const text = await file.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'image/svg+xml');
      if (doc.querySelector('parsererror')) {continue;}
      const root = doc.documentElement;
      const viewBox = root.viewBox?.baseVal;
      const width = viewBox?.width || numberFromLength(root.getAttribute('width')) || 400;
      const height = viewBox?.height || numberFromLength(root.getAttribute('height')) || 400;
      svgInfoArray.push({ file, text, width, height });
    } catch (e) {
      console.warn('Failed to parse', file.name, e.message);
    }
  }
  
  if (svgInfoArray.length === 0) {return;}
  
  // Calculate max width/height across all SVGs for uniform scaling
  const maxWidth = Math.max(...svgInfoArray.map(s => s.width));
  const maxHeight = Math.max(...svgInfoArray.map(s => s.height));
  
  // Calculate cell dimensions with padding
  const padding = 20; // mm padding between SVGs
  const cellWidth = (bedWidth - (cols + 1) * padding) / cols;
  const cellHeight = (bedHeight - (rows + 1) * padding) / rows;
  
  // Scale to fit within cell, maintaining aspect ratio
  const uniformScale = Math.min(cellWidth / maxWidth, cellHeight / maxHeight, 1);
  
  // Position SVGs in grid
  svgInfoArray.forEach((info, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    
    const cellCenterX = padding + cellWidth * (col + 0.5);
    const cellCenterY = padding + cellHeight * (row + 0.5);
    
    // Center the individual SVG within its cell
    const svgCenterX = info.width * uniformScale / 2;
    const svgCenterY = info.height * uniformScale / 2;
    const x = cellCenterX - svgCenterX;
    const y = cellCenterY - svgCenterY;
    
    try {
      const node = parseSvgToSceneNode(info.text, info.file.name, { x, y, scale: uniformScale });
      if (node) {newNodes.push(node);}
    } catch (e) {
      console.warn('Failed to import', info.file.name, e.message);
    }
  });
  
  if (newNodes.length === 0) {return;}
  
  // Merge with existing objects and select all new ones
  state.objects = [...state.objects, ...newNodes];
  state.selectedObjectIds = newNodes.map(n => n.id);
  
  state.interactionMode = 'select';
  elements.canvas.focus();
  render();
  setStatus(`Imported ${newNodes.length} SVG(s) in ${cols}x${rows} grid.`);
}

// Helper: Parse SVG without affecting state - returns a scene node
function parseSvgToSceneNode(svgText, name, options = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) {throw new Error('The SVG could not be parsed.');}
  const root = doc.documentElement;
  const viewBox = root.viewBox?.baseVal;
  const width = viewBox?.width || numberFromLength(root.getAttribute('width')) || 400;
  const height = viewBox?.height || numberFromLength(root.getAttribute('height')) || 400;
  
  if (!state.operationLayers.length) {
    state.operationLayers = defaultOperationLayers();
    state.selectedOperationLayerId = state.operationLayers[0].id;
  }
  
  const artworkBounds = { minX: viewBox?.x || 0, minY: viewBox?.y || 0, width, height };
  let topLevelGraphics = filterImportGraphics([...root.children], artworkBounds);
  if (!topLevelGraphics.length) {
    const nestedGraphics = filterImportGraphics(
      [...root.querySelectorAll('g, path, rect, circle, ellipse, line, polyline, polygon, use, text, image')].map((node) => node.cloneNode(true)),
      artworkBounds,
    );
    if (nestedGraphics.length) {topLevelGraphics = nestedGraphics;}
  }
  if (topLevelGraphics.length === 1 && topLevelGraphics[0].tagName === 'g' && !topLevelGraphics[0].hasAttribute('transform')) {
    const directChildren = filterImportGraphics([...topLevelGraphics[0].children], artworkBounds);
    if (directChildren.length) {topLevelGraphics = directChildren;}
  }
  if (!topLevelGraphics.length) {throw new Error('No supported SVG graphics were found in this file.');}
  
  // Calculate tight source bounds from children instead of using viewBox
  const tightBounds = unionBounds(topLevelGraphics.map(node => measureMarkup(node.outerHTML)));
  const actualWidth = tightBounds.width;
  const actualHeight = tightBounds.height;
  
  const baseScale = options.scale || Math.min((state.machine.bedWidth * 0.72) / actualWidth, (state.machine.bedHeight * 0.72) / actualHeight, 1.6);
  const offsetX = options.x !== undefined ? options.x : (state.machine.bedWidth - actualWidth * baseScale) / 2 - tightBounds.x * baseScale;
  const offsetY = options.y !== undefined ? options.y : (state.machine.bedHeight - actualHeight * baseScale) / 2 - tightBounds.y * baseScale;
  const operationLayerId = options.operationLayerId || state.selectedOperationLayerId || state.operationLayers[0].id;
  
  const rootNode = {
    id: crypto.randomUUID(),
    name: stripExtension(name) || 'Imported SVG',
    type: 'group',
    markup: '',
    x: offsetX,
    y: offsetY,
    scaleX: baseScale,
    scaleY: baseScale,
    lockRatio: true,
    rotation: options.rotation || 0,
    operationLayerId,
    children: topLevelGraphics.map((node) => createSceneNodeFromDom(node, operationLayerId, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, artworkBounds)),
    sourceBounds: tightBounds,
  };
  
  return rootNode;
}

function createSceneNodeFromDom(domNode, operationLayerId, transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, artworkBounds = state.artworkViewBox) {
  const isContainer = ['g', 'svg'].includes(domNode.tagName);
  const rawChildren = isContainer ? [...domNode.children] : [];
  const childrenNodes = rawChildren
    .map(child => createSceneNodeFromDom(child, '', { x:0, y:0, scaleX:1, scaleY:1, rotation:0 }, artworkBounds))
    .filter(c => isSceneNodeVisible(c, artworkBounds));
    
  // If it's a leaf, we use its own markup. If it's a group, we use "" so objectWorldBounds uses children.
  const markup = isContainer ? '' : domNode.outerHTML;
  const sourceBounds = !isContainer ? measureMarkup(domNode.outerHTML) : (childrenNodes.length > 0 ? unionBounds(childrenNodes.map(c => objectWorldBounds(c))) : { x:0, y:0, width:0, height:0 });

  const node = {
    id: crypto.randomUUID(),
    name: domNode.getAttribute('id') || domNode.getAttribute('inkscape:label') || prettyNodeName(domNode.tagName),
    type: isContainer ? 'group' : domNode.tagName,
    markup,
    x: transform.x,
    y: transform.y,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    lockRatio: true,
    rotation: transform.rotation,
    operationLayerId,
    children: childrenNodes,
    sourceBounds,
  };

  if (domNode.tagName === 'rect') {
    node.liveGeometry = {
      type: 'rect',
      width: Number(domNode.getAttribute('width')) || 0,
      height: Number(domNode.getAttribute('height')) || 0,
      rx: Number(domNode.getAttribute('rx')) || Number(domNode.getAttribute('ry')) || 0,
    };
  }
  
  return node;
}

function isVisible(node) {
  if (node.tagName === 'g' || node.tagName === 'svg') {
    return [...node.children].some(isVisible);
  }
  if (['image', 'text'].includes(node.tagName)) {return true;}
  
  const fill = node.getAttribute('fill');
  const stroke = node.getAttribute('stroke');
  const style = node.getAttribute('style') || '';
  const opacity = numericOr(node.getAttribute('opacity'), 1) * numericOr(node.getAttribute('fill-opacity'), 1);
  if (opacity < 0.001) {return false;}
  
  const hasFill = fill && fill !== 'none' && fill !== 'transparent';
  const hasStroke = stroke && stroke !== 'none' && stroke !== 'transparent';
  const hasStyleFill = style.includes('fill:') && !style.includes('fill:none') && !style.includes('fill:transparent') && !style.includes('fill: none');
  const hasStyleStroke = style.includes('stroke:') && !style.includes('stroke:none') && !style.includes('stroke:transparent') && !style.includes('stroke: none');
  
  return hasFill || hasStroke || hasStyleFill || hasStyleStroke;
}

function filterImportGraphics(nodes, artworkBounds) {
  const all = Array.isArray(nodes) ? nodes : [];
  const graphicNodes = all.filter(isGraphicNode).filter(isVisible);
  
  const otherGraphics = graphicNodes.filter(node => !isLikelyBackgroundRect(node, artworkBounds));
  return otherGraphics.length > 0 ? otherGraphics : [];
}

function isLikelyBackgroundRect(node, artworkBounds = state.artworkViewBox) {
  if (!node || node.tagName !== 'rect' || node.hasAttribute('transform')) {return false;}
  
  const fill = String(node.getAttribute('fill') || 'none').toLowerCase();
  const stroke = String(node.getAttribute('stroke') || 'none').toLowerCase();
  const isTransparent = (fill === 'none' || fill === 'transparent') && (stroke === 'none' || stroke === 'transparent');
  const isWhiteFill = ['#fff', '#ffffff', 'white', 'rgb(255,255,255)', 'rgb(255, 255, 255)'].includes(fill);
  
  if (!isTransparent && !isWhiteFill) {return false;}

  const x = numberFromLength(node.getAttribute('x'));
  const y = numberFromLength(node.getAttribute('y'));
  const width = numberFromLength(node.getAttribute('width'));
  const height = numberFromLength(node.getAttribute('height'));
  
  // Check if this rect is effectively the size of the whole artwork
  // We check BOTH the rect's own attributes AND its approximate world position in the SVG
  const minX = numericOr(artworkBounds?.minX ?? artworkBounds?.x, 0);
  const minY = numericOr(artworkBounds?.minY ?? artworkBounds?.y, 0);
  const boundsWidth = Math.max(0, numericOr(artworkBounds?.width, 0));
  const boundsHeight = Math.max(0, numericOr(artworkBounds?.height, 0));
  const tolerance = 5.0; 

  const matchesDirect = Math.abs(x - minX) <= tolerance
    && Math.abs(y - minY) <= tolerance
    && Math.abs(width - boundsWidth) <= tolerance
    && Math.abs(height - boundsHeight) <= tolerance;
    
  if (matchesDirect) {return true;}

  // Fallback: Check if its bounding box in SVG space matches
  try {
    const bbox = node.getBBox();
    return Math.abs(bbox.width - boundsWidth) <= tolerance 
        && Math.abs(bbox.height - boundsHeight) <= tolerance
        && Math.abs(bbox.x - minX) <= tolerance
        && Math.abs(bbox.y - minY) <= tolerance;
  } catch {
    return false;
  }
}


function isLikelyBackgroundRectFromSceneNode(node, artworkBounds = state.artworkViewBox) {
  if (!node || node.type !== 'rect' || node.rotation) {return false;}
  
  // Use world bounds (relative to parent group) to compare with artworkBounds
  const wb = objectWorldBounds(node, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });

  const swProp = node.style?.['stroke-width'] ?? node.attributes?.['stroke-width'] ?? node['stroke-width'];
  const sw = numericOr(swProp, 1);
  const stroke = node.style?.stroke ?? node.attributes?.stroke ?? node.stroke;
  if (stroke && stroke !== 'none' && sw > 0.5) {return false;}

  const fill = String(node.style?.fill ?? node.attributes?.fill ?? node.fill ?? 'none').toLowerCase();
  const isTransparent = fill === 'none' || fill === 'transparent';
  const isWhite = ['#fff', '#ffffff', 'white', 'rgb(255,255,255)', 'rgb(255, 255, 255)'].includes(fill);
  
  if (!isTransparent && !isWhite) {return false;}

  const minX = numericOr(artworkBounds?.minX ?? artworkBounds?.x, 0);
  const minY = numericOr(artworkBounds?.minY ?? artworkBounds?.y, 0);
  const boundsWidth = Math.max(0, numericOr(artworkBounds?.width, 0));
  const boundsHeight = Math.max(0, numericOr(artworkBounds?.height, 0));
  const tolerance = 1.0; // Relaxed tolerance for various export formats
  
  return Math.abs(wb.x - minX) <= tolerance
    && Math.abs(wb.y - minY) <= tolerance
    && Math.abs(wb.width - boundsWidth) <= tolerance
    && Math.abs(wb.height - boundsHeight) <= tolerance;
}

function createImportedSceneNodeFromMarkup(markup, name, operationLayerId, transform = { x: 0, y: 0, scale: 1, rotation: 0 }, sourceBounds = measureMarkup(markup)) {
  const s = transform.scaleX ?? transform.scale ?? 1;
  return {
    id: crypto.randomUUID(),
    name,
    type: 'group',
    markup,
    x: transform.x,
    y: transform.y,
    scaleX: s,
    scaleY: transform.scaleY ?? s,
    lockRatio: true,
    rotation: transform.rotation,
    operationLayerId,
    children: [],
    sourceBounds,
  };
}

function restoreProject(project, name) {
  if (!project || !project.machine || !Array.isArray(project.objects) || !Array.isArray(project.operationLayers)) {throw new Error('Invalid project.');}
  state.documentName = project.documentName || stripExtension(name);
  state.artworkViewBox = project.artworkViewBox || state.artworkViewBox;
  state.sourceDefsMarkup = project.sourceDefsMarkup || '';
  state.machine = { ...state.machine, ...project.machine };
  state.operationLayers = project.operationLayers;
  state.objects = normalizeSceneNodes(project.objects, state.operationLayers[0]?.id || '');
  state.selectedObjectIds = Array.isArray(project.selectedObjectIds)
    ? project.selectedObjectIds.filter((id) => Boolean(findNodeById(id, state.objects)))
    : [];
  state.selectedOperationLayerId = project.selectedOperationLayerId || state.operationLayers[0]?.id || '';
  render();
}

function saveProjectFile() {
  downloadText(`${stripExtension(state.documentName) || 'lumaburn-project'}.json`, JSON.stringify({
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
  setStatus('Saved project JSON.');
}

function isGraphicNode(node) {
  return ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'text', 'image'].includes(node.tagName);
}

function render() {
  // Ensure all nodes have scaleX and scaleY for transition
  state.objects.forEach(node => {
    if (node.scaleX === undefined) {node.scaleX = node.scale ?? 1;}
    if (node.scaleY === undefined) {node.scaleY = node.scale ?? 1;}
  });

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
  elements.canvasPanel.style.aspectRatio = '';
  elements.canvasStage.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  elements.toggleGridButton.textContent = state.machine.showGrid ? 'Hide Grid' : 'Show Grid';
  elements.toggleSnapButton.textContent = state.machine.snapEnabled ? 'Snap On' : 'Snap Off';
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
    const tab = button.getAttribute('data-right-tab');
    const active = tab === state.activeRightTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  elements.rightPanels.forEach((panel) => {
    const panelTab = panel.getAttribute('data-right-panel');
    panel.hidden = panelTab !== state.activeRightTab;
  });
  elements.selectModeButton.classList.toggle('button-primary', state.interactionMode === 'select');
  elements.selectModeButton.classList.toggle('button-ghost', state.interactionMode !== 'select');
  elements.workspaceHint.textContent = state.selectedObjectIds.length
    ? primaryNode
      ? `Selected: ${primaryNode.name}. Drag the item to move it, or drag the bottom-right handle to resize it live.`
      : 'Selection active. Drag the item to move it, or drag the bottom-right handle to resize it live.'
    : 'Click objects to select. Drag to move. Shift-click to multi-select. Arrow keys nudge by 1 mm.';
  elements.operationHelp.textContent = selectedNodes.length
    ? `Selected ${selectedNodes.length} object${selectedNodes.length === 1 ? '' : 's'}. Click an operation row or a colored dot in the object list to assign it.`
    : 'Select artwork, then click an operation row or a colored dot in the object list to assign it.';
  elements.objectSelectionSummary.textContent = selectedNodes.length
    ? selectedNodes.length === 1 && primaryNode
      ? `Selected ${primaryNode.name} · ${assignedLayerNames.length ? `Operation: ${assignedLayerNames.join(', ')}` : 'No operation assigned'}`
      : `Selected ${selectedNodes.length} objects · ${assignedLayerNames.length ? `Operations: ${assignedLayerNames.join(', ')}` : 'No operation assigned'}`
    : 'No objects selected.';
  syncAssignOperationSelect();
  syncDeviceControls();
  renderDiscoveryLog();
  renderDeviceFiles();
  renderDeviceActivity();
}

function syncAssignOperationSelect() {
}

function syncDeviceControls() {
  const enabled = state.device.enabled;
  const canRunFromController = controllerCanAutostartJobs();
  elements.deviceStreamButton.textContent = canRunFromController ? 'Run Job' : 'Upload Job';
  elements.deviceStreamButton.title = canRunFromController
    ? 'Upload the G-code to controller storage and start it there so the controller owns the run.'
    : 'This controller path supports upload-only from the app. Start the uploaded file directly on the controller.';
  [elements.deviceConnectButton, elements.deviceUploadButton, elements.deviceStreamButton, elements.deviceFrameButton, elements.deviceUnlockButton, elements.deviceHomeButton, elements.devicePauseButton, elements.deviceResumeButton, elements.deviceCommandButton].forEach((button) => {
    button.disabled = !enabled || state.device.streaming;
  });
  elements.deviceCommand.disabled = !enabled || state.device.streaming;
  elements.deviceScanButton.disabled = !state.device.bridgeActive || state.device.streaming;
  elements.deleteMachineProfileButton.disabled = !state.selectedMachineProfileId;
  elements.deleteDeviceProfileButton.disabled = !state.selectedDeviceProfileId;
}

function renderDiscoveryLog() {
  elements.deviceDiscovery.innerHTML = state.device.discoveryLog.length ? state.device.discoveryLog.map((entry) => escapeHtml(entry)).join('<br />') : 'Network discovery has not run yet.';
}

function renderDeviceFiles() {
  if (!state.device.files.length) {
    elements.deviceFiles.innerHTML = 'No files found on the active device storage path.';
    elements.deviceFiles.classList.add('empty-state');
    return;
  }
  const canRunFromController = controllerCanAutostartJobs();
  elements.deviceFiles.classList.remove('empty-state');
  elements.deviceFiles.innerHTML = state.device.files.map((file) => `
    <div class="file-item">
      <div>
        <strong>${escapeHtml(file.name || file.shortname || 'Unnamed file')}</strong>
        <span>${escapeHtml(file.size || '')}</span>
      </div>
      <div class="file-actions">
        <span>${escapeHtml(file.time || '')}</span>
        <button class="mini-button" data-device-action="run" data-device-file="${escapeAttribute(file.name || file.shortname || '')}" ${canRunFromController ? '' : 'disabled title="This controller path supports upload-only from the app. Start the file directly on the controller."'}>Run</button>
        <button class="mini-button" data-device-action="delete" data-device-file="${escapeAttribute(file.name || file.shortname || '')}">Delete</button>
      </div>
    </div>
  `).join('');
}

function renderDeviceActivity() {
  if (!state.device.activityLog.length) {
    elements.deviceActivity.innerHTML = 'No controller activity yet.';
    elements.deviceActivity.classList.add('empty-state');
    return;
  }
  elements.deviceActivity.classList.remove('empty-state');
  elements.deviceActivity.innerHTML = state.device.activityLog.map((entry) => `
    <div class="activity-item ${escapeAttribute(entry.level)}">
      <div class="activity-head">
        <strong>${escapeHtml(entry.message)}</strong>
        <span class="activity-meta">${escapeHtml(entry.time)}</span>
      </div>
      ${entry.detail ? `<p>${escapeHtml(entry.detail)}</p>` : ''}
    </div>
  `).join('');
}

function renderOperations() {
  const hasSelection = selectedObjects().length > 0;
  elements.layerList.innerHTML = state.operationLayers.map((layer) => `
    <div role="button" tabindex="0" class="layer-item operation-item${layer.id === state.selectedOperationLayerId ? ' active' : ''}${layer.enabled ? '' : ' disabled'}${hasSelection ? ' assign-ready' : ''}" data-operation-id="${layer.id}" style="--operation-color:${escapeAttribute(layer.color)}">
      <div class="layer-topline">
        <strong>${escapeHtml(layer.name)}</strong>
        <span class="layer-chip"><span class="layer-color" style="background:${escapeAttribute(layer.color)}"></span>${escapeHtml(layer.mode)}</span>
      </div>
      <div class="layer-meta">
        <span>${layer.enabled ? 'Enabled' : 'Disabled'} · ${layer.feed} mm/min · ${layer.power}% · ${layer.passes} pass</span>
        ${hasSelection ? "<span class='assign-hint'>Click to assign selected objects</span>" : ''}
      </div>
    </div>
  `).join('');
  [...elements.layerList.querySelectorAll('[data-operation-id]')].forEach((button) => {
    button.addEventListener('click', () => {
      const operationId = button.getAttribute('data-operation-id');
      state.selectedOperationLayerId = operationId;
      state.activeRightTab = 'edit';
      if (selectedObjects().length) {
        assignSelectedObjectsToOperation(operationId);
        const operation = operationLayerById(operationId);
        setStatus(`Assigned selected objects to ${operation?.name || 'operation'}.`);
        return;
      }
      render();
    });
  });
}

function renderObjectTree() {
  elements.objectList.innerHTML = renderObjectNodes(state.objects, 0);
  [...elements.objectList.querySelectorAll('[data-object-id]')].forEach((button) => {
    button.addEventListener('click', (event) => {
      selectObject(button.getAttribute('data-object-id'), event.metaKey || event.ctrlKey || event.shiftKey);
      state.activeRightTab = 'edit';
      render();
    });
  });
  [...elements.objectList.querySelectorAll('[data-assign-object-id][data-assign-operation-id]')].forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const objectId = button.getAttribute('data-assign-object-id');
      const operationId = button.getAttribute('data-assign-operation-id');
      const node = findNodeById(objectId);
      const operation = operationLayerById(operationId);
      if (!node || !operation) {return;}
      applyOperationToNode(node, operationId);
      state.selectedObjectIds = [objectId];
      state.selectedOperationLayerId = operationId;
      render();
      setStatus(`Assigned ${node.name} to ${operation.name}.`);
    });
  });
}

function renderObjectNodes(nodes, depth, inheritedOperationLayerId = '') {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const children = nodeChildren(node);
    const effectiveOperationLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);
    const operationLayer = operationLayerById(effectiveOperationLayerId) || state.operationLayers[0] || null;
    const effectiveOperationIds = collectEffectiveOperationLayerIds(node, inheritedOperationLayerId);
    const hasMixedOperations = effectiveOperationIds.length > 1;
    const operationColor = hasMixedOperations ? '#6f6f6f' : operationLayer?.color || '#ca5b31';
    const operationLabel = hasMixedOperations
      ? 'Mixed operations'
      : operationLayer?.name || 'No operation';
    const operationSourceLabel = hasMixedOperations
      ? `${effectiveOperationIds.length} active ops`
      : node.operationLayerId
        ? 'Direct'
        : children.length
          ? 'Inherited by children'
          : 'Inherited';
    const quickAssign = state.operationLayers.map((layer) => `
      <button
        type="button"
        class="operation-dot${layer.id === effectiveOperationLayerId && !hasMixedOperations ? ' current' : ''}"
        title="Assign to ${escapeAttribute(layer.name)}"
        aria-label="Assign ${escapeAttribute(node.name)} to ${escapeAttribute(layer.name)}"
        data-assign-object-id="${escapeAttribute(node.id)}"
        data-assign-operation-id="${escapeAttribute(layer.id)}"
        style="--dot-color:${escapeAttribute(layer.color)}"
      ></button>
    `).join('');
    return `
    <div class="object-card" style="margin-left:${depth * 14}px">
      <div role="button" tabindex="0" class="layer-item object-item${state.selectedObjectIds.includes(node.id) ? ' active' : ''}" data-object-id="${node.id}" style="--object-operation-color:${escapeAttribute(operationColor)}">
        <div class="layer-topline">
          <strong>${escapeHtml(node.name)}</strong>
          <span class="layer-chip"><span class="layer-color" style="background:${escapeAttribute(operationColor)}"></span>${escapeHtml(node.type)}</span>
        </div>
        <div class="layer-meta">${state.selectedObjectIds.includes(node.id) ? 'Selected · ' : ''}${escapeHtml(operationLabel)} · ${escapeHtml(operationSourceLabel)} · ${children.length ? `${children.length} child` : 'leaf'}</div>
      </div>

      <div class="object-operation-dots" aria-label="Operation shortcuts">
        ${quickAssign}
      </div>
    </div>
    ${children.length ? renderObjectNodes(children, depth + 1, effectiveOperationLayerId) : ''}
  `;
  }).join('');
}

function renderInspector() {
  const nodes = selectedObjects();
  const primaryNode = primarySelectedObject();
  const selectionOperation = effectiveOperationLayerForNode(primaryNode)?.operationLayer || null;
  const allOperations = new Set(nodes.map(n => effectiveOperationLayerForNode(n)?.operationLayer?.id).filter(Boolean));
  const isMixedSelection = allOperations.size > 1;
  const operationLayer = selectionOperation || operationLayerById(state.selectedOperationLayerId) || state.operationLayers[0] || null;
  const hasObjectSelection = Boolean(primaryNode);
  const hasOperationContext = Boolean(operationLayer);
  const hasInspectorContext = hasObjectSelection || hasOperationContext;
  elements.inspectorSelectionSummary.textContent = primaryNode
    ? nodes.length <= 1 ? `Editing ${primaryNode.name}` : `Editing ${primaryNode.name} · primary of ${nodes.length} selected`
    : operationLayer ? `No object selected. Editing operation ${operationLayer.name}.` : 'No object selected.';
  elements.inspectorEmpty.classList.toggle('hidden', hasInspectorContext);
  elements.inspectorFields.classList.toggle('hidden', !hasInspectorContext);
  if (!hasInspectorContext) {
    elements.inspectorEmpty.textContent = 'Click an object on the canvas or in the Objects list to edit size and placement.';
    elements.inspectorObjectSummary.textContent = 'Select one object to edit placement and size';
    elements.inspectorOperationSummary.textContent = 'Laser output settings';
    return;
  }
  const node = primaryNode;
  const objectEditable = Boolean(node);
  const nodeContext = node ? findNodeContextById(node.id) : null;
  const bounds = objectEditable ? objectWorldBounds(node, nodeContext?.parentTransform) : null;
  const effectiveSelection = effectiveOperationLayerForNode(node);
  const operationSource = objectEditable && effectiveSelection
    ? ` · ${effectiveSelection.direct ? 'direct' : 'inherited'}`
    : '';
  elements.inspectorObjectBlock.classList.toggle('inactive', !objectEditable);
  elements.inspectorOperationBlock.classList.toggle('inactive', !hasOperationContext);
  elements.inspectorObjectSummary.textContent = objectEditable
    ? `${node.name} · exact selected part`
    : 'Select one object to edit placement and size';
  elements.inspectorOperationSummary.innerHTML = operationLayer
    ? `<div class="inspector-badge">
        <span class="badge-dot" style="background:${isMixedSelection ? '#888' : operationLayer.color}"></span>
        ${isMixedSelection ? 'Mixed Operations' : operationLayer.name}${operationSource}
        <span class="badge-details">· ${operationLayer.mode} · ${operationLayer.power}% @ ${operationLayer.feed} mm/min</span>
      </div>`
    : 'Laser output settings';
  elements.layerName.disabled = !objectEditable;
  elements.layerX.disabled = !objectEditable;
  elements.layerY.disabled = !objectEditable;
  elements.layerScale.disabled = !objectEditable;
  elements.layerWidth.disabled = !objectEditable;
  elements.layerHeight.disabled = !objectEditable;
  elements.layerRotation.disabled = !objectEditable;
  elements.layerScale.value = objectEditable ? (node.scaleX === node.scaleY ? round(node.scaleX || node.scale || 1, 2).toFixed(2) : 'Mixed') : '';
  elements.layerRotation.value = objectEditable ? String(round(node.rotation ?? 0, 1)) : '';
  
  if (elements.layerWidth) {
    elements.layerWidth.value = bounds ? formatCompact(bounds.width) : '';
  }
  if (elements.layerHeight) {
    elements.layerHeight.value = bounds ? formatCompact(bounds.height) : '';
  }
  if (elements.layerLockRatio) {
    elements.layerLockRatio.checked = node ? (node.lockRatio ?? true) : true;
  }
  if (elements.layerVisualThickness) {
    elements.layerVisualThickness.value = node?.visualThickness ?? 0.3;
  }
  
  if (node) {
    if (node.isHole) {
      elements.btnHole.classList.add('active');
      elements.btnSolid.classList.remove('active');
      elements.btnHole.style.background = 'var(--accent)';
      elements.btnHole.style.color = 'white';
      elements.btnSolid.style.background = 'transparent';
      elements.btnSolid.style.color = 'var(--muted)';
    } else {
      elements.btnSolid.classList.add('active');
      elements.btnHole.classList.remove('active');
      elements.btnSolid.style.background = 'var(--accent)';
      elements.btnSolid.style.color = 'white';
      elements.btnHole.style.background = 'transparent';
      elements.btnHole.style.color = 'var(--muted)';
    }

    // Sync Operation Settings
    if (operationLayer && elements.opMode) {
      elements.opMode.value = operationLayer.mode || 'line';
      elements.opPower.value = operationLayer.power || 0;
      elements.opSpeed.value = operationLayer.feed || 0;
      elements.opPasses.value = operationLayer.passes || 1;
      elements.opColor.value = operationLayer.color || '#000000';
      elements.opIdDisplay.value = operationLayer.id;
    }

    // Image Settings Sync
    if (node.type === 'image' && elements.inspectorImageBlock) {
      elements.inspectorImageBlock.classList.remove('hidden');
      elements.imgBrightness.value = node.brightness ?? 0;
      elements.imgContrast.value = node.contrast ?? 100;
      elements.valBrightness.textContent = (node.brightness ?? 0) > 0 ? `+${node.brightness}` : (node.brightness ?? 0);
      elements.valContrast.textContent = `${node.contrast ?? 100}%`;
      updateImageFilter();
    } else if (elements.inspectorImageBlock) {
      elements.inspectorImageBlock.classList.add('hidden');
    }
    
    // Live Geometry Injection
    if (node.liveGeometry && elements.inspectorLiveGeometryBlock) {
      elements.inspectorLiveGeometryBlock.classList.remove('hidden');
      const type = node.liveGeometry.type;
      
      if (elements.liveRectWContainer) {elements.liveRectWContainer.classList.toggle('hidden', type !== 'rect');}
      if (elements.liveRectHContainer) {elements.liveRectHContainer.classList.toggle('hidden', type !== 'rect');}
      if (elements.liveRectRxContainer) {elements.liveRectRxContainer.classList.toggle('hidden', type !== 'rect');}
      if (elements.liveTextContentContainer) {elements.liveTextContentContainer.classList.toggle('hidden', type !== 'text');}
      
      if (type === 'rect') {
        elements.rectWidth.value = node.liveGeometry.width;
        elements.rectHeight.value = node.liveGeometry.height;
        elements.rectRx.value = node.liveGeometry.rx;
      } else if (type === 'text') {
        elements.textContent.value = node.liveGeometry.content || '';
      }
    } else if (elements.inspectorLiveGeometryBlock) {
      elements.inspectorLiveGeometryBlock.classList.add('hidden');
    }
  } else if (elements.liveGeometryBlock) {
    elements.liveGeometryBlock.style.display = 'none';
  }
}

function renderCanvas() {
  elements.canvas.innerHTML = '';
  const viewBox = canvasViewport();
  elements.canvas.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  elements.canvas.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  appendSvgMarkup(elements.canvas, state.sourceDefsMarkup);
  renderBedSurface();
  if (state.machine.showGrid) {renderGrid();}
  renderBedOutline();
  renderBedGuides();
  renderOrigin();
  state.objects.forEach((node) => elements.canvas.appendChild(renderCanvasNode(node, true)));
  renderInteractionOverlay();
  renderSelectionOverlay();
}

function renderBedSurface() {
  const defs = createSvg('defs');
  const gradient = createSvg('linearGradient', {
    id: 'bed-surface-gradient',
    x1: '0%',
    y1: '0%',
    x2: '0%',
    y2: '100%',
  });
  gradient.appendChild(createSvg('stop', { offset: '0%', 'stop-color': '#fffdf8' }));
  gradient.appendChild(createSvg('stop', { offset: '100%', 'stop-color': '#f8f1e6' }));
  defs.appendChild(gradient);
  elements.canvas.appendChild(defs);
  elements.canvas.appendChild(createSvg('rect', {
    x: 0,
    y: 0,
    width: state.machine.bedWidth,
    height: state.machine.bedHeight,
    rx: 2.5,
    class: 'bed-surface',
    fill: 'url(#bed-surface-gradient)',
  }));
}

function renderCanvasNode(node, isTopLevel = false, isMaskMode = false, inheritedOperationLayerId = '') {
  const children = nodeChildren(node);
  const operation = effectiveOperationLayerForNode(node)?.operationLayer;
  const power = operation?.power ?? 100;
  // Adaptive opacity: 100% power = opacity 1.0, 1% power = opacity ~0.15 for visibility
  const visualOpacity = (power / 100) * 0.85 + 0.15;
  const visualStroke = node.visualThickness ?? 0.3;

  const wrapper = createSvg('g', {
    transform: composeTransform(node),
    'data-object-id': node.id,
    class: `artwork${state.selectedObjectIds.includes(node.id) ? ' selected' : ''}`,
    'pointer-events': 'bounding-box',
    'opacity': visualOpacity,
    ...(isTopLevel ? { 'data-workspace-object-id': node.id } : {}),
  });
  if (isTopLevel) {
    wrapper.addEventListener('mousedown', (event) => startObjectInteraction(event, node.id));
  }

  if (children.length) {
    // Boolean Luma-Group Logic
    const holes = children.filter(c => c.isHole);
    const solids = children.filter(c => !c.isHole);

    const effectiveOperationLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);

    // Only apply masking if there are BOTH solids and holes in this group layer
    if (!isMaskMode && holes.length > 0 && solids.length > 0) {
      const defs = createSvg('defs');
      const mask = createSvg('mask', { id: `luma-mask-${node.id}` });
      mask.appendChild(createSvg('rect', { x: '-50000', y: '-50000', width: '100000', height: '100000', fill: 'white' }));
      holes.forEach(hole => mask.appendChild(renderCanvasNode(hole, false, true, effectiveOperationLayerId)));
      defs.appendChild(mask);

      const solidsWrapper = createSvg('g', { mask: `url(#luma-mask-${node.id})` });
      solids.forEach(solid => solidsWrapper.appendChild(renderCanvasNode(solid, false, false, effectiveOperationLayerId)));
      wrapper.appendChild(solidsWrapper);

      holes.forEach(hole => wrapper.appendChild(renderCanvasNode(hole, false, false, effectiveOperationLayerId)));
    } else {
      children.forEach((child) => wrapper.appendChild(renderCanvasNode(child, false, isMaskMode, effectiveOperationLayerId)));
    }
  } else {
    if (node.type === 'image') {
      const filterId = `filter-${node.id}`;
      const brightness = node.brightness || 0;
      const contrast = (node.contrast ?? 100) / 100;
      
      const filter = createSvg('filter', { id: filterId });
      const componentTransfer = createSvg('feComponentTransfer');
      const slope = contrast;
      const intercept = (brightness / 255) + (0.5 * (1 - contrast));
      
      ['feFuncR', 'feFuncG', 'feFuncB'].forEach(funcName => {
        componentTransfer.appendChild(createSvg(funcName, { type: 'linear', slope, intercept }));
      });
      filter.appendChild(componentTransfer);
      wrapper.appendChild(createSvg('defs')).appendChild(filter);

      const img = createSvg('image', {
        href: node.src,
        x: node.sourceBounds?.minX || 0,
        y: node.sourceBounds?.minY || 0,
        width: node.sourceBounds?.width || 100,
        height: node.sourceBounds?.height || 100,
        preserveAspectRatio: 'none',
        filter: `url(#${filterId})`
      });
      wrapper.appendChild(img);
    } else {
      // For vectors, we need a way to pass strokeWidth to the markup injector.
      // But since markup is a string, we just apply it style-wise if possible or inject it.
      // Actually, buildSvgMarkupFromPolylines now supports it. 
      // But for static imports, we should probably just rely on non-scaling-stroke and this wrapper's opacity.
      appendSvgMarkup(wrapper, node.markup);
      // Force visual stroke if it's a vector path
      const paths = wrapper.querySelectorAll('path, circle, rect, ellipse, line, polyline, polygon');
      paths.forEach(p => {
        p.setAttribute('stroke-width', visualStroke);
        p.setAttribute('stroke', operation?.color || '#111111');
      });
    }
    
    [wrapper.firstElementChild, ...wrapper.querySelectorAll('*')].forEach((el) => {
      if (!(el instanceof SVGElement) || el.tagName === 'image') {return;}
      el.setAttribute('vector-effect', 'non-scaling-stroke');
      el.setAttribute('pointer-events', 'none');

      if (isMaskMode) {
        // Deep nested paths inside a hole mask must render stark black to erase the shape
        el.setAttribute('fill', 'black');
        el.setAttribute('stroke', 'black');
        el.setAttribute('stroke-width', '1');
        el.removeAttribute('stroke-dasharray');
      } else if (node.isHole) {
        // Visual cue on the canvas for a Hole shape (translucent grey, dashed line)
        el.setAttribute('fill', 'rgba(0, 0, 0, 0.08)');
        el.setAttribute('stroke', 'rgba(0, 0, 0, 0.4)');
        el.setAttribute('stroke-dasharray', '4 4');
        el.setAttribute('stroke-width', '1.5');
      } else {
        // Color objects by their assigned/inherited operation layer
        const effectiveLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);
        const operationLayer = effectiveLayerId ? state.operationLayers.find(l => l.id === effectiveLayerId) : state.operationLayers[0];
        const opColor = operationLayer?.color || '#1c1c1c';
        const opMode = String(operationLayer?.mode || 'line').toLowerCase();
        
        // Dynamically scale stroke and opacity based on layer power to simulate real burn darkness/thickness
        const powerRatio = Math.max(0.01, Math.min(1.0, (operationLayer?.power || 10) / (state.machine?.laserMax || 1000)));
        const strokeThickness = 0.5 + (powerRatio * 2.0); // Ranges from 0.5px to 2.5px
        const fillAlpha = 0.2 + (powerRatio * 0.7); // Ranges from 20% to 90% opacity
        const scoreAlpha = 0.1 + (powerRatio * 0.4); // Ranges from 10% to 50% opacity
        const lineAlpha = 0.4 + (powerRatio * 0.6); // Ranges from 40% to 100% opacity

        // We use the assigned layer color, but we could use a single "burn" color (e.g. #301b0d) 
        // if we add a "Burn Preview" toggle later. For now, layer colors get WYSIWYG intensity.
        if (opMode === 'fill') {
          el.setAttribute('fill', opColor);
          el.style.fill = opColor;
          el.style.fillOpacity = fillAlpha.toFixed(2);
          el.style.stroke = opColor;
          el.style.strokeWidth = '0.5px';
          el.style.strokeOpacity = '0.5';
          el.style.strokeDasharray = 'none';
          // Ensure we don't have hidden visibility from source
          el.style.visibility = 'visible';
          el.style.display = 'inline';
        } else if (opMode === 'score') {
          el.style.fill = opColor;
          el.style.fillOpacity = scoreAlpha.toFixed(2);
          el.style.stroke = opColor;
          el.style.strokeOpacity = lineAlpha.toFixed(2);
          el.style.strokeWidth = `${strokeThickness}px`;
          el.style.strokeDasharray = '5 3';
          el.style.visibility = 'visible';
        } else {
          // Default Line (Cut)
          el.setAttribute('fill', 'none');
          el.style.fill = 'none';
          el.style.fillOpacity = '0';
          el.style.stroke = opColor;
          el.style.strokeOpacity = lineAlpha.toFixed(2);
          el.style.strokeWidth = `${strokeThickness}px`;
          el.style.strokeDasharray = 'none';
          el.style.visibility = 'visible';
        }
      }
    });
  }
  return wrapper;
}

function renderSelectionOverlay() {
  const overlay = createSvg('g', { class: 'selection-overlay' });
  const viewBox = canvasViewport();
  // Dimension labels only — bounding box is drawn by renderInteractionOverlay
  selectedObjects().forEach((node) => {
    const context = findNodeContextById(node.id);
    const b = context ? objectWorldBounds(node, context.parentTransform) : objectWorldBounds(node);
    overlay.appendChild(createSvg('text', {
      x: b.x + 4,
      y: Math.max(viewBox.y + 12, b.y - 6),
      class: 'canvas-hud selection-dimensions',
      fill: '#7a3a22',
      'pointer-events': 'none',
    }, `${formatCompact(b.width)} × ${formatCompact(b.height)} mm`));
  });
  elements.canvas.appendChild(overlay);
}


function renderInteractionOverlay() {
  const overlay = createSvg('g', { class: 'interaction-overlay' });

  if (state.dragSession?.kind === 'marquee') {
    const { startPoint: p1, currentPoint: p2 } = state.dragSession;
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const width = Math.abs(p1.x - p2.x);
    const height = Math.abs(p1.y - p2.y);
    
    overlay.appendChild(createSvg('rect', {
      x, y, width, height,
      fill: 'rgba(202, 91, 49, 0.1)',
      stroke: 'var(--accent)',
      'stroke-width': 1.2,
      'stroke-dasharray': '4,4',
      'pointer-events': 'none'
    }));
  }

  // Calculate the union bounds for ALL selected objects first
  const selectedNodes = state.objects.filter(n => state.selectedObjectIds.includes(n.id));
  let unionBox = null;
  if (selectedNodes.length > 0) {
    const boundsList = selectedNodes.map(n => {
      const ctx = findNodeContextById(n.id);
      return ctx ? objectWorldBounds(n, ctx.parentTransform) : objectWorldBounds(n);
    });
    // unionBounds may return {minX,minY,width,height} — normalize to {x,y,width,height}
    const raw = unionBounds(boundsList);
    unionBox = {
      x: raw.x ?? raw.minX ?? 0,
      y: raw.y ?? raw.minY ?? 0,
      width: raw.width ?? 0,
      height: raw.height ?? 0
    };
  }

  // Draw hitboxes for everything to allow click-to-select
  state.objects.forEach((node) => {
    const context = findNodeContextById(node.id);
    const b = context ? objectWorldBounds(node, context.parentTransform) : objectWorldBounds(node);
    const isSelected = state.selectedObjectIds.includes(node.id);
    const padding = isSelected ? 4 : 2;

    const hitbox = createSvg('rect', {
      x: b.x - padding,
      y: b.y - padding,
      width: Math.max(6, b.width) + padding * 2,
      height: Math.max(6, b.height) + padding * 2,
      class: 'object-hitbox',
      'data-object-id': node.id,
      'data-hitbox-for': node.id,
    });
    hitbox.addEventListener('mousedown', (event) => {
      if (event.button === 2) {return;}
      startObjectInteraction(event, node.id);
    });
    hitbox.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (!isSelected) {
        state.selectedObjectIds = [node.id];
        render();
      }
      showContextMenu(event.clientX, event.clientY);
    });
    overlay.appendChild(hitbox);
  });

  // Only draw ONE set of handles representing the UNION of the selection
  if (unionBox && unionBox.width >= 0) {
    const b = unionBox;
    const padding = 4;
    const handleSize = 8;
    /* const offset = handleSize / 2; - unused */

    // The comprehensive dashed box around the whole selection
    const selectionBorder = createSvg('rect', {
      x: b.x - padding, y: b.y - padding,
      width: b.width + padding * 2, height: b.height + padding * 2,
      fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.2,
      'stroke-dasharray': '4,4', 'pointer-events': 'none'
    });
    overlay.appendChild(selectionBorder);

    // Rotate handle
    const rotR = handleSize / 2 + 1;
    const rX = b.x + b.width / 2;
    const rY = b.y - padding - rotR - 10;
    
    const rotG = createSvg('g', { cursor: 'crosshair' });
    const rotHandle = createSvg('circle', {
      cx: rX, cy: rY, r: rotR + 2,
      fill: 'var(--accent)', stroke: 'white', 'stroke-width': '0.8',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))'
    });
    const rotIcon = createSvg('text', {
      x: rX, y: rY,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: 'white',
      'font-size': `${rotR * 1.6}`,
      'font-weight': 'bold',
      style: 'pointer-events:none; user-select:none;'
    });
    rotIcon.textContent = '\u21bb';
    rotG.appendChild(rotHandle);
    rotG.appendChild(rotIcon);
    rotG.addEventListener('mousedown', (event) => {
      startRotateInteraction(event, state.selectedObjectIds[0]); 
    });
    overlay.appendChild(rotG);

    // Scale handles at the 4 bounds corners — use directionally correct glyphs
    const scaleCorners = [
      { x: b.x - padding, y: b.y - padding, cursor: 'nwse-resize', glyph: '\u2921' },          // upper-left: ⤡ NW-SE
      { x: b.x + b.width + padding, y: b.y - padding, cursor: 'nesw-resize', glyph: '\u2922' }, // upper-right: ⤢ NE-SW
      { x: b.x + b.width + padding, y: b.y + b.height + padding, cursor: 'nwse-resize', glyph: '\u2921' }, // lower-right: ⤡ NW-SE
      { x: b.x - padding, y: b.y + b.height + padding, cursor: 'nesw-resize', glyph: '\u2922' }  // lower-left: ⤢ NE-SW
    ];
    const scR = handleSize / 2 + 1;
    scaleCorners.forEach(corner => {
      const scaleG = createSvg('g', { cursor: corner.cursor });
      const cx = corner.x;
      const cy = corner.y;
      const scaleHandle = createSvg('circle', {
        cx, cy, r: scR + 1,
        fill: 'var(--accent)', stroke: 'white', 'stroke-width': '0.8',
        filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))'
      });
      const scaleIcon = createSvg('text', {
        x: cx, y: cy,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        fill: 'white',
        'font-size': `${scR * 1.4}`,
        'font-weight': 'bold',
        style: 'pointer-events:none; user-select:none;'
      });
      scaleIcon.textContent = corner.glyph;
      scaleG.appendChild(scaleHandle);
      scaleG.appendChild(scaleIcon);
      scaleG.addEventListener('mousedown', (event) => startResizeInteraction(event, state.selectedObjectIds[0]));
      overlay.appendChild(scaleG);
    });
  }

  elements.canvas.appendChild(overlay);
}

function renderGrid() {
  const grid = createSvg('g', { class: 'canvas-grid' });
  for (let x = 0; x <= state.machine.bedWidth; x += 10) {
    const major = x % 100 === 0;
    const mid = !major && x % 50 === 0;
    grid.appendChild(createSvg('line', {
      x1: x,
      y1: 0,
      x2: x,
      y2: state.machine.bedHeight,
      stroke: major ? 'rgba(122,58,34,0.42)' : mid ? 'rgba(122,58,34,0.24)' : 'rgba(22,22,22,0.11)',
      'stroke-width': major ? 1.2 : mid ? 0.85 : 0.45,
    }));
  }
  for (let y = 0; y <= state.machine.bedHeight; y += 10) {
    const major = y % 100 === 0;
    const mid = !major && y % 50 === 0;
    grid.appendChild(createSvg('line', {
      x1: 0,
      y1: y,
      x2: state.machine.bedWidth,
      y2: y,
      stroke: major ? 'rgba(122,58,34,0.42)' : mid ? 'rgba(122,58,34,0.24)' : 'rgba(22,22,22,0.11)',
      'stroke-width': major ? 1.2 : mid ? 0.85 : 0.45,
    }));
  }
  elements.canvas.appendChild(grid);
}

function renderBedOutline() {
  elements.canvas.appendChild(createSvg('rect', {
    x: 0.75,
    y: 0.75,
    width: Math.max(0, state.machine.bedWidth - 1.5),
    height: Math.max(0, state.machine.bedHeight - 1.5),
    rx: 2,
    fill: 'none',
    stroke: 'rgba(22,22,22,0.68)',
    'stroke-width': 1.8,
  }));
}

function renderBedGuides() {
  const guideGroup = createSvg('g', { class: 'bed-guides' });
  guideGroup.appendChild(createSvg('text', {
    x: 0,
    y: -18,
    class: 'canvas-hud bed-label',
    fill: '#5e5a55',
  }, `Bed ${formatCompact(state.machine.bedWidth)} x ${formatCompact(state.machine.bedHeight)} mm`));
  guideGroup.appendChild(createSvg('text', {
    x: 0,
    y: -8,
    class: 'canvas-hud bed-label',
    fill: '#5e5a55',
  }, `Ray5 job origin: ${state.machine.originMode === 'lower-left' ? 'lower-left' : 'upper-left'} home`));
  renderBedRulers(guideGroup);
  elements.canvas.appendChild(guideGroup);
}

function renderBedRulers(group) {
  const lowerLeft = state.machine.originMode === 'lower-left';
  const rulerOffset = 8;
  const baselineY = lowerLeft ? state.machine.bedHeight + rulerOffset : -rulerOffset;
  const baselineX = -rulerOffset;
  const xTextY = lowerLeft ? baselineY + 10 : baselineY - 6;
  group.appendChild(createSvg('line', {
    x1: 0,
    y1: baselineY,
    x2: state.machine.bedWidth,
    y2: baselineY,
    stroke: 'rgba(122,58,34,0.75)',
    'stroke-width': 0.9,
  }));
  group.appendChild(createSvg('line', {
    x1: baselineX,
    y1: 0,
    x2: baselineX,
    y2: state.machine.bedHeight,
    stroke: 'rgba(122,58,34,0.75)',
    'stroke-width': 0.9,
  }));
  for (let x = 0; x <= state.machine.bedWidth; x += 10) {
    const major = x % 100 === 0;
    const mid = !major && x % 50 === 0;
    const tick = major ? 10 : mid ? 7 : 4;
    group.appendChild(createSvg('line', {
      x1: x,
      y1: baselineY,
      x2: x,
      y2: lowerLeft ? baselineY - tick : baselineY + tick,
      stroke: major ? 'rgba(122,58,34,0.9)' : 'rgba(94,90,84,0.6)',
      'stroke-width': major ? 1 : 0.7,
    }));
    if (major) {
      group.appendChild(createSvg('text', {
        x,
        y: x === 0 ? xTextY : xTextY,
        class: 'canvas-hud ruler-label',
        fill: 'rgba(122,58,34,0.95)',
        'text-anchor': x === 0 ? 'start' : 'middle',
      }, `${x}`));
    }
  }
  for (let y = 0; y <= state.machine.bedHeight; y += 10) {
    const major = y % 100 === 0;
    const mid = !major && y % 50 === 0;
    const tick = major ? 10 : mid ? 7 : 4;
    group.appendChild(createSvg('line', {
      x1: baselineX,
      y1: y,
      x2: baselineX + tick,
      y2: y,
      stroke: major ? 'rgba(122,58,34,0.9)' : 'rgba(94,90,84,0.6)',
      'stroke-width': major ? 1 : 0.7,
    }));
    if (major) {
      const label = lowerLeft ? state.machine.bedHeight - y : y;
      group.appendChild(createSvg('text', {
        x: baselineX - 4,
        y: y + 2,
        class: 'canvas-hud ruler-label',
        fill: 'rgba(122,58,34,0.95)',
        'text-anchor': 'end',
      }, `${label}`));
    }
  }
}

function renderOrigin() {
  const lowerLeft = state.machine.originMode === 'lower-left';
  const originX = 0;
  const originY = lowerLeft ? state.machine.bedHeight : 0;
  const labelY = lowerLeft ? originY - 10 : originY + 18;
  const origin = createSvg('g', { class: 'machine-origin' });
  origin.appendChild(createSvg('line', { x1: originX, y1: originY, x2: originX + 16, y2: originY, stroke: '#ca5b31', 'stroke-width': 1.8, 'stroke-linecap': 'round' }));
  origin.appendChild(createSvg('line', { x1: originX, y1: originY, x2: originX, y2: lowerLeft ? originY - 16 : originY + 16, stroke: '#ca5b31', 'stroke-width': 1.8, 'stroke-linecap': 'round' }));
  origin.appendChild(createSvg('circle', { cx: originX, cy: originY, r: 3.8, fill: '#ca5b31' }));
  origin.appendChild(createSvg('text', { x: originX + 20, y: labelY, class: 'canvas-hud origin-label', fill: '#7a3a22' }, 'Home 0,0'));
  elements.canvas.appendChild(origin);
}

function onCanvasMouseDown(event) {
  if (event.button !== 0) {return;}
  elements.canvas.focus();
  if (state.interactionMode !== 'select') {return;}
  const target = event.target.closest('[data-object-id]');
  if (!target) {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      state.selectedObjectIds = [];
      state.activeRightTab = 'edit';
      render();
    }
    state.dragSession = {
      active: false,
      kind: 'marquee',
      startPoint: eventToSvgPoint(event),
      currentPoint: eventToSvgPoint(event),
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      initialSelectedObjectIds: [...state.selectedObjectIds]
    };
    window.addEventListener('mousemove', onCanvasMouseMove);
    window.addEventListener('mouseup', onCanvasMouseUp);
    window.addEventListener('blur', onCanvasMouseUp);
    return;
  }
  startObjectInteraction(event, target.getAttribute('data-object-id'));
}

function onCanvasMouseMove(event) {
  if (!state.dragSession) {return;}
  if ((event.buttons & 1) !== 1) {
    onCanvasMouseUp();
    return;
  }
  const point = eventToSvgPoint(event);
  const dx = point.x - state.dragSession.startPoint.x;
  const dy = point.y - state.dragSession.startPoint.y;
  if (!state.dragSession.active && Math.hypot(dx, dy) < 2) {return;}
  state.dragSession.active = true;
  event.preventDefault();

  if (state.dragSession.kind === 'marquee') {
    state.dragSession.currentPoint = point;
    updateMarqueeSelection();
    render();
    return;
  }
  
  if (state.dragSession.kind === 'resize') {
    updateLiveResize(point);
    render();
    return;
  } else if (state.dragSession.kind === 'rotate') {
    updateLiveRotate(point);
    render();
    return;
  }
  
  state.dragSession.origins.forEach((origin) => {
    const node = findNodeById(origin.id);
    if (!node) {return;}
    node.x = round(origin.x + dx, 2);
    node.y = round(origin.y + dy, 2);
  });
  updateLiveWorkspaceDuringDrag();
}

function onCanvasMouseUp() {
  if (!state.dragSession) {return;}
  window.removeEventListener('mousemove', onCanvasMouseMove);
  window.removeEventListener('mouseup', onCanvasMouseUp);
  window.removeEventListener('blur', onCanvasMouseUp);
  if (state.dragSession.active) {render();}
  state.dragSession = null;
}

function updateMarqueeSelection() {
  const { startPoint, currentPoint } = state.dragSession;
  const minX = Math.min(startPoint.x, currentPoint.x);
  const minY = Math.min(startPoint.y, currentPoint.y);
  const maxX = Math.max(startPoint.x, currentPoint.x);
  const maxY = Math.max(startPoint.y, currentPoint.y);

  const baseSelection = new Set(state.dragSession.initialSelectedObjectIds || []);
  const marqueeSelectedIds = state.objects.filter((node) => {
    const b = objectWorldBounds(node);
    if (!b || b.width === undefined) {return false;}
    const nx = b.x !== undefined ? b.x : b.minX;
    const ny = b.y !== undefined ? b.y : b.minY;
    const right = nx + b.width;
    const bottom = ny + b.height;
    return nx < maxX && right > minX && ny < maxY && bottom > minY;
  }).map((node) => node.id);

  if (state.dragSession.additive) {
    marqueeSelectedIds.forEach((id) => baseSelection.add(id));
    state.selectedObjectIds = [...baseSelection];
  } else {
    state.selectedObjectIds = marqueeSelectedIds;
  }
}

function startObjectInteraction(event, objectId) {
  if (!objectId) {return;}
  event.preventDefault();
  event.stopPropagation();
  elements.canvas.focus();
  const previousSelection = state.selectedObjectIds.join(',');
  selectObject(objectId, event.metaKey || event.ctrlKey || event.shiftKey);
  if (state.selectedObjectIds.join(',') !== previousSelection) {
    state.activeRightTab = 'edit';
    render();
  }
  const point = eventToSvgPoint(event);
  state.dragSession = {
    kind: 'move',
    startPoint: point,
    origins: selectedWorkspaceObjects().map((node) => ({ id: node.id, x: node.x, y: node.y })),
    active: false,
  };
  window.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup', onCanvasMouseUp);
  window.addEventListener('blur', onCanvasMouseUp);
  refreshSelectionUi();
}

function startResizeInteraction(event, objectId) {
  if (!objectId) {return;}
  event.preventDefault();
  event.stopPropagation();
  elements.canvas.focus();
  selectObject(objectId, false);
  state.activeRightTab = 'edit';
  const node = findNodeById(objectId);
  const context = node ? findNodeContextById(node.id) : null;
  const bounds = node && context ? objectWorldBounds(node, context.parentTransform) : null;
  if (!node || !context || !bounds || bounds.width <= 0 || bounds.height <= 0) {
    render();
    return;
  }
  const point = eventToSvgPoint(event);
  state.dragSession = {
    kind: 'resize',
    objectId,
    startPoint: point,
    startBounds: bounds,
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    startScaleX: node.scaleX ?? node.scale ?? 1,
    startScaleY: node.scaleY ?? node.scale ?? 1,
    startX: node.x,
    startY: node.y,
    sourceBounds: node.sourceBounds,
    active: false,
  };
  window.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup', onCanvasMouseUp);
  window.addEventListener('blur', onCanvasMouseUp);
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
  const node = findNodeById(state.dragSession.objectId);
  if (!node) {return;}
  
  const { center, startPoint, startScaleX, startScaleY, startX, startY, sourceBounds } = state.dragSession;
  
  const startDx = Math.abs(startPoint.x - center.x);
  const startDy = Math.abs(startPoint.y - center.y);
  const currentDx = Math.abs(point.x - center.x);
  const currentDy = Math.abs(point.y - center.y);
  
  // Ratio Calculation
  let ratioX = startDx > 1 ? currentDx / startDx : 1;
  let ratioY = startDy > 1 ? currentDy / startDy : 1;
  
  // Shift key or lockRatio forces proportionate
  const isLocked = state.keys?.Shift || (node.lockRatio !== false);
  if (isLocked) {
    // If one dimension was nearly zero at start (side drag), use the other
    if (startDx < 5) {ratioX = ratioY;}
    else if (startDy < 5) {ratioY = ratioX;}
    else {
      const avgRatio = (ratioX + ratioY) / 2;
      ratioX = avgRatio;
      ratioY = avgRatio;
    }
  }
  
  const nextScaleX = round(Math.max(0.01, startScaleX * ratioX), 4);
  const nextScaleY = round(Math.max(0.01, startScaleY * ratioY), 4);
  
  node.scaleX = nextScaleX;
  node.scaleY = nextScaleY;
  
  // Adjust position to keep center stable
  node.x = round(startX + sourceBounds.centerX * (startScaleX - nextScaleX), 2);
  node.y = round(startY + sourceBounds.centerY * (startScaleY - nextScaleY), 2);
}

function startRotateInteraction(event, objectId) {
  if (!objectId) {return;}
  event.preventDefault();
  event.stopPropagation();
  elements.canvas.focus();
  selectObject(objectId, false);
  const node = findNodeById(objectId);
  const context = findNodeContextById(node.id);
  const bounds = objectWorldBounds(node, context.parentTransform);
  if (!node || !bounds) {return;}
  
  const point = eventToSvgPoint(event);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  
  state.dragSession = {
    kind: 'rotate',
    objectId,
    startPoint: point,
    cx, cy,
    startRotation: node.rotation || 0
  };
  window.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup', onCanvasMouseUp);
  window.addEventListener('blur', onCanvasMouseUp);
}

function updateLiveRotate(point) {
  if (!state.dragSession || state.dragSession.kind !== 'rotate') {return;}
  const node = findNodeById(state.dragSession.objectId);
  if (!node) {return;}
  
  const { cx, cy, startPoint, startRotation } = state.dragSession;
  const startAngle = Math.atan2(startPoint.y - cy, startPoint.x - cx);
  const currentAngle = Math.atan2(point.y - cy, point.x - cx);
  
  const deltaDeg = (currentAngle - startAngle) * (180 / Math.PI);
  node.rotation = round(startRotation + deltaDeg, 1);
}

function selectObject(id, additive = false) {
  if (!additive) {
    state.selectedObjectIds = [id];
    return;
  }
  state.selectedObjectIds = state.selectedObjectIds.includes(id) ? state.selectedObjectIds.filter((item) => item !== id) : [...state.selectedObjectIds, id];
}

function selectedObjects() {
  return state.selectedObjectIds.map((id) => findNodeById(id)).filter(Boolean);
}

function primarySelectedObject() {
  const primaryId = state.selectedObjectIds.at(-1);
  return primaryId ? findNodeById(primaryId) : null;
}



function selectedWorkspaceObjects() {
  // Prefer direct top-level membership — critical for post-ungroup selection
  return state.selectedObjectIds
    .map((id) => {
      const direct = state.objects.find((n) => n.id === id);
      if (direct) {return direct;}
      const topLevel = topLevelNodeForId(id);
      return topLevel;
    })
    .filter(Boolean)
    .filter((node, index, arr) => arr.findIndex((n) => n.id === node.id) === index); // dedupe
}

function selectedWorkspaceObjectsOrAll() {
  const selected = selectedWorkspaceObjects();
  return selected.length ? selected : state.objects;
}



function resizeSelectedObjectToDimension(dimension, value) {
  const node = primarySelectedObject();
  if (!node) {return;}
  const nextSize = Number(value);
  if (!Number.isFinite(nextSize) || nextSize <= 0) {return;}
  const context = findNodeContextById(node.id);
  const bounds = context ? objectWorldBounds(node, context.parentTransform) : objectWorldBounds(node);
  const currentSize = dimension === 'width' ? bounds.width : bounds.height;
  if (!Number.isFinite(currentSize) || currentSize <= 0) {return;}
  const factor = nextSize / currentSize;
  
  if (node.lockRatio !== false) {
    node.scaleX = round(Math.max(0.01, node.scaleX * factor), 4);
    node.scaleY = round(Math.max(0.01, node.scaleY * factor), 4);
  } else {
    if (dimension === 'width') {node.scaleX = round(Math.max(0.01, node.scaleX * factor), 4);}
    else {node.scaleY = round(Math.max(0.01, node.scaleY * factor), 4);}
  }
  render();
}

function refreshSelectionUi() {
  elements.selectionCount.textContent = `${selectedObjects().length} selected`;
  elements.workspaceHint.textContent = state.selectedObjectIds.length
    ? 'Drag the selected item to move it, or drag the bottom-right handle to resize it live. Shift + Arrow moves 10x.'
    : 'Click objects to select. Drag to move. Shift-click to multi-select. Arrow keys nudge by the active grid step.';
  renderObjectTree();
  renderInspector();
}

function updateLiveWorkspaceDuringDrag() {
  selectedWorkspaceObjects().forEach((node) => {
    const wrapper = elements.canvas.querySelector(`[data-workspace-object-id="${CSS.escape(node.id)}"]`);
    if (wrapper) {wrapper.setAttribute('transform', composeTransform(node));}
  });
  state.objects.forEach((node) => {
    const hitbox = elements.canvas.querySelector(`[data-hitbox-for="${CSS.escape(node.id)}"]`);
    if (!hitbox) {return;}
    const bounds = objectWorldBounds(node);
    hitbox.setAttribute('x', String(bounds.x));
    hitbox.setAttribute('y', String(bounds.y));
    hitbox.setAttribute('width', String(Math.max(6, bounds.width)));
    hitbox.setAttribute('height', String(Math.max(6, bounds.height)));
  });
  const previousOverlay = elements.canvas.querySelector('.selection-overlay');
  if (previousOverlay) {previousOverlay.remove();}
  renderSelectionOverlay();
}

function nodeChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function normalizeSceneNode(node, fallbackOperationLayerId = '') {
  if (!node || typeof node !== 'object') {return null;}
  const children = nodeChildren(node)
    .map((child) => normalizeSceneNode(child, fallbackOperationLayerId))
    .filter(Boolean);
  const sourceBounds = normalizeSourceBounds(node.sourceBounds);
  const markup = typeof node.markup === 'string' ? node.markup : '';
  if (!markup && !children.length) {return null;}
  const operationLayerId = typeof node.operationLayerId === 'string'
    ? node.operationLayerId // allow "" to mean "inherit"
    : fallbackOperationLayerId;
  return {
    id: typeof node.id === 'string' && node.id ? node.id : crypto.randomUUID(),
    name: typeof node.name === 'string' && node.name ? node.name : 'Imported Object',
    type: typeof node.type === 'string' && node.type ? node.type : (children.length ? 'group' : 'path'),
    markup,
    x: numericOr(node.x, 0),
    y: numericOr(node.y, 0),
    scaleX: Math.max(0.001, numericOr(node.scaleX ?? node.scale, 1)),
    scaleY: Math.max(0.001, numericOr(node.scaleY ?? node.scale, 1)),
    lockRatio: node.lockRatio !== undefined ? Boolean(node.lockRatio) : true,
    rotation: numericOr(node.rotation, 0),
    operationLayerId,
    isHole: Boolean(node.isHole),
    liveGeometry: node.liveGeometry && typeof node.liveGeometry === 'object' ? structuredClone(node.liveGeometry) : null,
    children,
    sourceBounds,
  };
}

function normalizeSceneNodes(nodes, fallbackOperationLayerId = '') {
  return (Array.isArray(nodes) ? nodes : [])
    .map((node) => normalizeSceneNode(node, fallbackOperationLayerId))
    .filter(Boolean);
}

function findNodeById(id, nodes = state.objects) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.id === id) {return node;}
    const child = findNodeById(id, nodeChildren(node));
    if (child) {return child;}
  }
  return null;
}

function findNodeContextById(
  id,
  nodes = state.objects,
  parentTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  inheritedOperationLayerId = '',
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
    if (nested) {return nested;}
  }
  return null;
}

function topLevelNodeForId(id) {
  return findNodeContextById(id)?.topLevelNode || null;
}

function findParentArray(id, nodes = state.objects) {
  const currentNodes = Array.isArray(nodes) ? nodes : [];
  // Check the current level FIRST to ensure we find the highest-level parent (e.g. top-level objects)
  if (currentNodes.some((node) => node.id === id)) {return currentNodes;}

  for (const node of currentNodes) {
    const children = nodeChildren(node);
    if (children.length > 0) {
      const nested = findParentArray(id, children);
      if (nested) {return nested;}
    }
  }
  return null;
}

function addOperationLayer() {
  const name = window.prompt('Operation name:', `Cut ${state.operationLayers.length + 1}`);
  if (!name) {return;}
  const op = createOperationLayer(name, defaultOperationColor(state.operationLayers.length));
  state.operationLayers.push(op);
  state.selectedOperationLayerId = op.id;
  state.activeRightTab = 'edit';
  render();
}

function moveOperationLayer(direction) {
  const index = state.operationLayers.findIndex((layer) => layer.id === state.selectedOperationLayerId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.operationLayers.length) {return;}
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
  const layerId = state.selectedOperationLayerId;
  const layer = operationLayerById(layerId);
  if (!layer) {return;}
  mutator(layer);
  state.selectedOperationLayerId = layer.id;
  render();
}

function operationLayerById(id) {
  return state.operationLayers.find((layer) => layer.id === id) || null;
}

function resolveOperationLayerId(explicitOperationLayerId, inheritedOperationLayerId = '') {
  return explicitOperationLayerId || inheritedOperationLayerId || state.operationLayers[0]?.id || '';
}

function effectiveOperationLayerForNodeId(id) {
  const context = findNodeContextById(id);
  if (!context) {return null;}
  return {
    direct: context.direct,
    operationLayerId: context.effectiveOperationLayerId,
    operationLayer: operationLayerById(context.effectiveOperationLayerId) || state.operationLayers[0] || null,
  };
}

function effectiveOperationLayerForNode(node) {
  return node ? effectiveOperationLayerForNodeId(node.id) : null;
}

function collectEffectiveOperationLayerIds(node, inheritedOperationLayerId = '') {
  const effectiveOperationLayerId = resolveOperationLayerId(node.operationLayerId, inheritedOperationLayerId);
  const children = nodeChildren(node);
  if (!children.length) {return effectiveOperationLayerId ? [effectiveOperationLayerId] : [];}
  return dedupeStrings(children.flatMap((child) => collectEffectiveOperationLayerIds(child, effectiveOperationLayerId)));
}

function assignSelectedObjectsToOperation(operationLayerId) {
  if (!operationLayerId) {return;}
  selectedObjects().forEach((node) => applyOperationToNode(node, operationLayerId));
  state.selectedOperationLayerId = operationLayerId;
  render();
}

function applyOperationToNode(node, operationLayerId) {
  node.operationLayerId = operationLayerId;
}

function groupSelection() {
  const selectedNodes = selectedObjects();
  const selectionIds = selectedNodes.map(n => n.id);

  if (selectionIds.length < 2) {
    setStatus('Select at least two objects to group.');
    return;
  }
  const parentArrays = [...new Set(selectionIds.map((id) => findParentArray(id)))];
  if (parentArrays.length !== 1 || parentArrays[0] === null) {
    setStatus('Only sibling objects can be grouped in one action.');
    return;
  }
  const parentArray = parentArrays[0];
  const selected = parentArray.filter((node) => selectionIds.includes(node.id));
  if (selected.length < 2) {
    setStatus('Select at least two objects to group.');
    return;
  }
  const insertionIndex = parentArray.findIndex((node) => node.id === selected[0].id);
  const group = {
    id: crypto.randomUUID(),
    name: `Group ${selected[0].name}`,
    type: 'group',
    markup: '',
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    lockRatio: true,
    rotation: 0,
    operationLayerId: selected[0].operationLayerId || '',
    children: selected.map(s => {
      const clone = structuredClone(s);
      // If we are grouping nested children, we must preserve their inherited op layers
      return clone;
    }),
    sourceBounds: unionBounds(selected.map((node) => objectWorldBounds(node))),
  };
  const remaining = parentArray.filter((node) => !selectionIds.includes(node.id));
  remaining.splice(insertionIndex, 0, group);
  replaceArrayContents(parentArray, remaining);
  state.selectedObjectIds = [group.id];
  render();
}

function ungroupSelection() {
  // Use selectedWorkspaceObjects so top-level nodes are always found correctly
  const candidates = selectedWorkspaceObjects().length
    ? selectedWorkspaceObjects()
    : state.objects.slice(); // fall back to all top-level objects
  const groups = candidates.filter((node) => nodeChildren(node).length);
  if (!groups.length) {
    setStatus('No grouped objects to ungroup.');
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
  setStatus(`Ungrouped selection into ${promotedIds.length} editable part${promotedIds.length === 1 ? '' : 's'}.`);
}

function flattenChildTransform(group, child) {
  child.x = group.x + child.x * (group.scaleX ?? group.scale ?? 1);
  child.y = group.y + child.y * (group.scaleY ?? group.scale ?? 1);
  child.scaleX = (child.scaleX ?? child.scale ?? 1) * (group.scaleX ?? group.scale ?? 1);
  child.scaleY = (child.scaleY ?? child.scale ?? 1) * (group.scaleY ?? group.scale ?? 1);
  child.rotation += group.rotation;
  return child;
}

function explodeGroupNode(group) {
  return nodeChildren(group).map((child) => {
    const promoted = flattenChildTransform(group, structuredClone(child));
    // Guarantee a valid, unique ID — child SVG nodes may not have one
    if (!promoted.id) {promoted.id = crypto.randomUUID();}
    return promoted;
  });
}

// Recursively collapse all groups to leaf nodes in one step
function flattenAllGroups() {
  const targets = selectedWorkspaceObjects().length
    ? selectedWorkspaceObjects()
    : state.objects.slice();

  // Recursive function: collect all leaf nodes with merged transforms
  function collectLeaves(node, parentX = 0, parentY = 0, parentScaleX = 1, parentScaleY = 1, parentRotation = 0) {
    const nx = node.x ?? 0;
    const ny = node.y ?? 0;
    const nsX = node.scaleX ?? node.scale ?? 1;
    const nsY = node.scaleY ?? node.scale ?? 1;
    const nr = node.rotation ?? 0;

    const cx = parentX + nx * parentScaleX;
    const cy = parentY + ny * parentScaleY;
    const csX = nsX * parentScaleX;
    const csY = nsY * parentScaleY;
    const cr = nr + parentRotation;
    const children = nodeChildren(node);
    if (children.length === 0) {
      const leaf = structuredClone(node);
      leaf.x = cx; leaf.y = cy; leaf.scaleX = csX; leaf.scaleY = csY; leaf.rotation = cr;
      if (!leaf.id) {leaf.id = crypto.randomUUID();}
      return [leaf];
    }
    return children.flatMap((child) => collectLeaves(child, cx, cy, csX, csY, cr));
  }

  const leaves = targets.flatMap((node) => collectLeaves(node));
  if (!leaves.length) {return setStatus('Nothing to flatten.');}

  // Remove original targets from their parents (wherever they are)
  const targetIds = new Set(targets.map((n) => n.id));
  
  function removeTargetsFromNode(node) {
    if (node.children) {
      node.children = node.children.filter(child => !targetIds.has(child.id));
      node.children.forEach(removeTargetsFromNode);
    }
  }

  // Remove from top-level
  state.objects = state.objects.filter((n) => !targetIds.has(n.id));
  // Remove from all groups
  state.objects.forEach(removeTargetsFromNode);
  
  // Insert flattened leaves at top level
  state.objects = [...state.objects, ...leaves];
  state.selectedObjectIds = leaves.map((l) => l.id);
  render();
  setStatus(`Flattened to ${leaves.length} individual shape${leaves.length !== 1 ? 's' : ''}.`);
}

function centerSelectionOnBed() {
  const nodes = selectedWorkspaceObjectsOrAll();
  const bounds = selectionBounds(nodes);
  if (!bounds) {return setStatus('Import or select objects to center.');}
  const dx = (state.machine.bedWidth - bounds.width) / 2 - bounds.x;
  const dy = (state.machine.bedHeight - bounds.height) / 2 - bounds.y;
  nodes.forEach((node) => { node.x = snap(node.x + dx); node.y = snap(node.y + dy); });
  render();
  setStatus('Selection centered on bed.');
}

function homeSelectionOnBed() {
  const nodes = selectedWorkspaceObjectsOrAll();
  const bounds = selectionBounds(nodes);
  if (!bounds) {return setStatus('Import or select objects to home.');}
  const dx = -bounds.x;
  const dy = state.machine.originMode === 'lower-left'
    ? state.machine.bedHeight - (bounds.y + bounds.height)
    : -bounds.y;
  nodes.forEach((node) => {
    node.x = snap(node.x + dx);
    node.y = snap(node.y + dy);
  });
  render();
  setStatus(state.machine.originMode === 'lower-left'
    ? 'Selection moved to machine home at the lower-left corner.'
    : 'Selection moved to machine home at the upper-left corner.');
}

function duplicateSelection() {
  if (!state.selectedObjectIds.length) {return setStatus('Select objects to duplicate.');}
  const clones = state.selectedObjectIds
    .map((id) => findNodeById(id))
    .filter(Boolean)
    .map((node) => {
      const clone = structuredClone(node);
      const reassignIds = (n) => {
        n.id = crypto.randomUUID();
        if (Array.isArray(n.children)) {n.children.forEach(reassignIds);}
      };
      reassignIds(clone);
      offsetNode(clone, 10, 10);
      return clone;
    });
  if (!clones.length) {return setStatus('Select objects to duplicate.');}
  // Always push to the same parent array as the originals
  const parentArray = findParentArray(state.selectedObjectIds[0]) || state.objects;
  parentArray.push(...clones);
  state.selectedObjectIds = clones.map((c) => c.id);
  render();
  setStatus(`Duplicated ${clones.length} object${clones.length !== 1 ? 's' : ''}.`);
}

function makeArrayFromSelection() {
  const items = selectedObjects();
  if (!items.length) {return setStatus('Select objects to array.');}
  const bounds = selectionBounds();
  const parentArray = findParentArray(state.selectedObjectIds[0]);
  const clones = [];
  for (let row = 0; row < state.machine.arrayRows; row += 1) {
    for (let col = 0; col < state.machine.arrayCols; col += 1) {
      if (row === 0 && col === 0) {continue;}
      items.forEach((node) => clones.push(offsetNode(structuredClone(node), col * (bounds.width + state.machine.arrayGapX), row * (bounds.height + state.machine.arrayGapY))));
    }
  }
  parentArray.push(...clones);
  render();
}

function deleteSelection() {
  if (!state.selectedObjectIds.length) {return setStatus('Select objects to delete.');}
  state.selectedObjectIds.forEach((id) => {
    const parentArray = findParentArray(id);
    const index = parentArray.findIndex((node) => node.id === id);
    if (index >= 0) {parentArray.splice(index, 1);}
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

async function updateGcodePreview() {
  const gcode = await generateGcode({ previewOnly: true });
  state.generatedGcode = gcode;
  elements.gcodePreview.value = gcode.split('\n').slice(0, 220).join('\n');
}

async function collectOperationPolylines() {
  const operations = [];
  for (const operationLayer of state.operationLayers) {
    // Collect all leaf polylines and flag them if they are holes
    const leafEntries = collectLeafEntries(state.objects)
      .filter((entry) => entry.operationLayer.id === operationLayer.id);

    const rawPolylines = [];
    const rasterGcodeBlocks = [];

    for (const entry of leafEntries) {
      if (entry.node.type === 'image') {
        try {
          const img = await loadImageFromFile(await (await fetch(entry.node.src)).blob());
          // Determine world bounds.
          const worldBounds = objectWorldBounds(entry.node, entry.parentTransform || { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
          const brightness = entry.node.brightness || 0;
          const contrast = (entry.node.contrast ?? 100) / 100;
          const dithered = ditherImageAtkinson(img, entry.node.sourceBounds, worldBounds, entry.transform, 254, contrast, brightness);
          const gcode = generateRasterGcode(dithered, worldBounds, operationLayer);
          rasterGcodeBlocks.push(...gcode);
        } catch (e) {
          console.warn('Failed to generate raster G-code for image', e);
        }
      } else {
        const polyData = extractLeafGeometry(entry.node, entry.transform, operationLayer);
        rawPolylines.push(...polyData.map(p => ({ points: p, isHole: entry.isHole })));
      }
    }

    // Sort: Holes first (Inside-Out cutting rule)
    rawPolylines.sort((a, b) => (a.isHole === b.isHole ? 0 : a.isHole ? -1 : 1));

    // Optimize: Strip metadata for core optimize call
    const holes = rawPolylines.filter(p => p.isHole).map(p => p.points);
    const solids = rawPolylines.filter(p => !p.isHole).map(p => p.points);
    
    const optHoles = optimizePolylines(holes, {
      joinTolerance: Math.max(0.05, state.machine.sampleStep * 0.75),
      simplifyTolerance: 0.001,
    });
    const optSolids = optimizePolylines(solids, {
      joinTolerance: Math.max(0.05, state.machine.sampleStep * 0.75),
      simplifyTolerance: 0.001,
    });

    operations.push({ 
      operationLayer, 
      polylines: [...optHoles, ...optSolids],
      rasterGcode: rasterGcodeBlocks
    });
  }
  return operations;
}

async function generateGcode({ previewOnly = false } = {}) {
  const operations = await collectOperationPolylines();
  return buildGcodeFromPolylines({
    machine: state.machine,
    operationLayers: state.operationLayers,
    operations,
    previewOnly,
  });
}

function collectLeafEntries(nodes, parentTransform = { x: 0, y: 0, scale: 1, rotation: 0 }, results = [], inheritedOperationLayerId = '') {
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
        isHole: Boolean(node.isHole),
        operationLayer: operationLayerById(effectiveOperationLayerId) || state.operationLayers[0],
      });
    }
  });
  return results;
}

function extractLeafGeometry(node, transform, operationLayer) {
  elements.measurementRoot.innerHTML = '';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${state.artworkViewBox.width} ${state.artworkViewBox.height}`);
  const wrapper = document.createElementNS(SVG_NS, 'g');
  appendSvgMarkup(svg, state.sourceDefsMarkup);
  appendSvgMarkup(wrapper, node.markup);
  svg.appendChild(wrapper);
  elements.measurementRoot.appendChild(svg);

  // Convert <text> elements into <path> outlines for toolpaths.
  // This is synchronous once the font is loaded (export/burn will await the font).
  if (wrapper.querySelector('text') && textToPathFont) {
    convertTextElementsToPaths(wrapper, textToPathFont);
  }

  const shapes = [];
  collectGeometryNodes(wrapper, shapes);
  return shapes.flatMap((shape) => sampleShape(shape, node, transform, operationLayer)).filter((polyline) => polyline.length > 1);
}

function collectGeometryNodes(node, shapes) {
  [...node.children].forEach((child) => {
    if (child instanceof SVGGeometryElement) {shapes.push(child);}
    if (child.children.length) {collectGeometryNodes(child, shapes);}
  });
}

function sampleShape(shape, node, transform, operationLayer) {
  function sampleOutlineSegments() {
    // Fast outline for axis-aligned plain rects.
    if (shape.tagName?.toLowerCase?.() === 'rect') {
      const rectRx = Number(shape.getAttribute?.('rx') ?? 0) || 0;
      const rectRy = Number(shape.getAttribute?.('ry') ?? 0) || 0;
      if (rectRx <= 0 && rectRy <= 0) {
        const bbox = shape.getBBox();
        const corners = [
          [bbox.x, bbox.y],
          [bbox.x + bbox.width, bbox.y],
          [bbox.x + bbox.width, bbox.y + bbox.height],
          [bbox.x, bbox.y + bbox.height],
          [bbox.x, bbox.y],
        ].map(([x, y]) => transformPointByTransform(x, y, node.sourceBounds, transform));
        return [dedupePolyline(corners)];
      }
    }

    // Generic outline sampling for SVGGeometryElements.
    const total = shape.getTotalLength?.();
    if (!total || !Number.isFinite(total)) {return [];}
    
    // Use an absolute scale approximation to check physical gaps.
    const s = Math.max(Math.abs(transform.scaleX || transform.scale || 0.0001), Math.abs(transform.scaleY || transform.scale || 0.0001));
    const step = Math.max(state.machine.sampleStep / s, 0.25);
    
    const segments = [];
    let currentPolyline = [];
    let lastPoint = null;

    for (let distance = 0; distance <= total; distance += step) {
      const point = shape.getPointAtLength(Math.min(distance, total));
      const tp = transformPointByTransform(point.x, point.y, node.sourceBounds, transform);
      
      if (lastPoint && currentPolyline.length > 0) {
        const gap = Math.hypot(tp.x - lastPoint.x, tp.y - lastPoint.y);
        // If the straight-line jump is substantially larger than the arc step distance,
        // we've crossed an invisible Move command between subpaths. Break the line here.
        if (gap > (step * s) * 1.5) {
          if (currentPolyline.length > 1) {segments.push(dedupePolyline(currentPolyline));}
          currentPolyline = [];
        }
      }
      currentPolyline.push(tp);
      lastPoint = tp;
    }
    const end = shape.getPointAtLength(total);
    const endTp = transformPointByTransform(end.x, end.y, node.sourceBounds, transform);
    if (lastPoint && currentPolyline.length > 0) {
      const gap = Math.hypot(endTp.x - lastPoint.x, endTp.y - lastPoint.y);
      if (gap > (step * s) * 1.5) {
        if (currentPolyline.length > 1) {segments.push(dedupePolyline(currentPolyline));}
        currentPolyline = [];
      }
    }
    currentPolyline.push(endTp);
    if (currentPolyline.length > 1) {segments.push(dedupePolyline(currentPolyline));}
    return segments;
  }

  if (operationLayer.mode === 'fill') {
    const bbox = shape.getBBox();
    // Hatch spacing: use a standard solid engraving interval (0.1mm = 10 lines per mm)
    // so the laser dot overlaps and produces a uniformly solid filled shape.
    // Do not use state.machine.sampleStep here, as that is for vector curve smoothing.
    const hatchStep = operationLayer.hatchStep || 0.1;
    const segments = [];

    // Add a boundary pass first for cleaner fills.
    const outlines = sampleOutlineSegments();
    outlines.forEach(outline => {
      if (outline && outline.length > 1) {segments.push(outline);}
    });

    // For plain rectangles, generate exact-width scanlines so the fill matches the
    // rectangle geometry (no "sampling grid" artifacts on small 1x1 modules).
    if (shape.tagName?.toLowerCase() === 'rect') {
      const rectRx = Number(shape.getAttribute?.('rx') ?? 0) || 0;
      const rectRy = Number(shape.getAttribute?.('ry') ?? 0) || 0;
      if (rectRx <= 0 && rectRy <= 0) {
        // Ensure even tiny rectangles (e.g. 1x1 QR modules) get multiple hatch lines.
        const rectStep = Math.min(hatchStep, Math.max(0.05, bbox.height / 4));
        for (let y = bbox.y; y <= bbox.y + bbox.height; y += rectStep) {
          const p1 = transformPointByTransform(bbox.x, y, node.sourceBounds, transform);
          const p2 = transformPointByTransform(bbox.x + bbox.width, y, node.sourceBounds, transform);
          const segment = (Math.round((y - bbox.y) / rectStep) % 2 === 1) ? [p2, p1] : [p1, p2];
          segments.push(dedupePolyline(segment));
        }
        return segments.filter((polyline) => polyline.length > 1);
      }
    }

    if (typeof shape.isPointInFill !== 'function') {return segments;}
    
    // Adaptive sampling for general shapes (e.g. rounded modules, paths, or imported DXF fills).
    // We use a high-resolution, fixed horizontal ray cast step (0.05mm) to accurately detect boundaries of
    // tiny inner features (like QR modules or text serifs) that might otherwise slip between coarse steps.
    const fillSampleStep = 0.05;
    
    for (let y = bbox.y; y <= bbox.y + bbox.height; y += hatchStep) {
      let activeX = [];
      const samples = [];
      for (let x = bbox.x; x <= bbox.x + bbox.width; x += fillSampleStep) {samples.push(x);}
      
      const reversePass = Math.round((y - bbox.y) / hatchStep) % 2 === 1;
      if (reversePass) {samples.reverse();}
      
      samples.forEach((x) => {
        if (shape.isPointInFill(createSvgPoint(x, y))) {
          activeX.push(x);
        } else if (activeX.length) {
          const x1 = activeX[0];
          const x2 = activeX.length > 1 ? activeX[activeX.length - 1] : (reversePass ? x1 - 0.02 : x1 + 0.02);
          const pt1 = transformPointByTransform(x1, y, node.sourceBounds, transform);
          const pt2 = transformPointByTransform(x2, y, node.sourceBounds, transform);
          segments.push([pt1, pt2]);
          activeX = [];
        }
      });
      if (activeX.length) {
        const x1 = activeX[0];
        const x2 = activeX.length > 1 ? activeX[activeX.length - 1] : (reversePass ? x1 - 0.02 : x1 + 0.02);
        const pt1 = transformPointByTransform(x1, y, node.sourceBounds, transform);
        const pt2 = transformPointByTransform(x2, y, node.sourceBounds, transform);
        segments.push([pt1, pt2]);
      }
    }
    return segments;
  }

  // Not a fill: return the outline segments directly.
  return sampleOutlineSegments();
}

async function exportGcode() {
  try {
    await ensureTextToPathReady();
  } catch (error) {
    // Continue without text-to-path if font fails to load.
    pushDeviceActivity?.('warn', 'Font load failed', error?.message || String(error));
  }
  const gcode = await generateGcode();
  if (gcode.startsWith('; No enabled')) {return setStatus('No enabled geometry to export.');}
  downloadText(preferredJobFilename(), gcode);
  setStatus('Exported G-code.');
}

function exportFrameGcode() {
  const bounds = selectionBounds();
  if (!bounds) {return setStatus('Select objects to generate a frame.');}
  downloadText(preferredJobFilename(`${stripExtension(state.documentName) || 'lumaburn-job'}-frame`), `${buildFrameLines(bounds, state.machine).join('\n')}\n`);
  setStatus('Generated framing G-code.');
}

async function renderStats() {
  const operations = await collectOperationPolylines();
  const estimate = estimateJobFromPolylines({
    machine: state.machine,
    operationLayers: state.operationLayers,
    operations: operations,
  });
  elements.statEnabled.textContent = String(estimate.enabledLayers);
  elements.statCutDistance.textContent = `${formatCompact(estimate.cutDistance)} mm`;
  elements.statTravelDistance.textContent = `${formatCompact(estimate.travelDistance)} mm`;
  elements.statRuntime.textContent = formatDuration(estimate.runtimeSeconds);
}

function deviceStorageCandidates() {
  return dedupeStrings([state.device.browsePath || '/', '/ext/', '/sd/', state.device.storageMode === 'direct' ? '/' : '', '/']);
}

function deviceUploadCandidates() {
  return dedupeStrings([state.device.uploadPath || '/', '/ext/', state.device.browsePath || '/', '/sd/', state.device.storageMode === 'direct' ? '/' : '', '/']);
}

function preferredJobExtension() {
  return state.machine.presetId === 'longer-ray5-20w' ? '.gc' : '.gcode';
}

function preferredJobFilename(baseName = stripExtension(state.documentName) || 'lumaburn-job') {
  return `${baseName}${preferredJobExtension()}`;
}

function controllerRunFlavor() {
  return state.machine.presetId === 'longer-ray5-20w' ? 'grbl-embedded' : '';
}

function controllerCanAutostartJobs() {
  return controllerRunFlavor() === 'grbl-embedded' || canUseControllerFileRun(state.device);
}

function isJobStorageFile(file) {
  const name = String(file?.name || file?.shortname || '').trim().toLowerCase();
  return ['.gc', '.gcode', '.nc', '.lbrn', '.lbrn2'].some((suffix) => name.endsWith(suffix));
}

function parseStorageSizeLabel(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) {return 0;}
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {return 0;}
  const unit = match[2].toUpperCase();
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] || 1;
  return amount * scale;
}

function isLikelyInternalFlashListing(listing) {
  const files = Array.isArray(listing?.files) ? listing.files : [];
  const totalBytes = parseStorageSizeLabel(listing?.total);
  if (files.some(isJobStorageFile)) {return false;}

  const hasWebFiles = files.some(file => {
    const ext = String(file?.name || file?.shortname || '').split('.').pop().toLowerCase();
    return ['html', 'htm', 'js', 'css'].includes(ext);
  });

  return String(listing?.path || '') === '/'
    && totalBytes > 0
    && totalBytes <= 32 * 1024 * 1024
    && hasWebFiles;
}

function shouldPreserveCurrentDirectListing(nextListing) {
  return state.device.storageMode.toLowerCase() === 'direct'
    && state.device.files.some(isJobStorageFile)
    && isLikelyInternalFlashListing(nextListing);
}

function scoreDeviceListing(listing, requestedPath = '') {
  if (!listing || listing.status !== 'Ok') {return Number.NEGATIVE_INFINITY;}
  const files = Array.isArray(listing.files) ? listing.files : [];
  const jobFiles = files.filter(isJobStorageFile).length;
  const internalFlashPenalty = isLikelyInternalFlashListing(listing) ? -1000 : 0;
  const directBonus = String(listing.mode || '').toLowerCase() === 'direct' ? 400 : 0;
  const rootBonus = String(listing.path || '') === '/' ? 60 : 0;
  const requestedMatchBonus = String(listing.path || '') === String(requestedPath || '') ? 20 : 0;
  const fileCountBonus = Math.min(files.length, 200);
  const jobFileBonus = jobFiles * 50;
  const sizeBonus = Math.min(parseStorageSizeLabel(listing.total) / (1024 ** 3), 16) * 10;
  return internalFlashPenalty + directBonus + rootBonus + requestedMatchBonus + fileCountBonus + jobFileBonus + sizeBonus;
}

function chooseBestDeviceListing(listings) {
  return (Array.isArray(listings) ? listings : [])
    .filter((entry) => entry?.payload?.status === 'Ok')
    .sort((a, b) => scoreDeviceListing(b.payload, b.requestedPath) - scoreDeviceListing(a.payload, a.requestedPath))[0]?.payload || null;
}

function applyDeviceListing(listing) {
  const resolvedBrowsePath = listing.path || state.device.browsePath || '/';
  state.device.browsePath = resolvedBrowsePath;
  state.device.uploadPath = resolvedBrowsePath;
  
  state.device.storageMode = String(listing.mode || state.device.storageMode || '');
  state.device.files = Array.isArray(listing.files) ? listing.files : [];
  state.device.lastFileSummary = `${state.device.files.length} file${state.device.files.length === 1 ? '' : 's'} on ${state.device.browsePath} · uploads via ${state.device.uploadPath} · ${listing.used || '?'} used of ${listing.total || '?'}`;

  // If we have an active device profile, persist these working paths immediately
  if (state.selectedDeviceProfileId) {
    saveDeviceProfile();
  }
}

function pushDeviceActivity(level, message, detail = '') {
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.device.activityLog = [{ level, message, detail, time: timestamp }, ...state.device.activityLog].slice(0, DEVICE_ACTIVITY_LIMIT);
  renderDeviceActivity();
}

function reportDeviceError(action, error) {
  const detail = error instanceof Error ? error.message : String(error);
  pushDeviceActivity('error', `${action} failed`, detail);
  setDeviceState('Error', detail);
  setStatus(`${action} failed.`);
}

async function deviceFetch(pathname, options = {}) {
  if (!state.device.url) {throw new Error('Set a controller URL first.');}

  let url;
  if (state.device.bridgeActive) {
    url = new URL(`/device${pathname}`, window.location.origin);
    url.searchParams.set('target', state.device.url);
  } else {
    // Manual Mode: Talk directly to target (subject to browser CORS)
    const base = state.device.url.includes('://') ? state.device.url : `http://${state.device.url}`;
    try {
      let finalPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
      
      // Translate Proxy-style commands to Native FluidNC/ESP32-Grbl commands
      if (finalPath.startsWith('/command')) {
        const urlObj = new URL(finalPath, 'http://temp.internal');
        const commandText = urlObj.searchParams.get('commandText');
        if (commandText) {
          finalPath = `/command?args=${encodeURIComponent(commandText)}`;
        }
      }
      
      url = new URL(finalPath, base);
    } catch (ignore) { // eslint-disable-line no-unused-vars
      throw new Error(`Invalid controller URL: ${state.device.url}`);
    }
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DEFAULT_DEVICE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
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
  // If no text, and HTTP status was OK, we treat it as a success unless strictly requirePositive with text
  if (!text) {
    if (requirePositive) {
      // For starting jobs, an empty 200 OK is often better than failing.
      return { text: '', inspection: { ok: true, confidence: 'medium', summary: 'Empty success' } };
    }
    return { text, inspection };
  }
  if (!inspection.ok && (requirePositive || inspection.confidence !== 'low')) {
    throw new Error(`${action}: ${inspection.summary}`.slice(0, 280));
  }
  return { text, inspection };
}

async function refreshDeviceFiles() {
  try {
    pushDeviceActivity('info', 'Loading controller files', state.device.url || 'No controller URL set.');
    setDeviceState('Connecting', `Listing files from ${state.device.url}...`);
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
    if (!payload) {throw new Error('The controller did not return a readable file listing.');}
    if (shouldPreserveCurrentDirectListing(payload)) {
      setDeviceState('Connected', 'Keeping direct-storage file list from the last verified upload.');
      pushDeviceActivity('warn', 'Ignored internal flash listing', 'The controller returned its web UI filesystem instead of the job storage list.');
      render();
      setStatus('Kept the direct-storage file list instead of the controller web UI filesystem.');
      return;
    }
    applyDeviceListing(payload);
    setDeviceState('Connected', `${payload.status || 'Ok'} · ${payload.used || '?'} used of ${payload.total || '?'} on ${state.device.browsePath}`);
    pushDeviceActivity('info', 'Controller file list loaded', state.device.lastFileSummary);
    render();
    setStatus(`Loaded ${state.device.files.length} device file${state.device.files.length === 1 ? '' : 's'} from ${state.device.browsePath}.`);
  } catch (error) {
    state.device.lastFileSummary = 'Unable to load files from device storage.';
    reportDeviceError('Load device files', error);
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
    if (!subnets.length) {throw new Error('No local subnet detected. Enter a manual IP or a custom scan range.');}
    state.device.discoveryLog = [];
    pushDeviceActivity('info', 'Starting network scan', `Scanning ${subnets.length} candidate subnet${subnets.length === 1 ? '' : 's'}.`);
    setDeviceState('Scanning', `Scanning ${subnets.length} likely subnet${subnets.length === 1 ? '' : 's'} for a controller.`);
    const response = await fetch(`/discover-many?subnets=${encodeURIComponent(subnets.join(','))}`);
    if (!response.ok) {throw new Error(`Network scan failed (${response.status}).`);}
    const payload = await response.json();
    state.device.discoveryLog = subnets.map((subnet) => `Scanned ${subnet}.0/24`);
    const [first] = payload.devices || [];
    if (first?.url) {
      state.device.url = normalizeDeviceUrl(first.url);
      state.device.friendlyName = first.title || 'Laser Controller';
      state.device.enabled = true;
      pushDeviceActivity('info', 'Controller discovered', `${state.device.friendlyName} at ${first.url}`);
      setDeviceState('Found', `Discovered ${state.device.friendlyName} at ${first.url}`);
      render();
      await refreshDeviceFiles();
      return;
    }
    setDeviceState('Generator Only', 'No controller found automatically. Enter a manual IP/friendly name or another scan range.');
    pushDeviceActivity('warn', 'No controller discovered', `Scanned ${subnets.length} candidate subnet${subnets.length === 1 ? '' : 's'}.`);
  } catch (error) {
    reportDeviceError('Network scan', error);
  }
}

async function sendManualDeviceCommand(command) {
  if (!command) {return setStatus('Enter a command first.');}
  try {
    pushDeviceActivity('info', 'Sending command', command);
    setDeviceState('Sending', `Command: ${command}`);
    await readDeviceResponseText(await deviceFetch(`/command?commandText=${encodeURIComponent(command)}`), 'Manual command');
    elements.deviceCommand.value = '';
    setDeviceState('Connected', `Last command sent: ${command}`);
    setStatus(`Sent command: ${command}`);
    pushDeviceActivity('info', 'Command sent', command);
  } catch (error) {
    reportDeviceError('Manual command', error);
  }
}

async function stopDeviceJob() {
  try {
    state.device.stopRequested = true;
    state.device.streaming = false;
    pushDeviceActivity('warn', 'Stopping device job', 'Issuing an emergency hold, laser-off, and reset burst while cancelling any local queued stream.');
    setDeviceState('Stopping', 'Issuing emergency stop commands and cancelling local streaming.');
    const { inspection } = await readDeviceResponseText(
      await deviceFetch('/stop'),
      'Stop job',
      { requirePositive: true },
    );
    const plan = inspection.data || { label: 'Emergency stop burst', partial: false };
    setDeviceState('Connected', 'Stop command sent to controller.');
    const detail = plan.partial ? `${plan.label} (with fallback errors)` : plan.label;
    setStatus(plan.partial ? 'Emergency stop sent with warnings.' : 'Emergency stop sent.');
    pushDeviceActivity(plan.partial ? 'warn' : 'info', 'Stop command sent', detail);
  } catch (error) {
    reportDeviceError('Stop job', error);
  }
}

async function uploadCurrentJobToDevice() {
  try { await ensureTextToPathReady(); } catch (error) { /* eslint-disable-line no-unused-vars */ }
  const gcode = await generateGcode();
  if (gcode.startsWith('; No enabled')) {return setStatus('No enabled geometry to upload.');}
  try {
    const filename = preferredJobFilename();
    await uploadGcodeToDevice(filename, gcode);
    setStatus(`Uploaded ${filename} to the controller.`);
    pushDeviceActivity('info', 'G-code uploaded', filename);
    if (state.device.storageMode.toLowerCase() !== 'direct') {
      await refreshDeviceFiles();
    } else {
      render();
    }
  } catch (error) {
    reportDeviceError('Upload G-code', error);
  }
}

async function streamCurrentJobToDevice() {
  try { await ensureTextToPathReady(); } catch (error) { /* eslint-disable-line no-unused-vars */ }
  const gcode = await generateGcode();
  if (gcode.startsWith('; No enabled')) {return setStatus('No enabled geometry to run.');}
  const filename = preferredJobFilename();
  try {
    state.device.streaming = true;
    state.device.stopRequested = false;
    pushDeviceActivity('info', 'Preparing device job', filename);
    await uploadGcodeToDevice(filename, gcode, false);
    if (!controllerCanAutostartJobs()) {
      state.device.streaming = false;
      setDeviceState('Uploaded', `Uploaded ${filename} to controller storage. Start it directly on the controller.`);
      setStatus(`Uploaded ${filename} to controller storage. Start it directly on the controller.`);
      pushDeviceActivity('warn', 'Upload-only controller mode', `Uploaded ${filename}. This controller reports direct root storage, so the app will not attempt an unsafe remote start.`);
      render();
      return;
    }
    const fullPath = normalizeDevicePath(state.device.uploadPath, filename);
    let startedByFileCommand = false;
    for (const command of buildRunFileCommands(fullPath, { controllerFlavor: controllerRunFlavor() })) {
      setDeviceState('Starting', `Attempting controller-side start: ${command}`);
      try {
        const result = await readDeviceResponseText(
          await deviceFetch(`/command?commandText=${encodeURIComponent(command)}`),
          'Controller-side stream start',
          { requirePositive: false } // Relax check: some controllers just start without returning JSON
        );
        pushDeviceActivity('info', 'Controller-side stream started', result.inspection.summary || command);
        startedByFileCommand = true;
        break;
      } catch (error) {
        pushDeviceActivity('warn', 'Controller-side start attempt failed', error.message);
      }
    }

    if (!startedByFileCommand) {
      state.device.streaming = false;
      await refreshDeviceFiles().catch(() => {});
      throw new Error(`Uploaded ${filename} to ${fullPath}, but the controller did not acknowledge starting it. Start it directly from the controller. Browser-side fallback streaming is disabled for safety.`);
    }

    state.device.streaming = false;
    setDeviceState('Running', `Controller is running ${filename} from device storage.`);
    setStatus(`Started ${filename} from device storage.`);
    pushDeviceActivity('info', 'Controller-run job started', `${filename} on ${fullPath}`);
    await refreshDeviceFiles();
  } catch (error) {
    state.device.streaming = false;
    reportDeviceError('Stream job', error);
  }
}

async function streamFrameToDevice() {
  const bounds = selectionBounds();
  if (!bounds) {return setStatus('Select objects to stream a frame.');}
  await streamLinesToDevice(buildFrameLines(bounds, state.machine), 'frame');
}

async function streamLinesToDevice(lines, label) {
  try {
    state.device.streaming = true;
    state.device.stopRequested = false;
    const commands = lines.filter(Boolean);
    if (!commands.length) {throw new Error(`No ${label} lines were generated.`);}
    pushDeviceActivity('info', `Streaming ${label}`, `${commands.length} command line${commands.length === 1 ? '' : 's'} queued.`);
    setDeviceState('Streaming', `Sending ${label} to ${state.device.url}`);
    let transportMode = null;
    for (let index = 0; index < commands.length; index += 1) {
      if (state.device.stopRequested) {
        state.device.streaming = false;
        setDeviceState('Stopped', `Stopped ${label} after ${index} of ${commands.length} lines.`);
        setStatus(`Stopped ${label} stream.`);
        pushDeviceActivity('warn', `${label.charAt(0).toUpperCase() + label.slice(1)} stream stopped`, `${index} of ${commands.length} lines were sent before stop was requested.`);
        return;
      }
      const line = commands[index];
      const variants = transportMode ? [transportMode === 'esp500' ? `[ESP500] ${line}` : line] : buildQueuedCommandVariants(line);
      let sent = false;
      let lastError = null;
      for (const variant of variants) {
        try {
          await readDeviceResponseText(
            await deviceFetch(`/command?commandText=${encodeURIComponent(variant)}`),
            `Stream ${label} line ${index + 1}`
          );
          transportMode = variant.startsWith('[ESP500]') ? 'esp500' : 'raw';
          sent = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sent) {throw lastError || new Error(`Unable to send ${label} line ${index + 1}.`);}
      if ((index + 1) % 20 === 0 || index === commands.length - 1) {
        setDeviceState('Streaming', `Sent ${index + 1} of ${commands.length} ${label} lines.`);
      }
      await delay(55);
    }
    state.device.streaming = false;
    state.device.stopRequested = false;
    setDeviceState('Connected', `Finished streaming ${label}.`);
    setStatus(`Streamed ${label} to the controller.`);
    pushDeviceActivity('info', `${label.charAt(0).toUpperCase() + label.slice(1)} stream completed`, `${commands.length} lines sent via ${transportMode || 'raw'} mode.`);
  } catch (error) {
    state.device.streaming = false;
    state.device.stopRequested = false;
    reportDeviceError(`Stream ${label}`, error);
  }
}

async function uploadGcodeToDevice(filename, gcode, updateStatus = true) {
  const blob = new Blob([gcode], { type: 'text/plain' });
  let lastError = null;
  for (const pathValue of deviceUploadCandidates()) {
    const formData = new FormData();
    formData.append('myfiles[]', blob, filename);
    formData.append('file', blob, filename);
    if (updateStatus) {setDeviceState('Uploading', `Uploading ${filename} to ${pathValue}`);}
    try {
      const response = await deviceFetch(`/upload?path=${encodeURIComponent(pathValue)}`, { method: 'POST', body: formData });
      const result = await readDeviceResponseText(response, 'Upload G-code');
      let listing = result.inspection?.data && Array.isArray(result.inspection.data.files)
        ? result.inspection.data
        : null;
      if (!deviceListingContainsFilename(listing, filename)) {
        listing = await verifyDeviceUpload(pathValue, filename);
      }
      if (!listing || !deviceListingContainsFilename(listing, filename)) {
        throw new Error(`Upload verification failed for ${pathValue}; ${filename} was not listed by the controller.`);
      }
      if (result.inspection?.data?.mode) {state.device.storageMode = String(result.inspection.data.mode);}
      if (listing?.mode) {state.device.storageMode = String(listing.mode);}
      applyDeviceListing({ ...listing, path: pathValue, mode: listing?.mode || state.device.storageMode });
      pushDeviceActivity('info', 'Upload target confirmed', pathValue);
      return listing;
    } catch (error) {
      lastError = error;
      pushDeviceActivity('warn', 'Upload target rejected', `${pathValue}: ${error.message}`);
    }
  }
  throw lastError || new Error('Unable to upload to any known controller path.');
}

function deviceListingContainsFilename(listing, filename) {
  return (Array.isArray(listing?.files) ? listing.files : []).some((file) => {
    const candidate = String(file?.name || file?.shortname || '').trim().toLowerCase();
    return candidate === filename.toLowerCase();
  });
}

async function verifyDeviceUpload(pathValue, filename) {
  const candidatePaths = dedupeStrings([pathValue, '/', state.device.browsePath || '/', state.device.uploadPath || '/']);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const candidatePath of candidatePaths) {
      try {
        const listing = await (await deviceFetch(`/files?action=list&path=${encodeURIComponent(candidatePath)}`)).json();
        if (listing?.status === 'Ok' && deviceListingContainsFilename(listing, filename)) {
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
  const target = event.target.closest('[data-device-action]');
  if (!target) {return;}
  const action = target.getAttribute('data-device-action');
  const filename = target.getAttribute('data-device-file');
  if (action === 'run') {await runDeviceFile(filename);}
  if (action === 'delete') {await deleteDeviceFile(filename);}
}

async function runDeviceFile(filename) {
  try {
    if (!controllerCanAutostartJobs()) {
      throw new Error('This controller path does not support safe autonomous file-run commands. Choose a storage-backed path such as /sd/ or /ext/.');
    }
    const fullPath = normalizeDevicePath(state.device.browsePath || state.device.uploadPath, filename);
    setDeviceState('Starting', `Requesting local run for ${filename}`);
    pushDeviceActivity('info', 'Starting device file', filename);
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
        pushDeviceActivity('warn', 'Run-file attempt failed', error.message);
      }
    }
    if (!started) {throw new Error(`The controller did not acknowledge starting ${filename}.`);}
    setStatus(`Requested local file run: ${filename}`);
    pushDeviceActivity('info', 'Device file start requested', filename);
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
    pushDeviceActivity('info', 'Device file deleted', filename);
    if (state.device.storageMode.toLowerCase() === 'direct' && state.device.files.length) {
      state.device.files = state.device.files.filter((file) => {
        const candidate = String(file?.name || file?.shortname || '').trim().toLowerCase();
        return candidate !== filename.toLowerCase();
      });
      state.device.lastFileSummary = `${state.device.files.length} file${state.device.files.length === 1 ? '' : 's'} on ${state.device.browsePath} · uploads via ${state.device.uploadPath || '/'} · direct storage cached`;
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
  if (!state.device.url || !state.device.streaming) {return;}
  state.device.stopRequested = true;
  try {
    fetch(`/device/stop?target=${encodeURIComponent(state.device.url)}`, {
      method: 'GET',
      keepalive: true,
      cache: 'no-store',
    }).catch(() => {});
  } catch {
    // Best-effort only.
  }
}

async function initializeDeviceDiscovery() {
  try {
    const response = await fetch('/network-info');
    if (!response.ok) {throw new Error(`Network info unavailable (${response.status}).`);}
    const payload = await response.json();
    state.device.bridgeActive = true;
    state.device.discoveredSubnets = [...new Set((payload.networks || []).map((network) => network.subnet))];
    state.device.knownScanSubnets = Array.isArray(payload.scanSubnets) ? payload.scanSubnets : [];
    state.device.scanRange = state.device.scanRange || state.device.discoveredSubnets[0] || state.device.knownScanSubnets[0] || '';
    if (state.device.url) {
      state.device.discoveryLog = [`LumaBurn Bridge active. Saved target: ${state.device.url}`];
      pushDeviceActivity('info', 'Checking saved controller', state.device.url);
      setDeviceState('Connecting', `Checking saved controller at ${state.device.url}`);
      await refreshDeviceFiles();
      return;
    }
    if (state.device.discoveredSubnets.length || state.device.knownScanSubnets.length) {
      state.device.discoveryLog = [
        `Bridge active. Interfaces: ${state.device.discoveredSubnets.join(', ') || 'none'}`,
        `Smart scan: ${state.device.discoveredSubnets[0] || 'No local subnet detected'}`,
      ];
      pushDeviceActivity('info', 'Local networks detected', state.device.discoveryLog.join(' | '));
      render();
      await scanNetworkForDevices();
    } else {
      state.device.lastFileSummary = 'No controller connected. Bridge is active.';
      setDeviceState('Bridge Idle', 'Bridge is active. Enter a manual IP or scan range to connect.');
    }
  } catch {
    state.device.bridgeActive = false;
    state.device.enabled = true; // Still enabled for direct manual mode!
    state.device.discoveryLog = ['LumaBurn Bridge unavailable. Using Direct Mode (CORS requirement).'];
    state.device.lastFileSummary = 'Using direct network communication. Bridge proxy is offline.';
    pushDeviceActivity('info', 'Direct communication mode', 'The LumaBurn Bridge is not detected. Attempting direct device fetch.');
    setDeviceState('Manual Mode', 'LumaBurn Bridge unavailable. Using direct controller communication (Direct Mode).');
    showNetworkSecurityWarning();
  }
}

function showNetworkSecurityWarning() {
  if (document.getElementById('security-warning-banner')) {return;}
  
  const isLocalFile = window.location.protocol === 'file:';
  const banner = document.createElement('div');
  banner.id = 'security-warning-banner';
  banner.style.cssText = `
    background: #ca3131;
    color: white;
    padding: 12px 24px;
    font-size: 0.9rem;
    font-weight: 500;
    text-align: center;
    border-bottom: 2px solid rgba(0,0,0,0.1);
    z-index: 10000;
  `;
  
  const message = isLocalFile
    ? '⚠️ <strong>NETWORK RESTRICTED:</strong> Browser security blocks laser control when running as a file. Please run <code>npm start</code> and open <a href="http://localhost:4173" style="color:white;text-decoration:underline">http://localhost:4173</a>.'
    : '⚠️ <strong>BRIDGE OFFLINE:</strong> The LumaBurn Bridge is not responding. Connectivity features may be limited. Ensure <code>node server.js</code> is running.';
    
  banner.innerHTML = message;
  document.body.prepend(banner);
}

function saveMachineProfile() {
  const name = window.prompt('Machine profile name:', 'Shop Machine');
  if (!name) {return;}
  const profile = { id: slugifyName(name), name, machine: structuredClone(state.machine) };
  upsertProfile(state.machineProfiles, profile);
  persistProfiles();
  state.selectedMachineProfileId = profile.id;
  render();
}

function saveDeviceProfile() {
  const name = window.prompt('Device profile name:', state.device.friendlyName || 'Laser Controller');
  if (!name) {return;}
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
  if (!profile) {return;}
  upsertProfile(state.deviceProfiles, profile);
  persistProfiles();
  state.selectedDeviceProfileId = profile.id;
  setStatus(`Saved device profile: ${profile.name}.`);
  render();
}

function setDefaultDeviceProfile() {
  if (!state.selectedDeviceProfileId) {return;}
  state.defaultDeviceProfileId = state.selectedDeviceProfileId;
  persistProfiles();
  setStatus('Default device profile saved.');
}

function setDefaultMachineProfile() {
  if (!state.selectedMachineProfileId) {return;}
  state.defaultMachineProfileId = state.selectedMachineProfileId;
  persistProfiles();
  setStatus('Default machine profile saved.');
}

function deleteSelectedMachineProfile() {
  if (!state.selectedMachineProfileId) {return;}
  state.machineProfiles = state.machineProfiles.filter((profile) => profile.id !== state.selectedMachineProfileId);
  if (state.defaultMachineProfileId === state.selectedMachineProfileId) {state.defaultMachineProfileId = '';}
  state.selectedMachineProfileId = '';
  persistProfiles();
  render();
}

function applySavedMachineProfile(profileId) {
  const profile = state.machineProfiles.find((item) => item.id === profileId);
  if (!profile) {return;}
  state.machine = { ...state.machine, ...structuredClone(profile.machine) };
  state.selectedMachineProfileId = profile.id;
  render();
}

function applySavedDeviceProfile(profileId) {
  const profile = state.deviceProfiles.find((item) => item.id === profileId);
  if (!profile) {
    state.selectedDeviceProfileId = '';
    render();
    return;
  }
  const runtimeDeviceState = {
    discoveredSubnets: state.device.discoveredSubnets,
    discoveryLog: state.device.discoveryLog,
    activityLog: state.device.activityLog,
    knownScanSubnets: state.device.knownScanSubnets,
    bridgeActive: state.device.bridgeActive,
    stateLabel: state.device.stateLabel,
    stateDetail: state.device.stateDetail,
    lastFileSummary: state.device.lastFileSummary,
  };
  state.device = {
    ...createDefaultDeviceState(),
    ...structuredClone(profile.device),
    ...runtimeDeviceState,
    uploadPath: normalizeStoragePath(profile.device.uploadPath, '/sd/'),
    browsePath: normalizeStoragePath(profile.device.browsePath || profile.device.uploadPath, '/sd/'),
    files: [],
    streaming: false,
    enabled: Boolean(profile.device.url),
  };
  state.selectedDeviceProfileId = profile.id;
  setStatus(`Loaded device profile: ${profile.name}.`);
  render();
}

function deleteSelectedDeviceProfile() {
  if (!state.selectedDeviceProfileId) {return;}
  state.deviceProfiles = state.deviceProfiles.filter((profile) => profile.id !== state.selectedDeviceProfileId);
  if (state.defaultDeviceProfileId === state.selectedDeviceProfileId) {state.defaultDeviceProfileId = '';}
  state.selectedDeviceProfileId = '';
  persistProfiles();
  setStatus('Device profile deleted.');
  render();
}

function loadProfilesFromStorage() {
  state.machineProfiles = readStoredProfiles(MACHINE_PROFILE_STORAGE_KEY);
  state.deviceProfiles = readStoredProfiles(DEVICE_PROFILE_STORAGE_KEY)
    .map(normalizeSavedDeviceProfile)
    .filter(Boolean);
  state.defaultMachineProfileId = window.localStorage.getItem(DEFAULT_MACHINE_PROFILE_STORAGE_KEY) || '';
  state.defaultDeviceProfileId = window.localStorage.getItem(DEFAULT_DEVICE_PROFILE_STORAGE_KEY) || '';
}

function persistProfiles() {
  window.localStorage.setItem(MACHINE_PROFILE_STORAGE_KEY, JSON.stringify(state.machineProfiles));
  window.localStorage.setItem(DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(state.deviceProfiles));
  window.localStorage.setItem(DEFAULT_MACHINE_PROFILE_STORAGE_KEY, state.defaultMachineProfileId);
  window.localStorage.setItem(DEFAULT_DEVICE_PROFILE_STORAGE_KEY, state.defaultDeviceProfileId);
}

function readStoredProfiles(key) {
  try { return JSON.parse(window.localStorage.getItem(key) || '[]'); } catch { return []; }
}

function upsertProfile(collection, profile) {
  const index = collection.findIndex((item) => item.id === profile.id);
  if (index >= 0) {collection.splice(index, 1, profile);}
  else {collection.push(profile);}
}

function applyStartupProfiles() {
  if (state.machineProfiles.length === 1 && !state.defaultMachineProfileId) {
    state.defaultMachineProfileId = state.machineProfiles[0].id;
  }
  if (state.deviceProfiles.length === 1 && !state.defaultDeviceProfileId) {
    state.defaultDeviceProfileId = state.deviceProfiles[0].id;
  }
  const machineProfileId = state.defaultMachineProfileId || state.machineProfiles[0]?.id || '';
  const deviceProfileId = state.defaultDeviceProfileId || state.deviceProfiles[0]?.id || '';
  if (machineProfileId) {applySavedMachineProfile(machineProfileId);}
  if (deviceProfileId) {applySavedDeviceProfile(deviceProfileId);}
}

function restoreWorkspaceFromStorage() {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) {return;}
    const workspace = JSON.parse(raw);
    if (!workspace || !Array.isArray(workspace.objects) || !Array.isArray(workspace.operationLayers)) {return;}
    state.documentName = workspace.documentName || state.documentName;
    state.artworkViewBox = workspace.artworkViewBox || state.artworkViewBox;
    state.sourceDefsMarkup = workspace.sourceDefsMarkup || '';
    state.machine = { ...state.machine, ...(workspace.machine || {}) };
    state.operationLayers = workspace.operationLayers.length ? workspace.operationLayers : state.operationLayers;
    state.objects = normalizeSceneNodes(workspace.objects, state.operationLayers[0]?.id || '');
    state.selectedObjectIds = Array.isArray(workspace.selectedObjectIds)
      ? workspace.selectedObjectIds.filter((id) => Boolean(findNodeById(id, state.objects)))
      : [];
    state.selectedOperationLayerId = workspace.selectedOperationLayerId || state.operationLayers[0]?.id || '';
    state.selectedMachineProfileId = workspace.selectedMachineProfileId || state.selectedMachineProfileId;
    state.selectedDeviceProfileId = workspace.selectedDeviceProfileId || state.selectedDeviceProfileId;
    state.interactionMode = workspace.interactionMode || 'select';
  } catch {
    window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }
}

function scheduleWorkspacePersist() {
  if (workspaceSaveTimer) {window.clearTimeout(workspaceSaveTimer);}
  if (elements.projectStatus) {
    elements.projectStatus.classList.remove('saved');
    elements.projectStatus.classList.add('saving');
    const label = elements.projectStatus.querySelector('.status-label');
    if (label) {label.textContent = 'Saving...';}
  }
  workspaceSaveTimer = window.setTimeout(persistWorkspaceNow, 1000);
}

function persistWorkspaceNow() {
  if (workspaceSaveTimer) {window.clearTimeout(workspaceSaveTimer);}
  workspaceSaveTimer = null;

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
  
  if (elements.projectStatus) {
    elements.projectStatus.classList.remove('saving');
    elements.projectStatus.classList.add('saved');
    const label = elements.projectStatus.querySelector('.status-label');
    if (label) {label.textContent = 'Saved';}
  }
}

function nudgeSelection(dx, dy) {
  const nodes = selectedWorkspaceObjects();
  if (!nodes.length) {return;}
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
  elements.measurementRoot.innerHTML = '';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${state.artworkViewBox.width} ${state.artworkViewBox.height}`);
  const group = document.createElementNS(SVG_NS, 'g');
  appendSvgMarkup(svg, state.sourceDefsMarkup);
  appendSvgMarkup(group, markup);
  svg.appendChild(group);
  elements.measurementRoot.appendChild(svg);
  const target = group.firstElementChild || group;
  const box = target.getBBox();
  return { minX: box.x, minY: box.y, width: box.width || 1, height: box.height || 1, centerX: box.x + box.width / 2, centerY: box.y + box.height / 2 };
}

function selectionBounds(nodes = selectedWorkspaceObjects()) {
  const bounds = nodes.map((node) => objectWorldBounds(node));
  return bounds.length ? unionBounds(bounds) : null;
}

function createSvgPoint(x, y) {
  const point = elements.canvas.createSVGPoint();
  point.x = x;
  point.y = y;
  return point;
}

function createSvg(tag, attributes = {}, text = '') {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text) {node.textContent = text;}
  return node;
}

function appendSvgMarkup(target, markup) {
  if (!markup) {return;}
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, 'image/svg+xml');
  const svg = parsed.documentElement;
  [...svg.childNodes].forEach((child) => target.appendChild(document.importNode(child, true)));
}

function refreshLiveGeometryMarkup(node) {
  if (!node?.markup || !node.liveGeometry) {return;}
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${node.markup}</svg>`, 'image/svg+xml');
  const root = parsed.documentElement;
  const el = root.firstElementChild;
  if (!(el instanceof SVGElement)) {return;}

  if (node.liveGeometry.type === 'rect' && el.tagName.toLowerCase() === 'rect') {
    const rx = Math.max(0, Number(node.liveGeometry.rx) || 0);
    const w = Math.max(0.1, Number(node.liveGeometry.width) || 0);
    const h = Math.max(0.1, Number(node.liveGeometry.height) || 0);
    el.setAttribute('rx', String(rx));
    el.setAttribute('ry', String(rx));
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
  }

  if (node.liveGeometry.type === 'text') {
    // If we have a text element or a group containing text, find the primary text node
    const textEl = el.tagName.toLowerCase() === 'text' ? el : el.querySelector?.('text');
    if (textEl && textEl.tagName?.toLowerCase?.() === 'text') {
      const value = String(node.liveGeometry.content ?? '');
      // Deep clear to handle complex nested structures from external SVGs
      textEl.innerHTML = ''; 
      textEl.textContent = value;
      // Synchronize back to the node properties for persistence
      node.content = value;
    }
  }

  node.markup = new XMLSerializer().serializeToString(el);
  node.sourceBounds = measureMarkup(node.markup);
}

function countObjects(nodes) {
  return (Array.isArray(nodes) ? nodes : []).reduce((sum, node) => sum + 1 + countObjects(nodeChildren(node)), 0);
}

function replaceArrayContents(target, source) {
  target.splice(0, target.length, ...source);
}

function snap(value) {
  if (!state.machine.snapEnabled || state.machine.snapStep <= 0) {return round(value, 1);}
  return round(Math.round(value / state.machine.snapStep) * state.machine.snapStep, 1);
}

function dedupePolyline(polyline) {
  return polyline.filter((point, index) => !index || Math.hypot(point.x - polyline[index - 1].x, point.y - polyline[index - 1].y) > 0.05);
}



function defaultOperationColor(index) {
  return ['#ca5b31', '#2f6b45', '#22618d', '#934d98', '#cf8b1d', '#7f4f24'][index % 6];
}

function prettyNodeName(tag) {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function numberFromLength(value) {
  const match = String(value || '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}



function formatDuration(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) {return `${hours}h ${minutes}m`;}
  if (minutes > 0) {return `${minutes}m ${secs}s`;}
  return `${secs}s`;
}



function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function showStatus(message) {
  if (typeof message !== 'string') {message = String(message);}
  if (elements.statusText) {
    elements.statusText.textContent = message;
  }
  console.log('[LumaStatus]', message);
}

function setStatus(message) {
  showStatus(message);
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(String(value));
}

function slugifyName(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || crypto.randomUUID();
}

initialize();

// Expose state and internals for testing/debugging
window.LumaState = state;
window.LumaElements = elements;
window.LumaActions = {
  render,
  renderCanvas,
  setStatus,
  showStatus,
  handleArtworkImport
};
