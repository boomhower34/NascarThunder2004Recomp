// nv2a-vsh.mjs — Xbox (NV2A) vertex shader microcode: decoder and a compiler to JavaScript functions.
//
// The game's vertex shaders are binaries made by the XDK shader assembler: a header dword (low word 0x2078,
// high word = instruction count) followed by 128-bit instructions (4 dwords; dword 0 unused). Each instruction
// pairs a vector op (MAC) with a scalar op (ILU), reads up to three operands A, B, C (temporary R, input V or
// constant C, with swizzle and negate) and writes temporaries and/or one output (o[] or c[]). The field layout is
// the one used by xemu / Cxbx-Reloaded (vsh.c field mapping).
//
// Registers: v0-v15 inputs; r0-r11 temporaries (r12 reads oPos); c0-c191 constants (the API's c-96..c95, so
// API register n is c[n + 96]); a0.x address register. Outputs by address: 0 oPos, 3 oD0, 4 oD1, 5 oFog, 6 oPts,
// 7 oB0, 8 oB1, 9-12 oT0-oT3. The assembler appends the viewport transform (c-38 scale, c-37 offset), so oPos
// leaves the shader in screen space (x, y in pixels, z in depth-buffer units) with w kept for perspective.
//
// compileVsh(words) -> fn(V, C, O): V Float32Array(16*4) inputs, C Float32Array(192*4) constants (can be written:
// shaders may store to c[]), O Float32Array(13*4) outputs indexed by output address.

const FIELDS = {     // name: [dword, bit, size]
  ILU: [1, 25, 3], MAC: [1, 21, 4], CONST: [1, 13, 8], V: [1, 9, 4],
  A_NEG: [1, 8, 1], A_SWZ_X: [1, 6, 2], A_SWZ_Y: [1, 4, 2], A_SWZ_Z: [1, 2, 2], A_SWZ_W: [1, 0, 2], A_R: [2, 28, 4], A_MUX: [2, 26, 2],
  B_NEG: [2, 25, 1], B_SWZ_X: [2, 23, 2], B_SWZ_Y: [2, 21, 2], B_SWZ_Z: [2, 19, 2], B_SWZ_W: [2, 17, 2], B_R: [2, 13, 4], B_MUX: [2, 11, 2],
  C_NEG: [2, 10, 1], C_SWZ_X: [2, 8, 2], C_SWZ_Y: [2, 6, 2], C_SWZ_Z: [2, 4, 2], C_SWZ_W: [2, 2, 2], C_R_HIGH: [2, 0, 2], C_R_LOW: [3, 30, 2], C_MUX: [3, 28, 2],
  OUT_MAC_MASK: [3, 24, 4], OUT_R: [3, 20, 4], OUT_ILU_MASK: [3, 16, 4], OUT_O_MASK: [3, 12, 4], OUT_ORB: [3, 11, 1], OUT_ADDRESS: [3, 3, 8], OUT_MUX: [3, 2, 1],
  A0X: [3, 1, 1], FINAL: [3, 0, 1],
};
export const MAC_OPS = ["nop", "mov", "mul", "add", "mad", "dp3", "dph", "dp4", "dst", "min", "max", "slt", "sge", "arl"];
export const ILU_OPS = ["nop", "mov", "rcp", "rcc", "rsq", "exp", "log", "lit"];
export const OUTPUTS = { 0: "oPos", 3: "oD0", 4: "oD1", 5: "oFog", 6: "oPts", 7: "oB0", 8: "oB1", 9: "oT0", 10: "oT1", 11: "oT2", 12: "oT3" };

export function decodeInstruction(d) {
  const f = {}; for (const [k, [w, b, s]] of Object.entries(FIELDS)) f[k] = (d[w] >>> b) & ((1 << s) - 1);
  const op = p => ({ neg: f[p + "_NEG"], swz: [f[p + "_SWZ_X"], f[p + "_SWZ_Y"], f[p + "_SWZ_Z"], f[p + "_SWZ_W"]], mux: f[p + "_MUX"],
    r: p === "C" ? (f.C_R_HIGH << 2) | f.C_R_LOW : f[p + "_R"] });
  return { mac: f.MAC, ilu: f.ILU, konst: f.CONST, v: f.V, a: op("A"), b: op("B"), c: op("C"), macMask: f.OUT_MAC_MASK, outR: f.OUT_R,
    iluMask: f.OUT_ILU_MASK, oMask: f.OUT_O_MASK, orb: f.OUT_ORB, oAddr: f.OUT_ADDRESS, oMux: f.OUT_MUX, a0x: f.A0X, final: f.FINAL };
}

