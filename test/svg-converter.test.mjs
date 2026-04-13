import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSvgToNodes, nodeTreeToSvgString } from '../svg-converter.mjs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.SVGElement = dom.window.SVGElement;

test('convertSvgToNodes: basic SVG with rect and path', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '10');
  rect.setAttribute('y', '10');
  rect.setAttribute('width', '80');
  rect.setAttribute('height', '80');
  rect.setAttribute('fill', '#000');
  svg.appendChild(rect);
  
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M 20 20 L 80 20 L 80 80 Z');
  path.setAttribute('stroke', '#f00');
  svg.appendChild(path);
  
  const result = convertSvgToNodes(svg);
  
  assert.equal(result.nodes.length, 2);
  assert.equal(result.nodes[0].type, 'rect');
  assert.equal(result.nodes[0].x, 10);
  assert.equal(result.nodes[0].width, 80);
  assert.equal(result.nodes[1].type, 'path');
  assert.ok(result.nodes[1].d);
});

test('convertSvgToNodes: handles transform correctly', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('transform', 'translate(10, 20) scale(2)');
  svg.appendChild(g);
  
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '5');
  rect.setAttribute('y', '5');
  rect.setAttribute('width', '10');
  rect.setAttribute('height', '10');
  g.appendChild(rect);
  
  const result = convertSvgToNodes(svg);
  
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].type, 'group');
  assert.ok(result.nodes[0].transform);
  assert.equal(result.nodes[0].transform.matrix.a, 2);
  assert.equal(result.nodes[0].transform.matrix.e, 10);
});

test('nodeToSvgString: reconstructs basic shapes', () => {
  const node = {
    tagName: 'rect',
    attributes: { x: 10, y: 20, width: 100, height: 50, fill: '#000' },
    transform: null,
    style: {},
    class: '',
    children: []
  };
  
  const svg = nodeTreeToSvgString(node);
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('x="10"'));
  assert.ok(svg.includes('y="20"'));
  assert.ok(svg.includes('width="100"'));
  assert.ok(svg.includes('height="50"'));
  assert.ok(svg.includes('fill="#000"'));
});

test('convertSvgToNodes: parses shapes (circle, ellipse, line, polyline, polygon)', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '10'); circle.setAttribute('cy', '15'); circle.setAttribute('r', '5');
  svg.appendChild(circle);

  const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
  ellipse.setAttribute('cx', '20'); ellipse.setAttribute('cy', '25'); ellipse.setAttribute('rx', '10'); ellipse.setAttribute('ry', '5');
  svg.appendChild(ellipse);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', '1'); line.setAttribute('y1', '2'); line.setAttribute('x2', '3'); line.setAttribute('y2', '4');
  svg.appendChild(line);

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '0,0 10,10 20,0');
  svg.appendChild(polyline);

  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', '5,5 15,5 10,15');
  svg.appendChild(polygon);

  const result = convertSvgToNodes(svg);
  assert.equal(result.nodes.length, 5);
  assert.equal(result.nodes[0].type, 'circle'); assert.equal(result.nodes[0].r, 5);
  assert.equal(result.nodes[1].type, 'ellipse'); assert.equal(result.nodes[1].rx, 10);
  assert.equal(result.nodes[2].type, 'line'); assert.equal(result.nodes[2].x2, 3);
  assert.equal(result.nodes[3].type, 'polyline'); assert.deepEqual(result.nodes[3].points, [{x:0, y:0}, {x:10, y:10}, {x:20, y:0}]);
  assert.equal(result.nodes[4].type, 'polygon'); assert.deepEqual(result.nodes[4].points, [{x:5, y:5}, {x:15, y:5}, {x:10, y:15}]);
});

