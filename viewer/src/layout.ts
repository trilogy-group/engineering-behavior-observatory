// The cloud's layout, computed in the browser with Embedding Atlas's own WASM: per unit family (messages, episodes,
// tools) a cosine UMAP (fixed seed, so a bundle lays out the same way each time) placed side by side, density
// clusters over each family's layout, and cluster labels from the facets most over-represented in a cluster. The
// bundle carries embeddings (embeddings.f32) instead of a layout. Numbers here are exploratory.
import { Field, Float32, Int32, List, makeVector, Struct, Table, tableFromIPC, tableToIPC, Utf8, vectorFromArray } from "apache-arrow";
import { createUMAP, findClusters } from "embedding-atlas";
import { STOP_WORDS } from "./stopwords";

export type CloudLabel = { x: number; y: number; text: string; level: number; priority: number };
type Row = { row_id: number; family: string; unit_kind: string; embed_text: string; tool_kind: string | null; command_head: string | null;
  check_kind: string | null; target: string | null; status: string | null; occurrences: string[] };

const FAMILIES = ["messages", "episodes", "tools"] as const;
const GRID = 256;
const STOP = new Set([...STOP_WORDS, ...`the a an and or of to in on for with this that it is are be as at by from not now so then let me i'll i'm we you they them its it's will can should would could all any each more also just into out up there here what which when while about after before over under than these those have has had was were been being do does did done use using file files make sure need want check run see let's going one two first next`.split(/\s+/u)]);

function targetClass(t: string | null) {
  if (!t) return null;
  const parts = t.split("/"), name = parts.at(-1)!;
  const ext = name.includes(".") && !name.startsWith(".") ? `*.${name.split(".").at(-1)!}` : name;
  return parts.length > 1 ? [...parts.slice(0, -1).slice(-2), ext].join("/") : ext;
}

/** What a unit is about, for labels: the command, check, target class, failure and occurrences of a tool; words otherwise. */
function facets(u: Row): string[] {
  if (u.unit_kind === "tool") {
    const f = [u.command_head ? `\`${u.command_head}\`` : u.tool_kind];
    if (u.check_kind && !["other", "inspect"].includes(u.check_kind)) f.push(u.check_kind);
    if ((u.tool_kind === "read" || u.tool_kind === "edit") && u.target) f.push(targetClass(u.target));
    if (u.status === "error") f.push("failed");
    f.push(...u.occurrences);
    return f.filter((x): x is string => Boolean(x));
  }
  return [...new Set((u.embed_text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))];
}

/** Density on a GRID×GRID raster of the family's points, smoothed by two box blurs. */
function densityMap(xs: Float32Array, ys: Float32Array, box: { x0: number; y0: number; w: number; h: number }) {
  let map = new Float32Array(GRID * GRID);
  for (let i = 0; i < xs.length; i++) {
    const px = Math.min(GRID - 1, Math.floor(((xs[i]! - box.x0) / box.w) * GRID)), py = Math.min(GRID - 1, Math.floor(((ys[i]! - box.y0) / box.h) * GRID));
    map[py * GRID + px]! += 1;
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(GRID * GRID), r = 3;
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < GRID && yy < GRID) { s += map[yy * GRID + xx]!; n++; }
      }
      next[y * GRID + x] = s / n;
    }
    map = next;
  }
  return map;
}

/**
 * Units as the viewer's table: a lab bundle already has a layout (x, y, neighbors, clusters) and labels.json; an EBO
 * bundle has embeddings, laid out here. Returns Arrow IPC bytes for DuckDB-WASM and the cluster labels.
 */