// read a shader binary from memory: { words: Uint32Array of instructions (4 per), count }
export function readVsh(mem, addr) {
  const hdr = mem.r32(addr), count = hdr >>> 16;
  if ((hdr & 0xffff) !== 0x2078 && (hdr & 0xffff) !== 0x7778) return null;
  const words = new Uint32Array(count * 4); for (let i = 0; i < count * 4; i++) words[i] = mem.r32(addr + 4 + i * 4);
  return { words, count, type: hdr & 0xffff };
}

const MASK = ["x", "y", "z", "w"];
export function disassemble(words) {
  const out = [];
  for (let i = 0; i * 4 < words.length; i++) {
    const n = decodeInstruction(words.subarray(i * 4, i * 4 + 4));
    const src = o => `${o.neg ? "-" : ""}${o.mux === 1 ? "r" + o.r : o.mux === 2 ? "v" + n.v : `c[${n.konst - 96}${n.a0x ? "+a0.x" : ""}]`}.${o.swz.map(s => MASK[s]).join("")}`;
    const m = k => MASK.filter((_, j) => k & (8 >> j)).join("");
    let s = "";
    if (n.mac) s += `${MAC_OPS[n.mac]} ${n.macMask ? `r${n.outR}.${m(n.macMask)}` : ""}${n.oMask && !n.oMux ? ` ${n.orb ? OUTPUTS[n.oAddr] ?? "o" + n.oAddr : `c[${n.oAddr - 96}]`}.${m(n.oMask)}` : ""}, ${src(n.a)}, ${src(n.b)}, ${src(n.c)}`;
    if (n.ilu) s += ` + ${ILU_OPS[n.ilu]} ${n.iluMask ? `r${n.mac ? 1 : n.outR}.${m(n.iluMask)}` : ""}${n.oMask && n.oMux ? ` ${n.orb ? OUTPUTS[n.oAddr] ?? "o" + n.oAddr : `c[${n.oAddr - 96}]`}.${m(n.oMask)}` : ""}, ${src(n.c)}`;
    out.push(s); if (n.final) break;
  }
  return out;
}

// which constants a shader reads (API numbering), e.g. to see whether it uses the viewport constants -38/-37
export function constantsRead(words) {
  const s = new Set();
  for (let i = 0; i * 4 < words.length; i++) { const n = decodeInstruction(words.subarray(i * 4, i * 4 + 4));
    if ([n.a, n.b, n.c].some(o => o.mux === 3)) s.add(n.a0x ? "indexed" : n.konst - 96); if (n.final) break; }
  return s;
}

