import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="elements"></div>
</body></html>`, { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.SVGElement = dom.window.SVGElement;
global.crypto = { randomUUID: () => 'uuid' };

// We need to mock state and elements
global.state = {
  operationLayers: [{ id: 'op1' }],
  objects: [],
  selectedObjectIds: []
};
global.elements = {
  measurementRoot: dom.window.document.createElement('div')
};
global.SVG_NS = 'http://www.w3.org/2000/svg';

// Load app.js and try to run the import path

// We need to just extract the functions we care about, or eval the whole thing.
// Evaling the whole thing might be tricky if it tries to bind UI events.
