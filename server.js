const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const DISCOVERY_TIMEOUT_MS = 1200;
const DISCOVERY_CONCURRENCY = 48;
const SMART_SCAN_LIMIT = 48;
const DEVICE_COMMAND_TIMEOUT_MS = 3500;
const STOP_SEQUENCE_STEPS = [
  { command: '!' },
  { command: 'M5' },
  { command: '\u0018', waitAfterMs: 25 },
  { command: 'M5' },
];

function ipv4ToInt(address) {
  return address.split('.').map(Number).reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
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

    const candidatePaths = ['/files?action=list&path=/sd/', '/files?action=list&path=/ext/', '/'];
    let settled = false;

    function finish(result) {
      if (settled) {return;}
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
          method: 'GET',
          path: candidatePaths[index],
          timeout: DISCOVERY_TIMEOUT_MS,
          headers: {
            'Accept-Encoding': 'gzip,deflate',
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length > 65536) {
              response.destroy();
            }
          });
          response.on('close', () => {
            const raw = Buffer.concat(chunks);
            const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
            let body = '';
            try {
              if (encoding.includes('gzip')) {
                body = zlib.gunzipSync(raw).toString('utf8');
              } else if (encoding.includes('deflate')) {
                body = zlib.inflateSync(raw).toString('utf8');
              } else {
                body = raw.toString('utf8');
              }
            } catch {
              body = raw.toString('utf8');
            }

            if (/"status"\s*:\s*"Ok"/i.test(body) && /"path"\s*:\s*"\/(sd|ext)\//i.test(body)) {
              finish({ url: targetRaw, title: 'ESP3D Controller' });
              return;
            }
            if (/ESP3D WebUI/i.test(body)) {
              finish({ url: targetRaw, title: 'ESP3D WebUI' });
              return;
            }
            tryPath(index + 1);
          });
        }
      );

      request.on('timeout', () => {
        request.destroy();
        tryPath(index + 1);
      });
      request.on('error', () => tryPath(index + 1));
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
      if (!entry || entry.family !== 'IPv4' || entry.internal || !isPrivateIpv4(entry.address)) {
        return;
      }
      const octets = entry.address.split('.');
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
  const cidr = String(network.cidr || '');
  const match = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) {return [network.subnet];}
  const address = match[1];
  const prefix = Number(match[2]);
  if (prefix >= 24) {
    const base = intToSubnet(ipv4ToInt(address) & 0xffffff00);
    return [base];
  }

  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const start = ipv4ToInt(address) & mask;
  const span = Math.min(SMART_SCAN_LIMIT, 2 ** Math.max(0, 24 - prefix));
  return Array.from({ length: span }, (_, index) => intToSubnet(start + index * 256));
}

function deriveSmartScanSubnets(networks) {
  const candidates = [];
  networks.forEach((network) => {
    candidates.push(...expandNetworkSubnets(network));
    const parts = String(network.subnet || '').split('.').map(Number);
    if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {return;}
    for (let offset = 1; offset <= 2; offset += 1) {
      if (parts[2] - offset >= 0) {candidates.push(`${parts[0]}.${parts[1]}.${parts[2] - offset}`);}
      if (parts[2] + offset <= 255) {candidates.push(`${parts[0]}.${parts[1]}.${parts[2] + offset}`);}
    }
  });
  return [...new Set(candidates.filter(Boolean))].slice(0, SMART_SCAN_LIMIT);
}

function normalizeSubnetList(raw) {
  return [...new Set(String(raw || '')
    .split(/[,\s;]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)))];
}

async function mapWithConcurrency(items, limit, iteratee) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {return;}
      results[current] = await iteratee(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function discoverDevicesOnSubnets(subnets) {
  const candidates = subnets.flatMap((subnet) => Array.from({ length: 254 }, (_, index) => `http://${subnet}.${index + 1}`));
  const results = await mapWithConcurrency(candidates, DISCOVERY_CONCURRENCY, (candidate) => probeDevice(candidate));
  return results.filter(Boolean).filter((device, index, array) => array.findIndex((entry) => entry.url === device.url) === index);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
    throw new Error('Missing target URL.');
  }
  const parsed = new URL(targetRaw);
  if (parsed.protocol !== 'http:') {
    throw new Error('Only http:// device targets are allowed.');
  }
  if (!isPrivateIpv4(parsed.hostname)) {
    throw new Error('Target must be a private IPv4 device.');
  }
  return parsed;
}

