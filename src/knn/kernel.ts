// EXACT kNN on the GPU — one WGSL brute-force kernel, host-free: the caller hands in a `GPU` object
// (the browser's `navigator.gpu`, or node's via the `webgpu` npm package — Dawn's own bindings). The
// kernel computes, for every vector, its true top-K cosine neighbors over the whole set. No index, no
// approximation: recall is 1.0 by construction, verified against CPU brute force in test/knn.test.ts.
//
// Shape: one workgroup per query. Each of the WG threads scans a strided slice of the database keeping
// a private sorted top-K (insertion into a K-length register array), then thread 0 merges the WG*K
// candidates. Queries are tiled TILE per dispatch (dispatch limit is 65535 workgroups/dim, and the tile
// also bounds the readback staging buffers). Measured on apple metal-3 (2026-08): 0.27s @ 10k,
// 23.7s @ 100k in Chromium; 0.19s @ 10k, 23.9s @ 100k, 162s @ 230k under node/bun via `webgpu` —
// output byte-identical across hosts, recall 1.0 everywhere.
//
// KNOWN HEADROOM, deliberately not taken: the kernel is untiled over the database and bandwidth-bound
// (~0.3 of ~3-4 TFLOP/s effective on this hardware) — a database-tiled successor that stages db rows
// through workgroup memory would drop in HERE (the shader is an isolated string; nothing outside this
// file knows its shape). Do not spread its structure around.

// WebGPU usage/map flag values (spec constants) — spelled locally so the module typechecks under a
// tsconfig without the WebGPU DOM globals (the node host gets them from Dawn at runtime, not tsc).
const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const MAP_READ = 0x1;

const WG = 64;    // threads per workgroup (webgpufundamentals guidance; measured fine on metal-3)
const TILE = 4096; // queries per dispatch

const shaderFor = (D: number, K: number) => `
struct Params { n: u32, qBase: u32, qCount: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> data: array<f32>;    // n x D, L2-normalized
@group(0) @binding(1) var<storage, read_write> outIdx: array<u32>;   // qCount x K
@group(0) @binding(2) var<storage, read_write> outScore: array<f32>; // qCount x K (cosine sims)
@group(0) @binding(3) var<uniform> p: Params;

var<workgroup> q: array<f32, ${D}>;
var<workgroup> candScore: array<f32, ${WG * K}>;
var<workgroup> candIdx: array<u32, ${WG * K}>;

@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let qi = p.qBase + wid.x;         // global query index (self-query: queries ARE the data rows)
  if (wid.x >= p.qCount) { return; }
  let t = lid.x;
  for (var j = t; j < ${D}u; j += ${WG}u) { q[j] = data[qi * ${D}u + j]; }
  workgroupBarrier();
  var bs: array<f32, ${K}>;
  var bi: array<u32, ${K}>;
  for (var m = 0u; m < ${K}u; m++) { bs[m] = -2.0; bi[m] = 0xffffffffu; }
  for (var v = t; v < p.n; v += ${WG}u) {
    if (v == qi) { continue; } // exclude self
    var dot = 0.0;
    let base = v * ${D}u;
    for (var j = 0u; j < ${D}u; j += 4u) {
      dot += data[base+j]*q[j] + data[base+j+1u]*q[j+1u] + data[base+j+2u]*q[j+2u] + data[base+j+3u]*q[j+3u];
    }
    if (dot > bs[${K - 1}u]) {
      var m = ${K - 1}u;
      loop {
        if (m > 0u && bs[m - 1u] < dot) { bs[m] = bs[m-1u]; bi[m] = bi[m-1u]; m -= 1u; }
        else { break; }
      }
      bs[m] = dot; bi[m] = v;
    }
  }
  for (var m = 0u; m < ${K}u; m++) { candScore[t * ${K}u + m] = bs[m]; candIdx[t * ${K}u + m] = bi[m]; }
  workgroupBarrier();
  if (t == 0u) {
    var fs: array<f32, ${K}>;
    var fi: array<u32, ${K}>;
    for (var m = 0u; m < ${K}u; m++) { fs[m] = -2.0; fi[m] = 0xffffffffu; }
    for (var c = 0u; c < ${WG * K}u; c++) {
      let s = candScore[c];
      if (s > fs[${K - 1}u]) {
        var m = ${K - 1}u;
        loop {
          if (m > 0u && fs[m - 1u] < s) { fs[m] = fs[m-1u]; fi[m] = fi[m-1u]; m -= 1u; }
          else { break; }
        }
        fs[m] = s; fi[m] = candIdx[c];
      }
    }
    let ob = wid.x * ${K}u;
    for (var m = 0u; m < ${K}u; m++) { outIdx[ob + m] = fi[m]; outScore[ob + m] = fs[m]; }
  }
}`;

