// xinput-hle.mjs — the Xbox controller API (XAPI XGetDevices / XGetDeviceChanges / XInputOpen / XInputGetState /
// XInputGetCapabilities / XInputSetState / XInputClose) on virtual gamepads the host fills in.
//
// The game's own input driver (open 0x12EE30, poll 0x12EF30: per-port records at 0x272ED0 + port * 0xD8) calls
// these; everything above it (menus, the race's steering/throttle/brake, pause on removal) is the game's code.
// Only the gamepad device type is answered here; other types (memory units 0x1C4A98, IR dongle) run the
// original XAPI code.
//
// Pad state (Xbox layout, as XInputGetState reports it):
//   buttons: bit field — DPAD_UP 0x01, DPAD_DOWN 0x02, DPAD_LEFT 0x04, DPAD_RIGHT 0x08, START 0x10, BACK 0x20,
//            LEFT_THUMB 0x40, RIGHT_THUMB 0x80
//   analog:  8 pressure bytes 0..255 — A, B, X, Y, BLACK, WHITE, LEFT_TRIGGER, RIGHT_TRIGGER
//   lx, ly, rx, ry: sticks -32768..32767 (y up is positive)
// Rumble the game sends (XInputSetState) is kept in pad.rumble = { left, right } (0..65535) for the host.

export const XAPI = { XInitDevices: 0x1c4d4c, XGetDevices: 0x1c5a1d, XGetDeviceChanges: 0x1c5a3f, XInputOpen: 0x1c61c0, XInputClose: 0x1c6216,
  XInputGetCapabilities: 0x1c6222, XInputGetState: 0x1c63fa, XInputSetState: 0x1c646d };
export const DEVICE_TYPE_GAMEPAD = 0x1c4b34;
export const BUTTON = { UP: 0x01, DOWN: 0x02, LEFT: 0x04, RIGHT: 0x08, START: 0x10, BACK: 0x20, LTHUMB: 0x40, RTHUMB: 0x80 };
export const ANALOG = { A: 0, B: 1, X: 2, Y: 3, BLACK: 4, WHITE: 5, LT: 6, RT: 7 };
// the menus map 0x228010's pressed entries (element index -> UI message), when the game's tables are not there
const MENU_MAP = [[0, 0], [1, 6], [8, 7], [11, 9], [10, 8], [9, 6], [13, 10], [12, 11], [14, 12], [15, 13]];
const HANDLE = 0x7e7f0000;                         // XInputOpen handles: HANDLE | port
const ERROR_SUCCESS = 0, ERROR_IO_PENDING = 0x3e5, ERROR_DEVICE_NOT_CONNECTED = 0x48f;

