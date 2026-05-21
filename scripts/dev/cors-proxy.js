const http = require("node:http");

const target = process.env.PROXY_TARGET || "http://localhost:8000";
const port = Number(process.env.PROXY_PORT || 3101);
const allowOrigin = process.env.PROXY_ALLOW_ORIGIN || "http://localhost:3103";

http
  .createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const upstreamUrl = new URL(req.url, target);
    const upstream = http.request(
      upstreamUrl,
      {
        method: req.method,
        headers: { ...req.headers, host: new URL(target).host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, { ...upstreamRes.headers, ...cors });
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      res.writeHead(502, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    req.pipe(upstream);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`CORS proxy listening on ${port} -> ${target}`);
  });