test('convertSvgToNodes: parses use, text, image', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const refRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  refRect.setAttribute('id', 'myRect');
  refRect.setAttribute('width', '100');
  defs.appendChild(refRect);
  svg.appendChild(defs);

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#myRect');
  svg.appendChild(use);

  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.textContent = 'Hello';
  text.setAttribute('font-size', '16');
  svg.appendChild(text);

  const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  img.setAttribute('href', 'data:image/png;base64,...');
  img.setAttribute('width', '50');
  svg.appendChild(img);

  const result = convertSvgToNodes(svg, { resolveUseElements: true });
  assert.equal(result.nodes.length, 3);
  assert.equal(result.nodes[0].type, 'rect'); // Resolved
  assert.equal(result.nodes[0].width, 100);
  assert.equal(result.nodes[1].type, 'text');
  assert.equal(result.nodes[1].content, 'Hello');
  assert.equal(result.nodes[2].type, 'image');
  assert.equal(result.nodes[2].width, 50);
});

test('convertSvgToNodes: parses styles and viewBox', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 300');
  svg.setAttribute('width', '800');
  svg.setAttribute('height', '600');
  
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('style', 'fill:#f00; stroke-width: 2;');
  svg.appendChild(rect);

  const result = convertSvgToNodes(svg);
  assert.deepEqual(result.viewBox, { x: 0, y: 0, width: 400, height: 300 });
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.equal(result.nodes[0].style.fill, '#f00');
  assert.equal(result.nodes[0].style['stroke-width'], '2');
});

test('convertSvgToNodes: transforms parsing and composition', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('transform', 'matrix(1, 0, 0, 1, 10, 10) rotate(90) skewX(10) skewY(5) translate(5, 5)');
  svg.appendChild(g);

  const result = convertSvgToNodes(svg);
  assert.ok(result.nodes[0].transform.matrix);
});

test('nodeTreeToSvgString: formats node tree to svg string correctly for all types', () => {
  const root = {
    tagName: 'g', type: 'group', attributes: { id: 'test' }, style: { opacity: 0.5 }, class: 'layer', transform: { matrix: { a:1, b:0, c:0, d:1, e:10, f:10 } },
    children: [
      { tagName: 'circle', type: 'circle', cx: 10, cy: 10, r: 5, attributes: {}, style: {} },
      { tagName: 'ellipse', type: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 2, attributes: {}, style: {} },
      { tagName: 'line', type: 'line', x1: 0, y1: 0, x2: 10, y2: 10, attributes: {}, style: {} },
      { tagName: 'polyline', type: 'polyline', points: [{x:0, y:0}, {x:5, y:5}], attributes: {}, style: {} },
      { tagName: 'polygon', type: 'polygon', points: [{x:0, y:0}, {x:5, y:0}, {x:5, y:5}], attributes: {}, style: {} },
      { tagName: 'image', type: 'image', href: 'img.png', x: 0, y: 0, width: 10, height: 10, attributes: {}, style: {} },
      { tagName: 'text', type: 'text', content: 'test & < >', attributes: {}, style: {} },
      { tagName: 'path', type: 'path', d: 'M0,0 L10,10', attributes: {}, style: {} },
      { tagName: 'use', type: 'use', href: 'myRect', attributes: { href: 'myRect' }, style: {} }
    ]
  };

  const str = nodeTreeToSvgString(root);
  console.log('OUTPUT SVG:', str);
  assert.ok(str.includes('<g'));
  assert.ok(str.includes('id="test"'));
  assert.ok(str.includes('class="layer"'));
  assert.ok(str.includes('opacity:0.5'));
  assert.ok(str.includes('<circle '));
  assert.ok(str.includes('cx="10"'));
  assert.ok(str.includes('cy="10"'));
  assert.ok(str.includes('r="5"'));
  assert.ok(str.includes('<ellipse '));
  assert.ok(str.includes('rx="5"'));
  assert.ok(str.includes('<line '));
  assert.ok(str.includes('<polyline '));
  assert.ok(str.includes('points="0,0 5,5"'));
  assert.ok(str.includes('<polygon '));
  assert.ok(str.includes('<image '));
  assert.ok(str.includes('href="img.png"'));
  assert.ok(str.includes('<text'));
  assert.ok(str.includes('test &amp; &lt; &gt;'));
  assert.ok(str.includes('<path '));
  assert.ok(str.includes('d="M0,0 L10,10"'));
  assert.ok(str.includes('<use'));
});
