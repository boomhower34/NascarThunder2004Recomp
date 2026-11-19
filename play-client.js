// play-client.js — the browser half of the live view (served by main.mjs): draws the frames the emulator records
// (gl-remote.mjs) with WebGL2, composites the UI overlay, and turns keyboard / gamepad input into the virtual Xbox
// pad (xinput-hle.mjs) with a mapping the player can change.
//
// GPU side of the NV2A: vertex programs arrive as GLSL (nv2a-vsh.mjs vshToGLSL); the pixel side is one fragment
// shader that runs the register combiners (or the D3D texture stage pipeline) from uniforms — the same rules as
// soft-renderer.mjs, which is the reference picture.

"use strict";
const canvas = document.getElementById("view"), gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
// depth clamp as the NV2A: depth outside [0, 1] is clamped, not clipped (the front-end car preview's projection is a
// 20-unit slab around the car); without the extension such geometry is clipped
// depth clamp (EXT_depth_clamp): the game sets NV097 SET_ZMIN_MAX_CONTROL to 0 (ZEnable through 0x19CEB8): no near /
// far clipping, depth clamped to the range — the player's car in the chase view reaches in front of the near plane
{ const dc = gl.getExtension("EXT_depth_clamp"); if (dc) gl.enable(dc.DEPTH_CLAMP_EXT); }
const status = document.getElementById("status");
if (!gl) { status.textContent = "WebGL2 is not available in this browser"; throw new Error("no webgl2"); }

// ------------------------------------------------------------------ shaders
const FRAG = `#version 300 es
precision highp float; precision highp int;
in vec4 vD0; in vec4 vD1; in vec4 vT0; in vec4 vT1; in vec4 vT2; in vec4 vT3; in float vFog;
uniform sampler2D t0; uniform sampler2D t1; uniform sampler2D t2; uniform sampler2D t3;
uniform ivec4 uTexOn; uniform ivec4 uTexLinear; uniform ivec4 uTexFlip; uniform vec4 uTexSize[4];
uniform int uMode; uniform ivec4 uTexModes;
uniform uint uRgbIn[8]; uniform uint uRgbOut[8]; uniform uint uAlphaIn[8]; uniform uint uAlphaOut[8]; uniform uint uC0[8]; uniform uint uC1[8];
uniform uint uFinalABCD; uniform uint uFinalEFG; uniform uint uFc0; uniform uint uFc1; uniform uint uCountFlags; uniform int uCount;
uniform ivec4 uCop; uniform ivec4 uCa1; uniform ivec4 uCa2; uniform ivec4 uAop; uniform ivec4 uAa1; uniform ivec4 uAa2;
uniform uint uTFactor; uniform uint uFogColor; uniform int uAlphaFunc; uniform float uAlphaRef;
out vec4 frag;
vec4 argb(uint x) { return vec4(float((x >> 16) & 255u), float((x >> 8) & 255u), float(x & 255u), float(x >> 24)) / 255.0; }
vec4 fetchTex(int s, vec4 tc) {
  int mode = uMode == 1 ? uTexModes[s] : (uTexOn[s] != 0 ? 1 : 0);
  if (mode == 4) return clamp(tc, 0.0, 1.0);
  if (uTexOn[s] == 0 || mode == 0) return uMode == 1 ? vec4(0.0) : vec4(1.0);
  float q = (mode == 2 && tc.w != 0.0) ? tc.w : 1.0;
  vec2 uv = tc.xy / q;
  if (uTexLinear[s] != 0) uv /= uTexSize[s].xy;
  if (uTexFlip[s] != 0) uv.y = 1.0 - uv.y;
  if (s == 0) return texture(t0, uv); if (s == 1) return texture(t1, uv); if (s == 2) return texture(t2, uv); return texture(t3, uv);
}
vec4 REG[16];
float mapIn(float x, int m) {
  if (m == 0) return max(0.0, x); if (m == 1) return 1.0 - clamp(x, 0.0, 1.0); if (m == 2) return 2.0 * max(0.0, x) - 1.0;
  if (m == 3) return -2.0 * max(0.0, x) + 1.0; if (m == 4) return max(0.0, x) - 0.5; if (m == 5) return -max(0.0, x) + 0.5;
  if (m == 6) return x; return -x;
}
vec3 inRGB(uint code) { vec4 R = REG[int(code & 15u)]; int m = int((code >> 5) & 7u);
  if (((code >> 4) & 1u) == 1u) return vec3(mapIn(R.a, m)); return vec3(mapIn(R.r, m), mapIn(R.g, m), mapIn(R.b, m)); }
float inA(uint code) { vec4 R = REG[int(code & 15u)]; return mapIn(((code >> 4) & 1u) == 1u ? R.a : R.b, int((code >> 5) & 7u)); }
float outScale(float x, uint m) { if (m == 1u) return x - 0.5; if (m == 2u) return x * 2.0; if (m == 3u) return (x - 0.5) * 2.0; if (m == 4u) return x * 4.0; if (m == 6u) return x / 2.0; return x; }
vec3 outScale3(vec3 x, uint m) { return vec3(outScale(x.r, m), outScale(x.g, m), outScale(x.b, m)); }
vec3 finRGB(uint code) { vec4 R = REG[int(code & 15u)]; bool inv = ((code >> 5) & 1u) == 1u;
  vec3 x = ((code >> 4) & 1u) == 1u ? vec3(R.a) : R.rgb; x = clamp(x, 0.0, 1.0); return inv ? 1.0 - x : x; }
float finA(uint code) { vec4 R = REG[int(code & 15u)]; float x = clamp(((code >> 4) & 1u) == 1u ? R.a : R.b, 0.0, 1.0); return ((code >> 5) & 1u) == 1u ? 1.0 - x : x; }
vec4 combiners(vec4 tex[4]) {
  for (int k = 0; k < 16; k++) REG[k] = vec4(0.0);
  REG[3] = vec4(argb(uFogColor).rgb, clamp(vFog, 0.0, 1.0));
  REG[4] = clamp(vD0, 0.0, 1.0); REG[5] = clamp(vD1, 0.0, 1.0);
  REG[8] = tex[0]; REG[9] = tex[1]; REG[10] = tex[2]; REG[11] = tex[3];
  REG[12].a = REG[8].a;
  int n = clamp(uCount, 1, 8);
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    REG[1] = argb(uC0[(uCountFlags & 0x1000u) != 0u ? i : 0]); REG[2] = argb(uC1[(uCountFlags & 0x10000u) != 0u ? i : 0]);
    bool muxSel = REG[12].a >= 0.5;
    uint w = uRgbIn[i]; vec3 A = inRGB(w >> 24), B = inRGB((w >> 16) & 255u), Cc = inRGB((w >> 8) & 255u), D = inRGB(w & 255u);
    uint o = uRgbOut[i], fl = o >> 12, m = (fl >> 3) & 7u;
    vec3 AB = (fl & 2u) != 0u ? vec3(dot(A, B)) : A * B, CD = (fl & 1u) != 0u ? vec3(dot(Cc, D)) : Cc * D;
    vec3 SUM = (fl & 4u) != 0u ? (muxSel ? CD : AB) : AB + CD;
    uint wa = uAlphaIn[i]; float a1 = inA(wa >> 24), b1 = inA((wa >> 16) & 255u), c1 = inA((wa >> 8) & 255u), d1 = inA(wa & 255u);
    uint oa = uAlphaOut[i], fa = oa >> 12, ma = (fa >> 3) & 7u;
    float aab = a1 * b1, acd = c1 * d1, asum = (fa & 4u) != 0u ? (muxSel ? acd : aab) : aab + acd;
    int r;
    r = int((o >> 4) & 15u); if (r != 0) { REG[r].rgb = clamp(outScale3(AB, m), -1.0, 1.0); if ((fl & 0x80u) != 0u) REG[r].a = REG[r].b; }
    r = int(o & 15u); if (r != 0) { REG[r].rgb = clamp(outScale3(CD, m), -1.0, 1.0); if ((fl & 0x40u) != 0u) REG[r].a = REG[r].b; }
    r = int((o >> 8) & 15u); if (r != 0) REG[r].rgb = clamp(outScale3(SUM, m), -1.0, 1.0);
    r = int((oa >> 4) & 15u); if (r != 0) REG[r].a = clamp(outScale(aab, ma), -1.0, 1.0);
    r = int(oa & 15u); if (r != 0) REG[r].a = clamp(outScale(acd, ma), -1.0, 1.0);
    r = int((oa >> 8) & 15u); if (r != 0) REG[r].a = clamp(outScale(asum, ma), -1.0, 1.0);
  }
  if (uFinalABCD == 0u && uFinalEFG == 0u) return clamp(REG[12], 0.0, 1.0);
  REG[1] = argb(uFc0); REG[2] = argb(uFc1);
  uint fl = uFinalEFG & 255u;
  vec4 v1 = (fl & 0x40u) != 0u ? 1.0 - clamp(REG[5], 0.0, 1.0) : clamp(REG[5], 0.0, 1.0);
  vec4 r0 = (fl & 0x20u) != 0u ? 1.0 - clamp(REG[12], 0.0, 1.0) : clamp(REG[12], 0.0, 1.0);
  REG[14] = (fl & 0x80u) != 0u ? clamp(v1 + r0, 0.0, 1.0) : v1 + r0;
  REG[15].rgb = finRGB(uFinalEFG >> 24) * finRGB((uFinalEFG >> 16) & 255u);
  vec3 A = finRGB(uFinalABCD >> 24), B = finRGB((uFinalABCD >> 16) & 255u), Cc = finRGB((uFinalABCD >> 8) & 255u), D = finRGB(uFinalABCD & 255u);
  return vec4(clamp(A * B + (1.0 - A) * Cc + D, 0.0, 1.0), finA((uFinalEFG >> 8) & 255u));
}
float stageArg(int a, int c, int s, vec4 cur, vec4 temp, vec4 tex[4], vec4 tf) {
  int sel = a & 15; float x;
  if (sel == 0) x = vD0[c]; else if (sel == 1) x = cur[c]; else if (sel == 2) x = tex[s][c]; else if (sel == 3) x = tf[c]; else if (sel == 4) x = vD1[c]; else x = temp[c];
  if ((a & 0x20) != 0 && sel == 2) x = tex[s].a;
  if ((a & 0x10) != 0) x = 1.0 - x;
  return x;
}
float stageOp(int o, float a1, float a2) {
  if (o == 2) return a1; if (o == 3) return a2; if (o == 4) return a1 * a2; if (o == 5) return a1 * a2 * 2.0; if (o == 6) return a1 * a2 * 4.0;
  if (o == 7) return a1 + a2; if (o == 8) return a1 + a2 - 0.5; if (o == 9) return (a1 + a2 - 0.5) * 2.0; if (o == 10) return a1 - a2;
  if (o == 11) return a1 + a2 - a1 * a2; return a1;
}
vec4 stages(vec4 tex[4]) {
  vec4 cur = vD0, temp = vec4(0.0), tf = argb(uTFactor);
  for (int s = 0; s < 4; s++) {
    int cop = uCop[s], aop = uAop[s];
    if (cop <= 1 && s > 0) break;
    int effC = cop == 1 ? 3 : cop == 0 ? (uTexOn[s] != 0 ? 4 : 3) : cop, effA = aop == 1 ? 3 : aop == 0 ? (uTexOn[s] != 0 ? 4 : 3) : aop;   // 1 = DISABLE: current passes on, texture or not
    int c1 = cop <= 1 ? 2 : uCa1[s], c2 = cop <= 1 ? 1 : uCa2[s], a1 = aop <= 1 ? 2 : uAa1[s], a2 = aop <= 1 ? 1 : uAa2[s];
    vec4 res;
    for (int k = 0; k < 3; k++) res[k] = stageOp(effC, stageArg(c1, k, s, cur, temp, tex, tf), stageArg(c2, k, s, cur, temp, tex, tf));
    res.a = stageOp(effA, stageArg(a1, 3, s, cur, temp, tex, tf), stageArg(a2, 3, s, cur, temp, tex, tf));
    cur = clamp(res, 0.0, 1.0);
  }
  return cur;
}
bool cmpf(int f, float a, float b) {
  int k = f & 15; if (k == 0) return false; if (k == 1) return a < b; if (k == 2) return a == b; if (k == 3) return a <= b;
  if (k == 4) return a > b; if (k == 5) return a != b; if (k == 6) return a >= b; return true;
}
void main() {
  vec4 tex[4]; tex[0] = fetchTex(0, vT0); tex[1] = fetchTex(1, vT1); tex[2] = fetchTex(2, vT2); tex[3] = fetchTex(3, vT3);
  vec4 col = uMode == 1 ? combiners(tex) : stages(tex);
  if (uAlphaFunc >= 0 && !cmpf(uAlphaFunc, col.a, uAlphaRef)) discard;
  frag = col;
}`;
const BLIT_VS = `#version 300 es
in vec2 p; out vec2 uv; uniform int uFlip;
void main() { uv = p * 0.5 + 0.5; if (uFlip == 1) uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;
const BLIT_FS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D img; uniform int uPremul; out vec4 o;
void main() { vec4 c = texture(img, uv); o = uPremul == 1 ? c : vec4(c.rgb, 1.0); }`;

function compile(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); console.error(log, src); throw new Error("shader: " + log); }
  return s;
}
const fragShader = compile(gl.FRAGMENT_SHADER, FRAG);
function link(vs, fs, attrs) {
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs);
  if (attrs) attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
  return finishLink(p);
}
function finishLink(p) {                         // uniform locations and per-program caches of a linked program
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); let cN = 0;
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, name); if (name === "C") cN = info.size; }
  const ts = [0, 1, 2, 3].map(s => gl.getUniformLocation(p, `uTexSize[${s}]`));   // (looked up once: getUniformLocation per draw was slow)
  return { p, u, ts, cN, cLoc: [], dlo: 0, dhi: cN, last: { ps: -1, rtw: -1, rth: -1, zs: NaN, on: -1, lin: -1, flip: -1, tw: [-1, -1, -1, -1], th: [-1, -1, -1, -1] } };
}
// ------------------------------------------------------------------ specialised pixel shaders
// FRAG interprets the register combiners / texture stages from uniforms: loops over stages, registers in an array
// indexed at run time, branches on every code. GPUs run that slowly per pixel (the array goes to scratch memory).
// A race uses only ~18 pixel states, so each gets its own fragment shader: the same arithmetic (the same helper
// functions, constants still uniforms), with stage count, register numbers, input mappings, operations and texture
// modes written in. Built in the background where the browser can (KHR_parallel_shader_compile); FRAG draws until
// a specialised program is ready.
const fnSrc = name => { const i = FRAG.search(new RegExp(`\\n[a-z0-9]+ ${name}\\(`)); let d = 0, j = FRAG.indexOf("{", i);
  for (let k = j; k < FRAG.length; k++) { if (FRAG[k] === "{") d++; else if (FRAG[k] === "}" && --d === 0) return FRAG.slice(i, k + 1) + "\n"; } return ""; };
const SPEC_LIB = FRAG.slice(0, FRAG.indexOf("vec4 REG[16];")) + ["mapIn", "outScale", "outScale3", "stageArg", "stageOp", "cmpf"].map(fnSrc).join("");
function specMain(st) {
  const P = st.ps, L = [];
  if (P) {
    const g = k => `g${k}`;
    const inRGB = c => { const k = c & 15, m = (c >> 5) & 7; return (c >> 4) & 1 ? `vec3(mapIn(${g(k)}.a, ${m}))` : `vec3(mapIn(${g(k)}.r, ${m}), mapIn(${g(k)}.g, ${m}), mapIn(${g(k)}.b, ${m}))`; };
    const inA = c => `mapIn(${g(c & 15)}.${(c >> 4) & 1 ? "a" : "b"}, ${(c >> 5) & 7})`;
    const finRGB = c => { const x = `clamp(${(c >> 4) & 1 ? `vec3(${g(c & 15)}.a)` : `${g(c & 15)}.rgb`}, 0.0, 1.0)`; return (c >> 5) & 1 ? `(1.0 - ${x})` : x; };
    const finA = c => { const x = `clamp(${g(c & 15)}.${(c >> 4) & 1 ? "a" : "b"}, 0.0, 1.0)`; return (c >> 5) & 1 ? `(1.0 - ${x})` : x; };
    for (let k = 0; k < 16; k++) L.push(`vec4 g${k} = vec4(0.0);`);
    L.push("g3 = vec4(argb(uFogColor).rgb, clamp(vFog, 0.0, 1.0));", "g4 = clamp(vD0, 0.0, 1.0); g5 = clamp(vD1, 0.0, 1.0);");
    for (let s = 0; s < 4; s++) L.push(`g${8 + s} = fetchS(${s}, vT${s}, ${P.texModes[s] | 0}, true);`);
    L.push("g12.a = g8.a;");
    const n = Math.min(8, Math.max(1, P.count | 0)), cf = P.countFlags >>> 0;
    for (let i = 0; i < n; i++) {
      const w = P.rgbIn[i] >>> 0, o = P.rgbOut[i] >>> 0, fl = o >>> 12, m = (fl >> 3) & 7, wa = P.alphaIn[i] >>> 0, oa = P.alphaOut[i] >>> 0, fa = oa >>> 12, ma = (fa >> 3) & 7;
      L.push(`g1 = argb(uC0[${cf & 0x1000 ? i : 0}]); g2 = argb(uC1[${cf & 0x10000 ? i : 0}]);`, "{ bool mux = g12.a >= 0.5;");
      L.push(`vec3 A = ${inRGB(w >>> 24)}, B = ${inRGB((w >>> 16) & 255)}, Cc = ${inRGB((w >>> 8) & 255)}, D = ${inRGB(w & 255)};`);
      L.push(`vec3 AB = ${fl & 2 ? "vec3(dot(A, B))" : "A * B"}, CD = ${fl & 1 ? "vec3(dot(Cc, D))" : "Cc * D"};`);
      L.push(`vec3 SUM = ${fl & 4 ? "(mux ? CD : AB)" : "AB + CD"};`);
      L.push(`float a1 = ${inA(wa >>> 24)}, b1 = ${inA((wa >>> 16) & 255)}, c1 = ${inA((wa >>> 8) & 255)}, d1 = ${inA(wa & 255)};`);
      L.push(`float aab = a1 * b1, acd = c1 * d1, asum = ${fa & 4 ? "(mux ? acd : aab)" : "aab + acd"};`);
      let r = (o >> 4) & 15; if (r) L.push(`${g(r)}.rgb = clamp(outScale3(AB, ${m}u), -1.0, 1.0);` + (fl & 0x80 ? ` ${g(r)}.a = ${g(r)}.b;` : ""));
      r = o & 15; if (r) L.push(`${g(r)}.rgb = clamp(outScale3(CD, ${m}u), -1.0, 1.0);` + (fl & 0x40 ? ` ${g(r)}.a = ${g(r)}.b;` : ""));
      r = (o >> 8) & 15; if (r) L.push(`${g(r)}.rgb = clamp(outScale3(SUM, ${m}u), -1.0, 1.0);`);
      r = (oa >> 4) & 15; if (r) L.push(`${g(r)}.a = clamp(outScale(aab, ${ma}u), -1.0, 1.0);`);
      r = oa & 15; if (r) L.push(`${g(r)}.a = clamp(outScale(acd, ${ma}u), -1.0, 1.0);`);
      r = (oa >> 8) & 15; if (r) L.push(`${g(r)}.a = clamp(outScale(asum, ${ma}u), -1.0, 1.0);`);
      L.push("}");
    }
    const fABCD = P.finalABCD >>> 0, fEFG = P.finalEFG >>> 0;
    if (!fABCD && !fEFG) L.push("vec4 col = clamp(g12, 0.0, 1.0);");
    else {
      const fl = fEFG & 255;
      L.push("g1 = argb(uFc0); g2 = argb(uFc1);");
      L.push(`vec4 v1 = ${fl & 0x40 ? "1.0 - clamp(g5, 0.0, 1.0)" : "clamp(g5, 0.0, 1.0)"};`, `vec4 r0 = ${fl & 0x20 ? "1.0 - clamp(g12, 0.0, 1.0)" : "clamp(g12, 0.0, 1.0)"};`);
      L.push(`g14 = ${fl & 0x80 ? "clamp(v1 + r0, 0.0, 1.0)" : "v1 + r0"};`);
      L.push(`g15.rgb = ${finRGB(fEFG >>> 24)} * ${finRGB((fEFG >>> 16) & 255)};`);
      L.push(`vec3 A = ${finRGB(fABCD >>> 24)}, B = ${finRGB((fABCD >>> 16) & 255)}, Cc = ${finRGB((fABCD >>> 8) & 255)}, D = ${finRGB(fABCD & 255)};`);
      L.push(`vec4 col = vec4(clamp(A * B + (1.0 - A) * Cc + D, 0.0, 1.0), ${finA((fEFG >>> 8) & 255)});`);
    }
  } else {
    const S = st.stages;
    L.push("vec4 tex[4];"); for (let s = 0; s < 4; s++) L.push(`tex[${s}] = fetchS(${s}, vT${s}, uTexOn[${s}] != 0 ? 1 : 0, false);`);
    L.push("vec4 cur = vD0, temp = vec4(0.0), tf = argb(uTFactor), res;");
    for (let s = 0; s < 4; s++) {
      const x = S[s] ?? [], cop = x[0] | 0, aop = x[3] | 0;
      if (cop <= 1 && s > 0) break;
      const effC = cop === 1 ? 3 : cop === 0 ? `(uTexOn[${s}] != 0 ? 4 : 3)` : cop, effA = aop === 1 ? 3 : aop === 0 ? `(uTexOn[${s}] != 0 ? 4 : 3)` : aop;   // as stages() in FRAG: 1 = DISABLE passes current on
      const c1 = cop <= 1 ? 2 : x[1] | 0, c2 = cop <= 1 ? 1 : x[2] | 0, a1 = aop <= 1 ? 2 : x[4] | 0, a2 = aop <= 1 ? 1 : x[5] | 0;
      for (let k = 0; k < 3; k++) L.push(`res[${k}] = stageOp(${effC}, stageArg(${c1}, ${k}, ${s}, cur, temp, tex, tf), stageArg(${c2}, ${k}, ${s}, cur, temp, tex, tf));`);
      L.push(`res.a = stageOp(${effA}, stageArg(${a1}, 3, ${s}, cur, temp, tex, tf), stageArg(${a2}, 3, ${s}, cur, temp, tex, tf));`, "cur = clamp(res, 0.0, 1.0);");
    }
    L.push("vec4 col = cur;");
  }
  L.push("if (uAlphaFunc >= 0 && !cmpf(uAlphaFunc, col.a, uAlphaRef)) discard;", "frag = col;");
  return SPEC_LIB + `vec4 fetchS(int s, vec4 tc, int mode, bool comb) {
  if (mode == 4) return clamp(tc, 0.0, 1.0);
  if (uTexOn[s] == 0 || mode == 0) return comb ? vec4(0.0) : vec4(1.0);
  float q = (mode == 2 && tc.w != 0.0) ? tc.w : 1.0;
  vec2 uv = tc.xy / q;
  if (uTexLinear[s] != 0) uv /= uTexSize[s].xy;
  if (uTexFlip[s] != 0) uv.y = 1.0 - uv.y;
  if (s == 0) return texture(t0, uv); if (s == 1) return texture(t1, uv); if (s == 2) return texture(t2, uv); return texture(t3, uv);
}
void main() {
  ${L.join("\n  ")}
}`;
}
const parallelLink = gl.getExtension("KHR_parallel_shader_compile");
const specFS = new Map(), specProgs = new Map();     // pixel state id -> fragment shader; vs id * 65536 + ps id -> program entry
let specOff = /[?&]spec=0/.test(location.search);
// the program for (vertex program, pixel state): the specialised one when it is ready, else the general one
// Programs are linked on first use, not when the game creates a vertex program. Linking one with the general fragment
// shader (FRAG, the register-combiner interpreter) takes ANGLE on Windows a second or more (it becomes a large HLSL
// program), and the game creates a race's vertex programs while its loading screen is up: linking each of them then
// froze the page at 0-1 fps for the whole load. A draw now asks for its specialised program first (a small,
// straight-line fragment shader that compiles quickly) and the general one only when there is no pixel state to
// specialise for, or when specialising failed. Where the browser can (KHR_parallel_shader_compile) both build in the
// background; a draw whose program is not ready yet is skipped (a frame or two, the first time a combination appears).
const prof = { res: {}, issue: 0, issueN: 0, poll: 0, pollN: 0, fin: 0, finN: 0 };   // where a slow page frame went (status line)
const profT = () => performance.now();
// Whether a background build has finished. getProgramParameter is a synchronous round trip to the browser's GPU
// process, so each pending program is asked at most once per page frame: asked by every draw that wanted it (a race
// frame has ~1,600 draws), the questions alone took the page over a second on the first race frame.
let frameNo = 0;
function built(x, p) {
  if (!parallelLink) return true;
  if (x.asked === frameNo) return false;
  x.asked = frameNo; const t = profT(); const c = gl.getProgramParameter(p, parallelLink.COMPLETION_STATUS_KHR);
  prof.poll += profT() - t; prof.pollN++; return c;
}
function genericProgram(e) {
  if (e.gen === undefined) {
    notePair(e, null);
    const pre = pre_gen.get(e.key);                // built ahead (see below)
    if (pre) e.gen = pre;
    else { const t = profT(); const p = gl.createProgram(); gl.attachShader(p, e.vsShader); gl.attachShader(p, fragShader); gl.linkProgram(p); e.gen = { pending: p, asked: -1 }; prof.issue += profT() - t; prof.issueN++; }
  }
  const g = e.gen; if (!g || !g.pending) return g;
  if (!built(g, g.pending)) return undefined;
  const t = profT(); let pr = null;
  if (gl.getProgramParameter(g.pending, gl.LINK_STATUS)) { pr = finishLink(g.pending); progList.push(pr); }
  else { stats.errors++; console.error("vertex program:", gl.getShaderInfoLog(e.vsShader) || gl.getProgramInfoLog(g.pending), e.src); }
  e.gen = pr; if (pre_gen.get(e.key) === g) pre_gen.set(e.key, pr); prof.fin += profT() - t; prof.finN++; return pr;
}
function startSpec(e, vs, ps, st) {             // a specialised program's background build (or the one built ahead)
  notePair(e, ps);
  const pk = e.key + ":" + psHash.get(ps), pre = pre_spec.get(pk);
  if (pre) { specProgs.set(vs * 65536 + ps, pre); return pre; }
  const t = profT(); let s = null;
  try {
    let fs = specFS.get(ps); if (!fs) { fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, specMain(st)); gl.compileShader(fs); specFS.set(ps, fs); }
    const p = gl.createProgram(); gl.attachShader(p, e.vsShader); gl.attachShader(p, fs); gl.linkProgram(p);
    s = { p, ready: false, prog: null, asked: -1 };
  } catch (err) { s = null; }
  specProgs.set(vs * 65536 + ps, s); if (s) pre_spec.set(pk, s); prof.issue += profT() - t; prof.issueN++;
  return s;
}
function programFor(vs, ps) {
  const e = programs.get(vs); if (!e) return undefined;
  const st = specOff || ps === undefined ? undefined : pstates.get(ps);
  if (!st) return genericProgram(e);
  const key = vs * 65536 + ps; let s = specProgs.get(key);
  if (s === undefined) s = startSpec(e, vs, ps, st);
  if (s && !s.ready) {
    if (!built(s, s.p)) { const g = e.gen; return g && !g.pending ? g : undefined; }
    const t = profT(); s.ready = true;
    if (gl.getProgramParameter(s.p, gl.LINK_STATUS)) { s.prog = finishLink(s.p); progList.push(s.prog); }
    else { stats.specErrors = (stats.specErrors ?? 0) + 1; if (stats.specErrors < 4) console.error("specialised shader:", gl.getProgramInfoLog(s.p)); }
    prof.fin += profT() - t; prof.finN++;
  }
  return s?.prog ?? genericProgram(e);
}

