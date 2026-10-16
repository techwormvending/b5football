/* Local preview of the static site (what GitHub Pages serves), on
   http://localhost:8737 (a Supabase Auth redirect URL, so magic links work locally).
   Only top-level site files are served; data/, scripts/, src/ and dotfiles never are.

   Usage:  node scripts/serve.js        PORT=8800 to change the port */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 8737;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let name;
  try { name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)); } catch { name = ""; }
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!type || name.includes("/") || name.includes("\\") || name.startsWith(".")) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(path.join(ROOT, name), (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`B5 site on http://localhost:${PORT}`));