// Can this GPU take the job at this size? (adapter present + storage binding big enough for the flat data)
export async function gpuAdapterFor(gpu: GPU | null | undefined, n: number, dim: number): Promise<GPUAdapter | null> {
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return null;
  const padded = Math.ceil(dim / 4) * 4;
  if (adapter.limits.maxStorageBufferBindingSize < n * padded * 4) return null;
  return adapter;
}

// Exact top-K cosine neighbors of every row of X against all of X (self excluded), on the GPU.
// Returns SELF-INCLUSIVE rows ([i, ...K neighbors]) + matching distances converted to
// euclidean-on-the-unit-sphere (sqrt(2·cosineDist)) — the same (indices, distances) convention as
// src/map.ts knnIndex / umap-js setPrecomputedKNN. X must be unit vectors (dot == cosine).
// NOTE: requests its OWN adapter every call — the WebGPU spec marks an adapter "consumed" once it has
// created a device (Dawn enforces this), so a held GPUAdapter is single-use. gpuAdapterFor is the
// cheap fitness probe; this does the work.
export async function exactGpuKnn(gpu: GPU, X: number[][], K: number): Promise<{ idx: number[][]; dst: number[][] }> {
  const n = X.length, dim = X[0].length;
  const adapter = await gpuAdapterFor(gpu, n, dim);
  if (!adapter) throw new Error("no WebGPU adapter fit for this corpus size");
  const Kc = Math.min(K, n - 1);
  const D = Math.ceil(dim / 4) * 4; // shader consumes 4 lanes at a time; zero-pad (zeros don't move dots)
  const flat = new Float32Array(n * D);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) flat[i * D + j] = X[i][j];

  const device = await adapter.requestDevice({ requiredLimits: {
    // default binding limit is 128MB — a 100k x 384 f32 corpus is 154MB, so raise to what the adapter allows
    maxStorageBufferBindingSize: Math.min(Math.max(flat.byteLength, 134217728), adapter.limits.maxStorageBufferBindingSize),
    maxBufferSize: Math.min(Math.max(flat.byteLength, 268435456), adapter.limits.maxBufferSize),
  } });
  try {
    const dataBuf = device.createBuffer({ size: flat.byteLength, usage: USAGE.STORAGE | USAGE.COPY_DST });
    device.queue.writeBuffer(dataBuf, 0, flat);
    const outIdxBuf = device.createBuffer({ size: TILE * Kc * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    const outScoreBuf = device.createBuffer({ size: TILE * Kc * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    const stageIdx = device.createBuffer({ size: TILE * Kc * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    const stageScore = device.createBuffer({ size: TILE * Kc * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    const paramBuf = device.createBuffer({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });
    const module = device.createShaderModule({ code: shaderFor(D, Kc) });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: dataBuf } },
      { binding: 1, resource: { buffer: outIdxBuf } },
      { binding: 2, resource: { buffer: outScoreBuf } },
      { binding: 3, resource: { buffer: paramBuf } },
    ] });

    const neighbors = new Int32Array(n * Kc), sims = new Float32Array(n * Kc);
    for (let qBase = 0; qBase < n; qBase += TILE) {
      const qCount = Math.min(TILE, n - qBase);
      device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, qBase, qCount, 0]));
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(qCount);
      pass.end();
      enc.copyBufferToBuffer(outIdxBuf, 0, stageIdx, 0, qCount * Kc * 4);
      enc.copyBufferToBuffer(outScoreBuf, 0, stageScore, 0, qCount * Kc * 4);
      device.queue.submit([enc.finish()]);
      await Promise.all([stageIdx.mapAsync(MAP_READ, 0, qCount * Kc * 4), stageScore.mapAsync(MAP_READ, 0, qCount * Kc * 4)]);
      neighbors.set(new Int32Array(stageIdx.getMappedRange(0, qCount * Kc * 4)).subarray(0, qCount * Kc), qBase * Kc);
      sims.set(new Float32Array(stageScore.getMappedRange(0, qCount * Kc * 4)).subarray(0, qCount * Kc), qBase * Kc);
      stageIdx.unmap(); stageScore.unmap();
    }
    const idx: number[][] = [], dst: number[][] = [];
    for (let i = 0; i < n; i++) {
      const ri = [i], rd = [0];
      for (let m = 0; m < Kc; m++) {
        const j = neighbors[i * Kc + m];
        if (j < 0 || j >= n) continue; // 0xffffffff sentinel when n-1 < K
        ri.push(j);
        rd.push(Math.sqrt(Math.max(0, 2 * (1 - sims[i * Kc + m]))));
      }
      idx.push(ri); dst.push(rd);
    }
    return { idx, dst };
  } finally {
    device.destroy();
  }
}