export async function prepareCloud(unitsBytes: Uint8Array, getEmbeddings: () => Promise<{ data: Float32Array; dimensions: number } | null>,
  status: (msg: string) => void): Promise<{ ipc: Uint8Array; labels: CloudLabel[] | null }> {
  const table = tableFromIPC(unitsBytes);
  if (table.schema.fields.some((f) => f.name === "x")) return { ipc: unitsBytes, labels: null };
  const embeddings = await getEmbeddings();
  if (!embeddings) throw new Error("This bundle has neither a layout nor embeddings for the cloud.");
  const { data, dimensions: d } = embeddings;
  const n = table.numRows;
  if (data.length !== n * d) throw new Error(`embeddings.f32 holds ${data.length / d} vectors for ${n} units.`);
  const col = (name: string) => table.getChild(name);
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({
    row_id: Number(col("row_id")!.get(i)), family: String(col("family")!.get(i)), unit_kind: String(col("unit_kind")!.get(i)), embed_text: String(col("embed_text")!.get(i) ?? ""),
    tool_kind: col("tool_kind")!.get(i) ?? null, command_head: col("command_head")!.get(i) ?? null, check_kind: col("check_kind")!.get(i) ?? null,
    target: col("target")!.get(i) ?? null, status: col("status")!.get(i) ?? null, occurrences: [...(col("occurrences")!.get(i)?.toArray?.() ?? [])].map(String),
  }));
  const x = new Float32Array(n), y = new Float32Array(n), cluster = new Int32Array(n).fill(-1);
  const clusterLabel: (string | null)[] = new Array(n).fill(null);
  const neighborIds: number[][] = Array.from({ length: n }, () => []), neighborDistances: number[][] = Array.from({ length: n }, () => []);
  const labels: CloudLabel[] = [];
  let offset = 0;
  for (const [fi, family] of FAMILIES.entries()) {
    const members = rows.filter((r) => r.family === family).map((r) => r.row_id);
    if (members.length < 10) continue;
    status(`Laying out ${members.length.toLocaleString()} ${family}…`);
    // Identical texts embed identically; lay out each distinct text once and place its units together.
    const unique = new Map<string, number>(), uniqueOf = new Int32Array(members.length), firstRow: number[] = [];
    members.forEach((row, i) => {
      const t = rows[row]!.embed_text;
      if (!unique.has(t)) { unique.set(t, unique.size); firstRow.push(row); }
      uniqueOf[i] = unique.get(t)!;
    });
    const m = firstRow.length, vectors = new Float32Array(m * d);
    firstRow.forEach((row, i) => vectors.set(data.subarray(row * d, (row + 1) * d), i * d));
    const umap = await createUMAP(m, d, 2, vectors, { metric: "cosine", nNeighbors: Math.min(15, m - 1), minDist: 0.1, seed: 42, initializeMethod: m < 50 ? "random" : "spectral" });
    await umap.run();
    const layout = new Float32Array(umap.embedding), k = umap.knnIndices.length / m;
    const knnIdx = umap.knnIndices, knnDist = umap.knnDistances;
    umap.destroy();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < m; i++) { minX = Math.min(minX, layout[2 * i]!); maxX = Math.max(maxX, layout[2 * i]!); minY = Math.min(minY, layout[2 * i + 1]!); maxY = Math.max(maxY, layout[2 * i + 1]!); }
    const fx = new Float32Array(members.length), fy = new Float32Array(members.length);
    members.forEach((row, i) => {
      const u = uniqueOf[i]!;
      fx[i] = x[row] = layout[2 * u]! - minX + offset; fy[i] = y[row] = layout[2 * u + 1]! - minY;
      for (let j = 0; j < k; j++) { const nb = knnIdx[u * k + j]!; if (nb !== u && nb >= 0) { neighborIds[row]!.push(firstRow[nb]!); neighborDistances[row]!.push(knnDist[u * k + j]!); } }
    });
    const box = { x0: offset, y0: 0, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
    offset += box.w * 1.12 + 1;
    // Density clusters; each unit joins the cluster whose boundary rectangles contain its pixel.
    const clusters = await findClusters(densityMap(fx, fy, box), GRID, GRID, { unionThreshold: 10 });
    const significant = clusters.filter((c) => c.pixelCount >= 4).sort((a, b) => b.sumDensity - a.sumDensity);
    const background = new Map<string, number>();
    for (const row of members) for (const f of new Set(facets(rows[row]!))) background.set(f, (background.get(f) ?? 0) + 1);
    significant.forEach((c, ci) => {
      const id = 1000 * (fi + 1) + ci;
      const inside = members.filter((row, i) => {
        const px = ((fx[i]! - box.x0) / box.w) * GRID, py = ((fy[i]! - box.y0) / box.h) * GRID;
        return cluster[row] === -1 && (c.boundaryRectApproximation ?? []).some(([x1, y1, x2, y2]) => px >= x1 && px <= x2 && py >= y1 && py <= y2);
      });
      if (inside.length < 5) return;
      const counts = new Map<string, number>();
      for (const row of inside) for (const f of new Set(facets(rows[row]!))) counts.set(f, (counts.get(f) ?? 0) + 1);
      const top = [...counts].filter(([, k2]) => k2 / inside.length >= 0.25)
        .map(([f, k2]) => [f, (k2 / inside.length) * Math.log((k2 / inside.length) / ((background.get(f) ?? 1) / members.length) + 1e-9)] as const)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
      const text = top.join(" · ") || family;
      for (const row of inside) { cluster[row] = id; clusterLabel[row] = text; }
      const xs = inside.map((row) => x[row]!).sort((a, b) => a - b), ys = inside.map((row) => y[row]!).sort((a, b) => a - b);
      labels.push({ x: xs[xs.length >> 1]!, y: ys[ys.length >> 1]!, text, level: 0, priority: inside.length });
    });
    labels.push({ x: box.x0 + box.w / 2, y: box.h + 0.5, text: family.toUpperCase(), level: 0, priority: 1e9 });
  }
  const neighborType = new Struct([new Field("ids", new List(new Field("item", new Int32(), true)), true), new Field("distances", new List(new Field("item", new Float32(), true)), true)]);
  const columns: Record<string, any> = Object.fromEntries(table.schema.fields.map((f) => [f.name, table.getChild(f.name)!]));
  const out = new Table({
    ...columns,
    x: makeVector(x), y: makeVector(y), cluster_id: makeVector(cluster),
    cluster_label: vectorFromArray(clusterLabel, new Utf8()),
    neighbors: vectorFromArray(neighborIds.map((ids, i) => ({ ids, distances: neighborDistances[i]! })), neighborType),
  });
  return { ipc: tableToIPC(out, "stream"), labels };
}