function serveStatic(requestPath, response) {
  const normalized = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = path.join(ROOT, path.normalize(normalized));
  if (!filePath.startsWith(ROOT)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    response.end(content);
  });
}

function proxyRequest(request, response, inboundUrl) {
  let target;
  try {
    target = sanitizeTarget(inboundUrl.searchParams.get('target'));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }

  const proxyPath = inboundUrl.pathname.replace(/^\/device/, '') || '/';
  const forwarded = new URL(proxyPath + inboundUrl.search, target);
  forwarded.searchParams.delete('target');

  const upstream = http.request(
    {
      protocol: forwarded.protocol,
      hostname: forwarded.hostname,
      port: forwarded.port || 80,
      method: request.method,
      path: `${forwarded.pathname}${forwarded.search}`,
      headers: {
        ...request.headers,
        host: forwarded.host,
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        ...upstreamResponse.headers,
        'Access-Control-Allow-Origin': '*',
      });
      upstreamResponse.pipe(response);
    }
  );

  upstream.on('error', (error) => {
    sendJson(response, 502, { error: error.message });
  });

  request.pipe(upstream);
}

function sendDeviceCommand(target, command) {
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        method: 'GET',
        path: `/command?commandText=${encodeURIComponent(command)}`,
        timeout: DEVICE_COMMAND_TIMEOUT_MS,
      },
      (upstreamResponse) => {
        const chunks = [];
        upstreamResponse.on('data', (chunk) => {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > 65536) {upstreamResponse.destroy();}
        });
        upstreamResponse.on('close', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((upstreamResponse.statusCode || 500) >= 400) {
            reject(new Error(`Command ${JSON.stringify(command)} failed: ${upstreamResponse.statusCode || 500} ${body}`.slice(0, 280)));
            return;
          }
          resolve({ statusCode: upstreamResponse.statusCode || 200, body });
        });
      }
    );

    upstream.on('timeout', () => {
      upstream.destroy(new Error(`Command ${JSON.stringify(command)} timed out.`));
    });
    upstream.on('error', reject);
    upstream.end();
  });
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
    if (step.waitAfterMs) {await delay(step.waitAfterMs);}
  }

  if (!succeededSteps) {
    throw new Error(failedSteps.at(-1)?.error || 'Unable to send stop commands.');
  }

  return {
    id: 'emergency-stop-burst',
    label: 'Emergency stop burst',
    partial: failedSteps.length > 0,
    failedSteps,
  };
}

const server = http.createServer((request, response) => {
  const inboundUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }

  if (inboundUrl.pathname === '/discover') {
    const subnet = inboundUrl.searchParams.get('subnet');
    if (!subnet || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
      sendJson(response, 400, { error: 'A subnet like 192.168.1 is required.' });
      return;
    }
    discoverDevicesOnSubnets([subnet]).then((devices) => {
      sendJson(response, 200, { devices });
    }).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
    return;
  }

  if (inboundUrl.pathname === '/discover-many') {
    const subnets = normalizeSubnetList(inboundUrl.searchParams.get('subnets'));
    if (!subnets.length) {
      sendJson(response, 400, { error: 'At least one subnet is required.' });
      return;
    }
    discoverDevicesOnSubnets(subnets).then((devices) => {
      sendJson(response, 200, { devices, subnets });
    }).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
    return;
  }

  if (inboundUrl.pathname === '/network-info') {
    const networks = getPrivateNetworks();
    sendJson(response, 200, { networks, scanSubnets: deriveSmartScanSubnets(networks) });
    return;
  }

  if (inboundUrl.pathname === '/device/stop') {
    executeStopSequence(inboundUrl.searchParams.get('target')).then((plan) => {
      sendJson(response, 200, { status: 'ok', ...plan });
    }).catch((error) => {
      sendJson(response, 502, { status: 'error', error: error.message });
    });
    return;
  }

  if (inboundUrl.pathname.startsWith('/device/')) {
    proxyRequest(request, response, inboundUrl);
    return;
  }

  serveStatic(inboundUrl.pathname, response);
});

server.listen(PORT, HOST, () => {
  console.log(`LumaBurn server running at http://${HOST}:${PORT}`);
});
