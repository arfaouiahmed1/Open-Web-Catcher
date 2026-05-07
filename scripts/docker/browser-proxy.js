#!/usr/bin/env node

const http = require('node:http');

const listenPort = Number.parseInt(process.argv[2] || '9222', 10);
const targetPort = Number.parseInt(process.argv[3] || '9332', 10);
const targetHost = process.argv[4] || '127.0.0.1';

if (!Number.isFinite(listenPort) || !Number.isFinite(targetPort)) {
  console.error('[browser-proxy] Usage: browser-proxy.js <listenPort> <targetPort> [targetHost]');
  process.exit(1);
}

function forwardedHeaders(headers) {
  return {
    ...headers,
    host: `${targetHost}:${targetPort}`,
    connection: headers.connection || 'close',
  };
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req.headers),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`[browser-proxy] upstream request failed: ${error.message}`);
  });

  req.pipe(upstream);
});

server.on('upgrade', (req, clientSocket, head) => {
  const upstreamReq = http.request({
    hostname: targetHost,
    port: targetPort,
    method: 'GET',
    path: req.url,
    headers: {
      ...forwardedHeaders(req.headers),
      upgrade: req.headers.upgrade || 'websocket',
    },
  });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode || 101} ${upstreamRes.statusMessage || 'Switching Protocols'}\r\n`;
    clientSocket.write(statusLine);
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (typeof value === 'undefined') {
        continue;
      }
      clientSocket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
    }
    clientSocket.write('\r\n');

    if (upstreamHead.length) {
      clientSocket.write(upstreamHead);
    }
    if (head.length) {
      upstreamSocket.write(head);
    }

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamReq.on('error', () => {
    clientSocket.destroy();
  });

  upstreamReq.end();
});

server.on('error', (error) => {
  console.error(`[browser-proxy] ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`[browser-proxy] forwarding 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}`);
});