// Building ahead. The game creates a race's vertex programs and pixel states as it draws, so they reach the page with
// the race-week menu's first frame, after the loading screen: building their programs then froze that menu for a
// second or more. (The game itself is done loading; this is the page's own work, which the game's loading screen
// should cover.) So the page remembers, in this browser, the programs a race used (each vertex program's source and
// pixel state, keyed by content), seeded with those of a recorded race, and builds them in the background when the
// page opens, long before a race. A draw then finds its program built: matched by content, whatever ids the game's
// resources got this time. Programs are kept across reconnections.
const PRE_KEY = "nt04.shaderCache";
const SEED = {"vs":{"ur1gek":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = v1.xyzz, b = C[96].xyzz, c = v1.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[4].x = m.x;\n  }\n  { vec4 a = v1.xyzz, b = C[97].xyzz, c = v1.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[4].y = m.y;\n  }\n  { vec4 a = v1.xyzz, b = C[98].xyzz, c = v1.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[4].z = m.z;\n  }\n  { vec4 a = v0, b = C[96], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].z = m.z;\n  }\n  { vec4 a = C[100].xxxx, b = v3.xxxx, c = v3;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[9].xyzw = i.xyzw;\n  }\n  { vec4 a = v0, b = C[99], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].w = m.w;\n  }\n  { vec4 a = C[1].xyzz, b = R[11].xxxx, c = v0.xxxx;\n    m = a * b;\n    R[10].xyz = m.xyz;\n  }\n  { vec4 a = C[2].xyzz, b = R[11].yyyy, c = R[10].xyzz;\n    m = a * b + c;\n    R[10].xyz = m.xyz;\n  }\n  { vec4 a = R[4].xxxx, b = C[1].yyzx, c = v0.xxxx;\n    m = a * b;\n    R[9].yzw = m.yzw;\n  }\n  { vec4 a = C[3].xyzz, b = R[11].zzzz, c = R[10].xyzz;\n    m = a * b + c;\n    R[10].xyz = m.xyz;\n  }\n  { vec4 a = R[4].yyyy, b = C[2].yyzx, c = R[9].yyzw;\n    m = a * b + c;\n    R[9].yzw = m.yzw;\n  }\n  { vec4 a = R[4].zzzz, b = C[3].yyzx, c = R[9].yyzw;\n    m = a * b + c;\n    R[9].yzw = m.yzw;\n  }\n  { vec4 a = R[4].xyzz, b = R[4].xyzz, c = C[10].wwww;\n    m = vec4(dot(a.xyz, b.xyz));\n    i = c;\n    R[4].w = m.w;\n    O[3].w = i.w;\n  }\n  { vec4 a = R[9].wyzz, b = R[9].wyzz, c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].w = m.w;\n  }\n  { vec4 a = R[11], b = C[clamp(101 + a0, 0, 191)], c = R[4].wwww;\n    m = vec4(dot(a, b));\n    i = vec4(inversesqrt(abs(c.x)));\n    R[2].x = m.x;\n    R[1].w = i.w;\n  }\n  { vec4 a = R[11], b = C[clamp(102 + a0, 0, 191)], c = R[10].wwww;\n    m = vec4(dot(a, b));\n    i = vec4(inversesqrt(abs(c.x)));\n    R[2].y = m.y;\n    R[1].x = i.x;\n  }\n  { vec4 a = R[4].xyzz, b = R[1].wwww, c = v0.xxxx;\n    m = a * b;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = R[9].yyzw, b = R[1].xxxx, c = v0.xxxx;\n    m = a * b;\n    R[9].yzw = m.yzw;\n  }\n  { vec4 a = R[4].xyzz, b = C[178].xyzz, c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].x = m.x;\n  }\n  { vec4 a = R[4].xyzz, b = C[180].xyzz, c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].y = m.y;\n  }\n  { vec4 a = R[3].xxxx, b = C[179].xyzz, c = v0.xxxx;\n    m = a * b;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = R[3].yyyy, b = C[181].xyzz, c = v0.xxxx;\n    m = a * b;\n    R[0].xyz = m.xyz;\n  }\n  { vec4 a = R[4].xyzz, b = C[182].xyzz, c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].x = m.x;\n  }\n  { vec4 a = R[11], b = C[clamp(103 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[2].z = m.z;\n  }\n  { vec4 a = R[7].xyzz, b = C[176].xyzz, c = v0.xxxx;\n    m = max(a, b);\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = R[0].xyzz, b = C[176].xyzz, c = R[2];\n    m = max(a, b);\n    i = c;\n    R[0].xyz = m.xyz;\n    O[0].xyz = i.xyz;\n  }\n  { vec4 a = R[3].xxxx, b = C[183].yyzx, c = v0.xxxx;\n    m = a * b;\n    R[8].xzw = m.xzw;\n  }\n  { vec4 a = R[11], b = C[clamp(104 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    O[0].w = m.w;\n  }\n  { vec4 a = C[100].wwww, b = v0.xxxx, c = v0.xxxx;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = R[7].xyzz, b = v0.xxxx, c = R[0].xyzz;\n    m = a + c;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = C[clamp(4 + a0, 0, 191)].xyzz, b = R[11].wwww, c = R[10].xyzz;\n    m = a * b + c;\n    R[11].xyz = m.xyz;\n  }\n  { vec4 a = R[8].wxzz, b = C[176].xyzz, c = O[0].wwww;\n    m = max(a, b);\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[0].xyz = m.xyz;\n    R[1].x = i.x;\n  }\n  { vec4 a = R[11].xyzz, b = R[11].xyzz, c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[11].w = m.w;\n  }\n  { vec4 a = R[7].xyzz, b = v0.xxxx, c = R[0].xyzz;\n    m = a + c;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = O[0].xyzz, b = C[58].xyzz, c = R[11].wwww;\n    m = a * b;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[1].w = i.w;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[7].xyzz, b = v0.xxxx, c = C[184].xyzz;\n    m = a + c;\n    O[3].xyz = m.xyz;\n  }\n  { vec4 a = R[11].xyzz, b = R[1].wwww, c = v0.xxxx;\n    m = a * b;\n    R[11].xyz = m.xyz;\n  }\n  { vec4 a = R[11].xyzz, b = R[9].wyzz, c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[0].x = m.x;\n  }\n  { vec4 a = O[0].xyzz, b = R[1].xxxx, c = C[59].xyzz;\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[0].xxxx, b = v0.xxxx, c = R[0].xxxx;\n    m = a + c;\n    R[0].w = m.w;\n  }\n  { vec4 a = R[9].wyzz, b = R[0].wwww, c = v0.xxxx;\n    m = a * b;\n    R[0].xyz = m.xyz;\n  }\n  { vec4 a = R[11].xyzz, b = v0.xxxx, c = -R[0].xyzz;\n    m = a + c;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = v0, b = v0, c = v0;\n  }\n  { vec4 a = R[9].xyyy, b = R[9].xyyy, c = v0.xxxx;\n    m = a * b;\n    R[6].xy = m.xy;\n  }\n  { vec4 a = C[0].wwww, b = R[6].yyyy, c = R[6].xxxx;\n    m = a * b + c;\n    R[0].x = m.x;\n  }\n  { vec4 a = R[6].xxxx, b = v0.xxxx, c = R[6].yyyy;\n    m = a + c;\n    R[0].y = m.y;\n  }\n  { vec4 a = v0.xxxx, b = v0.xxxx, c = R[0].xxxx;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[0].z = i.z;\n  }\n  { vec4 a = v0.xxxx, b = v0.xxxx, c = R[0].yyyy;\n    i = vec4(c.x == 1.0 ? 1.0 : 1.0 / c.x);\n    R[0].y = i.y;\n  }\n  { vec4 a = R[0].zzzz, b = R[0].xxxx, c = v0.xxxx;\n    m = a * b;\n    R[0].x = m.x;\n  }\n  { vec4 a = -C[0].xxxx, b = R[9].xxxx, c = R[0].xxxx;\n    m = a * b + c;\n    R[0].x = m.x;\n  }\n  { vec4 a = R[0].xxxx, b = R[0].yyyy, c = v0.xxxx;\n    m = a * b;\n    R[0].x = m.x;\n  }\n  { vec4 a = R[0].xxxx, b = -R[0].xxxx, c = v0.xxxx;\n    m = max(a, b);\n    R[0].x = m.x;\n  }\n  { vec4 a = R[0].xxxx, b = R[9].xzyy, c = C[0].yzyy;\n    m = a * b + c;\n    R[8].xyz = m.xyz;\n    O[10].y = m.y;\n  }\n  { vec4 a = v0, b = v0, c = v0;\n  }\n  { vec4 a = R[8].yyyy, b = v0.xxxx, c = -C[0].zzzz;\n    m = a + c;\n    R[0].x = m.x;\n  }\n  { vec4 a = R[8].xxxx, b = C[8].xxxx, c = v0.xxxx;\n    m = vec4(greaterThanEqual(a, b));\n    R[0].w = m.w;\n  }\n  { vec4 a = R[0].xxxx, b = -R[0].xxxx, c = v0.xxxx;\n    m = max(a, b);\n    R[0].x = m.x;\n  }\n  { vec4 a = R[8].zzzz, b = C[23], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[0].y = m.y;\n  }\n  { vec4 a = R[8].zzzz, b = C[24], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[0].z = m.z;\n  }\n  { vec4 a = R[0].xxxx, b = v0.xxxx, c = -C[9].xxxx;\n    m = a + c;\n    R[0].x = m.x;\n  }\n  { vec4 a = R[0].wwww, b = R[0].zzzz, c = R[0].yyyy;\n    m = a * b + c;\n    O[10].x = m.x;\n  }\n  { vec4 a = R[0].xxxx, b = C[8].zzzz, c = v0.xxxx;\n    m = a * b;\n    O[4].w = m.w;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","gwerf3":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 2) in vec4 a2;\nlayout(location = 3) in vec4 a3;\nlayout(location = 4) in vec4 a4;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = a2;\n  vec4 v3 = a3.zyxw;\n  vec4 v4 = a4.zyxw;\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = v0, b = C[96], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[0].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[0].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[0].z = m.z;\n  }\n  { vec4 a = C[100].xxxx, b = v2.xxxx, c = v2;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[9].xyzw = i.xyzw;\n  }\n  { vec4 a = C[0].wwww, b = v0.xxxx, c = v0.xxxx;\n    m = a;\n    R[11].w = m.w;\n  }\n  { vec4 a = R[0], b = C[clamp(101 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].x = m.x;\n  }\n  { vec4 a = R[0], b = C[clamp(102 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[0], b = C[clamp(103 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[0], b = C[clamp(104 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = C[176].wwww, b = v0.xxxx, c = -R[11].wwww;\n    m = a + c;\n    R[11].w = m.w;\n  }\n  { vec4 a = v4, b = C[0].wwww, c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[2].xyzw = m.xyzw;\n    R[1].x = i.x;\n  }\n  { vec4 a = O[0].xyzz, b = C[58].xyzz, c = v0.xxxx;\n    m = a * b;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = v3, b = R[11].wwww, c = R[2];\n    m = a * b + c;\n    O[3].xyzw = m.xyzw;\n  }\n  { vec4 a = O[0].xyzz, b = R[1].xxxx, c = C[59].xyzz;\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","1dsp06m":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 2) in vec4 a2;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = a2.zyxw;\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = C[100], b = v2, c = v2;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[3].xyzw = i.xyzw;\n  }\n  { vec4 a = v0, b = C[96], c = v0;\n    m = vec4(dot(a, b));\n    R[2].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0;\n    m = vec4(dot(a, b));\n    R[2].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0;\n    m = vec4(dot(a, b));\n    R[2].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(101 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(102 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[2], b = C[clamp(103 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(104 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = C[173].wwww, b = v0, c = -O[0].zzzz;\n    m = a + c;\n    R[3].x = m.x;\n  }\n  { vec4 a = C[100].zzzz, b = v0, c = v0;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = R[3].xxxx, b = C[173].yyyy, c = v0;\n    m = a * b;\n    O[5].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(0 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[9].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(1 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[9].y = m.y;\n  }\n  { vec4 a = v3, b = C[clamp(8 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[10].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(9 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[10].y = m.y;\n  }\n  { vec4 a = v3, b = C[clamp(16 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(17 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].y = m.y;\n  }\n  { vec4 a = v3, b = C[clamp(24 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[12].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(25 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[12].y = m.y;\n  }\n  { vec4 a = O[0], b = C[58], c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = R[1].xxxx, c = C[59];\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","36ntnn":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 2) in vec4 a2;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v2 = a2.zyxw;\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = C[100], b = v2, c = v2;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[3].xyzw = i.xyzw;\n  }\n  { vec4 a = C[96], b = v0.xxxx, c = v0;\n    m = a * b;\n    R[2].xyzw = m.xyzw;\n  }\n  { vec4 a = C[97], b = v0.yyyy, c = R[2];\n    m = a * b + c;\n    R[3].xyzw = m.xyzw;\n  }\n  { vec4 a = C[98], b = v0.zzzz, c = R[3];\n    m = a * b + c;\n    R[4].xyzw = m.xyzw;\n  }\n  { vec4 a = C[99], b = v0.wwww, c = R[4];\n    m = a * b + c;\n    R[5].xyzw = m.xyzw;\n  }\n  { vec4 a = R[5], b = C[clamp(102 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a, b));\n    i = c;\n    R[6].y = m.y;\n    O[9].xyzw = i.xyzw;\n  }\n  { vec4 a = R[5], b = C[clamp(101 + a0, 0, 191)], c = v2;\n    m = vec4(dot(a, b));\n    i = c;\n    R[6].x = m.x;\n    O[7].xyzw = i.xyzw;\n  }\n  { vec4 a = R[5], b = C[clamp(103 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a, b));\n    R[6].z = m.z;\n  }\n  { vec4 a = R[5], b = C[clamp(104 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a, b));\n    R[6].w = m.w;\n  }\n  { vec4 a = C[173].wwww, b = v0, c = -R[6].zzzz;\n    m = a + c;\n    R[7].x = m.x;\n  }\n  { vec4 a = R[6], b = v0, c = v0;\n    m = a;\n    O[0].xyzw = m.xyzw;\n  }\n  { vec4 a = R[7].xxxx, b = C[173].yyyy, c = v0;\n    m = a * b;\n    O[5].x = m.x;\n  }\n  { vec4 a = O[0], b = C[58], c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = R[1].xxxx, c = C[59];\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","khgbc8":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = v0, b = C[96], c = v0;\n    m = vec4(dot(a, b));\n    R[2].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0;\n    m = vec4(dot(a, b));\n    R[2].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0;\n    m = vec4(dot(a, b));\n    R[2].z = m.z;\n  }\n  { vec4 a = C[100], b = v3, c = v3;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[9].xyzw = i.xyzw;\n  }\n  { vec4 a = v1, b = C[96], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(101 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(102 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[2], b = C[clamp(103 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(104 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = v1, b = C[97], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].y = m.y;\n  }\n  { vec4 a = v1, b = C[98], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].z = m.z;\n  }\n  { vec4 a = C[173].wwww, b = v0, c = -R[2].zzzz;\n    m = a + c;\n    R[4].x = m.x;\n  }\n  { vec4 a = R[3], b = C[178], c = v3;\n    m = vec4(dot(a.xyz, b.xyz));\n    i = c;\n    R[5].xyw = m.xyw;\n    O[10].xyzw = i.xyzw;\n  }\n  { vec4 a = R[3], b = C[180], c = v3;\n    m = vec4(dot(a.xyz, b.xyz));\n    i = c;\n    R[6].xyw = m.xyw;\n    O[12].xyzw = i.xyzw;\n  }\n  { vec4 a = R[4], b = C[173].yyyy, c = R[5];\n    m = a * b;\n    s = clamp(c.w, -127.9961, 127.9961); i = vec4(1.0, max(c.x, 0.0), c.x > 0.0 ? pow(max(c.y, 0.0), s) : 0.0, 1.0);\n    R[1].y = i.y;\n    O[5].x = m.x;\n  }\n  { vec4 a = v0, b = v0, c = R[6];\n    s = clamp(c.w, -127.9961, 127.9961); i = vec4(1.0, max(c.x, 0.0), c.x > 0.0 ? pow(max(c.y, 0.0), s) : 0.0, 1.0);\n    R[7].y = i.y;\n  }\n  { vec4 a = R[1].yyyy, b = C[179], c = v3;\n    m = a * b;\n    i = c;\n    R[8].xyz = m.xyz;\n    O[11].xyzw = i.xyzw;\n  }\n  { vec4 a = R[7].yyyy, b = C[181], c = R[8].xyzz;\n    m = a * b + c;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = C[10].wwww, b = v0, c = v0;\n    m = a;\n    O[3].w = m.w;\n  }\n  { vec4 a = R[9].xyzz, b = v0, c = C[184];\n    m = a + c;\n    O[3].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = C[58], c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = R[1].xxxx, c = C[59];\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","19udsqd":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 2) in vec4 a2;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = a2.zyxw;\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = C[100].xxxx, b = v0.xxxx, c = v0.xxxx;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = v1.xyzz, b = C[96].xyzz, c = v1.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[9].x = m.x;\n  }\n  { vec4 a = v1.xyzz, b = C[97].xyzz, c = v1.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[9].y = m.y;\n  }\n  { vec4 a = v1.xyzz, b = C[98].xyzz, c = v1.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[9].z = m.z;\n  }\n  { vec4 a = v0, b = C[96], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].z = m.z;\n  }\n  { vec4 a = R[9].xyzz, b = R[9].xyzz, c = C[176].wwww;\n    m = vec4(dot(a.xyz, b.xyz));\n    i = c;\n    R[9].w = m.w;\n    O[3].w = i.w;\n  }\n  { vec4 a = R[11], b = C[clamp(103 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[11], b = C[clamp(101 + a0, 0, 191)], c = R[9].wwww;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    i = vec4(inversesqrt(abs(c.x)));\n    R[1].w = i.w;\n    O[0].x = m.x;\n  }\n  { vec4 a = R[11], b = C[clamp(102 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[9].xyzz, b = R[1].wwww, c = v0.xxxx;\n    m = a * b;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = R[9].xyzz, b = C[178].xyzz, c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[8].x = m.x;\n  }\n  { vec4 a = R[11], b = C[clamp(104 + a0, 0, 191)], c = v0.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = C[100].zzzz, b = v0.xxxx, c = R[8].xxxx;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    s = clamp(c.w, -127.9961, 127.9961); i = vec4(1.0, max(c.x, 0.0), c.x > 0.0 ? pow(max(c.y, 0.0), s) : 0.0, 1.0);\n    R[1].y = i.y;\n  }\n  { vec4 a = R[9].xyzz, b = C[180].xyzz, c = O[0].wwww;\n    m = vec4(dot(a.xyz, b.xyz));\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[7].x = m.x;\n    R[1].x = i.x;\n  }\n  { vec4 a = R[1].yyyy, b = C[179].xyzz, c = v0.xxxx;\n    m = a * b;\n    R[10].xyz = m.xyz;\n  }\n  { vec4 a = C[173].wwww, b = v0.xxxx, c = -O[0].zzzz;\n    m = a + c;\n    R[11].x = m.x;\n  }\n  { vec4 a = O[0].xyzz, b = C[58].xyzz, c = R[7].xxxx;\n    m = a * b;\n    s = clamp(c.w, -127.9961, 127.9961); i = vec4(1.0, max(c.x, 0.0), c.x > 0.0 ? pow(max(c.y, 0.0), s) : 0.0, 1.0);\n    R[1].y = i.y;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[10].xyzz, b = v0.xxxx, c = C[184].xyzz;\n    m = a + c;\n    R[10].xyz = m.xyz;\n  }\n  { vec4 a = R[11].xxxx, b = C[173].yyyy, c = v0.xxxx;\n    m = a * b;\n    O[5].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(0 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[9].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(1 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[9].y = m.y;\n  }\n  { vec4 a = v3, b = C[clamp(8 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[10].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(9 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[10].y = m.y;\n  }\n  { vec4 a = v3, b = C[clamp(16 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(17 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].y = m.y;\n  }\n  { vec4 a = v3, b = C[clamp(24 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[12].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(25 + a0, 0, 191)], c = v3.xxxx;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[12].y = m.y;\n  }\n  { vec4 a = R[1].yyyy, b = C[181].xyzz, c = R[10].xyzz;\n    m = a * b + c;\n    O[3].xyz = m.xyz;\n  }\n  { vec4 a = O[0].xyzz, b = R[1].xxxx, c = C[59].xyzz;\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","1xkl8fk":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 2) in vec4 a2;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = a2.zyxw;\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = C[100], b = v2, c = v2;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[3].xyzw = i.xyzw;\n  }\n  { vec4 a = v0, b = C[96], c = v0;\n    m = vec4(dot(a, b));\n    R[2].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0;\n    m = vec4(dot(a, b));\n    R[2].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0;\n    m = vec4(dot(a, b));\n    R[2].z = m.z;\n  }\n  { vec4 a = v1, b = C[96].xyzz, c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[7].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(101 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(102 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[2], b = C[clamp(103 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(104 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = C[173].wwww, b = v0, c = -O[0].zzzz;\n    m = a + c;\n    R[3].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(117 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[4].x = m.x;\n  }\n  { vec4 a = R[3].xxxx, b = C[173].yyyy, c = v0;\n    m = a * b;\n    O[5].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(118 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[4].y = m.y;\n  }\n  { vec4 a = R[2], b = C[clamp(119 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[4].z = m.z;\n  }\n  { vec4 a = v1, b = C[97].xyzz, c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[7].y = m.y;\n  }\n  { vec4 a = R[4], b = R[4], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[5].w = m.w;\n  }\n  { vec4 a = v1, b = C[98], c = R[5].wwww;\n    m = vec4(dot(a.xyz, b.xyz));\n    i = vec4(inversesqrt(abs(c.x)));\n    R[7].z = m.z;\n    R[1].w = i.w;\n  }\n  { vec4 a = R[4], b = R[1].wwww, c = v0;\n    m = a * b;\n    R[6].xyz = m.xyz;\n  }\n  { vec4 a = R[7], b = R[7], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[8].w = m.w;\n  }\n  { vec4 a = v0, b = v0, c = R[8].wwww;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[1].w = i.w;\n  }\n  { vec4 a = R[7], b = R[1].wwww, c = v0;\n    m = a * b;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = R[9], b = C[clamp(117 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].x = m.x;\n  }\n  { vec4 a = R[9], b = C[clamp(118 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].y = m.y;\n  }\n  { vec4 a = R[9], b = C[clamp(119 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].z = m.z;\n  }\n  { vec4 a = R[6], b = R[10], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[11].xyz = m.xyz;\n  }\n  { vec4 a = R[11], b = v0, c = R[11];\n    m = a + c;\n    R[0].xyz = m.xyz;\n  }\n  { vec4 a = R[10].xyzz, b = R[0].xyzz, c = v0;\n    m = a * b;\n    R[2].xyz = m.xyz;\n  }\n  { vec4 a = R[6], b = v0, c = -R[2];\n    m = a + c;\n    R[3].xyz = m.xyz;\n  }\n  { vec4 a = C[clamp(117 + a0, 0, 191)], b = R[3].xxxx, c = v0;\n    m = a * b;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = C[clamp(118 + a0, 0, 191)], b = R[3].yyyy, c = R[4];\n    m = a * b + c;\n    R[5].xyz = m.xyz;\n  }\n  { vec4 a = C[clamp(119 + a0, 0, 191)], b = R[3].zzzz, c = R[5];\n    m = a * b + c;\n    R[6].xyz = m.xyz;\n  }\n  { vec4 a = C[100].zzzz, b = v0, c = v0;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = R[6], b = C[149], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[7].x = m.x;\n  }\n  { vec4 a = R[6], b = C[150], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[7].y = m.y;\n  }\n  { vec4 a = R[6], b = C[152], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[8].w = m.w;\n  }\n  { vec4 a = v3, b = C[clamp(1 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[9].y = m.y;\n  }\n  { vec4 a = v3, b = C[clamp(0 + a0, 0, 191)], c = R[8].wwww;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    i = vec4(c.x == 1.0 ? 1.0 : 1.0 / c.x);\n    R[1].xy = i.xy;\n    O[9].x = m.x;\n  }\n  { vec4 a = v3, b = C[clamp(16 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].x = m.x;\n  }\n  { vec4 a = R[7], b = R[1], c = v0;\n    m = a * b;\n    O[10].xy = m.xy;\n  }\n  { vec4 a = v3, b = C[clamp(17 + a0, 0, 191)], c = v3;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].y = m.y;\n  }\n  { vec4 a = O[0], b = C[58], c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = R[1].xxxx, c = C[59];\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","16ufl9m":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = v0, b = C[96], c = v0;\n    m = vec4(dot(a, b));\n    R[2].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0;\n    m = vec4(dot(a, b));\n    R[2].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0;\n    m = vec4(dot(a, b));\n    R[2].z = m.z;\n  }\n  { vec4 a = C[100], b = v3, c = v3;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[9].xyzw = i.xyzw;\n  }\n  { vec4 a = R[2].xxxx, b = C[1].xyzz, c = v0;\n    m = a * b;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = R[2], b = C[clamp(101 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(102 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[2], b = C[clamp(103 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(104 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = C[173].wwww, b = v0, c = -O[0].zzzz;\n    m = a + c;\n    R[3].x = m.x;\n  }\n  { vec4 a = C[100].wwww, b = v0, c = v0;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = R[3].xxxx, b = C[173].yyyy, c = v0;\n    m = a * b;\n    O[5].x = m.x;\n  }\n  { vec4 a = R[2].yyyy, b = C[2].xyzz, c = R[4];\n    m = a * b + c;\n    R[5].xyz = m.xyz;\n  }\n  { vec4 a = R[2].zzzz, b = C[3].xyzz, c = R[5];\n    m = a * b + c;\n    R[6].xyz = m.xyz;\n  }\n  { vec4 a = C[clamp(4 + a0, 0, 191)], b = v0, c = R[6];\n    m = a + c;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = v1, b = C[96], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].x = m.x;\n  }\n  { vec4 a = R[7], b = R[7], c = C[10];\n    m = vec4(dot(a.xyz, b.xyz));\n    i = c;\n    R[8].w = m.w;\n    O[3].w = i.w;\n  }\n  { vec4 a = v1, b = C[98], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].z = m.z;\n  }\n  { vec4 a = v1, b = C[97], c = R[8].wwww;\n    m = vec4(dot(a.xyz, b.xyz));\n    i = vec4(inversesqrt(abs(c.x)));\n    R[10].y = m.y;\n    R[1].w = i.w;\n  }\n  { vec4 a = R[10].xxxx, b = C[1].xyzz, c = v0;\n    m = a * b;\n    R[11].xyz = m.xyz;\n  }\n  { vec4 a = R[7], b = R[1].wwww, c = v0;\n    m = a * b;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = R[10].yyyy, b = C[2].xyzz, c = R[11].xyzz;\n    m = a * b + c;\n    R[0].xyz = m.xyz;\n  }\n  { vec4 a = R[10].zzzz, b = C[3].xyzz, c = R[0].xyzz;\n    m = a * b + c;\n    R[3].xyz = m.xyz;\n  }\n  { vec4 a = C[177].wwww, b = v0, c = v0;\n    m = a;\n    R[5].w = m.w;\n  }\n  { vec4 a = R[9], b = R[3], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = R[4], b = v0, c = R[4];\n    m = a + c;\n    R[5].xyz = m.xyz;\n  }\n  { vec4 a = R[3].xyzz, b = -R[5], c = R[9];\n    m = a * b + c;\n    R[6].xyz = m.xyz;\n  }\n  { vec4 a = R[10], b = C[178], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[5].x = m.x;\n  }\n  { vec4 a = R[6], b = R[6], c = v0;\n    m = a * b;\n    R[7].xy = m.xy;\n  }\n  { vec4 a = C[0].wwww, b = R[7].yyyy, c = R[7].xxxx;\n    m = a * b + c;\n    R[8].x = m.x;\n  }\n  { vec4 a = R[7].xxxx, b = v0, c = R[7].yyyy;\n    m = a + c;\n    R[11].y = m.y;\n  }\n  { vec4 a = v0, b = v0, c = R[8].xxxx;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[1].y = i.y;\n  }\n  { vec4 a = R[1].yyyy, b = R[8], c = R[11].yyyy;\n    m = a * b;\n    i = vec4(c.x == 1.0 ? 1.0 : 1.0 / c.x);\n    R[9].x = m.x;\n    R[1].y = i.y;\n  }\n  { vec4 a = -C[0].xxxx, b = R[6].xxxx, c = R[9].xxxx;\n    m = a * b + c;\n    R[11].x = m.x;\n  }\n  { vec4 a = R[11].xxxx, b = R[1].yyyy, c = v0;\n    m = a * b;\n    R[0].x = m.x;\n  }\n  { vec4 a = C[clamp(11 + a0, 0, 191)], b = v0, c = -R[2].xyzz;\n    m = a + c;\n    R[11].xyz = m.xyz;\n  }\n  { vec4 a = R[0].xxxx, b = -R[0].xxxx, c = v0;\n    m = max(a, b);\n    R[3].x = m.x;\n  }\n  { vec4 a = R[3].xxxx, b = R[6], c = C[0].yyzw;\n    m = a * b + c;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = R[2], b = C[26], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[6].y = m.y;\n  }\n  { vec4 a = R[2], b = C[25], c = R[4].zzzz;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    i = c;\n    R[6].x = m.x;\n    O[12].y = i.y;\n  }\n  { vec4 a = R[4].yyyy, b = C[23], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[5].y = m.y;\n  }\n  { vec4 a = R[4].xxxx, b = C[8].xxxx, c = R[6];\n    m = vec4(greaterThanEqual(a, b));\n    i = c;\n    R[3].w = m.w;\n    O[10].y = i.y;\n  }\n  { vec4 a = R[4].yyyy, b = C[24], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[6].z = m.z;\n  }\n  { vec4 a = R[4].zzzz, b = v0, c = -C[0].zzzz;\n    m = a + c;\n    R[7].x = m.x;\n  }\n  { vec4 a = R[3].wwww, b = R[6].zzzz, c = R[5].yyyy;\n    m = a * b + c;\n    O[12].x = m.x;\n  }\n  { vec4 a = R[7].xxxx, b = -R[7].xxxx, c = v0;\n    m = max(a, b);\n    R[8].x = m.x;\n  }\n  { vec4 a = R[8].xxxx, b = v0, c = -C[9].xxxx;\n    m = a + c;\n    R[9].x = m.x;\n  }\n  { vec4 a = R[6], b = C[27], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[10].x = m.x;\n  }\n  { vec4 a = R[9].xxxx, b = C[8].zzzz, c = v0;\n    m = a * b;\n    O[4].w = m.w;\n  }\n  { vec4 a = R[2], b = C[28], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[6].x = m.x;\n  }\n  { vec4 a = R[2], b = C[29], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[6].y = m.y;\n  }\n  { vec4 a = v0.yyyy, b = C[32].xyzz, c = v0;\n    m = a * b;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = R[9].xyzz, b = C[30].xyzz, c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[6].w = m.w;\n  }\n  { vec4 a = R[9].xyzz, b = C[31].xyzz, c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[9].w = m.w;\n  }\n  { vec4 a = R[6].xyyy, b = v0, c = v0;\n    m = a;\n    R[9].xy = m.xy;\n  }\n  { vec4 a = C[30], b = R[6], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].x = m.x;\n  }\n  { vec4 a = C[31], b = R[9], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].y = m.y;\n  }\n  { vec4 a = R[11], b = R[11], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[0].x = m.x;\n  }\n  { vec4 a = v0, b = v0, c = R[0].xxxx;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[1].x = i.x;\n  }\n  { vec4 a = R[11], b = R[1].xxxx, c = v0;\n    m = a * b;\n    R[0].xyz = m.xyz;\n  }\n  { vec4 a = C[178], b = v0, c = R[0];\n    m = a + c;\n    R[2].xyz = m.xyz;\n  }\n  { vec4 a = R[2], b = R[2], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].x = m.x;\n  }\n  { vec4 a = v0, b = v0, c = R[3].xxxx;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[1].x = i.x;\n  }\n  { vec4 a = R[2], b = R[1].xxxx, c = v0;\n    m = a * b;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = C[58], c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[10], b = R[4], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[5].y = m.y;\n  }\n  { vec4 a = O[0], b = R[1].xxxx, c = C[59];\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[10], b = C[180], c = R[5];\n    m = vec4(dot(a.xyz, b.xyz));\n    s = clamp(c.w, -127.9961, 127.9961); i = vec4(1.0, max(c.x, 0.0), c.x > 0.0 ? pow(max(c.y, 0.0), s) : 0.0, 1.0);\n    R[5].x = m.x;\n    R[1].yz = i.yz;\n  }\n  { vec4 a = R[1].yyyy, b = C[179], c = v0;\n    m = a * b;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = v0, b = v0, c = R[5];\n    s = clamp(c.w, -127.9961, 127.9961); i = vec4(1.0, max(c.x, 0.0), c.x > 0.0 ? pow(max(c.y, 0.0), s) : 0.0, 1.0);\n    R[6].y = i.y;\n  }\n  { vec4 a = C[185], b = R[1].zzzz, c = v0;\n    m = a * b;\n    O[4].xyz = m.xyz;\n  }\n  { vec4 a = R[7], b = v0, c = C[184];\n    m = a + c;\n    R[8].xyz = m.xyz;\n  }\n  { vec4 a = R[6].yyyy, b = C[181], c = R[8].xyzz;\n    m = a * b + c;\n    O[3].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","1hehtyj":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = v0, b = C[96], c = v0;\n    m = vec4(dot(a, b));\n    R[2].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0;\n    m = vec4(dot(a, b));\n    R[2].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0;\n    m = vec4(dot(a, b));\n    R[2].z = m.z;\n  }\n  { vec4 a = C[100], b = v3, c = v3;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n    i = c;\n    O[9].xyzw = i.xyzw;\n  }\n  { vec4 a = R[2].xxxx, b = C[1].xyzz, c = v0;\n    m = a * b;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = R[2], b = C[clamp(101 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(102 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[2], b = C[clamp(103 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(104 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = C[173].wwww, b = v0, c = -O[0].zzzz;\n    m = a + c;\n    R[3].x = m.x;\n  }\n  { vec4 a = C[100].wwww, b = v0, c = v0;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = R[3].xxxx, b = C[173].yyyy, c = v0;\n    m = a * b;\n    O[5].x = m.x;\n  }\n  { vec4 a = R[2].yyyy, b = C[2].xyzz, c = R[4];\n    m = a * b + c;\n    R[5].xyz = m.xyz;\n  }\n  { vec4 a = R[2].zzzz, b = C[3].xyzz, c = R[5];\n    m = a * b + c;\n    R[6].xyz = m.xyz;\n  }\n  { vec4 a = C[clamp(4 + a0, 0, 191)], b = v0, c = R[6];\n    m = a + c;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = v1, b = C[96], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].x = m.x;\n  }\n  { vec4 a = R[7], b = R[7], c = C[184];\n    m = vec4(dot(a.xyz, b.xyz));\n    i = c;\n    R[8].w = m.w;\n    O[3].xyzw = i.xyzw;\n  }\n  { vec4 a = v1, b = C[98], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[0].z = m.z;\n  }\n  { vec4 a = v1, b = C[97], c = R[8].wwww;\n    m = vec4(dot(a.xyz, b.xyz));\n    i = vec4(inversesqrt(abs(c.x)));\n    R[11].y = m.y;\n    R[1].w = i.w;\n  }\n  { vec4 a = R[10].xxxx, b = C[1].xyzz, c = v0;\n    m = a * b;\n    R[2].xyz = m.xyz;\n  }\n  { vec4 a = R[7], b = R[1].wwww, c = v0;\n    m = a * b;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = R[11].yyyy, b = C[2].xyzz, c = R[2].xyzz;\n    m = a * b + c;\n    R[3].xyz = m.xyz;\n  }\n  { vec4 a = R[0].zzzz, b = C[3].xyzz, c = R[3].xyzz;\n    m = a * b + c;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = C[58], c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[9], b = R[4], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[5].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = R[1].xxxx, c = C[59];\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[5], b = v0, c = R[5];\n    m = a + c;\n    R[6].xyz = m.xyz;\n  }\n  { vec4 a = R[4].xyzz, b = -R[6], c = R[9];\n    m = a * b + c;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = R[7], b = R[7], c = v0;\n    m = a * b;\n    R[8].xy = m.xy;\n  }\n  { vec4 a = C[0].wwww, b = R[8].yyyy, c = R[8].xxxx;\n    m = a * b + c;\n    R[9].x = m.x;\n  }\n  { vec4 a = R[8].xxxx, b = v0, c = R[8].yyyy;\n    m = a + c;\n    R[0].y = m.y;\n  }\n  { vec4 a = v0, b = v0, c = R[9].xxxx;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[1].y = i.y;\n  }\n  { vec4 a = R[1].yyyy, b = R[9], c = R[0].yyyy;\n    m = a * b;\n    i = vec4(c.x == 1.0 ? 1.0 : 1.0 / c.x);\n    R[10].x = m.x;\n    R[1].y = i.y;\n  }\n  { vec4 a = -C[0].xxxx, b = R[7].xxxx, c = R[10].xxxx;\n    m = a * b + c;\n    R[11].x = m.x;\n  }\n  { vec4 a = R[11].xxxx, b = R[1].yyyy, c = v0;\n    m = a * b;\n    R[2].x = m.x;\n  }\n  { vec4 a = R[2].xxxx, b = -R[2].xxxx, c = v0;\n    m = max(a, b);\n    R[3].x = m.x;\n  }\n  { vec4 a = R[3].xxxx, b = R[7], c = C[0].yyzw;\n    m = a * b + c;\n    R[4].xyz = m.xyz;\n  }\n  { vec4 a = R[4].xxxx, b = C[8].xxxx, c = R[4].zzzz;\n    m = vec4(greaterThanEqual(a, b));\n    i = c;\n    R[5].w = m.w;\n    O[10].y = i.y;\n  }\n  { vec4 a = R[4].yyyy, b = C[23], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[6].y = m.y;\n  }\n  { vec4 a = R[4].yyyy, b = C[24], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[7].z = m.z;\n  }\n  { vec4 a = R[5].wwww, b = R[7].zzzz, c = R[6].yyyy;\n    m = a * b + c;\n    O[10].x = m.x;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","1s6h5js":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 1) in vec4 a1;\nlayout(location = 3) in vec4 a3;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = a1;\n  vec4 v2 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = v0, b = C[96], c = v0;\n    m = vec4(dot(a, b));\n    R[2].x = m.x;\n  }\n  { vec4 a = v0, b = C[97], c = v0;\n    m = vec4(dot(a, b));\n    R[2].y = m.y;\n  }\n  { vec4 a = v0, b = C[98], c = v0;\n    m = vec4(dot(a, b));\n    R[2].z = m.z;\n  }\n  { vec4 a = v1, b = C[96], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].x = m.x;\n  }\n  { vec4 a = v1, b = C[97], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].y = m.y;\n  }\n  { vec4 a = v1, b = C[98], c = v1;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[3].z = m.z;\n  }\n  { vec4 a = C[100].xxxx, b = v0, c = v0;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = C[8].xxxx, b = v0, c = v0;\n    m = a;\n    R[5].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(101 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].x = m.x;\n  }\n  { vec4 a = R[2], b = C[clamp(102 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].y = m.y;\n  }\n  { vec4 a = R[2], b = C[clamp(103 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].z = m.z;\n  }\n  { vec4 a = R[2], b = C[clamp(104 + a0, 0, 191)], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[0].w = m.w;\n  }\n  { vec4 a = C[173].wwww, b = v0, c = -O[0].zzzz;\n    m = a + c;\n    R[4].x = m.x;\n  }\n  { vec4 a = R[2], b = C[25], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[5].x = m.x;\n  }\n  { vec4 a = R[4].xxxx, b = C[173].yyyy, c = v0;\n    m = a * b;\n    O[5].x = m.x;\n  }\n  { vec4 a = R[2], b = C[26], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[5].y = m.y;\n  }\n  { vec4 a = C[100].wwww, b = v0, c = v0;\n    a0 = int(floor(a.x + 0.001)); m = vec4(0.0);\n  }\n  { vec4 a = v0.yyyy, b = C[32], c = R[5];\n    m = a * b;\n    i = c;\n    R[6].xyz = m.xyz;\n    O[10].y = i.y;\n  }\n  { vec4 a = R[5], b = C[27], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[10].x = m.x;\n  }\n  { vec4 a = R[2], b = C[28], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[5].x = m.x;\n  }\n  { vec4 a = R[2], b = C[29], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    R[5].y = m.y;\n  }\n  { vec4 a = R[6].xyzz, b = C[30].xyzz, c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[5].w = m.w;\n  }\n  { vec4 a = R[6].xyzz, b = C[31].xyzz, c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[6].w = m.w;\n  }\n  { vec4 a = R[5], b = v0, c = C[184];\n    m = a;\n    i = c;\n    R[6].xy = m.xy;\n    O[3].xyzw = i.xyzw;\n  }\n  { vec4 a = C[30], b = R[5], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].x = m.x;\n  }\n  { vec4 a = C[31], b = R[6], c = v0;\n    m = vec4(dot(a.xyz, b.xyz) + b.w);\n    O[11].y = m.y;\n  }\n  { vec4 a = C[clamp(11 + a0, 0, 191)], b = v0, c = -R[2].xyzz;\n    m = a + c;\n    R[7].xyz = m.xyz;\n  }\n  { vec4 a = C[8].yyyy, b = v0, c = v0;\n    m = a;\n    R[3].w = m.w;\n  }\n  { vec4 a = R[7], b = R[7], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[8].x = m.x;\n  }\n  { vec4 a = C[176], b = v0, c = R[8];\n    m = a;\n    i = vec4(inversesqrt(abs(c.x)));\n    R[4].zw = m.zw;\n    R[1].x = i.x;\n  }\n  { vec4 a = R[7], b = R[1].xxxx, c = v0;\n    m = a * b;\n    R[9].xyz = m.xyz;\n  }\n  { vec4 a = O[0], b = C[58], c = O[0].wwww;\n    m = a * b;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[3], b = R[9], c = v0;\n    m = vec4(dot(a.xyz, b.xyz));\n    R[10].x = m.x;\n  }\n  { vec4 a = O[0], b = R[1].xxxx, c = C[59];\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = R[10].xxxx, b = C[8].xxxx, c = v0;\n    m = vec4(greaterThanEqual(a, b));\n    R[11].x = m.x;\n  }\n  { vec4 a = C[185].wwww, b = R[11].xxxx, c = v0;\n    m = a * b;\n    O[4].w = m.w;\n  }\n  { vec4 a = R[3].xyzz, b = R[10].xxxx, c = v0;\n    m = a * b;\n    R[0].xyz = m.xyz;\n  }\n  { vec4 a = R[0].xyzz, b = v0, c = R[0].xyzz;\n    m = a + c;\n    R[2].xyz = m.xyz;\n  }\n  { vec4 a = -R[9].xyzz, b = v0, c = R[2].xyzz;\n    m = a + c;\n    R[3].xyz = m.xyz;\n  }\n  { vec4 a = R[3], b = C[19], c = v0;\n    m = vec4(dot(a, b));\n    R[4].x = m.x;\n  }\n  { vec4 a = R[3], b = C[20], c = v0;\n    m = vec4(dot(a, b));\n    R[4].y = m.y;\n  }\n  { vec4 a = R[4], b = C[15], c = v0;\n    m = vec4(dot(a, b));\n    O[9].x = m.x;\n  }\n  { vec4 a = R[4], b = C[16], c = v0;\n    m = vec4(dot(a, b));\n    O[9].y = m.y;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}","ybux0a":"#version 300 es\nprecision highp float;\nprecision highp int;\nuniform vec4 C[192];\nuniform vec3 uRT;\nlayout(location = 0) in vec4 a0;\nlayout(location = 3) in vec4 a3;\nlayout(location = 2) in vec4 a2;\nout vec4 vD0; out vec4 vD1; out float vFog; out vec4 vT0; out vec4 vT1; out vec4 vT2; out vec4 vT3;\nvoid main() {\n  vec4 v0 = a0;\n  vec4 v1 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v2 = a2.zyxw;\n  vec4 v3 = a3;\n  vec4 v4 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v5 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v6 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v7 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v8 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v9 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v10 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v11 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v12 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v13 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v14 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 v15 = vec4(0.0, 0.0, 0.0, 1.0);\n  vec4 R[12]; for (int k = 0; k < 12; k++) R[k] = vec4(0.0);\n  vec4 O[13]; for (int k = 0; k < 13; k++) O[k] = vec4(0.0); O[3] = vec4(1.0); O[4] = vec4(0.0);\n  int a0 = 0; vec4 m, i; float s;\n  { vec4 a = v0, b = C[187], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].x = m.x;\n  }\n  { vec4 a = v0, b = C[188], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].y = m.y;\n  }\n  { vec4 a = v0, b = C[189], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    R[11].z = m.z;\n  }\n  { vec4 a = v0, b = C[190], c = v0.xxxx;\n    m = vec4(dot(a, b));\n    O[0].w = m.w;\n  }\n  { vec4 a = v3, b = C[0], c = R[11];\n    m = a * b;\n    i = c;\n    R[2].xyzw = m.xyzw;\n    O[0].xyz = i.xyz;\n  }\n  { vec4 a = v2, b = v2.xxxx, c = O[0].wwww;\n    m = a;\n    s = 1.0 / c.x; s = s > 0.0 ? clamp(s, 5.42101e-20, 1.884467e19) : clamp(s, -1.884467e19, -5.42101e-20); i = vec4(s);\n    R[1].x = i.x;\n    O[3].xyzw = m.xyzw;\n  }\n  { vec4 a = O[0].xyzz, b = C[58].xyzz, c = v0.xxxx;\n    m = a * b;\n    O[0].xyz = m.xyz;\n  }\n  { vec4 a = v2.xxxx, b = v2.xxxx, c = v2;\n    i = c;\n    O[7].xyzw = i.xyzw;\n  }\n  { vec4 a = R[2], b = v0.xxxx, c = C[1];\n    m = a + c;\n    O[9].xyzw = m.xyzw;\n  }\n  { vec4 a = O[0].xyzz, b = R[1].xxxx, c = C[59].xyzz;\n    m = a * b + c;\n    O[0].xyz = m.xyz;\n  }\n  vec4 P = O[0]; float w = P.w;\n  float zn = P.z / abs(uRT.z);\n  vec3 nd = vec3(P.x / uRT.x * 2.0 - 1.0, 1.0 - P.y / uRT.y * 2.0, uRT.z < 0.0 ? zn / 64.0 : zn * 2.0 - 1.0);\n  gl_Position = vec4(nd * w, w);\n  vD0 = O[3]; vD1 = O[4]; vFog = O[5].x; vT0 = O[9]; vT1 = O[10]; vT2 = O[11]; vT3 = O[12];\n}"},"ps":{"1qzvkw8":{"ps":{"alphaIn":[0,3637776400,366006581,0,0,0,0,0],"finalABCD":12,"finalEFG":7296,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[0,192,3328,0,0,0,0,0],"rgbIn":[3355705344,0,0,3386712268,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[192,0,0,3072,0,0,0,0],"count":4,"countFlags":69892,"texModes":[1,1,0,0],"c0Map":4294963711,"c1Map":4294967295,"finalConsts":511},"stages":[[0,0,0,0,0,0],[0,0,0,0,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,false,false],"alpha":null,"tfactor":4294967295,"fog":0},"lsmbxy":{"ps":null,"stages":[[1,2,1,1,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[false,false,false,false],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"165dazy":{"ps":null,"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,false,false,false],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"fdzo7i":{"ps":{"alphaIn":[942673936,970723344,987500560,1004277776,0,0,0,0],"finalABCD":319750912,"finalEFG":201604224,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[192,192,192,192,0,0,0,0],"rgbIn":[3636985856,432655417,449498170,466340923,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[192,3072,3072,3072,0,0,0,0],"count":4,"countFlags":69892,"texModes":[1,1,1,1],"c0Map":4294967295,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,true,true],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"1jqt8n9":{"ps":{"alphaIn":[942673936,970723344,987500560,1004277776,0,0,0,0],"finalABCD":319750912,"finalEFG":201604224,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[192,192,192,192,0,0,0,0],"rgbIn":[3636985856,432655417,449498170,466340923,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[192,3072,3072,3072,0,0,0,0],"count":4,"countFlags":69892,"texModes":[1,1,1,1],"c0Map":4294967295,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,true,false],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"1finur6":{"ps":{"alphaIn":[942673936,970723344,987500560,1004277776,0,0,0,0],"finalABCD":319750912,"finalEFG":201604224,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[192,192,192,192,0,0,0,0],"rgbIn":[3636985856,432655417,449498170,466340923,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[192,3072,3072,3072,0,0,0,0],"count":4,"countFlags":69892,"texModes":[1,1,1,1],"c0Map":4294967295,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,false,false],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"1mdpljx":{"ps":{"alphaIn":[3637776400,0,0,0,0,0,0,0],"finalABCD":319554304,"finalEFG":7296,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[192,0,0,0,0,0,0,0],"rgbIn":[3368288256,180997162,0,0,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[192,3072,0,0,0,0,0,0],"count":2,"countFlags":69890,"texModes":[1,1,1,0],"c0Map":4294967295,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,true,false],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"1053q4u":{"ps":null,"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,false,false,false],"alpha":[516,0.6274509803921569],"tfactor":4294967295,"fog":3228459595},"1ypz4is":{"ps":{"alphaIn":[366006581,3625193488,0,3643841104,3660634416,0,3492846928,0],"finalABCD":319554317,"finalEFG":6272,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[3328,192,0,3072,19712,0,3072,0],"rgbIn":[0,3355705344,3420266700,0,3391146272,500026429,0,3223373088],"fc0":0,"fc1":0,"rgbOut":[0,192,3072,0,19712,3072,0,19712],"count":8,"countFlags":69896,"texModes":[1,1,1,1],"c0Map":4294967281,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,true,true],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"1hlmbwr":{"ps":{"alphaIn":[3637776400,0,0,0,0,0,0,0],"finalABCD":319554304,"finalEFG":6272,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[192,0,0,0,0,0,0,0],"rgbIn":[3368288256,3385925836,0,0,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[192,3072,0,0,0,0,0,0],"count":2,"countFlags":69890,"texModes":[1,1,0,0],"c0Map":4294967071,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,true,true],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"1roke1h":{"ps":{"alphaIn":[3643841104,3660634416,0,0,3492846928,0,3710965808,0],"finalABCD":319554304,"finalEFG":7296,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[3072,19712,0,0,3072,0,19456,0],"rgbIn":[0,3391146272,3721199616,3586654208,0,3441478688,0,0],"fc0":0,"fc1":0,"rgbOut":[0,19712,208,192,0,19456,0,0],"count":7,"countFlags":69895,"texModes":[1,1,1,0],"c0Map":4294967295,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,true,true],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"1gvtepi":{"ps":{"alphaIn":[3637579792,0,0,3710949712,3643858224,0,0,0],"finalABCD":319750912,"finalEFG":201596032,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[208,0,0,3072,19456,0,0,0],"rgbIn":[0,3369926656,432655417,0,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[0,192,3072,0,0,0,0,0],"count":5,"countFlags":69893,"texModes":[1,1,0,0],"c0Map":4294967280,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,true,true],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595},"11yau31":{"ps":null,"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,false,false,false],"alpha":[516,0.3137254901960784],"tfactor":4294967295,"fog":3228459595},"1lslkj5":{"ps":{"alphaIn":[942673936,970723344,987500560,1004277776,0,0,0,0],"finalABCD":319750912,"finalEFG":201604224,"c0":[0,0,0,0,0,0,0,0],"c1":[0,0,0,0,0,0,0,0],"alphaOut":[192,192,192,192,0,0,0,0],"rgbIn":[3636985856,432655417,449498170,466340923,0,0,0,0],"fc0":0,"fc1":0,"rgbOut":[192,3072,3072,3072,0,0,0,0],"count":4,"countFlags":69892,"texModes":[1,1,1,1],"c0Map":4294967295,"c1Map":4294967295,"finalConsts":511},"stages":[[4,2,0,4,2,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,true,false,false],"alpha":[516,0.3137254901960784],"tfactor":4294967295,"fog":3228459595},"1vy5poa":{"ps":null,"stages":[[4,2,0,2,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0],[1,0,0,1,0,0]],"present":[true,false,false,false],"alpha":[516,0],"tfactor":4294967295,"fog":3228459595}},"pairs":["ur1gek:1qzvkw8","gwerf3:lsmbxy","gwerf3:165dazy","1dsp06m:165dazy","1dsp06m:fdzo7i","1dsp06m:1jqt8n9","1dsp06m:1finur6","36ntnn:165dazy","khgbc8:165dazy","19udsqd:165dazy","1xkl8fk:1mdpljx","khgbc8:1053q4u","16ufl9m:1ypz4is","1hehtyj:1hlmbwr","1s6h5js:1roke1h","khgbc8:1gvtepi","1dsp06m:11yau31","1dsp06m:1lslkj5","ybux0a:1vy5poa","19udsqd:11yau31"]};
const strHash = str => { let x = 0x811c9dc5; for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619); return (x >>> 0).toString(36); };
const psHash = new Map();                        // pixel state id -> content key
const pre_spec = new Map(), pre_gen = new Map(); // "vsKey:psKey" / vsKey -> program entry (as in specProgs / e.gen)
const pre_vsh = new Map(), pre_fs = new Map();   // content key -> compiled shader
let cache = { vs: {}, ps: {}, pairs: [] }, cacheDirty = false;
try { const c = JSON.parse(localStorage.getItem(PRE_KEY) ?? "null"); if (c?.pairs) cache = c; } catch {}
for (const k in SEED.vs) cache.vs[k] ??= SEED.vs[k]; for (const k in SEED.ps) cache.ps[k] ??= SEED.ps[k];
const cachePairs = new Set([...SEED.pairs, ...cache.pairs]);
function notePair(e, ps) {
  const b = ps === null ? "g" : psHash.get(ps); if (!e.key || !b) return;
  const k = e.key + ":" + b; if (cachePairs.has(k)) return;
  cachePairs.add(k); cache.vs[e.key] ??= e.src; if (b !== "g") cache.ps[b] ??= pstates.get(ps); cacheDirty = true;
}
function saveCache() {
  if (!cacheDirty) return; cacheDirty = false;
  const pairs = [...cachePairs].slice(-400), vs = {}, ps = {};
  for (const k of pairs) { const [a, b] = k.split(":"); if (cache.vs[a]) vs[a] = cache.vs[a]; if (b !== "g" && cache.ps[b]) ps[b] = cache.ps[b]; }
  cache = { vs, ps, pairs };
  try { localStorage.setItem(PRE_KEY, JSON.stringify(cache)); } catch {}
}
function preShader(map, type, key, src) {
  let sh = map.get(key); if (!sh) { sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); map.set(key, sh); } return sh;
}
const preQueue = specOff ? [] : [...cachePairs];
function preTick() {                             // a few programs per animation frame, so opening the page stays smooth
  // (and at most ~4 ms of it: on Windows (ANGLE / Direct3D) a link can take 10-30 ms, and three a frame held the
  // boot screens at ~28 fps with the frames' acknowledgements 140 ms late)
  const t0 = performance.now();
  for (let n = 0; n < 3 && preQueue.length && performance.now() - t0 < 4;) {
    const k = preQueue.shift(), [a, b] = k.split(":"), src = cache.vs[a]; if (!src) continue;
    try {
      if (b === "g") {
        if (pre_gen.has(a)) continue;
        const p = gl.createProgram(); gl.attachShader(p, preShader(pre_vsh, gl.VERTEX_SHADER, a, src)); gl.attachShader(p, fragShader); gl.linkProgram(p);
        pre_gen.set(a, { pending: p, asked: -1 }); n++;
      } else {
        const st = cache.ps[b]; if (!st || pre_spec.has(k)) continue;
        const p = gl.createProgram(); gl.attachShader(p, preShader(pre_vsh, gl.VERTEX_SHADER, a, src)); gl.attachShader(p, preShader(pre_fs, gl.FRAGMENT_SHADER, b, specMain(st))); gl.linkProgram(p);
        pre_spec.set(k, { p, ready: false, prog: null, asked: -1 }); n++;
      }
    } catch (err) { console.error("building ahead:", err); }
  }
  if (preQueue.length) requestAnimationFrame(preTick); else requestAnimationFrame(finishTick);
}
requestAnimationFrame(preTick);
// ...and finishes them as their builds complete (link status, uniform locations: ~5 ms each), a few per animation
// frame while the page is idle. Finished at first use instead, the race weekend's first frame paid for ~19 of them
// at once ("shader finish×19 90 ms" in the slow-frame note).
function finishTick() {
  let left = 0, done = 0; const most = parallelLink ? 4 : 1;   // (without parallel builds a finish waits for the build)
  for (const [k, g] of pre_gen) {
    if (!g?.pending) continue; left++; if (done >= most) continue;
    if (parallelLink && !gl.getProgramParameter(g.pending, parallelLink.COMPLETION_STATUS_KHR)) continue;
    done++; const p = g.pending;
    if (gl.getProgramParameter(p, gl.LINK_STATUS)) { Object.assign(g, finishLink(p)); g.pending = null; progList.push(g); }
    else pre_gen.delete(k);                      // (a failed build: genericProgram builds and reports it on use)
  }
  for (const [k, x] of pre_spec) {
    if (!x || x.ready) continue; left++; if (done >= most) continue;
    if (parallelLink && !gl.getProgramParameter(x.p, parallelLink.COMPLETION_STATUS_KHR)) continue;
    done++; x.ready = true;
    if (gl.getProgramParameter(x.p, gl.LINK_STATUS)) { x.prog = finishLink(x.p); progList.push(x.prog); }
  }
  if (left > done) requestAnimationFrame(finishTick);
}

const blit = link(compile(gl.VERTEX_SHADER, BLIT_VS), compile(gl.FRAGMENT_SHADER, BLIT_FS), ["p"]);
// the loading bar (gl-remote OP_BLIT): part of an image copied into the picture on screen, pixel for pixel
const BAR_VS = `#version 300 es
in vec2 p; uniform vec2 uScale; out vec2 uv;
void main() { uv = vec2((p.x * 0.5 + 0.5) * uScale.x, (0.5 - p.y * 0.5) * uScale.y); gl_Position = vec4(p, 0.0, 1.0); }`;
const BAR_FS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D img; out vec4 o;
void main() { o = vec4(texture(img, uv).rgb, 1.0); }`;
const barProg = link(compile(gl.VERTEX_SHADER, BAR_VS), compile(gl.FRAGMENT_SHADER, BAR_FS), ["p"]);
const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const blitVao = gl.createVertexArray(); gl.bindVertexArray(blitVao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const drawVao = gl.createVertexArray();
// UI layer: textured, coloured triangles in UI pixel space (ui-remote.mjs), drawn over the 3D picture
const UI_VS = `#version 300 es
layout(location=0) in vec2 p; layout(location=1) in vec2 t; layout(location=2) in vec4 c;
uniform vec2 uSize; uniform vec4 uX; out vec2 vt; out vec4 vc;
void main() { vt = t; vc = c; gl_Position = vec4((p.x - uX.x) / uX.y * 2.0 - 1.0, 1.0 - (p.y - uX.z) / uX.w * 2.0, 0.0, 1.0); }`;
const UI_FS = `#version 300 es
precision mediump float; in vec2 vt; in vec4 vc; uniform sampler2D img; uniform int uTex; out vec4 o;
void main() { o = uTex == 1 ? vc * texture(img, vt) : vc; }`;
const uiProg = link(compile(gl.VERTEX_SHADER, UI_VS), compile(gl.FRAGMENT_SHADER, UI_FS), ["p", "t", "c"]);
const uiVao = gl.createVertexArray(), uiBuf = gl.createBuffer();
gl.bindVertexArray(uiVao); gl.bindBuffer(gl.ARRAY_BUFFER, uiBuf);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
gl.bindVertexArray(null);
const uiTextures = new Map(); let uiBatches = [], uiSize = [854, 480], uiSplit = 0;

// ------------------------------------------------------------------ resources
const programs = new Map(), buffers = new Map(), textures = new Map(), pstates = new Map(), targets = new Map(), samplers = new Map();
const consts = new Float32Array(192 * 4);
const pal32 = new Uint32Array(256); let texScratch = new Uint32Array(0);   // (little-endian: RGBA bytes)
const blank = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, blank); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
// Graphics options (the page's Graphics panel, saved in this browser as nt04.gfx):
//   aa:    multisample antialiasing, 0 / 2 / 4 / 8 samples (capped at the GPU's MAX_SAMPLES)
//   scale: render scale, 1 to 4: the game's targets (640 x 480) drawn at that many times the pixels (supersampling
//          when the view is no larger; a sharper picture on a big screen)
//   af:    texture filtering: 0 off (the game's textures without mipmaps, as before), 1 trilinear (mipmaps made here),
//          2 / 4 / 8 / 16 anisotropic (with mipmaps; capped at the GPU's maximum)
const afExt = gl.getExtension("EXT_texture_filter_anisotropic");
const GFX_MAX = { samples: gl.getParameter(gl.MAX_SAMPLES) | 0, af: afExt ? gl.getParameter(afExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1 };
const gfx = { aa: 0, scale: 1, af: 0 };
try { Object.assign(gfx, JSON.parse(localStorage.getItem("nt04.gfx")) ?? {}); } catch {}
const gfxSamples = () => { const n = Math.min(gfx.aa | 0, GFX_MAX.samples); return n >= 2 ? n : 0; };
const gfxScale = () => Math.max(1, Math.min(4, gfx.scale | 0));
function setGfx(k, v) {
  gfx[k] = v; try { localStorage.setItem("nt04.gfx", JSON.stringify(gfx)); } catch {}
  if (k === "af") { for (const s of samplers.values()) gl.deleteSampler(s); samplers.clear(); }
  stateReset(); show();   // (targets are made again at their next use with the new size / samples)
}
// the Graphics panel (main.mjs page): options the GPU lacks are greyed out
{ const sel = (id, key) => { const el = document.getElementById(id); if (!el) return;
    for (const o of el.options) { const v = +o.value; if ((key === "aa" && v > GFX_MAX.samples) || (key === "af" && v > 1 && (!afExt || v > GFX_MAX.af))) o.disabled = true; }
    el.value = String(gfx[key]); if (el.selectedIndex < 0) el.value = el.options[0].value;
    el.onchange = () => setGfx(key, +el.value); };
  sel("gfxAA", "aa"); sel("gfxScale", "scale"); sel("gfxAF", "af");
  const n = document.getElementById("gfxNote");
  if (n) n.textContent = `This GPU: up to ${GFX_MAX.samples}x MSAA, ${afExt ? `${GFX_MAX.af}x anisotropic filtering` : "no anisotropic filtering"}. Render scale draws the 3D picture at more pixels (supersampling on a smaller view); MSAA smooths polygon edges. Higher settings cost GPU time.`; }
function freeTarget(t) {
  gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); gl.deleteRenderbuffer(t.depth);
  if (t.msFbo) { gl.deleteFramebuffer(t.msFbo); gl.deleteRenderbuffer(t.msColor); }
}
// A target: the texture the game's picture ends in (t.tex, t.sw x t.sh = the game's w x h times the render scale)
// and, with antialiasing, a multisampled colour + depth framebuffer the draws go to (t.draw), resolved into the
// texture when the picture is next read (shown, sampled by a draw, copied: resolve)
function target(id, w, h) {
  let t = targets.get(id);
  const k = gfxScale(), ms = gfxSamples();
  if (t && (t.w !== w || t.h !== h || t.k !== k || t.ms !== ms)) { freeTarget(t); targets.delete(id); t = null; }
  if (!t) {
    const sw = w * k, sh = h * k;
    t = { w, h, k, ms, sw, sh, fbo: gl.createFramebuffer(), tex: gl.createTexture(), depth: gl.createRenderbuffer(), msFbo: null, msColor: null, dirty: false };
    gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
    if (ms) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, ms, gl.DEPTH24_STENCIL8, sw, sh); else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, sw, sh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    if (ms) {
      t.msFbo = gl.createFramebuffer(); t.msColor = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, t.msColor); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, ms, gl.RGBA8, sw, sh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.msColor);
    }
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, t.depth);
    t.draw = t.msFbo ?? t.fbo;
    targets.set(id, t); stateReset();
  }
  return t;
}
// the multisampled picture into the target's texture, when it was drawn to since the last time
function resolve(t) {
  if (!t.msFbo || !t.dirty) return;
  gl.disable(gl.SCISSOR_TEST); S.sci = null;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fbo);
  gl.blitFramebuffer(0, 0, t.sw, t.sh, 0, 0, t.sw, t.sh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); S.fbo = undefined; t.dirty = false;
}
function sampler(sp, mip = false) {            // packed: wrap u | wrap v << 8 | linear << 16; mip: mipmapped texture
  const key = mip ? sp + 0x1000000 : sp;
  let s = samplers.get(key); if (s) return s;
  const u = sp & 0xff, v = (sp >> 8) & 0xff, lin = (sp >> 16) & 0xff;
  const wrap = m => m === 2 ? gl.MIRRORED_REPEAT : m === 3 || m === 4 ? gl.CLAMP_TO_EDGE : gl.REPEAT;
  s = gl.createSampler(); gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap(u)); gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap(v));
  gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, mip ? (lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR) : lin ? gl.LINEAR : gl.NEAREST);
  gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  if (mip && afExt && gfx.af >= 2) gl.samplerParameterf(s, afExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(gfx.af, GFX_MAX.af));
  samplers.set(key, s); return s;
}
// Paletted textures expanded by the GPU: the indices go up as a one-byte texture and the 256-entry palette as a 256 x 1
// one, and a pass draws palette[index] into the texture's own RGBA storage. Expanding on the CPU and uploading RGBA
// (four bytes a pixel) cost ~110 ms for the ~200 paletted textures the race weekend's first frame brings. ?palgpu=0:
// the CPU way.
const noZBias = new URLSearchParams(location.search).get("zbias") === "0";   // (?zbias=0: depth bias off, for comparison)
const palGPU = new URLSearchParams(location.search).get("palgpu") !== "0";
const PAL_FS = `#version 300 es
precision highp float; uniform highp usampler2D idx; uniform sampler2D pal; out vec4 o;
void main() { uint i = texelFetch(idx, ivec2(gl_FragCoord.xy), 0).r; o = texelFetch(pal, ivec2(int(i), 0), 0); }`;
let palProg = null, palIdxTex = null, palPalTex = null, palFbo = null;
function palExpand(t, w, h, idx) {
  gl.disable(gl.SCISSOR_TEST); S.sci = null; gl.disable(gl.STENCIL_TEST); S.stn = 0;
  if (!palProg) {
    palProg = link(compile(gl.VERTEX_SHADER, BLIT_VS), compile(gl.FRAGMENT_SHADER, PAL_FS), ["p"]);
    palIdxTex = gl.createTexture(); palPalTex = gl.createTexture(); palFbo = gl.createFramebuffer();
    for (const x of [palIdxTex, palPalTex]) { gl.bindTexture(gl.TEXTURE_2D, x); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); }
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.activeTexture(gl.TEXTURE0); gl.bindSampler(0, null); gl.bindTexture(gl.TEXTURE_2D, palIdxTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, idx);
  gl.activeTexture(gl.TEXTURE1); gl.bindSampler(1, null); gl.bindTexture(gl.TEXTURE_2D, palPalTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pal32.buffer));
  gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, palFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.viewport(0, 0, w, h); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true);
  gl.useProgram(palProg.p); gl.bindVertexArray(blitVao); gl.uniform1i(palProg.u.idx, 0); gl.uniform1i(palProg.u.pal, 1);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palPalTex); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, palIdxTex);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
  stateReset();
}
function resource(r, blob) {
  stateReset();                                 // uploads bind buffers / textures behind the draw state cache
  switch (r.op) {
    case "vs": {                                 // compiled now, linked on first use (see programFor)
      const old = programs.get(r.id);
      if (old) for (const k of specProgs.keys()) if (Math.floor(k / 65536) === r.id) specProgs.delete(k);   // a redefined vertex program
      // (its programs stay built and in progList: they are kept by content and may be used again)
      const vsh = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vsh, r.src); gl.compileShader(vsh);
      programs.set(r.id, { vsShader: vsh, src: r.src, gen: undefined, key: strHash(r.src) });
      break; }
    case "buf": { let b = buffers.get(r.id); if (!b) { b = gl.createBuffer(); buffers.set(r.id, b); }
      const target = r.index ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER; if (r.index) gl.bindVertexArray(null);
      gl.bindBuffer(target, b); gl.bufferData(target, blob(r.blob), gl.STATIC_DRAW); break; }
    case "tex": { let t = textures.get(r.id); if (!t) { t = gl.createTexture(); textures.set(r.id, t); }
      gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, r.w, r.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, blob(r.blob)); t.mip = false; break; }   // (mipmaps made at the next use: draw)
    case "texp8": {                              // paletted texture: indices + BGRA palette, expanded here
      const idx = blob(r.blob), pb = blob(r.pal), n = r.w * r.h;
      for (let i = 0; i < 256; i++) { const o = i * 4; pal32[i] = o + 3 < pb.length ? (pb[o + 2] | (pb[o + 1] << 8) | (pb[o] << 16) | (pb[o + 3] << 24)) >>> 0 : 0; }
      let t = textures.get(r.id); if (!t) { t = gl.createTexture(); textures.set(r.id, t); }
      t.mip = false; if (palGPU) { palExpand(t, r.w, r.h, idx); break; }
      if (texScratch.length < n) texScratch = new Uint32Array(n);
      for (let i = 0; i < n; i++) texScratch[i] = pal32[idx[i]];
      gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, r.w, r.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(texScratch.buffer, 0, n * 4)); break; }
    case "ps": pstates.set(r.id, r.state); psHash.set(r.id, strHash(JSON.stringify(r.state))); break;
    case "pskey": psKeys.set(r.key, r.id); break;
    case "consts": consts.set(new Float32Array(blob(r.blob).slice().buffer)); constsChanged(0, 192); break;   // (a capture's starting state, see Capture)
    case "free": { const b = buffers.get(r.id); if (b) { gl.deleteBuffer(b); buffers.delete(r.id); dropVaosOf(r.id); } const t = textures.get(r.id); if (t) { gl.deleteTexture(t); textures.delete(r.id); } break; }
  }
}

// ------------------------------------------------------------------ drawing
const MODES = { points: gl.POINTS, lines: gl.LINES, lineLoop: gl.LINE_LOOP, lineStrip: gl.LINE_STRIP, triangles: gl.TRIANGLES, triangleStrip: gl.TRIANGLE_STRIP, triangleFan: gl.TRIANGLE_FAN };
const stats = { total: 0, frames: 0, draws: 0, errors: 0, bytes: 0, t: performance.now(), fps: 0, drawMs: 0, drawMax: 0, empty: 0, queued: 0 };
let progList = [];
// vertex constants: each program uploads only the registers changed since its own last upload (the whole 3 KB array
// went up whenever any register changed — on most draws, as every car / object sets its own matrices)
function constsChanged(lo, hi) { for (const q of progList) { if (lo < q.dlo) q.dlo = lo; if (hi > q.dhi) q.dhi = hi; } }
function uploadConsts(prog) {
  const lo = prog.dlo, hi = Math.min(prog.dhi, prog.cN); prog.dlo = 192; prog.dhi = 0; if (hi <= lo) return;
  const loc = prog.cLoc[lo] ?? (prog.cLoc[lo] = gl.getUniformLocation(prog.p, `C[${lo}]`));
  if (loc) gl.uniform4fv(loc, consts, lo * 4, (hi - lo) * 4);
}
// GL state as last set by draw(): a WebGL call costs far more than a comparison (each one is validated and sent to
// the GPU process), and consecutive draws mostly repeat the same states. Anything else that touches GL state
// (uploads, clears, the final blit, the UI layer) calls stateReset().
const S = { fbo: null, vp0: 0, vp1: 0, vp2: 0, vp3: 0, prog: null, unit: -1, tex: [], smp: [], blend: -1, bf0: -1, bf1: -1, beq: -1, bc: -1,
  zt: -1, zf: -1, zm: -1, cull: -1, cm: -1, vao: null };
// The viewport's rectangle as a GL scissor box, or null when it covers the target (or is empty: left alone). Draws
// and clears are confined to it as on the console: the race's rear-view mirror is the scene drawn again from a
// camera looking back into a 182 x 60 viewport at the top of the back buffer; its programs leave positions in screen
// space (so the GL viewport is the whole target), and without a box everything of that pass outside the strip
// covered the picture: the view seemed to turn round whenever the mirror was on.
function scissorFor(x, y, w, h, t) {
  if (!(w > 0 && h > 0)) return null;
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(t.w, Math.ceil(x + w)), y1 = Math.min(t.h, Math.ceil(y + h));
  if (x0 <= 0 && y0 <= 0 && x1 >= t.w && y1 >= t.h) return null;
  const k = t.k ?? 1; return [x0 * k, (t.h - y1) * k, Math.max(0, x1 - x0) * k, Math.max(0, y1 - y0) * k];
}
function stateReset() { gl.disable(gl.SCISSOR_TEST); S.sci = null; gl.disable(gl.STENCIL_TEST); gl.stencilMask(0xff); S.stn = 0; S.fbo = undefined; S.vp2 = -1; S.prog = null; S.unit = -1; S.tex = [undefined, undefined, undefined, undefined]; S.smp = [undefined, undefined, undefined, undefined];
  S.blend = -1; S.bf0 = S.bf1 = S.beq = S.bc = -1; S.zt = S.zf = S.zm = S.cull = S.cm = S.zb = -1; S.vao = undefined; }
stateReset();
// One draw, decoded into this single reused object (a new object, arrays and strings per draw — ~10 allocations, about
// 10,000 per race frame — made the page pause for garbage collection now and then)
const D = { mode: 0, count: 0, ib: 0, vs: 0, rtId: 0, rtW: 0, rtH: 0, screen: false, zs: 0, vp0: 0, vp1: 0, vp2: 0, vp3: 0,
  na: 0, attrs: new Int32Array(16 * 5), nc: 0, cStart: new Int32Array(192), cN: new Int32Array(192), cOff: new Int32Array(192), cSrc: null,
  blend: false, b0: 0, b1: 0, b2: 0, b3: 0, ztest: false, zfunc: 0, zwrite: false, cmask: 0, cull: 0, zbias: 0, ps: undefined,
  tKind: new Int32Array(4), tId: new Int32Array(4), tW: new Int32Array(4), tH: new Int32Array(4), tLin: new Int32Array(4), tS: new Int32Array(4), vkey: 0 };
// vertex layouts: one vertex array object per distinct (attributes, index buffer); the key is a hash of those words,
// checked against the words kept with the entry
const vaos = new Map(), vaoRefs = new Map();     // key -> { vao, words }; buffer id -> keys of the VAOs that use it
function dropVaos() { for (const v of vaos.values()) gl.deleteVertexArray(v.vao); vaos.clear(); vaoRefs.clear(); S.vao = undefined; }
function dropVaosOf(id) {
  const keys = vaoRefs.get(id); if (!keys) return; vaoRefs.delete(id);
  for (const k of keys) { const v = vaos.get(k); if (v) { gl.deleteVertexArray(v.vao); vaos.delete(k); } }
  S.vao = undefined;
}
function layoutKey(d) {
  let h = Math.imul(0x811c9dc5 ^ d.ib, 16777619); const A = d.attrs;
  for (let i = 0, n = d.na * 5; i < n; i++) h = Math.imul(h ^ A[i], 16777619);
  return (h ^ d.na) >>> 0;
}
function sameLayout(e, d) {
  const w = e.words; if (w.length !== d.na * 5 + 1 || w[0] !== d.ib) return false;
  for (let i = 0; i < d.na * 5; i++) if (w[i + 1] !== d.attrs[i]) return false;
  return true;
}
let tmpVao = null;
function vaoFor(d) {
  const e = vaos.get(d.vkey); if (e !== undefined && sameLayout(e, d)) return e.vao;
  if (vaos.size > 8192) dropVaos();
  const v = gl.createVertexArray(); gl.bindVertexArray(v); S.vao = v;
  let complete = true; const A = d.attrs;
  for (let i = 0; i < d.na; i++) {
    const reg = A[i * 5], buf = A[i * 5 + 1], offset = A[i * 5 + 2], stride = A[i * 5 + 3], type = A[i * 5 + 4];
    const b = buffers.get(buf); if (!b) { complete = false; continue; }
    gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(reg);
    const kind = type & 15, n = type >> 4;
    if (type === 0x40) gl.vertexAttribPointer(reg, 4, gl.UNSIGNED_BYTE, true, stride, offset);
    else if (type === 0x16) gl.vertexAttribIPointer(reg, 1, gl.UNSIGNED_INT, stride, offset);
    else if (type === 0x72) gl.vertexAttribPointer(reg, 3, gl.FLOAT, false, stride, offset);
    else if (kind === 2) gl.vertexAttribPointer(reg, Math.max(1, n), gl.FLOAT, false, stride, offset);
    else if (kind === 5) gl.vertexAttribPointer(reg, Math.max(1, n), gl.SHORT, false, stride, offset);
    else if (kind === 1) gl.vertexAttribPointer(reg, Math.max(1, n), gl.SHORT, true, stride, offset);
    else if (kind === 4) gl.vertexAttribPointer(reg, Math.max(1, n), gl.UNSIGNED_BYTE, true, stride, offset);
    else gl.disableVertexAttribArray(reg);
  }
  if (d.ib) { const ib = buffers.get(d.ib); if (ib) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); }
  if (!complete || e !== undefined) { tmpVao = v; return v; }   // a buffer not here yet (it may arrive later), or a hash clash: not kept
  const words = new Int32Array(d.na * 5 + 1); words[0] = d.ib; words.set(A.subarray(0, d.na * 5), 1);
  vaos.set(d.vkey, { vao: v, words });
  const ref = id => { let a = vaoRefs.get(id); if (!a) vaoRefs.set(id, a = []); a.push(d.vkey); };
  if (d.ib) ref(d.ib); for (let i = 0; i < d.na; i++) if (buffers.has(A[i * 5 + 1])) ref(A[i * 5 + 1]);
  return v;
}
const psKeys = new Map();                     // capture key -> pixel state id (IGL2 frames)
function applyPs(prog, ps) {
  const u = prog.u, st = pstates.get(ps); if (!st) return;
  const P = st.ps;
  gl.uniform1i(u.uMode, P ? 1 : 0);
  if (P) {
    gl.uniform4i(u.uTexModes, ...P.texModes);
    gl.uniform1uiv(u.uRgbIn, P.rgbIn); gl.uniform1uiv(u.uRgbOut, P.rgbOut); gl.uniform1uiv(u.uAlphaIn, P.alphaIn); gl.uniform1uiv(u.uAlphaOut, P.alphaOut);
    gl.uniform1uiv(u.uC0, P.c0); gl.uniform1uiv(u.uC1, P.c1);
    gl.uniform1ui(u.uFinalABCD, P.finalABCD >>> 0); gl.uniform1ui(u.uFinalEFG, P.finalEFG >>> 0); gl.uniform1ui(u.uFc0, P.fc0 >>> 0); gl.uniform1ui(u.uFc1, P.fc1 >>> 0);
    gl.uniform1ui(u.uCountFlags, P.countFlags >>> 0); gl.uniform1i(u.uCount, P.count);
  }
  const S = st.stages, col = k => S.map(s => s[k] | 0);
  gl.uniform4i(u.uCop, ...col(0)); gl.uniform4i(u.uCa1, ...col(1)); gl.uniform4i(u.uCa2, ...col(2)); gl.uniform4i(u.uAop, ...col(3)); gl.uniform4i(u.uAa1, ...col(4)); gl.uniform4i(u.uAa2, ...col(5));
  gl.uniform1ui(u.uTFactor, st.tfactor >>> 0); gl.uniform1ui(u.uFogColor, st.fog >>> 0);
  gl.uniform1i(u.uAlphaFunc, st.alpha ? st.alpha[0] : -1); gl.uniform1f(u.uAlphaRef, st.alpha ? st.alpha[1] : 0);
}
// a draw with the same state as the draw just made (OP_DRAW_SAME): the program, target, viewport, textures and render
// states are all set already, so only the constants, the vertex array and the draw call (the full path when the
// previous draw did not get as far as drawing)
let sameOk = false;
let curTarget = null;   // (the target of the last draw: OP_DRAW_SAME draws into it too)
function drawSame(d) {
  if (!sameOk) { draw(d); return; }
  if (curTarget) curTarget.dirty = true;
  for (let k = 0; k < d.nc; k++) {
    const st = d.cStart[k], n = d.cN[k] * 4, src = d.cSrc, o = d.cOff[k], dst = st * 4;
    for (let i = 0; i < n; i++) consts[dst + i] = src[o + i];
    constsChanged(st, st + d.cN[k]);
  }
  if (d.mode < 0 || (d.ib && !buffers.has(d.ib))) return;
  const prog = S.prog; if (prog.dhi > prog.dlo) uploadConsts(prog);
  const vao = vaoFor(d); if (S.vao !== vao) { gl.bindVertexArray(vao); S.vao = vao; }
  if (d.ib) gl.drawElements(d.mode, d.count, gl.UNSIGNED_SHORT, 0);
  else gl.drawArrays(d.mode, 0, d.count);
  if (tmpVao) { gl.deleteVertexArray(tmpVao); tmpVao = null; S.vao = undefined; }
  stats.draws++;
}
function draw(d) {
  sameOk = false;
  // the draw's vertex constants first: they are incremental state, kept even when this draw is skipped
  for (let k = 0; k < d.nc; k++) {
    const st = d.cStart[k], n = d.cN[k] * 4, src = d.cSrc, o = d.cOff[k], dst = st * 4;
    for (let i = 0; i < n; i++) consts[dst + i] = src[o + i];
    constsChanged(st, st + d.cN[k]);
  }
  const prog = programFor(d.vs, d.ps); if (!prog) return;
  if (d.mode < 0) return;
  if (d.ib && !buffers.has(d.ib)) return;
  const t = target(d.rtId, d.rtW, d.rtH), L = prog.last, k = t.k;
  if (S.prog !== prog) { gl.useProgram(prog.p); S.prog = prog;   // (before the textures: their size uniforms are the program's)
    if (!prog.samplersSet) { gl.uniform1i(prog.u.t0, 0); gl.uniform1i(prog.u.t1, 1); gl.uniform1i(prog.u.t2, 2); gl.uniform1i(prog.u.t3, 3); prog.samplersSet = true; } }
  // (textures first: resolving a target the draw samples binds framebuffers)
  let on = 0, lin = 0, flip = 0, selfUsed = false;   // (a draw that reads its own target copies it first: never repeated as OP_DRAW_SAME)
  const wantMip = gfx.af > 0;
  for (let s = 0; s < 4; s++) {
    const kind = d.tKind[s];
    let tex = null;
    if (kind === 2) { const rt = targets.get(d.tId[s] >>> 0); tex = rt ? (rt !== t ? (resolve(rt), rt.tex) : (selfUsed = true, selfCopy(t))) : null; }
    else if (kind) tex = textures.get(d.tId[s]) ?? null;
    const bt = tex ?? blank;
    if (wantMip && kind !== 2 && tex && !tex.mip) {   // mipmaps for the filtering option, made when the texture is first used after an upload
      if (S.unit !== s) { gl.activeTexture(gl.TEXTURE0 + s); S.unit = s; }
      gl.bindTexture(gl.TEXTURE_2D, tex); gl.generateMipmap(gl.TEXTURE_2D); tex.mip = true; S.tex[s] = tex;
    }
    const sm = kind ? sampler(d.tS[s], wantMip && kind !== 2 && !!tex?.mip) : null;
    if (S.tex[s] !== bt || S.smp[s] !== sm) {
      if (S.unit !== s) { gl.activeTexture(gl.TEXTURE0 + s); S.unit = s; }
      if (S.tex[s] !== bt) { gl.bindTexture(gl.TEXTURE_2D, bt); S.tex[s] = bt; }
      if (S.smp[s] !== sm) { gl.bindSampler(s, sm); S.smp[s] = sm; }
    }
    if (tex) { on |= 1 << s; if (d.tLin[s]) lin |= 1 << s; if (kind === 2) flip |= 1 << s;
      const w = d.tW[s], h = d.tH[s]; if (L.tw[s] !== w || L.th[s] !== h) { gl.uniform4f(prog.ts[s], w, h, 0, 0); L.tw[s] = w; L.th[s] = h; } }
  }
  if (S.fbo !== t.draw) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.draw); S.fbo = t.draw; }
  t.dirty = true; curTarget = t;
  // (the game's pixels times the render scale; the shaders keep the game's own target size, uRT)
  let v0, v1, v2, v3; if (d.screen) { v0 = 0; v1 = 0; v2 = t.sw; v3 = t.sh; } else { v0 = d.vp0 * k; v1 = (t.h - d.vp1 - d.vp3) * k; v2 = d.vp2 * k; v3 = d.vp3 * k; }
  if (S.vp0 !== v0 || S.vp1 !== v1 || S.vp2 !== v2 || S.vp3 !== v3) { gl.viewport(v0, v1, v2, v3); S.vp0 = v0; S.vp1 = v1; S.vp2 = v2; S.vp3 = v3; }
  { const sc = scissorFor(d.vp0, d.vp1, d.vp2, d.vp3, t), k = sc ? sc.join(",") : null;
    if (S.sci !== k) { if (sc) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...sc); } else gl.disable(gl.SCISSOR_TEST); S.sci = k; }
    // An inset view (a viewport smaller than the target: the race's rear-view mirror) keeps its rectangle: it is
    // marked in the stencil buffer (cleared to 1 there, once per frame) and full-view draws test stencil == 0. The
    // race draws both views object by object into one depth buffer, so the main view's near geometry (the catch
    // fence along the wall) won the depth test inside the mirror and showed through it.
    if (sc) { if (!(t.masks ??= new Set()).has(k)) { t.masks.add(k); gl.stencilMask(0xff); gl.clearStencil(1); gl.clear(gl.STENCIL_BUFFER_BIT); gl.clearStencil(0); }
      if (S.stn !== 0) { gl.disable(gl.STENCIL_TEST); S.stn = 0; } }
    else if (t.masks?.size) { if (S.stn !== 1) { gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.EQUAL, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP); gl.stencilMask(0); S.stn = 1; } }
    else if (S.stn !== 0) { gl.disable(gl.STENCIL_TEST); S.stn = 0; } }
  if (prog.dhi > prog.dlo) uploadConsts(prog);
  if (L.rtw !== t.w || L.rth !== t.h || L.zs !== d.zs) { gl.uniform3f(prog.u.uRT, t.w, t.h, d.zs); L.rtw = t.w; L.rth = t.h; L.zs = d.zs; }
  if (L.ps !== d.ps) { applyPs(prog, d.ps); L.ps = d.ps; }          // (uniforms belong to the program: kept per program)
  if (L.on !== on) { gl.uniform4i(prog.u.uTexOn, on & 1, (on >> 1) & 1, (on >> 2) & 1, (on >> 3) & 1); L.on = on; }
  if (L.lin !== lin) { gl.uniform4i(prog.u.uTexLinear, lin & 1, (lin >> 1) & 1, (lin >> 2) & 1, (lin >> 3) & 1); L.lin = lin; }
  if (L.flip !== flip) { gl.uniform4i(prog.u.uTexFlip, flip & 1, (flip >> 1) & 1, (flip >> 2) & 1, (flip >> 3) & 1); L.flip = flip; }
  // render states
  if (d.blend) {
    if (S.blend !== 1) { gl.enable(gl.BLEND); S.blend = 1; }
    const b0 = d.b0, b1 = d.b1, eq = d.b2, bc = d.b3 >>> 0;
    if (S.bf0 !== b0 || S.bf1 !== b1) { gl.blendFunc(b0, b1); S.bf0 = b0; S.bf1 = b1; }
    if (S.beq !== eq) { gl.blendEquation(eq); S.beq = eq; }
    if (S.bc !== bc) { gl.blendColor(((bc >> 16) & 255) / 255, ((bc >> 8) & 255) / 255, (bc & 255) / 255, (bc >>> 24) / 255); S.bc = bc; }
  } else if (S.blend !== 0) { gl.disable(gl.BLEND); S.blend = 0; }
  if (d.ztest) { if (S.zt !== 1) { gl.enable(gl.DEPTH_TEST); S.zt = 1; } if (S.zf !== d.zfunc) { gl.depthFunc(d.zfunc); S.zf = d.zfunc; } }
  else if (S.zt !== 0) { gl.disable(gl.DEPTH_TEST); S.zt = 0; }
  const zm = d.ztest && d.zwrite ? 1 : 0; if (S.zm !== zm) { gl.depthMask(!!zm); S.zm = zm; }
  const cull = d.cull === 0x901 || d.cull === 0x900 ? d.cull : 0;
  if (S.cull !== cull) { if (cull) { gl.enable(gl.CULL_FACE); gl.cullFace(cull === 0x901 ? gl.FRONT : gl.BACK); } else gl.disable(gl.CULL_FACE); S.cull = cull; }
  // depth bias as the NV2A gets it from D3DRS_ZBIAS (factor -0.25 v, units -v)
  const zb = d.ztest && !noZBias ? d.zbias | 0 : 0; if (S.zb !== zb) { if (zb) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-0.25 * zb, -zb); } else gl.disable(gl.POLYGON_OFFSET_FILL); S.zb = zb; }
  const cm = d.cmask >>> 0; if (S.cm !== cm) { gl.colorMask(!!(cm & 0x00010000), !!(cm & 0x00000100), !!(cm & 0x00000001), !!(cm & 0x01000000)); S.cm = cm; }
  // attributes + index buffer: a cached vertex array object
  const vao = vaoFor(d); if (S.vao !== vao) { gl.bindVertexArray(vao); S.vao = vao; }
  if (d.ib) gl.drawElements(d.mode, d.count, gl.UNSIGNED_SHORT, 0);
  else gl.drawArrays(d.mode, 0, d.count);
  if (tmpVao) { gl.deleteVertexArray(tmpVao); tmpVao = null; S.vao = undefined; }
  stats.draws++; sameOk = !selfUsed;
}
function clear(c) {
  sameOk = false;
  const t = target(c.rt.id, c.rt.w, c.rt.h); gl.bindFramebuffer(gl.FRAMEBUFFER, t.draw); gl.viewport(0, 0, t.sw, t.sh); t.dirty = true;
  let bits = 0;
  if (c.flags & 0xf0) { const x = c.color >>> 0; gl.colorMask(true, true, true, true); gl.clearColor(((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255, (x >>> 24) / 255); bits |= gl.COLOR_BUFFER_BIT; }
  if (c.flags & 1) { gl.depthMask(true); gl.clearDepth(c.z); bits |= gl.DEPTH_BUFFER_BIT; }
  if (c.flags & 2) { gl.clearStencil(0); gl.stencilMask(0xff); bits |= gl.STENCIL_BUFFER_BIT; }
  const full = !(c.vp && scissorFor(c.vp[0], c.vp[1], c.vp[2], c.vp[3], t));
  if (full && bits) { gl.clearStencil(0); gl.stencilMask(0xff); bits |= gl.STENCIL_BUFFER_BIT; t.masks = null; }   // (the inset masks of the last frame go)
  if (bits) { const sc = c.vp && scissorFor(c.vp[0], c.vp[1], c.vp[2], c.vp[3], t); if (sc) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...sc); } gl.clear(bits); if (sc) gl.disable(gl.SCISSOR_TEST); }
  // a front-end car preview (NT04_PREVIEW): the UI drawn before the car object goes into the back buffer first, so
  // the car lands on the menu background as in the game (the rest of the UI is drawn over the picture in show)
  if (uiSplit > 0 && showUI && (c.flags & 0xf0) && lastBack && lastBack.id === c.rt.id) { gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); drawUI(0, uiSplit); }
  stateReset();
}
// A draw that samples the very target it draws into (the loading screen's fade-in blends the picture already there
// with the new one) gets a copy of the target as it is: WebGL cannot read and write one texture in a draw.
let selfTex = null, selfW = 0, selfH = 0;
function selfCopy(t) {
  if (!selfTex) selfTex = gl.createTexture();
  if (S.unit !== 0) { gl.activeTexture(gl.TEXTURE0); S.unit = 0; }
  resolve(t); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); S.fbo = t.fbo;   // (copied from the resolved picture)
  gl.bindTexture(gl.TEXTURE_2D, selfTex); S.tex[0] = undefined;
  if (selfW !== t.sw || selfH !== t.sh) { gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, t.sw, t.sh, 0); selfW = t.sw; selfH = t.sh; }
  else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, t.sw, t.sh);
  return selfTex;
}
let lastBack = null, fit43 = false;
// F3: the 4:3 picture stretched to the view like the console on a 16:9 TV (default) / the UI's full 16:9 width
const TV_SCALE = 0.925;   // the 4:3 picture's share of the set's frame (see drawUI)
let stretch43 = true; try { stretch43 = localStorage.getItem("nt04.aspect") !== "wide"; } catch {}
function present(c) { lastBack = c.rt; sameOk = false; show(); }
// the loading screen's thread writes the bar into the front buffer: the picture last presented
function frontBlit(texId, sw, sh, x, y, w, h) {
  gl.disable(gl.SCISSOR_TEST); S.sci = null; gl.disable(gl.STENCIL_TEST); S.stn = 0;
  const t = lastBack && targets.get(lastBack.id), tex = textures.get(texId); if (!t || !tex) return;
  resolve(t); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(x * t.k, (t.h - y - h) * t.k, w * t.k, h * t.k);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true);
  gl.useProgram(barProg.p); gl.bindVertexArray(blitVao); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.bindSampler(0, sampler(0x0303)); gl.uniform1i(barProg.u.img, 0); gl.uniform2f(barProg.u.uScale, w / sw, h / sh);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  stateReset(); show();
}
function show() {
  gl.disable(gl.SCISSOR_TEST); S.sci = null; gl.disable(gl.STENCIL_TEST); S.stn = 0;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true); gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const bb = lastBack && targets.get(lastBack.id);
  if (bb) { resolve(bb); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
  gl.useProgram(blit.p); gl.bindVertexArray(blitVao); gl.activeTexture(gl.TEXTURE0); gl.bindSampler(0, null); gl.uniform1i(blit.u.img, 0);
  if (bb) {
    // the race loading screen (gl-remote "fit43") is a 2D picture made for 4:3: shown 4:3 in the middle, as the UI
    // layer shows its own 4:3 screens (the "Press START" screen that follows it), not stretched to the 16:9 view
    if (fit43 && !stretch43) { const w = Math.min(canvas.width, Math.round(canvas.height * 4 / 3)); gl.viewport((canvas.width - w) >> 1, 0, w, canvas.height); }
    // stretch43: the 3D picture fills the frame and the UI is drawn at TV_SCALE over it (drawUI). The game itself
    // works that way: the HUD script sizes the rear-view mirror's frame (10/0 state 2: x 325, y 17, scale 1.086 x 1.1)
    // so that at 0.92 about the centre it is exactly the mirror's viewport (227, 37, 182 x 60); with the 3D shrunk
    // like the UI the mirror sat outside its frame. (The garage behind the career menus reaches both sides too.)
    // (stretch43: nothing to set, the whole view)
    gl.bindTexture(gl.TEXTURE_2D, bb.tex); gl.uniform1i(blit.u.uFlip, 0); gl.uniform1i(blit.u.uPremul, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  if (uiBatches.length && showUI) drawUI(uiSplit, uiBatches.length);
  stateReset();
}
// The canvas's pixel size follows its size on screen (times the display's pixel ratio, up to 4K wide), so the menus,
// HUD and text are drawn at the screen's own resolution rather than at a fixed 1708 x 960 the browser then stretched
// (upscaled UI textures, textures/README.txt, only pay off this way). The 3D picture is still the game's 640 x 480.
// ?res=fixed keeps the old fixed size.
const fixedRes = new URLSearchParams(location.search).get("res") === "fixed";
function fitCanvas() {
  if (fixedRes) return;
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  let w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (w < 64 || h < 48) return;
  const k = Math.min(1, 3840 / w); w = Math.round(w * k); h = Math.round(h * k);
  if (w === canvas.width && h === canvas.height) return;
  canvas.width = w; canvas.height = h; show();
}
addEventListener("resize", fitCanvas);
if (typeof ResizeObserver !== "undefined") new ResizeObserver(fitCanvas).observe(canvas);
setTimeout(fitCanvas, 0);
// UI batches [from, to) into the bound framebuffer
let uiDrawnAt = 0;
function drawUI(from, to) {
  gl.disable(gl.SCISSOR_TEST); S.sci = null; gl.disable(gl.STENCIL_TEST); S.stn = 0;
  uiDrawnAt = performance.now();
  gl.useProgram(uiProg.p); gl.bindVertexArray(uiVao); gl.uniform2f(uiProg.u.uSize, uiSize[0], uiSize[1]); gl.uniform1i(uiProg.u.img, 0);
  // UI space is 854 wide; a 4:3 television shows x 107..747 of it (the game's own 4:3 camera), and a 16:9 set
  // stretches that picture across the screen, 3D and menus alike: "stretch43" draws it that way (as on the real
  // console on a widescreen TV), otherwise the whole 854 is shown unstretched
  // On the console the picture also sits inside the set's frame: recordings of it (two capture set-ups, compared
  // with the same screens here) show about 8% more on every side than the 4:3 picture's x 107..747 / y 0..480, with
  // black above and below and the UI's wider-than-4:3 sides filling the left and right. "stretch43" shows that frame:
  // the UI over x 427 +- 346 and y 240 +- 259.5 (TV_SCALE), the 3D picture over the whole view.
  const w43 = uiSize[1] * 4 / 3 / TV_SCALE, h43 = uiSize[1] / TV_SCALE;
  if (stretch43) gl.uniform4f(uiProg.u.uX, (uiSize[0] - w43) / 2, w43, (uiSize[1] - h43) / 2, h43);
  else gl.uniform4f(uiProg.u.uX, 0, uiSize[0], 0, uiSize[1]);
  gl.activeTexture(gl.TEXTURE0); gl.bindSampler(0, null); gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD);
  for (let i = from; i < to; i++) {
    const [id, add, first, n] = uiBatches[i], tex = id ? uiTextures.get(id) : null;
    if (id && uiVideos.has(id)) uiVideoUsed(id);
    gl.uniform1i(uiProg.u.uTex, tex ? 1 : 0); gl.bindTexture(gl.TEXTURE_2D, tex ?? blank);
    gl.blendFuncSeparate(gl.SRC_ALPHA, add ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, first, n);
  }
  gl.disable(gl.BLEND);
}
let showUI = true;

// ------------------------------------------------------------------ messages
// IGL2 frames: JSON resource list, then the capture's command words (gl-remote.mjs RemoteRenderer layout)
const PRIM_NAMES = ["points", "lines", "lineStrip", "triangles", "triangleStrip", "triangleFan", "lineLoop"];
const PRIM_MODES = PRIM_NAMES.map(n => MODES[n]);
function frameMessage2(buf) {
  const dv = new DataView(buf), jl = dv.getUint32(4, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
  const wOff = (8 + jl + 3) & ~3, nw = dv.getUint32(wOff, true), W = new Int32Array(buf, wOff + 4, nw), F = new Float32Array(buf, wOff + 4, nw);
  const bOff = wOff + 4 + nw * 4, blob = i => new Uint8Array(buf, bOff + json.blobs[i][0], json.blobs[i][1]);
  fit43 = !!json.fit43;
  for (const r of json.res) { const t = profT(); try { resource(r, blob); } catch (e) { stats.errors++; if (stats.errors < 5) console.error(e); }
    const x = prof.res[r.op] ??= { n: 0, ms: 0 }; x.n++; x.ms += profT() - t; }
  for (let p = 0; p < nw;) {
    const op = W[p++];
    try {
      if (op === 3) { present({ rt: { id: W[p], w: W[p + 1], h: W[p + 2] } }); p += 3; }
      else if (op === 4) { frontBlit(W[p], W[p + 1], W[p + 2], W[p + 3], W[p + 4], W[p + 5], W[p + 6]); p += 7; }
      else if (op === 2) { clear({ rt: { id: W[p], w: W[p + 1], h: W[p + 2] }, flags: W[p + 3] >>> 0, color: W[p + 4] >>> 0, z: F[p + 5], vp: [F[p + 6], F[p + 7], F[p + 8], F[p + 9]] }); p += 10; }
      else if (op === 1) {
        const d = D;
        d.mode = PRIM_MODES[W[p]] ?? -1; d.count = W[p + 1]; d.ib = W[p + 2]; d.vs = W[p + 3]; d.rtId = W[p + 4]; d.rtW = W[p + 5]; d.rtH = W[p + 6];
        d.screen = !!W[p + 7]; d.zs = W[p + 8]; d.vp0 = F[p + 9]; d.vp1 = F[p + 10]; d.vp2 = F[p + 11]; d.vp3 = F[p + 12]; const depth = !!W[p + 13]; p += 14;
        const na = W[p++]; d.na = na; d.attrs.set(W.subarray(p, p + na * 5)); p += na * 5;
        const nr = W[p++]; d.nc = nr; d.cSrc = F;
        for (let i = 0; i < nr; i++) { d.cStart[i] = W[p]; d.cN[i] = W[p + 1]; p += 2; d.cOff[i] = p; p += d.cN[i] * 4; }
        const bl = p; p += 12;
        d.blend = !!W[bl]; d.b0 = W[bl + 1] >>> 0; d.b1 = W[bl + 2] >>> 0; d.b2 = W[bl + 3] >>> 0; d.b3 = W[bl + 4] >>> 0;
        d.ztest = !!(depth && W[bl + 5] && W[bl + 6]); d.zfunc = W[bl + 7] >>> 0; d.zwrite = !!W[bl + 8]; d.cmask = W[bl + 9] >>> 0; d.cull = W[bl + 10] >>> 0; d.zbias = W[bl + 11] >>> 0;
        d.ps = psKeys.get(W[p++]);
        for (let k = 0; k < 4; k++, p += 6) {
          const kind = W[p]; d.tKind[k] = kind; if (!kind) continue;
          d.tId[k] = W[p + 1]; d.tW[k] = W[p + 2]; d.tH[k] = W[p + 3]; d.tLin[k] = W[p + 4] ? 1 : 0; d.tS[k] = W[p + 5] & 0xffffff;
        }
        d.vkey = layoutKey(d);
        draw(d);
      } else if (op === 5) {
        // OP_DRAW_SAME: the previous draw's state with new geometry and constants (D keeps the rest)
        const d = D; d.mode = PRIM_MODES[W[p]] ?? -1; d.count = W[p + 1]; d.ib = W[p + 2]; p += 3;
        const na = W[p++]; d.na = na; d.attrs.set(W.subarray(p, p + na * 5)); p += na * 5;
        const nr = W[p++]; d.nc = nr; d.cSrc = F;
        for (let i = 0; i < nr; i++) { d.cStart[i] = W[p]; d.cN[i] = W[p + 1]; p += 2; d.cOff[i] = p; p += d.cN[i] * 4; }
        d.vkey = layoutKey(d);
        drawSame(d);
      } else break;
    } catch (e) { stats.errors++; if (stats.errors < 5) console.error(e); if (op !== 1) break; }
  }
  stats.frames++; stats.total++; stats.bytes += buf.byteLength;
  return json.hold ? 1000 / 60 : 0;
}
// old JSON frames (recordings): one draw object -> D
function legacyDraw(c, blobF) {
  const d = D; d.mode = MODES[c.prim] ?? -1; d.count = c.count; d.ib = c.ib || 0; d.vs = c.vs; d.rtId = c.rt.id; d.rtW = c.rt.w; d.rtH = c.rt.h;
  d.screen = !!c.screen; d.zs = c.zs; [d.vp0, d.vp1, d.vp2, d.vp3] = c.vp ?? [0, 0, 0, 0];
  d.na = c.attrs.length; c.attrs.forEach((a, i) => d.attrs.set(a, i * 5));
  const parts = c.consts.map(([start, b]) => [start, blobF(b)]), total = parts.reduce((n, x) => n + x[1].length, 0), src = new Float32Array(total);
  d.nc = parts.length; d.cSrc = src; let o = 0; parts.forEach(([start, f], i) => { d.cStart[i] = start; d.cN[i] = f.length >> 2; d.cOff[i] = o; src.set(f, o); o += f.length; });
  d.blend = !!c.blend; if (c.blend) [d.b0, d.b1, d.b2, d.b3] = c.blend;
  d.ztest = !!c.ztest; d.zfunc = c.zfunc; d.zwrite = !!c.zwrite; d.cmask = c.cmask; d.cull = c.cull; d.zbias = 0; d.ps = c.ps;
  for (let k = 0; k < 4; k++) { const x = c.tex[k]; d.tKind[k] = x ? (x.rt !== undefined ? 2 : 1) : 0; if (!x) continue;
    d.tId[k] = x.rt !== undefined ? x.rt : x.id; d.tW[k] = x.w; d.tH[k] = x.h; d.tLin[k] = x.linear ? 1 : 0; d.tS[k] = x.s[0] | (x.s[1] << 8) | (x.s[2] << 16); }
  d.vkey = layoutKey(d); return d;
}
function frameMessage(buf) {
  if (new DataView(buf).getUint32(0, true) === 0x324c4749) return frameMessage2(buf);   // (returns how long to show it, for held frames)
  const dv = new DataView(buf), jl = dv.getUint32(0, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
  const base = (4 + jl + 3) & ~3, blob = i => new Uint8Array(buf, base + json.blobs[i][0], json.blobs[i][1]);
  const blobF = i => new Float32Array(buf.slice(base + json.blobs[i][0], base + json.blobs[i][0] + json.blobs[i][1]));
  for (const r of json.res) { try { resource(r, blob); } catch (e) { stats.errors++; if (stats.errors < 5) console.error(e); } }
  for (const c of json.cmds) {
    try {
      if (c.op === "draw") draw(legacyDraw(c, blobF)); else if (c.op === "clear") clear(c); else if (c.op === "present") present(c);
    } catch (e) { stats.errors++; if (stats.errors < 5) console.error(e); }
  }
  stats.frames++; stats.total++; stats.bytes += buf.byteLength;
}
function uiMessage(buf) {
  const dv = new DataView(buf), jl = dv.getUint32(4, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
  const base = (8 + jl + 3) & ~3, blob = i => new Uint8Array(buf, base + json.blobs[i][0], json.blobs[i][1]);
  for (const t of json.tex) try {                        // one bad texture must not cost the rest of the message
    let tex = uiTextures.get(t.id); if (!tex) { tex = gl.createTexture(); uiTextures.set(t.id, tex); }
    if (t.video) { uiVideoTexture(t, tex); continue; }
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.w, t.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, blob(t.blob));
    // mipmaps: a picture drawn smaller than its texture (an upscaled override in a small window) stays smooth
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } catch (e) { stats.errors++; console.error("UI texture", t.id, e); }
  gl.bindBuffer(gl.ARRAY_BUFFER, uiBuf); gl.bufferData(gl.ARRAY_BUFFER, blob(0), gl.DYNAMIC_DRAW);
  stateReset(); uiBatches = json.batches; uiSplit = json.split ?? 0; uiSize = [json.w, json.h];
  // a video the new UI no longer draws (the game stopped it: backing out of a Lightning Challenge interview) stops at
  // once, sound too, rather than after the one-second grace for a stalled page
  if (uiVideos.size) { const used = new Set(uiBatches.map(b => b[0])); for (const [id, v] of uiVideos) if (!used.has(id) && (v.clip || v.loading)) { uiVideoStop(v); v.used = 0; } }
  show();
}
let ws = null, info = "", slowNote = "", slowAt = -1e9;
// ?capture=1: F9 saves the last ~2 s of the 3D stream as a file (nt04-capture-*.bin) that replays offline, for
// glitches that last a frame or two. The page keeps the raw frame messages of the last CAP_FRAMES frames and, as
// frames leave that window, folds their resources (programs, pixel states, buffers, textures, frees) into a copy of
// the state the window starts from, with the vertex constants as they stood. The file: "NTCAP1", count, then
// length-prefixed messages — first a frame of that starting state (resource ops only, plus "consts"), then the frames.
const CAP_FRAMES = 150;
class Capture {
  constructor() { this.ring = []; this.base = { vs: new Map(), ps: new Map(), pskey: new Map(), buf: new Map(), tex: new Map() }; this.consts = new Float32Array(192 * 4); }
  add(data) {
    if (new DataView(data).getUint32(0, true) !== 0x324c4749) return;
    this.ring.push({ data, consts: consts.slice() });
    while (this.ring.length > CAP_FRAMES) { const f = this.ring.shift(); this.fold(f.data); this.consts = f.consts; }
  }
  fold(buf) {                                       // a frame's resource ops into the starting state
    const dv = new DataView(buf), jl = dv.getUint32(4, true), json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
    const wOff = (8 + jl + 3) & ~3, nw = dv.getUint32(wOff, true), bOff = wOff + 4 + nw * 4;
    const blob = i => new Uint8Array(buf, bOff + json.blobs[i][0], json.blobs[i][1]).slice();
    const B = this.base;
    for (const r of json.res) {
      if (r.op === "vs") B.vs.set(r.id, r);
      else if (r.op === "ps") B.ps.set(r.id, r);
      else if (r.op === "pskey") B.pskey.set(r.key, r);
      else if (r.op === "buf") { B.tex.delete(r.id); B.buf.set(r.id, { r, data: blob(r.blob) }); }
      else if (r.op === "tex") { B.buf.delete(r.id); B.tex.set(r.id, { r, data: blob(r.blob) }); }
      else if (r.op === "texp8") { B.buf.delete(r.id); B.tex.set(r.id, { r, data: blob(r.blob), pal: blob(r.pal) }); }
      else if (r.op === "free") { B.buf.delete(r.id); B.tex.delete(r.id); }
    }
  }
  baseMessage() {
    const B = this.base, res = [], parts = []; let off = 0;
    const put = u8 => { parts.push(u8); const i = res.blobs.length; res.blobs.push([off, u8.length]); off += u8.length; return i; };
    res.blobs = [];
    for (const r of B.vs.values()) res.push(r);
    for (const r of B.ps.values()) res.push(r);
    for (const r of B.pskey.values()) res.push(r);
    for (const { r, data } of B.buf.values()) res.push({ ...r, blob: put(data) });
    for (const { r, data, pal } of B.tex.values()) res.push(pal ? { ...r, blob: put(data), pal: put(pal) } : { ...r, blob: put(data) });
    res.push({ op: "consts", blob: put(new Uint8Array(this.consts.buffer.slice(0))) });
    const json = new TextEncoder().encode(JSON.stringify({ frame: -1, res: res.slice(), blobs: res.blobs }));
    const wOff = (8 + json.length + 3) & ~3, total = wOff + 4 + off, out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x324c4749, true); dv.setUint32(4, json.length, true); out.set(json, 8); dv.setUint32(wOff, 0, true);
    let p = wOff + 4; for (const u of parts) { out.set(u, p); p += u.length; }
    return out;
  }
  save() {
    const msgs = [this.baseMessage(), ...this.ring.map(f => new Uint8Array(f.data))];
    const head = new Uint8Array(10); head.set(new TextEncoder().encode("NTCAP1"), 0); new DataView(head.buffer).setUint32(6, msgs.length, true);
    const pieces = [head]; for (const m of msgs) { const l = new Uint8Array(4); new DataView(l.buffer).setUint32(0, m.length, true); pieces.push(l, m); }
    const blob = new Blob(pieces, { type: "application/octet-stream" }), n = msgs.length - 1;
    slowNote = `saving capture (${n} frames)…`; slowAt = performance.now();
    // to the server first (captures/ beside main.mjs); a browser download if that fails
    fetch("/capture", { method: "POST", body: blob }).then(r => r.ok ? r.text() : Promise.reject(new Error(r.status)))
      .then(path => { slowNote = `capture saved: ${path}`; slowAt = performance.now(); console.log(slowNote); })
      .catch(() => this.download(blob, n));
  }
  download(blob, n) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `nt04-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.bin`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    slowNote = `capture downloaded (${n} frames)`; slowAt = performance.now();
  }
}
const capture = new URLSearchParams(location.search).get("capture") === "1" ? new Capture() : null;
addEventListener("keydown", e => { if (capture && e.code === "F9" && !e.repeat) { e.preventDefault(); capture.save(); } });

// frame pacing: frames arrive unevenly (two in one screen refresh, none in the next), so they wait in a small queue
// and one is drawn per animation frame; a longer queue (the page fell behind) is drawn down to one frame at once.
// Frames carry incremental state, so every frame is processed, in order. ?pace=0 draws each frame on arrival.
const PACE = new URLSearchParams(location.search).get("pace") !== "0", frameQueue = []; let lastTick = -1e9;
let holdUntil = 0;                               // a held frame (made during one of the game's long calls) stays up one refresh
function playFrame(data) {
  let hold = 0;
  frameNo++; const t0 = performance.now(); try { hold = frameMessage(data) || 0; } catch (err) { stats.errors++; console.error(err); }
  if (capture) capture.add(data);
  if (hold) holdUntil = t0 + hold - 4;
  const dt = performance.now() - t0; stats.drawMs += dt; if (dt > stats.drawMax) stats.drawMax = dt; ws?.send(JSON.stringify({ t: "ack" }));
  if (dt > 150) {                               // a slow page frame: what it spent the time on
    const parts = Object.entries(prof.res).filter(([, x]) => x.ms >= 5).map(([k, x]) => `${k}×${x.n} ${x.ms.toFixed(0)}`);
    if (prof.issue >= 5) parts.push(`shader start×${prof.issueN} ${prof.issue.toFixed(0)}`);
    if (prof.poll >= 5) parts.push(`shader check×${prof.pollN} ${prof.poll.toFixed(0)}`);
    if (prof.fin >= 5) parts.push(`shader finish×${prof.finN} ${prof.fin.toFixed(0)}`);
    slowNote = `slow frame ${dt.toFixed(0)} ms: ${parts.join(", ") || "drawing"}`; slowAt = performance.now(); console.warn(slowNote);
  }
  prof.res = {}; prof.issue = prof.issueN = prof.poll = prof.pollN = prof.fin = prof.finN = 0;
}
function paceTick() {
  requestAnimationFrame(paceTick); lastTick = performance.now();
  if (!frameQueue.length) { stats.empty++; return; }
  if (lastTick < holdUntil) return;
  let n = frameQueue.length > 2 ? frameQueue.length - 1 : 1; stats.queued += frameQueue.length;
  while (n > 0 && frameQueue.length) { const d = frameQueue.shift(); if (d.ui) { uiMessage(d.ui); continue; } n--; playFrame(d); if (holdUntil > performance.now()) break; }
  while (frameQueue.length && frameQueue[0].ui) uiMessage(frameQueue.shift().ui);
}
// a UI message arriving while 3D frames still wait in the queue is applied in order with them: entering a career race
// weekend, the loading screen's ~70 presents (its fade, made inside one long call and held one per refresh, ~1.2 s as
// on the console's vsync) were still playing when the weekend menu's UI arrived, and the menu showed over the loading
// picture for that second
const playItem = d => { if (d.ui) uiMessage(d.ui); else playFrame(d); };
if (PACE) requestAnimationFrame(paceTick);
// replaced: the server gave the game to another page (tab); this one waits for a click before taking it back
let replaced = false;
status.addEventListener("click", () => { if (replaced) { replaced = false; status.textContent = "connecting"; connect(); } });
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`); ws.binaryType = "arraybuffer";
  ws.onopen = () => { status.textContent = "connected"; ws.send(JSON.stringify({ t: "hello" })); sendPad(true); };
  ws.onmessage = e => {
    if (typeof e.data === "string") { const m = JSON.parse(e.data); if (m.t === "info") info = m.text; else if (m.t === "race") raceBoard.update(m); else if (m.t === "rumble") setRumble(m.port | 0, m.left | 0, m.right | 0); else if (m.t === "replaced") replaced = true; else if (m.t === "movie") startMovie(m); else if (m.t === "version" && typeof CLIENT_VERSION !== "undefined" && m.v !== CLIENT_VERSION) { replaced = true; location.reload(); } return; }
    const kind = new DataView(e.data).getUint32(0, true);
    if (kind === 0x55495549) { if (frameQueue.length) frameQueue.push({ ui: e.data }); else uiMessage(e.data); }   // "IUIU": UI overlay (in order with queued frames)
    else if (kind === 0x44554149) audioMessage(e.data);               // "IAUD": mixed game audio
    else if (PACE && performance.now() - lastTick < 100) frameQueue.push(e.data);
    else { while (frameQueue.length) playItem(frameQueue.shift()); playFrame(e.data); }   // (no animation frames: hidden tab, or a browser without them)
  };
  ws.onclose = () => { if (movie) endMovie(null); status.textContent = replaced ? "another page took over the game — click here to play in this one" : "disconnected — retrying"; frameQueue.length = 0; dropVaos(); programs.clear(); specProgs.clear(); specFS.clear(); buffers.clear(); textures.clear(); pstates.clear(); psKeys.clear(); psHash.clear(); for (const q of progList) q.last.ps = -1;   /* (programs built ahead outlive the connection: pixel state ids start over) */ uiTextures.clear(); uiVideosStop(); uiBatches = []; if (!replaced) setTimeout(connect, 1000); };
}
connect();
setInterval(() => {
  const now = performance.now(), dt = (now - stats.t) / 1000;
  // (page draw time per frame: average / slowest of the second, JavaScript side of the WebGL calls)
  // (with pacing: animation frames that had nothing to draw, and the average queue length when one did)
  const pace = PACE ? `  |  empty ${stats.empty} q ${(stats.queued / Math.max(1, stats.frames)).toFixed(1)}` : "";
  if (ws?.readyState === 1) status.textContent = `${(stats.frames / dt).toFixed(0)} fps${pace}  |  page ${(stats.drawMs / Math.max(1, stats.frames)).toFixed(1)}/${stats.drawMax.toFixed(0)} ms  |  ${(stats.bytes / dt / 1e6).toFixed(1)} MB/s  |  ${stats.draws / Math.max(1, stats.frames) | 0} draws/frame${stats.errors ? `  |  ${stats.errors} errors` : ""}  |  ${info}${now - slowAt < 15000 ? `  |  ${slowNote}` : ""}`;
  saveCache();
  stats.frames = 0; stats.bytes = 0; stats.draws = 0; stats.t = now; stats.drawMs = 0; stats.drawMax = 0; stats.empty = 0; stats.queued = 0;
}, 1000);

// ------------------------------------------------------------------ sound: mixed PCM from the emulator -> Web Audio
// The PCM goes into an AudioWorklet that plays at the output rate, always at normal pitch. The emulator makes sound
// at game speed, which in races is below real time; instead of slowing the sound down (an octave lower at half speed,
// pitch jumps when the speed estimate changes), the worklet stretches it in time (WSOLA: 40 ms grains, 20 ms hop,
// each grain placed where it best matches the previous one). How much it stretches follows the fill of its buffer
// (aim ~120 ms; the stretch is measured from the minimum a grain needs, so even at a third of real time it settles
// without running dry). When the emulator stalls longer than the buffer (screen changes load data), the player fades
// out with the tail of the last grain, comes back as soon as ~50 ms is there, and keeps 50 ms more cushion per dry
// spell (up to 450 ms), giving it back slowly while playback is steady., smoothed per grain: at real-time speed the stretch is exactly 1 and the samples pass unchanged.
// Volume / mute are kept in this browser. (Browsers without AudioWorklet fall back to queued buffers.)
const WORKLET = `
class NT04Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1 << 18; this.mask = this.size - 1;                      // ~5.4 s ring per channel at 48 kHz
    this.L = new Float32Array(this.size); this.R = new Float32Array(this.size);
    this.w = 0;                                                         // samples written (absolute)
    this.H = 960; this.N = 1920; this.S = 360;                           // hop 20 ms, grain 40 ms, search +-7.5 ms
    this.win = new Float32Array(this.N); for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N);
    this.accL = new Float32Array(this.N); this.accR = new Float32Array(this.N);
    this.outL = new Float32Array(0); this.outR = new Float32Array(0); this.outPos = 0;
    this.inPos = 0; this.prev = -1; this.s = 1; this.baseTarget = this.target = 0.12 * sampleRate; this.minFill = this.N + this.S + 64; this.playing = false;
    this.clock = 0; this.lastStarve = 0;
    this.starved = 0; this.grains = 0; this.dropped = 0;
    this.port.onmessage = e => { const d = e.data; if (d.reset) { this.w = 0; this.inPos = 0; this.prev = -1; this.playing = false; return; }
      const f = d.pcm, n = f.length >> 1;
      for (let i = 0; i < n; i++) { const k = (this.w + i) & this.mask; this.L[k] = f[2 * i]; this.R[k] = f[2 * i + 1]; }
      this.w += n;
      if (this.w - this.inPos > this.size - 4 * this.N) { const skip = this.w - this.inPos - (this.target | 0); this.inPos += skip; this.prev = -1; this.dropped++; }
    };
      }
  // next grain: H output samples
  grain() {
    const H = this.H, N = this.N, S = this.S, L = this.L, R = this.R, m = this.mask;
    const fill = this.w - this.inPos, sr = sampleRate;
    this.clock += H;
    if (!this.playing) {
      // resume as soon as a little is there (the first grain's window fades in); not after a whole buffer's worth
      if (fill < this.minFill + 0.05 * sr) { this.tail(); return this.outL.length > 0; }
      this.playing = true; this.prev = -1;
    }
    if (fill < this.minFill) {
      // ran dry (the emulator stalled, e.g. loading at a screen change): fade out with the tail of the last grain,
      // and keep a bigger cushion from now on
      this.playing = false; this.starved++; this.lastStarve = this.clock;
      this.target = Math.min(0.45 * sr, this.target + 0.05 * sr);
      this.tail(); return this.outL.length > 0;
    }
    // steady for 5 s: give back 10 ms of the cushion a second (lower latency; a load's dry spells no longer keep the
    // race sound a few hundred ms late for minutes)
    if (this.clock - this.lastStarve > 5 * sr && this.target > this.baseTarget) { this.target = Math.max(this.baseTarget, this.target - 0.01 * sr); this.lastStarve = this.clock - 4 * sr; }
    // stretch factor from the buffer fill (smoothed): input consumed per output sample
    // ... but not while the fill stays in a wide band around the target: at real-time speed the fill only wanders with
    // the arrival jitter of the chunks, and following it kept a third to half of the grains stretched (s 0.5..1.08):
    // overlap-added grains instead of the plain samples, heard as crackle over the music and engine
    const lo = Math.max(this.minFill + 0.02 * sr, 0.5 * this.target), hi = 2.5 * this.target;
    const want = fill >= lo && fill <= hi ? 1 : Math.max(0.25, Math.min(1.1, (fill - this.minFill) / (this.target - this.minFill)));
    this.s += (want - this.s) * 0.15; if (want === 1 && Math.abs(this.s - 1) < 0.03) this.s = 1;
    const exact = Math.abs(this.s - 1) < 0.03 && this.prev >= 0;
    let start = Math.round(this.inPos);
    if (exact) start = this.prev + H;
    else if (this.prev >= 0) {
      // WSOLA: the candidate near inPos whose start best matches the natural continuation of the previous grain
      const nat = this.prev + H; let best = 0, bestC = -Infinity;
      for (let d = -S; d <= S; d += 4) {
        let c = 0; const a = start + d;
        for (let i = 0; i < 512; i += 2) c += (L[(a + i) & m] + R[(a + i) & m]) * (L[(nat + i) & m] + R[(nat + i) & m]);
        if (c > bestC) { bestC = c; best = d; }
      }
      start += best;
    }
    if (start + N > this.w) start = this.w - N;
    const aL = this.accL, aR = this.accR, w = this.win;
    for (let i = 0; i < N; i++) { const k = (start + i) & m; aL[i] += L[k] * w[i]; aR[i] += R[k] * w[i]; }
    this.emit();
    this.prev = start; this.inPos = exact ? start + H : this.inPos + H * this.s; this.grains++;
    return true;
  }
  // hand out the next H samples of the overlap-add accumulator and shift it
  emit() {
    const H = this.H, N = this.N, aL = this.accL, aR = this.accR;
    this.outL = aL.slice(0, H); this.outR = aR.slice(0, H); this.outPos = 0;
    aL.copyWithin(0, H); aR.copyWithin(0, H); aL.fill(0, N - H); aR.fill(0, N - H);
  }
  // no new grain: what is left in the accumulator is the fading second half of the last one (empty -> silence)
  tail() { let any = false; for (let i = 0; i < this.H; i++) if (this.accL[i] !== 0 || this.accR[i] !== 0) { any = true; break; }
    if (any) this.emit(); else { this.outL = new Float32Array(0); this.outR = new Float32Array(0); this.outPos = 0; } }
  process(inputs, outputs) {
    const o = outputs[0], L = o[0], R = o[1] ?? o[0], n = L.length;
    for (let i = 0; i < n; i++) {
      if (this.outPos >= this.outL.length && !this.grain()) { L[i] = 0; R[i] = 0; continue; }
      if (this.outPos >= this.outL.length) { L[i] = 0; R[i] = 0; continue; }
      L[i] = this.outL[this.outPos]; R[i] = this.outR[this.outPos]; this.outPos++;
    }
    if ((this.grains & 63) === 0 && this.grains !== this.lastReport) { this.lastReport = this.grains;
      this.port.postMessage({ fill: (this.w - this.inPos) / sampleRate, stretch: this.s, starved: this.starved, dropped: this.dropped, target: this.target / sampleRate }); }
    return true;
  }
}
registerProcessor("nt04-player", NT04Player);`;
let actx = null, again = null, player = null, aNext = 0, volume = 0.7, muted = false, audioInfo = null;
try { const v = JSON.parse(localStorage.getItem("nt04.audio")); if (v) { volume = v.volume ?? volume; muted = !!v.muted; } } catch {}
const volEl = document.getElementById("volume");
function applyVolume() { if (again) again.gain.value = muted ? 0 : volume * volume; if (volEl) volEl.value = Math.round(volume * 100); try { localStorage.setItem("nt04.audio", JSON.stringify({ volume, muted })); } catch {} }
function audioStart() {                                                 // browsers allow audio only after a user gesture
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    actx = new AC({ latencyHint: "interactive", sampleRate: 48000 }); again = actx.createGain(); again.connect(actx.destination); applyVolume();
    if (actx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      actx.audioWorklet.addModule(url).then(() => {
        player = new AudioWorkletNode(actx, "nt04-player", { numberOfInputs: 0, outputChannelCount: [2] });
        player.port.onmessage = e => { audioInfo = e.data; }; player.connect(again);
      }).catch(err => console.warn("audio worklet unavailable, using queued buffers", err));
    }
  }
  if (actx.state === "suspended") actx.resume();
}
addEventListener("keydown", audioStart); addEventListener("pointerdown", audioStart);
if (volEl) volEl.oninput = () => { volume = volEl.value / 100; muted = false; applyVolume(); };
addEventListener("keydown", e => { if (e.code === "KeyM" && e.target.tagName !== "TEXTAREA" && !keyMap?.KeyM) { muted = !muted; applyVolume(); } });
function audioMessage(buf) {
  stats.bytes += buf.byteLength;
  if (!actx || actx.state !== "running") return;
  const dv = new DataView(buf), rate = dv.getUint32(4, true), n = dv.getUint32(12, true);
  if (!n) return;
  const pcm = new Int16Array(buf, 16, n * 2), f = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) f[i] = pcm[i] / 32768;
  stats.audio = (stats.audio ?? 0) + 1;
  if (player && rate === actx.sampleRate) { player.port.postMessage({ pcm: f }, [f.buffer]); return; }
  // fallback: queued buffers at normal speed (gaps when the emulator is behind)
  const ab = actx.createBuffer(2, n, rate), L = ab.getChannelData(0), R = ab.getChannelData(1);
  for (let i = 0; i < n; i++) { L[i] = f[i * 2]; R[i] = f[i * 2 + 1]; }
  const now = actx.currentTime;
  if (aNext < now + 0.02) aNext = now + 0.08;
  if (aNext > now + 0.5) return;
  const src = actx.createBufferSource(); src.buffer = ab; src.connect(again); src.start(aNext); aNext += n / rate;
}

// ------------------------------------------------------------------ input: keyboard + gamepads -> virtual pad 0
// Xbox pad: buttons bits (UP 1, DOWN 2, LEFT 4, RIGHT 8, START 16, BACK 32, LTHUMB 64, RTHUMB 128), analog
// [A, B, X, Y, BLACK, WHITE, LT, RT] 0..255, sticks -32768..32767. The mapping is editable and kept in this browser.
const CONTROLS = ["A", "B", "X", "Y", "BLACK", "WHITE", "LT", "RT", "UP", "DOWN", "LEFT", "RIGHT", "START", "BACK",
  "STEER_LEFT", "STEER_RIGHT", "STICK_UP", "STICK_DOWN", "LOOK_LEFT", "LOOK_RIGHT", "LOOK_UP", "LOOK_DOWN"];
const DEFAULT_KEYS = { ArrowUp: ["RT", "STICK_UP"], ArrowDown: ["LT", "STICK_DOWN"], ArrowLeft: ["STEER_LEFT"], ArrowRight: ["STEER_RIGHT"],
  KeyW: ["RT", "STICK_UP"], KeyS: ["LT", "STICK_DOWN"], KeyA: ["STEER_LEFT"], KeyD: ["STEER_RIGHT"],
  Enter: ["A"], Space: ["A"], Escape: ["B"], Backspace: ["B"], KeyX: ["X"], KeyY: ["Y"], KeyQ: ["WHITE"], KeyE: ["BLACK"],
  KeyP: ["START"], Tab: ["BACK"], KeyI: ["UP"], KeyK: ["DOWN"], KeyJ: ["LEFT"], KeyL: ["RIGHT"],
  Numpad4: ["LOOK_LEFT"], Numpad6: ["LOOK_RIGHT"], Numpad8: ["LOOK_UP"], Numpad2: ["LOOK_DOWN"] };
let keyMap; try { keyMap = JSON.parse(localStorage.getItem("nt04.keys")) ?? DEFAULT_KEYS; } catch { keyMap = DEFAULT_KEYS; }
const held = new Set();
addEventListener("keydown", e => { if (e.target.tagName === "TEXTAREA") return; if (keyMap[e.code]) { e.preventDefault(); held.add(e.code); sendPad(); }
  if (e.code === "F2") { showUI = !showUI; show(); }
  if (e.code === "F3") { e.preventDefault(); stretch43 = !stretch43; try { localStorage.setItem("nt04.aspect", stretch43 ? "stretch" : "wide"); } catch {} show(); } });
addEventListener("keyup", e => { if (held.delete(e.code)) sendPad(); });
addEventListener("blur", () => { held.clear(); sendPad(); });
// Controllers: every connected gamepad is an Xbox pad. The first one shares port 0 (player 1) with the keyboard, the
// next ones are ports 1-3 (players 2-4; the game is told they were plugged in or pulled out). Standard-layout pads
// (Xbox, PlayStation, most others in Chrome / Edge / Firefox) map by position: A/B/X/Y = the four face buttons,
// LB = WHITE, RB = BLACK, LT / RT analog, sticks, d-pad, START = Menu/Options, BACK = View/Share, stick clicks.
// Pads the browser reports without the standard layout are tried with the same positions.
const NO_PAD = () => ({ buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0], lx: 0, ly: 0, rx: 0, ry: 0 });
function allPads() { return navigator.getGamepads ? [...navigator.getGamepads()].filter(gp => gp && gp.connected) : []; }
// (a pedal set on its own USB device that a wheel profile reads is not a player of its own)
function gamepads() { const ped = pedalDevices(); return allPads().filter(gp => !ped.has(wheelKey(gp)) || wheelProfile(gp)).slice(0, 4); }
// stick with a radial dead zone (rescaled so steering starts smoothly at its edge) -> Xbox -32768..32767, y up
function stick(x, y) {
  const r = Math.hypot(x, y), dz = 0.15; if (r < dz) return [0, 0];
  const k = Math.min(1, (r - dz) / (1 - dz)) / r, v = c => Math.max(-32768, Math.min(32767, Math.round(c * k * 32767)));
  return [v(x), v(-y)];
}
function addGamepad(s, gp) {
  const wp = wheelProfile(gp); if (wp) return addWheel(s, gp, wp);
  const b = i => { const x = gp.buttons[i]; return x ? (typeof x === "object" ? (x.value || (x.pressed ? 1 : 0)) : x) : 0; }, ax = i => gp.axes[i] ?? 0;
  [0, 1, 2, 3].forEach(i => s.analog[i] = Math.max(s.analog[i], Math.round(b(i) * 255)));
  s.analog[5] = Math.max(s.analog[5], Math.round(b(4) * 255)); s.analog[4] = Math.max(s.analog[4], Math.round(b(5) * 255));   // LB white, RB black
  s.analog[6] = Math.max(s.analog[6], Math.round(b(6) * 255)); s.analog[7] = Math.max(s.analog[7], Math.round(b(7) * 255));
  if (b(12) > 0.5) s.buttons |= 1; if (b(13) > 0.5) s.buttons |= 2; if (b(14) > 0.5) s.buttons |= 4; if (b(15) > 0.5) s.buttons |= 8;
  if (b(9) > 0.5) s.buttons |= 16; if (b(8) > 0.5) s.buttons |= 32; if (b(10) > 0.5) s.buttons |= 64; if (b(11) > 0.5) s.buttons |= 128;
  const [lx, ly] = stick(ax(0), ax(1)), [rx, ry] = stick(ax(2), ax(3));
  if (lx || ly) { s.lx = lx; s.ly = ly; } if (rx || ry) { s.rx = rx; s.ry = ry; }
  return gp.buttons.some(x => x?.pressed);
}
// ------------------------------------------------------------------ steering wheels
// A wheel (and its pedals) is a gamepad the browser reports without the standard layout, with its own axis and
// button numbers. A wheel profile per device (by its id, kept in this browser, set up in the "Steering wheel" panel)
// says which axis steers, which are throttle and brake (each with its rest and fully-pressed values: pedals rest at
// +1 or -1, or share one axis), which buttons are A / B / X / Y / START / BACK / WHITE / BLACK and an optional d-pad
// hat axis. Steering goes to the left stick (full lock at the chosen share of the wheel's rotation, with a small
// centre dead zone and an optional curve), throttle to RT and brake to LT, as the game reads a pad. (No force
// feedback: browsers don't drive wheel motors; the game's rumble still goes to vibrationActuator where there is one.)
const WHEEL_BUTTONS = ["A", "B", "X", "Y", "WHITE", "BLACK", "START", "BACK", "LTHUMB", "RTHUMB", "UP", "DOWN", "LEFT", "RIGHT"];
const WHEEL_IDS = /wheel|racing|G2[79]|G9[02]\d?|G923|Driving Force|DFGT|Momo|T150|T248|T300|T500|TMX|TX\b|T-GT|Thrustmaster|Fanatec|CSL|ClubSport|Podium|Moza|Simucube|Simagic|Cammus|Hori.*Apex|Steering/i;
let wheelProfiles; try { wheelProfiles = JSON.parse(localStorage.getItem("nt04.wheels")) ?? {}; } catch { wheelProfiles = {}; }
const wheelKey = gp => gp.id.replace(/\s+/g, " ").trim();
function saveWheels() { try { localStorage.setItem("nt04.wheels", JSON.stringify(wheelProfiles)); } catch {} }
function wheelProfile(gp) { const p = wheelProfiles[wheelKey(gp)]; return p && p.on !== false && p.steer ? p : null; }
// a pedal: 0 at rest .. 1 fully pressed, from its axis's recorded rest and full values (a pedal pair on one axis:
// throttle full = one end, brake full = the other, rest = the middle)
function pedalDevices() { const k = new Set(); for (const [id, p] of Object.entries(wheelProfiles)) if (p.on !== false && p.steer) for (const q of [p.throttle, p.brake]) if (q?.dev && q.dev !== id) k.add(q.dev); return k; }
function pedal(gp, ped, dz = 0.03) {
  if (!ped || !(ped.axis >= 0)) return 0;
  if (ped.dev && ped.dev !== wheelKey(gp)) gp = allPads().find(d => wheelKey(d) === ped.dev); if (!gp) return 0;   // pedals on their own device
  const v = gp.axes[ped.axis] ?? ped.rest, span = ped.full - ped.rest; if (!span) return 0;
  const t = (v - ped.rest) / span; return t <= dz ? 0 : Math.min(1, (t - dz) / (1 - dz));
}
function hatDirs(v) {                     // Chrome / Edge non-standard POV hat axis: -1 up, then clockwise in steps of 2/7
  if (v === undefined || v > 1.1 || v < -1.1) return 0;
  const k = Math.round((v + 1) / (2 / 7)); return [1, 1 | 8, 8, 2 | 8, 2, 2 | 4, 4, 1 | 4][k] ?? 0;
}
function addWheel(s, gp, p) {
  const bv = i => { const x = gp.buttons[i]; return x ? (x.value || (x.pressed ? 1 : 0)) : 0; };
  // steering: centre dead zone, full lock at `lock` of the axis's half range, then an optional curve (gamma > 1:
  // finer near the centre)
  let x = (gp.axes[p.steer.axis] ?? 0) - (p.steer.center ?? 0); if (p.steer.invert) x = -x;
  const dz = p.deadzone ?? 0.01, lock = Math.max(0.05, p.lock ?? 1), g = p.gamma ?? 1;
  let a = Math.abs(x) <= dz ? 0 : Math.min(1, (Math.abs(x) - dz) / (lock - dz)); a = Math.pow(a, g);
  const lx = Math.round(Math.sign(x) * a * 32767); if (lx) s.lx = lx;
  s.analog[7] = Math.max(s.analog[7], Math.round(pedal(gp, p.throttle) * 255));
  s.analog[6] = Math.max(s.analog[6], Math.round(pedal(gp, p.brake) * 255));
  const AN = { A: 0, B: 1, X: 2, Y: 3, BLACK: 4, WHITE: 5 }, BT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, START: 16, BACK: 32, LTHUMB: 64, RTHUMB: 128 };
  for (const [name, idx] of Object.entries(p.buttons ?? {})) {
    if (!(idx >= 0)) continue; const v = bv(idx);
    if (name in AN) s.analog[AN[name]] = Math.max(s.analog[AN[name]], Math.round(v * 255)); else if (name in BT && v > 0.5) s.buttons |= BT[name];
  }
  if (p.hat >= 0) s.buttons |= hatDirs(gp.axes[p.hat]);
  return gp.buttons.some(b => b?.pressed);
}
// defaults for a new profile: the standard positions when the browser maps it, else nothing until set up
function newWheelProfile(gp) {
  const std = gp.mapping === "standard";
  return { on: true, steer: { axis: 0, invert: false, center: 0 }, throttle: std ? null : null, brake: null, lock: 0.5, deadzone: 0.01, gamma: 1,
    buttons: std ? { A: 0, B: 1, X: 2, Y: 3, WHITE: 4, BLACK: 5, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } : {}, hat: -1 };
}
// set-up panel: pick the device, then capture each control by moving it
const wheelUI = document.getElementById("wheel");
if (wheelUI) {
  const $w = id => document.getElementById(id), sel = $w("wheelDev"), live = $w("wheelLive"), note = $w("wheelNote");
  let capture = null, base = null, cur = null;
  const dev = () => allPads().find(gp => wheelKey(gp) === sel.value);
  const prof = () => { const gp = dev(); if (!gp) return null; return wheelProfiles[wheelKey(gp)] ??= newWheelProfile(gp); };
  const refreshList = () => {
    const ids = allPads().map(wheelKey), had = sel.value;
    if (ids.join("|") !== [...sel.options].map(o => o.value).join("|")) {
      sel.innerHTML = ids.map(id => `<option value="${id.replace(/"/g, "&quot;")}">${id.slice(0, 70)}${WHEEL_IDS.test(id) ? " (wheel?)" : ""}</option>`).join("") || "<option value=''>no controller - press a button on it</option>";
      sel.value = ids.includes(had) ? had : ids.find(id => WHEEL_IDS.test(id)) ?? ids[0] ?? "";
      showProfile();
    }
  };
  const showProfile = () => {
    const gp = dev(), p = gp && wheelProfiles[wheelKey(gp)];
    $w("wheelOn").checked = !!(p && p.on !== false && p.steer);
    $w("wheelLock").value = Math.round((p?.lock ?? 0.5) * 100); $w("wheelGamma").value = p?.gamma ?? 1; $w("wheelDz").value = Math.round((p?.deadzone ?? 0.01) * 100);
    $w("wheelLockV").textContent = $w("wheelLock").value + "%"; $w("wheelInv").checked = !!p?.steer?.invert;
    const f = q => q && q.axis >= 0 ? `${q.dev ? "[" + q.dev.slice(0, 20) + "] " : ""}axis ${q.axis} (rest ${q.rest.toFixed(2)}, full ${q.full.toFixed(2)})` : "not set";
    $w("wheelMap").textContent = p ? `steering: axis ${p.steer.axis}${p.steer.invert ? " (inverted)" : ""} | throttle: ${f(p.throttle)} | brake: ${f(p.brake)} | d-pad: ${p.hat >= 0 ? "hat axis " + p.hat : "buttons"} | buttons: ${WHEEL_BUTTONS.filter(b => p.buttons?.[b] >= 0).map(b => b + "=" + p.buttons[b]).join(" ") || "-"}` : "no profile yet (the controller is used as a normal pad)";
  };
  sel.onchange = showProfile;
  $w("wheelOn").onchange = e => { const p = prof(); if (p) { p.on = e.target.checked; saveWheels(); showProfile(); } };
  $w("wheelInv").onchange = e => { const p = prof(); if (p) { p.steer.invert = e.target.checked; saveWheels(); showProfile(); } };
  $w("wheelLock").oninput = e => { const p = prof(); if (p) { p.lock = +e.target.value / 100; saveWheels(); } $w("wheelLockV").textContent = e.target.value + "%"; };
  $w("wheelGamma").onchange = e => { const p = prof(); if (p) { p.gamma = Math.max(0.5, Math.min(3, +e.target.value || 1)); saveWheels(); } };
  $w("wheelDz").onchange = e => { const p = prof(); if (p) { p.deadzone = Math.max(0, Math.min(0.2, (+e.target.value || 0) / 100)); saveWheels(); } };
  $w("wheelForget").onclick = () => { const gp = dev(); if (gp) { delete wheelProfiles[wheelKey(gp)]; saveWheels(); showProfile(); } };
  // capture: remember the axes / buttons when it starts, then watch what moves the most
  const start = (what, text) => { const gp = dev(); if (!gp) { note.textContent = "Connect the wheel and press a button on it first."; return; }
    // pedals may be a device of their own: watch every controller's axes for those
    const devs = what === "throttle" || what === "brake" ? allPads() : [gp];
    capture = { what, t: performance.now(), devs: devs.map(wheelKey), min: devs.map(d => [...d.axes]), max: devs.map(d => [...d.axes]), base: devs.map(d => [...d.axes]) }; base = [...gp.axes]; note.textContent = text; };
  $w("wheelSteer").onclick = () => start("steer", "Steering: turn the wheel all the way left, then all the way right, then let it centre (5 s).");
  $w("wheelThrottle").onclick = () => start("throttle", "Throttle: press it all the way down and release it (4 s).");
  $w("wheelBrake").onclick = () => start("brake", "Brake: press it all the way down and release it (4 s).");
  $w("wheelHat").onclick = () => start("hat", "D-pad: press up on the d-pad (or hat) and hold it.");
  for (const b of WHEEL_BUTTONS) {
    const el = document.createElement("button"); el.textContent = b; el.title = `assign ${b}: click, then press the wheel button`;
    el.onclick = () => { const gp = dev(); if (!gp) return; capture = { what: "button", name: b, t: performance.now(), held: gp.buttons.map(x => x.pressed) }; note.textContent = `${b}: press the wheel button for it (B on the wheel = back in menus, START = pause).`; };
    $w("wheelBtns").appendChild(el);
  }
  const tick = () => {
    refreshList(); const gp = dev();
    if (gp && wheelUI.open) {
      live.textContent = gp.axes.map((v, i) => `a${i} ${v >= 0 ? " " : ""}${(+v || 0).toFixed(2)}`).join("  ") + "\n" + gp.buttons.map((b, i) => b.pressed ? `b${i}` : "").filter(Boolean).join(" ");
      if (capture) {
        const el = performance.now() - capture.t, p = prof();
        if (capture.what === "button") {
          const i = gp.buttons.findIndex((x, k) => x.pressed && !capture.held[k]);
          if (i >= 0) { p.buttons[capture.name] = i; saveWheels(); note.textContent = `${capture.name} = button ${i}.`; capture = null; showProfile(); }
          else if (el > 8000) { note.textContent = "No button pressed."; capture = null; }
        } else {
          let bd = 0, best = 0, bestR = -1;
          capture.devs.forEach((key, d) => { const g2 = allPads().find(x => wheelKey(x) === key); if (!g2) return;
            g2.axes.forEach((v, i) => { capture.min[d][i] = Math.min(capture.min[d][i], v); capture.max[d][i] = Math.max(capture.max[d][i], v);
              const r = capture.max[d][i] - capture.min[d][i]; if (r > bestR) { bestR = r; bd = d; best = i; } }); });
          const range = { [best]: bestR }, cmin = capture.min[bd], cmax = capture.max[bd], cbase = capture.base[bd], cdev = capture.devs[bd];
          if (capture.what === "hat") {
            const i = gp.axes.findIndex((v, k) => Math.abs(v - base[k]) > 0.3 && Math.abs(v + 1) < 0.1);
            if (i >= 0) { p.hat = i; saveWheels(); note.textContent = `D-pad = hat axis ${i}.`; capture = null; showProfile(); }
            else if (el > 6000) { p.hat = -1; saveWheels(); note.textContent = "No hat axis moved: the d-pad is set with the UP / DOWN / LEFT / RIGHT buttons below."; capture = null; showProfile(); }
          } else if (el > (capture.what === "steer" ? 5000 : 4000)) {
            if (range[best] < 0.5) note.textContent = "Nothing moved far enough - try again.";
            else if (capture.what === "steer") { p.steer = { axis: best, invert: p.steer?.invert ?? false, center: Math.abs(gp.axes[best]) < 0.15 ? gp.axes[best] : 0 }; p.on = true; note.textContent = `Steering = axis ${best}. Turn left: the car should steer left (tick "invert" if not).`; }
            else {
              const rest = cbase[best], full = Math.abs(cmax[best] - rest) > Math.abs(cmin[best] - rest) ? cmax[best] : cmin[best];
              p[capture.what] = { axis: best, rest, full, ...(cdev !== wheelKey(gp) ? { dev: cdev } : {}) };
              note.textContent = `${capture.what === "throttle" ? "Throttle" : "Brake"} = ${cdev !== wheelKey(gp) ? "\"" + cdev.slice(0, 30) + "\" " : ""}axis ${best} (rest ${rest.toFixed(2)}, pressed ${full.toFixed(2)}).`;
            }
            saveWheels(); capture = null; showProfile();
          }
        }
      }
    }
    setTimeout(tick, 50);
  };
  tick();
}

// player 1: keyboard + first gamepad
function padState() {
  const on = new Set(); for (const k of held) for (const c of keyMap[k] ?? []) on.add(c);
  const s = NO_PAD();
  const AN = { A: 0, B: 1, X: 2, Y: 3, BLACK: 4, WHITE: 5, LT: 6, RT: 7 }, BT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, START: 16, BACK: 32 };
  for (const c of on) { if (c in AN) s.analog[AN[c]] = 255; if (c in BT) s.buttons |= BT[c]; }
  if (on.has("STEER_LEFT")) s.lx -= 32767; if (on.has("STEER_RIGHT")) s.lx += 32767;
  if (on.has("STICK_UP")) s.ly += 32767; if (on.has("STICK_DOWN")) s.ly -= 32767;
  if (on.has("LOOK_LEFT")) s.rx -= 32767; if (on.has("LOOK_RIGHT")) s.rx += 32767; if (on.has("LOOK_UP")) s.ry += 32767; if (on.has("LOOK_DOWN")) s.ry -= 32767;
  const gp = gamepads()[0]; if (gp && addGamepad(s, gp)) audioStart();      // (a button press may count as the gesture sound needs)
  return s;
}
const lastPads = ["", "", "", ""]; let padsShown = "";
function sendPad(force) {
  const list = gamepads();
  for (let port = 0; port < 4; port++) {
    let s;
    if (port === 0) s = padState();
    else if (list[port]) { s = NO_PAD(); addGamepad(s, list[port]); s.connected = true; }
    else s = { connected: false };
    const j = JSON.stringify(s);
    if ((force || j !== lastPads[port]) && ws?.readyState === 1) { ws.send(JSON.stringify({ t: "pad", port, ...s })); lastPads[port] = j; }
  }
  const shown = list.map((gp, i) => `P${i + 1}: ${gp.id.replace(/\s*\(.*?\)\s*/g, " ").trim().slice(0, 40)}${wheelProfile(gp) ? " (wheel)" : gp.mapping === "standard" ? "" : " (non-standard layout)"}`).join(" · ") || "no controller (press a button on it to connect)";
  if (shown !== padsShown) { padsShown = shown; const el = document.getElementById("pads"); if (el) el.textContent = shown; }
}
setInterval(() => sendPad(), 16);                                       // gamepads are polled
// rumble from the game (XInputSetState: left = low-frequency motor, right = high-frequency), renewed while it lasts
const rumble = [null, null, null, null];
const rumbleAt = [0, 0, 0, 0];
function setRumble(port, left, right) { rumble[port] = left || right ? { strong: left / 65535, weak: right / 65535 } : null;
  const now = performance.now(); if (!rumble[port] || now - rumbleAt[port] > 80) { rumbleAt[port] = now; playRumble(port); } }   // (the game may change it every frame)
function playRumble(port) {
  const gp = gamepads()[port], act = gp?.vibrationActuator, r = rumble[port]; if (!act) return;
  try { if (r) act.playEffect("dual-rumble", { duration: 250, strongMagnitude: r.strong, weakMagnitude: r.weak }); else act.reset?.(); } catch {}
}
setInterval(() => { for (let p = 0; p < 4; p++) if (rumble[p]) playRumble(p); }, 200);

// mapping editor
const ed = document.getElementById("keys");
if (ed) {
  ed.value = JSON.stringify(keyMap, null, 1);
  document.getElementById("keysSave").onclick = () => { try { keyMap = JSON.parse(ed.value); localStorage.setItem("nt04.keys", JSON.stringify(keyMap)); ed.style.outlineColor = ""; } catch { ed.style.outline = "2px solid #c33"; } };
  document.getElementById("keysReset").onclick = () => { keyMap = DEFAULT_KEYS; localStorage.removeItem("nt04.keys"); ed.value = JSON.stringify(keyMap, null, 1); };
  document.getElementById("controls").textContent = CONTROLS.join(" ");
}

// ------------------------------------------------------------------ menu videos
// Video textures in the menus (uis_vide race footage in the main menu's panel, uis_cvd* Lightning Challenge driver
// interviews): the UI message names one playback ({ video: { file, index, seq } }: the game started the clip on the
// element; a new start is a new texture) instead of sending pixels. It plays once from when a UI batch first draws it
// and stops (sound too) when the UI has gone on without it for a second; frames are decoded here by ea-mad.mjs into
// the top-left 320 x 240 of the 512 x 256 texture.
const uiVideos = new Map();
function uiVideoTexture(t, tex) {
  if (uiVideos.has(t.id)) return;
  gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const black = new Uint8Array(t.w * t.h * 4); for (let i = 3; i < black.length; i += 4) black[i] = 255;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.w, t.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, black);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  uiVideos.set(t.id, { ...t.video, tex, w: t.w, h: t.h, used: 0, clip: null, loading: false });
}
// fetch and split a clip: MAD frames, and the whole soundtrack as an AudioBuffer (when the page has sound)
const clipCache = new Map();                                          // the last few clips (the main menu replays its five)
async function loadClip(file, index) {
  const key = `${file}#${index}`; if (clipCache.has(key)) { const c = clipCache.get(key); clipCache.delete(key); clipCache.set(key, c); return c; }
  const c = await loadClip0(file, index); clipCache.set(key, c); while (clipCache.size > 3) clipCache.delete(clipCache.keys().next().value); return c;
}
async function loadClip0(file, index) {
  eaMad ??= await import("/ea-mad.mjs");
  const r = await fetch(`/movie?file=${encodeURIComponent(file)}&index=${index}`); if (!r.ok) throw new Error(`${file} #${index}: ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer()), chunks = eaMad.eaChunks(buf);
  let hdr = null, ad = null, audio = null; const parts = [];
  for (const c of chunks) {
    if (c.tag === "SCHl") { hdr = eaMad.eaAudioHeader(buf, c.off, c.len); ad = new eaMad.EaAdpcm(hdr.channels, hdr.revision === 3 ? 2 : hdr.revision === 4 ? 3 : 1); }
    else if (c.tag === "SCDl" && ad) { try { parts.push(ad.decode(buf, c.off + 8, c.len - 8)); } catch {} }
  }
  if (actx && hdr && parts.length) {
    const n = parts.reduce((k, p) => k + p[0].length, 0); audio = actx.createBuffer(hdr.channels, Math.max(1, n), hdr.rate);
    for (let ch = 0; ch < hdr.channels; ch++) { const d = audio.getChannelData(ch); let o = 0; for (const p of parts) { d.set(p[ch], o); o += p[ch].length; } }
  }
  return { buf, frames: chunks.filter(c => c.tag.startsWith("MAD")), audio };
}
let uiVideoTicking = false;
function uiVideoUsed(id) {
  const v = uiVideos.get(id), t = performance.now();
  if (t - v.used > 250) v.since = t;                       // a new run of frames showing this clip
  v.used = t;
  if (!v.clip && !v.loading) {
    v.loading = true;
    loadClip(v.file, v.index).then(clip => { if (!uiVideos.has(id) || !v.loading) return; v.loading = false; v.clip = clip; uiVideoStart(v); })
      .catch(e => { console.warn("menu video", e); v.loading = false; v.used = Infinity; v.failed = true; });
  }
  if (!uiVideoTicking) { uiVideoTicking = true; requestAnimationFrame(uiVideoTick); }
}
function uiVideoStart(v) {
  v.dec = new eaMad.MadDecoder(); v.k = 0; v.next = 0; v.ended = false;
  const sound = !!(v.clip.audio && actx), clock = sound ? () => actx.currentTime : () => performance.now() / 1000;   // the soundtrack's clock when there is one
  v.t0 = clock() + 0.05; v.clock = () => clock() - v.t0;
  if (sound) { v.src = actx.createBufferSource(); v.src.buffer = v.clip.audio; v.src.connect(again); v.src.start(v.t0); }
}
function uiVideoStop(v) { try { v.src?.stop(); } catch {} v.src = null; v.clip = null; v.dec = null; v.loading = false; v.rgba = null; }
function uiVideosStop() { for (const v of uiVideos.values()) uiVideoStop(v); uiVideos.clear(); }
function uiVideoTick() {
  const t = performance.now(); let live = 0;
  for (const v of uiVideos.values()) {
    if (v.failed) continue;
    if (uiDrawnAt - v.used > 1000) { if (v.clip || v.loading) uiVideoStop(v); continue; }   // the UI went on without it (not just a stalled page)
    live++; if (!v.clip || v.ended) continue;
    let now = v.clock(); const fr = v.clip.frames; let shown = null;
    if (!v.src && now - v.next > 0.5) { v.t0 += now - v.next; now = v.next; }   // the page stalled: carry on from here (a soundtrack keeps its own time)
    while (v.next <= now) {
      if (v.k >= fr.length) { v.ended = true; break; }                // the game moves on itself (it times the clip too)
      const c = fr[v.k++]; let f; try { f = v.dec.decode(v.clip.buf, c.off, c.len); } catch { continue; }
      v.next += (f.ms || 33) / 1000; if (v.next > now || v.k >= fr.length) shown = f;
    }
    if (shown) {
      v.rgba = eaMad.yuvToRgba(shown, v.rgba?.length === shown.w * shown.h * 4 ? v.rgba : undefined);
      gl.bindTexture(gl.TEXTURE_2D, v.tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(shown.w, v.w), Math.min(shown.h, v.h), gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(v.rgba.buffer));
      if (!lastBack) show();                                    // nothing else is presenting (the game holds the picture): redraw
    }
  }
  if (live) requestAnimationFrame(uiVideoTick); else uiVideoTicking = false;
}

// ------------------------------------------------------------------ movies
// The server holds the game while a movie the game asked for (PlayMovie) plays here: the clip comes from /movie (one
// entry of the bundle: EA Madcow video + EA ADPCM audio) and is decoded by ea-mad.mjs; it ends on its own or, when the
// game allows skipping, on A / START (reason 1) or B (2); the page then reports movieEnd.
let movie = null, eaMad = null, movieTex = null;
async function startMovie(m) {
  endMovie(null);
  const st = movie = { ...m, frames: [], k: 0, t0: 0, next: 0, done: false, src: null, rgba: null, dec: null, padSeen: 0 };
  try {
    eaMad ??= await import("/ea-mad.mjs");
    const r = await fetch(`/movie?file=${encodeURIComponent(m.file)}&index=${m.index}`); if (!r.ok) throw new Error(`movie ${m.file} #${m.index}: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer()); if (st !== movie) return;
    const chunks = eaMad.eaChunks(buf); st.buf = buf; st.frames = chunks.filter(c => c.tag.startsWith("MAD")); st.dec = new eaMad.MadDecoder();
    let hdr = null, ad = null; const parts = [];
    for (const c of chunks) {
      if (c.tag === "SCHl") { hdr = eaMad.eaAudioHeader(buf, c.off, c.len); ad = new eaMad.EaAdpcm(hdr.channels, hdr.revision === 3 ? 2 : hdr.revision === 4 ? 3 : 1); }
      else if (c.tag === "SCDl" && ad) { try { parts.push(ad.decode(buf, c.off + 8, c.len - 8)); } catch {} }
    }
    audioStart();
    if (actx && hdr && parts.length) {
      const n = parts.reduce((k, p) => k + p[0].length, 0), ab = actx.createBuffer(hdr.channels, Math.max(1, n), hdr.rate);
      for (let ch = 0; ch < hdr.channels; ch++) { const d = ab.getChannelData(ch); let o = 0; for (const p of parts) { d.set(p[ch], o); o += p[ch].length; } }
      st.src = actx.createBufferSource(); st.src.buffer = ab; st.src.connect(again);
    }
    st.clock = () => actx && st.src ? actx.currentTime : performance.now() / 1000;
    st.t0 = st.clock() + 0.05; st.src?.start(st.t0);
    requestAnimationFrame(movieTick);
  } catch (e) { console.warn(e); endMovie(0); }
}
function movieTick() {
  const st = movie; if (!st || st.done) return;
  const now = st.clock() - st.t0; let shown = null;
  while (st.k < st.frames.length && st.next <= now) {
    const c = st.frames[st.k++]; let f;
    try { f = st.dec.decode(st.buf, c.off, c.len); } catch (e) { console.warn("movie frame", e); continue; }
    st.next += (f.ms || 33) / 1000;
    if (st.k >= st.frames.length || st.next > now) shown = f;              // decode late frames, show the current one
  }
  if (shown) drawMovieFrame(shown);
  if (st.k >= st.frames.length && now > st.next) { endMovie(0); return; }
  // pad skip (A / START: next, B: back out), polled like the pad itself
  if (st.skippable) { const p = padState(), a = p.analog[0] > 128 || (p.buttons & 16), b = p.analog[1] > 128; if (!a && !b) st.padSeen = 1; else if (st.padSeen) { endMovie(b ? 2 : 1); return; } }
  requestAnimationFrame(movieTick);
}
function drawMovieFrame(f) {
  gl.disable(gl.SCISSOR_TEST); S.sci = null; gl.disable(gl.STENCIL_TEST); S.stn = 0;
  movie.rgba = eaMad.yuvToRgba(f, movie.rgba?.length === f.w * f.h * 4 ? movie.rgba : undefined);
  if (!movieTex) movieTex = gl.createTexture();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true);
  gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  // the clip (e.g. 640 x 448) in the 640 x 480 frame, centred: black bars as on the TV
  const h = Math.round(canvas.height * Math.min(1, f.h / 480)), w = Math.round(canvas.width * Math.min(1, f.w / 640));
  gl.viewport((canvas.width - w) >> 1, (canvas.height - h) >> 1, w, h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, movieTex); gl.bindSampler(0, null); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(movie.rgba.buffer));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.useProgram(blit.p); gl.bindVertexArray(blitVao); gl.uniform1i(blit.u.img, 0); gl.uniform1i(blit.u.uFlip, 1); gl.uniform1i(blit.u.uPremul, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  stateReset();
}
function endMovie(reason) {
  const st = movie; if (!st) return; st.done = true; movie = null;
  try { st.src?.stop(); } catch {}
  if (reason !== null && ws?.readyState === 1) ws.send(JSON.stringify({ t: "movieEnd", id: st.id, reason }));
  show();
}
addEventListener("keydown", e => { if (!movie?.skippable || e.repeat) return; if (["Enter", "Space", "KeyP"].includes(e.code)) endMovie(1); else if (["Escape", "Backspace"].includes(e.code)) endMovie(2); });

// ------------------------------------------------------------------ live race leaderboard / points standings
// race-hud.mjs (server) sends { t: "race", board, points, lap, laps, ... } twice a second during a race. Drawn as a
// panel at the top right of the picture (clear of the game's own position / lap plate, tach and lap times): F4 shows / hides it, F6 (or the tabs) goes running order -> race points -> season standings (Season / Career only).
// The top 10 are listed, then the player's car with the cars around it.
const raceBoard = (() => {
  let el = null, last = null, tab = "board", visible = true;
  try { visible = localStorage.getItem("nt04.board") !== "off"; tab = ["points", "season"].includes(localStorage.getItem("nt04.boardTab")) ? localStorage.getItem("nt04.boardTab") : "board"; } catch {}
  const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function make() {
    el = document.createElement("div"); el.id = "raceBoard";
    const st = document.createElement("style");
    st.textContent = `#raceBoard{position:fixed;z-index:5;pointer-events:auto;background:rgba(8,10,14,.78);color:#e8e8e8;border:1px solid rgba(255,255,255,.12);border-radius:6px;font:12px/1.35 system-ui,sans-serif;font-variant-numeric:tabular-nums;padding:6px 0 4px;min-width:250px;box-shadow:0 2px 12px rgba(0,0,0,.5);user-select:none}
#raceBoard .hd{display:flex;justify-content:space-between;align-items:baseline;padding:0 8px 4px;gap:10px}
#raceBoard .ttl{font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}
#raceBoard .lap{color:#ffd24a;font-weight:600;white-space:nowrap}
#raceBoard .yel{background:#ffd24a;color:#111;border-radius:3px;padding:0 4px;margin-right:4px;font-size:.9em}
#raceBoard .tabs{display:flex;gap:2px;padding:0 6px 4px}
#raceBoard .tabs span{flex:1;text-align:center;padding:2px 6px;white-space:nowrap;border-radius:3px;cursor:pointer;color:#9aa}
#raceBoard .tabs span.on{background:rgba(255,255,255,.14);color:#fff}
#raceBoard table{border-collapse:collapse;width:100%}
#raceBoard td{padding:1px 6px;white-space:nowrap;color:#e8e8e8}
#raceBoard td.n{text-align:right} #raceBoard td.p{color:#9aa;text-align:right;width:18px}
#raceBoard td.num{color:#ffd24a;font-weight:600;text-align:right;width:22px}
#raceBoard td.g{color:#bbb;text-align:right} #raceBoard td.up{color:#6fdc8c} #raceBoard td.dn{color:#ff7a6b}
#raceBoard tr.me td{background:rgba(255,210,74,.18);color:#fff}
#raceBoard tr.sep td{color:#667;text-align:center;padding:0;line-height:.9}
#raceBoard .tag{font-size:10px;padding:0 3px;border-radius:2px;margin-left:4px;background:#2e6bd6;color:#fff}
#raceBoard .tag.fin{background:#eee;color:#111} #raceBoard .tag.led{background:#6b5a14}
#raceBoard .ft{color:#778;font-size:10px;padding:3px 8px 0;text-align:right}`;
    document.head.appendChild(st); document.body.appendChild(el);
    el.addEventListener("click", e => { const t = e.target.dataset?.tab; if (t) setTab(t); });
    addEventListener("resize", place);
  }
  const tabsOf = m => m?.standings ? ["board", "points", "season"] : ["board", "points"];
  function setTab(t) { tab = t; try { localStorage.setItem("nt04.boardTab", t); } catch {} render(); }
  function place() { if (!el) return; const r = canvas.getBoundingClientRect(); el.style.left = ""; el.style.right = (innerWidth - r.right + Math.max(6, r.width * 0.012)) + "px"; el.style.top = (r.top + Math.max(6, r.height * 0.04)) + "px"; el.style.maxHeight = (r.height * 0.72) + "px"; el.style.overflow = "hidden"; el.style.fontSize = Math.max(10, Math.min(13, r.width / 90)) + "px"; }
  // the rows shown: the top 10, then the player and two either side (with a gap marker between)
  function pick(rows, isMe) {
    const me = rows.findIndex(isMe), keep = new Set(rows.slice(0, 10).map((_, i) => i));
    if (me >= 0) for (let i = me - 2; i <= me + 2; i++) if (i >= 0 && i < rows.length) keep.add(i);
    const out = []; let prev = -1; for (const i of [...keep].sort((a, b) => a - b)) { if (i !== prev + 1) out.push(null); out.push(rows[i]); prev = i; } return out;
  }
  const gapText = b => b.pos === 1 ? "Leader" : b.down > 0 ? `-${b.down} lap${b.down > 1 ? "s" : ""}` : b.gap != null ? `+${b.gap.toFixed(3)}` : "—";
  function render() {
    if (!el || !last) return; if (!visible || !last.active) { el.style.display = "none"; return; }
    el.style.display = ""; place(); const m = last;
    const lap = m.over ? "Final" : m.laps ? `Lap ${Math.max(0, Math.min(m.lap, m.laps))} / ${m.laps}` : `Lap ${m.lap}`;
    let h = `<div class="hd"><span class="ttl">${esc(m.name || m.track || "Race")}</span><span class="lap">${m.caution && !m.over ? `<span class="yel">CAUTION</span> ` : ""}${lap}</span></div>`;
    const tabs = tabsOf(m); if (!tabs.includes(tab)) tab = "board";
    const label = { board: "Running order", points: "Race points", season: `${m.year ?? ""} Season`.trim() };
    h += `<div class="tabs">${tabs.map(t => `<span data-tab="${t}" class="${tab === t ? "on" : ""}">${label[t]}</span>`).join("")}</div><table>`;
    if (tab === "board") {
      for (const b of pick(m.board, b => b.player)) {
        if (!b) { h += `<tr class="sep"><td colspan="4">···</td></tr>`; continue; }
        const tags = (b.pit ? `<span class="tag">PIT</span>` : "") + (b.fin ? `<span class="tag fin">FIN</span>` : "") + (b.led ? `<span class="tag led" title="laps led">${b.led}</span>` : "");
        h += `<tr class="${b.player ? "me" : ""}"><td class="p">${b.pos}</td><td class="num">${esc(b.num)}</td><td>${esc(b.short)}${tags}</td><td class="g">${gapText(b)}</td></tr>`;
      }
    } else if (tab === "points") {
      if (!m.scoring) h += `<tr><td class="g" style="text-align:center;padding:6px">No points in this race</td></tr>`;
      else for (const p of pick(m.points, p => p.player)) {
        if (!p) { h += `<tr class="sep"><td colspan="5">···</td></tr>`; continue; }
        h += `<tr class="${p.player ? "me" : ""}"><td class="p">${p.rank}</td><td class="num">${esc(p.num)}</td><td>${esc(p.short)}${p.bonus ? `<span class="tag led" title="lap bonus">+${p.bonus}</span>` : ""}</td><td class="n">${p.race}</td><td class="g">${p.rank === 1 ? "" : "-" + p.behind}</td></tr>`;
      }
    } else {
      // season standings as they would be if the race ended now: total, points behind the leader, places gained / lost
      // (this race's share in the total's tooltip)
      for (const p of pick(m.standings, p => p.player)) {
        if (!p) { h += `<tr class="sep"><td colspan="6">···</td></tr>`; continue; }
        const mv = p.was != null ? p.was - p.rank : 0, mvt = mv > 0 ? `▲${mv}` : mv < 0 ? `▼${-mv}` : "";
        h += `<tr class="${p.player ? "me" : ""}"><td class="p">${p.rank}</td><td class="num">${esc(p.num)}</td><td>${esc(p.short)}</td><td class="n" title="${p.race ? "+" + p.race + " this race" : p.running == null ? "not in this race" : ""}">${p.total}</td><td class="g">${p.rank === 1 ? "Leader" : "-" + p.behind}</td><td class="g ${mv > 0 ? "up" : mv < 0 ? "dn" : ""}">${mvt}</td></tr>`;
      }
    }
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    h += `</table><div class="ft">F4 hide · F6 ${label[next].toLowerCase()}${m.mapped ? "" : " · drivers not identified"}</div>`;
    el.innerHTML = h;
  }
  addEventListener("keydown", e => {
    if (e.target.tagName === "TEXTAREA" || e.repeat) return;
    if (e.code === "F4") { e.preventDefault(); visible = !visible; try { localStorage.setItem("nt04.board", visible ? "on" : "off"); } catch {} render(); }
    else if (e.code === "F6") { e.preventDefault(); const t = last ? tabsOf(last) : ["board", "points"]; setTab(t[(t.indexOf(tab) + 1) % t.length]); }
  });
  return { update(m) { if (!el) make(); last = m; render(); } };
})();