export function compileVsh(words) {
  const L = ["let a0 = 0, m0, m1, m2, m3, i0, i1, i2, i3, s;", "const R = new Float32Array(13 * 4);"];
  const read = (n, o, j) => {
    const k = o.swz[j]; let e;
    if (o.mux === 1) e = o.r === 12 ? `O[${k}]` : `R[${o.r * 4 + k}]`;
    else if (o.mux === 2) e = `V[${n.v * 4 + k}]`;
    else e = n.a0x ? `(C[(((${n.konst} + a0) & 255) * 4) + ${k}] || 0)` : `C[${n.konst * 4 + k}]`;
    return o.neg ? `(-${e})` : e;
  };
  for (let i = 0; i * 4 < words.length; i++) {
    const n = decodeInstruction(words.subarray(i * 4, i * 4 + 4));
    const A = [0, 1, 2, 3].map(j => read(n, n.a, j)), B = [0, 1, 2, 3].map(j => read(n, n.b, j)), Cc = [0, 1, 2, 3].map(j => read(n, n.c, j));
    L.push("{");
    // read all operands first (an instruction's writes do not affect its own reads)
    L.push(`const a = [${A}], b = [${B}], c = [${Cc}];`);
    switch (MAC_OPS[n.mac]) {
      case "mov": L.push("m0 = a[0]; m1 = a[1]; m2 = a[2]; m3 = a[3];"); break;
      case "mul": L.push("m0 = a[0] * b[0]; m1 = a[1] * b[1]; m2 = a[2] * b[2]; m3 = a[3] * b[3];"); break;
      case "add": L.push("m0 = a[0] + c[0]; m1 = a[1] + c[1]; m2 = a[2] + c[2]; m3 = a[3] + c[3];"); break;
      case "mad": L.push("m0 = a[0] * b[0] + c[0]; m1 = a[1] * b[1] + c[1]; m2 = a[2] * b[2] + c[2]; m3 = a[3] * b[3] + c[3];"); break;
      case "dp3": L.push("m0 = m1 = m2 = m3 = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];"); break;
      case "dph": L.push("m0 = m1 = m2 = m3 = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + b[3];"); break;
      case "dp4": L.push("m0 = m1 = m2 = m3 = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];"); break;
      case "dst": L.push("m0 = 1; m1 = a[1] * b[1]; m2 = a[2]; m3 = b[3];"); break;
      case "min": L.push("m0 = Math.min(a[0], b[0]); m1 = Math.min(a[1], b[1]); m2 = Math.min(a[2], b[2]); m3 = Math.min(a[3], b[3]);"); break;
      case "max": L.push("m0 = Math.max(a[0], b[0]); m1 = Math.max(a[1], b[1]); m2 = Math.max(a[2], b[2]); m3 = Math.max(a[3], b[3]);"); break;
      case "slt": L.push("m0 = +(a[0] < b[0]); m1 = +(a[1] < b[1]); m2 = +(a[2] < b[2]); m3 = +(a[3] < b[3]);"); break;
      case "sge": L.push("m0 = +(a[0] >= b[0]); m1 = +(a[1] >= b[1]); m2 = +(a[2] >= b[2]); m3 = +(a[3] >= b[3]);"); break;
      case "arl": L.push("a0 = Math.floor(a[0] + 0.001); m0 = m1 = m2 = m3 = 0;"); break;
    }
    switch (ILU_OPS[n.ilu]) {
      case "mov": L.push("i0 = c[0]; i1 = c[1]; i2 = c[2]; i3 = c[3];"); break;
      case "rcp": L.push("i0 = i1 = i2 = i3 = c[0] === 1 ? 1 : 1 / c[0];"); break;
      case "rcc": L.push("s = 1 / c[0]; s = s > 0 ? Math.min(Math.max(s, 5.42101e-20), 1.884467e19) : Math.max(Math.min(s, -5.42101e-20), -1.884467e19); i0 = i1 = i2 = i3 = s;"); break;
      case "rsq": L.push("i0 = i1 = i2 = i3 = 1 / Math.sqrt(Math.abs(c[0]));"); break;
      case "exp": L.push("s = Math.floor(c[0]); i0 = Math.pow(2, s); i1 = c[0] - s; i2 = Math.pow(2, c[0]); i3 = 1;"); break;
      case "log": L.push("s = Math.abs(c[0]); if (s === 0) { i0 = i2 = -Infinity; i1 = 1; } else { i0 = Math.floor(Math.log2(s)); i1 = s / Math.pow(2, i0); i2 = Math.log2(s); } i3 = 1;"); break;
      case "lit": L.push("s = Math.max(-127.9961, Math.min(127.9961, c[3])); i0 = 1; i1 = Math.max(c[0], 0); i2 = c[0] > 0 ? Math.pow(Math.max(c[1], 0), s) : 0; i3 = 1;"); break;
    }
    const wr = (dst, mask, v) => { for (let j = 0; j < 4; j++) if (mask & (8 >> j)) L.push(`${dst(j)} = ${v}${j};`); };
    if (n.mac && n.macMask) wr(j => n.outR === 12 ? `O[${j}]` : `R[${n.outR * 4 + j}]`, n.macMask, "m");
    if (n.ilu && n.iluMask) { const r = n.mac ? 1 : n.outR; wr(j => r === 12 ? `O[${j}]` : `R[${r * 4 + j}]`, n.iluMask, "i"); }
    if (n.oMask) {
      const v = n.oMux ? "i" : "m";
      if (n.orb) wr(j => `O[${n.oAddr * 4 + j}]`, n.oMask, v);
      else wr(j => `C[${(n.oAddr & 255) * 4 + j}]`, n.oMask, v);
    }
    L.push("}");
    if (n.final) break;
  }
  return new Function("V", "C", "O", L.join("\n"));
}

