// renderer.mjs — the platform layer's drawing interface. d3d-hle.mjs turns the game's Direct3D calls into calls on
// a renderer; backends implement the same small interface:
//   init({ width, height })          the game created its device (back buffer size)
//   setRenderTarget(color, depth)    surfaces (game memory addresses) drawing goes to
//   clear({ flags, color, z, stencil })
//   draw(cmd)                        one draw call: { kind, prim, count, ... , state }
//   present(stats)                   end of frame (Swap)
//
// NullRenderer records what a frame contains (headless runs, tests, the browser page's status line).
// SoftRenderer (soft-renderer.mjs) draws frames in software for captures and as the reference picture; the WebGL
// backend (in the browser) will take the same commands.

export class NullRenderer {
  constructor() { this.frames = 0; this.last = null; this.current = this.blank(); this.log = []; }
  blank() { return { clears: 0, draws: 0, prims: 0, kc: {}, textures: new Set(), shaders: new Set() }; }
  init(info) { this.info = info; }
  setRenderTarget() {}
  clear() { this.current.clears++; }
  get wantsState() { return this.detailed ?? false; }   // per-draw state (textures, shaders) only when asked for
  draw(cmd) {
    const f = this.current; f.draws++; f.prims += cmd.count;
    const k = f.kc[cmd.kind] ??= {}; k[cmd.prim] = (k[cmd.prim] ?? 0) + 1;   // counted without building a key string per draw
    if (!cmd.state) return;
    for (const t of cmd.state.textures) if (t) f.textures.add(t);
    if (cmd.state.vertexShader) f.shaders.add(cmd.state.vertexShader);
  }
  present() {
    this.frames++; const f = this.current;
    const kinds = {}; for (const [kind, ps] of Object.entries(f.kc)) for (const [prim, n] of Object.entries(ps)) kinds[`${kind}/${prim}`] = n;
    this.last = { frame: this.frames, clears: f.clears, draws: f.draws, prims: f.prims, kinds, textures: f.textures.size, shaders: f.shaders.size };
    this.current = this.blank();
  }
}
