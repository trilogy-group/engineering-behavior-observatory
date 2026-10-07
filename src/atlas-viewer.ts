import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built Atlas viewer (`viewer/dist`, shipped in the npm package) and the local server that shows one Atlas bundle
 * with it: the viewer at `/`, the bundle's files at `/bundle/`. Read-only, loopback only, no directory listings, and
 * every path must resolve inside its root after symlinks.
 */
export const ATLAS_VIEWER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer", "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".arrow": "application/vnd.apache.arrow.stream",
  ".svg": "image/svg+xml", ".png": "image/png", ".parquet": "application/vnd.apache.parquet", ".txt": "text/plain; charset=utf-8",
};
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** A file under `root` for a URL path, or undefined when it escapes the root, does not exist or is not a file. */
export function resolveContained(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return undefined; }
  if (decoded.includes("\0") || decoded.split("/").some((part) => part === "..")) return undefined;
  const realRoot = realpathSync(root);
  const candidate = resolve(realRoot, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (!existsSync(candidate)) return undefined;
  const real = realpathSync(candidate);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
  return statSync(real).isFile() ? real : undefined;
}

export async function serveAtlasBundle(bundleRoot: string, port = 13012, viewerRoot = ATLAS_VIEWER_ROOT): Promise<Server> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Atlas port.");
  if (!existsSync(join(viewerRoot, "index.html"))) throw new Error(`The Atlas viewer is not built (${viewerRoot}); run npm run build:viewer.`);
  if (!existsSync(join(bundleRoot, "units.arrow"))) throw new Error(`${bundleRoot} is not an Atlas bundle (units.arrow is missing).`);
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      if (!req.headers.host || !LOOPBACK.includes(new URL(`http://${req.headers.host}`).hostname)) { res.writeHead(403).end(); return; }
      if (req.headers.origin && !LOOPBACK.includes(new URL(req.headers.origin).hostname)) { res.writeHead(403).end(); return; }
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const file = path.startsWith("/bundle/") ? resolveContained(bundleRoot, path.slice("/bundle".length))
        : resolveContained(viewerRoot, path === "/" ? "/index.html" : path);
      if (file === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": statSync(file).size });
      if (req.method === "HEAD") { res.end(); return; }
      createReadStream(file).pipe(res);
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  return server;
}