// ---------------------------------------------------------------------- GLSL (WebGL2) translation
// vshToGLSL(words, regs, screen) -> GLSL ES 3.00 vertex shader source for the WebGL backend (play-client.js).
//   regs: the declaration's inputs [{ reg, type }] (NV2A types: 0x12-0x42 float1-4, 0x15/0x25.. short normalized,
//         0x14.. ubyte normalized, 0x40 D3DCOLOR (BGRA bytes), 0x16 NORMPACKED3 (11:11:10), 0x72 FLOAT2H (x, y, w)).
//         Inputs not declared read (0, 0, 0, 1). Attribute location = register number.
//   screen: the program ends in screen space (reads the viewport constants c-38/c-37, see the header comment):
//         oPos.xy in render-target pixels, z in depth-buffer units, w the clip w; it is turned back into clip
//         coordinates with uRT = (target width, height, depth scale; negative: depth z in [-64, 64] squeezed into the
//         depth range, for the front-end car preview's thin projection slab) so the GPU clips and interpolates as the
//         NV2A does. Otherwise oPos is D3D clip space (z 0..w) and the viewport comes from glViewport.
// Varyings: vD0 vD1 (oD0/oD1), vFog (oFog.x), vT0-vT3 (oT0-oT3).
export function vshToGLSL(words, regs, screen) {
  const S = "xyzw", L = [];
  const used = new Map(regs.map(r => [r.reg, r.type]));
  const head = ["#version 300 es", "precision highp float;", "precision highp int;", "uniform vec4 C[192];", "uniform vec3 uRT;"];
  for (const [reg, type] of used) head.push(type === 0x16 ? `layout(location = ${reg}) in highp uint a${reg};` : `layout(location = ${reg}) in vec4 a${reg};`);
  head.push("out vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;");
  const conv = (reg, type) => {
    if (type === 0x40) return `a${reg}.zyxw`;                                       // D3DCOLOR: bytes B G R A
    if (type === 0x16) return `vec4(float(int(a${reg} << 21) >> 21) / 1023.0, float(int(a${reg} << 10) >> 21) / 1023.0, float(int(a${reg}) >> 22) / 511.0, 1.0)`;
    if (type === 0x72) return `vec4(a${reg}.x, a${reg}.y, 0.0, a${reg}.z)`;
    if ((type & 0xf) === 1) return `max(a${reg}, vec4(-1.0))`;                      // normalized short: -32768 -> -1
    return `a${reg}`;
  };
  L.push("void main() {");
  for (let r = 0; r < 16; r++) L.push(`  vec4 v${r} = ${used.has(r) ? conv(r, used.get(r)) : "vec4(0.0, 0.0, 0.0, 1.0)"};`);
  L.push("  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);");
  L.push("  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);");
  L.push("  int a0 = 0; vec4 m, i; float s;");
  const read = (n, o) => {
    let e;
    if (o.mux === 1) e = o.r === 12 ? "O[0]" : `R[${Math.min(o.r, 11)}]`;
    else if (o.mux === 2) e = `v${n.v}`;
    else e = n.a0x ? `C[clamp(${n.konst} + a0, 0, 191)]` : `C[${n.konst}]`;
    const sw = o.swz.map(k => S[k]).join("");
    return `${o.neg ? "-" : ""}${e}${sw === "xyzw" ? "" : "." + sw}`;
  };
  let writesC = false;
  for (let k = 0; k * 4 < words.length; k++) {
    const n = decodeInstruction(words.subarray(k * 4, k * 4 + 4));
    L.push(`  { vec4 a = ${read(n, n.a)}, b = ${read(n, n.b)}, c = ${read(n, n.c)};`);
    switch (MAC_OPS[n.mac]) {
      case "mov": L.push("    m = a;"); break;
      case "mul": L.push("    m = a * b;"); break;
      case "add": L.push("    m = a + c;"); break;
      case "mad": L.push("    m = a * b + c;"); break;
      case "dp3": L.push("    m = vec4(dot(a.xyz, b.xyz));"); break;
      case "dph": L.push("    m = vec4(dot(a.xyz, b.xyz) + b.w);"); break;
      case "dp4": L.push("    m = vec4(dot(a, b));"); break;
      case "dst": L.push("    m = vec4(1.0, a.y * b.y, a.z, b.w);"); break;
      case "min": L.push("    m = min(a, b);"); break;
      case "max": L.push("    m = max(a, b);"); break;
      case "slt": L.push("    m = vec4(lessThan(a, b));"); break;
      case "sge": L.push("    m = vec4(greaterThanEqual(a, b));"); break;
      case "arl": L.push("    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);"); break;
    }
    switch (ILU_OPS[n.ilu]) {
      case "mov": L.push("    i = c;"); break;
      case "rcp": L.push("    i = vec4(c.x == 1.0 ? 1.0 : 1.0 / c.x);"); break;
      case "rcc": L.push("    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);"); break;
      case "rsq": L.push("    i = vec4(inversesqrt(abs(c.x)));"); break;
      case "exp": L.push("    s = floor(c.x); i = vec4(exp2(s), c.x - s, exp2(c.x), 1.0);"); break;
      case "log": L.push("    s = abs(c.x); if (s == 0.0) i = vec4(-3.4e38, 1.0, -3.4e38, 1.0); else { float e = floor(log2(s)); i = vec4(e, s / exp2(e), log2(s), 1.0); }"); break;
      case "lit": L.push("    s = clamp(c.w, -127.9961, 127.9961); i = vec4(1.0, max(c.x, 0.0), c.x > 0.0 ? pow(max(c.y, 0.0), s) : 0.0, 1.0);"); break;
    }
    const mask = k4 => S.split("").filter((_, j) => k4 & (8 >> j)).join("");
    const wr = (dst, k4, v) => { const mk = mask(k4); if (mk) L.push(`    ${dst}.${mk} = ${v}.${mk};`); };
    const reg = r => r === 12 ? "O[0]" : `R[${Math.min(r, 11)}]`;
    if (n.mac && n.macMask) wr(reg(n.outR), n.macMask, "m");
    if (n.ilu && n.iluMask) wr(reg(n.mac ? 1 : n.outR), n.iluMask, "i");
    if (n.oMask) { if (n.orb) { if (n.oAddr < 13) wr(`O[${n.oAddr}]`, n.oMask, n.oMux ? "i" : "m"); } else writesC = true; }
    L.push("  }");
    if (n.final) break;
  }
  // A vertex almost exactly on the camera plane (|w| < 1e-3; the near plane sits at w ~ 0.4 in the race views, so it
  // is clipped away whatever its w) gets w = -1e-3, its x, y, z kept: a nearby car's mesh straddling the camera had a
  // vertex at w = -8.7e-8, and on real GPUs (ANGLE / D3D11, which clip w and test depth per pixel) its triangles came
  // out as a long solid wedge of the car's colour across the screen, pointing the mirrored way. Exact clipping
  // (SwiftShader, the math) draws nothing there. The shift moves the near-plane crossing of its edges by ~0.2%.
  if (screen) L.push("  vec4 P = O[0]; float w = P.w;",
    "  float zn = P.z / abs(uRT.z);",
    "  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);",
    "  gl_Position = vec4(nd * w, abs(w) < 1e-3 ? -1e-3 : w);");
  else L.push("  gl_Position = vec4(O[0].x, O[0].y, uRT.z < 0.0 ? O[0].z / 64.0 : O[0].z * 2.0 - O[0].w, abs(O[0].w) < 1e-3 ? -1e-3 : O[0].w);");
  L.push("  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];", "}");
  return { src: head.join("\n") + "\n" + L.join("\n"), writesC };
}