export class Pads {
  constructor(count = 1) {
    this.pads = Array.from({ length: 4 }, (_, i) => ({ connected: i < count, buttons: 0, analog: new Uint8Array(8), lx: 0, ly: 0, rx: 0, ry: 0,
      packet: 1, rumble: { left: 0, right: 0 }, open: false }));
    this.reported = 0;                             // connection mask the game was last told about (XGetDeviceChanges)
    this.calls = { state: 0, open: 0 };
  }
  // what the game sees of a pad: netplay.mjs holds A / START back at the shared start screens (filter(port, pad) ->
  // a pad-shaped object, or the pad itself)
  view(port) { const p = this.pads[port]; return this.filter && p ? this.filter(port, p) ?? p : p; }
  get mask() { let m = 0; this.pads.forEach((p, i) => { if (p.connected) m |= 1 << i; }); return m; }
  // host side: change a pad (any subset of buttons / analog / lx ly rx ry / connected)
  set(port, s) {
    const p = this.pads[port]; if (!p) return;
    if (s.connected !== undefined) p.connected = !!s.connected;
    if (s.buttons !== undefined) p.buttons = s.buttons & 0xff;
    if (s.analog) s.analog.forEach((v, i) => { if (v !== undefined) p.analog[i] = Math.max(0, Math.min(255, v | 0)); });
    for (const k of ["lx", "ly", "rx", "ry"]) if (s[k] !== undefined) p[k] = Math.max(-32768, Math.min(32767, s[k] | 0));
    p.packet = (p.packet + 1) >>> 0;
  }
  // Menus: the frontend screens run in the UI VM (uis-vm.mjs), not in the game's UI manager, so the game's own
  // pad -> UI event path (0x6A770 -> 0x12F860 port action map -> callback 0x75F20 -> 0x13A890) does not reach them.
  // uiEvents() makes the same UI messages: while the port's action map (record [0x273244] + port * 0x1C: +8 map, +0xC
  // callback; entries of 5 words: action, element = kind | index << 16, dead zone, scale, -; end at element 0x8000)
  // is a UI map (callback 0x75F20), each "pressed" entry (kind 9) of it sends its action as the message. Element
  // index: 0 START, 1 BACK, 2-5 d-pad up / down / left / right, 6 / 7 stick clicks, 8-15 the analog buttons A, B, X,
  // Y, BLACK, WHITE, LT, RT. The menus map 0x228010 gives START 0, BACK 6, A 7, B 6, X 8, Y 9, WHITE 10, BLACK 11,
  // LT 12, RT 13 and 2-5 for the d-pad. (These used to be fixed: A 0 / START 7 / BLACK 10 / WHITE 11. Most screens
  // treat 0 and 7 alike, but the race's pause menu 3/1 does not: 7 picks the highlighted item, 0 returns to the race,
  // so every item resumed the race.) The left stick also gives 2-5; directions repeat while held. Value 1 on press,
  // 0 on release. With another map active (driving, the race intro) the game takes the pad itself: no UI messages.
  // Without the game's input tables (tests without game code) the menus map applies. Called once per frame.
  uiMap(mem, port) {
    if (!mem) return MENU_MAP;
    const base = mem.r32(0x273244); if (!base) return MENU_MAP;
    const rec = base + port * 0x1c, map = mem.r32(rec + 8), cb = mem.r32(rec + 0xc);
    if (!map || cb !== 0x75f20) return null;
    if (this.mapCache?.addr === map) return this.mapCache.list;
    const list = [];
    for (let a = map, k = 0; k < 64; a += 20, k++) { const action = mem.r32(a), el = mem.r32(a + 4); if (el === 0x8000) { if (k) break; continue; }
      if ((el & 0xffff) === 9) list.push([el >>> 16, action]); }
    this.mapCache = { addr: map, list }; return list;
  }
  uiEvents(frame, mem = null) {
    const out = [];
    this.ui ??= this.pads.map(() => new Map());
    this.pads.forEach((raw, port) => {
      if (!raw.connected) return; const p = this.view(port);
      const map = this.uiMap(mem, port); if (!map) { this.ui[port].clear(); return; }
      const el = i => i === 0 ? !!(p.buttons & BUTTON.START) : i === 1 ? !!(p.buttons & BUTTON.BACK) : i === 6 ? !!(p.buttons & BUTTON.LTHUMB) : i === 7 ? !!(p.buttons & BUTTON.RTHUMB)
        : i >= 8 && i < 16 ? p.analog[i - 8] >= 0x40 : false;
      const held = new Map([["d2", !!(p.buttons & BUTTON.UP) || p.ly > 16384], ["d3", !!(p.buttons & BUTTON.DOWN) || p.ly < -16384],
        ["d4", !!(p.buttons & BUTTON.LEFT) || p.lx < -16384], ["d5", !!(p.buttons & BUTTON.RIGHT) || p.lx > 16384]]);
      for (const [i, action] of map) if (i < 2 || i > 5) held.set(`e${i}:${action}`, el(i));
      const st = this.ui[port];
      for (const [k, on] of held) {
        const dir = k[0] === "d", msg = dir ? +k.slice(1) : +k.split(":")[1], was = st.get(k);
        if (on && !was) { st.set(k, { since: frame, next: frame + 24 }); out.push([msg, port, 1]); }
        else if (!on && was) { st.delete(k); out.push([msg, port, 0]); }
        else if (on && dir && frame >= was.next) { was.next = frame + 6; out.push([msg, port, 1]); }
      }
      for (const k of [...st.keys()]) if (!held.has(k)) st.delete(k);            // (entries of a map no longer active)
    });
    return out;
  }
  install(game) {
    const c = game.cpu, m = game.mem, H = (a, n, f) => game.hooks.set(a, (cc, ret) => {
      const v = f(cc, ret); if (v === undefined) return undefined;   // undefined: passed through to the original
      cc.r[4] += n; return v; });
    const through = (a, cc, ret) => { cc.push(ret); cc.passThrough = a; cc.hookReturn = a; return undefined; };
    // XInitDevices: the USB host stack (drivers for every device type, OHCI registers at 0xFED00000, DMA at
    // 0x80000000+) — none of it exists here; with the pads answered above, initialising it is not needed. (The
    // original faulted on the missing hardware, so the "Peripheral" module never finished and the game's input
    // system (0x12E7D0, enabled flag 0x272EC4) stayed off.)
    H(XAPI.XInitDevices, 8, () => 0);
    H(XAPI.XGetDevices, 4, (cc, ret) => cc.arg(0) === DEVICE_TYPE_GAMEPAD ? (this.reported = this.mask) : through(XAPI.XGetDevices, cc, ret));
    H(XAPI.XGetDeviceChanges, 12, (cc, ret) => {
      if (cc.arg(0) !== DEVICE_TYPE_GAMEPAD) return through(XAPI.XGetDeviceChanges, cc, ret);
      const now = this.mask, ins = now & ~this.reported, rem = this.reported & ~now; this.reported = now;
      m.w32(cc.arg(1), ins); m.w32(cc.arg(2), rem); return ins || rem ? 1 : 0; });
    H(XAPI.XInputOpen, 16, cc => {
      const port = cc.arg(1), p = this.pads[port]; this.calls.open++;
      if (cc.arg(0) !== DEVICE_TYPE_GAMEPAD || !p?.connected) return 0;
      p.open = true; return (HANDLE | port) >>> 0; });
    const pad = h => ((h & 0xfffffff0) >>> 0) === HANDLE ? this.pads[h & 3] : null, seen = h => ((h & 0xfffffff0) >>> 0) === HANDLE ? this.view(h & 3) : null;
    H(XAPI.XInputClose, 4, cc => { const p = pad(cc.arg(0)); if (p) p.open = false; return 0; });
    H(XAPI.XInputGetCapabilities, 8, cc => {
      const p = pad(cc.arg(0)), a = cc.arg(1); if (!p?.connected) return ERROR_DEVICE_NOT_CONNECTED;
      // XINPUT_CAPABILITIES: SubType, Reserved, In (XINPUT_GAMEPAD: every button and axis present), Out (rumble)
      // (SubType 0, Reserved word 2, In.wButtons 4, In.bAnalogButtons 6..13, In.sThumb* 14..21, Out.Rumble 22/24)
      m.w8(a, 1); m.w8(a + 1, 0); m.w16(a + 2, 0); m.w16(a + 4, 0xff); for (let i = 0; i < 8; i++) m.w8(a + 6 + i, 0xff);
      for (let i = 0; i < 4; i++) m.w16(a + 14 + i * 2, 0xffff); m.w16(a + 22, 0xffff); m.w16(a + 24, 0xffff);
      return ERROR_SUCCESS; });
    H(XAPI.XInputGetState, 8, cc => {
      const p = seen(cc.arg(0)), a = cc.arg(1); if (!p?.connected) return ERROR_DEVICE_NOT_CONNECTED;
      this.calls.state++;
      // XINPUT_STATE: dwPacketNumber, XINPUT_GAMEPAD { wButtons, bAnalogButtons[8], sThumbLX, LY, RX, RY }
      m.w32(a, p.packet); m.w16(a + 4, p.buttons); for (let i = 0; i < 8; i++) m.w8(a + 6 + i, p.analog[i]);
      m.w16(a + 14, p.lx & 0xffff); m.w16(a + 16, p.ly & 0xffff); m.w16(a + 18, p.rx & 0xffff); m.w16(a + 20, p.ry & 0xffff);
      return ERROR_SUCCESS; });
    H(XAPI.XInputSetState, 8, cc => {
      const p = pad(cc.arg(0)), f = cc.arg(1); if (!p?.connected) return ERROR_DEVICE_NOT_CONNECTED;
      // XINPUT_FEEDBACK: header { dwStatus, hEvent, Reserved[58] }, XINPUT_RUMBLE { wLeftMotorSpeed, wRightMotorSpeed }
      p.rumble = { left: m.r16(f + 66), right: m.r16(f + 68) };
      m.w32(f, ERROR_SUCCESS); return ERROR_IO_PENDING; });   // done at once: status already final
  }
}
