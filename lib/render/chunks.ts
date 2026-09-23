// Spatial chunking for circuit-wide static geometry. A merged mesh that
// spans a whole 5km circuit has a bounding sphere containing the whole
// circuit, so three can never frustum-cull it - every triangle is drawn
// every frame, and again for the shadow map. Split into grid cells, each
// chunk gets its own bounds and whatever is behind the camera (or outside
// the shadow box) is skipped.

export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Optional per-vertex RGB, carried through the split. */
  colors?: Float32Array;
}

/**
 * Splits a triangle mesh into square cells by triangle centroid (x/z),
 * re-indexing vertices per chunk. Every triangle lands in exactly one
 * chunk, so the union draws exactly the original mesh.
 */
export function chunkMesh(mesh: IndexedMesh, cellMeters: number): IndexedMesh[] {
  const { positions, indices, colors } = mesh;
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    const key = `${Math.floor(cx / cellMeters)},${Math.floor(cz / cellMeters)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(t);
  }
  const chunks: IndexedMesh[] = [];
  for (const tris of buckets.values()) {
    const remap = new Map<number, number>();
    const outIndices = new Uint32Array(tris.length * 3);
    let k = 0;
    for (const t of tris) {
      for (let v = 0; v < 3; v++) {
        const src = indices[t + v];
        let dst = remap.get(src);
        if (dst === undefined) remap.set(src, (dst = remap.size));
        outIndices[k++] = dst;
      }
    }
    const outPositions = new Float32Array(remap.size * 3);
    const outColors = colors ? new Float32Array(remap.size * 3) : undefined;
    for (const [src, dst] of remap) {
      outPositions.set(positions.subarray(src * 3, src * 3 + 3), dst * 3);
      if (outColors && colors) outColors.set(colors.subarray(src * 3, src * 3 + 3), dst * 3);
    }
    chunks.push({ positions: outPositions, indices: outIndices, colors: outColors });
  }
  return chunks;
}

/** Groups point instances (trees) into the same kind of cells. */
export function chunkPoints<T extends { x: number; z: number }>(items: readonly T[], cellMeters: number): T[][] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = `${Math.floor(item.x / cellMeters)},${Math.floor(item.z / cellMeters)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(item);
  }
  return [...buckets.values()];
}

/**
 * Deterministic thinning: keeps roughly `density` of the items, spread
 * evenly (a stride pattern, not the first N), and always the same ones for
 * the same density so a tier change never reshuffles the forest.
 */
export function thin<T>(items: readonly T[], density: number): T[] {
  if (density >= 1) return [...items];
  const keep = Math.round(Math.max(0, density) * 100);
  return items.filter((_, i) => ((i * 37) % 100) < keep);
}
