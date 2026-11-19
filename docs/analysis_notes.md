# default.xbe — analysis notes

Addresses are virtual addresses (image base 0x10000), the same in default.xbe and default.exe.
Names are working names, not symbols from the original build.

## Startup chain
| Address | Name | What it does |
|---|---|---|
| 0x109878 | entry (XAPI startup) | Clamps certificate size, computes TLS size (0x94 -> 0x2F47A8), TLS index -37, creates main thread via CreateThread wrapper, closes handle |
| 0x108275 | CreateThread | Wrapper over PsCreateSystemThreadEx; default stack 64 KB |
| 0x109804 | main thread start | CRT init (0x10AF86, 0x10AD24, 0x10AEF9, 0x10AEA1), then main(0,0,0), then 0x10AA2E(1,1,0) (probably CRT exit) |
| 0x14400 | main | Engine init, start groups 0 and 1, run frame loop until quit flag, shut down groups 10..0 |
| 0x144C0 | RequestQuit(al) | Sets quit flag 0x2F2D70 = 1 and 0x2F2D71 = al (exit action) |
| 0x144D0 / 0x144E0 | operator new | Thin wrappers over 0x110640 (pool alloc, size in arg / eax) |

## main(): engine init
| Address | Name | What it does |
|---|---|---|
| 0x144F0 | EngineInit | Calls the routines below in order |
| 0xEB300 | MemoryBudgetInit | GlobalMemoryStatus (0x109689); total RAM capped at 64 MB; XGetSectionHandle("$$XTIMAGE") (0x1096D8); copies MAIN/DB pool base+size into 0x2E069C.. ; 0x154D50(0xBD3851EC) |
| 0x11CA40 | (subsystem init, once) | Guard 0x22EEB4; clears 9x0x30-byte table at 0x2F8D2C; 0x11E420, 0x11E160, 0x11D780; status codes 0x3xxxx via 0x10EDB0 |
| 0x110A90 | AllocatorInit(0) | Critical section 0x2F8BC8; pool list head 0x22E4C4 |
| 0xEB3D0 | CreateMemoryPools | 0x110690(desc) for "MAIN", "DB", "SND_EVT" |
| 0x10F010 | (object/handle system init) | Config {1,0,1} at 0x28A640; builds free-lists with 0x11CC60; guard 0x22E30C; status 0x2xxxx |
| 0x1551D0 | (two ring buffers) | 512 x 8 and 256 x 8 byte arrays at 0x27FB18 / 0x27FB28 |
| 0x10FEB0 | (set default pool) | 0x22E4C8 = 0x10F480() |
| 0xEB400 | (finish memory setup) | 0x11CA10(0x10); re-copies pool bases |
| 0x14BB0 | — | Zeroes 0x28AE48..0x28AE58 |
| 0x127CE0 | — | 0x271AA8 = 1 |

### Memory pool descriptors (0x24 bytes each)
| Address | Name | ID | Base | Size |
|---|---|---|---|---|
| 0x2260EC | SND_EVT | 8 | allocate | 0x5000 (20 KB) |
| 0x226110 | DB | 2 | allocate | 0xB4000 (720 KB) |
| 0x226134 | MAIN | 1 | allocate | 0x2E47000 (~46 MB) |
Layout: name[8], id, base (-1 = allocate), size, two counts, flags (u16 at +0x1C).
0x110690 = CreatePool(desc), 0x110640 = PoolAlloc(size, flags).

## Game state machine (singleton at 0x2F3990)
* Built by static initializer 0x189EE0: base ctor 0x174EF0, vtable 0x1F9580, atexit dtor 0x18B440.
* Referenced from ~600 places — it is the central game-flow object.
* Manager vtable: [0] dtor 0xA0120, [1] GroupCount -> 11 (0xA0140), [2] CreateGroup(i) (0xA0150), [3] 0xA0360.
* Methods (thiscall, ECX = 0x2F3990): Init 0x174F60, SetMode 0x1750B0, StartGroup(group, stage=-1) 0x1752C0,
  Tick 0x175370 (called once per frame by main), IsGroupActive 0x175010, StopGroup 0x175320, Shutdown 0x174FC0.
* 11 groups, each a 0x24-byte object with base ctor 0x1753E0 and its own vtable:
  slot 0 dtor (shared 0xA0340), slot 1 (often no-op), slot 2 (default 0x9E710 = return true),
  slot 3 stage table {id, name*} terminated by -1, slot 4 second table, slot 5 lookup by id,
  slot 6 group name, slots 7-8 shared no-op 0xE42A0.
* Full group/stage list: stages.json (128 stages, IDs 0-141 with gaps).

| # | Group | Stages |
|---|---|---|
| 0 | Main Group | Main, Full Init |
| 1 | Interface_Group | branding movie, loading screens, frontend, in-game HUD, pause, end race, demo, simulator |
| 2 | Race_Group | race weekend, transitions, pre-race, race, All-Star segments, caution (QC) states, post-race, victory lane, replay, pause/quit/restart |
| 3 | Quick_Race_Group | setup, race |
| 4 | Season Group | init, setup, management, post-season, race setup, race |
| 5 | Career Group | init, setup, management, post-career, race setup, race, simulation |
| 6 | Memory Card Group | save/load/delete/probe/mount state steps |
| 7 | Lightning_Group | scenario setup/race, pause/resume/restart/quit |
| 8 | License_Group | setup, tutorial, race |
| 9 | Victory Lane Group | animation segments, trophy, team photo |
| 10 | SpeedZone_Group | setup, race, press start |

## How the state machine runs (manager 0x2F3990)

### Manager layout
| Offset | Meaning |
|---|---|
| +0x00 | vtable 0x1F9580 (base 0x1D2078) |
| +0x04 | initialized (byte) |
| +0x08 | mode (set by SetMode 0x1750B0; bit 1 passed to component Enter/Exit) |
| +0x0C | group count (11) |
| +0x10 | pending transition count |
| +0x14 | groups[20] (pointers) |
| +0x64 | pending transitions[], 12 bytes each: {group, fromStage, toStage} |

### Manager methods (thiscall, ECX = 0x2F3990)
| Address | Name | Calls from game code | What it does |
|---|---|---|---|
| 0x175030 | RequestStage(group, stage) | 208 | No-op if already in that stage; fails if group inactive; otherwise queues {group, current, stage}. Change happens next Tick. |
| 0x175010 | IsGroupActive(group) | 251 | group->active (+5) |
| 0x175020 | GetCurrentStage(group) | 66 | pending stage if one is set, else current |
| 0x1752C0 | StartGroup(group, stage=-1) | 12 | Activate (stage -1 = first in table), AddRef + Enter that stage's components |
| 0x175320 | StopGroup(group) | 14 | Deactivate, Release that stage's components |
| 0x1750A0 | PendingCount() | 10 | |
| 0x175370 | Tick() | main loop | 1) apply queued transitions (Transition 0x175240), clear queue; 2) for each active group call group Update (vtable slot 1), wrapped in a named context push/pop (0x110530) |
| 0x175240 | Transition(group, from, to) | | AddRef(to.components) -> Release(from.components) -> group.slot7(to) -> Enter(to.components) -> group.slot2(cur, to) -> group.slot8: set current = to |
| 0x174F60 | Init() | | Creates the 11 groups via vtable slots 1/2, initializes each (0x175420) |
| 0x174FC0 | Shutdown() | | Destroys groups via vtable slot 3 |
| 0x144C0 | RequestQuit | 0 direct calls (probably via a function pointer) | |

### Group object (0x24 bytes, base vtable 0x1D2088, ctor 0x1753E0)
+4 initialized, +5 active, +8 current stage, +0xC stage table, +0x10 second table, +0x14 stage count, +0x18 second-table count, +0x1C pending stage, +0x20 has-pending.
Vtable: 0 dtor, 1 Update (per frame), 2 OnStageChanged(old,new)->bool, 3 GetStageTable, 4 GetSecondTable,
5 GetStageComponents(stageId)->null-terminated list, 6 GetName, 7 OnBeforeEnter(stage), 8 OnAfterEnter(oldStage).

### Stage components (146 of them; see components.json)
* Base class vtable 0x1D20AC, ctor 0x1755C0 (also registers the object in a global list at 0x286710, count at 0x286EE4).
  Built by static initializers in the 0x189E00-0x18B100 range; destructors registered with atexit (0x17F8E2).
* Layout: +4 ?, +8 reference count, +0xC entered flag.
* Vtable: 0 dtor, 1 OnBeforeEnter, 2 OnAfterEnter, 3 OnBeforeExit, 4 OnAfterExit, 5 Enter()->bool,
  6 Exit()->bool, 7 GetDependencies()->list, 9 GetName.
* Reference counting: entering a stage AddRefs every component it lists **and their dependencies, recursively**
  (0x1750C0); Enter (0x175100 -> 0x175670) runs only for components not already entered. Leaving a stage
  Releases (0x175200 -> 0x175150 -> 0x1756A0); a component's Exit runs only when its count drops to 0.
  So components shared between the old and new stage (e.g. Track, Car, Sound) stay loaded across the transition.
* Each stage's component list is in stages.json ("components").

### Recompile notes
* Recompiling stage by stage works naturally: a stage's work = its components' Enter/Exit/Update plus the
  group's Update. Start with Main Group (Main Stage: DMA, DMAMem, USB, FileIO, Math, Matrix, Object,
  Peripheral, Resource, FileCache, Sort, VRAM, Rand) and Interface BrandingMovie (Glib, GlibRender, VRAMHeapFE,
  Sound (Minimal)).
* Component names (DMA, VRAMHeapFE, Glib, Oscilloscope, MemoryCard group) suggest a PS2-first codebase ported to Xbox.

## Main Stage components (group 0, stage 0)

Every component inherits two shared hooks:
* **OnBeforeEnter 0xA0380 -> 0xC4A70**: services audio: DirectSound (DSOUND section) and WMA decoding (WMADEC) of
  custom soundtracks from `\\Device\\Harddisk0\\Partition1\\TDATA\\FFFE0000\\MUSIC\\` (`%s%04x\\%08x.WMA`).
  Probably keeps music streaming while components load.
* **OnBeforeExit 0xA0390**: calls into D3D (0x127CF0 -> D3D section) and 0x131880. Probably keeps the GPU/screen
  serviced during teardown.
* Slot 8 (0x126CF0) returns 0 for all of them.

| Component | Enter | Exit | What Enter does | Status module |
|---|---|---|---|---|
| DMA | return true | return true | Nothing on Xbox (PS2 leftover) | — |
| DMAMem | return true | return true | Nothing on Xbox (PS2 leftover) | — |
| USB | return true | return true | Nothing on Xbox (PS2 leftover) | — |
| Time | 0xA3BE0 -> 0x14150 | — | Zeroes 0x28A5B8, 0x28A5BC, 0x21DB70; 0xE96D0 (uses KeQuerySystemTime) | — |
| Math | 0xA38E0 -> 0x120E00 | 0x120E40 | One-shot init 0x120E80 (guard 0x26EF08) | 0x4 |
| Matrix | 0xA3920 | 0xA3950 | 0x1203A0(3), 0x120440(1,8), 0x120440(2,8), 0x11F870(2): matrix stacks / pools | — |
| Object | 0xA2320 -> 0x1277E0(16) | 0x127C50 | Allocates 16 x 0x14-byte object slots (0x2F8EC0, count 0x2F8EC4) | 0x9 |
| Sort | 0xA3BA0 -> 0x120F10 | 0x120F60 | Sort buffers | — |
| VRAM | 0xA3C30 -> 0x16B8B0(cfg 0x220324) | 0x16B940 | count = cfg[0] (u16); allocates count x 0x18-byte VRAM block descriptors, marks all free (+8 = 0xFF) | 0x8 |
| Rand | 0xA3B10 | 0xA3B30 | Seed = **RDTSC** (stored 0x2B94E4); creates RNG object via factory table 0x205FE8[0] -> 0x2F2D84 | — |
| FileIO | 0x103C70 | — | 0x129580(0x22DD94), 0x1295A0(0), 0x128F50(cfg 0x22D9C0): copies a 908-byte config to 0x2F8F80; per-device table (n = 0x2F9304, 0x28 bytes each) + per-device locks; pools of 128 x 0x24 requests and 128 x 0x2C handles | 0xA |
| FileCache | 0xA0A80 | — | 0xEA780: free list of 0x5C-byte cache entries (0x2DF5C8-0x2E0598); for each of 36 files in table 0x225EEC, `D:\\data\\<file>` is copied to `Z:\\data\\<file>` if the Z: copy is missing (0x1082F0 CreateDirectoryA, 0x1085F8 DeleteFileA, 0xE9FF0 check, 0xEA5F0 copy on a worker thread). 0xEA850 starts/syncs the worker | — |
| Resource | 0xA0BD0 -> 0x1189B0(100), 0x11B480(1) | 0x11B6C0, 0x11AEA0 | Resource manager: 2 locks, pool of 100 x 0xA4-byte resource records, 32 KB work buffer; loader thread | 0xF |
| Peripheral | 0xA3A00 | 0xA3AA0 | Controller layer: 0x12E7D0(cfg 0x22030C) init (port count -> 0x2F93B4); 5 controller slots (0x12720); handler registration via 0x12F9C0; analog max 32767.0 (0x2B94E0); game input layer 0x6AAE0 / 0x6BF90. Reaches the XPP (XInput/USB) library | 0x18 |

Cached data files (D:\\data -> Z:\\data): gmodedb.dat, nascar.db, fe.qkl, game.qkl, simpobj.dat, effect.dat,
carparts.dat, loaddata.dat, cardata.dat, chardat.dat, chartex.dat, carresFE.dat, tk_rend.dat, nsound.dat, icons.dat,
tmapdat.dat, and 20 UI files uis_*.dat (all, awar, comn, cont, crew, drnm, drpo, fmvs, font, fe, gene, ig, modl,
pltl, plts, smnm, spon, smap, trlg, trpc).

### Middleware status codes
Library functions return `(module << 16) | code` and record it via 0x10EDB0 (last status; 0x10EE30 reads it back).
Known modules: 0x2 handle/object system (0x10F010), 0x3 (0x11CA40), 0x4 Math, 0x8 VRAM, 0x9 Object,
0xA FileIO, 0xF Resource, 0x18 Peripheral. `xxxx0001` = "already initialized".
KeQuerySystemTime + RtlTimeToTimeFields appear under almost every component because the status/log path timestamps entries.

### Live window (main.mjs, play-client.js)
- `node main.mjs [Data folder]` boots the game's own flow (NT04_NO_JS_SCREENS=1 by default for flow boot, so the
  game's own screens run: autosave prompt, tip screens, race weekend menu) and serves http://localhost:8854.
- 3D: the D3D layer's renderer is a RemoteRenderer (gl-remote.mjs). At each present it packs the frame's draws
  (vertex program ids, NV2A pixel state, textures, vertex ranges, render states) into one binary message; the
  browser (play-client.js, WebGL2) translates vertex programs to GLSL (nv2a-vsh.mjs vshToGLSL), runs the register
  combiners / texture stages in one uber fragment shader, keeps render targets as FBOs and blits the back buffer.
  Buffers and textures are cached on both sides by hash, so a steady frame is ~0.8 MB (about 1600 draws); the first
  frame of a track carries everything (~80 MB uncompressed RGBA, 200 textures, 2000 buffers).
- Flow control: a frame is only recorded after the page acknowledged the previous one; the emulator never waits for
  the browser (frames are dropped instead).
- UI (menus, HUD): ui-remote.mjs runs renderScreen into a recording canvas and sends textured quads (x, y, u, v,
  rgba; batches by texture and additive flag) only when they change; textures (screen art, fonts) cross once. The
  page draws them over the 3D picture (SRC_ALPHA / ONE_MINUS_SRC_ALPHA, additive SRC_ALPHA / ONE). F2 hides them.
- Input: keyboard (editable map, saved in localStorage "nt04.keys") and the Gamepad API (standard layout) become
  pad messages -> game.pads.set (xinput-hle.mjs).
- Verified offline (record a play-through with RemoteRenderer + UIRecorder, replay it into the page in headless
  Chromium/SwiftShader): title + autosave prompt, tip screens, race weekend menu over the 3D car, track flyovers
  (sky, grandstands, fences, shadows, motion blur) render correctly.
- Race (Race weekend menu -> Race -> 3/18 -> grid intro 3/10 -> HUD 10/0): cars, track and HUD draw (see "In-game
  HUD" below for how the HUD gets its values).
- Bug found by the browser view: no frame ever cleared its depth buffer. 0x1280F0 had been hooked to return 0 as a
  "file module busy" flag, but it reads 0x271AE0, the graphics library's "device created" flag, and begin-scene
  0x127F50 only calls Clear (flags 0xF3, or 0x03 when 0x206150 is clear) when it is set. The software renderer hid
  this (its captures start from fresh buffers); WebGL kept last frame's depth and colour, so near cars from earlier
  frames stayed on screen (doubled cars, piled-up look). Hook removed: one Clear per frame.
- Not drawn yet: fixed-function and immediate-mode (Begin/End) draws; textures are sent decoded (DXT could be sent
  compressed with WEBGL_compressed_texture_s3tc).

### In-game HUD (10/0) and grid intro (3/10) — live values
- The HUD reads the race through natives its scripts call, and the game pushes events into it. Three bridge bugs
  kept it on its authored placeholder strings ("p", "0/Speed", "pittime", "000 FPS / 000 ms"):
  1. 0x7A6A0 offers every native id to the screen's own table 0x78820 first (group <= 0x10, screen <= 0xF), then the
     global switch. The bridge did that only for ids with bit 31 set, so the HUD's ids went to the global switch,
     where they are empty (exit 0x7AE94, result 0). Now every id goes per-screen first. 10/0's table is 0x85F60:
     0x13 -> 0x70A80 (each frame: speed, rpm, gear with "R"/"N", lap time, fuel/status line, which can also queue a
     spotter message 0x1B via 0xD30E0), 0x14 -> 0x70A30 (position "%d" = 0x4B000() + 1, blank before ranking),
     0x15 -> 0x70940 (per-port state 0x2B7518..), 0x16 -> 0x709E0, 0x1A (lap), 0x1C -> 0x70750, 0xEE -> 0x70A20.
  2. Natives that run game code (GameCode.perScreen / global) reset the CPU and used the main stack. Between frames
     a game thread can be stopped mid-function (preemption) with its registers and x87 stack live in the CPU, so
     every HUD call corrupted it: ~14 s into a race the visibility walk 0xF2240/0xF1DB0 recursed through garbage
     until the stack ran out (200+ s per game second). Now GameCode.isolated() saves the whole CPU state
     (saveCtx/loadCtx + flags), runs the call on its own stack (UI_STACK 0x0F140000-0x0F180000) and restores it.
  3. 0x13C1C0 (game notification) delivers at once through 0x13C130 when the manager is not busy (byte +4 & 6) and
     only queues (0x13C2E0, kind 9) otherwise. The bridge always queued, so notifications that pass pointers to
     strings on the game's stack (the grid intro's qualifying times and speeds, 0x8000001D) were read after the stack
     was reused: garbage text and script aborts on 0xFFFFFFFF. Now the VM delivers at once when idle (no script
     running, no dispatch, not pumping: UIVM.idle; scripts share one stack, so a nested script would clobber the
     running one) and queues otherwise.
- Result: position, lap x/y, speed, rpm, gear, running and best lap time, damage diagram with "Pull L to repair",
  grudge/rival callouts (e.g. "-30 Rival, Casey Mears" after contact), no script aborts or game-code errors over 40
  s of racing; uis-vm-selftest passes.

### Vertical-blank interrupts must keep EFLAGS (the "visibility walk" corruption)
- Symptom: ~38 s into a race (deterministic with NT04_BOOT_DATE: frame 2305 after the hand-over in the scripted
  flow) the track's visibility walk 0xF2240/0xF1DB0 recursed forever (200+ s per game second). The tree of the main
  scene object 0x2F1E2C (tree 0x24BEA00, meshes 0x249C100: 3116 groups, 4043 mesh records) was valid at race start
  and all its leaf indices in range, but in that one frame every 16th byte (address = 4 mod 16) from below the mesh
  header up through the tree was zeroed, cutting the low byte off its pointers (leaf array 0x24C2F70 -> 0x24C2F00).
- Writer: the leaf loop 0xF2310-0xF2332 (byte[records + index*16 + 4 + viewport] = 0, count in eax, `cmp eax,ebx`
  at 0xF232C, `jne 0xF2310` at 0xF2332) ran on past 0 with eax going negative.
- Cause: the CPU tick (every 2M instructions: other threads' slices, and every ~12.2M a vertical blank) fell
  between `cmp eax,ebx` (ZF = 1, loop done) and `jne`. The vblank callback (D3D SetVerticalBlankCallback, Glib
  0x127CB0) ran through GameCode.nested(), which restored registers and eip but not EFLAGS; it returned with ZF = 0,
  so the jne looped again from eax = 0. Found by recording compiled-block entries (start, registers, flags) in a
  ring buffer: 0x127CB0 entered with flags 0x56, 0xF232E resumed with 0x16. It needed the interrupt to land in a
  two-instruction window, so any change in where blocks start (a JIT flush, verify mode, the interpreter) moved it.
- Fix: GameCode.interrupt() saves and restores the whole CPU state (saveCtx/loadCtx: registers, EFLAGS, x87, SSE,
  shadow call stack) and the vblank goes through it; nested() (synchronous callbacks from hooks) now also restores
  EFLAGS. A 600 s race-weekend run afterwards: no corruption, no script aborts. (Debug switch kept:
  NT04_JIT_NO_INLINE_W=1 makes compiled blocks write memory through Memory.w8/16/32, so writes can be trapped.)
- This may also be behind earlier one-off faults seen in races (e.g. 0x127595), since any flag-reading instruction
  after a tick could take the wrong path.

### Race start, player control and the race bot (race-bot.mjs) — work in progress
- Music fade wait at the green flag (fixed): 0x73660 sets 0x2F3053 and spins on 0x72B70 until the fade level
  [0x2B7878] reaches 0x20000; the level is advanced by 0x73580 from the background thread 0xEC800 every 16 ms. The
  spin hit the step limit (the thread's sleep never ends while game time stands still), cutting off that race-start
  tick. 0x72B70 is now hooked to run the fade steps itself. Races also run ~3x faster per game second since.
- Car race states (table [0x2F32D8], 0x68 bytes per car, index = car record +0x0C; 0x2C7D0(car, state) sets them):
  during the grid intro the field is in 10 (pace car 43: 9). At the hand-over all go to 10 (car 43: 8); at ~2.9 s
  (0xB3B35) the player's car goes to 3 (human racing) and the others to 2 (AI racing). The entry is track-relative:
  +0x14 sideways position, +0x30 speed, +0x34 heading vs track (degrees), +0x3C segment, +0x40 distance left in it,
  +0x54 lap time (9999 before the line), +0x5C low 16 bits = laps started.
- Pad -> car: the driving actions reach the game every frame (0x6B910: 0x46 throttle, 0x47 brake, 0x39 steering)
  and land in the car's 16-byte controls record (car record +0x5A8; player 0x3E33390: +0 throttle, +4 brake,
  +8 steering, +0xC gear) while the state is 3. The race update 0xB5E40 -> 0x55C50 sends human cars' controls (when
  0x18740(car) = 0, i.e. not AI-assisted) to 0x558D0, which writes them into the car's physics inputs (car record
  +0x20 -> 0x50-byte block: +0x30 steering, +0x34 brake, +0x38 throttle ramp). The AI controller (0x17EB0 -> 0x1E6C0)
  skips cars in state 3/4.
- Root cause found and fixed: the physics / AI constants block ([0x2F2F60], 0x561C bytes, loader 0x5E0E0) was all
  zero. The loader lists the constant tables in CNST (TNAM, ORDB; 37 tables: AI*, CLMD, DTGL, DTGS, PCAR, PCSE,
  PGER gear ratios, PMOM, PSUR surface grip, PTOR torque curve, PTRF, PTSF, PTWS, ZBIA) and copies each through the
  engine's structured API (0x147D70 / 0x1480E0 / 0x1481C0 / 0x148170), which was never bridged and found no tables.
  Now filled from the JS database: per table (CNST sorted by name), rows sorted by ORDB, int/uint/float fields
  (types 2/3/4) except the sort column, 4 bytes each: exactly 0x561C bytes (PSUR lands at +0x319C so the wheel code's
  friction read +0x31A0 + surface*8 is SURT; PTSF rows of 0x5C at +0x4140). With it the player's car brakes (29.8 ->
  0.9 in 3 s) and steers. Before: the wheel force scale table[+0x31A0] was 0, i.e. no grip at all.
- Field order inside each table (fixed): the loader qsorts the table's field list by name (0x5E070, comparator
  0x5F480 = the 4-char codes compared as bytes, i.e. alphabetically) after taking the sort column out (0x5DFE0).
  Copying in declaration order (first version) kept every table's size and offset right but scrambled the values
  inside rows: PGER (gear sets) became 3.5/3.6/0.85/-3/1.15 and the car ran in a "first gear" with a 6.3 overall
  ratio and almost no drive torque (engine pinned at its 2000 rpm floor, car slowly losing speed). With sorted fields
  (PGER = FIGR final drive, FOGR, REGE, REGR, SEGR, THGR) full throttle takes the car from 109 to 190 mph in 9 s with
  a 2->3 shift at ~7900 rpm.
- Drivetrain notes from the investigation: engine speed (phys +8) = rear wheel spin (wheels [car+0x10], 0x60 each,
  +0x18 spin, +0x10 ground force) x gear ratio ([car+4][gear] x [car+4]+0x18) x 9.549, clamped 2000..10000 (0x51E00);
  engine torque 0x509A0 = torque curve 0x2A50A0 (from PTOR) x [car+4]+0x74 x throttle (phys +0x34) x [car+0x18]+0x28
  / +0x30, minus engine braking; per-wheel spin update 0x51D30 (drive torque / wheel inertia, clamped). The race
  update runs 60 physics ticks per second: 0xB6140 turns the ms counter [0x28A5BC] x 0.06 into ticks (1-3 per frame)
  and calls 0xB5E40 per tick.
- Second music wait (fixed): 0x737E0 spins on 0x72B60 until [0x2B7904] reaches 0x26E8F0, stepped by 0x73780 from the
  same background thread; 0x72B60 is now hooked like 0x72B70.
- First complete unattended race (bot2race.mjs with race-bot.mjs, speed target 250 ft/s; the race entry's speed
  +0x30 is in ft/s, the HUD shows mph): 5 laps (default race length) at ~80 s per lap; after lap 5 the game shows the
  Unofficial Results (3/8: winner D. Earnhardt Jr. 5:24.418, player T. Stewart 43rd +1:08.542) and then the replay
  screen (3/3, "Reel 0 - Time 00:00:00.000": replay data not checked yet). No faults and no step limits for the whole
  race. Screenshot race_results.png. (That run's "lane keeping" had the steering sign backwards: the car leaned on
  the outside wall all race, hence the slow laps. Fixed in race-bot.mjs: left lock moves the car toward negative lane
  values; with an integral term the bot now laps at 230-250 ft/s with ~6 ft RMS lane error. Stronger heading damping
  made it oscillate more, so the gains stay 0.035 / 0.07 / 0.0004.)
- Pit stops (default track, EA Sports 500): pit road lies at lane ~-110..-120 (the bot's lane coordinate, ft); the
  entry is near the end of segment 1 (seen at ~500 ft to go); on the front stretch (segment 3, > ~800 ft to go) a wall
  separates it from the apron. Driving in hands the car to the game: race state 5 (pit road, the car is driven at the
  88 ft/s = 60 mph limit), the pit menu 10/1 opens (Replace Tires All 4, Repair Damage, Add Fuel Full Tank, Wedge,
  Tire Pressure, Abort / Done, "Estimated Time 15.650", "70 mph Speed Limit"), state 6 in the stall (~16 s service +
  penalties), state 5 out, state 3 back on track. Entering above 70 mph gives "5 Second Speeding Penalty! 70 MPH Pit
  Entry Speed" (shown correctly). Pit Manager component 0x2F3DF4 (enter 0xA85F0 loads each player's pit settings into
  0x2B9E6C + player*100 via SQL); the per-player pit status word 0x2B9E84 + player*100 (getter 0xA8730, setter
  0xA8750(cl=player, edx=status): 1 = request (only from 0), 4 = entering (from the pit process 0x699A0), 5 = in the
  stall (0x69300), 6 = leaving (0x693C0/0x69445), 8 = clear -> 0 (0x69860)); the pit process is 0x69C00 (under
  0xB5F70, the same chain as the 0x49546 fault below). race-bot.mjs: pitOnLap / pitLane / pitSpeed / pitFrom; the bot
  leaves the pad alone in states 5/6. Pad actions 0x2F / 0x31 are camera / look-back actions blocked in the pits.
  Open: the exact entry condition. Being at lane -110..-120 in the entry zone is not enough: in both test runs the
  first passes there were ignored and the car was taken in only on a later pass (the bot just stays in pit mode
  until it is). Probably a trigger line / request latch in the pit process; states 5 are set from 0x282AA, 0x28EAB,
  0x29188, 0x2AE96, 0x2B146, 0x2B896, 0x2B9A1, 0x2C68B, 0x9F604 (to check).
- Full race with a pit stop (bot2race.mjs, SPEED=330 PITLAP=2): stop on lap 2 (menu 10/1, ~16 s in the stall, no
  penalty at 65 mph), then laps of ~54 s at 245-267 ft/s (qualifying times are ~52 s); at the flag the car goes to
  state 7 (finished), results 3/8 (winner 4:51.502, player one lap down after the stop), replay 3/3. No faults, no
  step limits. Screenshot pit_menu.png.
- Browser check of a full race (recrace.mjs records the draw stream + UI of a bot race with a pit stop, one frame per
  2 s; replayed into play-client.js in headless Chromium/SwiftShader): grid intro, green flag, racing with the HUD,
  pit road (60 mph), the pit menu, the animated pit crew changing tires (letterboxed pit camera, pit timer), laps
  3-5, the cool-down lap, the results and the replay screen all render correctly, no client errors
  (browser_race.png, browser_pitstop.png). The replay screen plays the race back in 3D; only its "Reel 0 - Time
  00:00:00.000" label stays at zero. Notes: race frames are ~10 MB each in the stream (dynamic vertex data re-sent
  every frame; 179 frames = 1.26 GB), which matters for the live WebSocket link; and the pad tap that hands the car
  over must come before the bot's first drive() (the bot overwrites the pad every frame).
- Race speed (measured with a bot race; the container is a shared VM, so single numbers vary): a plain race frame
  costs ~35 ms of emulation (real time needs 16.7 ms: races run ~0.45x before anything goes to the browser).
  Recording the browser stream every frame took it to ~113 ms: the stream is ~1 MB/frame (920 draws; half of it
  re-sent textures), but the cost was CPU in gl-remote.mjs per draw: texture() re-probed up to 1024 words of every
  texture for every draw, pixelState() parsed the pixel shader and JSON-serialised the state per draw, vertex blocks
  were hashed per use, indices read 16 bits at a time, and d3d-hle state() rebuilt its render-state objects per draw.
  Now: textures probed once per frame, vertex blocks hashed once per frame (per-frame memos), pixel states looked up by
  a cheap key with the parsed shader memoised, indices copied in one block, and the render-state maps count their
  changes (GenMap) so the snapshot objects are reused until one. Recording now costs ~71-73 ms per frame (same stream
  content; the replayed frames render as before). The rest of the per-draw cost is record() itself (constant diff,
  command objects) and JSON packing.
  JIT disk cache bug (fixed): its key did not include NT04_JIT_NO_INLINE_W, so debugging runs with that switch had
  filled the shared cache with blocks whose memory writes all went through method calls (~620,000 slow writes per
  race frame instead of ~29,000), and every later run reused them. The key now includes it (first run after the
  update recompiles). It was not the main cost: the plain race frame stayed ~35 ms. Where that goes (profile): the
  dispatch loop runUntil (~20%), many small compiled blocks of the visibility walk 0xF2xxx and the track/scene code,
  memory methods, GC. That is the next target for races in real time.
- Sound (audio-mix.mjs, dsound-hle.mjs, main.mjs + play-client.js): the DirectSound layer now feeds a software mixer
  (48 kHz stereo). What the game plays: mono Xbox ADPCM (tag 0x69, 36-byte blocks -> 64 samples) and mono PCM16 sound
  effects at 48 kHz; engine sounds are looping ADPCM / PCM samples pitched by SetFrequency every frame (~15-27 kHz);
  EA's own software mix goes into a looping 6-channel PCM16 buffer of 50 ms (2400 frames) that the game rewrites
  ahead of the play cursor every frame (it is the loudest part of the race mix, with the engine). Voices read game
  memory live at their play position (so ring buffers work), follow volume (1/100 dB), frequency, loop region and
  position; ADPCM is decoded once per buffer contents. The mixer runs on its own audio clock (game ms + CPU time since
  the last tick, monotonic) and is caught up on every DirectSound call; GetCurrentPosition / GetStatus come from it and
  stream packets complete when played. Master gain 0.8 (headroom). Not yet: mix-bin volumes (3D pan / per-speaker
  levels of SetMixBinVolumes), filters, I3DL2 reverb.
  Live page: the server streams the mix as "IAUD" messages (u32 magic 0x44554149, rate, game speed x1000, frames,
  PCM16 stereo; ~190 KB/s). The page plays it through an AudioWorklet (play-client.js NT04Player) at the output rate:
  the game makes sound at game speed, races run below real time (~0.5-0.7x), and the first version played the sound
  slower to match (an octave down at half speed, pitch jumps when the once-a-second speed estimate changed, rate steps
  between 33 ms chunks, rebuffer gaps) - the user heard it as audio that "messes up a lot". Now the worklet stretches
  the sound in time instead (WSOLA: 40 ms Hann grains, 20 ms hop, +-7.5 ms best-match search), by a factor taken from
  its buffer fill (aim 200 ms, measured from the 49 ms a grain needs, smoothed per grain, 0.25..1.1); within 3% of 1
  the grains are laid exactly, so at real-time speed the samples pass unchanged. Tested with a 440 Hz tone fed at
  1x / 0.6x / 0.5x / 0.4x with +-30% message jitter: pitch stays 439-442 Hz, level steady, no dropouts; 0.3x: one
  dropout at the start; the menu mix at 0.6x: continuous. Live from main.mjs: buffer 170-195 ms, stretch 1.0, no
  dropouts after the initial fill. (Latency ~0.2 s; the queued-buffer path remains as a fallback without
  AudioWorklet.)
  Menu screen changes (user: "swapping between menu scenes makes the music mess up sometimes"): the mixed audio is
  regular in game time (exactly 800 samples per frame), but a screen change costs 40-120 ms of wall time per frame
  for a few frames (game loading work, first compile of newly reached code, new UI textures prepared for the page;
  menu frames are otherwise ~1.5 ms). Up to ~270 ms in a row ran the 200 ms player buffer dry; the player then waited
  for a whole buffer before playing again (gap longer than the stall, with a click), and main.mjs threw away any lag
  over 250 ms (a hole in the game's sound). Now the player fades out with the tail of the last grain, resumes once
  ~50 ms is buffered (the first grain's window fades in), and adds 50 ms of cushion per dry spell (max 450 ms),
  giving 10 ms back per 10 s of steady play; main.mjs catches up lags up to 1 s. Test: 300 ms stalls every 3 s ->
  short dips for the first few, then absorbed (buffer 0.3 s); 150 ms stalls on the menu music -> never dry.
  START on the title (user: the music breaks "when pressing start at the beginning and the things about the hard
  drive pop up"): pressing START reaches a lot of game code for the first time (profile / save checks, menus), and
  the compiled-code cache (x86-jit-cache.mjs) loaded its chunks on demand, synchronously, mid-frame: read + inflate +
  compile a whole chunk (~400 blocks, saved in first-compile order) for one block. 6.1 s of a 9 s profile; frames of
  300-1000 ms (this machine reads the files over a network mount; a local disk is faster, but it is the same burst).
  Now the live loop prefetches the cache in idle time (main.mjs: while ahead of real time; GameCode.prefetchCode ->
  JitCache.prefetch): reading and inflating run in the background, an idle slot only compiles a chunk whose bytes are
  ready (V8 code cache: fast). Test: all 77 chunks loaded within 4.1 s of the title, no prefetch call over 13 ms,
  title frames <= 10 ms; after START 6.2 s of game time take 1.7 s of wall time (was 8.9 s), worst frame 90 ms (was
  1022 ms). Code never compiled before (a first run without a cache) still compiles on first use.
- 3D stream split (gl-remote.mjs): the emulator thread only captures (RemoteRenderer: one typed word buffer + one
  byte arena per frame, game memory hashed in place and copied only when changed; constants diffed against a shadow
  using d3d-hle's dirty register range); FramePacker turns that into the client message, in a worker
  (gl-remote-worker.mjs; buffers transferred, not copied; results from before a client reset are dropped by epoch) or
  in-thread. Race frame (~955 draws), measured inside record(): capture 19 ms -> ~9 ms after removing per-draw
  string keys (numeric map keys, cached pixel-state key when its inputs repeat), per-draw allocations, and per-word
  memory calls in the texture probe; packing ~5-6 ms. Output identical to the old renderer (39 frames, every
  command and constant; only the grouping of constant runs differs) and worker output byte-identical to in-thread.
  On this 2-core VM the worker made the emulator thread slower (contention: 51 vs 40 ms per frame recording every
  2nd frame; plain 34), so main.mjs uses it only with >= 4 cores (NT04_GL_WORKER=1/0 forces). The emulation itself
  (~63% of a recorded race profile) stays the main cost.
- Emulation speed in races. A race frame: ~2.63 M x86 instructions, ~97 k compiled-block entries (27 instructions
  per entry), ~6.6 k hook calls, ~2.5 k interpreted steps, 4 runUntil calls. Bigger blocks (NT04_JIT_MAX 96 / 128 /
  256) were slower (V8 optimizes large functions worse); 64 stays. What helped (CPU ms per frame, medians of
  interleaved runs on the 2-core VM; wall time there is too noisy):
  - V8 tier-up (v8-tuning.mjs, imported first by main.mjs): TurboFan after 600 calls instead of 3000, 100 after an
    inline-cache change instead of 500. Many block functions had stayed in the baseline tier (tick profile full of
    *_Baseline builtins). ~38 -> ~30 ms; the scripted boot to a warmed race also got faster (126 -> 106 s).
    More aggressive values (200 / 50) were not better. NT04_V8_DEFAULTS=1 turns it off.
  - Compiled calls no longer record the shadow call stack (noteCall per call, only used in error messages): error
    reports now add return addresses found on the guest stack (x86emu callStack). ~5-7 ms. NT04_JIT_CALLSTACK=1
    brings the records back (part of the JIT cache key).
  - runUntil runs compiled blocks back to back in an inner loop (limits computed once per pass): ~3%.
    NT04_SLOW_DISPATCH=1 for the old loop.
  - Block functions loaded from the cache get the same properties as fresh ones (one hidden class).
  Checked with a determinism test: after boot + 300 race frames, a hash of game memory (without the two HLE
  scratch pages at 0x1002000, written from wall-clock values, and the UI VM's own regions) plus registers is
  identical between runs and identical between the old and new code.
  Tried and reverted: treating EFLAGS as dead at calls / returns (skip computing them) changed the race (different
  instruction count and car position after 300 frames), so some code does read flags across a call or a hook.
- 3D frame pacing: the page acknowledges each frame after drawing it, and the server used to capture the next frame
  only after that acknowledgement. One frame per round trip (rest of the current game frame + one captured frame +
  packing + transfer + drawing) gave ~10-12 fps in races however fast the game ran. Now up to 3 frames may be
  unacknowledged (gl-remote.mjs credits; NT04_GL_IN_FLIGHT). Simulated page taking 40 ms per frame, 2-core VM:
  1 in flight: game 23 fps, 3D 6-7 frames/s; 3 in flight: game 18 fps, every frame shown (17-18/s). The game itself
  slows a little because every frame is now captured (and packed, unless the worker runs on >= 4 cores).
- User's video after that (their PC): race 3D 24-34 fps, game 32-48 fps, game speed falling with the draw count;
  the race load screen at 2 game fps for ~15 s (first launch after the JIT cache key changed: recompiling).
  Streaming every frame cost (2-core VM, CPU ms/frame): no stream 44.3, streaming 71.3 (capture 14.5, packing 8.3).
  Packing now sends the capture's command words as they are ("IGL2" message: u32 magic, u32 JSON length, JSON
  { frame, res, blobs }, pad to 4, u32 word count, words, blobs; pixel states via res "pskey" key -> id), and
  play-client.js walks the words (old JSON frames still play, e.g. recordings). In-thread packing reuses the
  frame arena. Result: streaming 61.3 against 45.6 without (capture 12.9, packing 1.7 ms).
  Page: the 192 vertex-shader constants (3 KB) were uploaded to the GPU on every draw (~1000 per frame); now only
  when they changed or the program's copy is stale.
- User's video, 2026-10-25 (their PC, after the WebAssembly steps): game 59-61 fps for most of the race (dips to
  45-53 only at 1600-2000 draws/frame), the page 10 fps below it (~900 draws: 49-55, 1100-1500: 43-48, 1600-2000:
  33-40): the page's drawing, not the emulator, was the limit. Stream ~25-50 MB/s (race frame ~578 KB: command
  words 317 KB for ~1050 draws, textures 244 KB — a 128x128 texture re-sent every frame and 512x512 ones now and
  then —, buffers 13 KB, constants 29 KB).
- Page draw state cache (play-client.js). A recorded race stream (scratch streamrec.mjs: the IGL2 messages from
  boot to 25 s of racing) replayed to the page with every WebGL call counted: 76,300 calls per frame for ~1220
  draws (62 per draw: 16 disableVertexAttribArray + 3 calls per attribute, 3 texture calls x 4 stages,
  getUniformLocation for texture sizes, all blend / depth / cull / mask states, 3 uniform4i...). Now:
  - GL state as last set is kept (framebuffer, viewport, program, texture + sampler per unit, blend, depth, cull,
    colour mask, vertex array); uploads, clears, the final blit and the UI layer reset it (stateReset);
  - one vertex array object per (attributes, index buffer), dropped when one of its buffers is freed, not kept
    while a buffer is missing;
  - uniforms remembered per program (pixel state, render target size, texture on / linear / flip / size);
    texture size locations looked up once at link;
  - vertex constants: each program uploads only the registers changed since its own last upload.
  Result: 4,100 calls per frame (18x fewer); the replayed race frame is pixel-identical to the old page's
  (swiftshader). Frame time cannot be measured here (software GL: rasterising dominates); each WebGL call is
  validated and sent to the GPU process, so the saving shows on real GPUs.
- Re-sent textures (scratch texlog.mjs, 1200 race frames): every re-send is P8 (paletted, format 0x0B) and its
  index data really changed each time — none was content already sent under the same key. A 128x128 P8 texture
  changes every frame, a 128x64 one every ~3 frames; one 512x512 P8 buffer (0x36A5A60) is used with ~40 palettes
  (one per car) and rewritten for a different car every few frames (each palette key comes back every ~172 frames
  with new indices). Since they change, they must go out; now cheaper: P8 textures travel as their palette
  indices (unswizzled, 1 byte per pixel) plus the 1 KB BGRA palette ("texp8" resource) and the page expands them
  through a 256-entry Uint32 table — a quarter of the bytes (512x512: 1 MB -> 257 KB), and no per-pixel
  pixelToRGBA call on the server (mmap-tex.mjs decodeIndices; Morton tables now cached). Expansion checked
  byte-identical against decodePixels for 512x512, 128x128, 128x64, 64x256, 256x2, 1x1.
- Page frame reading without per-draw allocations: each draw was a new object with arrays (attributes, constants,
  textures, viewport), a new string key for its vertex layout and Float32Array views — ~10 allocations per draw,
  ~10,000 per race frame, i.e. regular garbage-collection pauses. Now one reused draw record (typed arrays for
  attributes / constant ranges / texture slots), constants copied straight from the message's words, vertex
  layouts keyed by a hash of their words (checked against the words kept with the VAO; a clash is drawn with a
  temporary VAO). Old JSON frames go through a converter (legacyDraw).
- Specialised pixel shaders (play-client.js specMain / programFor). FRAG runs the register combiners / texture
  stages as an interpreter (stage loop, REG[16] indexed at run time, a branch per code), slow per pixel on GPUs.
  A race uses 18 pixel states (24 vertex program / pixel state pairs, scratch stream count). Each pixel state now
  gets its own fragment shader generated from its state: registers as separate variables, stage count, register
  numbers, input mappings, operations, final combiner and texture modes written in; same helper functions and
  arithmetic order, constants (c0 / c1 / final constants / TFACTOR / fog colour / alpha reference) still uniforms.
  Linked per (vertex program, pixel state) with KHR_parallel_shader_compile where available; FRAG draws until the
  program is ready (and when compiling fails). ?spec=0 in the page URL turns it off.
  - Checks: each race pixel state drawn on a full-screen gradient with random textures by FRAG and by its
    specialised shader: 0 differing pixels for all 17 (scratch spectest.mjs). Replay of the recorded race: the
    finished frame read back from the render target after the same 1138 frames is identical (screenshots were
    not a valid comparison with the slow shader: they caught the page mid-frame).
  - Software GL (swiftshader) as a proxy for per-pixel cost, wall ms per replayed race frame: FRAG 4069, specialised
    479, a trivial one-texture shader 402 — the interpreter shader was ~88% of the drawing time there.
- Draw capture, next pass. Per race frame: ~1000 buffer blocks hashed (1.4 MB), only ~67 changed (12 KB); 96
  texture probes, 2 changed. record() ~11 ms -> ~7 ms (timer inside record, 2-core VM):
  - index buffers: per (address, primitive, count) a cache of the raw-byte hash, the vertex range and the uploaded
    rebased buffer; same bytes -> no copy, no min/max scan, no rebase, no second hash (quads / polygons keep the
    old path);
  - texture stage states read from one Int32Array view of D3D_g_DeferredTextureState instead of ~36 memory calls
    per draw; render states by NV2A method number (no name lookups); no per-draw arrays for textures / samplers;
  - the eviction sweep every 30 frames instead of every frame.
  Checked: 199 race frames, every message byte-identical to the previous version.
- User: ~40 fps in races. Emulation pass:
  - JIT cache bug (found because test runs compiled every block, in races too: 0 hits / 27 k misses): the index
    listed chunk files that no longer existed (parallel runs with different cache keys deleted each other's
    folders), and add() skips addresses already in the index, so those blocks were recompiled in every run for
    good. Now a chunk that fails to load drops its index entries (saved again on the next save), and other
    versions' folders are deleted only when unused for 10 minutes. The user's cache was checked: all 134 chunks
    its index references exist.
  - V8 rejects a code cache made under other flags (tested: same flags accepted, mixed rejected and recompiled
    from source, ~200 ms per chunk): gamecode.mjs imports v8-tuning.mjs, so every entry point runs with the same
    flags. Cached block functions get their properties in the same order as fresh ones (src no longer set first).
  - D3D hooks counted every call by name (~200-key object) -> only with NT04_D3D_COUNTS=1; shader constants copied
    as one block (views) instead of per dword; NullRenderer counted draw kinds with two key strings per draw.
    d3d-hle 3.2% -> 2.8%, renderer 1.2% -> 0.2% of a race profile.
  - Tried and reverted: block linking (each block keeps its last two successors, skipping the hook bitmap and
    table lookups); interleaved A/B in one process: no difference (37.4 vs 38.3 ms).
  Race profile now (2-core VM, healthy cache): compiled game code ~52%, runUntil/call (dispatch, incl. the block
  calls) ~23%, interpreter fallbacks ~3%, d3d-hle ~3%, UI VM ~2%. Determinism hash and 3D stream unchanged.
- Code-generation experiments (all reverted; the compiler is unchanged):
  - Lazy EFLAGS across block exits (a block's last flag writer stores its operands, the next reader computes the
    flags; 18.6 k of 26 k blocks had such records, flags computed at ~17.6 k of ~97 k exits per frame; determinism
    hash identical): no measurable gain. TurboFan inlines the FL helpers; they were never the cost.
  - No per-instruction `i = N` (only used for error reports): no gain.
  - Aligned 32-bit memory access through a Uint32Array instead of the DataView: inconclusive (6/12 rounds).
  - Method lesson: cross-process A/B on the 2-core VM swings +-15%. An in-process A/B with two sets of compiled
    blocks swapped (NT04_JIT_CACHE=0) favours whichever set was compiled first (during boot): a variant that had to
    be slower won by 25%. Fair form: drop the boot-time set, build both variants afterwards, run both build orders
    (scratch cgab2.mjs). With that, every micro-variant above came out even.
  Conclusion: at ~6 ns per guest instruction the JavaScript blocks are near what V8 gives for this code shape; the
  next real step for game code is a different backend (WebAssembly blocks over the game RAM as linear memory).
- WebAssembly backend, measurement prototype (wasm-emit.mjs: minimal binary module writer; wasm-jit-proto.mjs:
  x86 subset -> one wasm function per block). The game's low window is now a WebAssembly.Memory (uis-vm.mjs
  enableLow; same 256 MB, same views; lowOK in the page after it, so a lookup with any address's upper 16 bits is
  in bounds; a state page after that). Determinism hash unchanged.
  - Subset: 32-bit mov/lea/ALU (no adc/sbb)/test/inc/dec/push/pop/shifts by imm8/movzx/movsx, jcc as side exits,
    jmp followed, calls inlined (3 deep, return-address check), ret. Flags kept as operands until read (as the JS
    fusion), computed at exits. Registers / EFLAGS / count through the state page.
  - Checked on the hottest race blocks it covers: 12 of 12 identical to the interpreter (registers, flags, next
    eip, all memory).
  - Speed (per block, harness loop subtracted, medians, --no-liftoff): long straight blocks ~35% faster per
    instruction (1.5-1.6 vs 2.3-2.4 ns); but each call from JS costs ~30-40 ns (transition + register copies) vs
    ~15-25 ns for a JS block, and accesses outside the window go through imported JS functions (a block jumps to
    ~470 ns). Overall even (6.66 vs 6.71 ns per instruction).
  - Conclusion: swapping blocks one by one does not pay. It would need execution to stay inside WebAssembly
    across blocks (dispatch by call_indirect in wasm, leaving only for hooks / uncompiled code / ticks), the
    0x8xxxxxxx mirror handled inside wasm, and coverage of most hot instructions incl. x87 and SSE (the race
    physics is floating point) so it rarely leaves. That is a large project (several steps); gain estimate
    1.3-2x on emulation if it works, not verified.
- WebAssembly path, step 1 (wasm-jit.mjs, opt-in NT04_WASM=1): blocks compiled in batches of 256 into modules,
  registered in one shared funcref table; run(eip, budget) inside WebAssembly looks up MAP[eip] (u16 block number,
  memory after the window: OKB page flags, CTX state, NTAB counts, MAP), checks the block's instruction count
  against the budget (so ticks land on the same instruction as before) and calls it with call_indirect; it returns
  to JavaScript at an address without a block. x86emu runUntil's inner loop enters it when MAP has a block, copies
  registers / EFLAGS through CTX. The 0x81000000 heap mirror is handled in WebAssembly (OK flag 2: address ^
  0x80000000). Determinism hash with NT04_WASM=1: identical to the JavaScript path.
  - Bugs found on the way (both made the game abort a frame silently, because an exception escaped from the
    batch compiler into the game's own error handling): the module writer appended with push(...array) (throws
    for large code sections) and the funcref table overflowed (block numbers not reused; a batch could pass the
    end). Now nothing in the batch path can throw into the game, numbers are reused on a flush, batches are capped.
  - Debugging method that found them: per-frame instruction counts of both paths -> first differing frame ->
    hook trace -> block / slow-path traces -> full state compare at one instruction count -> the CPU loop was
    left without reaching its stop address (an exception).
  - Coverage in a race: 2.62 M instructions per frame, 20% inside WebAssembly, ~37.5 k entries per frame
    (14 instructions per entry). Exits to JavaScript by the instruction there: x87 fld m32 16%, mov eax,[moffs]
    14%, cmp r/m8,imm8 14%, imul r,r/m,imm8 8%, mov r8,r/m8 7%, call [r/m] 7%, ... ; the block table (65535)
    also fills (~68 k starts wanted), so some supported code gets no block.
  - Speed: in-process on/off alternation said 35.9 vs 47.0 ms (12/12), but that is biased (with wasm off, the JS
    JIT is left with many small blocks starting where wasm blocks ended). Separate processes: quietest pair
    40.6 vs 37.4 ms median, minimums equal (33.8 / 34.0) -> no reliable gain yet at 20% coverage.
  Next: the cheap integer forms above (moffs moves, 8-bit ALU / mov / test, imul, indirect call / jmp, inc/dec
  r/m, shifts by cl), a bigger block table, then x87.
- WebAssembly path, step 2: block table u32 (MAP 16 MB, NTAB 256 KB, up to 262143 blocks; uis-vm allocates
  LOW/64K + 262 pages = wasm-jit MEM_PAGES). Pending flags carry their size (8 / 32). New: 8-bit ALU / mov / test
  (00-3D 8-bit forms, 80/82, 84, A8, F6/0, 88, 8A, B0-B7, C6), moffs moves (A0-A3), imul (69, 6B, 0F AF; CF=OF by
  i64 product), mul (F7/4), not / neg, inc / dec / push / call / jmp through r/m (FF /0 /1 /6 /2 /4), shifts by 1
  and by cl (D1, D3), setcc, cmovcc, xchg, cdq, cwde, ret imm16.
  - Determinism hash with WebAssembly: identical. Per-block verification ran 40 min (time limit) without a
    mismatch.
  - Race coverage: 39.4% of instructions inside WebAssembly (was 20%), 24.6 k entries per frame (was 37.5 k),
    42 instructions per entry. Exits now: x87 fld m32 47%, other x87 ~12%, sbb 9%, blocks of a single instruction
    (ret, mov; translate wants >= 2), MMX / SSE moves, 16-bit forms, rep movs / stos.
  - Speed, separate processes (2-core VM, CPU ms per race frame): pairs 38.4 vs 31.8 and 40.5 vs 29.4 (medians),
    minimums 35.0 / 37.8 vs 29.5 / 26.3 (first pair disturbed by a load spike) -> ~20-25% less CPU.
  - Now on by default (gamecode.mjs; NT04_WASM=0 turns it off). Live server: menus at 60 fps with sound, the
    auto race reaches the bot driving. Peak memory 3.2 GB vs 2.7 GB without (compiled modules; not cached on disk:
    each launch translates again, ~25 ms per batch of 256 blocks).
  Next: x87 (FPU registers in the state page; the interpreter's x87 is f64, so WebAssembly f64 matches), sbb / adc,
  single-instruction blocks.
- WebAssembly path, step 3: x87. The CPU's r (Uint32Array) and fpu (Float64Array) are now views of the state page
  (CTX, FPU = CTX + 64), so blocks use them in place; the CPU loop copies only EFLAGS and the x87 top / status /
  control words (CTX + 44 / 48 / 52). Translated: fld / fst / fstp m32 m64 st(i), fild m16 m32, fist / fistp m32
  (rounding by the control word's RC, 0x80000000 when out of range, as x86emu), arithmetic with m32 / m64 / m32int
  / st(i) incl. the popping and reversed forms, fcom / fcomp / fcompp / fucom(p)(p) (status word C3 C2 C0),
  fcomi / fucomi(p) (EFLAGS), fxch, fchs, fabs, ftst, fld1 / fldz / constants, fsqrt, frndint, fincstp /
  fdecstp, fldcw / fnstcw, fnstsw m16 / ax, sahf. Floats outside the window go through imported functions that
  use the interpreter's own conversions. Also: adc / sbb (incoming carry, the interpreter's carry rules), inc /
  dec r/m8, leave, fwait, 16-bit mov / movzx forms, and blocks of a single instruction.
  - The determinism test hashed the register array's whole buffer, which is now the WebAssembly memory: it hashes
    the 32 register bytes now. Hash with and without WebAssembly: identical (and equal to the one before all of
    this).
  - Race coverage: 65% of instructions inside WebAssembly (39% before), 12.3 k entries per frame (139 instructions
    each). Remaining exits: SSE / MMX moves (0F 28, 0F 6F, 0F 10: ~50%), 16-bit ALU forms, shld, fnstenv /
    fnsave, rep movs / stos.
  - Speed, separate processes, CPU ms per race frame: JavaScript 39.1 / 38.4 / 36.4 (medians; minimums 34.7 /
    32.6 / 33.6), WebAssembly 30.0 / 23.5 / 23.6 (minimums 26.3 / 21.9 / 20.3) -> ~35-40% less CPU.
  Next: SSE / MMX moves (XMM / MMX registers in the state page too), 16-bit ALU, then caching the translated
  modules on disk.
- WebAssembly path, step 4: SSE / MMX and the game's threads.
  - XMM / MMX register files moved into the state page (x86-simd simdRebind: buffer + offset; XMMB = CTX + 0x100,
    MMXB = CTX + 0x180); wasm-jit points the JavaScript compiler's lane views (jit.xu / xf / mu) there, so the
    x86-jit.mjs source (and its cache key) is unchanged.
  - Translated (x86-simd semantics; float arithmetic promoted to f64 and demoted once, exactly as the
    interpreter): movaps / movups / movss load + store, movntps, movlps / movhps / movhlps / movlhps, unpcklps /
    unpckhps, shufps, andps / andnps / orps / xorps, add / sub / mul / div / min / max / sqrt / rsqrt / rcp (ps and
    ss), cmpps / cmpss, (u)comiss, cvtsi2ss, cvttss2si, movmskps, MMX movd / movq / movntq, emms.
  - The big one: 25.9% of a race frame's instructions run in the game's other threads (xbox-threads runSlice),
    which never entered WebAssembly. runSlice now does, like runUntil (budget check per block; the thread exit
    address 0xdead1000 is outside the image).
  - Tried and reverted: running an untranslated instruction alone in the interpreter and going straight back to
    WebAssembly (instead of a JavaScript block): MMX arithmetic loops then ran instruction by instruction in the
    interpreter (x86-simd msrc allocating per call: 12.7% of the profile) and the frame got slower than before.
  - Coverage: 89% of race instructions inside WebAssembly (65% before), 17.4 k entries per frame.
  - Determinism hash identical with and without WebAssembly.
  - Speed, separate processes: WebAssembly 28.1 / 24.9 / 23.3 ms (minimums 20.5 / 21.8 / 20.1) vs JavaScript
    38.0 / 36.3 / 39.2 (33.1 / 31.5 / 34.2) -> ~37-40% less CPU; only a little better than step 3, because what is
    left is mostly outside the game's code. Profile: WebAssembly blocks 53%, CPU loops + interpreter 15%,
    translating new blocks still ~7% (no disk cache), JavaScript blocks 6%, d3d-hle 4%, UI VM 3%.
  Next: cache translated modules on disk (like the JavaScript block cache), MMX arithmetic, 16-bit ALU.
- WebAssembly path, step 5: translated modules kept on disk (wasm-jit.mjs WasmCache). Folder w<15 hex> beside the
  JavaScript cache's folders in jit-cache (key = wasm-jit.mjs + wasm-emit.mjs sources, game image, memory layout;
  other w* folders are deleted once unused for 10 minutes). Each batch module is saved as m<N>.wz (the module bytes,
  gzip level 1: ~25x smaller, 366 KB -> 14 KB) plus m<N>.jz (gzip JSON: per block start, function index,
  instruction count, instruction addresses). Only blocks whose code lies inside the game image are listed.
  - Use: when the game reaches an untranslated address that the index lists, its module is instantiated (compiled
    synchronously unless the idle prefetch already compiled it) and every block of it is registered at once —
    except blocks that run through an address hooked now (hooks change the translation; a block saved while one of
    its addresses was hooked simply ends earlier, which stays correct). prefetchCode() (main.mjs idle time) now
    also compiles cached modules with WebAssembly.compile, one at a time.
  - Determinism hash: 4759102df54c9322 with a cold cache and with a warm cache (same steps, lap, lane, speed).
  - Race test (det.mjs): translation 30.0 s -> 0.4 s; whole run 108 s -> 63 s wall (115 -> 73 s CPU). Index read
    at startup ~0.3 s for ~124 k blocks / 490 modules; disk 15 MB (302 MB uncompressed). A warm run still adds a
    few small modules (new blocks, e.g. those skipped because of hooks); untranslatable blocks are retried each run.
  - Live auto race on the 2-core VM (browser on the same cores): reaches the race with no errors, cold and warm.
- Static recompilation, step 1: what can be found statically (recomp-scan.mjs; race time samples from
  recomp-sample.mjs -> recomp-samples.json). Code sections .text, D3D, D3DX, XGRPH, DSOUND, WMADEC, XPP
  (0x11000-0x1CC908; DOLBY is DSP code). Recursive descent with the JIT's length rules (+ loop / jecxz / int):
  - from the entry point 0x109878 alone: 4,358 instructions, 78 functions, 0.2% of the executed code (threads and
    callbacks are started through pointers);
  - + the 2,295 data words that point at decodable code (vtables, callback tables): 410,206 instructions,
    8,940 functions, 320 jump tables (jmp [table + reg*4]), 1,105 indirect calls, 34 other indirect jumps;
    covers 89.3% of the 190,725 instruction addresses the block caches have seen executed, and 97.3% of race time;
  - + every block start the game has run (caches): 494,869 instructions, 100% of executed addresses but one
    (0x168D3) and 100% of race time.
  - Race time is concentrated: top 10 functions 41.6%, top 100 79.0%, top 300 95.3% (700 functions sampled).
    Hottest: 0xF1DB0 11.7%, 0xF21D0 7.8%, 0xF2450 6.5% (packed SSE vector maths: movaps / shufps / mulps /
    addps — one to one with WebAssembly SIMD f32x4), 0x134E50 3.8%, 0x132400 2.6%.
  - Plan: x86 functions -> C (registers as locals, flags computed only where read, x87 / SSE in the
    interpreter's arithmetic) -> clang 18 --target=wasm32 -O2 -msimd128 (available in the build workspace; the
    .wasm is committed, nothing to install) -> one module on the game's WebAssembly.Memory, entered from the
    dispatcher by function address; HLE hooks stay; anything not recompiled (unresolved indirect jumps, code
    written at run time, unsupported instructions) keeps running in the block translators. Hot functions
    first, checked with the determinism hash at every stage.
- Static recompilation, step 2: the translator (recomp.mjs) and its place in the dispatcher.
  - recomp.mjs: x86 function -> C function (registers, flags and XMM registers as locals; a switch on the entry
    address; goto between blocks), integer instruction set (ALU with x86emu flags, shifts / rotates by x86emu
    shift(), mul / imul / div / idiv with a zero-divisor exit, movzx / movsx, setcc / cmovcc, push / pop, leave,
    jump tables as switches) and SSE single precision (moves, shufps / unpck, packed arithmetic as SIMD f32x4
    with NaN results stored as 0x7FC00000 like DataView.setFloat32, rsqrt / rcp exact in double, min / max /
    cmp / comiss / cvtsi2ss / cvttss2si as x86-simd.mjs). Built with clang 18 (--target=wasm32 -O2 -msimd128,
    imported memory, data / stack at RC_BASE = LOW + 0x1060000: 64 more pages in uis-vm.mjs and wasm-jit MEM_PAGES;
    enable bytes at RC_BASE + 0x3F0000). Output beside the executable: recomp.wasm, recomp.json (per function:
    entries -> export names, instruction addresses for the hook check). recomp-scan.mjs --save writes the
    function entries (recomp-functions.json) it picks from; node recomp.mjs --top N builds the N hottest.
  - Dispatcher contract: an entry runs at most 255 instructions (budget check at every block start; NTAB 255),
    stores its count at CTX+36 and returns the next eip; every block start is an entry. Unsupported instructions,
    calls through pointers, calls to functions not recompiled / not enabled and jumps out of the function leave to
    the dispatcher; direct calls between recompiled functions are C calls (registers written back before, read
    after; the caller continues only when the callee's ret popped its return address). wasm-jit.mjs loadRecomp /
    registerRecomp: a function is enabled only if none of its instruction addresses is hooked (checked again after
    each hook change). Off with NT04_RECOMP=0.
  - First build, the 300 hottest functions: 29,240 instructions, 7,156 entries, 3.7 MB wasm, clang ~40 s.
    Determinism hash identical (4759102df54c9322, same steps / lap / lane / speed) with 298 functions enabled
    (2 contain hooked addresses).
  - Not faster yet: recompiled code runs 43.5% of race instructions but is entered ~51,000 times per frame for
    only 23 instructions per entry, because x87 instructions (d8-df: ~7,200 of the 29,240) leave to the block
    translator; CPU ms per race frame on vs off within noise (24.0 / 26.7 vs 24.8 / 28.9). Next: x87 in C, and
    load / save only the registers a function uses at entries / exits.
- Static recompilation, step 3: x87, string instructions, MMX moves; registers saved selectively.
  - x87 in C as x86emu.mjs x87(): registers as f64 at CTX+64, top / status / control word in locals; fld / fst /
    fstp m32 / m64, fild / fist / fistp / fisttp m16 / m32 / m64 (rdI64 / wrI64 / fround rules copied exactly,
    including fild m64 going through double arithmetic and the interpreter's round-half formula), arithmetic in
    all register / memory forms, fcom / fcomp / fcompp / fucom* / fcomi*, fnstsw, fldcw / fnstcw, fxch, fchs, fabs,
    ftst, fxam, the constants (exact bit patterns of the interpreter's Math values), fsqrt, frndint, fincstp /
    fdecstp. Transcendentals (fsin, fcos, fptan, fpatan, fyl2x, f2xm1, fscale, fprem, fxtract) and m80 forms are
    left to the dispatcher. rep movs / stos / lods / cmps / scas (byte / dword; the whole loop is one instruction,
    as in strop()), MMX movq / movd / emms. Each function loads / saves only the XMM registers it mentions.
  - NaN bits. First assumption (NaN results stored as 0x7FC00000) was wrong: a game table of 0xFFC00000 NaNs is
    copied unchanged by the interpreter (V8 keeps NaN sign and payload through DataView / Float64Array), so floats
    are plain bit casts. Then a projection-matrix routine (0x154D60: fdiv then fchs with 0/0) came out with the
    other NaN sign: clang -O2 rewrote -(a / b) as (-a) / b (LLVM treats NaN signs as unspecified). Fixed with an
    empty inline-asm barrier around negation / fabs and around the SSE bit operations (xorps / andps / andnps /
    orps); adds and multiplies are emitted as fixed-order WebAssembly instructions (inline asm) so the operand
    whose NaN survives stays the interpreter's. -ffp-model=strict is not supported for the wasm target.
  - Results, 300 hottest functions: 29,240 instructions, ~20 left untranslated; recompiled code runs 64.2% of race
    instructions, 42,141 entries per frame, 41.8 instructions per entry. Determinism hash identical. CPU ms per
    race frame, recomp on vs off (alternating runs): 24.0 / 22.7 / 22.2 / 21.6 vs 25.2 / 26.0 / 22.8 / 24.6 —
    roughly 5-10% less.
  - All 700 sampled functions (52,920 instructions, 70.8% of race instructions, 51 per entry): positions identical
    but the hash differs — NaN sign bits in a second matrix table (0x2DE9A0..0x2DEA0C: the interpreter has
    0x7FC00000, recompiled 0xFFC00000). Bisection is not monotonic (it depends on which mix of functions runs in C),
    so not found yet; the committed build is the verified 300.
  - Entries are still frequent: calls through pointers (vtables) and calls to functions that are not recompiled
    leave to the dispatcher, and every return into a recompiled caller re-enters it.
- Static recompilation, step 4: fewer exits, more functions, the NaN rule found.
  - Exits counted by reason (recomp.mjs WHY counters; RC_NOTE=1 builds report each call that leaves): of ~42,000
    entries per frame with 300 functions, returns to the dispatcher 26 k (mostly after an outside call), calls to
    functions not recompiled 16 k (a third of them HLE hooks: D3D, and 0x1803A8 _ftol), calls through pointers
    6 k, budget 4.6 k, jumps out 2 k.
  - Calls through pointers now look the target up (generated switch over recompiled entries, enable byte checked)
    and call it directly. Bug found by bisection (0x1333C0 enabled it): the 'not found' flag of a nested miss leaked
    to the outer call, which then re-ran its callee from the start; the flag is cleared after every found call.
  - _ftol (0x1803A8) runs natively in C when the hook installed there is gamecode's (marked recompNative: "ftol";
    wasm-jit sets NATIVE[0]): a hooked call costs no step; the return address stays written below esp as after
    the hook's pop. NT04_RECOMP_NO_NATIVE=1 turns it off.
  - Selection: the sampled functions plus the functions most often called from recompiled code while not
    recompiled (recomp-calls.json, from an RC_NOTE run; node recomp.mjs --calls N).
  - The NaN difference (matrix table 0x2DE9A0) was not a block-boundary effect: the pure interpreter (17 min run)
    gives the reference hash too. Cause: when both operands are NaNs, JavaScript keeps the second operand's NaN for
    + and * (V8 swaps commutative operands) and the first one's for - and /, while WebAssembly keeps the first
    one's for all four (measured). A matrix multiply (0x11F6C0, mulps / addps on a matrix of mixed-sign NaNs) showed
    it once it ran in C (with 0x120360 recompiled; before, the block translator inlined it). + and * are now
    emitted with their operands swapped (inline asm, so clang cannot reorder or constant-fold them); - / and sqrt
    are opaque instructions too (clang folds constant operands with its own NaN rules: 0/0 -> +NaN).
  - Build: all 700 sampled functions + 200 most called: 754 functions, 53,824 instructions, 6.8 MB wasm, clang 91 s.
    Determinism hash identical (748 enabled). Recompiled code runs 72.8% of race instructions; 29,827 entries per
    frame (67 instructions per entry); exits per frame: budget 5.9 k, calls to functions not recompiled 9.7 k
    (mostly HLE hooks), calls through pointers 0.3 k, jumps out 2.5 k, returns to the dispatcher 21 k. CPU ms per
    race frame on / off, alternating: 21.5 / 20.6 vs 24.7 / 22.3 (~10% less).
- Static recompilation, step 5: hooks run in place, the dispatcher's real budget.
  - Calls from recompiled code to hooked addresses (D3D and the other HLE functions) run the JavaScript hook in
    place (import hook -> wasm-jit.mjs recompHook, as x86emu's loops run hooks: pop the return address, call,
    eax, hookReturn) and continue at the return address. The step count a hook sees is exact: the dispatcher writes
    its running total to CTX+40 before each block, the C code passes its own count. When the hook changes the
    course (another return address, yield, game code run inside the hook, hooks changed, tick / step limit
    changed) the C code leaves at that address and the dispatcher stops (flag CTX+56), so the run loop takes over;
    runSlice returns "yield" after such a run only when the hook asked (W.hookYield; a stale yieldNow — set by a
    tick or left by runUntil, which ignores yields — must not end the slice: first attempt did that). Hooked
    targets per call site: recomp.json ext -> byte table set at registration. NT04_RECOMP_NO_HOOKS=1: off.
  - Budget: recompiled entries now run up to the dispatcher's remaining budget (CTX+0x1C0, written before each
    block) instead of 255 instructions; NTAB 64 (their longest block). A budget exit used to unwind the whole C
    call chain, each level coming back through the dispatcher on its return.
  - Bug found on the way (endless loop, then a different race): blocks made by splitting a long block were not
    capped again, so one could exceed 64 instructions; entered with less budget than that block it ran zero
    instructions and the dispatcher retried forever. Found with per-frame step / memory hashes (first difference
    in frame 1092), a hook / run log of that frame, and a check that now raises an error when an entry makes no
    progress or runs past its budget.
  - Determinism hash identical. Per race frame: 9,718 entries (205 instructions each; was 29,827 / 67), budget
    exits 1 (was 5.9 k), hooks run in place 7,960, returns to the dispatcher 7.6 k (was 21 k). CPU ms per race
    frame on / off, alternating: 22.3 / 18.0 vs 22.7 / 26.0 (noisy 2-core VM).
- NT04_AUTORACE=1 (main.mjs, testing): the scripted race-weekend menu presses in game time, then the race bot
  drives, through the real server loop and page.
  Volume slider + M = mute, kept in the browser; audio starts after the first key press / click.
  UI sounds: the screens' sound objects (type 1, handler 0x9AC40: method 0 plays UI sound id args[0] via 0xCC240) and
  audio objects (type 4, 0x9AB70: music tracks 2..0x33 / 0x34 on lifecycle -1 load, -2 open, -3 close) now run the
  game's handlers (GameCode.uiObject); the VM sends -2 / -3 to type 4 objects on screen open / close (0x13AAF1 /
  0x13A5D0). Menu navigation sounds play. The audio natives 0x06 0x08 0x31 0x7A 0x7B 0x7F run the game's code now.
  Music and speech (fixed): EA's sound library streams the EA Trax songs (nmusic.dat), the spotter / announcer speech
  (nspchdat.dat) and long samples straight from the archive files: the stream service 0xCE410(edi = kind: 0 music,
  1-4 speech, 5-7 others; ebx = entry) -> 0x12D900; the menu music is started by the audio service 0xC4930 (track
  0xC4710) and runs from the title screen on. Opening a stream asks the resource module for the entry's size, file
  offset and file handle (0x119260(h, i, &size, &offset, &file), from 0x16C682), which was stubbed "not a file entry",
  and then reads 8 KB blocks with the file module's asynchronous read 0x1293C0(h, buf, n, priority, cb, ctx, ?) ->
  request id, completion cb(count, error, ctx) (not ported). Both are implemented now: the archive is already in
  memory (resource module), so the file handle is a file-module handle on that buffer (fileFromBuffer, shared, not
  freed by close), reads complete at once and their callbacks run at the start of the next tick
  (completeFileReads). Result: music through the menus (fades out when the race loads), 7 speech lines opened during
  the grid intro and 31 in 30 s of racing. The music goes through EA's software mix (the 6-channel buffer).
  Not involved after all: the DirectSound stream created at boot (44.1 kHz stereo, 0xEAAC0, callback 0xEA990) is the
  Xbox custom-soundtrack player (XFindFirstSoundtrack 0x1089F2: the user's own WMA soundtracks; plays only when one is
  chosen); 0xEE100 / 0xEE1E0 are the EA Trax jukebox preview (screen 0/12 per-screen native 0x80000012 -> 0x8F8B0);
  native 0x7F (0xEDD30 / 0xEDE60) sets 3D listener vectors. The address-denied module 0x2F4174 is "Sound (Frontend)"
  (not a resource streamer as noted earlier); it and UISEATrax load without faults with NT04_TRY_FE_SOUND=1 but are not
  needed for music, so they stay off by default. Output conversion has a soft knee above 0.9.
  Samples: sound_race_sample.wav (engine, effects, spotter), sound_menu_sample.wav (menu music + navigation).
- Still open: (3) a process tick faulted at 0x49546 (car parts byte read via [rec+0x5A0]) from 0xB5F70 -> 0x74730 ->
  0xA87D0 -> 0xA9C50 -> 0x69C00 -> ... -> 0x47920 with a non-car pointer (eax looked like a float, ~137.0); seen only before the field-order fix, after the car had stopped dead; not seen in the full race since;
  (4) 0x7F4B0 (caller 0x801C0) fetches rows through the unbridged 0x1481C0 from the cursor [0x2B85B0]: the career
  engine list (table ENGN: ENID, ECON, ECPW, ECEF, ECDR, TTYP), not needed for races.
- Earlier symptom notes (before the constants fix): the player's car then barely responded. Three seconds of full brake
  take its speed from 105.6 to 104.8; zero and full throttle give identical trajectories; full left lock in a turn
  lets it slide straight into the outside wall. It behaves like a car with no tire grip, i.e. the human car's full
  physics (wheel/ground contact?) not working in the emulation, while AI cars (a simpler track model) are fine.
- race-bot.mjs keeps a lane from the track-relative entry (steer = -(k*(lane - target) + k*heading + integral), speed
  target, stuck -> reverse, pit mode). Earlier attempts (following a recorded line using the car records' +0x4C position, refreshed
  only every few seconds, or the per-frame table at ~0x28B600, whose entries move between cars) were misled by
  wrong position data: the "car stops near the line" seen then was another car's entry.

### Toward full races: no autopilot yet
- Before the hand-over (A on the grid intro 3/10) the game's AI drives the player's car, but the race does not go
  green: the grid intro walks the rows from the back (about 25 s per row here, 22 rows; at 600 s it was on row 1
  with lap time 0.000) and the field mills around. The slow rows probably wait for the announcer's per-row speech
  stream, which the silent sound backend plays in the wrong time. So an unattended full race needs either a
  driving bot after the hand-over or the AI switch for the player's car (not found yet: 0x2951CC is per-player
  controller records, player 0 at 0x2951E0 with +0x20 = car physics: speed +0, rpm +8, gear byte +0x2B, fuel +0x24).
- The grid intro panels now show real qualifying data (e.g. "9 #88 D. Jarrett 51.948 (184.338 mph)").

## Kernel functions needed by Main Stage
40 functions; full list with users in mainstage_kernel.csv. Groups:
* Core, used everywhere: RtlInitialize/Enter/LeaveCriticalSection, KeQuerySystemTime, RtlTimeToTimeFields, RtlNtStatusToDosError.
* Files (FileCache, Resource, audio hook): NtCreateFile, NtOpenFile, NtReadFile, NtClose, NtQueryInformationFile,
  NtSetInformationFile, NtQueryVolumeInformationFile, RtlInitAnsiString.
* Threads/sync (FileCache, Resource): PsCreateSystemThreadEx, NtResumeThread, NtSuspendThread, NtCreateSemaphore,
  NtWaitForSingleObject(Ex), KeDelayExecutionThread.
* Hardware, almost all from the XPP USB host driver (Peripheral): HalGetInterruptVector, KeInitializeInterrupt,
  KeConnectInterrupt, KeInitializeDpc, KeInitializeTimerEx, KfRaiseIrql/KfLowerIrql, KeRaiseIrqlToDpcLevel,
  KeStallExecutionProcessor, MmAllocateContiguousMemory, MmGetPhysicalAddress, MmLockUnlockBufferPages, ExAllocatePoolWithTag.

### Recompile notes for Main Stage
* DMA/DMAMem/USB need nothing.
* Replace the XPP library (XInput + USB host driver) with a high-level controller API (e.g. the Gamepad API or a
  Node HID library) instead of emulating interrupts, DPCs and the OHCI controller; then most of the hardware kernel
  calls above disappear.
* Rand seeds from RDTSC: substitute a fixed seed for reproducible testing.
* FileCache only optimises disc reads; a Node runtime can map both D:\\data and Z:\\data to the same extracted folder.
* Threads (file cache worker, resource loader) can be run as async jobs or worker threads, as long as the
  semaphores/waits keep their semantics.

## Interface BrandingMovie (group 1, stage 4)

Adds 4 components on top of Main Stage: Glib, GlibRender, VRAMHeapFE, Sound (Minimal).

### What happens on screen
Interface group Update (0x9DDE0) runs every frame: 0xCBFC0 and 0xC4A70 (audio service) first, then a switch on the
current stage (jump table 0x9DF6C, ids 4-18):
* **Stage 4 BrandingMovie**: `PlayMovie("movies.dat", 0, skippable=0)`, then `PlayMovie("movies.dat", 1 + Rand(49), skippable=1)`,
  then `RequestStage(Interface, 5)`. Both calls block until the movie ends, so this stage lasts exactly one tick.
  (Rand(n) = 0x14A10, uses the RNG object made by Rand.Enter.) The second movie is apparently a randomly chosen clip.
* **Stage 5 MainLoading**: sets 0x2B90FC = 1, `RequestStage(Main, 1 Full Init)`, `RequestStage(Interface, 6 Frontend)`.
* Group OnStageChanged (0x9DFB0) handles the UI/menu side of transitions (UI screen ids, starting the Race group, etc.).

### Movie playback
| Address | Name | Notes |
|---|---|---|
| 0x73840 | PlayMovie (register args) | EDX = index, ECX = bundle file name, AL = skippable; -> 0xECF30 |
| 0xECF30 | PlayMovieWrapper | Pauses soundtrack music (0xC4A00/0xC4C70, resumes 0xC4D10) and the FileCache worker (0xEA8A0/0xEA850, resumes 0xEA800) around playback |
| 0x103AD0 | PlayMovieBlocking | 1 MB work buffer; decoder context 0x16C320(2,2,2,buf,1MB); 0x16C5B0, 0x16C4F0; opens the bundle 0x118A70(name, 0x2C); stream 0x16C600; plays with 0x172680(..., frame callback 0x103AA0, flags) — blocks; closes 0x16D070 |
* Bundles: `movies.dat` (0x21D65C) and `prmovies.dat` (0x21D668, used by 0x73850 for other movies, e.g. by race event id).
* Codec: **EA "Madcow" (MAD) video**: the decoder references the chunk tags MADk/MADm/MADe (stored reversed as
  "mDAMeDAMkDAM") and MAD_FRAME. FFmpeg decodes this format, so for the Node port the simplest path is to extract the
  clips from movies.dat and pre-convert them to WebM/MP4 for a `<video>` element, keeping the same index order.
  The bundle's index layout still needs to be read (0x118A70).

### Glib (graphics) — Enter 0x103F40, Exit 0x104090
1. **Device creation** 0x128070 -> 0x127DD0 with config at 0x22DF08 (status module 0xE):
   | Field | Value |
   |---|---|
   | Back buffer | 640 x 480, format 6 (A8R8G8B8), count 2 |
   | Depth/stencil | auto, format 0x2A (D24S8) |
   | Swap effect | 2 (flip) |
   | Presentation interval | 0x80000001 (ONE_OR_IMMEDIATE: vsync, tear if late) |
   | Push buffer | 0x240000 bytes (2.25 MB), kick-off 0x2000 |
   Flags: widescreen (0x10) if XGetVideoFlags & WIDESCREEN; progressive (0x40) if AV pack is HDTV and 480p is enabled
   (0x189AA0 = XGetAVPack, 0x189A57 = XGetVideoFlags).
   SDK calls: 0x199D20 Direct3DCreate8, 0x199C50 Direct3D_SetPushBufferSize, 0x199C70 CreateDevice(0, HAL, 0,
   HARDWARE_VERTEXPROCESSING, &pp at 0x2F8EE0, &device at 0x2F8F68), 0x18C0A0(callback 0x127CB0) probably
   SetVerticalBlankCallback.
2. **Gamma ramp**: 256 entries x RGB at 0x2F2958/0x2F2A58/0x2F2B58,
   `v = 255 * clamp(clamp(pow(i/256, 1.12) * 1.05 - 0.025) - 0.02)` (params at 0x22DEFC..0x22DF04), applied with
   0x18BD80(2, ramp) (first D3D-section function; probably SetGammaRamp).
3. **Render state / shader registry** 0x103CA0 (registers "vtxshader" etc.).
4. **Dynamic vertex buffers** 0x156630(0, 40000, 0x242, 0x244): two buffers of 40000 x 24 bytes in write-combined
   physical memory (0x109788 = XPhysicalAlloc-style), shaders XGS3d, XGS3dMV, XGS2d.
5. Further subsystem inits: 0x132210('Loca'), 0x138890(1), 0xF1220, 0xF9370, 0xFEDC0, 0xF0A40, 0x1038D0, 0x103DC0.
* Named shaders registered by Glib (each needs a WebGL/WebGPU equivalent):
  2xform3, AddMul, ApplyAlpha, CarDmgPixel, CarDriver, CarFEPixel, CarFEVertex, CarGhostPixel, CarLow, CarOnePass, CarPixel, CarSh, CarVertex, CarWinPixel, CarWinVertex, ClrLerpVtx, Cluster, ConeVtx, CrowdPxl, EnvSphereMap, Flat, HalfParaboloid, MultiPass, OnePass, OnePassAdd, OnePassAddTO, OnePassTO, Particle, ParticleRoll, Shadow, ShimmerVertex, SimpleCarVertex, TrackEnvVertex, TrackLitVertex, TrackSpecVertex, TrackVertex, TwoPass, TwoPassAdd, TwoPassEnv, VLit1Vpt, WinSdwSpecPix, WinSdwSpecVtx, XGS2d, XGS3d, XGS3dMV, commonsh, stock, trackshaders, vtxshader, xform0, xform1, xform3
* Glib reaches a few extra kernel functions: AvGetSavedDataAddress, AvSendTVEncoderOption, ExQueryNonVolatileSetting,
  MmAllocateContiguousMemoryEx, KeSetEvent, XcHMAC, XcVerifyPKCS1Signature, DbgPrint.

### Other components
* **GlibRender**: Enter = Exit = 0xA05C0 (returns true). Nothing to do.
* **VRAMHeapFE**: Enter/Exit return true (the heap itself lives in VRAM, set up by Main Stage).
* **Sound (Minimal)**: Enter 0xA35E0 -> 0xCBDB0: fills a 212-byte default sound config (0x12D4D0) and initialises the
  sound library (0x12DEE0); 0xEB260 / 0xEB2A0 around it. Exit 0xCBE10 closes files/handles.

### Recompile notes for BrandingMovie
* Graphics: one 640x480 canvas with WebGL; ignore push-buffer sizes and AV-pack flags (or expose widescreen as an option).
* Gamma ramp can be a final full-screen shader pass, or folded into the colour output.
* Movies: pre-convert the MAD clips; implement PlayMovie as "play clip N, resolve when it ends (or on button if skippable)",
  pausing the soundtrack and file-cache worker as the original does.
* After this stage the game requests Full Init (Main group) and Frontend (Interface group), so the next milestone is the
  Interface MainLoading -> Frontend path.

## Movie bundles (MOVIES.DAT, PRMOVIES.DAT) — EA "TERF" format

| Offset | Content |
|---|---|
| 0x0000 | "TERF", u32 alignment (0x800), u8 2, u8 2, u16 5 (unknown), u16 0x800, u16 entry count |
| 0x0800 | "DIR1", u32 chunk size (0x800), then count x {u32 offset, u32 size}; offsets are relative to the DATA chunk |
| 0x1000 | "DATA", u32 chunk size; entries follow, each aligned to 0x800 (entry 0 at DATA + 0x800 = 0x1800) |

* Directory entry N = movie index N passed to PlayMovie.
* Each entry is a standalone EA multimedia stream: MADk/MADm/MADe video chunks (EA Madcow) interleaved with
  SCHl/SCCl/SCDl/SCEl audio chunks (EA ADPCM R1, 48 kHz stereo). Video is 640x448 at ~30 fps (1000/33), so the game
  shows it in the 640x480 frame with 16-pixel bars.
* FFmpeg reads entries directly with `-f ea` (decoders `eamad` + `adpcm_ea_r1`).
* MOVIES.DAT: 54 entries. #0 = EA Sports logo (4.0 s, played unskippable at boot); #1-#53 = short driver clips
  (~4-8 s); the boot sequence plays one of #1-#49 at random.
* PRMOVIES.DAT: 5 entries, long movies (#0 is 96 s), selected by 0x73850.
* Tool: terf-extract.mjs (list / extract / convert to MP4 or WebM via FFmpeg).

### Other TERF video bundles (all EA MAD video, decoded cleanly by FFmpeg; full list in video_inventory.json)
| File | Entries | Video | Audio | Content | Used by |
|---|---|---|---|---|---|
| UIS_VIDE.DAT | 5 x 74.2 s | 320x240 | none | silent race-footage loops, probably frontend backgrounds | UI file table 0x21FD90, index 14 |
| WHATSNEW.DAT | 1 x 247 s | 640x448 | EA ADPCM R1 | gameplay showcase ("What's New") | frontend code 0x8E622 |
| UIS_CVD1.DAT | 13 (33-80 s) | 320x240 | EA ADPCM R2 | pit-lane driver interviews | UI file table index 15 |
| UIS_CVD2.DAT | 13 (42-117 s) | 320x240 | EA ADPCM R2 | pit-lane driver interviews | index 16 |
| UIS_CVD3.DAT | 13 (46-80 s) | 320x240 | EA ADPCM R2 | pit-lane driver interviews | index 17 |
| UIS_CVD4.DAT | 3 (73-93 s) | 320x240 | EA ADPCM R2 | pit-lane driver interviews | index 18 |
* UIS_VIDE/UIS_CVD* use 0x40 alignment instead of 0x800; the same TERF layout otherwise (terf-extract.mjs handles both).
* UI file table at 0x21FD90 (35 names, used by index): uis_font, comn, fe, ig, snd, drpo, drnm, modl, trpc, trlg, smnm,
  spon, crew, smap, vide, cvd1-4, pltl, plts, fmvs, text, gene, shop, over, icon, trop, back, awar, cont, anma, spdl,
  race, logo. uis_snd.dat is in the table but not on the disc.
* The 320x240 clips are drawn inside UI panels, not full screen.

## MainLoading -> Frontend (the path to the main menu)

### What changes, in order
* **Interface 4 -> 5 (MainLoading)** enters 28 components, in dependency order:
  QuickloadFrontend, Texture, Loading...Coldboot, CarResource, MemoryCard, DB, DB Constants, User Profiles, User Files,
  Speech, Sound, Music, EASportsBIO, Viewport, Camera, Font, UIStudio, UISCommon, UISDebug, UISMemoryCard, UISChat,
  Sound (Frontend), UISEATrax, Motion Blur, UISFrontEnd, UISFlagObj, UISCarObj, UISController.
  QuickloadFrontend and Loading...Coldboot are entered 1st and 3rd, so the loading screen is up while the rest loads.
* **MainLoading Update** then queues Main 0 -> 1 (Full Init) and Interface 5 -> 6 (Frontend).
* **Main 0 -> 1** adds nothing new (DB and DB Constants were already pulled in as dependencies of User Profiles).
* **Interface 5 -> 6 (Frontend)** enters USB Keyboard, Oscilloscope, FileCacheProcess and releases QuickloadFrontend and
  Loading...Coldboot (the loading screen goes away). 47 components are active on the main menu.

### Per-component summary
| Component | Enter | Exit | Notable kernel calls | Notable strings / files |
|---|---|---|---|---|
| QuickloadFrontend | 0xa0b30 | 0xa0b50 | NtResumeThread | fe.qkl |
| Texture | 0xa2bf0 | 0xa2c10 | — | RAW1 |
| Loading...Coldboot | 0xa1a20 | 0xa1a40 | KeBugCheck, NtClose, NtQueryInformationFile, NtResumeThread, NtSetInformationFile, PsCreateSystemThreadEx | ColdbootLoadFinish, ColdbootLoadStart, NIPS'.'DIPS' inner join 'NOPS' on 'RFFO'.'DIPS' = 'NOPS'.'DIPS' where 'RFFO'.'TK, loaddata.dat |
| CarResource | 0xa0750 | 0xa07d0 | NtClose, NtQueryInformationFile, NtResumeThread, NtSetInformationFile | RESIcarparts, Resident, carparts.dat |
| MemoryCard | 0xa3990 | 0xa39b0 | @KfLowerIrql, @ObfDereferenceObject, KeRaiseIrqlToDpcLevel, KeSetBasePriorityThread, NtCreateEvent, NtSetEvent | — |
| DB | 0xa08a0 | 0xa0940 | DbgPrint, ExQueryNonVolatileSetting, HalRegisterShutdownNotification, MmAllocateContiguousMemoryEx, MmFreeContiguousMemory, MmQueryAddressProtect | nascar.db |
| DB Constants | 0xa0980 | 0xa0990 | — | — |
| User Profiles | 0xa3140 | true | — | — |
| User Files | 0xa3100 | 0xa3110 | — | — |
| Speech | 0xa3810 | 0xa3820 | NtClose, NtResumeThread | nsound.dat |
| Sound | 0xa3250 | 0xa3260 | — | nmusic.dat, nsound.dat, nspchdat.dat |
| Music | 0xa3200 | 0xa3220 | MmAllocateContiguousMemoryEx, MmFreeContiguousMemory, NtClose, NtCreateFile, NtQueryInformationFile, NtSetInformationFile | ERROR |
| EASportsBIO | 0xa09d0 | 0xa09f0 | — | Races Run: |
| Viewport | 0xa2c40 | 0xa2c60 | — | — |
| Camera | 0xa04c0 | 0xa04f0 | — | — |
| Font | 0xa0af0 | 0xa0b00 | — | — |
| UIStudio | 0xa19d0 | 0xa19f0 | NtClose, NtQueryInformationFile, NtResumeThread, NtSetInformationFile | %s%s\%s, looseres\, uis_gscr.dat |
| UISCommon | 0xa1260 | 0xa1370 | NtClose, NtCreateFile, RtlInitAnsiString | %s%04x\%08x.WMA, \Device\Harddisk0\Partition1\TDATA\FFFE0000\MUSIC\ |
| UISDebug | true | true | — | — |
| UISMemoryCard | 0xa19a0 | true | — | — |
| UISChat | true | true | — | — |
| Sound (Frontend) | 0xa3550 | 0xa3570 | — | — |
| UISEATrax | 0xa14c0 | 0xa14f0 | — | ERROR |
| Motion Blur | 0xa2900 | 0xa2910 | — | — |
| UISFrontEnd | 0xa1570 | 0xa15f0 | NtClose, NtCreateFile, RtlInitAnsiString | %s%04x\%08x.WMA, \Device\Harddisk0\Partition1\TDATA\FFFE0000\MUSIC\ |
| UISFlagObj | 0xa1530 | 0xa1540 | — | FLAG |
| UISCarObj | 0xa1110 | 0xa11b0 | NtResumeThread | CMMP, Decal%d, MMAP, envwin |
| UISController | 0xa1430 | 0xa1450 | — | — |
| USB Keyboard | true | true | — | — |
| Oscilloscope | true | true | — | — |
| FileCacheProcess | 0xa0ab0 | 0xa0ac0 | NtReleaseSemaphore, NtResumeThread, NtSuspendThread, NtWaitForSingleObjectEx | — |

No-ops (Enter/Exit return true): UISDebug, UISChat, USB Keyboard, Oscilloscope.

### Loading screen (Loading...Coldboot)
* Enter 0xA1A20: posts load event "ColdbootLoadStart" (0x11B950(0x1FA0EC)), then 0x733C0(mode = 1).
* 0x733C0 (mode in EAX): sets render-enable flag 0x21FD14 = 1; opens loaddata.dat; mode 1 -> 0x73060 (full-screen
  640x480 quad with image #1 of loaddata.dat); **fades in synchronously**: alpha 0..252 step 4, each step draws
  (0xECBE0 / 0xECC20 / 0xECCD0) and presents; then alpha 255. If flag 0x2F3052 is set, 0xECD10 starts a background
  thread (CRT _beginthreadex 0x17FC15 -> CreateThread) that keeps the screen animating while loading continues.
* Exit 0xA1A40: 0x73660 (stops the thread / fades out), posts "ColdbootLoadFinish" (0x1FA0D8).
* loaddata.dat: TERF bundle, 133 entries, all "MMAP" (image) resources.

### Database (DB, DB Constants) — nascar.db + GMODEDB.DAT
* DB.Enter 0xA08A0: memory from the "DB" pool (720 KB, descriptor 0x226110); engine init 0x144890(5, 1270, 400, 30, 150)
  (limits, exact meaning unknown); 0x147590('ncar', 0xB4000); open 0x147780('ncar', 0, "nascar.db" 0x21D5E0, cb 0x205F74);
  0x147920('ncar'); then 0xA0800, 0xA0850, 0x16840 and an update query (0x1F98C8).
  DB reaches XcHMAC / XcVerifyPKCS1Signature, so the database (or saved copies of it) is signature-checked.
* **Query API: 0x1471D0(0, query, ...args)**, called from 2,139 places. Queries are SQL text with typed placeholders:
  0x80 = int8, 0x81 = int16, 0x82 = int32, 0x83 = uint8, 0x84 = uint16 (size/signedness of the C variable; for
  `into` outputs the game passes a pointer and the engine writes that many bytes). Arguments are in order of appearance,
  outputs and inputs mixed. 833 query strings (571 select, 185 update, 41 delete, 36 insert) over 117 tables; in the
  query text the 4-character names are byte-reversed relative to the database file ('TSRD' = table DRST).
  All queries, names un-reversed: db_queries.json.
* **File format** (fully decoded; reader: nascar-db.mjs):
  * Header: "DB" 00 08, u32 0, u32 file size, u32 0, u32 table count, u32 checksum; directory of {char name[4], u32 offset}
    (offset from the end of the directory).
  * Table: u32 crc, u32 flags (0x20 string pool, 0x40 Huffman-coded pool), u32 record size, u32 record bits - 1,
    u32 pool size, u16 capacity, u16 record count, u16 ?, u16 0xFFFF, u8 field count, u8 index count, 6 bytes ?, u32 crc;
    fields {u32 type, u32 bit offset, char name[4], u32 bits}; records (capacity x size); string pool; index blocks (16 bytes each).
  * Field types: 0 inline string, 2 signed int, 3 unsigned int, 4 float32, 13 pooled string (32-bit pool offset).
    Values are packed LSB-first at bit offsets.
  * Pooled strings: plain = u8 length + chars; Huffman (flag 0x40) = tree at the start of the pool (2-byte entries,
    00 cc = leaf 'cc', otherwise child node; node n -> entries 2n / 2n+1), each string = u8 length + MSB-first bitstream.
  * Byte 0xB1 ('±') in names is the game font's (R) symbol ("Daytona 500±").
* Contents: NASCAR.DB = 198 tables / 6,287 rows; GMODEDB.DAT = 5 more DBs (challenges CHAL/CHAC/CHAE; MRNR/STNM/UMAP;
  career CARE/CONT/OFFR/CCRW/TASK/parts; scenarios SCEN/SCAR/SZSC...; CRDS). 261 tables, 10,414 rows in total.
  GINF.YEAR = 2003; DRST holds driver season stats 1953-2002 (2002 leader Stewart, 4,800 points — matches the real season).
  Full export: nascar_db.json.
* **Node implementation**: nascar-db.mjs (parseDb / openDatabases / Database.exec, CLI tables|dump|query) and
  nascar-db-selftest.mjs (all 833 queries parse; 829 execute, 4 hit table capacity with dummy parameters).
  The engine enforces table capacity like the original fixed-size tables.

### Quickload (QuickloadFrontend) — fe.qkl
* Enter 0xA0B30 -> 0x11B4B0("fe.qkl", 0x2C); Exit -> 0x11B520.
* Format "QL01": u32 0xC, u32 0xE64; chunk FILS (41 x 48-byte file names: cardata.dat, carresFE.dat, loaddata.dat,
  nmusic.dat, nsound.dat, nspchdat.dat, uis_*.dat...), chunk DTLS (140 x 12-byte records; layout not yet decoded),
  then packed data. It is a pre-recorded read cache so the frontend loads with one sequential read; the resource manager
  serves reads of those files from it. A Node port can skip it and read the source files directly.

### UI system (UIStudio and UIS* components) — EA "ll_api" middleware
* Source path left in the binary: `\proj\ll_api\Source\Common\UIStudio\UISEvent.c`, so the middleware library
  (status modules, file I/O, resources, DB, UI) is EA's "ll_api".
* UIStudio.Enter 0xA19D0 -> 0x757B0: clears 8 UI layer slots (0x20 bytes each from 0x2B7C38), 0x127810(10, 20, 8, ...),
  loads uis_gscr.dat (536 bytes; probably the screen table/script) -> 0x2B7928/0x2B792C, more init (0x76140, 0x753B0,
  0x76180, 0x74CD0); then 0xEDC00 and 0x127CF0.
* The Interface group's OnStageChanged opens UI screens with 0x13B1B0(layer handle 0x2B7C38/0x2B7C58, screen id, ...).
* UISCommon / UISFrontEnd also reach the WMA soundtrack player (custom music in menus).

### Frontend frame (Interface Update, stage 6)
1. UpdateUILayer (0x75500, layer in EAX) for layers 0, 3, 6, 8.
2. 0x751E0, then 0x13E8B0(0x13E750(1)).
3. 0x154C10: renders the frame (heavy D3D/XGRPH use; DDS textures).
4. If render-enable flag 0x21FD14: 0x127FC0 = Present (D3D 0x199AA0(0), probably Swap; frame time in vblanks -> 0x20614C).
5. 0x1317F0(port, 0) for ports 0-3.
6. Rand(0xFFFF) (advances the RNG every frame).

### Data files on this path
| File | Format | Used by |
|---|---|---|
| fe.qkl | QL01 read cache | QuickloadFrontend |
| loaddata.dat | TERF, 133 MMAP images | Loading...Coldboot |
| nascar.db | EA DB, 198 tables | DB |
| gmodedb.dat | TERF, 5 DB files | (game modes) |
| carparts.dat | resident resource ("RESIcarparts") | CarResource |
| nsound.dat, nmusic.dat, nspchdat.dat | sound banks | Sound, Speech |
| uis_gscr.dat | 536-byte UI table | UIStudio |

## Compressed bundles (TERF COMP chunk) and textures (MMAP)

### TERF chunk layout, refined
- First chunk starts at the u32 at 0x04. Later chunks follow the previous chunk, padded either to the small
  alignment at u16 0x0C (4 in the UI bundles) or to the u32 at 0x04 (0x800 in MOVIES.DAT).
- Optional `COMP` chunk between DIR1 and DATA: entryCount x { u32 method, u32 uncompressedSize }.
  DIR1 sizes are then the stored (compressed) sizes.
- Read path: resource open 0x118A70 -> read entry 0x11A390 -> 0x1194F0 (method from COMP table at param_1[0x15]+idx*8)
  -> codec dispatcher 0x122280 -> init 0x121D10 / step 0x121E30 / end 0x121E90.
- Codec registry: pointer 0x26EF1C, filled at 0x122130. Method 0 'NONE' 0x2060F8, 1 'RLE1' 0x2060D0,
  2 'HUFF' 0x2060A8, 3 'LZM1' 0x206080, 5 'LZH1' 0x206054. Codec table: +0 tag, +4 version,
  +8 compress init, +0xC step, +0x14 decompress init, +0x18 step, +0x1C end.
  Only NONE and LZH1 occur in the files seen so far.

### LZH1 (method 5) — simplified DEFLATE, implemented in ea-lzh1.mjs
- Decompress init 0x124790 (32 KB window via 0x10FF20 when not decoding straight to memory), block reader
  0x123690, symbol loop 0x123060 (windowed) / 0x123A40 (inlined, direct-to-memory). Bit reader 0x122530: MSB-first.
- Block: 1 bit last-flag. 1 = end of stream (then 32 bits read and ignored). 0 = 285 x 4-bit lit/len code lengths,
  30 x 4-bit distance code lengths, then symbols until 256.
- Canonical Huffman codes exactly as DEFLATE (0x1228C0); decode tables built by 0x122950/0x1235B0.
- Lit/len: 0-255 literal, 256 end of block, 257-284 lengths with the DEFLATE table (0x1CD564 extra bits,
  0x1CD580 base) except symbol 284 = 227 with no extra bits. Distance: DEFLATE table (0x1CD5BC / 0x1CD5DC).
- Verified: all 210 LZH1 entries in the staged files decode to exactly their COMP sizes.

### MMAP texture resource (mmap-tex.mjs)
- 0x1C palette header offset (absolute; its +8 = palette data offset relative to 0x80, BGRA entries),
  0x20 name offset (absolute), 0x28 u16 width, 0x2A u16 height, 0x2C D3D format, 0x30 pixel bytes,
  0x34 pixel offset (relative to 0x80). Swizzled formats use Morton order, x first.
- Formats seen: 0x0B P8, 0x06 A8R8G8B8.
- LOADDATA.DAT: 133 textures; entry 0 = "LOADING" coldboot screen, 1024x256 = per-track banners, 1024x512 = tips/controller.
- CHARTEX.DAT (all LZH1): 37 DRIVERFACE + 9 FACE (256x256), 40 ARM firesuit (256x512) + 40 ARM glove/low-res (64x128).
- UIS_COMN 21, UIS_FE 27, UIS_ICON 72, UIS_LOGO 10 MMAPs (unnamed). ICONS.DAT: 6 XPR0 + 1 BM6D (not decoded yet).

### UI bundles
- UIS_ALL.DAT: 17 nested TERFs (alignment 0x10, all entries LZH1) + 1 empty entry — UI screens, format next.
- UIS_GSCR.DAT: 1 LZH1 entry, 0x627 bytes: repeated records with floats — UI screen layout data.
- UIS_FONT.DAT: 6 "FNTS" fonts.
### Limits seen here (for the configurability goal)
- Driver character textures are fixed sets in CHARTEX.DAT (37 named faces + 9 generic, 40 suits).
  More drivers need either more texture entries or a fallback to the generic faces.

## UI system (UIStudio, ll_api) — screens and script VM (uis-screen.mjs)

### Containers
- uis_<name>.dat = TERF of screens (one group); uis_all.dat = TERF of 17 group TERFs (+1 empty entry), all screens LZH1.
  196 screens in uis_all. Filename table at 0x21FD70/0x225F60; group descriptors near 0x2267B0 (used from 0xA1200).
- uis_gscr.dat = the global screen, loaded at 0x75980 (stored 0x2B792C) and installed with SetGlobalScreen 0x13A2F0.
  Script addresses with bit 31 set resolve into it (0x13CA80).
- Resource cache per group: 0x13E5D0 (0x24-byte group records), load 0x13E950, entry fetch 0x13ECD0 (async via 0x11A490).

### UIStudio context (init 0x13A140, magic "_SIU", set up at 0x75660)
- Callbacks: +0x0C native-call dispatcher 0x7A6A0, +0x10 0xEDC10, +0x14 load screen 0x75450, +0x18 unload 0x75470,
  +0x1C state callback 0x140450, +0x24 screen-activated 0x754F0.
- +0x38/+0x3C open screens (0x14 each: {?, u16 group, u16 screen, u16 prevGroup, u16 prevScreen, unloading, data}).
- +0x48/+0x4C object-type handler table (register 0x13A2D0), +0x54/+0x58 rate functions (0x34 each),
  +0x5C/+0x60/+0x64 suspended scripts (0x28 each), +0xB0/+0xB4 message queue (post 0x13C2E0, dispatch 0x13C430).
- Message kinds: 0 open (0x13AF10), 1 close (0x13A4C0), 2/7 send event (0x13A9D0), 3/4 activate (0x13B230),
  5/6 enable/disable child state (0x13AC10), 8 0x13BEB0, 9 0x13C130.

### Screen format (relocation 0x139F70)
- Header: stateCount, statesOff(0x30), stringCount, stringsOff, strRefCount, strRefsOff, objCount, objsOff, then the
  screen-object table at 0x20 (always type 3 string table + type 1 sound).
- Strings: { u32 type 1, u32 capacity, u32 ptr }. Script strings are mutable buffers of that capacity.
- State (0x14): { hdr, childCount, childPtrs, eventCount, events }. Event { u16 flags, s16 id, u32 code }:
  0x8000 + id<0 system events (-2 = enter/init, -3, -4, -6, -7 ...), 0x8000 + id>=0 messages,
  0x4000 controller input (id = button), 0xC000/-1 = link to child state.
- Child: { hdr, n, items } with item { s16 type, u16, ptr }; type -1 = nested state index, else object.
- Object types: 0 element 0x13FC20 (19,500 uses), 1 sound 0x9AC40, 2 game hook 0x9A900, 3 localized string table 0x9A990,
  4 audio 0x9AB70, 6 0x141130 (8,328 uses, probably text), 7 0x13F630, 8 0x142200. Handler(obj, msg, argc, args, ret):
  msg -1 load/relocate, -2/-3 lifecycle, >= 0 methods called by scripts (op 0x0A).
- Type 3 string table: { u8 loaded, u8 groupCount, u16 langCount, u16 curLang, +8, +0xC entries (4 bytes), +0x10 groups
  {u16 count, u16 first}, +0x14 string ptrs }; methods 0 group size, 1 field, 2 get string, 3 find, 4 set language.

### Script VM (0x13CAB0)
- Stack machine, 32-bit cells, byte opcodes 1..0x7E (jump table 0x13E324), operands little-endian inline.
  Jumps take their relative offset from the stack (push imm; jz) relative to the next instruction.
  call imm32 (bit 31 = global screen), ret pops pc; pc 0 ends the script. Script start pushes {.., args, obj, 0}.
- Ops 4/5/9/0x16/0x17/0x53 end the script. 0x51/0x70 suspend the script until the opened screen closes (returns 3).
- native_call (0x0B): pops argc, args and function id -> ctx+0x0C = 0x7A6A0. That first tries per-screen handlers
  0x78820 (group <= 0x10, screen <= 0xF), then a switch over ids 0..0xF7: the UI <-> game API surface.
- obj_call (0x0A): pops argc, type, method, object -> handler table. tween (0x58): animate a property id
  (0x13B570 maps ids 0x10..0x27 to object fields) over time. rate_start/stop: per-frame callbacks.
- Verified: every event script in all 196 screens + gscr disassembles with control flow followed (1.1M instructions).

### Drawing screens (uis-render.mjs)
- UI space 854x480: UI camera (0x75520) is centred on (427,240) at z = -240/tan(22.5 deg) with a 45 degree FOV, so
  z=0 maps 1:1; a 4:3 display shows x 107..747 (widescreen shows all 854).
- Texture groups (cache 1, tables 0x226A48 frontend-common, 0x226AF0 frontend, 0x226E20 in-game): 0 font, 1 comn,
  2 fe, 3 ig, 5 drpo/drps, 6 drnm, 7 modl, 8 trpc, 9 trlg, 10 smnm, 11 spon, 12 crew, 13 smap, 14 vide (video),
  15 pltl, 16 plts, 17 fmvs, 18 text, 19 gene, 20 shop, 21 icon, 22 trop, 23 back, 24 awar, 25 cont, 26 anma, 27 race,
  28 spdl, 29 cars, 30 over, 31 logo, 32-35 cvd1-4. Screen groups (cache 0, nested in uis_all by group id):
  0 main, 1 sett, 2 pops, 3 ingm, 4 seas, 5 memc, 6 cold, 8 cac, 9 care, 13 ligh, 14 insi, 15 lice, 16 spd.
  Registration loop 0x76600 over 0x1C-byte records {id, ?, ?, name, flags, flags, nested}.
- State header: +0 ?, +4 active, +8 transform {pos, pivot, rot deg (X,Y,Z), scale, +0x30 ?, colour mul +0x34,
  colour add +0x44}, +0x60 loaded. Enter = 0x140350 (push matrix + colour), leave = 0x140420.
- Child group header: u32 visible. State 0 is the root; other states start inactive and are switched on by scripts
  (system event -2 = enter), so most screens need the script VM to look right.
- Element (type 0): flags (bit1 textured, bit2 cull back faces — not additive, see "EA coin" below, bit4 palette fx), u16 +2, s16 entry +4, s16 group +6,
  palette +8/+0xA, 4 x RGBA bytes +0x14, 4 x (s16 u,v)/256 +0x24, 4 x (s16 x,y,z)/16 +0x34; 0x60 bytes.
  Methods: 0 set vertex pos, 1 set uv, 2 set rgb (-1 = all), 3 set alpha, 4/5 set texture, 9 load, 11 loaded?
- Text (type 6): u16 flags (bits 0/1 align centre/right, 2 no kerning, 0x10/0x40 shadow, 0x100 boxed, 0x200 clip,
  0x1000 word wrap, 0x2000 char wrap), font entry +2 / group +3, s16 x,y,z +6, shadow dx,dy,? +0xC, line count +0xF,
  first line +0x10, box w,h +0x14, colour +0x18, shadow colour +0x1C, string record +0x20 (offset from object),
  line table +0x24. Layout 0x1407A0, draw 0x140BD0 -> font module 0x130000 (status module 0x11).
- FNTS font: "FNTS", u32, u16, u16 glyphCount, u32, u8 lineHeight @0x13, glyph table @[0x14] (12 bytes,
  sorted by char), kerning @[0x18] (u32 n, 8-byte {a, b, s8}), sheet header @[0x1C] {u32 fmt, u16 w, u16 h, 8 pad,
  4-bit alpha, low nibble first}. Missing glyphs use 0xB5. 6 fonts in uis_font.dat.
- Verified visually: the "Press START" title screen renders identical in layout to the game (art, centred shadowed
  text, copyright line).

### UI runtime in Node (uis-vm.mjs, uis-run.mjs) — screens now run their scripts
- Memory model: flat 32-bit regions; global screen at 0x10000000, screens at 0x20000000+, stack 0x60000000,
  null page at 0 (stubbed game functions return 0 pointers). Screens are relocated exactly like 0x139F70.
- Script entry (0x13B480): stack = [ret][extra?][args...][this = state header][0]; `ret` of 0 ends the script;
  the initial ret cell is the return value (tween step callbacks return a speed factor, default 1.0f).
- Calling convention used by compiled scripts: `dup` makes a result slot, args pushed, `call`; locals are `dup`'d
  cells; `load_sp -3` = this. State headers are 0x84 bytes apart and scripts address child state headers as
  this + n*0x84 (e.g. tween targets).
- Stack effects that matter: native_call drops 2 cells and reads fnId argc cells below (result in the cell under
  fnId); obj_call pops argc/type/method/objRef; strlen (0x49) pops and writes the cell below.
- Events (0x139B20): a state handles event E if (header+4 active and header+0x60 loaded) or E is one of
  -10 -9 -2 -3 -8 -4 -5 -11. Child states are listed as events {0xC000, -1, index}; after a child handles E and is
  active, the parent's child-specific handler {flags & 0x2FFF = child index, id = E} runs; then the state's own
  0x8000 handler. System events: -2 OnMoveForward (screen opened), -3 OnMoveBackward, -4 OnScreenActivate,
  -5 deactivate, -6 state activated, -7 state deactivated, -9 loaded, -10 frame tick, -14 tween finished.
- Opening a screen (0x13AF10 + 0x13B230): load objects (msg -1) through every nested state, state 0 active,
  event -9, event -2 (or -3) with the open arguments, then event -4.
- Statechart (0x13AC10 / 0x13BE60): enabling a state first disables its active sibling (states that are children
  of the same parent are exclusive), sets header+4, runs -6 / -7 and the parent's child handler.
- Drawing (0x1398C0) ignores the active flag: a state is drawn when header+0 is set, a child group when the word
  its header points at is set, objects once loaded; colour stack = mul header+0x3C, add header+0x4C.
- Frame (0x13AB30 + 0x139D40): pump message queue, event -10 to each screen, then the timer table: rate functions
  (op 6, keyed by (this, id), run every `period` ms with args (id, time, period)) and tweens (op 0x58: property id
  -> header field via 0x13B570, step = (target - now) / (duration / frame), optional per-step and completion
  callbacks, else the root's -14 handler).
- Message kinds: see the next section (all of 0-9 are now handled).
- Verified: all 196 screens open and run 1 s with no aborts (12,950 scripts, 16.9M instructions); the title
  screen shows the scripted "Press START button" with its pulse tween; main menu builds its 12 numbered rows.
  uis-vm-selftest.mjs checks this.
- Game API used by the UI: 94 functions (69 global ids via 0x7A6A0, 25 per-screen ids 0x8000xxxx via 0x78820);
  inventory with handler addresses and screens in ui_natives.json. These are the boundary the port implements.

### Game functions, screen stack and controller input (uis-natives.mjs) — the frontend boots and navigates
- Native dispatch: 0x7A6A0 first offers the id to the per-screen table 0x78820 (group table 0x790C4 -> screen
  tables; main menu 0/0 = 0x8E4E0, ids 0x80000000..0x80000016, audio/stream actions that return "handled";
  F_Main 0/5 = 0x8E240), then the global switch (index bytes 0x7B020 -> jump table 0x7AE9C; 18 ids share the exit
  0x7AE94 and leave 0). uis-natives.mjs implements the ids the frontend uses; unknown ids return 0 and are counted.
- Database-backed natives run the executable's own query strings through nascar-db.mjs (names byte-reversed,
  placeholders 0x80-0x8E): 0x00 GINF.NMPL, 0x58 GINF.NPLL, 0x02 DRVR.POID, 0x04 team name (CARS join TEAM),
  0x09/0x0A track via RACE.TRID, 0x5D RACE.RLID, 0x11 driver name in 4 styles fit to a width, 0x1E hometown
  "%s, %s" and birthday "%02d/%02d/%02d", 0x26 CSYS.ASAV. Checked: driver 76 -> "Ryan Newman".
- Other natives: 0x35 = length of the unlock-notice queue 0x2F2DA0 (push 0x158D0 / pop 0x15920; not a frame
  counter: a non-zero value opens the "You've unlocked N new Thunder Plates" popup 2/3); 0x40 =
  sprintf(a0, "%s%s%s", a1, "Press START", a2); 0x41 streaming idle; 0x48 = 1 in the retail build (menu skips a
  hidden row: index >= 2 -> index + 1); 0x0D text width via the font metrics; 0x10 random float in [a, b];
  0x2D/0xC1 option array 0x21DB78; audio setters store only.
- Message queue (0x13C7A0): re-entrancy guarded by manager flag bit 0; pumped at frame start, at the start of
  controller delivery, and inside event dispatch after the child states and before the state's own handler (so a
  child's state switch is visible to the parent's handler). Scripts that run inside a dispatch never pump.
- Kinds: 0 open, 1 close, 3/4 activate, 5/6 enable/disable state, 2/7 event broadcast, 8 = move screen b places in
  the stack (0x13BEB0), 9 = game notification (0x13C130 -> 0x13C080): to every screen, every state reachable by
  child links (active or not), handler flagged 0x4000 with that id. Op 0x76 stack: [id][a1..aN][argc].
- Controller (0x13A890, called by the pad loop ~0x75FE0 with ids from 0x75B50): message id = button (0 A, 2 up,
  3 down, 6 X help, 7 START, 9 B/back). Delivered to the focused screen and every screen below it in the stack,
  skipped where the screen's input mask (ops 0x4F/0x50/0x74; 0x75 tests "enabled") has the pad's bit. The one
  script argument is the button value as a float (1.0 = pressed); handlers test `arg == 1.0`.
- Verified (uis-vm-selftest.mjs): F_Main 0/5 with arg 101 builds screens 0/5 0/1 0/0 2/1 with no unimplemented
  natives; down, down highlights FEATURES; down, A opens RACE MODES (SpeedZone, Lightning Challenge, Thunder
  License, Season, Career); Season gives New / Load; A on RACE NOW reaches the Race Now screen 0/6.
- Open: the debug stamp "Milestone 1.04a" (text in root child group 2 of 0/0, group word authored as 1) is still
  drawn, so the retail build must hide it elsewhere; preview videos (uis_vide) not drawn.

### Screen manager, modal screens and the Race Now flow
- Screen records (0x14 bytes, list at mgr+0x3C, count +0x38): +0 input mask, +4/+6 group/screen, +8/+0xA the
  screen that opened it (`parent`), +0xC unloading, +0x10 data. Focus index mgr+0x30.
- Event delivery to "the focused screen" (0x13A9D0 / 0x13A890 with all = 0) covers the range [focus, focus + 1):
  only the focused screen, not the screens below it. With all = 1 it covers every screen. Kinds: 7 -> focused
  screen; 2 -> all screens (event -8 with a target); 9 -> all screens, all states.
- Activate (kind 3, 0x13B230): when no modal screen is open, -5 goes to the old focus; then state 0 of the new
  screen is set active, focus moves to it and it gets -4. Kind 4 only sends the -5.
- Open (kind 0, 0x13AF10) records the opener as parent; op 0x48 activates the parent (not the previous focus).
- Close (kind 1, 0x13A4C0): op 0x03 pops a result, then the id. The closing screen gets -3. Screens whose parent
  was the closed screen inherit its parent. If it was the focused screen, focus goes to its parent (else the top
  screen) through a posted activate.
- Modal focus stack (mgr+0x60 count, +0x64 entries of 0x28 bytes: +0x24/+0x26 the modal screen, +0x18 the caller,
  +0x1C/+0x20 a suspended script): op 0x51/0x70 open_screen_wait opens the screen, pushes an entry and suspends the
  calling script. Input goes to the top entry's screen. Closing that screen pops the entry, gives focus back to
  the caller and resumes the script with the close result in the cell the screen id used (0x13A3B0 -> 0x13CAB0).
  The VM saves and restores the script stack for this.
- F_Main 0/5 and F_QuickRace 0/6 are controller screens: they keep a mode in +0x70, react to notifications
  48/49 (args: screen code, result) and open, close or activate the visible screens. Race Now: main menu notifies
  48 [21, 1] -> F_Main closes 0/0 and itself and opens 0/6 -> 0/6 opens and activates the settings screen 0/13 ->
  A notifies 49 and 0/6 moves on to driver select 0/8.
- Race Now settings (per-screen handler 0x8C580, ids 1..10): the profile slot is 0x21DB74; 3 reads SGPP.DIFF,
  6 fills the summary for a difficulty (EDIF name, DIFF row -> ESKL name for AI, OFF/LIMITED/FULL aids,
  QUICK REPAIR/NORMAL/VISUAL ONLY damage, tires ON/OFF, yellow flags), 7 writes SGPP.DIFF, 9/10 write and read
  SGPP.SRLN as an index into 3/5/10/25/50/100 %.
- Native 0x0B is the number of connected, ready controllers (port table 0x2B700C); 0 makes the settings screen
  back out at once. Native 0x0D measures a string in UI font entry a1.
- Text objects: methods 12/13 give the x/y of a character index in the laid-out string (0x141030; advances
  without kerning, line height from the font). Method 20 returns the box width; for unboxed text the relayout
  0x1407A0 stores the widest line there (0x130800 measure, kerning unless flag 4). Screens use it to place value
  columns after their labels. Alignment bits confirmed in 0x1305B0: 1 = centre, 2 = right.
- Verified (uis-vm-selftest.mjs): A on RACE NOW shows the settings filled for EASY; right, right gives HARD with
  the summary changed (VETERAN, QUICK REPAIR, ...); A continues to driver select 0/8.

### Driver and track selection (uis-natives-carsel.mjs, uis-natives-tracksel.mjs) — Race Now runs to the end
- Unlocked cars per profile live in table ULDR (empty in the shipped database). The profile system start-up
  (0x146B0) resets it through 0x16840: every car whose CTYP is not 6, 8, 9 or -1 goes into the list of profiles
  0..3, then 0x15DD0 runs the unlock-card handlers (table 0x21DC14, card types 0..7; not ported yet). The port
  does the reset when ULDR is empty.
- Car select (handler 0x8DFE0, ids 1..21, screens 0/8 0/9 0/10): one SQL cursor per player over ULDR x CARS x DRVR
  with CTYP in (0,1,2,3,4), ordered by CSEL, CNUM, last and first name, plus a cursor over created cars (CCAR).
  Rows are read at random: the code sets the cursor row (cursor +4) and fetches. Classes: Cup (CTYP 1/2), 0, 3, 4,
  created; class counts per player drive left/right paging (id 14). A car belongs to a player through CARS.PLID
  (-2 = free; 0x11D30 also stores CRID/DCID in the profile row PPRE). Rows show "first last", the number (CNMD)
  and whether another player holds the car. Preview ids 6..11 and 16 load the 3D car (async load polled by id 9);
  the port marks it loaded at once. Created-car driver ids are CRID + [0x21FD0C].
- Track select (handler 0x8F4E0, ids 1..11, screen 0/3): a cursor over TRCK (TIPP = 1, FRSZ = 0, by TSOR) and per
  track a race cursor over RACE (RAID 61 excluded, by RSEL desc, RSOR); RSEL = 0 shows the race as locked. Picking
  writes PPRE.RAID and GINF.RAID/TRID. Details: city/state, track type text from enum table ETRT (0x5F150), length
  "%1.5f" trimmed + " Mile", banking, laps = RLAP x length % (race style ASTY 1: at least 25 % for 3/5/10 %, style
  2: at least 10 % for 3/5 %), day/night, record time (0x769F0 format) / holder.
- Query-name rule: names are stored reversed in the executable, so a query written by hand must reverse them too
  (table ETRT is written 'TRTE'; the CGPL table parameter is passed as 'LPGC').
- When the user picks a track, F_QuickRace closes every screen; the frontend has then handed the race to the game
  (GINF race/track, each player's car via PLID). uis-run.mjs and main.mjs print that setup. Native 0x4D is the
  frontend's start/stop of a background system (0xEA8A0 / 0xEA800), not the race start.
- Verified: Race Now -> Tony Stewart preselected from the profile -> down picks Ricky Rudd #21 -> Talladega,
  EA SPORTS 500 -> frontend closes with that race and car. Down on the track list shows Texas, Samsung/RadioShack
  500, 10 laps at 3 %.
### Limits seen here
- UI layout is authored for an 854x480 space (4:3 crops to x 107..747); native API has 248 fixed ids plus per-screen handlers
  for groups 0..16 x screens 0..15. Lists in screens (drivers, cars, tracks) are fed by native calls, so their sizes are
  decided by game code and the DB, but visible rows are fixed by each screen's authored elements.
- Race length choices are hard-coded in the exe as 3/5/10/25/50/100 % (0x8C240 / 0x8C500 switch tables); difficulty
  levels and what they set (AI skill, aids, damage, tires, yellows) come from the DB tables EDIF, DIFF and ESKL, so
  those are data-driven. Controller ports: 4 (table 0x2B700C). Modal screen stack capacity: manager +0x5C (not yet read;
  8 assumed). Race Now summary has 5 fixed rows in screen 0/13.
- Players: 4 everywhere in car select (per-player cursors, ULDR filled for profiles 0..3, readiness array of 4).
  Car classes are 5 fixed buckets keyed to CTYP values 0..4 (+ created cars); CTYP 6, 8, 9 never reach the list.
  The car list itself is DB-sized (ULDR join), shown 5 rows at a time. Tracks: any TRCK row with TIPP = 1 and
  FRSZ = 0 is listed (DB-driven); race 61 is hard-coded out; default track TPHD 13 / race 18 when the profile's race
  is not listed.

### The game's own code in the frontend (x86emu.mjs, gamecode.mjs)
- Native handlers no longer need a JS port to work: x86emu.mjs interprets the executable's code (integer, x87,
  string ops, the 0F group) and gamecode.mjs maps default.exe flat at 0x10000 into the VM's memory, so pointers
  from scripts are valid for it. Heap 0x40000000 (bump allocator for 0x110640), x86 stack below 0x70100000,
  scratch 0x70200000, fs 0x7F000000, kernel stand-ins 0x7FF00000, UI managers 0x7E000000 + ctx * 0x100.
- Entry points: per-screen handler 0x78820 (cx group, ax screen, edx result*, stack id, 0, args*); global natives
  through the switch of 0x7A6A0 (jump 0x7AE9C[0x7B020[id]], frame built as the switch leaves it). A screen with a
  JS map in uis-natives.mjs (Race Now 0/13, car select 0/8-0/10, track select 0/3) still runs the JS port.
- Hooks at the boundary: C runtime (ftol 0x1803A8, cookie 0x18035A, _chkstk 0x180100, sprintf 0x170C90, atexit
  0x17F8E2 / _onexit 0x17F8AA), allocation, the DB query bridge 0x1471D0 (placeholders 0x80-0x8E; into-params are
  pointers; doubles take 8 bytes; cursor param = the game's cursor struct, row at +4; table-name param 0x8C is a
  4-char int passed reversed; returns 0, 0x17 no row, 0x15 cursor end), cursor close 0x144B80, the UI manager API
  (open 0x13B1B0, close 0x13A790, activate 0x13A7F0, notify 0x13C1C0, focus ids 0x13A840, text width 0x1425A0),
  stubs for models/textures/3D preview/movies. Callee-pop sizes for stubs: x86_callee_pops.json. Errors carry a
  shadow call stack.
- Startup like the entry point: the 191 C++ static initializers (table 0x204F94..0x205290) run, then the game
  process manager 0x2F3990 is created (0x174F60). That manager is the game's top-level structure: 11 processes,
  each a hierarchical state machine (state tables from vtable +0xC/+0x10, enter/exit chains 0x175100/0x175150,
  requests 0x175030(slot, state) queued and applied by the tick 0x175370, start 0x1752C0(slot, state), stop
  0x175320, state 0x175020, running 0x175010). (These five were wrongly labelled "audio stream" stubs before.)
  | slot | vtable | role |
  |---|---|---|
  | 0 | 0x1F94F0 | system / graphics (enter = D3D set-up; not run) |
  | 1 | 0x1F9668 | "Interface_Group": the game flow. States 4 BrandingMovie, 5 MainLoading, 6 Frontend, 14 LoadingFrontend, 15 LoadingDemoToFE, 7 LoadingIngame, 8 LoadingDemo, 9 RaceWeekend, 10 In-game, 11 Pause, 12 EndRace, 13 Demo, 16-18 Simulator; allowed transitions table 0x1D7BB8; per-state resource groups via vtable +0x14 (not run yet) |
  | 5 | 0x1F9538 | database process: enter reloads nascar.db into the engine (0xA08A0), loads gmodedb.dat parts (0x5F4D0), copies TSCD -> TSCC |
  | 6 | 0x1F9514 | memory unit: update 0x104470, states 0x4C..0x7F (device scan, list, load, save, delete) |
  | 2-4, 7-10 | ... | started by frontend screens (0x8E3C0.. starts 4, 5, 7, 8, 10) |
  The main loop starts 0 and 1; here neither runs (the UI VM is the frontend). Processes the UI starts itself
  run and are ticked once per UI frame (vm.onFrame).
- File module 0x128000-0x129800 (file table 0x271D10, async requests served by worker threads) is replaced at its
  API by host files in the Data folder: open 0x129070(name, device), close 0x129130, seek 0x129160, exists
  0x129210, read 0x129260, size 0x129540, tell 0x129560. Other entry points are reported if reached.
- Database engine: loading a database (0x147780(db, source, mode, file ops); ops[0] open, ops[1] close, ops[2]
  read) reads the bytes through the given ops and replaces the JS database's tables of the same names. 0x5F4D0
  (a part of gmodedb.dat through the resource module) reads the TERF part directly. Engine setup calls are no-ops.
- Memory-unit library 0x110000-0x114100: an operation sets status 0x22E840 = -1 and queues a job 0x110DF0(proc,
  param) for a worker thread (event 0x22EC60); the proc sets status 1; 0x114060 polls. Jobs run at once here.
  Their file work is XAPI -> kernel Nt* calls, served by xbox-fs.mjs: \Device\CdRom0 = disc folder,
  \Device\Harddisk0\Partition1 = <save folder>\E (UDATA\45410031 = saved games; title id 0x45410031 from the XBE
  certificate), drive letters through IoCreateSymbolicLink or defaults (D, T, U, Z). Save folder: "save" next to
  default.exe (uis-run option saveDir / env NT04_SAVE).
- UI contexts: the game has one UIStudio manager per context (table 0x2B7C38, 32-byte entries; 0 frontend, 6
  memory-unit/profile dialogs, ...). Notifications (kind 9) and broadcasts (kind 2) stay inside a context: the
  memory-unit screens post 48/49 (accept/cancel) to their own context, and F_Main 0/5 has unrelated 48/49
  handlers for the frontend context (closing/reopening menus by its mode at +0x70). Screens now carry ctx; focus
  is still one global focus (input to context 0 is locked by native 0xE9 while the dialogs are up).
- Help: X is handled by the input loop, not by scripts (0x75F89): on press (value 1.0), in contexts 0/1/6/8, with
  help allowed (0x2B7934, set by frontend init 0x75960) and the focused screen's state 0 active, the screen's first
  string-table object (0x13AB90) goes to 0x2B7930, 2/0 opens with the controller as argument and is activated, and
  0x2B7935 is set; while set, only message 8 reaches screens. The help screen clears 0x2B7934 while it is up and
  closes on the X release (value 0.0) from the same controller. So help is "hold X".
- Pad message ids, corrected: 0 A, 2/3 up/down, 4/5 left/right, 6 B (back), 7 START, 8 X (help), 9 Y (profile),
  10/11 the black/white buttons (11 = Quick Save on the help bar).
- Verified: Career > Load > hard disk lists 8 empty slots ("50,000+ blocks", status valid) from an empty save
  folder; B, B returns to Race Modes with Career highlighted. Career > New runs settings -> startup ->
  Create-A-Car through game code. Holding X on the main menu shows "Main Menu Help".

### Saving (quick save) — the whole chain runs on the game's code
- Message 11 (the help bar's Quick Save button) is broadcast by the input loop to every screen of the focused
  context (0x7607F, 13A890 with the "all screens" flag), unless the busy counter 0x2F3424 is up (0xE6720).
  Message 10 goes the same way to context 8. Everything else goes to the focused screen.
- Process names (state tables via vtable +0xC, names inline): 0 Main Group (Main Stage, Full Init Stage), 1
  Interface_Group, 2 Race_Group (race weekend, race, QC/caution states, victory lane, replay, pause...), 3
  Quick_Race_Group, 4 Season Group (0x3F init, 0x40 setup, 0x41 management, 0x42 post-season, 0x43/0x44 race),
  5 Career Group (0x45..0x4B; enter of 0x45 activates the career save slot), 6 Memory Card Group (0x4C idle,
  0x4D scan, 0x50-0x55 load, 0x56 overwrite, 0x58-0x67 save: create dir, change dir, open, write, flush, close,
  icon; 0x69/0x6D delete, 0x6E-0x73 file list, 0x74-0x7F probe/mount/free space), 7 Lightning, 8 License,
  9 Victory Lane, 10 SpeedZone.
- Save slots: table 0x21F2C8 of 0x48-byte records {.., type at +8, index at +0xC, active at +0x10, name at
  +0x18}, end type 5: system settings (type 0), four profiles (type 4), season/career slots further on. Quick save
  lists the active ones ("Changed only"/all).
- What goes into a save: table STAB (game name 'BATS': TNAM table, UFIL save type, ICRC) lists the tables per
  save type; 0x5E400 sets their save flags, then 0x1477D0 writes those tables as a DB image through file ops
  (first through counting ops 0x21F2A8 for the size, then into the buffer). nascar-db.mjs writeDb() builds the
  image from the JS database (plain string pool, no index blocks); round trip verified on all 261 tables.
- Save file: XCreateSaveGame (XAPI, statically linked) makes U:\<id>\ with SaveMeta.xbx ("Name=..." UTF-16);
  the data file (named after the save) is written with the C runtime's fopen/fwrite: a 32-byte name ("Settings"),
  a type byte, the DB image, then a 20-byte signature (XCalculateSignature over the data; XcSHA*/XcHMAC are
  stand-ins, so signatures are not real ones). saveimage.xbx is the icon from icons.dat (resource module).
- What it needed: the XBE header at 0x10000 (certificate at [0x10118]: title id 0x45410031, signature keys),
  the CRT/XAPI initializers (0x10AEF9: thread data, stdio table; 0x10AEA1: FPU, C and C++ initializers), the
  XAPI heap (RtlAllocateHeap 0x10CE9A / RtlFreeHeap 0x10D615 / RtlSizeHeap 0x10C4F8 / RtlReAllocateHeap
  0x10D809), the game heaps (0x10FF20 alloc(heap, size, tag), 0x110100 free), CRT _lock/_unlock (0x185B67,
  0x185AB5) as no-ops, KeTickCount advancing with the UI clock (GetTickCount 0x107069; the "Please wait" box stays
  at least 2.7 s, natives 0x45/0x4C), the resource module on terf.mjs, and native 0x2E (0x79A90: message texts)
  running in game code. Result: Main menu > Quick Save > hard disk > New... > "Save successful." > OK writes
  save\E\UDATA\45410031\000000200031\{SaveMeta.xbx, " 1", saveimage.xbx} and returns to the menu.
- The save is named " 1" because the profile has no name yet (the profile screen shows "New Driver"; the save name
  comes from the slot record, filled when a profile is named/saved).
- Loading works: Season New (Ricky Rudd) -> quick save "All" -> season row -> a fresh run -> Race Modes > Season >
  Load > hard disk lists "Season 1-Season1, 15 blocks, date/time" -> A -> "Load successful." -> Season main menu,
  and the player's car (CARS.PLID 0) is #21 Ricky Rudd again (self-test "season save/load round trip").
- Save names and types: a save's name is the save type's EUFL text + number ("Season 1", "System Settings 1"); the
  data file header is the EUFL short name + number ("Season1", 13 bytes) + a 20-byte signature of it. The load
  list parses the name back to (type, number) (0x105560) and marks a save damaged unless the header signature
  matches and the save's size in 16 KB blocks equals ceil((DB image size of the type + 0xC000) / 16 KB) (0x105630).
  The size comes from XFindFirstSaveGame, which sums the save directory's files (NtQueryDirectoryFile).
- Fixes this needed: enum texts 0x5F150 (EDIS of the enum row with that EVAL; uses the engine's structured query
  0x148210, so it is done in JS; used 48 times, e.g. save type names, track types), real SHA-1/HMAC for XcSHA*/
  XcHMAC (node:crypto; keys are stand-ins, so only our own saves verify), RtlTimeToTimeFields/RtlTimeFieldsToTime,
  FILE_DIRECTORY_INFORMATION with EndOfFile at +0x28 and AllocationSize at +0x30, RestartScan as a BOOLEAN (low byte
  only), and reading a DB image through file ops by its header size (memory readers fail on over-reads).
- Career works end to end too: New -> Career Settings -> Career Startup (four steps; 0x7C060 checks them: a car with
  CARS.PLID 0, every sponsor location of SSTA except STYP 5 signed (CSCS 1), the crew (count of CCRW)) ->
  Create-A-Car (template -> Driver/Car/Colors tabs, on-screen keyboard -> B -> keep changes) -> Sign Team (Y quick
  sign) -> Sign Sponsors (five locations) -> Done -> Career main menu (process 5 in 0x47). Quick save "All" ->
  Career -> keyboard (name "Career1") -> "Career 1" (17 blocks); a fresh run's Career > Load brings it back
  (self-test "career setup, save and load").
- Game modules: per process state the manager loads a list of module objects (refcount +8, Load/Unload in the
  vtable, dependencies; 0x175100 / 0x175150). The Interface Frontend state (6) list is 0x1D7D00: CarResource,
  MemoryCard, User Profiles, User Files, (graphics), Speech, Sound, Music, EASportsBIO, UIStudio, UISCommon,
  UISDebug, UISMemoryCard, UISChat, (?), CarResource, UISEATrax, UISFrontEnd, UISFlagObj, UISCarObj,
  UISController, USB Keyboard, Oscilloscope, FileCacheProcess (lists of the other states: MainLoading adds
  QuickloadFrontend, in-game states UISGauges/UISInGame...). At startup the port loads the game-state ones
  (CarResource, MemoryCard, User Profiles, User Files, EASportsBIO, UISMemoryCard, UISCarObj, UISFlagObj); UI
  system, audio and graphics modules stay unloaded. UISCarObj's Load (0xA1110) is cut down to the created-car id
  range (0x6C810: first CARS row with CSEL 255 -> 0x21FD0C = 187); without it Create-A-Car wrote nowhere.
- 0x6D2B0 / 0x6D290 select the car tables (CARS/'SCCA' vs created, CPAL/SPAL) — wrongly stubbed before as "car
  models: reset", which left the table-name parameter of the car-part queries empty.
- The UI listener (0x751E0, part of the Interface Frontend update) runs every frame: it shows the "Please Wait"
  boxes of blocking/async UI tasks (minimum display time) and notifies 88/89/90 to the listener screen 2/9.
- Game clock 0x10ED50: a timer object (0x22E320, from the timer system 0x10F010 at system start-up) read in 1/60 s.
  It was 0 here, so every "wait at least N ticks" (UI listener boxes, EA SPORTS Bio's task steps) waited forever;
  it now follows the UI clock.
- Threads: xbox-threads.mjs runs the game's threads cooperatively on the one CPU (own context, stack and fs block
  each; X86.saveCtx/loadCtx/runSlice). Dispatcher objects are DISPATCHER_HEADERs in memory (+0 type, +4 signal
  state), shared by handle calls (NtCreateEvent/NtSetEvent/NtPulseEvent, semaphores, mutants) and pointer calls
  (KeSetEvent, KeWaitForSingleObject/MultipleObjects). A thread runs each frame until it waits on an unsignalled
  object (it yields; the wait completes later with the right status or STATUS_TIMEOUT), sleeps
  (KeDelayExecutionThread), ends (return or PsTerminateSystemThread) or uses its step budget. When the main
  context waits, the threads run until the object is signalled (bounded, so the UI never deadlocks). So far the
  one thread created is the memory-unit worker (XAPI thread start 0x1081DD -> 0x111190, waiting on 0x22EC60);
  memory-unit jobs still run directly when queued.
- EA SPORTS Bio now runs its check to the end: it mounts the shared EA title data (TDATA\4541FFFF as W:, an
  alternate title through IoCreateSymbolicLink), looks for the Bio file "EASB", finds none on a fresh save
  folder (task result 1) and the screen transitions off back to My NASCAR. A Bio file is written from the Bio
  screen's Save option or by gameplay; profile saves do not create it.
- Save slot records hold a "changed" check: +0xD = (CRC of the slot's tables == CRC at +0x14), so a fresh season
  shows "No" under Changed and appears only with "All". Slot types: 0 settings, 1 season, 2 career, 3 created cars
  (16), 4 profiles (4); the game modules' Load methods activate them (Season module 0xA0D60, Career 0xA0C30,
  Create-A-Car 0x8403D).

### Game flow boot and the race handoff (uis-run "flow", NT04_NO_JS_SCREENS=1)
- Boot: GameCode.startInterface() starts process 1 (Interface) at state 5 (MainLoading); its Update requests 6
  and OnStateChanged 0x9DFB0 opens 0/5 (1, 2) = title screen. START -> autosave prompt -> main menu, all game code.
- Race Now with the game's own screens (no JS per-screen ports): driver select 0/8 asks native 0x80000009 ->
  0x8DB60 "model ready" = [0x2B9094 + slot*24] != -1. The slot is filled by the model-load callback: 0x8D9D0
  calls 0x6C5D0(car, 1, done = [0x22012C + slot*4]) with ebx = model class; 0x6C5D0 refcounts the entry in
  [0x2B714C + class*12] (+car*0x1C: +0 refs, +4 handle, +8 loading flag), loads through the resource module
  (0x1191B0 / 0x11A490, completion 0x6C740) and calls done(class name, car, handle, 0); done (e.g. 0x8DA60)
  stores the car id at 0x2B9094 and the handle at 0x2B9098. gamecode.mjs now answers 0x6C5D0 with a fake handle
  (0x7Cccnnnn) and calls done at once.
- With that, driver select -> track select -> A closes the frontend and the game requests Interface state 7
  (LoadingIngame); process 3 (Quick Race) is at 0x3D and process 2 (Race) at 0x13. The in-game module list then
  loads ~35 race modules (gauges, cameras, particles, collision, AI speeds, race manager, pit manager...); in
  emulation they fail (SSE/MMX opcodes 0F AE / 0F 6F, uninitialised render/resource state) and are counted as
  loaded. The race itself (3D engine, physics, AI) is the next layer and is not running.

### Simulated races (Interface states 16-18) — run entirely on the game's code
- Season hub 4/6: A on Race Weekend calls native 0x80000008 (0x7BBA0 sets the script's flag) and the menu turns
  into Race / Simulate in place. Simulate calls native 0x80000002 -> 0x95700: 0xB0C40, then Interface request 16.
  Career: the Build Car screen 9/13 has Race / Simulate as its last two items (same mechanism).
  Group 4 natives dispatch: 0x78820 group 4 screen 6 -> 0x957F0 (ids 0x80000001-0x8000000C, table 0x958A8).
- Interface Update (switch 0x9DF6C, states 4..18): 16 sets 0x2F3290 = 1 (0xAFB40) and requests 17; OnStateChanged
  16 -> 17 starts process 2 (Race) at state 0x33 = the race simulator; 18 clears 0x2F3290 (0xAFB50) and requests 6.
  Also seen: 4 -> 5, 5 -> (process 0 state 1, 0x2B90FC = 1) 6, 7 -> 9 (0x76720(0)), 8 -> 13, 14 -> 6 (0xB0D90), 15 -> 6.
  Interface message 0x47/0x4B (0x9DCC5) is a second way into 16 (0x6D2B0 car tables, 0x3C6D0, request 16).
- The whole thing runs in about four frames: 16 -> 17 (p2 = 0x33) -> 18 -> 6, then the game opens Post Race Stats
  (4/8 season, 9/17 career). Tables written: DRRS (one row per car: start/finish position, laps, laps led, speed,
  earnings, points), DRST (driver stats rows, +43), RSTT (race summary: lead changes, cautions), QUAL, APRP,
  AWTD/AWKY/AYRY (awards), CARS/DRVR/DCAR/DDRV updates; GINF.RORD moves to the next race. Laps follow the race
  length setting (6 laps at Daytona, 9 at Atlanta on the default season length).
- main.mjs now boots the game flow by default (--boot flow; menu/title open a screen directly and have no game
  flow, so Simulate does nothing there).

### Configuration overlay (nt04-config.mjs) — what is data, what is code
- nt04.config.json next to the Data folder (or NT04_CONFIG / uis-run option config) is applied to the database at
  start and again whenever the game reloads NASCAR.DB (0x147780 with source "nascar.db"); not to save images.
  Options: schedules (SCID -> RAIDs), races / drivers / cars / teams / tracks (field updates by key), tables
  (generic add / set / delete), capacity (table row limits), seasonRaces, fieldSize. Example:
  nt04.config.example.json. Verified with simulated races:
  - Season length is data. Schedules: SCHD (RAID, SCID, RORD); SCID 0 = 15 entries (12 points races + Shootout 62,
    All-Star Open 61, All-Star 60), 1 = 27, 2 = 39 (full), 3 = rebuilt by the game from the chosen one at season
    start (delete + insert). GINF.NRAC = entries in the season's schedule. A 46-entry schedule ran end to end
    (hub "Race: 41/45", season rolls over to 2004 with "New Season").
  - The 39-race ceiling is only table capacities, sized for 39 schedule entries: DRRS 1677 = 39 x 43 cars,
    SCMD 39, AWKY 234 = 6 x 39, RSTT 40, QUAL 50; and SCHD's total. The original engine refuses inserts past a
    table's capacity ("table X is full"); the JS engine keeps that rule, so the overlay raises them.
  - RACE has 78 races (RAID <= 79), including ~30 not in any schedule (fantasy tracks 36-59, 63, 70-72, 79 and
    Speedzone 64-78); they simulate fine in a season. Per-race AI tables (AIFW/AITW/AIWS/PTRF) are 80 rows by RAID.
  - Drivers and cars are data: a new DRVR + CARS row (CTYP 1, CCRC 1, PLID -2) races and scores. The field is
    filled per race by 0x139B0: CTYP 1 cars, then 2, 3... each ordered by DRVR.DPOP desc, until the field size
    (cursor 0x1D4475; PLID = grid slot). SODD/SODR are not used by the season simulator.
  - Field size: byte table 0x21DB28 indexed by human players (1P 44, 2P 20, 3-4P 10; 0x28A550 = GINF.NMPL); field
    = value - 1 (43). Lowering works (24 and 29 tested); 45+ cars overflow fixed per-car arrays in the race code
    (memory corruption, crashes in the process tick), so 43 is a code limit until those arrays are found and moved.
  - Car numbers on the results list are images by car, not CNMD/CNUM/NSID text (changing them did not change the
    picture). Driver names are plain data (DRVR FNAM/LNAM show up everywhere).

### Qualifying with more entrants than starters (qualifying.mjs, config "qualifying")
- How the game builds a race grid (season simulator path, 0x128F0): 0x139B0 fills the field from CARS (CCRC 1, a
  driver; types from table 0x21DB3C = {type, % chance}: 0 (only while Quick Race process 3 runs), 1, 2, 3, 4 at
  100%; each type by DRVR.DPOP desc; duplicate people/cars from other series are paired in DDRV (DRID<->DDRD) and
  DCAR (CRID<->DCRD), the twin gets SELC 1 and is skipped). Field cars get PLID -1, others -2, humans >= 0.
  Then 0xB1D20 (human qualifying; called from 0x89414 and 0xB8C9F) clears QUAL and inserts the humans' times:
  b1630(position) interpolates between QUAL rows (b1510: LAPT x 0.001 s) or uses the track's base lap time
  [0x2DD4DC] (set by track physics, 0 here) + (rand(41)+10) x 0.01. 0x4D6A0 then gives each car (records at
  0x2951E0, 0x5C0 bytes each, 43 of them; overflowing them is what crashes fields > 43) its driver's rank in QUAL
  ordered by LAPT (0x4B0F0), or the next counter value when the driver is not in QUAL. So QUAL seeds the grid.
  QUAL's capacity is 50: the database was laid out for up to 50 qualifiers.
- The extension: before 0x139B0, N entrants (the game's own fill order, one car per person, or an entry list) get
  lap times: base = QGEN.PTIM (pole time for the track's TPHD), spread = QGEN.SPRD, score = 0.7 x DSKL (driver
  skill for the track type TRCK.TTYP: 0 short, 1 speedway, 2 superspeedway, 3 road) + 0.3 x DRVR.DSPD, time =
  base + spread x ((100 - score) / 40 + 0.15 x gaussian). The fastest fill the field (humans are guaranteed a
  place, marked provisional when slower, unless playerMustQualify); CCRC is cleared on every other car for the
  fill call and restored after; after 0xB1D20, QUAL holds the starters' times (ms) so the grid is the qualifying
  order. The race itself still has 43 cars.
- Verified: 55 and 70 entrants for 43 places over three straight season races (43 results each, 12 / 27 DNQ,
  grid = qualifying order); 30 entrants for a 24-car field in the self-test. Exhibition races (All-Star Open)
  take another field path (0x12A19 etc.) and are not affected.
- Results: game.qualifying / game.state.qualifying, a text sheet appended to <save folder>/qualifying.log, and
  main.mjs serves the latest at http://localhost:8854/qualifying. There is no in-game screen for them yet.

### Toward a real race: CPU coverage, memory, data files (first pass)
- MMX/SSE (x86-simd.mjs, test x86-simd-selftest.mjs): the Pentium III set the code uses — .text has ~600 SSE and
  ~250 MMX instructions, the D3D/XGRPH/DSOUND/WMADEC/XPP sections more (movaps/movups, shufps, mulps/addps,
  unpck*, movlhps/movhlps, cmpps, movmskps, rcpps, movss/addss.., cvtss2si/cvtps2pi, comiss, movntps/movntq,
  movq/movd, punpck*/pack*, saturating adds, shifts, pmaddwd, pmullw/pmulhw, pshufw/pextrw, sfence, ldmxcsr);
  no SSE2. Also wbinvd/invd (texture code flushes caches before GPU use) and xlat. After this no race module
  fails on an unknown instruction; the remaining "unknown opcodes" are jumps through null pointers.
- Memory: one 256 MB heap with a real allocator (size headers, free lists; frees from 0x110660, 0x110100 and the
  XAPI heap are honoured; NT04_NO_FREE=1 turns reuse off for debugging). Allocator kinds (0x11CA40, from the
  system init 0x144F0 that main 0x14400 runs before the process manager) are now registered at startup: without
  them pool allocations jump through the null table at 0x2F8D00. Step limit for one game call raised to 60M
  (NT04_STEP_LIMIT).
- The race needs the big archives: LOADDATA, CARDATA, CARPARTS, CARRESFE, CHARDAT, TK_PHYS, TK_REND, TK_PBNR,
  TK_SKY, TK_SHAD, TK_SCORE, TMAPDAT, AI_SPDS, EFFECT, SIMPOBJ, GAME.QKL (~500 MB). Without them every track/car
  resource open fails ("not found") and modules crash on null data.
- The game's own resource module (0x118000-0x11C000) initialises and opens archives once the allocator kinds
  exist (NT04_GAME_RES=1 runs it instead of the JS one); the JS version stays the default for now.
- main 0x14400: system init 0x144F0 (0xEB300, allocator kinds 0x11CA40, heaps 0x110A90(0), 0xEB3D0, 0x10F010,
  0x1551D0(0x200, 0x100), 0x10FEB0(1), 0xEB400), 0x14BB0, 0x127CE0(1) (a flag at 0x271AA8), process manager
  init, start processes 0 and 1, tick until 0x2F2D70, stop all, shutdown 0x14550.
- Where the race stops now (15 modules fail, all in set-up): texture and model registration (0x134930 ->
  0x155910/0x155610, 0x132BD0) works on Direct3D resources — the D3D device is created by the Glib/GlibRender
  modules, which are not loaded (no GPU) — so texture descriptors are empty (an endless log2 loop on a zero
  width at 0x143EF0, writes through 0xCCCCCCCC). Track set-up (module 0x2F3DE4) loops in 0xD6xxx on the same
  missing data. The next layer is graphics: let Glib create its device on an emulated GPU (NV2A push buffer)
  or replace the D3D calls.

### How the game draws — the graphics boundary (d3d-hle.mjs, renderer.mjs, xbe_symbols.json)
- Libraries (XBE library table): XAPILIB, D3D8, D3DX8, XGRAPHC, DSOUND, XBOXKRNL, LIBCMT, all XDK 1.0.5455.
  XbSymbolDatabase (MIT, Cxbx-Reloaded project; built from github, CLI run on default.xbe) identifies 286
  library functions and globals by signature: xbe_symbols.json (name -> address, calling convention, params).
- The game calls 104 D3D entry points (101 identified; the other three: 0x199D20 returns 1, 0x199E20 =
  XPhysicalFree wrapper, 0x18E580 = a CreateCubeTexture2/CreateVolumeTexture2-style creator). It never touches
  the device structure (D3D_g_pDevice 0x19D008) or the push buffer itself; it does write D3D's deferred state
  arrays inline (texture stage states D3D_g_DeferredTextureState 0x19CB70 with dirty flags 0x19CB68, render
  states D3D_g_RenderState 0x19CD70). Used: device (CreateDevice, Release, SetPushBufferSize), render targets
  (GetBackBuffer2, GetDepthStencilSurface2, GetRenderTarget2, SetRenderTarget), Clear, Swap, vertical blank
  (BlockUntilVerticalBlank, SetVerticalBlankCallback), fences, visibility tests, viewport/transform/scissors,
  ~30 SetRenderState_* + SetRenderState_Simple (NV2A method, value), SetTextureState_* (4), vertex shaders
  (Create/Delete/Load/Select/Set, constants 1/1Fast/4/NotInline/NotInlineFast, SetShaderConstantMode), pixel
  shaders (Create/Delete/Set, constants), SetStreamSource, SetTexture, SwitchTexture, SetPalette, DrawVertices,
  DrawIndexedVertices, DrawVerticesUP, DrawIndexedVerticesUP, Begin/SetVertexData2f/4f/4ub/End, resources
  (CreateTexture2, CreateVertexBuffer2, CreatePalette2, Register, Release, Lock2s, LockRect, GetDesc,
  GetSurfaceLevel2), D3D_AllocContiguousMemory.
- d3d-hle.mjs replaces the GPU-facing ones (device, targets, clear/swap, states, shaders, streams, textures,
  draws) and lets the resource bookkeeping run as is, with D3D's GPU waits (0x192040 BlockOnResource, 0x1920C0,
  0x191D00 BlockOnTime, 0x191FC0/0x191E40 push buffer space) as no-ops. Resource Data holds physical addresses
  (virtual = | 0x80000000): the heap is mirrored at 0xC0000000, MmGetPhysicalAddress strips bit 31. Draws
  become commands { kind, prim, count, ..., state } for a renderer (renderer.mjs: NullRenderer now, WebGL next).
  The vertical-blank callback (Glib 0x127CB0 stores D3DVBLANKDATA.VBlank in 0x271AD4) is called on each
  BlockUntilVerticalBlank / Swap with a running count; the in-game frame 0xEBDF0 waits for 2 vblanks per frame.
- The graphics library ("Glib", EA): init 0x128070 -> 0x127DD0 fills the present parameters (640x480 at
  0x2F8EE0), SetPushBufferSize, Direct3D_CreateDevice, SetVerticalBlankCallback; present 0x127FC0 = Swap and
  the vblank delta in 0x20614C. 0x128010-0x1280B0 were wrongly stubbed as "file module" before (they are Glib's).
  Glib is in the Interface's Branding (4) module list, so the flow now starts processes 0 and 1 in their
  default states like main does (Interface 4 -> 5 -> 6).
- 0x155910 is the MMAP/CMMP texture-archive relocation (offsets -> pointers, once; flag bit 0 at +6), not a
  release: stubbing it left every in-game texture block unrelocated. CARDATA.DAT's TERF has an HSH1 chunk.
- With these, the race path reaches Race Weekend (Interface 9) with the game drawing through d3d-hle (first
  frames: textured triangle strips). Remaining: audio (DSOUND touches the APU at 0xFE800000; FakeDoppler and
  module 0x2F4124 allocate through an allocator kind the sound init registers), track set-up 0x2F3DE4 (loops
  in 0xD6xxx), XGRAPHC swizzle on an unregistered texture (Loading Ingame, 0x19FA81), a game thread at 0xEC870.

### Sound boundary and the first in-game scene (dsound-hle.mjs)
- The game's sound layer (EA's, ~0x157000-0x160000; init 0x15C700 creates the device, downloads the DSP effects
  image 0x1CD8C8 (0x3360 bytes), allocates voices and starts an audio thread 0x15C3F0) calls 26 DirectSound C
  entry points (all identified), and drives streams through their XMediaObject vtable. dsound-hle.mjs replaces
  them: buffers play in game time (+ CPU time inside long calls, ~733k instructions per ms, so loading code that
  waits for a sound to end sees it end), stream packets complete in DirectSoundDoWork (status 0, the stream
  callback called). Backend interface for Web Audio later: createBuffer, play, stop, setVolume, packet. The
  Sound/Music/Speech modules now load (NT04_NO_SOUND=1 skips them).
- Memory layout matters to D3D: it keeps physical addresses masked to 28 bits. The heap moved to 0x01000000
  (224 MB, below 0x10000000 like Xbox RAM), mirrored at 0x81000000. With the heap at 0x40000000 every palette and
  some textures/vertex buffers pointed at 0x82xxxxxx garbage. Thread stacks moved to 0x62000000 (they overlapped
  the UI VM's stack at 0x60000000).
- Result: every race module loads except Peripheral (controllers) and two that wait on async loads; the Race
  Weekend scene (Interface 9) draws ~1,030 draw calls / ~135,000 primitives per frame through d3d-hle (indexed
  triangle strips, 19 textures, 8 vertex shaders), at ~2 frames per second in the interpreter.
- Still missing: asynchronous resource loads. 0x11A670(archive, entry, ..., callback 0x2FCE0, context) and its
  friends are stubs in the JS resource module; the game queues jobs in 0x28A4BC (16 bytes per slot) and
  0x110D0 waits for a slot while pumping 0xCBFC0 — "Pre Race" and module 0x2F41D4 wait forever. Next: complete
  async loads (load at once, call the callback) or run the game's own resource module (NT04_GAME_RES=1).
- Interpreter speed: ~6M x86 instructions per second (simple loop benchmark); the Xbox CPU runs ~733M. Real-time
  racing needs a faster CPU core (decoded-instruction cache, then translating the game's code to JavaScript or
  WebAssembly ahead of time).

### Into the race: async loads, preemption, sound data (Interface 10 reached)
- Async resource read 0x11A670(archive, entry, prio, buf, kind, callback, ctx) is done at once in the JS resource
  module: data copied (to buf, or a new block recorded in the archive's pointer/flag tables), then
  callback(archive, entry, data, status, ctx). Already-resident entries report status 0xF0007.
- Some waits need other threads to run while the main context spins (loading screen: thread 0xEC800 updates the
  progress word 0x2B7878 that main loop 0x73660 waits for). The interpreter now has a tick: every 2M instructions
  the thread scheduler runs other threads for a slice, every 12.2M instructions (~1/60 s of a 733 MHz CPU) a
  vertical blank is raised (D3D VBlank callback; Glib 0x127CB0 counts them in 0x271AD4).
- The "slot" waits (0x110D0 on the 0x28A4BC table, slot 0) were not async loads: slot 0 is the streamed-audio
  buffer. 0xCBBA0(kind, done-callback) takes the slot and starts a stream (0xCC020); the stream's end callback
  (0xCBB90 / 0xC9FD0 / 0xCCEF0) gives it back. With NSOUND.DAT / NMUSIC.DAT / NSPCHDAT.DAT missing from the copy
  of Data used here the stream never ended and every later taker (module 0x2F41D4, Pre Race 0x2FDD0) spun to the
  1e9-instruction limit (~3 minutes each). With the sound files present all race modules load (only Peripheral
  still fails) and Season -> Race Weekend -> Race reaches Interface 10 (in-game, Race process state 0x26) in
  ~3 minutes instead of 11.
- The UIStudio module is not loaded (the VM is the UI), but its Load 0x757B0 also fills the in-game camera/HUD
  action table 0x2F3078 (0x74CD0, data only) that the race update 0x9F360 -> 0x74DF0 calls through; startup now
  runs 0x74CD0 (before: a call through a null entry every race tick).
- In-game, the interpreter runs ~2.5 s of game time per 31 s (about 12x slower than real time); 300-850 draw calls
  per frame.
- Open: one error on the first in-game tick (0xF2450 -> D3DXMatrixTranspose 0x19F104 with a garbage matrix
  pointer: some camera/view object not set up yet), and one in the sound layer (0x160D6C: the sample-memory pool
  0x15D620, header at [0x2806B0], returns a garbage pointer, so its block table is overwritten somewhere). Both
  are caught per tick and the race keeps running.

### First pictures of the 3D scene (soft-renderer.mjs, nv2a-vsh.mjs, scene-capture.mjs)
- SoftRenderer implements the renderer interface in software: at each draw it reads vertex buffers (declaration
  tokens), runs the NV2A vertex shader program, clips (w > 0 and the near plane, in homogeneous screen space),
  rasterizes with perspective-correct attributes, samples textures (swizzled/linear/DXT/P8 via mmap-tex.mjs
  decodePixels; linear textures take texel coordinates) and shades with the NV2A register combiners from the
  pixel shader definition (or the texture stage states without one), then alpha test, depth test, blending and
  colour mask from the NV2A methods of SetRenderState_Simple. Render targets are kept as images; a texture whose
  data is a render target reads our image (the bloom pass downsamples the back buffer to 320x240 and blends it
  back). It only draws while capturing (capture(n)); ~2-6 s per frame. `node scene-capture.mjs <Data> [keys]
  [out.png]` and the browser server's /scene.png use it.
- nv2a-vsh.mjs decodes the 128-bit vertex shader instructions (xemu/Cxbx field layout), disassembles them and
  compiles each program to a JavaScript function. The assembler appends the viewport transform (c-38 scale, c-37
  offset): d3d-hle now writes those constants on SetViewport/SetRenderTarget/device creation (D3D8 resets the
  viewport to the whole target on SetRenderTarget).
- Fixes found by drawing: SetVertexShaderConstant* take the hardware register (0-191, the inline wrappers already
  add 96) and NotInline counts are in dwords (D3D also shadows constants at 0x19BF50); SwitchTexture (a texture
  change written straight into the push buffer, method 0x1B00 + stage*0x40) now sets the stage's texture; an unset
  texture reads as 0 in pixel shaders (the terrain splat shader uses four stages, the game binds three); visibility
  tests return the pixels counted by the renderer (the sun-glare quad is sized by it: a fixed 1000 drew a quad
  ~150x the screen and tinted everything brown).
- Resource module: entry count 0x1190A0, archive kind 0x1190F0, load into buffer 0x11A5C0, copy entry 0x11A870,
  open-entry-as-archive 0x11AF60 (named archive name + index), is-open 0x119220, async-into-buffer 0x11A770 are
  ported. Before, entry counts read as 0, so the track's render setup came out half empty (LOD table [obj+0x30]
  null) and the first race tick faulted in 0xF2450.
- A fault in the sound layer when a speech stream starts (0x12D660 -> sample pool 0x15D620; the pool's block
  table at [0x2806B0] gets an entry (0, 0xC0C45800) that is not from 0x15D620 itself) aborted every Race process
  tick before Swap, so the race drew nothing new. The stream start is now guarded: that one sound is skipped.
  Root cause still open.
- Result: the Race Weekend view and the race itself draw recognisably (Daytona: grandstands and crowd, track,
  apron, infield grass, sky dome, clouds, blimp). Cars are missing because car models are still the fake handles
  (0x6C5D0): with the real loader the season hub waits for "model ready" (NT04_REAL_CAR_MODELS=1 to try).

### Car models (race cars draw; the frontend preview still uses stand-ins)
- The race's 43 cars come from CARDATA.DAT through the synchronous load 0x11A390 (about 3 entries per car, loaded
  by the race module 0xA2EB0 path); the race weekend garage car comes from CARRESFE.DAT #352/#155 the same way,
  relocated with 0x155910 (MMAP/CMMP in-place fixup, flag bit 0 at +6). With the resource-module ports these load
  and render: after the pre-race UI (3/18) the race shows the full field lined up on pit road (scene_race_grid.png).
- 0x6C5D0 (car model loader with refcount and done callbacks, table 0x2B714C) is only the driver-select 3D preview
  (CARRESFE.DAT by car number, done callback from 0x22012C -> 0x9DA60). It uses the async load 0x11A490 (now ported:
  data in at once, entry flagged "loading" (0x10) and the callback run at the start of the next frame, after the
  caller stored the buffer; 0x1191B0 reports "loading"); synchronous loads of an entry still loading complete it
  first instead of loading a second copy.
- With the real 0x6C5D0 (NT04_REAL_CAR_MODELS=1) the season hub now continues, but the race weekend's visibility
  pass (0xF2350 -> 0xF2240, track cell tree at [0x2F1E2C+0x28]) reads an object record with a garbage LOD count
  (~-3700): its visibility-flag clearing loop (0xF2310) then writes zeros over the tree and its vis struct
  ([vis+4] low byte) and later frames recurse until the stack runs out. The object is probably the preview car
  carried into the 3D scene; its data is not fixed up the way the race path's 0x155910 does. Default stays the
  stand-in handle (no driver-select preview car; nothing else depends on it).
- Speed: with all race assets loading, the race weekend runs ~2.5 s of game time per ~110 s (1,600-1,700 draws per
  frame); reaching the race takes ~6 minutes. The interpreter is now the main obstacle to playing.

### CPU speed: block compiler (x86-jit.mjs) — same results as the interpreter
- Straight-line runs of game code are translated once into JavaScript functions (`new Function`), which V8 compiles
  to machine code. A block runs until a control transfer or 64 instructions and never into a hooked address.
  Conditional branches become side exits (the block goes on along the fall-through path), unconditional jumps
  are followed, and direct calls are inlined up to 3 deep (the callee's ret checks the return address; if the game
  changed it, the block exits there). Flags are computed only where a later instruction can read them.
- Translated: integer ALU/moves/shifts/mul, stack, setcc/cmov/movzx, x87 and the SSE subset the game uses. Anything
  else (string ops, rdtsc, ...) runs in place in the interpreter with exact step counts, so coverage never limits
  what runs. Two-level block table over the image (4 KB pages), hook bitmap for the dispatcher's fast path; the
  memory module's 64 KB page table replaces the region search on every access.
- Emulated time is exact: kernel time (KeQuerySystemTime/KeQueryInterruptTime, DSound clock) comes from the step
  count (733 steps per µs), and a block only runs when it fits before the next tick (thread slice, vertical blank)
  or the slice budget, so ticks land on the same instruction as in the interpreter. A fault inside a block counts
  the faulting instruction, like the interpreter (module "Peripheral" faults during boot by design).
- Checks: NT04_JIT_VERIFY=1 runs every block in both engines (writes journaled and undone) and compares registers,
  flags, x87, XMM, memory and step counts — 0 mismatches over boot, frontend and race weekend loading. Hook-call
  traces (address, eax, esp, step count) are identical between NT04_NO_JIT=1 and the compiler from boot through the
  race weekend. For identical runs pin the wall clock the game sees: NT04_BOOT_DATE=2004-01-01T12:00:00Z (otherwise
  the real date, which makes runs differ slightly — the game derives values from it).
- First measurement (race weekend loading): interpreter ~5.9 M instructions/s, compiler 23-25 M/s.

### CPU speed, second pass: regions, locals, flat memory (pre-race scene ~2x real time)
- Where the time went: idle-loop skipping was not worth it (no polling loop above 1% in loading or in the race
  scene). The costs were in compiled code itself; measured with per-line profiles of the block functions:
  - *Hidden-class change*: the CPU object gained fields after construction, which left c.steps / c.eip / c.flags
    megamorphic in every block compiled before (all fields now declared in the constructor with their final
    representation).
  - *Instructions still interpreted*: cmpps/cmpss, movmskps, MMX movq, cvtpi2ps/cvtsi2ss, cvt(t)ss2si, imul
    r,r/m,imm, rcpps/sqrtps/rsqrtps, sahf, xlat, fwait, emms, fucompp, fnstsw m16 now translated (21 M interpreted
    instructions per 1 G down to 1 M).
  - *Compile cost* (~430 µs per block, 20% of loading): blocks compile on their 2nd visit (half the blocks a race
    load reaches run only a few times), the function is compiled eagerly (V8 otherwise parsed it twice), and exits
    share one epilogue.
  - *Memory access*: the game's own memory (image, heap, main and thread stacks) now lives in one flat 256 MB
    window below 0x10000000 (uis-vm.mjs Memory.enableLow; stacks moved there from 0x70000000 / 0x62000000). Blocks
    access it inline: `a < 0x10000000 && lowOK[a >>> 16] ? lowDV.getUint32(a) : m.r32(a)` (lowOK marks pages a region
    covers completely, so unmapped addresses still fault exactly as before).
- Block structure: a block is a region of straight-line segments — taken branches queue their targets as further
  segments — compiled into one function with a `switch` for branch targets inside it; loops run inside the
  function while the step budget (c.lim, from the dispatcher: next tick or slice end) covers another pass.
  Registers, EFLAGS and the x87 stack top live in JS locals, written back at exits and around interpreted
  instructions. cmp/test/sub/add/inc/dec followed by a conditional branch test the operands directly; EFLAGS are
  computed on the taken path or when something reads them. Constant shl/shr/sar are inline. The shadow call stack
  (error reports) is a fixed Float64Array.
- Results (same machine, NT04_BOOT_DATE pinned): pre-race scene (3/18 over the 3D track, steady) 35 -> 63-67 M
  instructions/s, i.e. 2.5 s of game time in ~4.9 s (1.9-2x slower than real time); race weekend loading 24 -> 29-32
  M/s. The interpreter alone: 6.2 M/s in the race scene (20.8x slower than real time), 5.5 M/s loading — the
  compiler is now ~10x the interpreter there.
- Checks: verify mode over boot/frontend and over a race-scene window (NT04_JIT_VERIFY, or jit.verify set later
  with a flush: blocks are then recompiled with journaled memory writes); hook traces identical to the interpreter
  from boot through race weekend loading (1,467,339 calls) with the new memory layout.
- Knobs: NT04_JIT_THRESHOLD (visits before compiling, 2), NT04_JIT_MAX (instructions per block, 64),
  NT04_JIT_NOLOOP (no branches inside a block), NT04_JIT_DEBUG (guest addresses as comments in block source).
- Remaining in-block costs: memory access (~30% of block time), register load/write-back (~13%), x87.

### Compiled blocks kept between runs (x86-jit-cache.mjs)
- Generated block code depends only on the game image, the compiler and its options, so it is saved:
  <exe folder>/jit-cache/<key>/ (NT04_JIT_CACHE=<dir> elsewhere, NT04_JIT_CACHE=0 off; not used in verify mode).
  key = hash(x86-jit.mjs, the image, options); caches of other keys are deleted when a game opens the cache.
- index.json: block start -> [chunk, slot, instruction count, guest addresses]; chunk_*.js.gz: the blocks saved
  together (every 400 new blocks, rest at exit) as one script returning their functions; chunk_*.bin: V8's code
  cache for that script (bytecode), written the first time a chunk is loaded. Chunk names carry pid + time, so two
  running games sharing the folder do not clobber each other.
- A cached block is used only if none of its instruction addresses is hooked now (hooks can be added during a
  session); blocks with code outside the image are not cached.
- Effect (same machine): boot -> race scene ~71 s without the cache, ~57 s with it (race weekend loading 47 ->
  37 s; the second run after the cache is first built is in between while it writes the code caches). Size about
  180 MB after a race load (sources 20 MB gzipped, code caches 160 MB uncompressed: inflating them cost more time
  than it saved). Hook traces identical with a cold and a warm cache.
- NT04_NO_JIT=1 turns the compiler off.

### Controllers (xinput-hle.mjs) — driving the race
- The boundary is the XAPI controller API, answered for the gamepad device type (0x1C4B34) on four virtual pads:
  XGetDevices 0x1C5A1D, XGetDeviceChanges 0x1C5A3F, XInputOpen 0x1C61C0, XInputGetCapabilities 0x1C6222,
  XInputGetState 0x1C63FA, XInputSetState 0x1C646D (rumble kept in pad.rumble), XInputClose 0x1C6216. Other device
  types (memory units 0x1C4A98, IR dongle) run the original code. Pads connected: NT04_PADS (default 1, port 0).
- XInitDevices 0x1C4D4C (USB host stack init) is skipped: it faulted on the missing USB hardware (bad address
  0x80000020), which is why module "Peripheral" always failed — and with it the game's input system 0x12E7D0
  (enabled flag 0x272EC4) never started. Now Peripheral loads and the input system runs.
- The game's input stack, all original code: device manager (port records [0x2F93BC] + port * 0x20, count
  0x2F93B4, drivers [0x2F93B8], gamepad driver table 0x21629C = open 0x12EE30 / close / poll 0x12EF30: XInput
  state -> per-port report: sticks, 8 analog buttons as 0x80-centred bytes, digital bits). Per frame 0x6A770 polls
  each port (0x12E880) and 0x12F860 runs the port's action map ([0x273244] + port * 0x1C: +8 map, +0xC callback):
  map entries are 5 words (action, element|kind<<0, dead zone, scale, -), the callback gets (port, action, value).
  Maps seen: 0x228010 menus (callback 0x75F20 = the native UI input entry), 0x228394 race intro (0x40, 0x63 = A),
  0x227A70 driving (callback 0x6B910: 0x46 throttle = right trigger, 0x47 brake = left trigger, 0x39 steering = left
  stick X, plus buttons for camera, look back, pit...). Port table 0x2B700C (16 bytes/port: +0 flags, +4 state).
- Menus: the screens run in the UI VM, not the game's UI manager, so pad changes become UI messages in
  Pads.uiEvents (A 0, B/BACK 6, X 8, Y 9, START 7, black 10, white 11, d-pad or left stick 2-5 with repeat while
  held), sent each frame through vm.press — the same messages as before; code that calls vm.press still works.
- Verified: with only the virtual pad, START, A, A, A, down, A, A, A reaches the race weekend menu exactly like the
  scripted presses; A on the pre-race screen 3/18 starts the race (map 0x228394), A on 3/10 hands over control
  (map 0x227A70) and the driving actions arrive (0x46 = 1.0 for the trigger, 0x39 = -0.97 for the stick). Holding
  the throttle with no steering drives the player's car (#21) off the line into the outside wall and the infield
  (frames captured). Runs with and without input are identical until control is handed over, then diverge.
- (Fixed later, see "In-game HUD": the HUD script aborts after the hand-over came from the native bridge.)
- Host side: game.pads.set(port, { buttons, analog: [A, B, X, Y, black, white, LT, RT], lx, ly, rx, ry,
  connected }) — a keyboard / host gamepad mapping goes on top of this (the browser front end will fill it in).

### Limits seen here
- Memory-unit load screen shows 8 slots per device; a race field is 43 cars — a code limit (per-car arrays; see the configuration section); seasons: 39 schedule entries by table capacities only (raised by the overlay; 46 tested); default season is 12 races ("Race: 1/12"); DRVR 119/119, CARS 116/116, RACE 78/78, TEAM 77/77, TRCK 65/65 (full, but the JS engine lets the overlay grow them); DRST 656/1500 grows by ~43 rows per season year; process slots: 11 (manager capacity 20); memory-unit job queue
  holds one job; file module handles: table at 0x271D10 (size not read yet).

## Kernel
129 imports; see kernel_imports.csv (114 functions + 15 data exports).

### Static recompilation step 6: all executed functions (4,314), split compilation

- `recomp.mjs --executed` adds every function the race and menus actually executed (recomp-executed.json, 4,303 entries) to the hot/called sets: 4,314 functions, 195,949 instructions, 49,148 entry points, 39 MB wasm.
- One 65 MB C file made clang run out of memory (~6 GB). build() now writes a shared header `recomp.h` (runtime prelude, register macros, declarations of every function and `call_any`) and translation units of ~1.5 MB each; unit 0 defines the globals `G_cnt/G_exit/G_nf/G_lim` and `call_any`. Functions are `hidden`, non-static. Units compile in parallel (`xargs -P`, up to 8) with `clang -c` and are linked by wasm-ld with the same memory flags as before. Full build: ~3.7 min on 2 cores.
- Determinism: STATE 4759102df54c9322 (exact), 4,287 functions enabled (the rest contain hooked addresses).
- Race: recompiled code runs 76.8% of instructions (was 72.8%), 8,911 entries/frame, 236 instructions/entry. CPU per race frame median 17.9 ms (min 15.7) vs 20.9 (18.1) with NT04_RECOMP=0.
- Remaining exits per frame: ret to dispatcher 6.5k, hooks run in place 8.2k, jump out 3.0k, call not recompiled 1.0k, call via pointer 0.3k. Coverage is no longer the limit; the next gains are from keeping control inside wasm (tail jumps between functions, returns into the caller's resume point) and from hook cost.
- Shipped as `recomp.wasm.gz` (4.4 MB; the raw 39 MB file is over the transfer limit). wasm-jit loadRecomp reads `recomp.wasm` if present, else gunzips `recomp.wasm.gz`; the old 754-function recomp.wasm was moved to `_to_delete/` so it does not shadow the new build.

### Static recompilation step 7: trampoline inside the wasm module

- After a recompiled function returns (G_exit 0) or jumps out of itself (now G_exit 2, label `out_jump`), the entry wrapper calls `chain(pc)` (unit 0): binary search of the sorted resume points (RA/RI tables, 49k entries), first enabled function owning that pc, call through a function table (`FT[i](pc)`), repeat. The step budget carries over (G_cnt/G_lim), so a block that would cross it still exits exactly at its start (WHY 0, G_exit 1), which ends the chain; so does any other exit and the dispatcher's stop flag (CTX+56).
- WHYS[11] chained returns, WHYS[12] chained jumps (cpubench4 prints 13 counters).
- Determinism exact (4759102df54c9322).
- Per race frame: entries 8,911 → 4,316 (488 instructions per entry); 4,766 returns and 834 jumps now continue inside wasm; still exiting: returns to non-recompiled callers 1.7k, jumps to non-resume-point targets 2.2k, calls to non-recompiled functions 1.0k, hooks in place 8.2k (these don't exit). CPU per race frame median 16.1–17.3 ms (was 17.9; 20.9 with recomp off).

### Static recompilation step 8: exits that should not happen (missing instructions, missing functions)

- An RC_NOTE build now notes every pc where the trampoline stops (6/8: no resume point; 16/18: owning function disabled); `recomp.mjs --out DIR` writes a build elsewhere.
- The hot unchained jump targets were instructions the recompiler did not translate, so their blocks were dropped: now translated, matching x86emu exactly — 16-bit movzx/movsx/inc/dec, xlat, sahf/lahf, fwait, shld/shrd (32-bit, imm and cl), cvtss2si, and the x87 ops fprem, fpatan, fptan, fsin, fcos, fsincos, f2xm1, fyl2x, fyl2xp1, fscale. The transcendental/remainder ops and cvtss2si call into JavaScript (imports `fm(k, a, b)` and `cvt(v)` in wasm-jit loadRecomp) so they compute with the same Math functions and MXCSR rounding as the interpreter.
- The hot unchained return targets were in functions missing from recomp-functions.json. recomp-extra.json (36 functions; start = 16-aligned address after int3 padding that reaches the noted address) is included with `--executed`. Build: 4,350 functions, 199,824 instructions, 50,021 entries.
- Determinism exact (4759102df54c9322); 4,323 functions enabled.
- Per race frame: entries 4,316 → 1,427 (1,520 instructions per entry); recompiled code runs 79.2% of instructions; returns to the dispatcher 1.7k → 220, jumps out 3.0k → 837. CPU per race frame median 14.6–15.7 ms, min 12.1 (was 16.1–17.3; 20.9 with recomp off).

### Static recompilation step 9: functions found from every executed block

- A race CPU profile showed hot JS-JIT blocks (0x168363, 0x166229) in functions missing from recomp-functions.json; they are entered by calls from code that is not recompiled, so step 8's exit notes did not find them.
- `recomp-extra.mjs [DataDir]` (with NT04_JIT_CACHE set): takes every executed block start from the JS and wasm block caches (56.6k), keeps those no recompiled function contains, finds the function start (16-aligned address after int3 padding that reaches the block) and merges it into recomp-extra.json (now 426 functions). Run it after a rebuild; it changes nothing once everything executed is covered.
- Build: 4,740 functions, 223,993 instructions, 55,742 entries, 44.8 MB wasm (4.9 MB gzipped). Determinism exact; 4,711 enabled.
- Per race frame: recompiled code runs 93.3% of instructions (was 79.2%), 1,222 entries, 2,093 instructions per entry. CPU per race frame median 12.4–12.6 ms, min 10.6 (was 14.6–15.7; 20.9 with recomp off).
- Profile before this step: recompiled code ~53% of race CPU; in-place hooks ~1.8 ms/frame (the hottest are 0x18de30 1.65k calls/frame, 0x18ed60 845, 0x190be0 621, 0x18dc60 425); memory helpers (ld32/st32/ld128/rdf32) show as separate functions, i.e. clang does not inline them.

### Static recompilation step 10: inlining and lookup tables

- Profile after step 9: recompiled code 70% of race CPU; inside it the largest single items were `chain` (4.3%, binary search over 55k resume points) and `call_any` (0.9%, a 4,740-case switch); memory helpers were not inlined in large functions.
- Memory and flag helpers (ld/st 8/16/32, szp, f_add…f_dec, float bit casts, rdf/wrf 32/64, fcmp_/fcomi_, fist32, toi32) are `always_inline`; ld128/st128 check the page once (offset ≤ 0xfff0) and use one 16-byte access, with an out-of-line slow path. The page-table read in FAST is no longer volatile: the table only changes in JavaScript during an import call, so clang may reuse a check between imports.
- `chain` and `call_any` look up open-addressing hash tables (RH: resume point → lowest function index; CH: function entry → index; size 2× entries, multiplicative hash, linear probe). A disabled first owner falls back to the old binary search for the next enabled owner, so the choice is unchanged.
- Determinism exact. CPU per race frame median 11.2–12.0 ms, min 9.8 (was 12.4–12.6; 20.9 with recomp off).

### Frame spikes during the race (step 11)

- Per-frame timing over 1,800 race frames (scratchpad spikes.mjs): median 10.6 ms, p99 29 ms, max 374 ms. A CPU profile with timestamps (spikeprof.mjs) showed the big frames inside `JitCache.load`: a JS block-cache chunk read, inflated and compiled (vm.Script) synchronously, 40–65 ms or more, the first time any block of it ran. 100 chunks were loaded this way in 30 s of racing. These blocks run on the dispatcher's JS path, mostly near a tick, when the remaining step budget was smaller than a recompiled entry's NTAB.
- x86-jit-cache.mjs: with `lazyLoad` set (gamecode prefetchCode sets it on the live loop's first idle call), a block whose chunk is not loaded is compiled on its own (get returns null) and the chunk moves to the front of the idle-time prefetch queue. NT04_JIT_SYNC_CHUNKS=1 restores synchronous loading.
- Recompiled entries are registered with NTAB = their first block's length (recomp.json entries are now [addr, export, firstBlockLen]; older builds fall back to 64). The recompiled code checks the budget before every block, so only the first must fit; near a tick the dispatcher stays in recompiled code longer instead of falling back to JS blocks.
- With lazy loading (warm caches): median 10.6 ms, p99 20–24 ms, max ~50 ms (was 374). Remaining slow frames: one-off single-block compiles (the live loop prefetches those chunks in idle time) and fresh wasm block batches (~100–180 ms per 256 blocks) when the wasm block cache is cold — it is keyed on wasm-jit.mjs, so the first race after an update to that file rebuilds it.
- Determinism exact. CPU per race frame median ~12 ms.

### WebAssembly block batches off the frame (step 12)

- With a cold wasm block cache, each batch of 256 new blocks cost 80–180 ms inside one frame. Splitting it: V8's compile is now asynchronous (`WebAssembly.compile`, off-thread); the blocks are installed from the event loop between frames (`installBatch`; after a flush — `gen` changed — only blocks that still avoid hooked addresses and have no block yet). Until then those addresses keep running as JS blocks, with identical results. NT04_WASM_SYNC=1 / `syncCompile` restore the synchronous path.
- The larger part was translation itself (x86 → wasm, ~80–100 ms per batch). `compileBatch(deadline)` now translates until a deadline and keeps partial work (`tlist`); with `deferBatches` (set by `idleWork`) a full queue no longer triggers a batch inside the frame (fallback at 8×BATCH queued). The live loop (main.mjs) calls `g.prefetchCode(ms)` in the time left before the next frame (from 2 ms left, up to 4 ms per call, re-armed every frame); it runs `W.idleWork(ms)` and the JS chunk prefetch.
- Determinism exact in both modes (the test never yields to the event loop, so nothing is installed asynchronously there; sync mode installs immediately).
- Spike test with idle work simulated: cold wasm cache max ~80 ms outside the first frame (was 184), warm cache median 10.8 ms, p99 22.5 ms, max ~46 ms. Live auto-race: no errors, game 50–65 fps.

### Static recompilation step 13: registers moved per call

- Counting build (`RC_COUNT=1`, WHYS[13]/[14]): ~62,400 direct calls between recompiled functions and ~5,800 call_any calls per race frame (one per ~39 instructions); every call stored and reloaded all 12 general/x87 registers plus the caller's XMM registers, on both sides.
- Each function now loads/saves only the registers it mentions (U). Invariant: while a function runs, CTX holds the true value of every register outside its U. Around a direct call to G it moves U ∩ U*(G), where U*(G) is everything G and its callees can touch (fixpoint over the call graph); if G exits to the dispatcher, the caller saves the rest of its U before returning (placeholders @@SC/@@LC/@@SX@@ filled in build()). Hooks run in place therefore always see a true context.
- U* is "all registers" for a function that calls through a pointer or calls a hooked address, or calls anything that does. Hooked addresses come from `recomp-hooks.mjs` (boot to a race, record every hooked address → recomp-hooks.json, 371 addresses; stored in recomp.json `hooked`). wasm-jit registerRecomp disables any function that calls an address hooked at run time but missing from that list (its callers then take the full-save exit path).
- Build: call sites move 66% of the registers they used to; 2,122 of 4,740 functions still need all (hook/pointer callers). wasm 43.9 MB (was 47.5). Determinism exact; 4,711 functions enabled (no late hooks).
- This VM was ~25% slower than the previous day's (recomp off 26.1 ms/frame, was 20.9), so old and new builds were run alternately: median 15.5 vs 16.5 ms, p25 14.4 vs 15.0 (~6%).
- Fix: background wasm block compiles (step 12) only with the live loop's idle work (`deferBatches`); a caller that never yields to the event loop (tests, benchmarks) never installed them, ran everything else on JS blocks and, with recomp off, ran out of heap.

### Static recompilation step 14: D3D state setters natively

- Hooks by name per race frame (NT04_D3D_COUNTS=1): SetStreamSource 1,779, DrawIndexedVertices 1,009, SetPixelShaderConstant 583, SetVertexShaderConstant4 546, SetPalette 452, SetVertexShaderConstant NotInline(Fast)/1(Fast) ~720, … The setters only record state the renderer reads at draw time.
- recomp.mjs: a state block `NST` (1,024 words, exported address `nstate()`) and `nhook(id, ecx, edx, esp)` implement SetStreamSource (1), SetPalette (2), SetVertexShaderConstant4/1/NotInline (3/4/5, incl. D3D's shadow copy at 0x19BF50 and the dirty range) and SetPixelShaderConstant (6). At a hooked call site `NHT[k]` (u16 at EN−0x10000: id | stack bytes << 8) selects it; the call then pops the return address and arguments, sets eax = 0 and continues, as the JavaScript hook does. Unusual arguments (stream ≥ 16, misaligned / unmapped / mirrored source, vertex range wrapping, counts out of range) return 0 and the JavaScript hook runs instead.
- d3d-hle.mjs: those hooks carry `recompNative { id, pop, d3d }`; `shareState(buf, base)` moves streams (16 getter objects), palettes, vsConst, psConst (typed-array views) and vsDirtyLo/Hi (accessors) into the block, so hooks, native code and renderers use one copy. wasm-jit registerRecomp calls it and fills NHT; NT04_RECOMP_NO_D3D_NATIVE=1 turns just these off.
- Determinism exact; JS hook calls in the test run 15.4 M → 5.6 M (9.8 M native). D3D state (streams, vsConst, psConst, palettes, dirty range) hashed at every draw over 600 race frames (730k draws): identical with and without native setters.
- Alternating runs, same build: median ~14.1 ms vs ~15.4 ms with the JavaScript setters (~8%).

### Tried and dropped: page-table-free access to main RAM

- Idea: main RAM (0x1000000–0xEFFFFFF) and the image's constant addresses are window pages for the whole run, so ld/st could use one range compare instead of the page-table lookup (`DIRECT`, with a loader check of the page table).
- Determinism exact, but alternating benchmarks showed no difference (medians 15.7/15.6, 15.0/16.0, 17.3/17.0 ms, old/new) and the wasm grew 46 → 49 MB. Reverted; the page-table check (one byte load, mostly cached) is not a measurable cost.
- Race profile at this point: recompiled code ~70% of CPU, in-place JS hooks ~10% (D3D draw handler ~4.5%), thread waits/switching (NtWaitForSingleObjectEx) ~5%, UI script VM ~4.6%, audio mix ~1.2%, GC ~2%.

### Browser fps below 60 with the game at 60 (frame flow)

- Status-line diagnostics (main.mjs sendInfo, gl-remote takeDiag, play-client): `page avg/max ms` (the page's JavaScript time per frame), `sent N skipped M` (frames not captured because the page had not acknowledged earlier ones), `ack avg/max ms` (capture → acknowledgement), `emu max` (slowest emulator frame of the second).
- User's race video: game 60 fps throughout, page 0.7–1.8 ms per frame, but 0–8 frames skipped per second; ack 6–15 ms on average with spikes to 24–46 ms in heavy frames (1,300–1,700 draws, 25–34 MB/s), and emulator frames up to 17–32 ms followed by catch-up. With 3 frames allowed in flight, a latency spike during catch-up ran out of credits.
- IN_FLIGHT default 3 → 6 (NT04_GL_IN_FLIGHT still overrides). Frames only queue during spikes, so latency is unchanged when the page keeps up.
- Frame pacing in play-client.js: 3D frames wait in a queue and one is drawn per requestAnimationFrame (a queue longer than 2 is drawn down to one at once; all frames are processed in order, since they carry incremental state). The acknowledgement goes out when a frame is drawn. If no animation frame ran for 100 ms (hidden tab, a starved compositor) frames are drawn on arrival again. `?pace=0` turns pacing off. Status line: `empty N` (animation frames with nothing to draw) and `q` (average queue length when drawing).
- Test environment note: headless Chromium with SwiftShader on this 2-core VM gets only 0–5 animation frames per second on the game page (compositor starved), so pacing could only be checked for the fallback here, not for smoothness.

### Bug: blank driver / track data after the attract demo

- Symptom (user): after the idle attract demo, Race Now's driver select showed empty name bars, no driver photo, no series badge and a garbled car name. Reproduced headless (main menu → wait for the demo to load → back → driver select).
- Cause: on the demo's loading screen the game runs 0x5F320, "reset career data": for each row of table CDRS (TNAM, DELT) it either deletes the rows of a DELT=1 table (DRVR, CARS, SPON, DRST, GINF, AWAR, QUAL, …; query "delete from \x8c") and afterwards reloads all of them from nascar.db through 0x148510(db, tag list, "nascar.db", 2, file ops), or drops a DELT=2 table through 0x1479E0(db, tag) (game-mode tables that gmodedb.dat brings in). The JS database (gamecode databaseEngine) bridged the deletes but not the reload or the drop, so those tables stayed empty (ULDR, rebuilt from DRVR by later code, too).
- Fix: hooks 0x148510 (fresh tables from the named file, keeping each table's save flag, config overlay reapplied for nascar.db) and 0x1479E0 (remove the table). DELT=1 tables all come from nascar.db, DELT=2 all from gmodedb.dat parts, so the reset now matches the original.
- After the demo: all tables identical to before except the dropped game-mode tables (as in the game); driver select correct; a race started afterwards runs. The normal race path never calls 0x5F320, so the determinism test is unchanged (exact). recomp-hooks.json regenerated (373 addresses); until recomp.wasm is rebuilt, the loader disables the few recompiled callers of the two new hooks.

### Full static recompilation, step 1: every function of the image

- `recomp-all.mjs` → recomp-all.json: the known lists (recomp-functions/executed/extra, 9,348) plus every 16-aligned address after int3 padding (2,446 more candidates) plus every direct call target, repeated to a fixpoint; candidates whose start does not decode as code are dropped (48). Result: 11,746 functions reaching 501,991 instructions — essentially the whole code section (0x11000–0x1CD000, 1.8 MB). Runs in ~1 s.
- `recomp.mjs --all` adds them: 11,748 functions, 524,898 instructions, 127,061 entry points; wasm 106 MB (12 MB gzipped); clang ~8.5 min on 2 cores.
- V8 allows at most 100,000 exports per module: entry wrappers are no longer exported. Unit 0 holds `ENTRY_FN[]` (their function-table slots, `entry_table()`), the module exports its table (`--export-table`), recomp.json entries are [address, wrapper number, first block], and wasm-jit takes `__indirect_function_table.get(ENTRY_FN[k])` (old builds with export names still load). `__heap_base` is exported; the loader refuses a build whose data reaches the hook tables (EN − 0x20000) — this build ends at 0x11392B10, ~640 KB below.
- Determinism exact; 11,496 functions enabled (252 disabled: hooked entries, one with a hook inside). Loads in ~0.4 s.
- Race: calls into functions that are not recompiled 0 per frame (was ~600–1,000); recompiled code still runs only ~93.5% of instructions; remaining exits per frame: unchained jumps out ~650, jumps through pointers ~480, calls through pointers ~130, returns to the dispatcher ~9.

### Full static recompilation, step 2: the last 6% of race instructions

- RC_NOTE build of the full module (now also noting jumps through pointers, kind 4, and jump-table misses, kind 5), totals over a ~2,500-frame race: unchained jumps to 0x1660E3 / 0x1662DE (`pushad` / `popad` in a hand-written MMX routine at 0x1660E0, unsupported, so those blocks ran on the JIT), tail jumps into hooked functions (mostly `jmp _ftol` 0x1803A8, ~260/frame, plus D3D setters) that left to the dispatcher and the JS hook, jumps through pointers to recompiled entries (~265/frame) that ended the chain, calls through pointers to hooked kernel thunks (0x7FF000xx).
- Fixes: `pushad`/`popad` (as x86emu); `jmp` through a pointer exits with G_exit 2 so the trampoline continues; trampoline `chain_hook`: a target with no enabled recompiled code runs its hook in place (whole state is in CTX there; `_ftol` natively on CTX's x87 registers), continuing at the return address it popped; a call through a pointer that misses call_any tries `imp_hook` before leaving; `cvtpi2ps` (two int32 from an MMX register or memory → low two floats, round to nearest as the interpreter) — the routine's remaining blocker.
- Result: determinism exact; recompiled code runs 99.9% of race instructions (was 93.7%); 13 entries per race frame (was ~1,060), ~209,000 instructions per entry; calls through pointers that leave 1/frame (was 131).

### Full static recompilation, step 3: static mode (no block compilers)

- Per phase (scratchpad phases.mjs, full build): recompiled code runs 99.83–99.99% of instructions in boot, title, menus, race loading and racing; what ran elsewhere was 0.01–2 M instructions per phase (~450 per race frame), yet the wasm JIT still translated hundreds of blocks per phase and the JS JIT loaded cached chunks.
- Static mode (gamecode, on whenever recomp.wasm is loaded; NT04_STATIC=0 restores the block compilers): `cpu.jit.off` (x86-jit block() returns null, so the run loops fall through to the interpreter), `wasm.noJit` (want() still registers the recompiled code but queues nothing), and no JitCache / WasmCache is opened (no jit-cache folder, no index loading at start).
- Determinism exact; no blocks translated; determinism test 29 s (was 45–56 s); boot to a warmed race 29 s (was ~53 s); recompiled code 100.0% of race instructions; CPU per race frame median 8.3 ms (9.4 with the block compilers, same day).
- Frame times over 1,800 race frames: median 8.1 ms, p99 13.8 ms, max 21.3 ms, 4 frames over 16.7 ms, none over 25 ms (with warm caches before: median 10.6, p99 20–24, max ~46; cold caches 100–370 ms stalls). Live auto-race: game 60–62 fps, no errors.
- The jit-cache folder beside the game is no longer used in static mode.

### Where things stand after static mode; menu 3D preview (investigation)

- Race profile in static mode: recompiled code 81% of CPU; UI script VM ~5% (run0/walk/notify), audio mix ~2%, hook bridging a few %, GC <1%. A race frame needs ~8 ms of the 16.7 ms budget.
- Stubbed game functions reached in a menus → demo → race run (g.unknown): kernel thunks (expected), the front-end render 0x154C10 (every frame), car preview (0xEF030 set car, 0xEF050 attach model, 0xEF1F0/0xEF200 preview viewport), movies (0x73840 play / 0x733B0 stop), 0x6C590 car model release, 0xEF660 flag object init, file module 0x1286B0 (~15k calls; also the first call inside 0x154C10).
- 0x154C10 = 0x1286B0(); if not re-entered: begin 0x127F50, walk render list [0x27FB04] calling 0x154BA0 per object (0x154F30 / 0x154930 draw), end 0x127FB0, 0x154EF0.
- Experiment (gamecode env switches, off by default): NT04_UNSTUB=<addresses> leaves those STUBS entries out; NT04_FE_RENDER=1 keeps 0x154C10 running. With the preview stubs removed and the front-end render running, nothing breaks, the render runs every frame, but the render list is empty (0x154BA0 never called) and preview init 0xEE580 / attach car 0xEF130 are never called: the car / driver select screens are driven by the JS port of their handler (uis-natives-carsel.mjs), written while the preview was stubbed, so nothing creates the preview car. Next: find where the original handler 0x8DFE0 calls the preview functions and do the same from the port.
- Live play runs the game's own car-select handler (main.mjs sets NT04_NO_JS_SCREENS=1 for the flow boot; uis-natives-carsel.mjs is only used without it).
- Preview init 0xEE580 and attach car 0xEF130 have one caller: 0xA1110 = UISCarObj module load (init preview, 0x6D5D0, 0x6C810 created-car ids, car handle 0x6C520(1), attach slots 0..3, 0x6C590, 0x6DD50, attach slots 4..7). gamecode hooks it to run only 0x6C810 (NT04_CAROBJ=1 runs the original; it runs once at front-end module load). Set car 0xEF030 is called from the screen handlers (0x8DB80, 0x8DE30, 0x9DB30, ...).
- The front-end render list [0x27FB04] gets its entries from 0x154750 (create a view: screen rect, then 0x126CF0), called from 0x75520 and 0x172B0. 0x75520(layer in eax, ...) builds a UI layer: camera 0x1214C0 (0x121950 / 0x121900 427 x 240, fov / 0x1217D0, +0x20 = 45.0), full-screen view 0x154750 (desc {5, 0, 2, 0, 0, w, h}), view +0x1C &= ~1, 0x154990, 0x1217F0(view, camera), a 2D sprite layer 0x1278C0 with draw callback 0x75410 attached by 0x154A90, and the game's UI manager 0x13A100 with its handlers (globals per layer at 0x2B7C38 + 0x20 * layer: manager, view, camera, sprite layer, ...). The JS UI VM replaces all of it, so no front-end 3D view exists and nothing is drawn.
- Plan: create layer 0's camera and view (and nothing of the UI manager) the way 0x75520 does, keep 0x154C10 running, run 0xA1110 and the preview functions, and see whether the preview car is drawn into that view and reaches the browser stream under the UI overlay.
- How the original draws the preview car: layer 0's sprite layer calls 0x75410 → 0xEDB20, which renders the UI manager 0x13AA60 (then 0xF00B0, a screen-transition quad overlay, not the car). 0x13AA60 sends every active screen 0x1398C0(manager, screen, 0, -2) every frame: message -2 is the per-frame render traversal to the screen's objects (uis-vm calls -2 a one-time "open" message), and the car widget draws itself when it gets it.
- The UI manager's object handlers (0x75520): type 0 0x13FC20, 1 0x9AC40 (sound), 2 0x9A900, 3 0x9A990, 4 0x9AB70 (audio/music), 5 none, 6 0x141130, 7 0x13F630, 8 0x142200. Driver select 0/8 holds exactly one type-2 object: the car widget (UISCarObj). uis-vm has handlers for types 0, 1, 3, 4, 6 only, so the car object is ignored.
- Plan: (1) vm.handlers[2] → game.uiObject(0x9A900, ...) for its messages; (2) build layer 0's camera, view and sprite layer as 0x75520 does (no UI manager), with the sprite layer's draw callback 0x75410 hooked to send -2 to the visible type-2 objects inside the game's front-end frame (0x154C10 kept running); (3) run 0xA1110 and the preview functions (no stubs); (4) check the car reaches the 3D stream under the UI overlay.
- NT04_PREVIEW=1 experiment (gamecode previewHooks / buildLayer0, uis-natives type-2 handler), off by default:
  - Calling the whole 0x75520 for layer 0 also created a game UI manager and its input path: the JS menus stopped reacting to the pad. buildLayer0 makes only the 3D part with the same calls and values (0x127D20/0x127D30 size, 0x175E0 fov, camera 0x1214C0 + 0x121950 + 0x121900 427/240/-(240/0x1207A0()) + 0x1217D0 + fov 45 at +0x20, view 0x154750 {5,0,2,..} + flag + 0x154990, 0x761A0(eax 0, fov), 0x1217F0, sprite layer 0x1278C0 + 0x127970(cb 0x75410) + 0x154A90 + item 0x127A70), manager slot left 0. Menus work; the view is now in the render list and drawn every frame (0x154BA0 → 0x154B60 / 0x154F30 / 0x154930).
  - The sprite layer's callback 0x75410 is never reached; the car objects get -2 instead from a hook on 0x154930 for layer 0's view: 0x9A900 now runs every frame on driver select (plus 4 VM messages).
  - Still 0 draws: preview "set car" 0xEF030 is never called, i.e. the preview car never finishes loading. On the way to the screen the resource module 0x118BD0 and file module 0x1295B0 / 0x128F50 are reached and are "not ported" stubs (car resources open: cardata.dat, carresFE.dat, carparts.dat) — next suspect: the front-end car loading path.
- Car preview, continued (NT04_PREVIEW=1 + NT04_REAL_CAR_MODELS=1):
  - The car model loader 0x6C5D0 is faked by default (handle 0x7C...); with NT04_REAL_CAR_MODELS=1 the real one loads car 68 for slot 0 (handle 0x1F1A7A0), the screen's show-in-viewport 0x8DB80 runs and preview set car 0xEF030 is called.
  - 0x75520 ends with 0x9A8F0(eax = 0xEEED0): it registers the car objects' draw callback 0xEEED0 (→ preview draw 0xEEB00 per slot). buildLayer0 now does the same; 0xEEED0 / 0xEEB00 run every frame on driver select.
  - 0xEEB00 sets up the preview (viewport, transforms, shader constants, render states: D3D SetViewport / SetTransform / SetVertexShaderConstant* / SetPixelShader each frame) and draws the model's parts through 0xEE310 (enable bytes 0x2E0F38.., all 1) → 0x1352A0, which draws a named piece of the current model [0x2F95F0] (set by 0x133470; preview models at [0x2F34B4] / [0x2F34B8]) only when 0x136590 finds it. No draw call comes out: the preview models apparently hold no pieces of the car — next: attach model 0xEF050 (called once) and how the loaded car's meshes get into the preview model.
  - Why no pieces: the car object's Load 0xEE580 (UISCarObj module, via 0xA1110) never finished. Our early module pre-load (KEEP list in gamecode) loaded UISCarObj / UISFlagObj ahead of everything, before Sort (0x120F10 fills the sort table 0x2F8EB0; 0xEE580 sorts its 5 resource ids with 0x120FA0 kind 1 → called address 0) and before Glib (0x1356D0 registers the model chunk handlers 0x2749F8: Info, Lite, Matl, Text, Skel, Geom, Extn, Swap, Clst, Txfm, Inst, Ring, Fade, DInf, MAnm; without them 0x1322F0 → 0x1322B0 zeroes every chunk pointer, so the models at 0x2E0E40 / 0x2E0E74 and the instances 0x2E0CB0 stayed empty). The module failed, was "counted as loaded", and the frame code ran against empty models.
  - Fix (NT04_PREVIEW only): UISCarObj / UISFlagObj leave the pre-load list and load with the interface's module lists (after Sort and Glib). Both Loads now succeed; cardata.dat entries 0x166 / 0x16D (TMdl body models), 0x183 / 0x18B / 0x18C (textures) are parsed; the instance mesh table has 0x1B pieces.
  - Result: 0x135200 → 0x134FB0 → D3DDevice_SetStreamSource / DrawIndexedVertices: 28 draws per frame at driver select (one car, ~30k strip indices). (d3d.stats.draws is reset at each present: read it per frame.)
  - Still wrong: placement / projection. Soft renderer: the first draw already covers the whole screen (vertices land at the left edge, z/w ≈ 7, far past the far plane). Likely causes: our render message -2 to the car object passes no arguments, so the position 0xEEB00 gets from 0xEEED0 ((x0+x1)/2, y) is 0 while the layer-0 camera sits at (427, 240) in UI coordinates; and buildLayer0's camera is a partial copy of 0x75520. Next: find the arguments the UI manager's render 0x13AA60 passes with -2 (object rectangle), pass them, and compare the camera with 0x75520's.
  - Browser: with these draws the headless (SwiftShader) page took 17 s for one frame — full-screen geometry many times over; recheck once the placement is right.
  - Placement: the UI manager renders a car object inside its states' transforms: 0x1398C0 calls the state callback (manager +0x1C = 0x140450) with (1, header + 8) before the state's children and (2, ...) after; 1 → 0x140350 (eax = header + 8: select the view's matrix stack 0x11F870(0x154A20()), push 0x11F8B0, translate position (+0) and pivot (+0xC), rotate x / y / z by +0x18 / +0x1C / +0x20 when set, scale +0x24.., translate -pivot, colour 0x140240), 2 → 0x140420 (pop). The object handler then gets (obj, -2, 0, &0x27D488, 0); 0x9A900 -2 jumps to the callback [0x2F31CC] = 0xEEED0 with (obj[0] slot, obj[2], obj[1], obj[3], obj[4]) (the car's box relative to its state). Now gamecode wraps the -2 in the chain of visible states above the object (uis-natives previewObjects walks the screens as 0x1398C0: state header+0 set, child group word set) → the car lands at x 180-560, y 220-330.
  - Depth: the UI layers' projection is a 20-unit slab (0x761A0 → 0x154AB0(view, 45, aspect, near [0x2B7C4C] = 569, far [0x2B7C50] = 589), set by 0xA1260 for layers 3 / 4 / 6 and by our layer 0); the car spans depths ~525-600, so z/w runs about -6..+7. D3D's ZEnable writes NV097 SET_ZMIN_MAX_CONTROL (0x1D78) from [0x19CEB8] = 0 here: no near / far culling, depth clamped. The soft renderer now clamps depth instead of clipping at the near plane (SOFT_ZCLIP=1: old behaviour) and the page enables EXT_depth_clamp. Soft render at driver select: the #20 Home Depot car, correct place and shape (the back buffer's alpha is 0 where the car is: video ignores alpha).
  - Layering: the page draws the UI over the 3D picture, which would hide the car under the menu background. ui-remote marks the first car object in draw order (uis-render canvas.mark3d) and sends `split` (NT04_PREVIEW only); the page draws UI batches before it into the back buffer right after the frame's clear, the rest over the picture.
  - main.mjs NT04_AUTOPREVIEW=1 (testing): presses to driver select in game time.
  - Now the default (NT04_PREVIEW=0 / NT04_REAL_CAR_MODELS=0 turn it off). Checked with it on: Race Now to the race (det.mjs: two runs identical, new state fe49e9d61f617a26 / steps 6454129350 since the menus now run more game code; the race drives normally — the old race-weekend visibility crash with real car models no longer happens), four season races through the hub (qseason.mjs: same results as with it off), the page at driver select (car shown, game at 60 fps).
  - Depth order fix: clamping wrecked the car's own depth order (its near half all clamped to 0, far half to 1, so parts drawn later — the far side, the cage — painted over the near side). The car shader is a screen-space one (epilogue oPos = oPos * c-38 / w + c-37, c-38.z = 16777215, c-37.z = 0) and the projection (matrix 3: z' = -57.9 z - 33514) puts depth 0..1 at distance ~579-589; the car spans about -6..+7. While gamecode renders the car objects it sets d3d.zRemap: the draws carry it, gl-remote sends the depth scale negated, the page's vertex code then maps depth -64..64 onto the depth range (linear in clip space, so interpolation stays correct) and the soft renderer does the same (z / 128 + 0.5). Soft render and the page now show the car with its parts in order.
  - Checked at driver select: changing driver changes the car (Tony Stewart #20 → Ward Burton #22 Caterpillar), left / right changes the paint scheme (the #20's alternate scheme), the car turns. Screens with car objects (type 2): 0/8 (driver select), 0/9 (2), 0/10 (4), 4/12, 8/4, 8/7, 9/4, 9/32, 9/41, 14/2 (2) — not all visited yet.
  - Leak fixed: the resource unload 0x118E50 / unload-all 0x118F30 only cleared the entry's flags and pointer; like the real ones they now free the block when the module allocated it (flags 2 and 1 set, not 0x40 / 0x20 / 8). Driver select was losing ~260 KB per driver change (40 changes: heap 22.4 → 32.6 MB); now flat (22.2 MB). A driver-select frame costs ~0.7 ms. Race (det.mjs) still deterministic (two runs d611c87d91c34828, steps 6454114464; lane and speed as before), season (qseason.mjs) results unchanged.
- Create-A-Car and the preview modes (the screens with car objects: 0/8 driver select, 0/9 and 0/10 two / four player driver select, 4/12, 8/4 (paint shop lighting), 8/7 (Create-A-Car: New / Modify / Select a Car to Modify), 9/4, 9/32, 9/41 (career), 14/2):
  - The preview is now tied to the game flow: GameCode({ flow }) / this.preview (uis-run passes flow for openScreen(..., "flow")). The direct-screen mode the self-tests use (openScreen(dataDir, 0, 5)) keeps the old stand-ins — there the car object module is pre-loaded before Glib / Sort, so its own code cannot run (the career self-test failed with the preview on: the car paint compositor 0x6DD60 read uninitialised paint images). NT04_REAL_CAR_MODELS defaults to the preview setting.
  - Car paint compositor 0x6DD60 (Create-A-Car paint: templates, sponsors, number decals composed into the car's texture) read a null image: its templates come from carparts.dat, which CarResource opens as a resident archive through 0x118BD0(block, size, "RESIcarparts") after reading the file with the file module's whole-file read 0x1295B0 (not ported, so the block stayed empty) — archive slot 1 (0x28AE48[1]) was null and 0x11A390 got handle 0 for paint parts 15, 107, 158, 179, 192-198... 0x118BD0 is now ported: a resident TERF from memory, or for "RESI<file>" not in memory, <file>.dat from the data folder. Create-A-Car > New / Select a Car to Modify now shows the created car with its composed paint (#192, WM sponsor, Grand Prix body) over the screen's shadow.
  - Checked: self-test suite 28/28 (career setup / save / load included); Race Now race deterministic (two runs 1d5d19280d5852aa / steps 6431159596 — new state since carparts.dat is now open).
  - Walked with the preview on (game flow, scratchpad careerflow.mjs: vm.press codes 0 A, 2 up, 3 down, 4 left, 5 right, 6 B, 7 START; soft render + the UI split around the car object composed into one picture):
    - Features > Create-A-Car: New → Select a Car to Modify → editor tabs Driver (8/3), Car (8/1? Name/Make/Scheme/Number/Style/Decals), Colors (Primary..Roof Outer → colour grid → brightness / RGB sliders), Sponsors: the car moves per tab, and picking a colour recomposes the paint at once (white #192); a colour step costs ~20 ms.
    - Race Modes > Career: settings → Career Startup → Create-A-Car (career car is a grey template until painted) → Sign Team → Sign Sponsors (sponsor decals appear on the car, e.g. Nikon on the hood) → Career main menu 9/0 (car in front of the hauler): player car 187, no game-code errors.
    - Not reached: two / four player driver select (0/9, 0/10): with NT04_PADS=4 the Race Now settings' Players row stays at 1.

- 3D UI states: states can rotate about x and y as well as z (0x140350 → 0x11FBD0 / 0x11FC90 / 0x11FD50; D3DX row-vector matrices, each op applied on the local side; angle * 46603.38 = 2^24 per turn). uis-render used only the z rotation, so the preview screens' tilted floor and the car's ground shadow (4/12, 8/4, 8/7, 9/4, 9/32: state 1/2 floor 23/63 at rot x 32, y 25 then x -90; state 4 shadow 2/24, black with alpha, at rot x 90 under the car) were drawn face-on: a big dark upright blob behind the car in Create-A-Car. uis-render now uses full 3x4 state matrices with the UI camera's perspective, and splits quads that are tilted in depth into an 8x8 grid so textures follow the perspective. The floor and shadow now lie under the car; also changes the tilted track maps (0/3, 4/6, rot x -60) and the US map (15/0). Self-test suite passes.

## Movies
- ea-mad.mjs: EA Madcow video (MADk / MADm / MADe) and EA ADPCM (R1; R2 / R3 state carried) decoders in plain JS, plus the stream chunk walker and the SCHl "PT" header reader. Checked bit-exact against FFmpeg's eamad / adpcm_ea_r1 output: MOVIES.DAT #0 (EA Sports logo, 120 frames) and #5 (255 frames) and UIS_VIDE.DAT #0 (320x240, 2250 frames) — every frame identical; #5's 408,408 stereo samples identical. ~5 ms per 640x448 frame in Node. MAD details: 24-byte frame header (tag, size, 6 bytes, u16 ms, u16 w, u16 h, u8, u8 quantiser, u16), bitstream = LE 16-bit words MSB first; quant[0] = (aan[0]*intra[0]) >> 11, quant[i] = (aan[i]*intra[i]*q + 32) >> 10; DC = (128 + s8) * quant[0]; AC MPEG-1 table (escape: s10 level, u6 run + 1; level = (|l| * quant >> 4) - 1 | 1); EA IDCT with block[0] += 4, columns then rows, >> 4 and clamp; inter MB: 1 bit = intra, else 1 bit (1 = mv map 6 bits, 0 = all 6 blocks predicted), motion 1/1+4 bits (-17 base), per predicted block add = 2 * motion(); MADe is not a reference.
- PlayMovie 0x73840 (ecx file, edx entry, al skippable) queues the clip (gamecode movieQueue) and returns; 0x103B90 (how the last clip ended: 2 back out, 4 previous) returns movieResult. main.mjs holds the game (no frames) while the page plays the queue: it sends {t: "movie", file, index, skippable, id}; the page fetches /movie?file&index (the bundle entry), decodes with /ea-mad.mjs, plays the audio through its AudioContext and the frames through WebGL (letterboxed, 640x448 in 640x480), and answers {t: "movieEnd", id, reason} (0 ended, 1 A / START / Enter, 2 B / Esc: drops the rest of a run). Before the first page connects the boot movies wait for it; with no page after that (or NT04_NO_MOVIES=1) the queue is dropped. Boot now shows the EA Sports logo and a random driver clip (e.g. #23) before the title.
- Menu videos: texture groups registered with kind 5 in the UI texture tables (0x226C78..: 14 uis_vide, 32-35 uis_cvd1-4; record {id, 1, kind, name, ...}, kind 4 = MMAP textures) are EA Madcow clips; only two elements use them, both with element flag 0x20 (set on nothing else): main menu 0/0 state 1 element 0xE760 (14/x, the panel right of the menu: uvs 0.117-0.617 x 0.03-0.88 of a 512x256 texture = the 320x240 clip; vertex colour authored ff0000ff, the script fades alpha 0x91 -> 0xFA; the element draw path 0x143DC0 has no 0x20 test; drawn as authored the footage came out red (user report), so uis-render now keeps a 0x20 element's alpha but not its colour) and Lightning Challenge 13/0 state 1 element 0x6F40 (32/0, a 320x240 panel; state 1 sits at x 1380, off screen; the script slides it in / out (L_C700: tween to 952.5 / 975, or 1380) from the A handler when the screen's page variable says so — not reached in testing, A went straight to the race). The main menu script steps the element's texture entry 0,1,2,3,4 every frame (vm frame trace), so the entry is not a clip choice: uis-render treats group 14 as one channel (texture "14/*") that plays the bundle's clips in turn; cvd elements play the entry they name, once, with sound.
  - uis-render Assets.video: { width 512, height 256, video: { file, index, playlist } } (rgba = the first frame, decoded only when a software canvas draws it; null when the bundle is missing); ui-remote sends video textures as { id, w, h, video } with no pixels; the page (uiVideos) fetches /movie?file&index when a batch has drawn the texture for 300 ms (the menus flick through ids while opening), decodes frames by clock into the texture's top-left (texSubImage2D), plays the soundtrack, stops when the UI has gone on without it for 1 s, catches up by skipping time after a page stall (no soundtrack). /movie now reads one entry with terf.mjs readTerfEntry (header + one positioned read) instead of loading the 100-300 MB bundles.
  - Checked: headless page at the main menu, the race footage plays in the panel (clip #0 advancing with the clock through page stalls), page at 60 fps; soft render of the main menu shows the first frame in the panel. Going on to the next clip at the end of one (74 s) not watched.
- What's New (Features): 0x8E620 calls PlayMovie("whatsnew.dat", 0, skippable), so it already goes through the movie queue (checked: Features > What's New queues it; the page plays it like the boot movies).
- Not yet: WHATSNEW.DAT (0x8E622); the Lightning Challenge interview panel (see above).
- Stale page after a server restart (user report: black video panel, X / Y / Quick Save button icons as white and pink boxes): the page reconnects by itself when the server restarts, so it kept the previous play-client.js, whose UI-message reader expected pixels for every texture; the first video texture (no pixels) threw, which left the video texture empty (black) and skipped every texture after it in that message (the button icons, drawn untextured). Now main.mjs appends CLIENT_VERSION (hash of play-client.js) when serving the script and sends { t: "version" } on every connection; a page with another version reloads itself. The UI-message reader also handles each texture in its own try / catch.
- Random numbers: the game's generator ([0x2F2D84]; 0x14A10(n) = random below n via 0x120C70) is seeded once at boot by 0xA3B10: rdtsc (0x120CB0) -> 0x149A0(eax = seed) -> 0x120C20(0, seed). The emulated rdtsc counts instructions, so every boot drew the same numbers: the intro's driver clip (0x9DE07: PlayMovie("movies.dat", 0) then PlayMovie("movies.dat", random(0x31) + 1, skippable)) was always #23. GameCode({ seed }) replaces 0x149A0 with the given seed; main.mjs passes one from the clock (NT04_SEED=n to repeat), the tests pass none (unchanged, deterministic). Checked: seeds 3735928559 / 2654435761 / 4000000000 / 777777777 / 3141592653 give clips 21 / 13 / 47 / 45 / 5 (nearby small seeds give the same clip: the first draw depends on the seed's high bits).
- Boot "Unable to load System Settings from hard disk" (user report, with the dialog flicking past): every boot with a settings save on the hard disk failed to load it, also a save written by this same build. The cold-boot memory-card state machine (0x104xxx, screen 6/0) reads the save asynchronously (0x1139E0 queues fread on the worker; 0x114060 polls), checks the signature (0xE63F0: HMAC over the 832-byte DB image, matched), then loads the image from memory with 0x147780("ncar", reader 0x2DE750, 3, ops 0x205FC8) (0xE5B30). Our 0x147780 bridge read in 32 KB chunks from the start, and the memory reader refuses a read past its end, so it got no bytes ("not an EA DB file") and the load failed. It now reads the 12-byte DB header first and then exactly the rest. Boot with a settings save now goes "Load successful" -> main menu (the user's own save too). Season / career loads read the same way (self-test passes).
  - Also on the way: FATX directories now report one 16 KB cluster as their allocation size (XFindFirstSaveGame counts it: a save is ceil((image + 3 clusters) / 16 KB) blocks; the settings save came out one block short and was marked damaged by 0x105630), and NtQueryInformationFile class 6 (internal / file index) is answered (it was refused at every boot).
  - det.mjs: new state 5d15b588f5bef64b / steps 6465529407 (two runs identical; the boot path changed with class 6), race drives normally.
  - Debug: NT04_TRACE_SIG (SHA calls), NT04_TRACE_SAVESIZE (save size / read / poll results), NT04_FSTRACE (file opens and reads).
- Boot memory-card walk (user report: "Checking controller N, expansion slot X" cycling with a harsh sound): after the settings load the cold-boot check (screen 6/0; game natives for group 6 at 0x82800, table 0x82A24) walks devices 0-8 for Create-A-Car / profile saves: native 1 -> 0x91090(ecx = step) moves the device (0x104290 -> [0x2F2D4C]) and starts its check (process 6 state 0x74); each device reopens the "Please wait" box 2/7 (0x13A330 re-sends -2: its enter script plays sound 0x40008), and an absent slot answers at once (0x111580: status -2 when 0x111210(dev) & [0x22E810] is 0), so eight messages went by in ~0.5 s with eight overlapping pop-up sounds. That is the game's own walk; at the user's choice 0x91090 is now replaced: it skips devices that are not present (only the hard disk here). NT04_MU_CHECK_ALL=1 restores the full walk. Boot with a settings save: Loading System Settings -> Load successful -> main menu, one pop-up sound; a fresh save folder still asks about Autosave. Self-tests pass; det.mjs d33e003c417fe22a / steps 6462359571 (two runs identical).
- UI video playback (the game's library: element method 8 -> 0x1406D0(cache, group, entry) starts the texture's clip when the busy flag 0x27DC6E is clear; method 9 -> 0x140710 stops it; byte 0x2186D8 = ended / idle (1 at load, 0 while a clip plays, 1 when it ends), read by 0x1406C0 = global native 0x41 and the 13/0 per-screen native 6 (0x8B9A0)). uis-vm now keeps UIVM.video = { element, group, entry, t0, dur, seq, ended } for methods 8 / 9 (one clip at a time; stopped too when its screen closes), ends it after the clip's length (sum of the MAD frame headers' ms, Assets.videoDuration), and native 0x41 answers from it (it was a constant 1).
  - Main menu: native 0x41 = 1 made 0/0's frame handler (0x17041: if ended -> method 9, next clip from its table [0x11C] (L_16049), method 8) step to the next clip every frame — that was the 0,1,2,3,4 entry cycle. Now one clip plays to its end (74 s), then the script picks the next. The "group 14 is one channel" stand-in and the page's playlist are gone.
  - Lightning Challenge (13/0): A on a challenge (L_BEA9 -> L_C700) slides in the TV panel (state 1) and, when it arrives (tween callbacks 0xC8A2 -> 0xC9DC), sets the element's clip from the challenge number [0xAC] (L_9938: 0-12 uis_cvd1, 13-25 cvd2, 26-38 cvd3, 39- cvd4, entry = number mod 13) and starts it (L_9AE7: alpha 0, method 8, fade-in rate 0x9B99); a 50 ms poll (0xC8CF) starts the race (L_BEA9 again) once the video has ended, A ("CONTINUE") starts it at once. Before, nothing played, the video counted as ended and the race started right away. Checked: Rookie "Hold 'em off" (challenge 28) plays UIS_CVD3 #2 (64.8 s) in the TV, in the soft render and in the page.
  - Rendering: a video element (flag 0x20) on a live screen is drawn only while UIVM.video plays on it (renderScreen opts.video / opts.base); its texture is per playback (Assets.videoPlay(group, entry, seq)), so the page starts each playback afresh; the page plays it once (sound too), holds the last frame, keeps the last three clips.
  - main.mjs testing aids: NT04_AUTOPRESS=7,0,3,... (UI messages to the VM, 2.5 s apart), NT04_AUTOKEYS=START,A,DOWN,... (pad presses). uis-vm NT04_VM_WATCH=<hex address> logs script stores to it.
- Race depth near the camera (user report: track and walls "clipping" behind the car at the left and right of the screen): the screen-space vertex path (game epilogue oPos.xyz = oPos.xyz / w * c-38 + c-37, oPos.w = w) is turned back into clip space as (nd * w, w), which is linear in clip space only if every term is; the depth term was min(zn * 2 - 1, 1) (added to keep the sky, at z ~1, from being far-clipped before depth clamp was on). For vertices behind the camera (w < 0, the big track and wall polygons beside the car) zn = z / w is past 1, so min() cut their depth to w and the depth across those polygons was wrong — the track and walls showed through at the screen sides. With EXT_depth_clamp on (the hardware's ZMIN_MAX_CONTROL = 0) the far clamp is not needed: depth is now zn * 2 - 1, linear. (Briefly tried: depth clamp only for the car preview — near-plane clipping in the race instead; reverted, clamp stays on everywhere as the hardware does.) Soft renderer unchanged in effect (clamp everywhere).
- Race audio crackle / distortion (user report): the software mixer (audio-mix.mjs) resampled every voice and stream by taking the nearest source frame (pos | 0). The engine sounds play at a rate the game changes every frame, so nearest-frame picking aliased (the output showed sample-and-hold steps) — a harsh, crackling tone that grows with the revs. Voices and streams now interpolate linearly between the two nearest frames (across the loop point / into the next stream packet). Same 20 s of a race: second-difference spikes > 0.15 2091 -> 89, energy above 12 kHz 7.0% -> 3.2% of the spectrum, peak unchanged. Play positions (GetCurrentPosition) unchanged; det.mjs unchanged (d33e003c417fe22a).
- Driver select car number (user report: always "9"): the number graphic (0/8 state 11 element 0x6D60, texture group 6 uis_drnm) gets its texture from global native 1 (0x7A7A1 -> 0x79F60: the driver's car number / paint scheme from the database, out-params -> element method 5); the JS native 1 was a stand-in returning 0 without writing them, so the element kept its authored entry (1, a "9"). With the game's code present native 1 now runs there (GAME_FIRST): Tony Stewart -> entry 34 ("20"), Kenny Wallace -> 115 ("23"). Also used by 0/4, 0/9, 0/10, 4/2, 4/7, 4/17, 9/15, 9/18. Self-tests pass; det.mjs new state f3082f1a6f40000d / steps 6665422313 (two runs identical; more game code runs at driver select).

## Loading-screen freeze (page side)
- Symptom: page at ~1 fps (1225 ms/frame) on the race loading screen while the game ran at 60 fps with 3 draws/frame.
- Cause: the race's vertex programs arrive as "vs" resources during loading. Each one was compiled and linked synchronously against the big generic FRAG shader, which blocked the browser's main thread.
- Fix (play-client.js):
  - "vs" now only queues the compile and link.
  - With KHR_parallel_shader_compile, `baseProgram()` finalises the program only once COMPLETION_STATUS_KHR is true; until then, draws using that program are skipped. These are only loading-screen frames.
  - Vertex constants are copied into `consts` before the skip check, so skipped draws don't lose state.
  - Without the extension, programs are still linked immediately.
- Verified: headless race renders normally. SwiftShader doesn't compile in parallel, so its timing numbers aren't representative.
- Follow-up (still freezing for the user): programs are now linked on first use, not when the "vs" resource arrives. A draw asks for its specialised program (small straight-line fragment shader); the general FRAG program is only linked when there is no pixel state or specialising failed. Draws whose program isn't ready are skipped. On vertex-program redefinition the old specialised programs are dropped too (they used to linger).
- Slow page frames (>150 ms) now show a breakdown in the status line for 15 s ("slow frame N ms: texp8×4 24, shaders×1 4751") and in the console, to pin down what a real GPU stalls on.
- shaderbench (artifact) times the race's real shaders on the viewer's GPU: general compile, one waited general link, background general links, background specialised links (with frame gaps).
- User report after lazy linking: "slow frame 1545 ms: buf×1892 10, texp8×201 119, shaders×18 1411" on the first race frame (race-week menu over the track). Cause: every draw that wanted a still-building program asked getProgramParameter(COMPLETION_STATUS_KHR), which is a synchronous round trip to the GPU process. ~1,600 draws per frame meant hundreds of round trips. Now each pending program is asked at most once per page frame (`built()`, `frameNo`). The status breakdown splits shader time into start / check / finish.
- Driver-select hitch: the server's "emu max 160 ms" — the game loading the car model (game side), not the page.
- Building ahead (play-client.js, "nt04.shaderCache" in localStorage): gl-remote sends a race's vertex programs and pixel states only when they are first drawn, so they arrive with the race-week menu's first frame, after the loading screen. Waiting for them always meant a hitch. Now:
  - The page keeps each used (vertex program source, pixel state) pair by content hash, up to 400 pairs. It is seeded with the 20 pairs of a recorded race.
  - When the page opens, it builds them in the background, 3 per animation frame. Draws adopt them by content (`pre_spec` / `pre_gen`).
  - A test race matched all 20 seeded pairs; only 4 new pairs were added.
  - These programs outlive reconnections, so `last.ps` is reset on close (pixel state ids start over).
  - A redefined vertex program keeps its programs in progList.
- Race loading screen ("Grudges & Alliances", loaddata.dat): the game's own loading finishes almost at once here (reads are instant), so its progress bar fills at once and "Press START" appears immediately. The black second before it appears was the fade-in, drawn while the screen's program was still building (skipped draws). Building ahead covers that from the second time on.

## Race loading screen: fade-in and loading bar (live)
- What the game does (0x733C0 enter / 0x73660 exit, called by the loading processes' Enter/Exit at 0xA1A20…0xA1C10):
  - It shows a loaddata.dat tip image and fades it in synchronously: 63 presents of 2D quads, plus a quad that samples the target itself (blending with the previous picture).
  - For the tip screens (0x72F30 / 0x73210) it starts thread 0xEC800 (via 0xECD10). Every 16 ms the thread:
    - advances the fake progress (0x73580: [0x2B7878] += [0x2B7884], decelerating; 0x2000 per step once 0x2F3053 says loading is done);
    - copies the bar image (unswizzled at [0x2F34A8], pitch [0x2E073C]) straight into the locked front buffer (0xEC6D0), up to the bar quad's right edge (quad at [0x2F34AC]: x0, y0, …, y1 +20, right edge +24). There is no present.
  - Exit sets 0x2F3053 and spins (0x72B70) until the progress is full, then stops the thread.
- Why it was never visible here:
  - The whole load runs inside one emulator frame (~2.7 s in a test): fade, race load and exit.
  - Game time (g.ms, KeTickCount, thread sleeps) stood still for that long call, so the thread never ran. The 0x72B70 hook then filled the bar at once.
  - Flow control dropped all but the first ~6 fade frames, since no acknowledgements arrive during a long call.
  - The fade quads come from a pass-through ("screenspace") vertex program. gl-remote marked only programs that read c-37 as screen space, so these were drawn as clip space, far off screen (black).
- Now:
  - **liveClock** (gamecode, main.mjs sets g.liveClock / g.liveMark per frame while a page is connected): past 33 ms into a frame, cpu.onTick moves game time with real time. The bar thread runs in real time during the load. The 0x72B70 hook lets it finish in real time (spinning main thread: 2 ms waits, then the threads get a turn), with the old fill as a 3 s fallback. Offline (tests, det.mjs) nothing changes: det.mjs gives f3082f1a6f40000d / 6665422313 as before.
  - **Urgent frames** (gl-remote): in a long frame, frames are recorded without credits, sent at once, and marked `hold`. The worker's results come back on a MessagePort, drained synchronously with receiveMessageOnPort + Atomics.wait, so order is kept. Before the first one in a frame, the UI layer is sent (beforeUrgent → sendUI), so the closed menu doesn't stay over the loading screen.
  - The page shows held frames one per refresh (holdUntil), so the fade plays at 60 fps.
  - **0xEC6D0 hook**: the bar becomes OP_BLIT (texture id, source size, x, y, w, h). The bar image is sent once as RGBA ("rawtex"). The page draws that part of it into the last presented target and shows it (frontBlit, nearest sampling). Offline the hook runs the original copy (passThrough).
  - All game vertex programs are treated as screen space (screen = true). Every race program already was.
  - Page: a draw that samples its own target gets a copy of it (selfCopy, copyTexSubImage2D), instead of the white blank texture.
- Windows follow-up (user video): the fade frames and the bar only reached the page after the long call (page queue of 60 frames, then played back quickly). From the emulator thread a socket gets only its first write out during a long call: Node issues the next write after the previous one's completion, which on Windows (IOCP) needs the event loop. The HTTP server and WebSocket now run on their own thread (net-worker.mjs):
  - main.mjs posts each page message to it (bytes that own their whole buffer, over 4 KB, are transferred);
  - it posts back HTTP requests (answered by main's `answer()`), the page's messages and open/close.
- After a long live frame, main.mjs no longer catches up. The game clock already advanced with real time, and the race-week frames after the load used to run back to back at ~90 fps (ack 700-1300 ms).
- User video 3: the loading screen stayed dim under the bar, then jumped to the bright "Press START" with a burst of noise.
  - Dim: on a fast computer the whole fade (63 presents) ran within the 33 ms before a frame counts as "long". Only the first few dark frames got credits, and the rest were dropped. Now a frame that follows a present in the same main.mjs frame is also taken without a credit and held (presentStep / g.stepNo). main.mjs calls remote.stepBegin() each frame to give the credit back when no second present came. A capture with time-based urgency off (barcap FAST) now gets all 65 fade frames, 64 held.
  - Noise: the sound mixed during the long call (game time now runs, so sounds play through the load) came out as one block of up to 2 s at the end. gamecode liveTime now calls g.onLiveTick every 50 ms of a long call, and main.mjs sends the mixed audio then.
- Aspect: the race loading screen is a 2D picture drawn into the 640x480 back buffer, and the page stretched it over the 16:9 view. The "Press START" screen after it is the UI layer, which shows 4:3 screens 4:3 in the middle of its 854x480 space, so the switch was visible. gl-remote now marks frames sent while [0x2F3052] is set (`fit43`), and the page draws the back buffer into a centred 4:3 viewport for them.

## Race HUD under the pre-race presentation
- The race frame (0xEBC8C..) draws UI contexts 5, 1, 6, 8, 3, 4 every frame through 0x75430 (eax = context: the layer item [0x2B7C48 + ctx*32] -> 0x75410 -> 0xEDB20 -> 0x13AA60 manager render) and runs their managers (0x75500).
- The HUD's context 2 is updated and drawn by 0x708A0 only while byte [0x2F304A] is set. That is 0 under the pre-race presentation 3/18 (where the HUD 10/0 is already open), and 1 from the race proper.
- The VM drew every open screen. The race puts managers of its own into table entries 1, 2 and 5, so the VM context of their screens (ctxOf, from the pointer) is not the entry index (HUD: VM ctx 9 = entry 2). gamecode now records the mapping when a manager opens or notifies (uiCtxIndex). uiContextDrawn(vmCtx) answers for entry 2 (when it holds a race manager) from [0x2F304A]. uis-run sets vm.drawn, and ui-remote / main.mjs skip screens that aren't drawn. Checked: HUD hidden during 3/18 and right after it, shown once [0x2F304A] = 1. uis-vm-selftest passes.

## Race car-number badges (the white boxes)
- The race draws a badge for each nearby car at the bottom of the screen (and a drop marker over allies / rivals). 0xED090 builds per-car textures at race load: 0x13ECD0(cache 0x13E750(1), group 10 = uis_smnm, entry = car number from the car record +0xC0), then reads them back with 0x1426F0 (= 0x13E660), plus entries 125-127 (circle, drop, glow) into 0x2E0750 / 0x2E0808... 0x741D0 draws them through 0xED2E0 / 0xED320 / 0xED3D0: material 0x133620(0x2F9520, [obj+0x14], [obj+0x1C]) and Glib quads.
- The game's UI resource caches are never created here (the UI system is the JS VM; UIStudio is denied), so 0x13E750 returned 0, the table stayed empty, and the badges drew with whatever texture was bound last (an 8x8 one): white boxes. They only show with the user's settings (HUD indicators): run harnesses with NT04_SAVE / saveDir set to a copy of the user's save.
- Bridge (gamecode uiCacheHooks):
  - 0x13E750(n) returns a dummy cache.
  - 0x13ECD0(cache, group, entry) loads the MMAP entry of the group's bundle (live table: textureGroupHooks), relocates it with 0x155910 and fills in what the cache's loader makes:
    - a D3D texture header (common 0x40001, data = pixels at 0x80 + desc+0xC, format word 0x29 | fmt<<8 | 1<<16 | log2 w<<20 | log2 h<<24, size 0);
    - a palette header (common 0x30001, data = 0x80 + [palette header + 8]).
  - The material call reads them as handles, so the block's +0x14 / +0x1C point at cells holding the header addresses.
  - 0x13E660 returns the block.
- Texture groups: the UI modules register id -> bundle tables with 0x76600 (eax 1 = textures; frontend 0x226AF0, in-game 0x226E20, where group 5 is uis_drps rather than uis_drpo) and drop them with 0x759B0. gamecode keeps the live mapping (texGroups), which the renderer uses too (Assets.groupOverride).
- Checked: test race with the user's settings shows the badges (numbers on circles); uis-vm-selftest passes. det.mjs state is now 11957ac8a8c64c16 / 6463654035 (heap use changed).

## Other borrowers of the UI resource cache; 3D objects of UI type 4
- Callers of the cache API outside the UI code: badge textures (0xED090, race), driver-list numbers (UISCommon-era module 0xA0EA0 / 0xA0F70: uis_smnm entry 0, one per DB row, 125-127), the flag object (UISFlagObj Load 0xEF660: uis_modl 1 model, uis_text 1 texture set, uis_anma 0 animation; Unload 0xEF790), the trophies (0xEE100 load / 0xEE1E0 draw / 0xEE180 release: uis_modl id, uis_text id + 90), model 0x34 (0xEDE70 / 0xEDF50 / 0xEDEF0), group registration inside 0x76600 (0x13EC50) and its unregister (0x766A0 → release -2), cache creation 0xA1200 (0x13E560 / 0x13E740; UISCommon Load 0xA1260, not loaded here), the "is it loaded" native 0x79E20 (0x13E920), the per-frame step 0x9DEC0 (0x13E8B0).
- The real fetch 0x13ECD0 returns the loaded entry (resource module 0x11A390), then post-processes it by the group's kind (record +0x10, the table's +0x10 byte): 4 texture → 0x142770 makes the texture object (what get 0x13E660 returns), 8 font → 0x1424C0, 2 video → 0x140540, 1 raw (uis_modl, uis_anma, uis_text) → nothing: the caller parses it (0x1322F0 Glib model chunks, 0x134930 texture set). Release 0x13EE30 counts references down (u16 per entry), unloads at 0 (0x118E50); entry -1 = every entry once, -2 = all.
- The bridge (uiCacheHooks) now returns the loaded data from fetch (it returned 0: the flag and trophy code pushed that straight into the model loader), keeps texture-object filling for kind-4 MMAP entries only, counts references and frees on release, answers "loading?" with 0 and makes register / archive / per-frame / flush / archive-handle no-ops (they used to write through the null cache's record table at low addresses).
- Texture-group tables of the UI modules the VM replaces: UISCommon (common 0x226A48) and UISFrontEnd (frontend 0x226AF0) are not loaded (moduleFilter), so their Loads never registered their tables and every front-end fetch failed (no names). moduleFilter now adds those tables when it skips the module's Load and drops them at its last unload (UI_TEX_TABLES); the kind byte is kept with each group (texGroupKinds).
- UI object type 4 (handler 0x9AB70) is not "audio": objects { u16 7, u16 id } are 3D objects — id 1 the waving flag (draw 0xEF8C0), 2..0x33 trophy models (0xEE1E0), 0x34 another model (0xEDF50); id 0 does nothing. -1 loads, -2 draws (the UI manager's per-frame render message), -3 releases. Screens: 0/12 Trophy Room (id 2; its child group stays off with the saves tested — presumably on only for a trophy won), 15/0 the US track map (flag, state 70 under 50), the car screens carry an id-0 one. The earlier note calling 0xEE100 / 0xEE1E0 the "EA Trax jukebox preview" was wrong.
- With the preview on, uis-natives previewObjects now also lists visible type-4 objects (id 1..0x34) with handler 0x9AB70, and gamecode's front-end render sends them -2 every frame inside their state transforms like the car objects; the VM's open-time -2 for type 4 is dropped (vm.lifecycleSkip), -1 / -3 unchanged. uis-render marks them as a 3D split point (UI before them goes under the 3D picture).
- Checked: soft render of 15/0 with state 50 / 70 forced on: the 3D flag (blue, logo, waving) over Alabama — 2 draws per frame; 0/12 with the id-2 object's states forced on: 1 draw per frame (trophy model loaded: uis_modl 2, uis_text 92). Race badges still textured (texfail.mjs, user settings). uis-vm-selftest 28/28. det.mjs two runs identical: 806b40e2b9414bae / steps 6463607515.

## Replay screen ignored the pad after the race
- User report: after a race the selection could not be moved until the next replay clip began.
- The replay screen 3/3 locks its input when it opens (system -2 → global 0x5F9: native 0xE9 + set_flags = every controller masked); the only unlock is its handler for game event 30 (the reel's lap / position info; → global 0x610: native 0xE9 + clear_flags), sent at every reel start.
- At the end of the race the game calls open 3/3, activate 3/3 and notify 30 back to back (370.17 s in the test race). Open and activate are queued messages; notify, with the UI idle, was delivered at once — before the queued open, so no screen 3/3 existed to receive it. The first reel's event was lost (its "Reel 0 - Time 00:00:00.000" label also stayed at zero), and the screen stayed locked until the second reel's event 30 (~10 s later, with the 3/14 reel wipe).
- Fix (uis-natives ui.notify): when idle, messages still queued are run first, then the event is delivered (at once, so arguments pointing into the caller's stack stay valid). Inside a script it is still queued.
- Checked (postrace.mjs: bot race to the flag, then LEFT every 1.5 s): 3/3's input unlocks at 370.2 s, right at open; the first press moves the toolbar from Exit to Hide Display, the next to Advance Reel. uis-vm-selftest passes; det.mjs two runs identical: 7eda2b5be7a4b649 / 6463607514. uis-vm has an optional traceFlags(sc, pc, code) hook for input-mask changes.

## Race HUD EA coin showed flag colours all the time
- User report: the round EA logo in the race HUD had flag colours in it all race; the real game shows them only when a flag is out.
- The coin (10/0 states 3 > 5 > 6; also 3/17, 3/18, 11/0, 12/0) is two-sided: state 5 holds the front logo (el 0x6460, comn 0) and, before it, state 6 turned 180° about y (the back): its logo (0x6340) and the flag discs (uis_ig 3 white disc ×2 tinted by script, 4 checkered, 5 dark). The coin turns round to show the flag.
- Element flag bit 2 (0x4) is the back-face cull switch: the element draw 0x143DC0 sets Glib state 0x93 (D3D cull mode, 0x131B60 → D3DDevice_SetRenderState_CullMode) to 0x900 (D3DCULL_CW) when it is set, else 0 (none). Only these 16 coin logos in the whole UI have it. uis-render took the bit for "additive": the front logo was added over the discs behind it, so their colours showed through.
- Fix (uis-render drawElement): bit 2 = drop the element when its projected quad faces away (front faces wind the way every normal element does); always normal alpha blend. Checked: static 10/0 render shows a clean logo; with state 5 turned 180° the flag side (discs) shows instead; a live race frame shows both HUD coins clean; uis-vm-selftest passes.

## UI object type 8: the immediate-mode ellipse (speedometer disc)
- Only one type-8 object exists in all the UI: race HUD 10/0, state 16 (in the speedometer cluster, state 8 at 153.5, 314.5; state 16 at +99, +27 = the centre of the MPH bubble). Type 7 is unused.
- Handler 0x142200: -1 0x1419A0, -2 draw 0x142100, -3 0x1419F0; methods 0..13 store their arguments in the object (0 centre +0x3C/+0x40, 2 radii +0x2C/+0x30, 3 / 4 start / end angle +0x34 / +0x38, 6 / 7 colours +0x14 / +0x18 as r, g, b, a bytes, 8 u16 segment count +0x10, 9 / 10 texture via the texture cache, 11 u16 +8/+0xA, 12 / 13 first colour byte) unless byte +1 bit 7 is set.
- Draw 0x144690: material (untextured unless flag 4), cull off (Glib state 0x93 = 0), world / view from the UI state stack (0x1447E0), then D3D immediate mode: Begin(TRIANGLEFAN) (TRIANGLESTRIP when flags & 5), per vertex SetVertexData4ub(diffuse, r, g, b, a) + SetVertexData4f(position, x, y, 0, 1) (callbacks 0x144630 / 0x1445C0), End. Vertices 0x1415F0: the centre in colour +0x14, then segments + 1 rim points at (cos a · rx, sin a · ry) + centre for a = start..end (flag 0x10: 0..360); flag 0x20 shades the rim (towards +0x18). 0x141A00 is the scaled / textured variant (flags 1 / 4), unused.
- The HUD's object: flags 0x5A (full circle), 10 segments, radii 30 x 27, colour (100, 100, 255, 150) set at load by methods 6 / 7. Drawn after the MPH face (3/13) and before its chrome rim (3/12) and white ring (3/0): a translucent blue disc over the speed readout.
- The VM had no handler for it (method calls were dropped) and uis-render did not draw it. Now uis-vm fanHandler stores the method arguments and uis-render drawFan draws the fan (state transform and colour applied like elements; textured / scaled variants skipped). Checked: static and live race renders (speedometer face blue-tinted), uis-vm-selftest passes, det.mjs unchanged (7eda2b5be7a4b649).
- No real-console reference was available to compare the tint against.

## Driver-select entry freeze (database joins)
- Entering driver select (Race Now → 0/8) cost one ~400 ms emulator frame (server-side, renderer attached; changing driver there costs ≤ ~45 ms). CPU profile: ~300 ms in nascar-db #select — the screen's queries join CARS / ULDR / CRSK (16 count(*) queries ULDR ⋈ CARS, a cursor over CARS ⋈ ..., CARS ⋈ CRSK), and the join was a nested loop that built a context object for every row pair.
- Fix (nascar-db #select): hash join when the ON condition is (or ANDs in) an equality between a qualified column of the joined table and a value known before it (another table's column, a parameter, a number); the candidate rows come from a per-join index and the full condition is still evaluated on them, so rows and their order are unchanged. Keys follow the queries' loose "=" (numbers and numeric strings meet as numbers, "" as 0, null never matches).
- Result: entry frame 336–405 ms → ~50 ms (now the car model load and first draws); the slow queries now take 0.5 ms each. Checked: nascar-db-selftest, uis-vm-selftest, det.mjs unchanged (7eda2b5be7a4b649), and qseason.mjs (four season races with qualifying) gives the same results and the same final database (hash de48f53d8290f7d5) with the old and the new module.

## Slow-frame survey (menus, season hub, race weekend)
- scratch survey.mjs: a press sequence through the flow with the remote renderer recording every frame; logs frames over 30 ms with the screens, database time, script instructions and arena bytes; PROFRANGE=a-b CPU-profiles those frames.
- Findings (before → after):
  - Season hub (4/9 with 4/6, then 4/8): the game recomputes standings with ~2,900 small queries over two frames (190 + 137 ms, ~180 ms of it database); opening 4/8 runs 678k UI script instructions in one frame (198 ms).
  - Fixes: (1) nascar-db: one-table WHERE conditions compiled to row predicates (cached per condition node; same semantics as #eval — note a column's `table: null` is not a parameter name), equality indexes on a table field for "= parameter / number" terms (rebuilt when the rows array, its length or the insert / delete counter changes; an update drops only the indexes of the fields it sets; invalidate() after nt04-config's and qualifying's in-place row edits), and a fast path for one-table selects with plain columns (no context objects). (2) uis-vm run0: the operand / stack helper closures were created for every instruction; now once per script (about 2x on the interpreter).
  - After: those queries 181 → 53 ms; hub frames 190 / 137 / 198 ms → ~155 / 63 / 104 ms (what is left of the 155 ms is game code).
  - Race-weekend first frame after the loading screen: 415 + 673 ms (game's first frame of the scene, then ~78 MB of new textures / buffers captured in one frame). Not changed beyond: gl-remote's frame arena now starts at a size hinted by recent frames (with the worker each frame got a fresh 1 MB arena that regrew). Steady race frames only carry ~0.1 MB.
- Equivalence: every query of a season-hub run (7,766) and of a Race Now run into the race (7,974) recorded and replayed on the old and the new database module: no difference in any result, identical final databases. Also nascar-db-selftest, uis-vm-selftest, det.mjs unchanged (7eda2b5be7a4b649), qseason.mjs same results and final database hash (de48f53d8290f7d5).

## Race-weekend first frames after the loading screen (capture cost)
- Frames 1546-1548 of a Race Now run (worker packing, credits every frame, stepNo advanced per frame as main.mjs does): 1546 is the game's own first frame of the scene (~350 ms of game code, nothing captured); 1547 captures the whole scene for the first time; 1548 still costs ~250 ms of capture (gl-remote code paths running cold: constants 45 ms, pixel states 48 ms, textures 40 ms), 1549 on ~60-100 ms, then ~20-45 ms.
- 1547 carried 78 MB: texture0 copied w × h × 4 bytes of every new texture whatever its format (8× too much for DXT1, 4× for P8). Now level 0's real size: pitch × h for linear, w × h × bytes-per-pixel for swizzled, 4×4 blocks for DXT (unknown formats keep the old bound) → 21 MB.
- The frame arena was one buffer that doubled and copied itself as a heavy frame filled it (and with the worker every frame starts from a fresh arena). Now resource bytes go into 1 MB chunks (a bigger one for a bigger item) that are transferred to the worker as a list; an address is chunk × 2^32 + offset. (The size hint added the step before is gone: after a spike it made every frame allocate a big arena.)
- Frame 1547: ~673 → ~250 ms. Packed output unchanged: 1,682 frames of the same run hash identically with the old and the new gl-remote, in-thread and with the worker (91,194,356 bytes, 6da9bcf623580969).
- Still open: the game's own first frame (1546) and the cold capture paths (1548).

## Page: paletted textures expanded on the GPU
- User video (race weekend appearing after the loading screen): page status "slow frame 240 ms: buf×1892 36, texp8×208 109, shader finish×19 90" — the page's own hitch, now bigger than the server's. Server side: game 60 fps, emu max 7-16 ms in the race; page 59-60 fps.
- texp8 (P8 textures: indices + BGRA palette): the page expanded every texel through the palette in JavaScript and uploaded RGBA (4 bytes a texel). Now (play-client palExpand) the indices go up as an R8UI texture and the palette as a 256 × 1 RGBA texture, and a pass draws palette[index] (texelFetch) into the texture's own RGBA storage through a scratch framebuffer; the draw state cache is reset after. One byte a texel crosses to the GPU, no per-texel JavaScript. ?palgpu=0 keeps the CPU way.
- Checked (scratch rwreplay.mjs: 1,741 frames of a Race Now run recorded from gl-remote, replayed into the page in headless Chromium / SwiftShader with ?pace=0): the back buffer after frames 1600 and 1741 (race weekend) is pixel-identical with ?palgpu=0 and =1; no page errors. SwiftShader runs the GPU on the CPU, so the gain cannot be timed there.
- Not changed: shader finish (programs first needed by the race weekend; built ahead from the page's cache once seen) and buffer uploads.

## Page: shaders built ahead are finished ahead too
- The race weekend's first page frame also spent "shader finish×19 90 ms": programs built ahead in the background (localStorage cache + seed) were only finished (link status, uniform locations) when a draw first needed them.
- play-client finishTick: after the building-ahead queue empties, the page finishes those programs as their builds complete, up to 4 per animation frame while idle (1 without KHR_parallel_shader_compile); generic ones are completed in place (Object.assign into the entry e.gen points at), specialised ones get ready / prog as programFor would. finishLink also makes one pass over the active uniforms instead of two.
- Checked (rwreplay.mjs, page opened 40 s before the 1,741-frame Race Now stream, fresh localStorage = seed only): programs finished inside frames 25 → 5 (those not in the seed); back buffer at frames 1600 / 1741 pixel-identical to the previous client.

## Mode sweep (menus and challenge modes)
- scratch modes.mjs: from the main menu, a press sequence (vm.press), then optionally DRIVE=s seconds of the race bot; reports screens per press, game stubs reached (kernel / database / UI-manager noise filtered), VM log lines, game errors, and UI pictures.
- Entered every item of Race Modes (SpeedZone 16/x, Lightning Challenge 13/x, Thunder License 15/x, Season 4/x, Career 9/x), Features (What's New — plays its movie, NASCAR 101 0/14, Create-A-Car 8/x), My NASCAR (EA SPORTS Bio 14/2 "no Bio found" prompt, Trophy Room 0/12, Thunder Plates 0/11, Best Laps 0/7, Gameplay 1/x and System Settings 1/x) and EA SPORTS Extras (Season Previews 14/3, Find MRN Radio 14/1, Credits 14/0), two presses deep: no VM errors, no game errors, no unported stubs beyond the known ones (movie play / stop, graphics flush, thread creation for the race load).
- Thunder License's map 15/0 draws the 3D flag on its own (3D object render ×240) — the type-4 path works in the real flow.
- Driven: SpeedZone "Passing – Level 1" (points, "Damage (−2 pts)", ended "Below Minimum Speed! Sorry. Try Again." → results 16/4) and Lightning Challenge "Hold 'em off" (ended "Failed – Out of Contention", goal checklist → results 13/2): the challenge logic, scoring and result screens run.

## Depth bias (grass edges and wall writing flickering)
- User: grass texture popping in and out along the pavement edge, writing on the walls popping in and out.
- The race draws those decals with D3DRS_ZBIAS 16 (~6,000 of ~76,000 draws over 120 race frames; everything else 0). SetRenderState_ZBias (0x18F8B0): v != 0 enables NV2A polygon offset (point / line / fill), factor = -v × 0.25 ([0x204620]), units = -v. Neither gl-remote nor the page carried it, so the decals z-fought with the track and walls under them.
- gl-remote now sends rs ZBias as a 12th render-state word of each draw; the page enables POLYGON_OFFSET_FILL with polygonOffset(-0.25 v, -v) while depth testing (?zbias=0 turns it off for comparison).
- Checked (2,040-frame stream into the race replayed in headless Chromium): no page errors; with / without the bias the pictures differ only along the grass / pavement edge line (328 px), where the decal now wins. The soft renderer does not apply the bias.

### Autosave (user report: "Need saving to work automatically")
- The game's autosave is UI-script driven: a screen calls native 0x26 (CSYS.ASAV, 0x79480) and 0xD9 (0xE6790 -> 0x5EC60:
  number of active save slots whose "unchanged" flag +0xD is clear) and, when both are set, native 0x82(1, -1, -1, 1)
  (0x79A40: the memory-unit dialogs 5/0 in context 6 in autosave mode: "Saving User Profile to hard disk..."). Points:
  main menu 0/0 entry (0x17E1D), season menu 4/6 entry (0x1BFD7, so after every race), career 9/0, Lightning 13/0,
  License 15/0 / 15/4, SpeedZone 16/6, 0/7, 0/11; the help bar 2/1 shows Quick Save lit from 0xD9. Native 0x29(type)
  (0x79450: slot of that type active and changed) asks "save first?" when quitting a season / career.
- Three things kept it from ever running: natives 0x29 and 0xD9 were JS stubs returning 0 (now in GAME_FIRST: run in
  game code), and the slot checksum was always 0. Slot records (table 0x21F2C8, 0x48 bytes) keep a checksum at +0x14;
  0x5EAE0 recomputes it through 0x5E550 -> 0x147830(db 'ncar', table names from STAB for the slot type, count, crc*) and
  sets +0xD = (crc == +0x14) (with "baseline" set it also stores it: slot init 0x5EE00/0x5EDB0, after a load or save);
  0xE6730(ecx = type, index) refreshes a slot (options screens, profile changes, the options autosave toggle 0x90AB0).
  0x147830 walks the game's own table list 0x27F6E4, empty here (the database is nascar-db.mjs), so it returned 5 and
  the checksum stayed 0: nothing ever looked changed. It is now a hook: FNV-1a over the rows of the listed save-flagged
  tables (~10 ms for the season set). NT04_NO_SAVE_CRC=1 restores the old behaviour.
- Result (fresh save folder, Yes at the boot prompt): the main menu saves User Profile 1-4 (their tables SVCS / SSGO
  change when the front end starts, after the slot baselines were taken); Season > New saves "Season 1" as its menu
  opens and again after each race (the next race's return to 4/6). Quick save, load and the self-tests' manual saves
  are unchanged. The boot "enable Autosave?" prompt still appears whenever there is no System Settings save (its Yes
  stores ASAV = 1, which is nascar.db's default, so the settings slot does not change and is not autosaved — as the
  game does it; a settings change or quick save writes it).
- Self-tests: the existing checks run with autosave off (config CSYS.ASAV 0, the flow ones answer No), plus a new
  autosave check (profiles at the main menu, season saved on its menu and again after a simulated race). det.mjs now
  runs on a copy of the save folder with file times pinned and native 0x26 forced to 0 (the copy's creation / access
  times differ per run and the game stores them); new baseline 42dd9047d90f53f7 / steps 6593926750, two runs identical.

### Pre-race driver intro speech named the wrong driver (user report: "showed Tony Stewart's car, but started talking about Johnny Benson")
- The intro line for a car is a "highlight" clip picked by 0xD4760: `declare ? cursor for select 'HLID' from 'THLD'
  where 'DRID' = ? and 'TRID' = ?` (this track, then TRID 255 = any track); only when the declare does not return 0x17
  it sets a random row (0x14A10) and fetches HLID into a 16-bit local; otherwise HLID = -1. Speech entry = 504 + HLID
  (kind 2 stream, 0xD08E0 -> 0xCE410).
- Our query bridge returned 0 for a cursor with no rows, so for a driver without a highlight at this track the game
  fetched from the empty cursor (0x15, nothing written) and used the uninitialised local: HLID 0 = Johnny Benson's
  (THLD row 0, DRID 4). Now a declare that finds no row returns 0x17 like an empty select. Checked (Race Now as Tony
  Stewart at Talladega): entries 504 / 172 before, 618 (504 + HLID 114, a Stewart any-track highlight) / 286 after.
- Self-tests pass; det.mjs 7f61257047e993bf / steps 6568874313 (the intro speech differs).

### Loading-screen music and crackle (user report: "crackling audio", "loading screen music messes up during loading")
- Loading music: EA's software mix (the loudest part of menu and race sound) is a looping 6-channel 50 ms ring that the
  game's sound thread refills ahead of the play cursor (GetCurrentPosition calls come from a thread). During a load
  much of the time goes to our own JavaScript (loaders, textures, models) with no instructions run, so no CPU tick:
  game time (live clock) then jumped by the whole stretch at the next tick and the mixer played the stale ring for
  all of it. Measured over a Race Now load (live clock, real-time pacing): consecutive 50 ms blocks correlated 1.00
  for up to 0.4 s at a time (a buzzing loop). liveTime now takes jumps over 12 ms in 8 ms steps and runs the threads
  after each (as the sound thread would have run meanwhile): no repeated blocks afterwards; the music fades out as the
  race load starts, as before. Offline runs (tests, det) do not use the live clock: unchanged (det 7f61257047e993bf).
- Crackle: the server's mix is clean (race, 20 s, offline and live-paced: no repeated blocks, no click windows by a
  second-difference detector that catches spliced jumps). The page's player was the cause: it stretched the sound
  whenever its buffer fill differed from the 200 ms target, and at real-time speed the fill wanders with the chunks'
  arrival jitter, so 28-48% of the grains were overlap-added (s 0.5-1.08) instead of the plain samples (offline run of
  the worklet, wsim.mjs, chunks every 33 ms with 10-80 ms jitter). The stretch now stays exactly 1 while the fill is
  within 0.5x-2x of the target: 97% of grains exact with jitter up to 150 ms; at 0.6x emulator speed it still
  stretches (s ~0.6, no starving).

### User profiles came back in the wrong slots (user report: "Lightning challenge progress wasn't saved")
- It was saved: Lightning Challenge results live in the active profile's working tables (LSCO scores, challenge
  completions -> SCHR, unlocks -> SUNK); the profile slot's checksum changes, and Lightning's menu 13/0 autosaves on
  entry (0x26 && 0xD9 -> 0x82): the user's "User Profile 1" was rewritten with SCHR CLID 29 and an unlock.
- At the next boot the memory-card walk (process 6) lists the saves (states 0x6E-0x73: XFindFirstSaveGame order, then
  each data file's 32-byte header is checked, 0xE6500 -> 0x105630) and loads them into the profile slots 0-3 in date
  order, newest first (state 0x51 at 0x104A99 -> 0xE5D70; the slot record gets the save's name "User Profile N" at
  +0x27, the profile name at +0x19). The date is the save directory's (NtQueryFullAttributesFile on U:\<dir>\).
  Rewriting an existing save's files in place does not change the host directory's time, so the re-saved profile
  kept its creation time: it was loaded last, into slot 3, and the empty profile in slot 0 was the active one.
- xbox-fs.mjs: a directory's last-write / change time is now the newest of its own and its entries' (an Xbox save's
  date is its last write). Checked with a re-saved profile: PRFL Profile2,3,4,1 -> Profile1,2,3,4 and LSCO's row on
  PRID 0. With the user's folder (User Profile 1 written last, with the challenge) profile 1 comes back as slot 0.
- Self-test: after the autosave check, two boots on the same folder: the four profiles reload, and after User
  Profile 3's file is rewritten later it comes back first. Self-tests pass; det unchanged (7f61257047e993bf).

### Controllers (user request: "Can you add controller support?")
- There was a basic path already (the first standard-layout gamepad merged into pad 0). Now (play-client.js):
  every connected gamepad is an Xbox pad: the first shares port 0 (player 1) with the keyboard, the next ones are
  ports 1-3 (the server marks them connected / pulled out, so the game gets its XGetDeviceChanges insertions);
  standard layout by position (face buttons A/B/X/Y, LB = WHITE, RB = BLACK, analog triggers, sticks, d-pad,
  START = Menu/Options, BACK = View/Share, stick clicks); pads without the standard layout are tried with the same
  positions; sticks have a radial dead zone (0.15) rescaled so steering starts smoothly; the page shows which
  controllers it sees under the picture; a button press also starts the page's sound when the browser allows it.
- Rumble: the game sets it through XInputSetState (xinput-hle.mjs keeps pad.rumble; seen in a race: 25856 / 47104 on
  both motors); main.mjs sends changes as { t: "rumble", port, left, right } and the page plays them on that
  gamepad's vibrationActuator ("dual-rumble", renewed every 200 ms while on, at most every 80 ms on changes).
- Checked: headless Chromium with a mocked standard gamepad against the live server: START skips the intro movie,
  START / A / d-pad reach the menus (pad messages logged at the server); a second pad connected at the title does not
  disturb the flow into a race (offline run).

### Race pause menu: every item resumed the race (user report)
- Pause menu 3/1: up / down move between its item states (st38.. rows, ev2/ev3, -6/-7); the root handles two
  buttons: message 7 -> 0x22AB8 picks the highlighted row (0x1E50C) and runs its action (confirm boxes, Gameplay /
  System Settings, Restart, Quit ...), message 0 -> 0x22FE2 runs action [root+0x94] = 0 = back to the race (the help
  bar: "START: Return to game", "A: Select").
- Our pad -> UI messages were a fixed table (A 0, START 7, BLACK 10, WHITE 11), so A resumed. The game's own table is
  the port's action map (record [0x273244] + port * 0x1C: +8 map, +0xC callback; 5-word entries action, element =
  kind | index << 16, dead zone, scale, -; end element 0x8000). In menus the map is 0x228010 with callback 0x75F20
  (the UI input entry: message = action). Element index (from the maps and the report built by 0x12EF30): 0 START,
  1 BACK, 2-5 d-pad, 6/7 stick clicks, 8-15 analog A B X Y BLACK WHITE LT RT; kind 9 = pressed, kind 3 = repeat,
  kind 2 = analog, kind 0xB = held (driving: brake 0x47 <- LT 14, throttle 0x46 <- RT 15, steering 0x39 <- 0x14).
  0x228010 gives START 0, BACK 6, A 7, B 6, X 8, Y 9, WHITE 10, BLACK 11, LT 12, RT 13. Most screens handle 0 and 7
  with the same code (92 screens; e.g. main menu 0/0 both at 0x14E41), the pause menu does not.
- xinput-hle.mjs uiEvents(frame, mem) now reads the active map: with a UI map (callback 0x75F20) every kind-9 entry
  sends its action; the d-pad / left stick give 2-5 with repeat as before; with another map active (driving, race
  intro) no UI messages (the game takes the pad itself); without the game's tables the menus map applies.
- Checked (Race Now, pad input): pause -> down -> A opens Gameplay Settings (1/14), B back to the pause menu, START
  resumes; Quit Race -> "Are you sure?" -> Yes -> main menu. Self-tests pass; det.mjs 078b0e146c5167e8 / steps
  6593543515 (pad A now sends 7; two runs identical). Quick Save (help bar 2/1, message 11) is BLACK.

## Career: menus skip unavailable items; Build Car parts lists showed 0 stats

- **Skipping disabled items.** Op 0x47 (enable_state_idx, original handler 0x13D52A) moves focus to the next item of
  its table; when that item is disabled, the original (0x13AC10) runs the item's -6 handler with two arguments:
  [the op's key as a signed direction, index of the target in the op's table or -1]. The VM passed only [index], so
  the scripts' "go on in the same direction" code saw direction = index and stopped on the disabled item. The VM now
  posts [(key << 16) >> 16, index] (uis-vm.mjs, post kinds 5/6 default [0, -1]). Seen in the Career Startup icon row
  (after the team is signed its icon is disabled and focus goes on to Sign Sponsors) and the Build Car menu
  (Chassis <-> Quick Select). The self-test's career script no longer presses Right there.
- **Parts lists (screen 9/35, "<builder> Assignments").** 0x7FB60 sets up a 0x20-byte column table at 0x21FF3C
  (table + field codes: CHAS CHID / ECON / CCTG / CCTW / ECDR, or ENGN.. / BODY..), 0x7F340 opens a cursor through
  the query bridge (handle in [0x2B85B0], count in [0x2B85C0]), and 0x7F4B0 reads each visible row with the engine's
  structured fetch 0x1481C0(handle, mode, n, fields*), then prints entry+0 (ID + 1, then the stats as floats through
  ftol). The fetch was not bridged and the handle was never written, so every fetch failed (0x11) and the rows read
  the zeroed buffer: "1, 0, 0, 0" on every line.
  Now the bridge's cursor creation also writes a handle id in the cursor struct's first word (as the engine does) and
  0x1481C0 is hooked on it: mode 0 = n rows from the current one, 1 = row n, 2 = n back from the last; entries are 16
  bytes (+0 value out, +4 table, +8 field, +0xC field index out) up to field -1; int / uint as u32, float as f32.
  0x148170 closes the handle. Chassis now show 1/2, condition 100, grip 53/51, wear 52/50 (the CHAS rows).
- det.mjs baseline is now a2836bdc126be0f5 / 6399477924 steps (unchanged by these two fixes: same hash with both
  reverted; it had moved since the last recorded value).

## Career parts list: Type flipped between Short Track and Generic

- 0x7F4B0 prints the Type column from "select 'TTYP' into \x83 from \x8c where \x8c = \x82" (table CHAS / ENGN /
  BODY, ID column, the row's ID), then the ETRT enum text of that value (0x5F150; on 0x17 it prints "Generic").
- The query parser read a name parameter (0x8C) in a WHERE operand as a plain value, so the condition compared the
  text "CHID" with the ID: never true, the select found nothing (0x17) and the game used its uninitialised output
  byte: 0x43 (no enum -> "Generic") or 0 (EVAL 0 = "Short Track") depending on what the stack held, which changed
  as the columns scrolled.
- nascar-db.mjs operand(): a 0x8C parameter is now a column whose name the caller gives ({col: {field:
  {tableParam}}}); #rowPred / indexes fall back to #eval for it. The executable has 8 such queries, all for car parts:
  this one, the selected-chassis flag 'TSCE' (now read, so Build Car options that need a selected part can enable),
  the part condition / assignment updates ('DICC' = 1, ECON / ... = float where TSCE and ID), a part delete and the
  part detail selects. All CHAS rows have TTYP -1, shown as "Generic".

## Career: Race stayed on the garage picture (race HUD over it)

- The garage is the front end's background screen 0/1 (scene 0xC from the race weekend menu's mode). Race Now (0/6)
  and Season (4/9) close 0/1 when they go to the race weekend; no career screen does, so it stayed open into the race
  and the UI layer drew it over the 3D picture.
- In the game the race weekend and the race use UI managers of their own (made by the game, e.g. 0x2A26060 race
  weekend in context-table entry 1, 0x2A209C0 HUD in entry 2); the front end's manager is drawn by the Frontend state's
  render only. Two fixes in gamecode.mjs:
  - ctxOf: a manager that is not one of our stand-ins gets a VM context of its own (16 and up). The old
    (mgr - UI_MGR) >>> 8 & 15 took address bits, and the career race weekend's manager came out as context 0 (the front
    end's): its screens shared notifications with 0/1.
  - uiContextDrawn: context 0 is not drawn while the Interface process is in 9 (race weekend), 10 (in-game) or 11
    (paused). uis-run drawScreen now honours vm.drawn like main.mjs.
- Also: Create-A-Car paint quantising (0x778A0, per pixel 0x777A0 = nearest palette colour by summed squared byte
  differences, cached in [0x2B8558] while [0x2B855C] is 0) ran ~1e9 x86 steps inside the module load of the career race
  weekend and hit the step limit ("module 0x2F4034 ... step limit at 0x77828"), after which Render Logical Car and
  Race_Manager-Sys failed to load (bad addresses) and process ticks faulted. 0x777A0 is now a JavaScript hook (same
  result, same cache); the load completes with no errors.
- Seen but not fixed yet: the career race weekend's Qualifying Order lists "43 Fittipaldi" in every slot.

## Career / season race weekend: Qualifying Order showed "43 Fittipaldi" in every slot

- The list (3/0 native 0x19 / 0x79 -> per-screen 0x89C70: 0x89710 case 6, 0x899D0) reads the driver ids that 0x89500
  collected from QUAL (0xB2270: cursor "select QUAL.DRID order by LAPT", one fetch per position). QUAL was empty, the id
  array stayed 0, and 0x4B970 found driver 0's car (#43 Fittipaldi) for every position.
- QUAL is filled at race-weekend load by 0xB1930 (from 0xB1CB0): in season / career modes ([0x2BB114] 1 or 2) it
  takes the cars from "CARS left outer join DRST on DRID where CARS.PLID = -1 and CARS.CTYP != 7 and DRST.YEAR =
  <season year> order by DRST.CRNK" and gives each a qualifying lap time by rank. A new season has no DRST rows for its
  year yet (they are inserted as races pay out), so with standard SQL the WHERE on DRST dropped every car.
- It is the game's only left join, and it is written to return every car: nascar-db.mjs now applies WHERE terms on a
  left-joined table as part of that join (no match -> the left row stays with the joined table null, nulls sort last).
  Career first race: 42 AI cars in QUAL, Qualifying Order 4 Busch, 5 Gordon, 6 Craven...

## Matching a hardware recording (career setup -> race weekend, 16:9 capture)

- Aspect: the recording is the console's 4:3 picture stretched across a 16:9 set, 3D and menus alike. UI space is
  854 x 480 and a 4:3 display shows x 107..747 of it; the page stretched the 3D backbuffer to its 16:9 view but drew the
  UI over the full 854 unstretched, so menus sat narrower than the 3D and than the console (extra margin each side, the
  "CAREER"/"RACE NOW" header lettering and the menu panel showing beyond where the console cuts them). play-client.js
  now maps UI x 107..747 onto the view (uniform uX in the UI shader) and no longer pillarboxes the race loading screen
  (fit43); F3 switches to the old full-width UI (localStorage nt04.aspect = "wide").
- Magenta vertex colours: ff00ff (2/1 Quick Save icon, texture uis_gene 6: a dark button with white highlights) and
  ff33ff (3/0, 3/2, 3/5 info-bar left cap, uis_ig 18: grey shades) are the only magenta elements (8). On hardware both
  show untinted (grey cap, dark button with grey rim); here they were pink. The UI draw (0x13FB00 -> 0x143DC0 ->
  0x142CC0, immediate mode SetVertexData4ub(2, colour) with the AddMul shaders) passes the colour bytes unchanged and
  no code compares against magenta, so the mechanism is still unknown; uis-render.mjs takes such colours as white.
- Compared side by side after the change: title screen and race weekend menu. The other screens in the recording
  (career settings, Create-A-Car, sponsors, crew, build car, Grudges & Alliances loading) were not compared one by one.

## Career: no loading screen going to the race weekend

- The race load (Interface 7, tip screen up: [0x2F3052] set by 0x72F30) ran as in Race Now, but the career's garage
  background 0/1 (front-end context 0, still open: no career screen closes it) was drawn over the loading picture.
  uiContextDrawn now also hides context 0 in Interface state 7 (with 9, 10, 11).

## Picture framing vs hardware captures ("ours looks zoomed in")

- Fitting our UI render to a console screenshot (main menu, 1270x727) and a recorded frame (race weekend) by edge
  matching: the console's picture shows UI x 82..774 (screenshot) / 99..774 (recording) instead of 107..747, and
  UI y 0..480 sits inside black bands above and below. In other words the whole 4:3 picture appears at ~0.92 of the
  frame, the UI's wider-than-4:3 sides filling left and right (in the race weekend frame the right edge beyond the
  3D picture is dark). The cause on the console side was not found (the game's UI view is aspect 4/3 at 0x75520 /
  0x761A0, 16/9 only with the widescreen flag 0x127D80); it is reproduced as a display frame: play-client.js
  TV_SCALE = 0.925 (UI drawn over x 427 +- 346, y 240 +- 259.5; the 3D backbuffer in the middle 92.5% of the view).
  F3 still switches to the unstretched full-width view.

## Race weekend: empty message box after a session ("has a new best lap")

- After a session 3/0 opens the message box 2/5 with "<name> has a new best lap: <time>", the name from global native
  0x91 (player, string object) -> 0x7A290 -> 0x14750: "select PFLN from PRFL where PRID = player" into the string's
  buffer. uis-natives.mjs had it as a JavaScript stub returning 0 (labelled "option load query"), so the text began
  with a space; 2/5's layout (0x5C9D) treats an empty text or one starting with a space as no text: zero lines, a
  collapsed box in the middle and its Ok button left at the top-left corner. The stub is gone; the game code runs
  ("Profile1 has a new best lap: 59.250", box laid out normally).
- Reproduced headless: career race weekend -> Qualify -> RaceBot two laps at Daytona -> session end -> 2/5.
- det.mjs baseline now 722a07869020be4a / 6399477946 steps (the Race Now path calls 0x91 too; race state unchanged).
- The info bar after qualifying: 3/0's L_18015 picks the bar's modes from the session state (native 0x80000013:
  0 -> 6,4; 1 -> 4,6; 2 -> 6; 3 -> 7 (+8 unless native 0x85); 4 -> 8,9) into its ticker (+0x4C14: count +0x94, modes
  +0xB0..; started by L_1626D, which calls 0x79 / 0x19 per mode). After qualifying it starts once the best-lap box
  is closed: with the box fixed, Ok -> "Qualifying Results" with the names and lap times. While the box is up the bar
  is still blank.

## Nameplates: red end caps (race HUD 10/0 drafting plate, Grudges & Alliances results 3/25)

- Both plates are three pieces on uis_ig 18 (grey bar texture): left cap, middle, right cap. The HUD plate (10/0
  @A000 / @A0C0) has ff3333 on both caps and white in the middle; the 3/25 name bar (@1940, @1DC0, @2240, @26C0) has a
  white left cap and an ff3333 right cap. All are flag 2 (textured, bit 0 clear). The respect label bar above the 3/25
  name (@2AE0.., flag 3, ff0000) is recoloured by the script (method 2: be ff be Ally, ff be be Rival, white None) and
  stays as it is.
- Same picture as the magenta caps (ff33ff on the same texture, grey on hardware); the console's version of the
  nameplate (the Grudges & Alliances loading picture in the hardware recording) has a plain grey name bar. The draw path
  was followed again: 0x143DC0 -> material OnePassTO (0x137B80: stage 0 MODULATE texture x diffuse for colour and
  alpha) -> 0x142CC0 -> SetVertexData4ub(diffuse, bytes 0..3) -> vertex shader AddMul (oD0 = (v2 + c60) * c61, the
  global add / multiply colours, 0 / 1). The colour index path (+8/+0xA colour table, bytes as an index when flag 0x10
  is clear) is not used by these elements (-1). So the mechanism is still not found; uis-render.mjs now also takes
  R ff, G <= 33, B <= 33 on a textured element with bit 0 clear as white (only those 6 elements match).

## Standings / driver stats: "---------1---------2---------3-" title

- 9/15 (and the other stats screens) fill a title buffer (static string 1, its 31-char placeholder) with native 0x11 and
  show it. 0x11 is 0x795E0 with edi 0: args (driver id, string record, UI font entry, width); "First Last", wider than
  the width (unsigned) -> "F. Last", still wider -> "Last". uis-natives.mjs read the args as (id, width, record,
  style), so the name was written nowhere and the placeholder showed over the standings. Fixed (Career 9/15 passes
  font 0x143 width 1 -> "Mears").

## Page: 3D picture across the full width in the 4:3 frame

- Hardware recordings (career garage menus): the 3D reaches both sides of the frame, black bands only above and below.
  play-client.js stretch43 drew the 3D backbuffer in the middle 92.5% both ways (black at the sides behind the scrolling
  menu headers); it now uses the full width and 92.5% of the height. The UI framing is unchanged.

## Pit road options / Pit Under Caution: the pad did nothing

- On pit road the game switches port 0 to the menus action map (0x228010, callback 0x75F20), so xinput-hle.mjs
  uiEvents does make UI messages. Two things kept them from working:
  1. Target. 0x75F20 sends to the input context [0x2B791C] (2 = the race HUD, manager 0x283B120, VM context 16) and,
     when that context's byte +0x1C in the table 0x2B7C38 (32 bytes per entry) is set, to every screen of its manager
     (0x13A890's last argument), not only its focus. Only the HUD has it set: the pit options 10/1 (and 10/2 "Pit
     Under Caution?") open beside 10/0, which keeps the focus, so vm.press sent everything to 10/0. gamecode.mjs
     uiInputTarget() reads it; uis-natives.mjs presses with { all, ctx } then.
  2. Controller. 10/1 (state 0 +0x90) and 10/2 (+0x84) keep the player's port from global native 0x33 (0x6ACA0, the
     player -> port table 0x2B7008) and drop presses from any other port. 0x33 was a JS stub returning -1, which no
     press matched. It now runs the game's code (GAME_FIRST).
- Checked headless: Race Now, RaceBot pitOnLap 1 -> pit road (race state 5, 10/1 open) -> Down moves the highlight,
  Left turns Repair Damage to No (estimated time 16.048 -> 15.650), Right on Replace Tires gives Left (8.978).
  Pit Under Caution uses the same path (message 7, port check); not reproduced (needs a caution).

## Career results / lists: the player's Create-A-Car number missing

- Car numbers in the UI are uis_smnm entries indexed by the car record's number style +0xC0 (CARS.NSID; e.g. Busch
  NSID 97 -> entry 97). A Create-A-Car (CTYP 6) gets +0xC0 = 0x59 + player (0x4EDB4), and entries 89-93 are empty
  32 x 32 slots: at race-weekend load 0xF4C50 fetches the slot (0x6DF60 -> 0x13ECD0, kept in [0x2B74F4]) and 0x70030
  draws the car's own number (CNMD "192", its number font and colours) into it, through the MMAP block's own
  pointers: [+0x18] image description (pixels at +0x80 + desc+0xC) and [+0x1C] palette header (palette at +0x80 +
  [+8]).
- Two things lost it:
  1. gamecode's cache bridge had written the texture handles over the block's +0x14 / +0x1C, so 0x70030 copied the
     palette to a stray address (digits drawn, palette all black). The texture object 0x13E660 / 0x1426F0 returns is
     now a copy of the relocated header with the handles; the block the fetch returns keeps its pointers.
  2. The UI renderer reads textures from the files, so the slot was empty there. uis-run.mjs Assets.dynamic now reads
     uis_smnm 89-93 from the game's loaded block (file layout, pixels and palette from game memory), re-decoded when
     they change. Checked: career weekend -> slot 89 decodes to "192" (cream digits, gold outline).
- det.mjs: 98c42af09888aacb / 6399477946 steps (heap layout; race state unchanged).

## Rear-view mirror turned the whole view round

- With CDIS.SRVM = 1 (Gameplay Settings > Rear View Mirror) the race draws every object twice, alternating viewports:
  the mirror camera into a 182 x 60 viewport at (227, 37) of the back buffer, then the main view at 640 x 480. The
  mirror's vertex programs leave positions in screen space and the page draws such programs with the whole target as
  GL viewport, so nothing kept the mirror pass inside its strip: its picture (the view behind) covered the screen.
  The console confines drawing to the viewport, and Clear without rects clears only the viewport.
- play-client.js: every draw gets a GL scissor box of its viewport (none when it covers the target or is empty);
  clears carry the viewport (gl-remote OP_CLEAR + 4 floats) and are scissored too; UI / blit / movie paths turn it off.
  soft-renderer.mjs clips triangles and clears to the viewport the same way.
- Checked with the software renderer (Race Now, mirror on): the mirror shows as an inset at the top middle with the
  cars behind. Open: in that capture the main view's sky is dark with the mirror on (also when the mirror draws are
  skipped: its first draw inherits the texture the mirror's last draw bound), not seen on the page yet.

## Rear-view mirror: black sky, mirror outside its frame

- Black sky: the sky dome (first draw of the main view, 146 vertices, no pixel shader) has stage 0 COLOROP = 1
  (DISABLE) and relies on texture 0 being whatever is bound; with the mirror on that is the mirror pass's last
  texture. The page and the software renderer took stage-0 DISABLE with a bound texture as "texture x diffuse" (meant
  for a never-set stage, 0), so the dome came out as the texture's dark colours. DISABLE (1) now passes the current
  colour on at stage 0, texture or not; a never-set op (0) still modulates a bound texture.
  (The page has the rule twice: stages() in the general FRAG shader and the generator of the specialised per-state
  shaders, which is what normally draws; the first change only reached FRAG, so the sky stayed black on the page.)
- Frame: the HUD's mirror frame (10/0 state 2, element 182 x 59.5) is placed by the script at x 325, y 17 with scale
  1.086 x 1.1, i.e. 197.7 x 65.3 around (426.5, 52.4); at 0.92 about the screen centre that is exactly the mirror
  viewport (227, 37, 182 x 60 of the 640 x 480 picture: centre 318 / 67 -> UI 425 / 67). So on the console the 3D
  picture fills the frame and the UI is drawn at ~0.92 over it (the same 0.925 the screenshot fits found for the
  UI). play-client.js stretch43 now draws the back buffer over the whole view (the UI framing unchanged); this also
  gives the career garage's sides (seen as full width in the hardware recording). Checked by composing the software
  render (mirror on) with the HUD at the page's mapping: the mirror sits inside its frame.

## Rear-view mirror: the main view's catch fence showed through it

- The race draws the two views object by object (a render list sorted by material: mirror instance, main instance)
  into one colour and one depth buffer; no stencil, scissor (SetScissors: one stale, non-exclusive rect) or depth
  range split (main viewport z 0..0.993, mirror 0..1). Inside the mirror's rectangle the main view's sky (drawn
  after the mirror's) and its near geometry, such as the catch fence along the wall, pass the depth test against the
  mirror's farther picture and land on top of it.
- play-client.js keeps an inset's rectangle: the first draw with a viewport smaller than its target in a frame
  clears the stencil to 1 inside it (scissored); full-view draws on that target then test stencil == 0. The next
  full clear (colour or depth) resets stencil and the list. soft-renderer.mjs does the same with a list of inset
  rectangles. Checked with the software renderer driving next to the wall (lane 15): the fence stops at the mirror.

## Career AI per race weekend (checked)
- Career start: a cursor over SCHD (SCID from GINF) joined to RACE sets GINF RAID/TRID/RORD (first race RAID 0 TRID 11).
  After a race (finished or quit) the same update moves to the next RORD (e.g. RAID 32 TRID 23 RORD 2).
- Entering the next race weekend re-runs the AISpeeds component: [0x21dd4c] went 10 (Daytona) -> 31 (TRID 23 TPID 31).
  In the race the LKSD skill lookups pass TTYP 1 (intermediate) and the TRPL flag byte (0x2DD4BE) is 0.
- So career weekends after the first get the right AI_SPDS entry, skill set and no plate flag. Atlanta is RAID 1,
  TRID 0 -> TPID 0, TTYP 1, TRPL 0. Note Atlanta's TRCK.AISF is 0.7, the same as Daytona/Talladega/Michigan/Kansas
  (Bristol 2, road courses 3.5-5), so a tight field there comes from the game's own data; the career default race
  length here was 10 laps, which also keeps the field bunched.

## Race HUD lap counter: vertical line through the plate (Happy Hour / practice)
- 10/0's lap plate is four quads of one 64x32 texture: stretched grey middle 177.25..234.75, the grey-to-dark piece
  234.25..246.25, the stretched dark middle 246.75..283.25, the right cap 283.25..298.25 (UI units = console pixels).
  Between 246.25 and 246.75 nothing is drawn: on the console (D3D, pixel centres at integers, covered when in
  [left, right)) both edges land on pixel 247, so there is no gap; drawn at the fractional positions (page at 2-3x,
  or the software canvas sampling at x + 0.5) the gap was a line of background through the dark box.
- uis-render.mjs snapRect: axis-aligned element quads get each edge at ceil(edge) (the console's pixel boundary in
  the page's convention), uv / colour extrapolated over the corners; rotated and 3D quads untouched. Other screens
  (0/1, 1/0, 3/0, 9/13, 2/1) change only by sub-pixel edge moves.

## Career: loading picture showing behind the race weekend menu
- Hub -> race weekend: process state 7 presents ~70 frames of the loading picture (3 draws each) inside one frame
  (one long call; on the console each present waits for a vsync, ~1.2 s), then state 9 starts with the weekend UI.
- gl-remote sends those frames at once marked "hold"; the page plays them one per refresh. UI messages ("IUIU")
  were applied the moment they arrived, so the weekend menu came up over the still-playing loading frames for
  about a second.
- play-client.js: a UI message that arrives while frames wait in the queue is queued with them ({ ui }) and applied
  in order (paceTick / the no-animation-frame path); with an empty queue it is applied at once as before.

## Manufacturer logos with a red rim (grid intro 3/10, results 3/8, 3/15 ...): element flag bit 0
- The logo is two elements on uis_ig 7 (the script swaps in the make's logo, e.g. 3/6): a larger copy behind
  (flags 2, authored 990000ff) and the logo in front (flags 3, the script sets its colour to dcdcdc). Drawn with
  the authored colour the back copy made a dark red rim round every logo.
- Element load (type 0, message -1: 0x140127 -> 0x13FA10 -> 0x142C80): for a textured element (bit 1) with bit 0
  clear, the game sets bit 0 and the RGB of all four vertex colours to ff, alpha kept. So bit 0 means "keep the
  authored colours"; every other textured element starts white (a script can colour it afterwards). This is also
  what turned the magenta / ff3333 end caps grey on the console (all of them have bit 0 clear), which uis-render
  had special-cased.
- uis-vm.mjs elementHandler -1 does this (and sets +1 bit 0x40 as the game does); uis-render draws a textured
  element without bit 0 white (screens drawn without the VM's load), replacing the magenta rule. 110 elements in
  all screens change (bit 0 clear, authored non-white): mostly invisible; the X / A button icons and the career
  check marks come out brighter.

## Black line across the track / car at night (open) and the capture tool
- User screenshot (Lowe's night, lap 15): a solid black sliver, hairline over the player's spoiler, widening to the
  right edge, drawn over the car for one frame, several times a race. Shape = one long triangle reaching the camera
  plane (a vertex at / behind w = 0, clipped).
- Not reproduced: Race Now at Lowe's (night) driven by the bot, 840 frames of the real 3D stream recorded headless
  (RemoteRenderer with a sink) and replayed in headless Chromium + SwiftShader with play-client.js (replay/run.mjs):
  no sliver. Checked on the way: the per-light car shadows (uis 128x128 P8 shadow, SRC_ALPHA blend, no z write)
  often reach behind the camera and draw as clipped wedges; skid marks (one strip of all marks, degenerate joins)
  and trackside posts also cross w = 0; all draw sensibly. No stencil is used in races.
- play-client.js ?capture=1: F9 saves the last 150 frames of the 3D stream (nt04-capture-*.bin): the raw frame
  messages plus a synthetic first frame holding the state the window starts from (vs / ps / pskey / buf / tex /
  texp8 as of then, and a new "consts" op with the vertex constants). Replayed in a fresh page it gives the same
  pixels as the live page (checked: 150 frames, final frame identical). Next step: a capture of the line.
- The capture is now POSTed to the server (net-worker.mjs: POST /capture -> captures/nt04-capture-*.bin beside
  main.mjs); the browser download is only the fallback (the first F9 press produced no file in Downloads).
- First capture (Talladega, day; 150 frames, replayed in headless Chromium: replay/rep2.mjs, trace.mjs): the dark
  lines on the track come from the track draw itself (vs 294, ps 8, 3 textures 387 grooves / 310 asphalt / 388
  markings atlas, all static). Swapping 388 for a transparent texture removes them; 388 (256x512 P8, black where
  alpha is 0) holds the lane lines and, painted in dark opaque strokes (alpha ~32-200), crack and tar-seam lines:
  long straight ones along the columns and short wavy ones across. Constants are not involved (uploading every
  register on every draw changes nothing). So the lines are the game's own track decals; drawn without mipmaps
  (client samplers are LINEAR / NEAREST only) far ones shimmer and break up instead of fading.
- Capture viewer: main.mjs serves /replay (lists captures/ via /captures, file via /captures/<name>): the page
  loads play-client.js with a stand-in WebSocket and feeds the capture's messages; frame buttons / slider / arrow
  keys / play, "save PNG" (show() then toDataURL). Going back replays from the start (state is incremental).
- Second capture (Indianapolis-like day track, frame 38): on the user's GPU a solid light-grey wedge from the car to
  the bottom right; the SwiftShader replay of the same frame does not have it. Under it, by the SwiftShader trace:
  the player car's light shadows, draws 289 / 290 (vs 755, screen-space program, tex 757 128x128, SRC_ALPHA blend,
  no z write; quads whose far vertices are behind the camera, w ~ -11..-13 vs +4..+7, fog factor ~1.04, colour
  d2010104 / f0020204). The day wedge is light grey, the night one (Lowe's) black: fog-colour-like. Suspect a
  GPU-dependent result for these clipped near-camera triangles (NaN / inf varyings, clamp(NaN) in the fog / colour).
- Viewer: click a pixel -> the frame is replayed draw by draw on the user's own GPU and every draw that changed
  that pixel is listed (vs, ps, textures, blend, vertex buffer, value); "skip draw N" leaves one draw out.
- Third capture, frame 58 (black wedge over the player's car, the colour of a nearby car): the pixel inspector run
  on the user's GPU listed draws 957 / 1132 (vb 47142, vs 1084 / 793: another car, 355-vertex strip) writing the
  wedge; SwiftShader does not. That car straddles the camera (w -3.2 .. 2.1); vertex 120 has w = -8.7e-8. Exact GL
  clipping of its triangles (pos.mjs) covers no part of the wedge: the wedge points the mirrored way of that vertex.
  Capture 1 frame 58 shows the same class even in SwiftShader (large black / grey slabs for one frame; track
  vertex at w = -4.7e-5).
- nv2a-vsh.mjs: gl_Position.w = -1e-3 where |w| < 1e-3 (x, y, z kept, as clip-space values): the near plane is at
  w ~ 0.4, so such a vertex is clipped away anyway and its edges' near-plane crossings move by ~0.2%. In replays:
  capture 3 unchanged in SwiftShader (it never drew the wedge), capture 1 frame 58 loses its black slab (a grey
  slab of a track triangle crossing the camera plane remains for that frame: texture coords flat near the
  crossing). The viewer applies the same change to captures recorded before it (?oldvs=1: as recorded).

## UI texture overrides (upscaled pictures)
- uis-render.mjs Assets.override: before decoding a UIS bundle entry, a PNG from textures/ (beside Data, or
  NT04_TEXTURES) named <bundle>/<NNN>.png, <bundle>/<bundle>_<NNN>*.png or <bundle>_<NNN>*.png replaces it
  (png-read.mjs decodes it). Elements use 0..1 texture coordinates, so any size maps onto the same area; the page
  gets the bigger image through ui-remote unchanged. Checked: the Race Now driver select with 2x portraits (red
  test borders) shows them in place of the originals. Not for fonts (pixel coordinates), video panels or the
  dynamic car-number slots.
- Fonts: Assets.font takes an override of the glyph sheet (textures/uis_font/<NNN>.png) and keeps the original sheet
  size as uw / uh, against which drawText normalises the glyph rectangles: the bigger sheet is sampled at the same
  places (checked: 9/13 with every UI bundle and the fonts at 2x, text in place).
- read_textures.py: FNTS entries (glyph sheet, 4-bit coverage -> alpha) and LZH1 bundles (Python port of
  ea-lzh1.mjs; UIS_GSCR entry 0 matches the JS output byte for byte). upscale_textures.py: --bundles ui (all UIS
  picture bundles; 2034 pictures), font sheets go through the model as grey (alpha is the picture).
- play-client.js: the canvas's pixel size follows its on-screen size x devicePixelRatio (up to 3840 wide; ?res=fixed
  for the old 1708 x 960), so the UI is drawn at the display's resolution; UI textures get mipmaps.

## Launcher (launch window in the browser)

`node launcher.mjs [--port 8800] [--data <Data folder>] [--no-open]` (or double-click Launch.bat) serves a page on 127.0.0.1 and opens it:
- Play: start/stop main.mjs as a child (port, start-at flow/title/menu), console output, opens the game tab when it prints "Open http://localhost", link to /replay.
- Textures: tick picture sets (quick picks Portraits / Photos / Menus-HUD-fonts / All), model + clean-up model from models/, size, soften, replace existing, advanced tile/device/fp16 → runs upscale_textures.py (no shell; options validated server-side; one job at a time; Cancel kills it). Progress from "[k/n] bundle" lines the scripts now print. Export ticked sets → read_textures.main convert into exports/<bundle>.
- Overrides: counts per set in textures/, Remove deletes that set's PNGs (name checked against ^uis_[a-z0-9]+$).
- Setup: detected Python (py -3 / python / python3) and whether numpy, pillow, spandrel, torch, CUDA are present; pip install buttons for the basics / spandrel; PyTorch via pytorch.org link.
Settings persist in launcher-settings.json. Tested headless: page upscale/export runs, override list, game start → ready → stop.

## Track select showed the PLACEHOLDER track picture
- Screen 0/3 asks native 9 (0x798F0, case at 0x7A7EB: eax = a0 race id, esi = a1 pointer) for the track picture.
  It reads TRCK.TAID / TNIT of the race's track: returns TAID (TNIT = 1: TAID + 36, the night photo) and writes
  *a1 = TAID + 72 (the night lights overlay) or -1. The script sets the photo and its shadow from the return value and
  the overlay element from *a1 (skipped and faded out when -1). uis_trpc: 0 / 36 / 72 are the PLACEHOLDER pictures.
- The JS port treated a1 as a field selector and never wrote *a1, so the overlay element got entry 0 (PLACEHOLDER)
  at full alpha on top of the real photo. Fixed in uis-natives.mjs; day tracks show the photo, night tracks
  (Richmond) the night photo with the lights.

## Roster: added drivers with their own car, portrait, number and paint (launcher Roster tab)
- Data: roster/roster.json beside Data (written by the launcher, roster-server.mjs / roster-ui.js), merged into the
  configuration by nt04-config.mjs withRoster (uis-run) and applied by applyRoster on every NASCAR.DB load.
  A driver is a copy of a template car + its driver: DRVR, DSKL, AIRP rows (driver), CARS, CRSK, CHAC, SCAR rows
  (car; CHAC / SCAR / AIRP live in GMODEDB.DAT), then the user's fields. Ids: DRID / CRID from 250, TMID from 200
  (8-bit), POID from 100 (8-bit), number picture entries from 300. Season / career saves keep their own DRVR, CARS,
  CRSK, TEAM (STAB), so drivers added later appear in new seasons and careers.
- Paint: CRSK (CRID, CTXN = CARS.CSTN) -> CTID = the CARDATA.DAT texture of the race car (MMAP "DECAL", P8, a
  512/256/128 mip chain; the first image at 0x80 + offset, the smaller ones right after it, palette header at
  [0x1C] absolute, palette data 0x80 + [hdr+8]) and the same index in CARRESFE.DAT (front-end preview; without that
  entry driver select drew the big-number layout and no portrait). Rookie drivers (0x50680) use CARDATA 0x192 + CRSK
  RTOF instead (the rookie-stripe copy) when RTOF >= 0: custom rows get RTOF -1.
  Custom paint: CRSK CTID = PAINT_BASE 0x400 + slot; gamecode withRosterPaints gives both archives those entries,
  encoded from roster/paint/<crid>.png by paint-mmap.mjs (median-cut palette, swizzle, all mips; an opaque picture
  keeps the template's alpha). Checked: Race Now with the added driver, CARDATA 1024 loaded for slot 0, the car
  drawn with the custom paint in the race (soft render).
- Number pictures: CRSK CNID = uis_drnm entry (driver select's number) = uis_smnm entry (race badges, through the
  game's UI cache). Same number as another car: its CNID / NSID; otherwise the launcher draws one (canvas) into
  roster/textures/uis_drnm|uis_smnm/<300+>.png: uis-render reads roster/textures as a second override root, and the
  UI cache (gamecode rosterUiEntry) builds MMAPs for entries past a bundle's end from those PNGs.
- Portrait: DRVR POID = uis_drpo / uis_drps entry; roster/textures/uis_drpo|uis_drps/<poid>.png (overrides work
  past the bundle's 55 entries).
- Tracks (not done): TK_REND 76 TMdl, TK_PHYS 65 entries (one per TRCK row), TK_SHAD 67 TMdl, TK_SKY 300 TMdl,
  TK_SCORE 76 TMdl, TK_PBNR 126 MMAP, TMAPDAT 141. Adding a track needs those formats (render model, physics, AI
  data) plus TRCK / RACE rows and pictures; the virtual-entry mechanism used for paints would carry the files.

## Track files, step 1: the render model (TK_REND TMdl) — tmdl.mjs
- TK_REND.DAT: 76 TMdl track models (entry 0 ATL_ATLANTA, 28 NLO_COKE = Lowe's night). Loaded by the race with
  0x11A870 (read into a buffer), chunks assigned by 0x135500, relocated per chunk by the handlers registered in
  0x1356E0 (Matl 0x136080, Txfm 0x137440, Geom 0x137800, Inst 0x1370B0, Rint 0x137180, Swap 0x136630, DInf
  0x138EB0); Text textures built by 0x1347D0 (texture table at MMAP +0x14: 12 bytes, u16 mips, u16 first image,
  u16 palette; images +0x18 16 bytes; palettes +0x1C 12 bytes; names +0x20 16 bytes).
- Geom: draws (20 bytes: strip block {1, P -> u32 prims, 12 bytes, u16 indices}, material, vertex buffer) and
  vertex buffers (12-byte D3D header + vertices; tracks: 40 bytes, FVF 0x152 pos/normal/BGRA/uv). The race draws
  each block as one NV2A triangle strip of prims + 2 indices (checked against the draw calls at Lowe's: every
  indexed draw from the model starts at a block's P + 16 with that count). Units: feet, y up (car models ~16.5
  long). Piece names in DInf ("Atlanta_Track_Surface_LOD_28_...": the 28 is a section number).
- tmdl.mjs: info / gltf export (meshes per material, colour texture of multi-pass materials, KHR_texture_transform
  from Txfm, vertex colours = baked lighting). Lowe's exports complete; Atlanta's export has open patches in the
  infield (to compare with the game — maybe Inst / Rint placement or Swap sets). Texture alpha is not transparency
  (most tracks textures carry other data there), so the export keeps materials opaque.
- Other track archives: TK_SKY (dome models, several vertex streams per draw: tmdl.mjs reads one stream only),
  TK_SHAD (shadow textures), TK_SCORE (scoring tower digits), TK_PBNR (pit banners), TMAPDAT (per track: minimap
  pictures + 16 bytes of placement). TK_PHYS (one per TRCK row, ~600 KB): its own z-up frame; first look shows
  plane tables (normal + d), long point strips (lines around the track, e.g. 0x5FB80 at Atlanta), a z = 450 path
  (cameras?) and a point grid — next step.

## Track files, step 2: physics (TK_PHYS) — tkphys.mjs
- Loaded by 0xD8D10 (entry = TRCK.TPID of GINF's track, 0x11A390 into 0x2F33A0); 0xD9CB0 lays the entry out from
  its header counts (all offsets derived, nothing stored) and 0xD6F50 builds per-section data. Layout in
  tkphys.mjs. Coordinates: feet, z up; same origin as the render model: phys (x, y, z) = (rx, -rz, ry) / 30.48 —
  so TK_REND track models are in centimetres (correction to the step-1 note; car models are in feet).
- Collision mesh: vertices = xy pairs + a plane per vertex (z from the plane), triangles of 40 bytes (u16 a, b, c,
  tangent, plane normal, d, flags) grouped by track section: "surface" (racing surface, banked; Atlanta's turns
  rise to ~20 ft) and "apron" (apron / pit road / infield). Sections (Atlanta 59, Lowe's 76) are a ring around
  the lap with bounds and boundary lines.
- Spot tables (12, 0x3C bytes: position, 3x3 orientation, section): 44 / 44 / 44 / 129 / 43 / 43 / six singles at
  every track looked at — grid rows, pit stalls, etc.
- Line groups (19, quadratic-curve control points, 2n + 1 points for n segments): 0 racing line, 1 lanes across the
  track (6 at Atlanta, 3 at Lowe's), 2 inside line, 3-5 pit entry, 6-8 pit exit, 9 / 10 per-stall paths (88
  each), 11 pit road lanes, 13 / 14 / 15 / 16 / 18 others (infield loop, big outer circles...). Same structure at
  Atlanta, Lowe's and two other tracks.
- Not decoded yet: per-segment data (64 bytes per segment), nodes (0x1C), edge records (0x2C), triangle flags
  (surface types?), the 0x20 / 0x78 / 0x68 records, the 12-byte point table and the tail read by 0xD9C10.

## Track files, step 3: writing (entry overrides, TMdl relayout, TK_PHYS rebuild)
- gamecode withEntryOverrides: any archive entry can be replaced or added from a file — config
  "entryOverrides": { "tk_rend.dat": { "28": "file" } } or NT04_ENTRY_OVERRIDE="tk_rend.dat:28=...;tk_phys.dat:25=...".
  Track packs will add their models this way.
- Pointer fields: the relocated Lowe's model was dumped from game memory and diffed with the file — 9,870 words
  differ by exactly the load address (pointers), the rest are runtime fields (D3D resource headers, texture objects,
  Inst state). tmdl.mjs tmdlPointers() enumerates the same 9,870 from the structure, following the relocators
  (Swap 0x136630, Geom 0x137800, Matl 0x136080, Txfm 0x137440, Inst 0x1370B0 + 0x138FB0, Rint 0x137180, Lite
  0x1391A0; DInf 0x138EB0 is self-relative, Fade / Text hold none).
- tmdl.mjs relayoutTMdl(): chunks moved apart (4 KB alignment kept), every pointer rewritten. Race Now at Lowe's
  with the relaid model (and a TK_PHYS whose tail moved 64 bytes): the captured race frame is pixel-identical to
  the original (deterministic run, det.mjs save handling; trtrace2.mjs + rshot.mjs in the work folder).
- TK_PHYS: no stored pointers except header +0x18C -> the tail block (read by 0xD9C10: up to 7 relocated fields);
  after the 0x78 / 0x68 records come u32 K + K x 12 bytes, then header[0x40] quads of 48 bytes (4 corners: the
  grandstand / crowd areas). tkphys.mjs physParts / writePhys rebuild an entry from its parts (byte-identical for
  the six entries tried).
- Chunk contents learned on the way: Rint = visibility tree (0x40-byte nodes: bbox min/max, four counts +0x20, four
  child / list pointers +0x30; plus a list of cells: bbox and (count, draw) pairs); Inst = per-piece draw ranges
  (u16 first, end), 16-byte per-piece records (runtime fields + node index), a u16 list (172 at Lowe's) and a scene
  graph of the artist's nodes (865 at Lowe's: names, transforms); Swap = texture-swap sets (20-byte entries);
  Lite = light setup. To make new tracks these need generating: next.

## Track files, step 4: a model written from scratch (tmdl-build.mjs)
- How the game uses the organising chunks (0xF2350 -> 0xF21D0 / 0xF2240 per view):
  - Inst: instances, each a range (u16 first, end) of "subs" (16 bytes: two runtime words, per-view visibility
    bytes at +4, draw index at +12); +0xC a u16 list (fences / shadows: unused by the visibility pass); +0x10 the
    artist's scene graph (names 16 B, translation 4f, rotation 3 x s16, scale 3f per node).
  - Every frame all subs are hidden (0xF21D0), then the Rint tree is walked (0xF2240): cells (bbox, count, entries
    (child cell, 0xFFFF) or (1, node)); a visible node picks one of four LOD lists by camera distance (thresholds
    at [0x228E40]); each list entry (u16 instance, u16 sub within it) shows that sub.
  - Swap = 8 "render groups" ("0".."7" entries -> "render group" ranges over a u16 instance list): an empty Swap
    leaves the track undrawn. Lowe's: 0 track / ground, 2 walls, 3 buildings and stands, 5 scaffolds and pit
    banners, 6 fences and crowd quads, 7 empty.
  - Fade: one u32 per instance. Matl: count, then the record offsets (only the first is relocated: records are
    contiguous — tmdl.mjs now reads them that way). Draw flag +0x11 bit 0x20 marks the swappable pit banners.
- tmdl-build.mjs buildTMdl(scene, template): Info, Swap (groups from material.group or texture alpha), Geom
  (40-byte vertices, one strip per piece), Lite (template), Matl ("1P_BT", one texture), Txfm, Inst (one instance
  per piece; scene graph from the template), Rint (one node per piece, one cell), Text (A8R8G8B8 swizzled with
  mip chains), Fade. No DInf.
- Test: Lowe's re-exported (pieces, the colour texture of each material) and written by the builder; Race Now at
  Lowe's on it draws the track (rs_built.png): ground, track, walls, buildings; multi-pass detail layers are lost and
  a grandstand face is white (its material needs more than one texture or a different group). Splicing the built
  chunks into the original one by one (splice.mjs) isolated the empty Swap as the only blocker.

### Track step 4b: materials and placements in the builder (catch fence / grass fix)
- User report: catch fence solid white, track/grass textures different on the built model. Two causes.
- Materials: the builder wrote every material as shader 1P_BT with only the first texture. Matl records now carry the real
  shader name and all texture layers (rebuild.mjs passes `shader` and every texture; `--single` restores the old way).
  The Matl parser had a bug too: records are contiguous 0x30-byte entries after the first offset (`u32(L+4) + k*0x30`).
- Placements: repeated objects (fence posts, light poles; 913 subs at Lowe's, 1356 at Atlanta) are a single mesh drawn
  once per scene-graph node. Inst sub +8 = node index into H, +12 = draw index. H = {count, names 16B, translation 16B,
  rotation 3 x s16 (32768 = 180 deg), scale 12B}; matrix = T * Rz * Ry * Rx * S.
  - tmdl.mjs: model.nodes, model.placements, nodeMatrix(); exportGLTF bakes each placement (Atlanta export now complete).
  - tmdl-build.mjs: pieces[i].placements = [{name?, t, r (deg), s}]. The builder generates H itself (node 0 = identity,
    one node per placement), one instance per piece with one sub per placement, and one Rint node per sub using the
    placed (world) bounding box. Nothing is copied from the template now except Lite.
- Result (Lowe's rebuilt from parse, Race Now, deterministic): light poles and fence posts present; remaining difference is
  per-pixel texture noise from the ARGB re-encode (mean 8.4/765), no missing geometry. rs_pair3.png = original | built.

## Track packs (track-pack.mjs, gltf-read.mjs, tracks-server.mjs, tracks-ui.js)
- Slots: TK_REND has one model per race dressing (76 entries; day / night / sponsor signage); RACE.RTID picks the
  entry (Daytona 500 RTID 12 = DTA_DAYTONA, UAW-DaimlerChrysler 400 RTID 25 = LAV_UAW). TRCK.TPID picks the
  TK_PHYS entry. `node track-pack.mjs slots <Data>` lists them with track and race names (cached in
  roster/tracks/slots.json: reading all 76 names takes ~14 s).
- A pack (roster/tracks/<id>/): track.json { name, author, model, slots, enabled } + a glTF / GLB model. Build
  (node track-pack.mjs build, or the launcher) writes build/tk_rend_<slot>.bin with that slot's own model as the
  template (Lite and the Info name come from it) and build/build.json with a key over the pack's files, model and
  slots (renaming or enabling does not need a rebuild). nt04-config withTracks() (called by uis-run after
  withRoster) adds entryOverrides for every enabled pack with a current build; the config's own entries win;
  several packs on one slot: the last by folder name wins (the launcher warns).
- Importer (sceneFromGLTF): metres -> cm, y up; a mesh used by several nodes = one piece with placements (matrix
  decomposed to t / Rz Ry Rx / s, falls back to baking on shear; the uniform scale is moved into the geometry);
  other meshes baked to world space and cut into 60 m tiles per material, at most 16,000 vertices per piece;
  triangles / strips / fans; missing normals computed; COLOR_0 = the game's vertex colours (white when absent).
  Materials: extras.nt04 { shader, group, layers [{ image, offset, scale }] } when present (the game's layered
  types), else the base colour texture (+ KHR_texture_transform, baseColorFactor) as 1P_BT; alpha kept only for
  MASK / BLEND (group 6). PNG only; sizes rounded to powers of two, at most 1024.
- Starter export (exportStarter): one glTF mesh per piece, one node per placement (shared meshes), all layers as
  PNGs with nt04 extras, alphaMode BLEND when the main layer has alpha; root node scales cm -> m.
- Checks (Race Now at Lowe's, deterministic): starter export -> build -> race = the same frame as the model built
  directly from the file (rs_pack); the same pack made through the launcher API and picked up by withTracks:
  identical (max difference 0). Without the extras (a plain glTF, as a Blender export without custom properties):
  works, track and grass flatter (single layer). Textures edited in the starter pack show in the race
  (rs_edit_pair.png: grass recoloured).
- Correction: my earlier comparison pictures carried the framebuffer's alpha channel (rshot wrote RGBA), which
  image viewers composite as a white haze; the game's screen shows RGB only (play-client's blit writes alpha 1).
  rshot.mjs now saves RGB. The "washed out" look of the single-texture build was mostly that alpha.
- Limits now: the slot's physics / AI lines / pit stalls / shadows (TK_SHAD) / sky / pit banners stay, so the
  racing surface must keep the original layout. New layouts need generated TK_PHYS (next).

## Added tracks (track packs, mode "add")
- Drivers were already additive (applyRoster: new DRVR / CARS / CRSK rows with ids from 250; the game's drivers stay).
  With more than 43 eligible cars the qualifying extension (QGEN by TPHD) decides who starts.
- How track select groups tracks (queries in the exe): tracks = select TPHD, TRID, TSNM, TIFY from TRCK where TIPP = 1
  and FRSZ = 0 order by TSOR; races of a listed track = RACE inner join TRCK on TRID where TRCK.TPHD = ? (so day /
  night rows of a track share a TPHD: "home track"). TPHD (0..47) also keys QGEN (pole time), TSCC / TSCD (setups),
  DCST, PTSF, AIBL, the ER** AI tables, BLTM (best laps), SBLT, SVCS.
- applyTracks (nt04-config, cfg.addedTracks from withTracks; runs before schedules so they can name the new races):
  copies the base race's TRCK row (new TRID and TPHD, TIPP 1, FRSZ 0, TSOR last, names / city / state), its RACE row
  (new RAID, TRID, RTID = the pack's new TK_REND entry, race name, laps), and the base's rows of the per-track
  (TRID: AICA LCON PTRK RSPR TAUD THLD TKSH TKSK ZBIA), per-home-track (TPHD: AIBL DCST ERBO EREB ERLA ERLB ERLC
  ERXB PTSF QGEN), per-race (RAID: AIFW AITW AIWS PTRF) and per-model (RTID: TFOG) tables; BLTM / CCST / SBLT /
  SVCS get capacity for one more home track. TPID (physics), TAID (photo), TLID stay the base's.
- Ids (tracks-server newIds): the next free after the game's and other packs' (TRID 65, TPHD 48, RAID 80, TK_REND
  entry 76 for the first), kept in track.json so they stay the same.
- Verified (Race Now, deterministic): with an added pack the track list has the new track last (16 x down from the
  default Talladega); picking it sets GINF TRID 65 / RAID 80, the race loads TK_REND 76 (the pack) and TK_PHYS 25
  (Lowe's), and runs (track_added_race.png: the pack's recoloured grass). Lowe's itself still loads entry 28.
  Same with a pack made through the launcher API.
- Not yet: season schedules (config "schedules" can list the new RAID), the track photo / map (base's), records.

## Schedule editor (launcher Schedules tab: schedules-server.mjs, schedules-ui.js; nt04-config withSchedules)
- What the game does: Season Settings and Career Settings both have a "Schedule" choice, 12 / 24 / 36 Races =
  SCHD 0 / 1 / 2 (the texts are fixed strings in the settings screens: strings 11-13 of screen 4/0). A season
  copies the chosen schedule without exhibitions (RACE.ASTY 1 All-Star, 2 Shootout, 4 All-Star Open) into SCHD 3;
  a career uses its schedule directly (GINF.SCID; default 1 = 24 races). The career "New" query sets SCID 1
  ("... TWYP = 1 and SCID = 1 ..." after clearing OFFR / CONT); the settings write the choice with
  "update GINF set SCID = ? ...".
- roster/schedules.json { schedules: { "0".."2", "4".."6": [RAID] }, careerSchedules } -> config schedules /
  careerSchedules (the config file's own entries win). Schedules naming a race that does not exist (a track pack
  switched off) leave it out with a message instead of failing.
- careerSchedules: gamecode moves the value of "update GINF set SCID = ?" up by 4 while GINF.GMOD = 2 (career), so a
  career uses SCHD 4 / 5 / 6; applyConfig fills any of those not configured with a copy of the season one.
- Settings labels: uis-vm loadScreen has a textPatch hook (screen texts replaced before the screen runs, within
  their space); uis-run uses it for "12 / 24 / 36 Races": the count of points races in the schedule the choice
  means (career ones in career mode), read from the game's live database.
- Verified: season schedule 0 with 18 points races -> settings show "18 Races", season NRAC 19 (with the Shootout);
  careerSchedules with schedule 5 = 5 races incl. the added track's race -> career settings "5 Races", GINF SCID 5,
  NRAC 5; a season whose first race is the added track: hub "Next Race: Purple 500, Race: 1/4"
  (season_added_track.png; the logo is the base track's). Launcher page: edit, add, reorder, save (playwright).
- Not checked yet: a career's second year (whether the rollover keeps SCID 4-6).

## Track physics for new layouts, step 1: the collision layer decoded (tkphys.mjs parseCollision / withCollision)
- Functions: loader 0xD9CB0 (all offsets from counts; also sets the per-section list pointers +0x44.. and the ring
  +0x5C / +0x60), per-section setup at load 0xD6F50 -> 0xD59D0 (triangle neighbours along the track direction),
  0xD64F0 (walls near each triangle), 0xD67C0 (surface triangle under / over the apron: flags 1 / 2), 0xD6CD0
  (flag 4: triangle not flat against its vertices' planes); results in a table of 10 bytes per triangle
  (0x2DD4B0) and the triangle bytes +0x25 / +0x26: not stored in the file. Location lookup 0xD7380: walk the
  section ring (up to 7 each way) until the point is on the positive side of a section's start and end planes,
  then the nearest wall within 20 ft (kinds 5, 6, 4); 0xD71C0 / 0xD8DF0 use a location {section, kind (0 surface,
  1 apron, 2 B, 4/5/6 walls, 3/8 none), u16 index}.
- Records: section 0x64 (bounds, 2 floats, start plane, end plane, 6 u16 counts, runtime); triangle 40 (3 vertex
  indices, track direction, plane = the plane through its 3 vertices (unit normal), u8 surface type: 0 racing
  surface, 6 apron, 7 grass, 1 pit road / concrete, 3 pit stalls — phys_lowes_types.png); wall 0x2C (top pair and
  bottom pair of wall points, vertical plane, top z, u32 kind 8 outer wall / 12 inner and pit walls, two small
  u16 not decoded, index in the list, section); wall points: 12 bytes, 4 per wall quad. Vertices: xy + own plane.
- parseCollision -> objects; collisionParts / withCollision write them back: all 65 TK_PHYS entries rebuild byte
  for byte from the decoded objects. Raising every surface / apron / vertex plane by 4 ft: the race camera and
  cars ride 4 ft higher (rs_up4), so the cars drive on this layer.
- exportCollisionGLTF: the collision layer in the render frame (metres, y up; render = (x, z, -y) x 30.48 cm) as
  coloured meshes + wall quads. Starter packs now include physics-reference.gltf (the slot's physics entry via
  RACE.RTID -> TRCK.TPID) to line models up in Blender; the walls overlay the render model exactly (checked).
- Still to decode for generating a whole entry: the wall u16 pair +0x24 / +0x26, the section floats +0x10 / +0x14
  (0 so far), the AI / pit lines (line records 0x90, nodes 0x1C, the per-segment arrays, 64-byte segment data),
  spot tables (grid, pit stalls), the 0x20 / 0x78 / 0x68 records, k12, crowd quads and the tail.

## Track physics for new layouts, step 2: lines, spots, the whole entry as a document (tkphys.mjs)
- Lines (accessors 0xD7830..0xD8D10): record 0x90 {u16 segments, u16 points, 11 node counts, runtime pointers};
  points = quadratic Bezier control points (start, middle, end per segment). Per segment: arc length, cumulative
  length, cubic t -> distance (0xD79D0), 64 bytes (camera code 0x35690 / car tracking 0x1D460; not decoded); per
  segment + 1: lap fraction measured on the racing line (closed line: first = last, 0xD7920).
- Profile: 7 x s16 arrays, 7 samples per segment + 1, inches (0xD7E50: x 1/12, linear between samples): 0 the
  line's own offset, 1 / 2 inside / outside racing-surface edge, 3 / 4 paved edge, 5 / 6 walls (outside edges are
  clipped to the wall).
- Node lists: 0x1C {x y z, position along the line (segment + t), s32 value}; a value holds from its position on
  (0xD7CA0, 0xD7D00 default 9, 0xD7D60 also returns the next value and the distance to it). Seen: list 0 speeds
  in mph (pit entry 150 -> 120 -> 60), 2 / 4 zone numbers, 5 / 6 corner kinds read by the AI (0xC9190), 8 / 9 TV
  camera numbers (200-ish / 300 / 480 codes), 10 on lane lines.
- Spots (0x3C): position, 3 x 3 axes, section index, two u32 (line / segment reference?). Lowe's: table 0 the
  starting grid (44, two wide, before the line), 1-5 other formations, 6-11 single spots. 0x20 records: TV
  camera positions (100-170 ft up); k12: 68 points 113 ft up along the outside = the light towers (night glows).
- Derivable from the geometry (checked on 4 tracks, 4,598 segments): length (within 0.5 %), cumulative length
  (exact), the cubic (fit, within 5 % of the length), lap fraction (0.0004); profile from the collision layer:
  outside arrays within 0.4-1 ft, inside ones mostly within 1 ft but 4-40 ft off around pit road (the game's rule
  there is not known yet).
- physDocument / physToJSON / physFromJSON / physFromDocument (CLI: tkphys doc / fromdoc): every TK_PHYS entry as
  an editable JSON document (collision, lines, spots decoded; the 0x20 / 0x78 / 0x68 records, k12, quads and the
  tail as hex) and back: all 65 entries rebuild byte for byte through JSON (negative zeros and the few NaN
  floats in degenerate triangles kept as "-0" / "nan:<bits>").

## Track physics for new layouts, step 3: the layout generator (trackwarp.mjs, aispeeds.mjs, track packs)
- AI_SPDS.DAT (aispeeds.mjs; one entry per TRCK.TPID like TK_PHYS; loader 0x20290, lookups 0x201C0 / 0x20240 /
  0x20340): 19 x {count, offset} = the TK_PHYS line groups; per line {node ring, speed bytes}; nodes {f32 position
  (segment + t), s32 mph, next}; speed bytes 31 samples per segment + 1 (used when present); pit stall groups 9 / 10
  use group 11's first line. All 65 entries rewrite with identical decoded content.
- warpTrack({ data, baseRend, basePhys, layout }): every point of the base track (collision vertices, wall panels,
  line control points, spots, cameras, lights, render vertices and object places) keeps its lap fraction s and
  sideways offset d from the base centre and is put at (s, d) on the new centreline; heights keep their offset from
  the base cross-section (Z + slope x d) on the new one (banking "auto" from curvature or per point). Sideways
  offsets past the new centre of curvature are squeezed. Long collision edges are cut first (conforming,
  longest-edge-first: the game links triangles by shared edges, no T-junctions), sections get planes at the base
  section planes' crossings, triangle / vertex planes are recomputed (vertex plane = averaged neighbours), lines
  get new middle control points, lengths, cubic and lap fractions; AI speeds scale by sqrt(new radius / base).
- Render model (warpRend): world pieces are cut to 24 ft edges near the track (up to 4 x that far away; an
  unlimited allowance left one infield ground triangle 3,800 ft across, which sat above the road), keep the base
  model's render groups (Swap chunk), and the base's ground sheet (a piece mostly under the collision surface) goes
  1 ft lower: its larger triangles bend differently from road / grass / markings inches above it and showed
  through as black. tmdl-build: pieces of more than 10,000 triangles are split (the game draws a strip with a
  16-bit index count: a strip of 77,667 indices drew only its last 12,131 as garbage).
- Track packs: track.json "layout" (a .json layout, or a .glb / .gltf with a mesh named centerline, an edge loop) +
  "layoutOptions" (bankStraight / bankTurn): the build writes tk_phys.bin, ai_spds.bin, layout.svg and, without a
  model, the warped base scenery as the render entry; packState overrides TK_PHYS / AI_SPDS at the pack's own TPID
  and sets TRCK.TLEN to the new length.

## Added tracks: why the AI did not drive (fixed)
- Symptom: on an added track (and on any track once a pack was installed) the field stayed in formation and rolled
  backwards; the database answers, archive entries and TRCK / RACE fields were all ruled out one by one.
- Cause: the physics / AI constants block (0x5E0E0, [0x2F2F60], 0x561C bytes) is the CNST tables copied back to
  back, and 7 of them are keyed by an id the game indexes at fixed offsets: AICA (+0x18, 44-byte rows) and ZBIA
  (+0x5414, 8) by TRID, AIFW (+0xB74), AITW (+0x1790), AIWS (+0x1F3C, 24 each) and PTRF (+0x3240, 48) by RAID,
  PTSF (+0x4140, 92) by TPHD. applyTracks' cloned rows made the tables longer, so every table after them moved
  (wrong gear ratios, grip, AI tables for all tracks).
- Fix (gamecode): the block keeps the game's own id rows only (CNST_ID_ROWS: 65 / 80 / 48), so its layout is the
  shipped one; the sites that index those tables get the base track's id for an added one: they read it from the
  getters 0xDA7A0 (TRID [0x2DD4B8]) / 0xDA7B0 (TPHD [0x2DD4B9]) right before (17 TRID and 4 TPHD return
  addresses; every other caller gets the real id), and the AI set-up 0x12B60 indexes the per-race tables with
  [0x28A56C] from "select RAID from GINF" (0x132B4; remapped after the query, its getter 0x13750 still gives the
  real id to its other two callers).
- TK_SCORE.DAT is indexed by RACE.RTID too and has 78 entries (77 is loaded in every race): added tracks' model
  ids start at 78 (track-pack FIRST_RTID; the launcher renumbers older packs), and each gets a copy of its base's
  scoring entry (entry overrides accept "@N" = a copy of the archive's own entry N).
- Verified (Race Now, deterministic): Lowe's with a pack installed 0.67 laps in 30 s (without 0.64); the added
  Purple track (glTF model) 0.65; the generated paperclip layout through the track list: 42 of 43 cars past 0.9
  laps, mean 2.9 laps in 150 s, on TK_PHYS / AI_SPDS 65 and TK_REND / TK_SCORE 78 (generated_layout_race.png).

## Launcher "Start at: Title screen / Main menu"
- These booted the frontend directly (screen 0/2 or 0/5 with the screens' JS stand-ins, no game flow behind them):
  the driver select had no background, portrait or car, and picking a track ended the frontend (no screens, black),
  so no race could start. main.mjs now always runs the game flow; "title" skips the intro movies, "menu" also
  presses START at the title screen (boot: skipped to the main menu). NT04_DIRECT_BOOT=1 keeps the old direct boot.
- Driver select itself shows its list first and the background / portrait / 3D car a few seconds later (car model
  and portrait textures loading; the page shows 0 fps meanwhile).
- "Unable to load User Profile from hard disk" with a track pack installed (fixed): BLTM / CCST / SBLT / SVCS are
  saved in user profiles and the game checks a profile's size, so the extra capacity applyTracks gave them made
  every existing profile unreadable (the game then made new ones, User Profile 5-8). Their capacity now stays;
  nascar-db Database.overflow lets an added track's rows go past it, and saves / the save checksum leave those rows
  out (savedRows), so best laps / setups at added tracks last only for the session.

## Generated layouts: scenery and camera fixes (from a play-through of the paperclip oval)
- Road missing in the turns (black, the ground sheet showing): 226 of Lowe's road / grass / shadow pieces hang under
  a group node ("Lowes_base_LODP", 4 ft up) and were treated as repeated objects (moved rigidly). A piece placed
  once now gets its node's transform baked in and bends with the scenery; only pieces placed several times stay rigid.
- Infield folded over (ground sheet face down over the turns): the nearest-centre search gave up past ~2,400 ft and
  used an arbitrary sample, so far terrain got offsets of -4,000 ft and was squeezed into the infield; it now falls
  back to every sample. Offsets beyond a 150 ft band are scaled from the base's room to the new layout's room on that
  side (half the distance across to the centreline's other parts; finishFrame ROOML / ROOMR), then squeezed, also short
  of the centre of curvature in turns (a narrower infield than the base's no longer overlaps itself).
- Pre-race / grid camera shots looking at dark slopes: TK_PHYS 0x78 records are cameras (position +0x40, far aim point
  +0x28, two yaw angles in degrees +0x4C / +0x50; car-attached ones have position 0) and 0x68 records positioned
  objects (position +0x50, heading in degrees +0x64); both stayed at the base track's coordinates. They now move with
  the layout, aims and angles turned by the local heading change.
- Still the base race's: the race logo on the pause / weekend screens (RACE.LBNR).

## Generated layouts follow a model's own road (trackwarp centrelineFromGLTF)
- A layout read from a model (edge loop "centerline") now also reads the road: meshes or materials named like
  road / track / surface / asphalt / tarmac (roadTrianglesFromGLTF), a height field of them (triHeightField); at
  every centreline point the height at the centre and 20 ft either side give the layout's z and bank (per point;
  the "auto" banking and the launcher's banking boxes are then not used). The warped physics' racing surface then
  lies on the modelled road (test model: 5 deg straights, 24 deg turns: physics within 0.05 ft across the racing
  surface; past the base track's edges the base's apron shape, about 1 ft off at 25 ft inside on 24 deg).
- Test pack (model = layout = my-oval.glb: road ribbon, grass plane, centerline, "start" empty): builds the model as
  the scenery and the warped physics under it; Race Now: 39 of 43 cars past 0.9 laps in 60 s, the field on the
  modelled road in the pre-race shots.
- (Superseded below: widths and walls now come from the model too; pit road and grid lanes still the base's.)

## Generated layouts take the model's widths and walls
- centrelineFromGLTF also measures, at every centreline point, where the road mesh ends on either side (edges) and
  where a ray across meets a mesh named like wall / barrier / safer (walls; those meshes and materials are left out of
  the road). The warp's sideways map then goes through knots: base racing-surface edges -> the model's road edges
  (outside edge -> the model's outside wall when it has one, the base's outside wall standing at its edge), base inside
  wall -> the model's inside wall, linear between, shifted beyond. Heights use the base's racing-surface clamp mapped
  the same way. Layout option widths:false keeps the base widths.
- Section boundary planes: the base boundary line carried through the mapper (two points 25 ft either side of the
  base centre, mapped), so they lean with the stretching instead of staying square to the new centreline; square
  when the carried line is unusable. (A fit through the vertices two sections share was tried and dropped: sections
  share whole rows of triangles, so the fit leaned 10+ degrees.)
- Bug this exposed (game side): the walls near each collision triangle (0xD64F0 at load: up to 7 u8 ids per triangle
  in the 10-byte records at [0x2DD4B0]) count across the section's three wall lists (kind 6 +0x40 / list +0x50, kind 5
  +0x42 / +0x54, kind 4 +0x3E / +0x58). Triangles at section overlaps are listed in two sections; looked up through
  the other one (0xD71C0 -> 0xD7180 id -> wall, 0xD6470 id -> kind / index) an id can run past that section's walls
  and the car's wall tracker gets a garbage plane. At the wide test oval (inside wall 130 ft from the inside edge, so
  the nearest wall is the outside one, id past the next section's 20 + 14) the player's car was "pushed out" of it:
  position z 400,000 ft at a fixed spot of the pace lap, its camera with it, and from then ~21 global location
  searches (0xD8E70, all sections' triangles) per frame: the race ran ~9x slower. Same ids out of range at My Oval
  (~90 per frame) but harmless there. gamecode wallIdHooks (only with added tracks installed; the stock tracks never
  hit it) takes an out-of-range id as the section's last wall, the wall 0xD64F0 itself falls back to.
  After: wide oval 0 searches per frame, Race Now 32 of 43 cars past 0.9 laps in 60 s (mean 0.93; longer lap).
- Builder fixes found on the way: textures of a model with 3+ materials (MMAP laid out like TK_SHAD: names after the
  image data, then the texture table, texture entry field 0 = 1; before, materials 0 and 1 got no texture); texture
  names unique and not prefixes of each other; vertex colour [150,150,150] when a mesh has none (unlit look matches
  the stock scenery).

## Generated layouts: pit road and ground from the model; race loading of big collision data
- The model's ground: every mesh but walls and the centreline (centrelineFromGLTF groundAt). Off the road on the
  inside (apron, pit road, infield) the warped physics takes the model's surface there: the highest one up to 25 ft
  above where the base's ground would have gone (so not roofs or bridges), what stood above the base's ground (cameras,
  lines, wall tops) as high above the new one. Outside a modelled outside wall it is left alone (out of reach; its
  ground would pull the road's edge triangles down).
- The model's pit road: a mesh named like "pit" (pit road / pit lane; not "pit wall"): per centreline point its near
  and far side going inward. The base track's pit road far side (PFAR: pit lanes = line group 11, stall paths 9 / 10,
  pit-stall triangles = apron type 3, +4 ft) goes to the model's far side, its pit wall (inside wall profile) to the
  model's inside wall there (the wall nearest the road: the pit wall); linear between. Where the model has no pit road
  the map fades over 200 ft to the plain shift. The room squeeze starts past the pit road (it squeezed it before).
  Only the stretch where the base has its pits is placed (no along-track remapping): the model's pit road should be
  on the same stretch (front stretch at the oval bases). Lowe's has no collision wall on its pit wall line (only the
  stall back wall), so a modelled pit wall is scenery only.
- Test model mkoval3 (pit-oval.glb): infield ring from the road's inside edge to 2 ft, pit road 60-100 ft inside on
  the front straight, pit wall at 58 ft. Physics: pit stalls (type 3) at 2.0-2.2 ft across y -690..-650 (60-100 ft
  in), stall back wall at 98 ft, pit lanes 66-85 ft in.
- Race loading ran out of steps (and left the walls near most triangles unset: cars went through walls, the "out of
  range wall ids" of the section before were this): the collision set-up 0xD6F50 assigns each triangle record an id
  (0xD59D0, +0x26), then per section works out the walls near each triangle (0xD64F0: every triangle x every wall,
  0xD6220 = crossing, within 8 ft (0xD61B0) or crossing when moved 8 ft toward the middle) and flags between racing
  surface and apron (0xD6C20 -> 0xD67C0: every surface triangle x every apron triangle and back; 6 point-in-triangle
  and 9 edge-crossing tests a pair; flag bits in +0x25). Quadratic per section; the warp's refinement (every edge cut
  to 24 ft) made 43,775 triangle records (stock Lowe's 4,401) and sections of 1,500: past the 1e9 step limit of the
  module load, abandoned after section 0 (ids 0 for the rest: they all shared entry 0's walls).
  Fixes: (1) the warp cuts edges only where it bends them: a size field from a 24 ft probe's offset at the edge's
  middle (offset under 0.3 ft within 120 ft of the centre, looser farther; edges 12 / 24 ft at least, 400 at most;
  flat triangles never ask for cuts: bisecting them cycles) -> ~18,000 records at My Oval, ~27,000 at the pit oval
  (ids are 16-bit: must stay under 65,536; probes at several points along each edge also catch the sideways map's
  knots and gave 45-67,000); walls stay every 24 ft
  (cut adaptively the race never started at the test oval; walls are few, so they stay at 24 ft). (2) gamecode collisionSetupHooks
  (added tracks only, long lists only): 0xD67C0 gets the other list cut to the triangles whose box meets this one's;
  0xD64F0 is done in JS the game's way (kind-4, kind-6, kind-5 lists in order, up to 7, none: the last wall looked
  at; more than 7: none), asking 0xD6220 only for walls within 9 ft of the triangle's box; 0xD6220 itself answers no
  at once past that. Checked: per-triangle flags, ids and the near-wall table identical with and without (hashes),
  set-up 12.7 s -> ~3.4 s. (3) Step limit default 2e10.
- With the set-up complete for the first time, the race stopped at the first wall contact ("process tick: bad
  address 0xc44...", in 0x4FF70 -> 0x4FA80): wall records hold neighbour links, +0x20 / +0x22 previous wall (index in
  its section's list of the same kind, section) and +0x24 / +0x26 next (-1 none; 0xD9AE0 / 0xD9B20, read by the wall
  contact code). Base Lowe's: all 1,007 consistent. Cutting walls into pieces copied them, so 95% pointed at other
  walls or past the lists. trackwarp now re-aims them at the pieces (first piece's previous = the previous wall's last
  piece, and so on): 2,599 / 2,599 consistent at all three test packs. (The earlier "AI frozen / race never starts"
  after the set-up fix was this, and before it the set-up never got far enough for the links to be read.)
- The model's ground is used only within 8 ft of where the base's ground would go (My Oval's road floats 13 ft above
  its grass plane: the apron triangles dragged the road's edges down), from 3 ft past the road's edge, blended in over
  6 ft. Heights at My Oval: centre 8.0, edges 5.6 / 10.4 (model 5.4 / 10.6), turn 24 deg exact.
- After all of it (Race Now, 60 s): My Oval 40 of 43 cars past 0.9 laps, Paperclip 37 of 43, pit oval 28 of 43
  (longer lap; mean 0.79), no process faults; the bot's car stops against the outside wall instead of passing it.
  Pit stop on the pit oval: the game takes the car down pit road (state 5) and back out (3); one run earlier (before
  the link fix) stuck at the end of pit road past the model's pit stretch, where the base's pit road is longer than
  the model's (no along-track remap yet).

## NR2003 track conversion (nr2003-dat.mjs, nr2003-track.mjs)

Converts a user's own NR2003 track folder into a track pack. Nothing from NR2003 is shipped; the user points it at their copy.

    node nr2003-track.mjs info    <NR2003 track folder>
    node nr2003-track.mjs convert <NR2003 track folder> <roster/tracks/<id>>   then build the pack in the launcher's Tracks tab

**.dat archive**
- Header: u16 (0xFEF9 / 0xFF1D; not a fixed magic), u32 directory size, u16 0. The first entry is at offset 10.
- Entry: u8 5, u8 method (0 stored / 2 imploded), u32 size, u32 stored size, u32 offset, u8 name length, name, NUL.
- Imploded data is PKWARE DCL, decoded by a port of zlib's blast (`explode`). Names can carry folders (`trackmat\asphalt.mip`).

**.ptf object stream (Papyrus)**
- Per object: u32 oid, u32 cid, plus u32 length + class name the first time a class appears. Lists are u32 byte count (n*4) followed by objects.
- **SegmentDescriptor:** X / F / W section lists. Tail of 6 doubles (x0, y0, h0, x1, y1, h1); Wilkesboro adds a 7th. Equal headings mean straight, otherwise a circular arc with R = length / dh. dlong 0 is the start/finish line, counter-clockwise, in metres.
- **X_Section:** height knots, two per section. Format 2 is (dlat, z, dz) doubles. Format 3 is f32 dlat, double z, f32 dz. z is absolute; dlat is positive to the left.
- **F_Section:** surfaces (format 4: doubles; format 5: f32) and texture name. **W_Section:** walls (format 7: f32 dlat start/end).
- **track.ini:** name, city, laps, stalls / grid (dlong/dlat), pit_lane_start/end_dlong.

**Layout**
- Points every 3 m.
- Outside edge is the right-hand wall. Inside edge is the last surface boundary at least 1 m short of the inside wall.
- z and bank come from the height knots at the edges.
- A lateral ground grid (4 ft step) is laid from the knots. trackwarp `groundFromGrid` uses it instead of the base track's ground (blend starts 0.5 ft off the road), which fixed Milwaukee's apron ditch.
- Pit near/far come from the track.ini stalls.
- trackwarp `warpAI` now scales the base AI speeds by sqrt(limit_new / limit_base). The limit is R(mu + tan b)/(1 - mu tan b), mu 1, at the same lap fraction, smoothed ±4 samples.

**Test harness note.** The added track is the last in the track list: `TRACK_DOWNS=16` from the default Talladega. The default (8 × Up) lands on Lowe's.
- The first "results" recorded here (38 / 43 Milwaukee, 39 / 43 Wilkesboro) were Lowe's races, not the converted tracks: withdrawn.
- On the real tracks the field spun and stopped (0–9 of 43 past 0.9 laps), and race loading logged a tick error.

**Scenery (nr2003-mip.mjs, nr2003-3do.mjs, nr2003-scene.mjs).** `convert` now also writes model.gltf + model.bin + textures/*.png and sets track.json "model".

*.mip textures*
- 32-byte header, then per mip level (smallest first): "PAMB" { "DHMB" (u8 format, u32 width, u32 height, u32, u8 packed; padded to 4), "ATAD" pixels }.
- Formats: 0x0a DXT1, 0x0b DXT3, 3 / 4 uncompressed.
- Big DXT3 levels are PKWARE-imploded (packed = 1), decoded with the .dat archive's `explode`.

*.3do models*
- The same object stream as the .ptf, a tree written depth first. A back-reference to an object already written is its id + class 0.
- StateSwitch / LodSwitch / Group (Transform only in the animated flagmen) end with a child list (u32 4n + children). Only the first child of a switch is kept (most detailed LOD, first state).
- Shape → Appearance → Texture (.mip name) and Geometry → PlainVertexList (u32 1, 0, 1, 1, N; lists of N doubles each led by 8N: x, y, z, a u32, nx, ny, nz, a u32, u, v) → TriList (1, 0, 1, 0, 1, n, 4n, indices) or TriStrip.
- A TriStrip may only wrap the next primitive. Primitives are collected until the next non-geometry object.
- Header scan skips vertex and index payloads (index data looked like headers).

*.ptf additions*
- F_Section: after the dlats a byte, u32 1, u32 surface type (1 asphalt, 2 apron / concrete, 3 paint, 4 grass), then its Appearance (or a back-reference) → texture.
- W_Section format 7: f32 dlat start / end, byte, u32, double height start / end (m), 4 doubles, ..., Appearance → texture.
- TSOReferenceDescriptor: u32 1, 0, 1, x, y, z, heading (rad, CCW about z), pitch, roll (doubles), then its TSODescriptor (u32 1, 0, 3, .3do name, a copyright string) or a back-reference.
- With a .ptf both beside and inside the archive, the one whose objects the archive has wins (Wilkesboro: the archive's wilkessrc_06.ptf, 35 missing vs 73).

*Scene*
- Road: per segment, strips between F boundaries, cut at the height knots, heights from the same knots as the layout. Textures in 8 m tiles; a strip under 1.5 m wide takes the texture once across.
- Walls: two-sided faces of the W height.
- Objects: one glTF mesh per .3do, a node per placement.
- Frame: NR2003 (x, y, z) m → glTF (x, z, −y), which track-pack reads back as the layout's feet.
- Objects from NR2003's shared folder (c_light, cone, ...) are not in a track's archive: left out and listed.

**Fixes found on the real tracks**

1. *Race loading hung in 0xE9A50.* This is the nearest-point-on-curve fallback of 0xE9F70, called from 0xDB870. It narrows [lo, hi] with step = max(0.1 (hi − lo), 0.001) and stops only when B(mid ± step) are within 1/24 ft, so on a curve longer than ~21 ft it never stops. The step limit cut the loading tick.
   - gamecode `curveNearestHook` replaces it, for added tracks only (`NT04_NO_CURVE_FIX` turns it off). Same search, stops after 64 rounds. Leaves the signed sideways distance on the x87 stack, writes B(t) to ecx and t to arg 1.
   - Constants: 0x204624 0.5, 0x2046B4 0.1, 0x204660 0.001, 0x2045F8 1.0.
2. *Physics surface off the road by up to 1.6 ft at turn entries.* With the midpoint probe only, 4400 sample points at Milwaukee were more than 0.3 ft off the layout's plane.
   - Layouts with a ground grid now probe edges at 0.25 / 0.5 / 0.75: 89 points, 63k triangles. Falls back to the midpoint probe past 65,000 (16-bit ids).
   - The ground grid also takes over right at the road's edge (0.05 ft, blended over 0.5 ft). Before, the base's apron shape left a 0.9 ft dip along the inside edge.
3. *"bad address 0xff000004" in the texture set-up 0x1317F0 at race load.* This happened with any custom model under about 500 draws: 341 and 471 failed; 531, 561 and 890 loaded. Which table indexes past the model's draws is not pinned down.
   - track-pack pads added-track models to 600 pieces with tiny ones 1 km below ground. BUILDER is now "track-pack 6".

**Results, 60 s race, 43 cars, headless, TRACK_DOWNS=16, both packs with their own scenery**

| Track | Cars past 0.9 laps | Mean laps | Tick errors | Notes |
|---|---|---|---|---|
| Milwaukee | 42 / 43 | 1.59 | 0 | Same result twice |
| North Wilkesboro | 36 / 43 | 1.45 | 0 | Some spins remain |

- Scaling the pack's AI speeds by 0.8 / 1.15 on the real Milwaukee changed little (6 and 4 / 43 before the fixes): the spins were the surface, not the pace.

**Still to do**
- The base slot's night lights and scoring tower still show (TK_SCORE / lights are the base's).
- NR2003 shared objects; LP racing lines; track.ini grid / pit stalls.
- Wilkesboro's remaining spins.

## NR2003 import: launcher, shared objects, racing line, base dressing
- **Launcher, Tracks tab: "Import an NR2003 track".** Takes a track folder and an optional shared-objects folder. Calls POST /api/tracks/nr2003 (tracks-server.mjs), which makes a pack (id from the folder name, new ids) based on Lowe's (RAID 8) and runs `convertNR2003`. The user then builds and enables it as for any pack.
  - Tested through the handler: the Milwaukee pack was made with ids TRID 65 / RAID 80 / RTID 78 and the converter log.
  - The build step was not tested this way (the test folder had no track-pack.mjs).
- **Shared objects.** `convert ... --objects <dir>` (repeatable) and `readNR2003(dir, { objects })`. After the track's own archive, the converter looks for loose .3do / .mip files (up to 4 folders deep) and the .dat archives in those folders (`assetSource`).
  - Tested with a renamed model standing in for a missing one: it was placed.
  - There is no NR2003 install on this machine, so the real shared folder is untested.
- **raceline.lp.** Read by `readLP`: u32 0x10003, count, then 24-byte records. f32 at +0 is speed-like; f32 at +8 is dlat (m, left +); f32 at +16 is the step (3 m).
  - It is written to layout.json as "raceline": the sideways distance per layout point, in feet, right +.
  - trackwarp puts the racing line (group 0) on it only with layoutOptions.useRaceline. Each point keeps its warped lap position, so the AI speeds per sample stay valid.
  - Milwaukee: no change (42 / 43, 1.60 laps).
  - Wilkesboro: worse (90 s: 32 / 43, 1.43 laps on the LP line vs 37 / 43, 2.12 laps without it). The lanes and AI speeds are still Lowe's, warped. So it is off by default.
- **Base choice.**
  - Martinsville (day, slot 29) under Wilkesboro: 6 / 43.
  - Phoenix (day, slot 40) under Milwaukee: 40 / 43 but 1.21 laps vs 1.60. The race is in daylight then, but Phoenix's pit banners and scoring tower float over the track.
  - Lowe's stays the base for imports.
- **Base dressing hidden.** For tracks with their own height profile (layout "ground"), the base's night glows (phys k12) and positioned objects (0x68 records) are moved 10,000 ft down. Layout option "hideBaseObjects": false keeps them.
  - The floating Lowe's light glows are gone. The scoring pylon (TK_SCORE model) still shows, and so does the dusk sky.
  - Races after the change: Milwaukee 42 / 43, 1.63 laps; Wilkesboro 36 / 43, 1.45 laps; no tick errors.

## AI speeds and pit road speed for converted tracks
**AI_SPDS lines (stock tracks)**
- Group 1 holds the three race lanes, each with per-sample mph bytes. Integrated along their own lines, the stock lanes lap within 1–2 % of TRCK.TQRT, the track record:

| Track | AI lane lap | TQRT |
|---|---|---|
| Lowe's | 29.34 s | 28.96 s |
| Martinsville | 19.75 s | 19.86 s |
| Phoenix | 26.63 s | 26.83 s |
| Bristol | 15.25 s | 14.91 s |
| Richmond | 21.02 s | 21.20 s |

- Groups 3 and 6 are the ways onto and off pit road (bytes from race speed down to the pit speed).
- Groups 4 / 5 / 8 / 11 (pit entry, pit road, pit exit, stall paths) are node speeds.
  - Talladega: 80→75 / 70 / 70 / 60, and its pit menu says "70 mph Speed Limit", so the shown limit is groups 5 / 8.
  - Lowe's: all 60. Phoenix 50. Bristol 35–40. Martinsville 40.
- Group 0 is a single node at or a little above the pit speed (Talladega 75, Bristol 40 vs 35): taken as the pace car's.
- The pit code reads group 11 line 0 (calls to 0x20340 with group 0xB at 0x2AFB1, 0x2B573, ...).

**NR2003 sources**
- track.ini [pit_lane_0] speed_limit_MPH: Milwaukee 40, Wilkesboro 35.
- track.ini pace_speed_limit_mph: 40.
- track.ini [cup] record_lap_time: Milwaukee 29.29 s, Wilkesboro 18.905 s.
- raceline.lp's first column is a relative speed along the lap. Corner / straight ratio 0.68 at Milwaukee, 0.70 at Wilkesboro. The scale is not the same between tracks: Σ 3 m / v ÷ record lap = 37.7 vs 44.6.
- nr2003-track.mjs writes layout pitSpeed, paceSpeed, recordLap and aiSpeed (the LP column per layout point).

**Build (trackwarp warpAI)**
- Race lanes = aiSpeed(s) × U, with U set so the lane laps in recordLap × (base AI lap / base TQRT). Lowe's ratio is 1.016, so Milwaukee 29.77 s and Wilkesboro 19.21 s.
- Without an LP the shape comes from a cornering model fitted on the base lane: v = min(vtop, sqrt(g R (mu + tan b) / (1 − mu tan b))), with braking / acceleration passes, R from the centreline's bend averaged over ±100 ft at the lane's offset. The lanes' own bends are kinked. Lowe's fit: mu 1.25, mean error 17 mph (its front-stretch dogleg).
- Groups 3 / 6: pit speed where the base sat at its pit speed, the race shape elsewhere, joined by the braking / acceleration passes.
- Pit nodes scale to the new pit speed; group 0 takes the pace speed.

**Result**

| Track | Race lanes | Pit road | Target lap |
|---|---|---|---|
| Milwaukee | 102–150 mph | 40 mph | 29.8 s |
| Wilkesboro | 100–144 mph | 35 mph | 19.2 s |

- Measured lap times (180 s race, 2 s samples, lap by lap): Milwaukee 32–36 s, Wilkesboro 26–32 s. The cars do not reach the targets, Wilkesboro by far. The earlier warped-Lowe's speeds were no faster. So something in the track itself holds them back (grip from the surface types carried over from Lowe's? the remaining bumps?) — open.
- The pit limit in the game (pit menu, speeding penalty) is not checked yet.

## Added tracks: home track by type, inside edge, material pass guard
**Home track by type**
- The per-home-track tables (TPHD) are now copied from a stock track of the same kind instead of the base race's:
  - DCST, the default setup: gear set GRAT (an index into PGER's 10 sets), spoiler, wedge, springs, bars, tyre pressure.
  - AIBL and ER**, the AI tables.
  - PTSF and QGEN.
- `track-pack similarHomeTrack` picks the listed track whose AI lanes top out nearest the new track's, plus a length term. It is written to build.json as "home" and passed to applyTracks as tk.home.
  - Milwaukee → Phoenix (154 vs 151 mph, GRAT 4).
  - Wilkesboro → Bristol (145 vs 146, GRAT 2), instead of Lowe's GRAT 6, which tops out near 198 mph.
- track.json "home" (a TPHD) forces a choice. "setup" overrides DCST fields.
- track.record (NR2003 [cup] record_lap_time) sets TRCK.TQRT / TQRS.
- Checked through withTracks → applyTracks: Wilkesboro's DCST is Bristol's row with TPHD 48; TQRT 18.905, TQRS 120.73.
- The Bristol setup alone did not change Wilkesboro's lap times.

**Inside edge (nr2003-track layoutFromPTF)**
- The inside edge is now the first height knot more than 5 m left of the reference line (where the banking meets the apron): Milwaukee 12.1 m, Wilkesboro 7.7–10.5 m. It stays short of an inside wall.
- Before, the last surface boundary short of the inside wall counted Wilkesboro's flat infield apron and pit area, out to 85 ft, as racing surface. The inside AI lane ran there and cars stopped in bunches at −40..−70 ft along turns 1–2 and the backstretch.
- 180 s race: Wilkesboro 42 / 43 past 0.9 laps (36 before), mean 6.05 laps. Milwaukee unchanged at 42 / 43, 5.20 laps.
- Best laps from 2 s samples: Wilkesboro 20–22 s (target 19.2), Milwaukee 26–30 s (target 29.8). The pack runs 26 s and 32 s laps in traffic.

**"bad address 0xff000004" at race loading: the real cause**
- The fault is in 0x131A10, sampler states, called from 0x132EA0 (one material pass) and 0x133470 (the pass walk).
- A 4-pass material instance (not the pack's model: its materials are all 1P_BT) had pass records of 0xFF000000: leftover memory, an opaque-black colour. Whether it happened moved with heap layout (model size, tiling, physics).
- gamecode `textureGuardHook` (added tracks only; `NT04_NO_TEX_GUARD` turns it off) passes a record in the hardware range (≥ 0xF0000000) to 0x132EA0 as none, which it skips.
- With the guard both packs load without padding (Wilkesboro 341 draws, Milwaukee 561). The draw padding (the earlier "under ~500 draws" theory) is removed. BUILDER is now "track-pack 7".
- Which material it is (sky, car, TK_SCORE from the base slot?) is still open.

## HUD track map for added tracks (trackmap.mjs)
**Where the game finds it**
- TRCK.IDTM picks the track's TMAPDAT entries. 0xDABF0 runs "select TRCK.IDTM from TRCK join GINF on TRID" (the query string at 0x2001E8 is stored backwards). 0xDAC10 loads IDTM + 1, or IDTM + 3 when the setting at 0x136E0 is 3.
- TMAPDAT has entry 0 (an 8×8 texture), then 4 entries per map, 35 maps (IDTM 1, 5, ..., 137; some tracks share one):
  - +0: small map, 128×128, paletted 0x0B, the track in the right half on transparent.
  - +1: its placement, 4 floats: sc, th, ox, oy.
  - +2: large map, 256×256, on black.
  - +3: its placement.

**Placement**
- With A = 30.48 x and B = 30.48 y (physics feet → cm):
  - u = (A cos th − B sin th + ox) · sc
  - v = (A sin th + B cos th + oy) · sc
  - pixel = ((u + 1) / 2 · W, (1 − v) / 2 · H)
- Fitted on the stock maps: each track's racing line lands on the grey of its own map (fit 0.62–1.00; Atlanta 0.96, Bristol / Martinsville / Richmond / Phoenix / Dover 1.00).
- Large map: u −0.5..0.5, v ≈ −0.98..0.98. Small map: the same with ox + 0.5 / sc.
- Colours: track 131 grey with 106 edges, grass / apron 32,139,32, pit road 106,90,205, white start line.

**Build**
- trackmap.mjs draws both maps from the layout: road between the edges, apron inside, pit road from layout.pit, start line. 2×2 samples per pixel. It picks the rotation that stands the track upright (or the best fit if upright is under 90 % of its size).
- They are encoded into copies of the base track's map textures (encodePaint) as build/tmap_small / tmap_large (.bin + .pos), plus build/track-map.png.
- TMAPDAT entries 141 + 4·(TRID − 65) .. +3 come through entryOverrides; ids.idtm → TRCK.IDTM (applyTracks).
- Checked: race loading reads entries 141 / 142 from the Milwaukee pack. On-screen drawing not seen yet: the soft-renderer shots show no HUD.

## Pit road position and starting grid from track.ini
**What decides them**
- TK_PHYS spot table 0 is the starting grid (44 places, two wide). Table 6 is the pace car's start spot.
- Table 1 is the pit stalls (44; Lowe's: 0.993..0.072 of the lap, 150–220 ft inside). Table 7 is a single pit spot.
- Line group 11 is the pit lanes (Lowe's 0.864..0.109 measured on its racing line; 0.904..0.113 on its centre). Groups 3–8 are the ways in and out; 9 / 10 are the per-stall paths.

**Pit road along the lap (trackwarp makeMapper remap)**
- The mapper's lap fraction for the new layout is remapped piecewise linearly through (0, 0) and the two ends of pit road: the base's group-11 lanes (start and end points located on its centre) → layout.pitLane (track.ini pit_lane_start / end_dlong).
- Everything warped (pit road, stalls, stall paths, lanes, in / out lines, sections) lands where the track has its pit road. N lookups use the remapped fraction; B lookups do not.
- Skipped when the two runs are on different sides of the line, or when any piece would be drawn out or squeezed more than 2.5×.
  - Milwaukee: 0.904..0.113 → 0.849..0.108, applied.
  - Wilkesboro: pit road 0.599..0.138 (starts in turn 3), ×4.2, skipped. With it applied: 32 / 43 past 0.9 laps in 120 s; without: 42.
- Stalls are not placed one by one: the base's stall run comes along inside its pit road.

**Starting grid (trackwarp setGrid)**
- nr2003-track layout.grid comes from the first track.ini [starting_grid_N] whose places lie on the racing surface. Milwaukee's grid 0 is on the apron / pit road (17–22 m in), so it uses grid 1; Wilkesboro uses grid 0.
- Values are [x, y, heading] in feet, plus the pace car's.
- Spot table 0 gets these positions (rows go on at the track's spacing past its 43). Height is the new surface plus the spot's own height above it. Orientation is the mapped spot turned to the heading. Section is the one whose triangle is under it. Table 6 gets the pace car's.

**Results (120 s)**
- Milwaukee: 40 / 43 past 0.9 laps, 3.15 laps.
- Wilkesboro (grid, no pit move): 42 / 43, 3.99 laps.
- An in-game pit stop on these tracks is not tested yet.

**Also written: layout.pitStalls** (stall lap fractions; unused so far).

## NR2003 pit road vs walls (pit far side, inside wall along pit road)

- Static check `pitLinesThroughWalls(doc)` (track-pack.mjs, logged at build): warped pit lines (groups 3-11) against wall top edges. Stock Lowe's: none cross.
- Before the fix Milwaukee's three pit lanes (group 11) crossed the NR2003 pit wall (12.2 m) mapped as the inside wall at the pit exit; a car on pit road stopped against it.
- Fix in layoutFromPTF: pit far side = min(stall + 4, wall behind the stalls - 0.6 m); inside wall (WIN) along pit road = the first wall past the stalls.
- After: Milwaukee 1 stall path (group 9, near pit entry) crosses; Wilkesboro none.
- 120 s races: Milwaukee 40/43 cars past 0.9 laps (mean 2.74), Wilkesboro 42/43 (mean 4.28), 0 tick errors.
- Bot pit stop test: not yet conclusive (player car boxed in by traffic at the start). In-game pit stop still unverified.

## NR2003 pit stops verified (Milwaukee, Wilkesboro)

- The previous fix (inside wall along pit road = the wall past the stalls) was wrong: the base's pit road got shifted
  past that wall, so the game's pit road ran 20-50 ft inside the visible one (on the grass) with stalls behind the
  armco. A car entering the visible pit road was only taken over at the start line and drove through without stopping.
  Reverted: along pit road the inside wall is the track's pit wall again (Milwaukee 12.2 m).
- The real cause of the pit-exit wall: two discontinuities in the warp's sideways mapping.
  1. The track's inside wall jumps where the pit wall ends (-40 -> -97 ft at Milwaukee): nr2003-track.mjs now eases
     every jump of 8 ft or more over 300 ft on the far side.
  2. The base's pit road far side (PFAR) followed each stall's loop (min over +-30 ft) and stopped dead where pit road
     ends: trackwarp now takes the min over +-150 ft averaged over 300 ft, and fades the pit-road mapping out over 200
     ft past the end (PFARX / PFW). Warped stall paths and pit lanes were wobbling 10-20 ft; now smooth loops as at Lowe's.
- Static check after: Milwaukee 1 pit lane touches the wall where it rejoins at the exit, Wilkesboro none.
- In game (race-bot-pit-test.mjs: AFTER script; WAIT ms braking for the field to pass, PITLAP / PITFROM or PITBEFORE):
  - Milwaukee: bot moves to pit road (game lane -65) on lap 1; game takes over at the pit entry (race state 5), pit
    menu, drives at 40 mph, stops in its stall (state 6, pit word 5) ~16 s, leaves (pit word 6), back to racing (state 3), laps on.
  - Wilkesboro: a full stop the same way (pit road still at the base's place on the front stretch: the remap is skipped there).
- 120 s races: Milwaukee 41/43 past 0.9 laps (mean 2.80), Wilkesboro 42/43 (4.08), 0 tick errors.
- Bot notes: game lane is not the layout's lateral (Wilkesboro: the bot at lane 0 hits the outside wall; -30 works).
  Both Milwaukee straights read segment 3: race-bot pitFrom[2] (least distance to go) limits the approach to the front one.

## NR2003 pit stalls: stops on the track's stall row

- Base Lowe's: 44 stalls, stop k = end of g9[k] (= g9[k+44]; out paths g10[k], g10[k+44]); k 0 nearest the exit, 43
  past it (the pace / spare stall). The base's inner wall stands ~8 ft behind each stop. Spot table 1 (two rows of 22) is
  not the stops (pit crew / box places).
- trackwarp: along the stalls the base's pit-road far side (PFAR) is now that wall (averaged over +-60 ft), not 15-50 ft
  past it; nr2003-track: the layout's pit far side is the track's wall behind its stalls (within 12 m), else stalls + 2.5 m.
  So the base's wall lands on the track's armco and the stops at the track's stall distance: Milwaukee stops at
  -90 ft (track.ini stalls 27.5 m = 90.2 ft; before -78), Wilkesboro ~-83 (24.2 m = 79 ft). Static check clean on both.
- In game (Milwaukee): stop at -87 ft, pit crew service, back to racing. 120 s races: Milwaukee 42/43, Wilkesboro 41/43.
- Not done: along the lap the stops keep the base's spacing (29 ft, with Lowe's gaps) instead of the track's (31 ft, no
  gaps). Matching them one to one moves the end stalls up to ~95 ft (the start line lies between stalls 17/18 in
  NR2003, 20/21 at Lowe's, and the lap remap is pinned at the line); stall 0 would sit 37 ft from the pit lane end with
  no room for its exit path.

## NR2003: AI lanes on the track's racing line; a solid pit wall

- Front stretch weave (user report, Milwaukee): the warped AI lanes (group 1) kept Lowe's line relative to its track,
  which dives in and out across the dogleg: on Milwaukee's straight the lanes cut in and out by up to 40 ft. trackwarp
  lanesOnRaceline: lane 1 = layout.raceline (raceline.lp), lanes 2 / 3 keep their distance from lane 1 (the base's,
  averaged over +-300 ft), held 4 ft inside the road edges. Milwaukee front stretch now lane 1 +6..+11 ft steady.
  (layout.aiLanesFromRaceline: false keeps the warped lanes.) Group 0 is the frame centre, unchanged.
- Pit wall (user report: not solid): Lowe's has grass between track and pit road, so nothing in the warp stood on
  Milwaukee's pit wall. Stock tracks with a pit wall (TK_PHYS "other" walls: Atlanta etc.) build it as a free-standing
  closed loop 1 ft thick: per segment top / bottom points, vertical plane with the normal left of travel (out of the loop),
  kind 10 (13 / 0x1000x variants at ends), 3.2 ft high; z20 = section << 16 | index of the segment ending at this one's
  start, (c, a) = the one starting at its end (all inner / outer / other chains are closed rings in the stock data).
  nr2003-track: layout.pitWall = runs of [x, y, d] where a wall lies between the racing edge and the stalls along pit
  road (+-30 m). trackwarp addPitWall: builds the loop, listed in each section whose end planes take it in; left out
  within 15 ft of any pit line crossing (openings: the base's entry / exit need not match the track's), within 8 ft
  of a warped wall, and pieces under 100 ft. Milwaukee: one run 1245 ft; Wilkesboro: 610 ft on the front stretch.
- In game: the bot aimed into pit road from the track scraped along the wall at -36..-40 ft for the whole straight;
  entering in turn 4 (behind the wall's start) it made a full stop (stall, service, back to racing).
- 120 s races: Milwaukee 41/43 (mean 2.67), Wilkesboro 41/43 (3.92), 0 tick errors. (First Wilkesboro try with a 4 ft
  cover test left two short wall stubs beside its turn 3-4 inside wall: 39/43, mean 2.20.)
- Note: four test races at once sometimes die silently (memory): run at most three.

## Roster: own number picture, pit sign and pit box colours
- Pit signs (the banner over each pit stall, sponsor + number): TK_PBNR.DAT, entries 2..125 PITBNR 128 x 32 paletted
  MMAP (0 / 1 PITBOX: the crew / pit cart texture sheet, shared). Race load 0xD5750 fills the per-car table 0x2DD200
  (16 bytes, 43 cars) with 0xD5410 / 0xD55C0: +0 CRID, +4 s16 CRSK PBNR ("select CRSK.PBNR ... where CRID and CTXN",
  0x1FFE08; car type 6 (create-a-car) gets -1 - CRID instead), +6..+0xB CRSK IPRD IPGN IPBL ISRD ISGN ISBL (0x1EA960):
  the team's primary / secondary colours (Home Depot 193,80,14 = its orange pit cart and crew). The race then loads
  TK_PBNR entry PBNR + 3 for every car (traced: Home Depot PBNR 16 -> entry 19 "HOME DEPOT 20"). PBNR is a 16-bit field.
- Added drivers: pitSign "copy" | "made" (drawn in the launcher: sign text on the primary colour, the number on the
  secondary) | "custom" (the user's picture, 4 : 1) -> roster/textures/pitsign/<crid>.png; nt04-config BANNER_BASE
  0x200 + slot = TK_PBNR entry, CRSK PBNR = entry - 3; gamecode withRosterBanners encodes the PNG in the start car's
  sign format (paint-mmap encodePaint, resized to 128 x 32). colors { primary, secondary } -> CRSK IPRD.. / ISRD..
- Number picture: numberPic "custom" uses the user's picture (uis_drnm 512 x 256 + a 64 x 32 uis_smnm badge made from
  it) whatever the number; "auto" keeps the old rule (the game's picture for that number, else one drawn in the launcher).
- Checked: launcher (playwright) adds a driver with a made sign and an uploaded number picture; Race Now with that
  roster: TK_PBNR entry 512 loaded, the car's table entry 250: PBNR 509, colours 17,39,84 / 169,14,25 as chosen.
  Not seen on screen yet (the test car never pits beside that stall). NT04_TRACE_ENTRIES=<archive regex> logs entry loads.
- Pit box / crew sheet: TK_PBNR entry 0 PITBOX 256 x 128 P8 is ONE index image with 43 palettes (all grey in the
  file; palette header +0x1C, 12 bytes each, data 0x480 apart; entry 1 the same with one palette). At race load the
  game fills palette k with car slot k's tint from its CRSK primary / secondary colours (dumped from memory: every car
  its own colours; the added test driver, slot 42, navy + red as chosen). Face, ears, suit, gloves and the pit cart are
  all on this sheet, so per car only the two colours differ; a whole custom picture would need a separate texture
  (e.g. the renderer swapping the image when that palette is bound) — not done.

## Roster: high-resolution car paints
- Stock paint (CARDATA / CARRESFE "DECAL"): 512 / 256 / 128 P8, one palette. Header: +0x0E image count, +0x10 palette
  count, +0x14 size - 0x0C, +0x1C palette header (absolute; 12 bytes: 1, 0x400, data offset - 0x80), +0x20 name
  (absolute), images at 0x28 + k * 0x10 (w, h, format, bytes, offset: image 0 0x80 = relative to 0x80, the others absolute).
- paint-mmap encodePaintHD: the same header with the images 1024 / 512 / 256 (or 2048 / 1024 / 512) in DXT5 (0x0F, own
  range-fit encoder, alpha kept; a flattened picture takes the template's alpha), then an unused grey palette and the
  name. paintSize: over 724 px -> 1024, over 1448 -> 2048. gamecode withRosterPaints uses it (NT04_PAINT_MAX caps it).
  Launcher: a paint upload keeps its own size (square, up to 2048) instead of being shrunk to 512.
- In game: #20 (the Race Now player car, CTID 68) given a 1024 paint with fine print, and a 2048 one, via
  entryOverrides: drawn on the car, sharp, shading as before; 20 s of racing fine. A roster driver with a 1252 x 1252
  modder paint: CARDATA entry 0x400 loaded, no error. Sizes: 1024 1.4 MB, 2048 5.5 MB (stock 0.35 MB).

## Roster: 1252 modder template layout; more paint schemes per driver
- The 1252 x 1252 modder sheets (later EA NASCAR layout) hold this game's body parts drawn the same, placed differently:
  the body block (sides, hood / roof / deck, spoiler strip, antenna) is one box scaled ~1.22 (at 1024 output ~1.0),
  front bumper and rear deck + bumper are separate boxes. paint-layout.mjs convertLayout finds each zone's box on both
  sheets from the opaque parts and maps box onto box; the alpha is the make's stock paint's. Measured on the Dodge
  sample: every panel lands on the template's mask (preview), and on #20 in a race (override) the rear, deck and
  numbers sit where they belong. guessLayout: a square 1200-1300 px picture is taken for this layout (the launcher
  preselects it; the user can switch).
- roster-server: PUT paint &layout=ea1252&make=<make> converts on upload (stored already rearranged, at 1024 / 2048).
  The template paint for alpha (and in gamecode withRosterPaints for the MMAP header) is now a stock paint of the
  driver's make (the start car's if it is that make): before, a custom paint on another make took the start car's.
- More schemes: d.schemeName, d.schemes [{ name }] (up to 8), pictures roster/paint/<crid>_<k>.png. rosterPaints lists
  every (driver, scheme) with its file; applyRoster adds a CRSK row per extra scheme like the car's current one, CTXN
  after the last, CTID = its CARDATA / CARRESFE entry (PAINT_BASE + slot), CNAM = the scheme's name. Checked: the rows
  (CTXN 0 "Jasper" 1024, CTXN 1 "Test HD" 1025); race loads 1024. Picking scheme 1 in the game's menus not tried yet.
- Fix (user: the layout choice went back to "This game's" on save, and nothing was rearranged without picking the
  picture again): the layout is now stored (d.paintLayout, schemes[k].layout); the server keeps each paint as given
  (<file>.src.png) and makes the game's paint from it on upload, and again on save when the layout or make changed (a
  paint saved before this becomes its own .src). Checked in the launcher: saved driver keeps "1252 modder" after a
  reload, and the old 512 upload was rearranged.
- Fix (user video: black on the car's right side): the 1252 sheet's disc above the body passed the 2.5 % row
  threshold, the source box began 15 px too high and the right side (the top panel, upside down) came out 6 px off
  at the car's lower edge. Threshold now 8 %; and where a solid part (template alpha > 200) falls just off a panel of
  the other sheet, the nearest painted pixel within 8 px fills in (no black seams). Checked on the mask: no uncovered
  edges left but the windows (the sheet's glass is transparent). (A per-row / per-column dynamic time warp was tried
  first: it smeared the lettering; dropped.)

## Roster: pit crew uniforms (user: the crew still wore Rusty Wallace's suits)
- The crew in the pit stop wears CHARTEX.DAT entry CRSK PTEX (32-bit; #2 Rusty Wallace 3 = blue Miller Lite, #20 17 =
  Home Depot). Traced: only the player car's entry is loaded in a race (17 for Race Now's #20). Entries 0..79 are crew
  sets: one MMAP, 7 paletted swizzled textures each with its own palette, ARM 64x128, PANTS 64x128, TORSO 128x256,
  HELMET 128x64, FACE 64x64, SHADES 16x8, VISOR 16x16; texture offsets are from 0x80 for every texture (separate
  textures, unlike a paint's mips). 80..125: other people (2 textures).
- An added driver copied the start car's PTEX, so its crew wore the start car's suits (the colours only tint the pit
  box sheet). crew-tex.mjs: decodeCrew / crewSheet (ARM, PANTS, TORSO, HELMET, FACE on a 256 sheet, any multiple) /
  encodeCrew (per texture palette by median cut) / madeCrew (plain suits: shading of CHARTEX 0, a light suit,
  blurred so logos fade, primary colour; helmet secondary; dark gloves / shoes kept).
- d.crew "copy" | "made" | "custom" (roster/textures/crew/<crid>.png); nt04-config CREW_BASE 0x100 + slot, CRSK PTEX;
  gamecode withRosterCrews (template: the start car's crew set). Launcher: crew options, template download (the start
  car's crew sheet at 1024), upload. Checked: launcher save; an override of entry 17 with a made set loads in the race.
  Not yet seen during a stop on screen (the bot's pit approach is unreliable at the moment).

## Roster: taking the game's own drivers out
- roster.removed: [car id]. applyRoster (after the added drivers, so a removed car can still be a start car) sets
  their CARS.CTYP to 9: car select lists CTYP 0..4 (ULDR x CARS), the profile car list skips 6 / 8 / 9, and the
  field builder 0x139B0 takes types 1..4 by DPOP, so the car is gone everywhere and the field fills from the next
  cars (only 40 primary + secondary cars exist, so a 43 field already includes fantasy / custom ones).
- Launcher: "The game's drivers" card (per class, find, tick / untick, Save -> POST /api/roster/removed).
  withRoster now also loads a roster that only removes.
- Checked: #20 Tony Stewart (32, Race Now's default car) and #8 Earnhardt Jr (6) taken out: Race Now still starts
  a race, the field is 43 without 6 / 32 (169, 170, 174 come in).

## NR2003 import: scoring pylon digits, day races, road brightness
- **Scoring pylon digits.** TK_SCORE entries (indexed by RACE.RTID) are only the pylon's digit panels (Lowe's 28:
  "NLOTowerDigits.ea3", 126 small vertex buffers, about 1 x 4 x 1 ft of local geometry); the game draws them where the
  base track's pylon stands. Under an NR2003 track's own scenery that pylon is gone, so the digits hung in the sky.
  track-pack (builder "track-pack 8") now writes build/tk_score.bin for added tracks with a ground profile: the base's
  entry with every vertex position at one point (nothing drawn), used instead of "@slot". Layout
  "hideBaseObjects": false keeps them.
- **Day or night.** Stock rows show the pattern: day tracks TRCK.TNIT 0, RACE.RNIT 0, TKSK SKY0/SKY1 -2/-2, TFOG
  colour 110,98,75; night tracks 1, 1, -1/-1, black fog. Added tracks copied Lowe's night rows (dusk sky, black fog).
  applyTracks now takes track.night (true / false): when it differs from the base it sets TNIT / RNIT and copies TKSK and
  TFOG from a stock track of that kind. packState passes night: false for packs with scenery of their own unless
  track.json "track": { "night": true }.
  - In game (trtrace6, TRACK_DOWNS=16): Milwaukee and Wilkesboro now load TK_SKY 130 / 260 (day) instead of 283 / 285
    (Lowe's night) and TK_SCORE 76 instead of 77; the dusk sky is gone.
  - Test harness note: trtrace2's menu path (UP x8) picks stock Lowe's; trtrace6 with TRACK_DOWNS=16 picks the added track.
- **Road brightness.** Milwaukee's racing-surface texture Asphalt.mip averages 224 / 255 (nearly white; NR2003 draws
  it darker), so the road looked washed out. nr2003-scene: asphalt textures on surface types 1 / 2 brighter than 180
  are scaled to a mean of 135 (option roadTone; `convert ... --road-tone <n|off>`). Wilkesboro's (162) is left alone.

## NR2003 tracks through glTF; physics and racing lines from glTF; object library
The launcher no longer imports an NR2003 track straight into a pack. The track becomes three .glb files to edit in
Blender; a pack is then made from them (or from anyone's own glTF files with the same names).
- **nr2003-gltf.mjs** (`node nr2003-gltf.mjs <track folder> <out> [--objects <dir>] [--road-tone n|off]`):
  - `<id>_scenery.glb`: the .ptf surfaces and walls, the track's .3do objects, plus `pit_stall_boxes` (white boxes 8.5 x
    4.4 m at track.ini's stalls; NR2003 paints these itself).
  - `<id>_physics.glb`: `centerline` (LINE_LOOP at road height), `start` (empty), `road` (strip between the racing edges,
    heights from the .ptf cross-section: nr2003-track `sectionAt`), `walls` (every W section as vertical quads),
    `pit_wall` (the layout's pit-wall runs), `pit_area` (pit near..far), `ground` (the cross-section grid).
  - `<id>_lines.glb`: `raceline` (LINE_LOOP; relative AI speed as the `_AISPEED` attribute and node extras.aiSpeed),
    `pit_lane` (strip entry -> exit), `pit_stall_NN` / `grid_NN` / `grid_pace` empties (yaw = heading), scene
    extras.track { recordLap, pitSpeed, paceSpeed }.
  - gltf-write.mjs: a small GLB writer (embedded PNGs, lines, empties, extras, custom attributes).
- **gltf-layout.mjs** `layoutFromGLTF({ physics, lines }, options)`: trackwarp's centrelineFromGLTF, then:
  - road edges bisected to 0.01 ft;
  - z and banking from the plane through the road's two edge heights (as NR2003 / layoutFromPTF);
  - walls: the nearest wall face beyond each edge that runs along the track (within 45 degrees), then
    nr2003-track `easeWallJumps` (now shared);
  - pit near / far bisected;
  - ground grid 4 ft, out to where the ground mesh ends (max 360 ft), each sample the height nearest the last
    (the infield's far side lies under the same line);
  - pit wall runs, racing line offsets and speeds (ray from each point), pit lane ends and stalls as lap fractions
    (a backwards line is turned round), grid places, speeds from extras.
  - Polylines are walked from edges, so Blender's LINES output in any order works.
- Round trip (NR2003 -> glTF -> layout vs layoutFromPTF directly): points exact; z and banking exact; edges within
  0.01 ft; walls within 0.1 ft except where the inside wall jumps (one index of easing; Wilkesboro: up to 11 ft over
  a few points where a ray now meets a different wall); raceline and AI speeds exact; stalls / pit lane within 0.001
  of a lap; grid exact (heading mod 2 pi).
- track-pack: track.json "physics" / "lines" (instead of "layout"); in packKey; BUILDER stays "track-pack 8".
- 120 s races, 43 cars (same session, deterministic per build):

| Pack | Cars past 0.9 laps | Mean laps |
|---|---|---|
| Milwaukee, from glTF | 42 / 43 | 2.79 |
| Wilkesboro, from glTF | 40 / 43 | 2.58 |
| Wilkesboro, direct import (old path) | 41 / 43 | 2.56 |

  (First glTF try: Wilkesboro 38 / 43, from banking off by 0.3 degrees, the road's heights taken from the 4 ft
  ground grid, and pit-wall ends missed by a ray at a quad's edge.)
- tmdl.mjs DInf fix: per draw a 36-byte record (name in 32 bytes, u32 0xFFFFFFFF). The old reader took every padding
  byte as an empty name, so draw k got the wrong name (draw 7 "display_tower" was really the horizon strip).
- **objects-export.mjs**:
  - game: one .glb per named object of a track model (TK_REND). Names like `<obj>Shape<n>`, with `_<material>` parts
    and `_1`, `_2` copies; the first copy is kept with all its parts. Generic and track-surface pieces are left out.
    Each object stands on the origin, in metres, with its colour texture and vertex colours. Lowe's gives 415
    objects, among them PitCart_Source x43, PIT_TIRES x92, PitTower_*, PitExtras_*, PitBanner_S0/1/2, Pit_Boxes_0*,
    caution lights and Mirror_lights x93.
  - nr2003: every .3do in folders, loose or in .dat archives, with its .mip textures (Wilkesboro folder: 69).
  - Not done: a placed PITBANNER material does not become a swappable per-car pit sign. The game swaps draws with
    flag +0x11 bit 0x20, and tmdl-build doesn't set it.
- Launcher Tracks tab (tracks-server / tracks-ui):
  - "NR2003 track to glTF" (POST /api/tracks/nr2003-gltf; output folder roster/converted/<name> or one given), with
    a list of converted tracks and "Make a track pack" (POST /api/tracks/new from "converted").
  - New track pack: Scenery / Physics / Racing lines file pickers and "Create from these files".
  - Pack editor: Physics and Racing lines selects, each with its own upload.
  - Object library card (POST /api/tracks/objects -> roster/objects).
  - The last build log stays shown after the editor redraws.
  - Checked with Playwright: convert Milwaukee, make a pack, build (14.8 s), create a pack from three uploaded
    Wilkesboro files, export Lowe's and NR2003 objects.

## Generating physics from the track's own files (no stock track), step 1: the collision layer
- trackwarp `generateCollision` (used when the layout comes from glTF: gltf-layout attaches `layout.geom` with the
  surface type / road height fields and the wall faces): the driving surface, apron, pit road, stalls, grass and the
  walls are built from the physics file instead of bending the base's.
  - Rows square to the centre line at every layout point, 14 points across: inner limit, ground x2, pit far side,
    stall line, pit near side, ground, road edge, road x3, road edge, ground, outer limit. Zones of no width are left
    out. The inner limit is short of half-way across the infield and of 0.8 x the turn radius (rows from both sides
    of a turn would otherwise cross).
  - Heights: the road from the road mesh, the rest from the ground grid.
  - Triangle type from the file at its centre: stalls 3, pit road 1, road 0, grass 7, other ground 6. Types 0 / 6 go
    in "surface", 1 / 3 / 7 in "apron", as in Lowe's: S0 1825, S6 1489, A7 603, A1 405, A3 77.
  - Sections: the base's count (76) and order. Each is a run of rows, with boundary planes through a row line,
    square to the centre line, so every row lies in exactly one section. Spots get the section of their nearest row.
  - Walls: per row, the nearest wall face beyond each road edge that runs along the track (pit walls excluded),
    with the top height of the wall there. A panel is made between rows where both have a wall less than 6 ft apart.
    Outer panels (kind 8) run with the lap and inner panels (kind 12) against it, so the track is on each panel's
    left with the normal facing it, as in the stock files. Panels are chained prev / next (0xFFFF at chain ends).
    The pit wall comes from addPitWall as before.
  - nr2003-gltf now writes `pit_stalls` (the stall-box strip) and splits `ground` into materials "apron" / "grass"
    from the .ptf's surfaces (nr2003-track sectionAt().surfaceAt).
- Results, 120 s races, 43 cars:

| Track | Collision | Cars past 0.9 laps | Mean laps |
|---|---|---|---|
| Milwaukee | generated (7,532 points; 4,304 road, 3,724 apron, 276 pit, 276 stall, 3,812 grass triangles; 538 outer / 536 inner wall panels) | 42 / 43 | 2.71 |
| Milwaukee | bent from the base | 42 / 43 | 2.79 |
| Wilkesboro | generated | 29 / 43 | 1.77 |
| Wilkesboro | bent from the base | 40 / 43 | — |

  - Wilkesboro fails because its pit road can't be moved onto the track's (it is left at Lowe's place), so the base's
    bent pit and AI lines cross the track's real walls.
  - So the generated collision is used only when the pit lines could be moved (warpTrack `pitMoved`). Otherwise the
    collision is bent as before, with a note in the build log. NT04_WARP_COLLISION=1 forces the bent one.
  - Milwaukee's static check now reports 5 stall paths and 1 pit lane through a wall (the armco behind the stalls,
    now at its real place). A pit stop there is untested.
- Step 2 (lines) started. Per-segment 64-byte data: FUN_D7C20(group, seg; line in EAX) returns line record +0x8C +
  seg * 0x40. It is used by car tracking 0x1D460 with the projection helpers 0xE9F10 / 0xE9C50 / 0xE9A50, which
  evaluate a quadratic curve from 9 floats through ESI / EDX.
  - Zeroing the whole block in the Milwaukee pack changed the race (deterministic runs differ from the first
    sample; 41 / 43 instead of 42 / 43), so the game reads it.
  - Its layout (4 rows x [a, b, c, 0]; columns look like x / y / z terms: the z column is 0 on flat lines) is not
    worked out yet.

## Generating physics, step 2 (lines): what the per-line data does
- **Per-segment 64-byte block: not used in a race.** Zeroing all of it in the Milwaukee pack left a 120 s, 43-car race
  identical to the end (every car's position at every 5 s sample).
  - An earlier test that seemed to show a change was invalid: copying the pack changed file times, so the pack was
    skipped and stock Lowe's ran. Copy packs with `cp -a`.
  - In 0x1D460 the pointer from FUN_D7C20 is pushed as the second argument of 0xE9F10, which never reads it; the
    curve comes through ECX from FUN_D7BF0 (the line's points).
  - Generated lines can write zeros there.
- **Profiles (7 arrays) are used:** zeroing them changes the race from the first second. Read off Lowe's (at the
  racing line, the pit lanes, a stall path, a pit entry and a lane line):
  - p0 is the line's own sideways place in the racing line's (group 0) frame: pit lane -135.6, stall path -162.3,
    pit entry -34.6, lanes -5..-17.
  - The others are distances from the line to features at that lap position, signed by side:
    - p1 = -|e1 - p0|, the racing surface's inner edge (Lowe's about -21 from the racing line)
    - p2 = +|e2 - p0|, its outer edge, no farther than the outer wall
    - p3 = -|e3 - p0|, the paved edge (about -36)
    - p4 = p2 at the segment's start (held for the 7 samples)
    - p5 = -|e5 - p0|, the inner limit: the inner wall, or the start of the stall boxes where those come first
      (Lowe's -193 at the line)
    - p6 = +|e6 - p0|, the outer wall
  - Checked: lane line p1 -15.8 = -(20.7 - 4.9); p2 26.2 = 21.3 + 4.9; pit lane p1 -112.9 = -(135.6 - 22.7);
    p2 154.5 = 135.6 + 18.9 (outer wall 19.2).
  - Bent from the base, these were the base's own distances. trackwarp `profilesFromTrack` now works them out from
    the generated collision (per-row features from generateCollision; samples at t = k / 7).
    NT04_KEEP_PROFILES=1 keeps the old ones.
- **Trial: pit lines moved on their own** (NT04_SPLIT_PIT=1, for pit road too far from the base's). Only pit lines
  (groups 3-11) and spots near the base's stall stops take the stretched lap remap; the rest is carried along as is.
  - Wilkesboro: 19 / 43 at first. Formation spots beside Lowe's pit road had been moved onto the pit road; with the
    stall-stop test instead, 25 / 43.
  - Many AI cars go into Wilkesboro's pit road, which here runs from turn 3 along the inside of turns 3-4, and stay
    in the stalls.
  - Off by default. Wilkesboro keeps the bent collision; the pit lines need to be built from the track's own pit lane
    and stalls instead.
- Pit walls in the walls mesh: generateCollision no longer builds the inner wall from faces that lie on a pit_wall
  (within 2 ft). An NR2003 conversion writes every wall into `walls`, so the inner chain had shut the pit exit; the
  pit wall comes from addPitWall, with openings. The static check is clean at both tracks.
- **One run is not a measurement.** Wilkesboro (bent collision), with the same layout values except ground heights
  up to 0.49 ft different (the ground mesh's quads split along the other diagonal), gave 32 / 43 against 40 / 43.
  The work-folder harness trtrace6 now takes SEED= (the game's random seed). Comparisons should use several seeds.
- Milwaukee, three seeds (11 / 12 / 13), 120 s, 43 cars, cars past 0.9 laps:

| Collision | Seed 11 | Seed 12 | Seed 13 | Average | Mean laps |
|---|---|---|---|---|---|
| Generated, with track-made profiles | 41 | 37 | 40 | 39.3 | 2.62 |
| Bent from Lowe's | 42 | 40 | 39 | 40.3 | 2.70 |

  - Close, a little behind. Generated stays the default where the pit lines land on the pit road.

## Generating physics, step 3: lines and collision from the track's own files at Wilkesboro

- Own mode (the default for a glTF layout): collision, track lines, pit lines, profiles and pit spots all come from
  the user's files. Still from Lowe's: the section count (76), cameras and formations (bent), node values, the
  AI_SPDS structure and the database rows.
- Lanes (group 1): lane 0 on the racing-lines file's raceline; the other two at the stock lanes' distance from it
  (smoothed over 300 ft either way). Lowe's own lanes 0 and 1 run together through its turns, so overlapping lanes
  are normal. Groups 0 and 2 sit where the stock ones sit across the racing surface.
- Pit crew and box spots (a = 1 in tables 1 and 7) move with the nearest stock stop onto the track's stalls.
- Inner limit of the ground: at least 90 ft, and past pit road's far side wherever pit road is within 400 ft along
  the lap (the pit lanes ease off and on beyond the pit area's ends).
- **Triangle winding.** Every stock collision triangle is counter-clockwise seen from above (Lowe's: 4401 of 4401).
  The generated ones were all clockwise (the rows run the other way round). The game did not find them under a car
  everywhere: at Wilkesboro the leaders bounced back 40-75 ft in turn 1, at a section boundary, and the stuck field
  was reset into the pit stalls about 50 s later (the "cars parked in stalls"). generateCollision now flips any
  clockwise triangle. Milwaukee had raced on the clockwise ground (40 / 43), Wilkesboro had not (21 / 43).
  - Found by swapping: own lines on the bent collision 28 / 43 in 45 s, bent lines on the own collision 6 / 43.
- **Section overlap.** Stock sections overlap a lot (Lowe's: a quarter of the triangles and half the wall panels lie
  past their own section's planes). Each generated section now also holds the rows up to 60 ft past either end
  (`NT04_SECTION_OVERLAP`, 0 = none); a copied wall panel's links still name the first copy. This alone did not fix
  Wilkesboro (the winding did); kept to match the stock layout.
- The height of the car position the harness logs (+0x4c) seems to follow the lines' heights (bent build: 6-8 ft above the ground), so it is no ground check.
- Results, 120 s, 43 cars, cars past 0.9 laps (own mode, counter-clockwise triangles, 60 ft overlap):

| Track | Seed 11 | Seed 12 | Before the winding fix (11 / 12) | Bent from Lowe's |
|---|---|---|---|---|
| Milwaukee | 40 (2.66 laps) | 40 (2.46) | 40 / 34 | 42 / 40 |
| Wilkesboro | 40 (2.58) | 42 (3.69) | 21 / 25 | 40 / 32 |

## Generating physics, step 4: the track's own sections and formations

- Stock section counts are free (TK_PHYS entries 0-39): 33 to 106 sections, 44 to 141 ft long (Martinsville 62 x 44
  ft, Lowe's 76 x 103 ft, most about 110 ft). No other part of TK_PHYS scales with the count (t20, r78, r68, k12,
  quads, tail); the lines have no section field, the spots one each (set from the nearest row).
- Own mode now cuts the lap into sections of about 110 ft from row 0 (`NT04_SECTION_FT`, 33..106 of them;
  `NT04_BASE_SECTIONS=1` = the base's count and bent boundaries as before). Milwaukee 48, Wilkesboro 33.
  120 s, cars past 0.9 laps (seed 11 / 12): Milwaukee 42 (2.81 laps) / 39 (2.45), Wilkesboro 41 (3.82) / 42 (3.95).
- Spot tables (Lowe's), by where they lie along its middle line (group 0), d across it:
  0 grid (44, two wide, 0.999 back to 0.882); 1 pit crews (44, a = 1); 2 two wide 0.924-0.811 (44); 3 two wide then
  single file 0.919-0.727 (129); 4 single file 0.729-0.562 (43); 5 single file 0.396-0.172 (43); 6 the grid's pace
  car; 7 one more crew spot (a = 1); 8-11 a pace car ahead of each of 2-5 (0.931, 0.926, 0.732, 0.399).
  Every stock spot sits exactly on the ground.
- Formations (2-5, 8-11) are now put on the track's own middle line: the first spot of each table at the same lap
  fraction, the rest the same feet behind it and across (a line-up longer than 90 % of the lap pressed to fit),
  heading with the line, height on the road (`NT04_BENT_FORMATIONS=1` = bent as before). Bent, they had shrunk with
  the lap: Wilkesboro's single file stood 12 ft apart (cars overlapping); now 30 ft as at Lowe's.
- With the formations, 120 s (seed 11 / 12): Milwaukee 42 (2.76 laps) / 40 (2.60), Wilkesboro 42 (4.28) / 42 (3.93).
- Still from Lowe's: cameras (r78) and positioned objects (r68) bent along the lap, the line node values, the
  AI_SPDS structure, the database rows.

## Generating physics, step 5: the pit lines as one network

- Stock pit lines join end to end (Lowe's, to the foot): entry k of group 3 ends where pit lane k (group 11) starts,
  4 at lane 0's start, 5 at lane 1's; exit k of group 6 starts where lane k ends, 7 at lane 0's end, 8 at lane 1's.
  The lanes run on past the stalls into the entry and exit funnels (Lowe's lanes start 136 / 127 / 117 ft in and end
  61 / 52 / 42 ft in), so the stall paths start and end on them (within 2-12 ft; lane spacing 10 ft).
- The generated ones did not: entries ran 300 ft into pit road and ended up to 14 ft off the lanes, onto them in
  the reverse order; exits started 300 ft before the lanes' ends; the end stalls' paths started or finished off the
  lanes (the NR2003 stalls fill pit road: Milwaukee's first 19 ft from pit road's start, the last 41 ft from its end).
- linegen now runs the lanes 150 ft past pit road's ends, clear of the track's inner wall there (6 / 11 / 16 ft for
  lanes 0 / 1 / 2, the wall found along each row's normal), joins the entries (ease over their last 300 ft) and exits
  (ease over 250 ft) to them end to end, and keeps every stall path on them. Pit road check clean on both tracks.
- 120 s (seed 11 / 12): Milwaukee 42 (2.86 laps) / 42 (2.48), Wilkesboro 42 (4.17) / 41 (4.00).
- In-game pit stop with the bot (race-bot-pit-test.mjs) not reached on the own-mode Milwaukee: the bot's lane is
  the game's own sideways coordinate (car state +0x14) against its own segments (+0x3C, 5 at Milwaukee, order
  3 1 4 0 per lap), not the layout's d; driving onto pit road at its lane -55 the game neither took the car over
  nor counted the lap. Before the network fix one try was taken over (state 5) for 0.5 s and let go. Where the game's
  segments and lane come from (the bent Lowe's data?) is the next thing to find.

## Generating physics, step 6: the track lines' node lists follow the track's turns

- The game's car state segment (+0x3C) and distance left (+0x40) are group 0's node list 6: the corner kinds
  0 (turn in), 3 (middle), 1 (way out), 4 (straight); Lowe's 0@0.152 3@0.242 1@0.374 4@0.471 0@0.556 3@0.635 1@0.732
  4@0.793; the bot saw segments 3 1 4 0 in that order at Milwaukee. Lists 2 / 4 (zones), 5 (corner kinds), 8 / 9 (TV
  camera numbers) sit on the same line.
- Generated lines had kept them at the stock lap fraction, so at Milwaukee turn 3's "turn in" came at 0.62 where
  the turn starts at 0.58. linegen now finds the turns (heading change over +-150 ft above a third of the largest;
  bends under a third of the largest turn's whole heading change dropped, e.g. Lowe's front-stretch dogleg) and maps
  the lap fraction piecewise between the turns' starts, middles and ends (kept as before when the counts differ).
  The AI_SPDS nodes (nodeMap) use the same mapping.
  - Lowe's turns 0.16-0.28-0.40, 0.63-0.74-0.85; Milwaukee 0.08-0.22-0.36, 0.58-0.72-0.86 (list 6 now 0@0.076 3@0.147
    1@0.257 4@0.369 0@0.567 3@0.651 1@0.777 4@0.856); Wilkesboro 0.08-0.25-0.41, 0.58-0.75-0.91.
- 120 s (seed 11 / 12): Milwaukee 42 (2.83 laps) / 38 (2.52), Wilkesboro 40 (4.07) / 39 (3.92): within the
  seed-to-seed spread seen before (Milwaukee 34-42).

## Pit stops on a generated track: the game's rule, and a full stop at Milwaukee

- Pit flag (race table [0x2F32D8] +9, read 0xBAE70, set 0xBAE80): written every frame by 0xB9840 (from 0xB9700) as
  "the car's surface type is 3" (car +0x10 -> +0x38). The human-racing state handler (table 0x1DFFAC -> 0x2B100)
  puts a car with the flag into pit-in, state 5 (0x2B4A0 sets the pit options, then 0x2C7D0(car, 5)).
- In 0x2A440 a car in pit-in whose flag is off and that has not latched (+0x38 = 0) is handed back (state 3 for
  the player, 2 for AI) once it is more than 5.1 ft (0x1D4E0C) from the start of its current line (car +0x40 =
  { group, index }; 0xD7880 = line record +0x88, its first point; 0x11F130 = distance).
- Stock surface types: **3 is the whole of pit road** (Lowe's: from 155 ft before the pit lanes start to their end,
  136-250 ft in, lanes and stalls alike); 1 is the paved infield around the track (all the way round, 40-190 ft in).
  The generated collision had pit_area as 1 and only the stall strip as 3: the bot's car was taken over when it
  touched the stall strip and handed back 0.5 s later when it drifted onto the lanes (type 1).
- generateCollision now writes the whole of pit road as 3 (`NT04_PIT_TYPE1=1` = as before); the pit lanes sit
  deeper (0.85 / 0.6 / 0.35 of the way from pit road's near side to the stall fronts) so lane 2 is well inside.
- Bot pit test, own-mode Milwaukee (race-bot-pit-test.mjs, PITFROM=0,450,0 PITLANE=-76): pit-in at the entry
  (state 5, F9919), down pit road at 59 mph, stopped in stall 2 (line 9/2; state 6, pitword 5: service) for 18 s,
  out along its out-path (10/2) onto lane 0 and back to racing (state 3) at the lane's end, lap 2 at 98 mph.
  The whole stop runs on the generated lines and collision.
- 120 s with pit road as 3 (seed 11 / 12): Milwaukee 42 (2.83 laps) / 40 (2.54), Wilkesboro 40 (3.64) / 40 (3.86).
- The same bot test at Wilkesboro never reached pit road: the bot (lane keeping in the game's segment frame) runs
  into turn 1's outside wall at 45-50 mph whatever its target speed; a harness limit, not tried further.

## More NR2003 tracks: Iowa, Walt Disney World, Montreal (glTF -> own-mode packs)

- Converter (nr2003-track.mjs): a segment's start / end are heading-checked (|h| <= 2 pi): Iowa's .ptf has a value
  one double before the first segment's that passed the old check (|h| < 20) and every later segment failed. A
  track with no .dat archive (Montreal_2007: loose .3do / .mip files) now reads its objects from its own folder
  (169 objects placed, 0 before).
- Iowa: pit road curves away from the centre line (stalls 95-230 ft in) and a plain wall (in the physics file as a
  wall, not a pit wall) stands between the track and the stalls. linegen took one mean stall depth for the whole of
  pit road (lanes on the track's side of the wall, stall paths through it). Now: the stall front at each point is the
  stalls' own depth there (interpolated), and where a wall stands between the track and the stalls pit road's near
  side is taken 4 ft behind it. generateCollision: pit road's near side moved behind such a wall, ground past pit
  road's far side, and the ground on the track's side of the wall is no pit road (6, not 3: a car on the apron would
  have been put into pit-in).
- Walt Disney World: 32 stalls, the game's tables 44: places past the track's own stalls go one stall spacing on
  while that stays on pit road, then halfway between two of the track's stalls (they went off pit road's end into a
  wall). Its tri-oval bend counted as a third turn: with more turns than the stock track, the largest are used.
- Montreal: pit road is on the right of the track; the layout reader, the collision rows and linegen all look for
  it on the left, so the pack keeps the base's bent pit lines (through walls). Not supported yet.
- 120 s, cars past 0.9 laps (seed 11 / 12; Iowa before the pit road changes): Iowa 42 (3.55 laps) / 40 (3.34),
  Walt Disney World 42 (2.79) / 41 (2.67).
- Bot pit stop at Iowa (SPEED=70 PITFROM=3,260,0 PITAFTER=25 PITLANE=-80): pit-in at the entry, pit road at 66 mph,
  stall 2 for 17 s, out onto lane 0, back to racing at the lane's end.
- Montreal (road course, base still Lowe's): 120 s, 6 / 2 of 43 past 0.9 laps (a lap is 2.76 mi; mean 0.47 / 0.19
  laps); cars 0 and 1 never moved, others stopped 60-130 ft left of the centre line. Road courses need their own
  work (pit road on the right, the base's oval tables).

## Road courses: driving direction and pit road's side (Montreal)

- Stock TK_PHYS: the ovals run counter-clockwise with pit road on the left; the road courses (entries 38/39, 44-47,
  50/51, 60-63: Sears Point, Watkins Glen, the fictional road courses) clockwise with pit road on the right (the
  infield side). Profiles are left / right of each line (Watkins Glen: p1 / p3 / p5 on the left = its outside, p5 the
  outer wall at -27 ft); wall kind 12 (inner) is the infield side (Watkins Glen: on the right, 84-92 ft).
- centrelineFromGLTF no longer turns every centre line counter-clockwise: the loop's own order is the driving
  direction (nr2003-gltf writes it so; Montreal_2007 is clockwise; NT04_CCW=1 = as before). It was racing Montreal
  backwards.
- Sideways is now measured so that negative is pit road's side: the right normal, or the left one when the model's
  pit meshes lie on the right of the lap (layout.flipped). Montreal's pit road is on the outside of its clockwise lap,
  i.e. the left: not flipped. (Everything that looks for pit road, the infield ground, inner walls on the negative
  side keeps working; the walls' kinds follow pit road's side rather than the infield.)
- Flipped layouts: profiles written left / right (mirrored), wall panels run the other way round (the track on each
  panel's left) and their links follow; stock lines' profiles read through the base's own pit side (baseFlipped:
  its pit lane right of its middle line); formations and crew spots mirrored when the base's pit side and the
  track's differ.
- Crew spots: tables 1 and 7 at every stock track (Watkins Glen's have +0x34 = 0, so the a = 1 test found none).
- Home track: same kind as the base (both clockwise or both not): Montreal on the Watkins Glen base gets Watkins
  Glen's setups and AI tables (Talladega's before, for its top speed).
- Montreal track.json: base { slot 56, trid 14, raid 12, tpid 46 } (Watkins Glen; RACE "Sirius At The Glen").
- Still: Montreal's pit entry runs past a wall that separates the pit entry road from the track (the NR2003
  pit_lane line covers pit road only, not its entry): pit road check 6 lines.
- Montreal, clockwise on the Watkins Glen base, 120 s (a lap is 2.76 mi): 18 / 18 of 43 past 0.9 laps (6 / 2 before),
  mean 0.61 / 0.55 laps. Of the 14 cars stopped at the end (seed 11), 10 are on pit road (the pit lines through the
  entry wall) and 3 together in the hairpin (lane 0 there 5 ft off the right edge); car 0 (the player's) never moves.

## Live race leaderboard and points standings (race-hud.mjs, play-client.js)
- Read from the running game, nothing hooked: race table [0x2F32D8] (0x68 per slot): +0x00 state, +0x30 speed (ft/s),
  +0x5C low 16 laps started, **+0x5E (u16) running position, 0 = leader** (the game's own order, by distance).
- Who is in a slot: the field list at 0x2DD200 (CRIDs, 16 bytes apart) in order, with the players' cars (CARS PLID 0,
  1, ...) taken out and put first, so slot 0 = player 1 (Race Now at Milwaukee: slot 0 = CRID 32 #20 T. Stewart, then
  CRID 0 #43, CRID 1 #19 ...). Checked against the car record's +0x36 (u16 car number; "01" / "02" are 201 / 202):
  41 of 43 agree (one slot shows 22 where the field car is #26, one 210 for "0"). QUAL is not the slot order.
- Race length: SGPP.SRLN (row PRID = profile [0x21DB74]) is the percentage itself (3, 5, 10, 25, 50, 100; 0x8C240
  switches on SRLN - 3): laps = round(RACE.RLAP x SRLN / 100) — Milwaukee 200 at the default 3 % = 6 laps (the RACE
  fields NCL3 / NC10 / ... hold 0 / 3, not lap counts).
- State 7 = past the checkered flag; after the race the cars go to pit road (5 / 6 again).
- Race points: PNTS by place (PLAC 0 = 175), + 5 for leading a lap, + 5 for the most laps led — the game's own rule
  (a simulated Daytona: DRRS CPNT 165 + BONU 10 for 3rd with the most laps led; DRST CPNT = their sum). RACE.ISPT 0
  = no points (The All-Star 60, All-Star Open 61, The Shootout 62, SpeedZone 64-78).
- Season standings: GINF.GMOD is 0 in Race Now, 1 in a Season (2 assumed Career); after each race the game adds the
  43 drivers' DRST rows for GINF.YEAR (CPNT season points, CRNK rank, NWIN wins). race-hud.mjs: the year's DRST CPNT
  + the race's live points for every driver with a row or in the race, ties on wins; ▲ / ▼ = places against the
  standings before the race; drivers not in the race keep their points (DNS). Shown as a third tab, "<year>
  Season", only in a Season / Career.
- Checked: a new Season (Race Modes > Season > New > Continue > driver) gives GMOD 1, NRAC 15; Simulate wrote 43 DRST
  2003 rows (winner 180). The season race itself did not load in the headless harness (after Race Weekend > Race the
  UI went empty and the race table stayed at the simulated race's values), so the season tab was checked in a Race
  Now race with the 2002 DRST rows copied to 2003 at a tenth of their points: 44 drivers, Busch 464 -> 649 (▲2),
  Stewart parked 1st -> 17th (▼16), ~23 KB per message.
- Laps led: the car at +0x5E = 0 when the leader starts a new lap led the one before. Gaps: the time between the
  leader's and the car's start of the same lap (game time = frames x frame length in main.mjs); a car the leader
  started more laps before it, or more than a leader lap time behind, or stopped (its lap so far counted at the
  leader's lap time) is shown laps down.
- Checked headless (Milwaukee, seed 11, 6 laps): names / numbers right for all 43, Busch led all 6 (+10), the parked
  player 43rd and counted -1 .. -5 laps as the leader came round, gaps 0.6 .. 18 s; sample() 0.12 ms, ~14 KB per
  message twice a second.
- Page: panel at the top right of the picture (clear of the game's pos / lap plate, tach and lap times): top 10, then
  the player and two either side; F4 shows / hides, F6 or the tabs go running order -> race points -> season (kept
  in the browser).

## "Unable to load Career from hard disk" with a roster driver added (fixed)
- Loading a save: 0xE5C40 allocates the buffer and 0xE5D70 reads name (0x21) + signature (20) + DB image, with the
  image size from 0x5E950 — which writes the save type's tables as they are NOW to a counting sink (0x1477D0), not
  the file's size. On the console the tables never change size, so the two always agree.
- The roster (applyRoster) adds rows to CARS / DRVR / CRSK / TEAM (and grows their capacity); a career / season save
  holds those tables (career: APRP AWTD AWAR AWKY CARS CRSK DRVR DRRS DRST CAIS CGPL GINF RSTT SCCA SPAL SCMD SODR SPON
  TEAM BODY CARE CCOS CCRW CNWS CTIP CTRP CHAS CONT CFHR ENGN OFFR SPHT SSTA). The user's Career 1 (made before the
  roster) is a 223,172-byte image; with Brendan Gaughn added the tables make 223,708, so fread asked for 536 bytes
  past the end of the file, the job came back -100 and the load failed. (Same for any save made with a different
  roster or removed-cars list, either way round. NT04_TRACE_SAVESIZE=1 logs the size checks and reads.)
- gamecode.mjs hook 0xE5D70: reads the file whole (up to 256 KB past the expected size) into a new buffer, takes the
  image size from the file when its DB header agrees ([0x2DE758] = bytes read - 0x21 - signature), then finishes the
  read job as the worker would (0x22E838 status 0, 0x22E83C bytes, 0x22E840 = 1). The signature check (0xE63F0) and
  the load (0x147780) then see the save exactly as written. NT04_STRICT_SAVE_SIZE=1 keeps the game's read.
- After a saved game's image is loaded (0x147780, not nascar.db) with CARS / DRVR in it, nt04-config reapplyRoster
  puts back the roster drivers the save does not have (their leftover DSKL / AIRP / CHAC / SCAR / CRSK rows are taken
  out first, so nothing doubles), leaves the ones it has as saved, and marks removed cars again.
- Checked with the user's own Career 1, roster.json and track packs: "Load successful", the career hub (9/0) opens,
  Gaughn (DRID 250, car 250, team 200) is in DRVR / CARS / CRSK / TEAM once and DSKL / AIRP four times as before.

## Cautions: no caution laps at the 3 % / 5 % race lengths (stock data; now 1 / 2)
- A caution, live race (Race process group 2 stages): 0x1D Race -> 0x21 QC Cooldown (cars state 11) -> 0x22 Pace Car
  -> 0x23 Wreck Replay (3/15) -> 0x24 Pitting (state 10, pit menu 10/2) -> 0x25 PostPit Pacing -> 0x27 Restart ->
  0x1D (0x28 QC Finish when the race runs out under it). The switch is 0xAD960; 0xAD6B0 decides that a caution comes
  out. Forcing one in the harness: RequestStage 0x175030(ecx 0x2F3990, 2, 0x21) after clearing 0x2BA9BC / 0x2F3284.
- Caution laps: at race start 0xAD8E0 stores 0xAE310() in [0x2BA7C8] = RACE.NCL3 / NCL5 / NC10 / NC25 / NC50 / N100
  of the race by the length setting (SRLN 3 / 5 / 10 / 25 / 50 / 100). At the caution 0xADE0C copies it to the
  caution's lap count ([0x2F32E0] -> 0x2BB8B8: u16 laps to run, u16 laps run, 0xBB220 = to run - run) and the QC
  stages count them on every car (0xABB27 -> 0xBAF90 set laps). Stock RACE rows have 3 for 10 % and up but 0 for 3 %
  and 5 %, so at the default 3 % a caution counted no laps: the field restarted on the lap it came out (user report).
  Checked: NCL3 0 -> Milwaukee lap 2 stays 2 through the caution; NCL3 3 -> 2 -> 5; NCL3 1 -> 2 -> 4 (the pace line
  also crosses the line once at 40 mph, counted as a normal lap).
- nt04-config applyConfig "caution laps" (always on, also without a configuration file now: uis-run / gamecode call
  applyConfig with {}): NCL3 1 and NCL5 2 where they are 0; "cautionLaps": { "3": n, ... } sets a length for every
  race ({ "3": 0, "5": 0 } = stock).
- Line crossings (0xB54B0 per car): 0xB4790 -1 = crossed backwards -> per-car flag 0x2BB197 (+0x1C each) set, the
  next forward crossing is not counted unless the race phase (0xB8E60: Race stage -> phase, 10 QC Restart, 11 QC
  Finish) is 10 / 11; 0xBAF80 / 0xBAF90 get / set laps (race entry +0x5C, at most 999).
- race-hud.mjs: the field in states 10 / 11 after the green = caution ("CAUTION" in the panel's header); the panel
  stayed up only for states 1..10 before, so the cool-down (11) ended the race on the page and lost the laps led.
  Laps counted under caution give no gaps (all cars at once) and are kept out of the laps-down estimate.

## Race length in the leaderboard: the game's own lap count
- 0x136F0 returns [0x28A556] (u16) = the race's laps (the finish / QC finish checks use it); 0x13760 returns the
  length setting [0x28A56E] (byte, %). The leaderboard took SGPP.SRLN of the profile, which a career / season does not
  use (user: a career Brickyard 400 = 160 x 5 % = 8 laps, the panel said 5 = 160 x 3 %). race-hud.mjs now
  reads [0x28A556] every sample (Milwaukee Race Now: 6, length 3) and keeps the DB estimate only when it is unset.

## Live gaps (race-hud.mjs)
- Race entry +0x50 (float) = the car's race distance in laps (laps + lap fraction; 0xBAF00 writes it every frame from
  +0x5C laps and +0x58 the fraction, 0xBAF50); +0x54 = time into the current lap (not the last lap's time).
- Gaps are now live: every sample (each 2nd frame in main.mjs) each car's distance is binned at 1/400 lap and the time
  it passed each bin kept for two laps (interpolated between samples; no trail over a caution's all-at-once laps).
  Gap = now - when the leader passed this car's distance; interval the same against the car ahead; laps down =
  floor(leader distance - car distance). Line times stay the fallback when distances are missing.
- Milwaukee: gaps 0.03 .. 1.6 s change every update through the lap (were fixed at each line crossing); the parked
  player read +9.8 .. +36.5 s growing, then -1L once the leader was a lap further.
- After the checkered flag the gaps froze nowhere (user: the running order's times kept going up): a car is now "done"
  when it takes the flag (state 7, or a lap past the race's) and its gap (its line time minus the winner's) or laps
  down (race laps + 1 - its laps) is kept from then on; "over" = the winner has crossed. The game stops +0x50 at the
  race distance. Milwaukee cut to 3 laps ([0x28A556] = 3): Harvick +0.57, Wallace +1.13, Labonte +1.63, Nadeau
  +1.73, the parked player -2L, unchanged for the 50 s after the finish.

## Race frame cost on Indianapolis's front stretch (gl-remote capture, page)
- User: the front stretch at Indianapolis drops to ~45 fps. Harness (scratchpad prof.mjs: trtrace7 TRACK_UPS=12 =
  Brickyard 400 in the track list; the live RemoteRenderer with every frame acknowledged; bot driving): ~2,240 draws a
  frame there (crowds, grandstands, the field), 78 command words a draw, ~640 KB a frame; the capture (gl-remote
  record) was ~10 ms of a ~21 ms frame at the start / finish line and ~7.8 of 18.4 ms around the lap; the game's own
  code most of the rest.
- 89 % of draws there have the same program, target, viewport, render states, pixel state and textures as the draw
  before. Now:
  - OP_DRAW_SAME (5): prim, count, index buffer, attributes and constants only; the page (drawSame) keeps the rest
    and only uploads constants, binds the vertex array and draws (full path when the previous draw did not get as
    far as drawing, and never after a draw that copied its own target). Command words 174 k -> 90 k a frame there;
    messages 43 % smaller (534 -> 307 KB a frame over a lap).
  - A quick check before working the state out: the device's handles / GenMap counters (rs, simple), the textures'
    data / format words, the palettes, the viewport object and the 128 texture-stage words unchanged -> same state
    without texture probes, pixel state or render-state lookups. NT04_GL_NO_QUICK / NT04_GL_NO_SAME switch them off:
    the stream (md5 over 3,000 frames) is identical with and without the quick check.
  - constants(): the dirty range read straight from d3d-hle's shared block (sharedI32[36/37]; the accessor
    properties were ~2 %), no closures / arrays per draw; pixelState: no allocation, states looked up by a hash of
    their 31 numbers; render target info once per frame; vertex blocks by a small-integer key checked against the
    entry (vtab); blocks / textures unchanged for 60 checks fully checked every 4th frame (a 64-word / 1/8 sample in
    between).
- Result (same frames, this container): around the lap capture 7.75 -> 5.7-5.9 ms, frame 18.4 -> 15.1-16.0 ms (p90
  27.5 -> 20.5-22); the bunched field at the start 10.0 -> 9.2-9.4 ms capture (many state changes there). The page:
  replaying the same 80 front-stretch frames with and without OP_DRAW_SAME draws the same picture (pixel diff 0) with
  the same 6,200 GL calls a frame; its JavaScript 1.5 -> 1.0-1.3 ms a frame.
- What is left on that stretch: the game's own render traversal (~10 ms here) and ~4 µs of capture per draw.
- Second round (user: drops to the low 50s; the status line there: page 4 ms, game 51-54 fps, emu max 23-26 ms,
  3,400-3,700 draws a frame with the mirror and the bunched field, no frames skipped: the emulator's frame is the limit).
  Capture per draw (timed around RemoteRenderer.draw, 1,500 Brickyard frames, two runs each) 3.23-3.46 -> 2.65-2.68 µs,
  5.2-5.5 -> 4.2 ms a frame; stream md5 unchanged:
  - index blocks by a small-integer key checked against the entry (address, count, primitive), with the STABLE
    sample check (the double keys of three Maps boxed a number per lookup; every index block was fully hashed once a frame);
  - the quick check compares only the 36 texture-stage words the state is made of (address U / V, mag filter and the six
    colour / alpha words per stage), not all 128;
  - streams / attributes in reused typed arrays (no Map and arrays per draw); textures by a small-integer key checked
    against the entry (the string key only for a new one); the constants' dirty range compared as bits;
  - d3d-hle draw fills in the hook's own command object instead of copying it.
- What is left: the game's code ~58 % of a frame there (no single hot spot: 0xF2450 track-object draw loop 2.8 %, 0xF1DB0
  box-in-frustum test 2.6 %, the draw wrapper 0x134E50 2.2 %), the capture ~25 %.


## Career: white badge boxes and no Create-A-Car number from the second race on
- User: after a completed career race the next race showed the ally / rival markers and the badges of the cars
  behind as white boxes, and the career car number was missing from the race results.
- Reproduced headless (crace2.mjs + scratch bdg_c.mjs: new career, race 1 forced to 1 lap and driven by the bot,
  results, Exit to the hub, Build Car > chassis > Quick Select > Race, race 2): race 2's 891 badge / marker draws had
  no texture (race 1 had no allies or rivals yet, so nothing was drawn there).
- Cause: the texture-group kind byte (+0x10 of the UI modules' tables) carries state bits set by the game. The
  in-game table 0x226E20 read 4 on its first registration and 0x24 / 0x34 / 0x44 when registered again for the next
  race. gamecode took the whole byte, so uis_smnm counted as "not a texture group" in race 2: entries were not
  relocated (0x155910) and got no texture object, so 0x13E660 returned the raw block ([+0x14] = 0xA10). The badge
  table 0x2E0750 / 0x2E0808 then pointed at headers that were never filled in, and 0x70030 drew the player's number
  through unrelocated pointers. Fix: kind = the low 4 bits. Race 2: all 891 draws textured, slot 89 drawn (558 px).
- Also: cache entries are now kept per cache handle (arg 0 of 0x13ECD0 / 0x13E660 / 0x13EE30), as the game's caches
  are; leaving the weekend, a second cache frees its group 10 (-2) after the race's cache released its entries. The UI
  renderer keeps the last picture of slots 89-93 once the weekend's entries are freed (hub screens).

## Leaderboard left up over the menus
- User: the board still showed the Watkins Glen race (Final, its season totals) three races later in the career menus,
  so its points did not match the game's standings screen. The race table stays in memory after a race with its cars
  in state 7, which counted as a running race. race-hud now also needs game process 1 in state 10 (the race process:
  grid, racing and the in-race results; 9 is the race weekend menus, 12 the results / front end after it). Off it, the
  board sends active: false (the page hides it) and drops the race, so the next race starts from the then-current DRST
  totals.

## Spotter called a roster car by its template's number
- User: the spotter said "the 2 car" for the added #77 (Brendan Gaughn, template CRID 34 = Rusty Wallace #2).
- The car record keeps CARS NSID at +0x36 (the number the race knows the car by; "0n" as 200 + n) and SSID at +0x34.
  Setting every car's +0x36 in a race: NSID 2 -> spotter entry 342, 12 -> 352 (340 + NSID), 77 / 50 -> a line without a
  number (no sample for those numbers). Setting +0x34 changed nothing heard in that run.
- applyRoster copied the template's NSID (and SSID) whenever no stock car had the new number. Now: another car's NSID /
  SSID with that number, else NSID = the number (as the game's own Create-A-Car rows: a career #63 has NSID 63; up to
  99, else the template's) and SSID 999. A save made with the old roster gets its car's NSID / SSID corrected when the
  roster goes on again (still the template's while the number differs). Checked with the user's roster: CARS 250
  NSID 77 SSID 999, race slot 42 +0x36 = 77; self-tests pass.

## A late caution restarted on the last lap instead of finishing under yellow
- User: caution on lap 11 of 13, the race restarted at 13 / 13 and ended at the line.
- 0xAD960 stage 0x24 (pits close, 0xACA16): laps run (0xBAF80) + the caution's laps left (0xBB220) >= race laps
  (0x136F0) -> 0x28 QC Finish, else 0x25 -> 0x27 restart; but not when the length setting 0x13760() is 3 or 5 %
  (stock RACE rows give those lengths no caution laps). With our NCL3 1 / NCL5 2 the short races ran caution laps
  but never finished under one.
- gamecode cautionFinishHook: 0x13760 answers 10 to those two calls (return addresses 0xACA45 / 0xACA50) while the race
  has caution laps ([0x2BA7C8] > 0); NT04_STOCK_CAUTION_FINISH=1 turns it off. Checked (Indianapolis, laps set to 4,
  caution forced on lap 3): stock 0x24 -> 0x25 -> green finish; now 0x24 -> 0x28 -> 0x29 (checkered, all cars
  state 10) -> post-race results.
- race-hud: at a finish under caution every car is done at once (laps down by distance from the winner, no gaps),
  CAUTION is no longer shown once the flag is out; state 7 counts as finished only on the last lap (the player's car
  showed state 7 in a caution's wreck replay in the harness, which ended the board early).

## Demo race and victory lane at double speed
- User: the demo (attract) race and the victory lane celebration played sped up.
- Those scenes (and the race weekend menus) wait for two vertical blanks a frame (Swap + BlockUntilVerticalBlank:
  30 fps on the Xbox) and time their animation by the vblank delta (Glib 0x20614C, 2 there). main.mjs ran every
  frame in one 60 Hz period, so they played at 2x. Measured per frame (waits / delta): front end 1 / 1, race weekend
  2 / 2, race 1 / 1, demo race (Race process state 13, screen 3/5) 2 / 2.
- main.mjs: a frame now takes as many 60 Hz periods as the vblanks the game waited for in the frame before (1..4),
  game time (vm.frame dt) moves on by the same, the status line's game fps counts periods (60 = real time), the UI
  layer goes out every frame at 30 fps. d3d-hle counts the waits (d3d.waits).
- Also: the instruction-count vblank (every 12.2 M instructions, for spin loops) counted on through the game's own
  vblanks, so about every 4.7th race frame got a second one and a delta of 2 for a 1 / 60 s frame (race delta was
  1 x 223 / 2 x 77 per 300 frames, now 1 x 300). It now counts from the last vblank of any kind.

## Graphics options: antialiasing, render scale, texture filtering
- Page "Graphics" panel (main.mjs PAGE, play-client.js; saved in the browser as nt04.gfx), applied at once:
  - Antialiasing: MSAA 2x / 4x / 8x (capped at MAX_SAMPLES). A target then draws into a multisampled colour + depth
    framebuffer (t.draw) and is resolved (blitFramebuffer) into its texture when next read: shown, sampled by a
    draw (render-to-texture), copied for a draw that reads its own target, or written by the loading bar.
  - Render scale 1x-4x: targets are w x h times the scale; viewports, scissors (the mirror's stencil inset), clears and
    the bar blit are scaled; the shaders keep the game's target size (uRT), so positions map the same.
  - Texture filtering: Off (no mipmaps, as before), Trilinear, Anisotropic 2x-16x (EXT_texture_filter_anisotropic,
    capped). The game's textures came up with level 0 only and min filter LINEAR; mipmaps are now made with
    generateMipmap the first time a texture is drawn after an upload (t.mip), and such textures get a mipmapped
    sampler (+ anisotropy); render targets never.
- Checked in headless Chromium (SwiftShader) with NT04_AUTORACE: Off and MSAA 4x + 2x + 16x both draw the race,
  no page errors. Known trade-off: alpha-tested textures (catch fence, crowd) thin out in the distance with mipmaps.

## Native build of the recompiled code (recomp.mjs --native, recomp-native.c)
- The same generated C, compiled for the machine (x86-64) instead of WebAssembly, linked with recomp-native.c into a
  Node add-on: recomp-native-<platform>-<arch>.node + recomp-native.json (its own manifest) beside default.exe.
  wasm-jit.mjs loadNative uses it before recomp.wasm; NT04_NATIVE=0 keeps WebAssembly; any load error falls back.
- Same memory: the add-on takes the WebAssembly memory's bytes (init) and addresses guest memory as MB + address, so
  CPU context, page flags, block map, enable bytes, hook tables and the D3D state block (NST, now at RC_BASE + 0x1000)
  are shared exactly as before. recomp.mjs nativize() rebases every address the C makes ((T*)(uintptr_t)X and casts
  of ENA / CTXA / OKB / XMMA); the build fails if one is left.
- Float operations whose NaN result depends on operand order are SSE instructions in V8's order (addsd/mulsd/... with
  the same operands first as the WebAssembly code), BAR is a memory barrier; imports are function pointers calling
  the same JavaScript functions through N-API; the dispatcher loop (wasm-jit dispatcher()) is in the add-on (run).
  A JavaScript exception in an import longjmps to its run() and is rethrown there.
- No C library, no Node import library: memcpy & co in the glue; Windows: N-API from the host executable by
  GetProcAddress, kernel32 import library made with llvm-dlltool, __chkstk and _fltused in the glue; linked by
  lld-link (/noentry). Cross-built here: RC_TARGET=x86_64-pc-windows-msvc node recomp.mjs --calls 369 --executed --all
  --native (11,748 functions, ~14 min on 2 cores, 106 MB DLL). Linux: RC_TARGET unset (124 MB .so).
- Checked (Linux, Indianapolis, 1,500 frames): stream md5 identical to the WebAssembly build (5c7cb786...), frame
  p50 / p90 / p99 12.2 / 16.3 / 27.0 ms vs 14.6 / 19.9 / 30.4. Capture 4.1 ms of it either way; the recompiled code is
  ~52% of the frame natively (~59% as WebAssembly). Builds without the --calls functions (0x1333C0, 0x103820) left
  them to the interpreter and were no faster.

## Particles never started (no tire smoke, sparks, dust)

- Effects are messages (type 0x15, dispatched by 0x69060 through table 0x1D6C28) whose handlers start an emitter from a
  pool (0x62DE0 -> 0x16F3A0 -> 0x16F0B0). 0x16F0B0 takes the particles from the game heap [0x282C1C] after checking
  its free space with 0x10FEC0. The game heaps are HLE (0x10FF20 alloc / 0x110100 free go to our allocator), but
  0x10FEC0 was not, so it read the unset heap and returned 0: every emitter start failed, nothing was ever spawned.
- gamecode.mjs: 0x10FEC0 returns 64 MB free (NT04_STOCK_HEAPFREE=1 restores the old behaviour for comparison).
  With it, emitters run in races (sparks on wall contact, smoke, dust), checked in the harness (active emitters,
  particle counts, quad draws x20) and in a browser screenshot (sparks).
- The new hook is "late" for the native / wasm builds (not in their manifests), so the callers of 0x10FEC0 run in
  the JIT; no rebuild needed.
- NT04_PROBE=addr,addr (+ NT04_PROBE_ARG / NT04_PROBE_N) counts calls of game functions (testing aid).

## Post-race "Official Results" listed only the winner

- Screen 3/6 sizes its list with native 0x5B, which the game answers with the number of cars (0x79800 -> 0x13680,
  byte 0x28A553). The JS stand-in returned the number of controllers (1). 0x5B now runs in the game code when it is
  present (GAME_FIRST in uis-natives.mjs). Reproduced with a forced win in a career race: 10 rows after the fix.

## Race loads of 5-7 s with the native build (user video: the game stalls after "Race")

- Live play (page connected: game time follows real time through long calls). While a race loads, the loading
  screen's fade thread (0xEC870) passes over the whole framebuffer (paddusb / psubusb) every 16 ms. The framebuffer is
  in the heap's 0x8xxxxxxx mirror, and those pages were marked direct (OKB 2) only by wasm-jit mirrors(), which ran
  only when the block compiler translated: never in static mode. So every access of recompiled code there went
  through the r32 / w32 imports: ~28M + 28M calls during one race load. From WebAssembly that was cheap; from the
  native add-on each is a call into JavaScript: the load step took 5.8 + 1.8 s (WebAssembly 0.2 + 0.4 s).
- wasm-jit.mjs registerRecomp() now calls mirrors(): the same load is 0.19 + 0.18 s native. Offline streams of native
  and WebAssembly builds stay identical (900 race frames, md5 0d309ed6...).
- Also: the native run wrapper checks the entry map in JavaScript first (an address without an entry returns without
  a call into the add-on); NT04_COUNT_IMPORTS=1 counts the native build's import calls (testing).
- Page (play-client.js): the shader programs built ahead at page open are limited to ~4 ms an animation frame.
- The career weekend load (3 s, the loading bar) is the same in both builds.

## Lightning Challenge completion (checkered flag)

- Result native 0x8b070 (message 0x80000006 of handler 0x8b1d0, sent when the results screen is left; in a real win it
  runs twice, first with success 1, then success 0). Success = thunk 0x9c6c0 = byte [[0x2f31e4]+0x56].
- On success: `select count(*) ... from CHRS where CLID= and PRID=`; if 0, insert CHRS (CLID, PRID). PRID from 0x146f0
  (0 for the loaded profile). The challenge list (13/0) draws the checkered flag from CHRS; the profile save writes it
  as SCHR (CLID, PRID=255), plus SUNK credits (CRDN). Both persist across restarts.
- The CHAL table comes from GMODEDB.DAT part 1 (loader 0x5f4d0 via 0x9a6f0); 0x15d70 (table 0x21dc10) updates
  CHAL CHBC/CHBL after the table-exists check 0x147d50 (hooked against our DB, NT04_STOCK_TABLECHECK=1 for the stock one).
- Verified with the user's saves: harness forced win (0x9c6c0 -> 1), harness real win (lap counter set ahead), and the
  launcher itself (`NT04_AUTORACE=lightning main.mjs Data --boot menu`, forced win): CHRS row, flag on the list, SCHR saved.
- gamecode logs `lightning: challenge <ptr> finished, success <0/1>, completed rows <n>` on every 0x8b070 call.

### Completions wiped after about four challenges (thread stacks)

- Symptom: after ~4 Lightning races in one session the checkered flags were gone (CHRS empty), and the profile's
  next save kept the empty table. In the harness the 5th race load reproduced it every time.
- Cause: xbox-threads.mjs gave each new thread the stack/fs slot of its list index; only 16 slots are mapped
  (0x0f200000 + 0x40000 each). Races create threads, so the 17th thread's stack was unmapped ("bad address
  0xf63fefc") while process 2 changed state 19 -> 21 (race load). The process manager (0x175370 -> 0x175240) retried
  the change every frame, unloading and reloading the module lists; module refcounts went to 0 and negative, and the
  database module's Load (0xa08a0) reloaded nascar.db, whose CHRS/SCHR are empty.
- Fix: a new thread takes the lowest slot no live (not done) thread holds.
- NT04_TRACE_MODULES=1 traces module load/unload (refcounts), process state changes (0x175240) and state enters
  (0x175580), and failed module list loads.

## Unlocks: Thunder Plates, tracks, EA SPORTS Bio rewards

- Cards (Thunder Plates) are table CARD (CRDN number, CRDT type 0..7, CPRM parameter, CLVL level); a profile's
  unlocked ones are ULCD (PRID, CRDN, CLVL, CRDE), saved as SUNK. Award = 0x16B10 -> 0x159E0 (count / insert / update
  ULCD, then 0x158D0 queues a notice; the queue count 0x2F2DA8 is native 0x35 -> 0x16A80, shown as "You've unlocked
  a new Thunder Plate" 2/3 over the results screen). Types seen: 1 = race (CPRM = RAID: the locked alternate races
  - infield / night / fantasy / All-Star / Shootout), 2 = driver (CPRM = CRID), 3 = car won at a track (UORD order),
  4 = Create-A-Car templates, 5 = paint, 6 = misc (Bio-only), 0 = sponsors (levels 0-2).
- Award sites: post-race 0xB6460 -> Race Now win 0x16350 (0x15A60: difficulty / skill requirement; UNSK (CRID, TRID)
  first win with that car at that track -> 0x15E70 next type-3 car card + 0x15F10 the track's type-1 race cards);
  season / career 0x16450 (card of the race run); Lightning 0x8B070; career 0x164E0; cheat names 0x16250;
  EA SPORTS Bio levels 0xE8C30 / 0xE8D80 (table RWLV: Bio level -> card; drivers at 2, 4, 8, 10, 18, 20, 24, 28, 36,
  40, 44, races at 12, 14, 16, 32, misc at 48-60).
- Checked (scratch after_aw.mjs, Race Now at Talladega, 0x16350 run with the win check forced): ULCD gets card 168
  (type 3, car 54) and 42 (type 1, "Alabama 500"), UNSK (32, 13), two notices queued.
- Port bug 1: native 0x35 had a JS stand-in returning 0, so the notices never showed. Now in GAME_FIRST.
- Port bug 2 (EA SPORTS Bio): ExQueryNonVolatileSetting returned "not found", so XapiGetTimeZoneInformation
  (0x106FBF, XQueryValue 0xFF = the 0x100-byte EEPROM user block) left the time-zone struct as stack garbage and the
  local clock 0xE7830 (time() - bias * 60) was ~74 years off. The Bio timer (0x175B40: total += now - last at
  [0x286EE8]+0x11DC) then added it at once: a new Bio showed Level 534, 28320 days. The kernel now answers 0xFF and
  the time-zone indices (bias = host UTC offset, DST off, English, region 1); a new Bio starts at Level 1, 0 days.
- The Bio file: TDATA\4541FFFF\EASB\EASB (shared EA title data), XOR-scrambled with "Copyright Electronic Arts".
- Button bar "Y <profile>" label (2/1, user report "shows Profile4 while L is selected"): 2/1 gets the active slot
  from native 0x92 (0x7A220 -> 0x146F0, *a1 = [0x21DB74]) and the name from 0x91(slot). 0x92's JS stand-in never
  wrote *a1, so the label kept slot 0's name after switching profiles with Y. 0x92 now runs in game code.
  Checked: Y, right (slot 1) -> "Profile4"; Y, left (slot 0) -> "L".

### Race audio crackle, part 2, and sound delay (user: "car sounds are very slightly delayed", "in race audio still crackling")
- Measured on the live path (main.mjs with a scripted page client recording the IAUD stream, 60 fps race): ~17
  clicks a second, phase-locked to the 800-sample frame. Per voice: all of them in EA's 6-channel 50 ms software-mix
  ring (music, crowd, effects); the engine voices (Xbox ADPCM loops) and other PCM were clean, and the ring data EA
  wrote (snapshots between mixes, all six channels in write order) was clean too.
- Cause: EA's sound thread writes from GetCurrentPosition's *write* cursor to ~20 ms past it, once per wake. We gave
  write = play, so the lead was ~20 ms; whenever the thread woke a frame late (it then wrote two frames' worth), the
  mixer had already read past the refilled part into the previous turn of the ring - clicks at the refill boundaries
  (ring positions 143/144, 943/944, 1743/1744...). The write cursor of a looping buffer is now one 60 Hz frame ahead
  of the play cursor (17 ms, NT04_WRITE_LEAD); the hardware's write cursor is ahead of play as well. Race: 1,513 ->
  11 isolated spikes in 90 s (live), 756 -> 0 in 32 s (offline). (Slicing the frame's time into 4 ms steps with the
  threads run between was tried first: worse, 118 / s; reverted.)
- Also: voice and stream volumes glide (~3 ms one-pole) instead of stepping; NT04_MIX_ONLY=ring|adpcm|pcm mixes one
  kind of voice only (debugging).
- Delay: the page player aimed at 200 ms of buffer and gave back load-time cushion (+50 ms per dry spell, up to 450)
  at 10 ms per 10 s, so a race after a load could keep a few hundred ms. Now: aim 120 ms (stretch-free band 69 ms ..
  2.5x), 10 ms per second back after 5 s steady, and main.mjs sends the sound every frame instead of every other.
  Worklet run against the recorded arrival times (wsim2.mjs): race fill 188 ms -> 132-153 ms, 98.9% of grains exact,
  no dry spells in the race.

## Steering wheels (page side, play-client.js "Steering wheel" panel)
- The game reads a pad only (XInputGetCapabilities' SubType is stored by 0x12EE30 but never read), so a wheel is
  turned into one in the page: steering -> left stick X (full lock at a chosen share of the wheel's axis, centre dead
  zone, optional curve), throttle -> RT, brake -> LT, buttons / hat -> A B X Y WHITE BLACK START BACK, stick clicks,
  d-pad (Chrome / Edge report a POV hat as one axis: -1 up, then clockwise in steps of 2/7, >1 centred).
- Profiles per device id in localStorage "nt04.wheels", set up by moving each control (the axis that moves the most
  is taken; pedals keep their rest and pressed values, so +1-at-rest, -1-at-rest and split/combined axes all work).
  Pedals on their own USB device (Fanatec, Moza, Simagic, Heusinkveld...) are found across all controllers; such a
  device is then not a player of its own.
- Checked with Playwright and mocked gamepads (G29-like wheel + separate pedal set): set-up captures as above, then
  steer -0.25 at 50% lock -> lx -16049, throttle half -> RT 124, brake quarter -> LT 58, hat right -> RIGHT, A.
- No force feedback: browsers don't drive wheel motors (WebHID per wheel model would be the way, later).

## Fuel (user: "I don't think the fuel tank ever empties")
- The HUD (0x70A80, per frame) shows fuel as (1 - [[car rec + 0x18] + 0x2C]) * [[car rec + 8] + 0x44] gallons
  (player 0's car record 0x2951E0; [rec+8]+0x44 = 13.5 here) and gives the spotter lines Halfway / Low / Very Low /
  Fuel Tank Almost Empty / Fuel Tank Empty at thresholds 0x2B7764 / 0x2B7588 / 0x2B7514 / 0x2B7768 / 0x2B758C.
  (Phys + 0x24, noted earlier as fuel, is not it.)
- Consumption runs: a Lightning race at Martinsville (scratch lcf.mjs) used ~0.7% of the tank a lap (0.0021 per 5 s;
  ~140 laps a tank), the same with CGPL.SPIT 0 or 1 and any SRLN (that mode sets its own laps).
- "Unlimited tires and fuel" is the difficulty's SPIT (DIFF table: Rookie and the next preset SPIT 0 = unlimited ON,
  the two harder ones SPIT 1). The user's profiles: DIFF 0, SPIT 0, SRLN 3 (3% races), where a tank lasts far
  longer than the race either way. Not checked yet: whether SPIT 0 stops the use in Race Now / season races (the
  scripted Race Now in main.mjs never goes green: the player's entry stays in state 10 at pace speed).
- main.mjs testing switches: NT04_PIT_SETTING=0|1 (SGPP.SPIT before the scripted Race Now), NT04_LOG_FUEL=1.

### Fuel in Lightning challenges
- Per-car challenge setup comes from the CHAC table (one row per car per CLID). Its FUEL column is percent of a full tank. Only three challenges change the player's fuel: CLID 8 "Every drop counts" (Homestead, FUEL 5), CLID 6 "Ah, but I can go Thirty-EIGHT" (Talladega, FUEL 9) and CLID 4 "It's about time" (Rockingham, FUEL 7). Every other car and challenge is 100.
- Checked in the port with the lightning harness on CLID 8: the race starts with fuel used = 0.952 (4.8% left), so the CHAC value is applied. It burns about 1.5% per lap at full throttle (0.00047 per second), which is about 3.2 laps of fuel for the 3-lap challenge. Flat out you finish with a fraction of a lap to spare.
- Forcing used to 0.998 makes it reach 1.0 within 4 seconds. The engine then cuts, the car coasts down (237 to 177) and the challenge ends as failed (state 7, success 0). Running dry works.
- The game's unlimited-fuel difficulty switch (SPIT) does not affect this: consumption is the same with SPIT 0 and SPIT 1 inside the challenge.

### Online racing, step 1: host / join and car sync (netplay.mjs)
- Design: one player hosts, the others join by address (WebSocket, default port 27104). The host relays states and keeps the player list. Every machine runs its own full race; each other player's car takes the place of an AI car.
- Car bodies: car record [0x2951E0 + car * 0x5C0] +0 points to the car's rigid body. The bodies form an array of 0x120 bytes per car, with car 0 first.
  - +0x00: vec3 that moves with the car. It is about 1.8 times the position change per second, so it looks like momentum.
  - +0x10: angular rate. +0x20: centre of mass. +0x34 / +0x38: per-car constants.
  - +0x40: 4x4 matrix (orientation rows, position at +0x70). +0x80 holds a copy of it.
  - +0xC0 and up: forces.
  - AI cars use the same bodies. A position written there sticks: the AI does not pull the car back, and the car's race entry (segment, distance, lane, laps) follows the body (nettest1: car 3 held 12 ft beside the player for 10 s).
  - [rec+0x1C] points into a shared array of 8 collision-box corners per car (0x80 each).
  - [rec+0x10] holds the human car's 4 wheels (0x60 each): +0 hub world position, +0x40 / +0x44 heights.
- Remote cars: gamecode tick() now calls game.afterTick at its end, and NetPlay uses it.
  - It sends our car's body (28 floats: +0x00..+0x2C and the +0x40 matrix) every 2nd tick while our car's race state is 3–6.
  - It writes each remote player's body into that player's slot, a little in the past (NT04_NET_DELAY, default 100 ms). It uses Hermite position between snapshots with velocities from the neighbouring snapshots, orientation slerp, and up to 300 ms of extrapolation.
  - Timestamps are the sender's game ms, with a clock offset per player. The offset follows drops at once and rises slowly.
  - A slot with no state for 2 s goes back to its AI driver.
- Slots: player p is shown in car slot p, and client j shows the host in slot j. Both machines put the human in car 0 at the same grid spot. So when a client's race starts (car state 1, 10, or 3–6), it trades bodies with car j, and its wheels move with it.
  - Without moving the wheels, the suspension flung the teleported car (z 20 to 58 in 2 s).
  - A teleport also ends a Lightning challenge (state 7), so challenges are not a mode for online play.
- Tested with two processes on one machine (scratch nettest3.mjs: Race Now, hand-over, race bot in each, 150 s):
  - States flowed both ways at ~30 per second, and every tick applied them. Local RTT was 3–10 ms.
  - Positions compared by wall clock: the host showed the client's car within a median 2.9 ft (p90 15 ft) of where the client had it. The client showed the host within a median 11 ft (p90 22 ft).
  - The two processes ran at different speeds, which this comparison mixes in.
- main.mjs: `--net-host` / `--net-join <address[:port]>`, `--net-name`, `--net-port` (or NT04_NET_*). A client retries until the host answers and reconnects after a drop. `GET /net` returns the player list, slots, ping, and who is sending. The page's info line shows the same.
- Launcher, Play tab: Online Off / Host / Join, name, host address and online port. It shows this computer's addresses for the host to share, and live status from the game's /net.
- Not in step 1:
  - Race setup is not shared: everyone picks the same race and starts at about the same time.
  - Flags, cautions, pit penalties and results are each machine's own.
  - The other player's car keeps the AI driver's name, number and paint.
  - There is no lobby or relay, so internet play needs a forwarded TCP port on the host.

### Online racing, step 2: the host's race for everyone, shared starts, the host's AI field (netplay.mjs v2)
- Race setup, from the code:
  - Race Now's track pick writes GINF RAID/TRID.
  - The field fill 0x139B0 runs with no screens open. It takes cars with CCRC = 1 by CTYP, then DRVR.DPOP, and sets PLID -1 on field cars (PLID -2 = free, humans keep their PLID).
  - 0xB1D20 then fills QUAL (DRID, LAPT; 43 rows), and the grid follows QUAL.
  - Car record +0x36 is the car's number (CARS.NSID). It identifies a car across machines; the order of the car records does not.
- Host:
  - At its 0x139B0, the clients' cars (reported by each client, "me" message: CRID and phase) get CTYP 1 and DPOP 1000 for the call, so they are in the field. They become AI cars that their players drive remotely.
  - After its 0xB1D20 it sends the race card: RAID/TRID, the shared SGPP fields of its profile (not ASSI), the field (CRIDs) and QUAL.
- Client:
  - At its 0x139B0 it writes the card's race into GINF and its SGPP. Only the card's cars keep CCRC = 1 for the call.
  - After its 0xB1D20, QUAL becomes the card's. Its SGPP comes back when the race ends.
  - The same driver as the host's, a car missing from the host's field, or a roster difference is reported, with a fall back to step 1.
- Starts: A at the pre-race screen 3/18 starts the pace laps. A at the grid intro 3/10 hands over (green about 1.5 s later).
  - With others connected, Pads.filter (new in xinput-hle.mjs: view(port) is what XInputGetState and uiEvents see) holds A and START back there.
  - The host's A sends "go" once everyone has been on that screen for 1.5 s. A press the moment a screen opens is ignored by the game: in the first try the client's go press landed 50 ms after its 3/18 opened and did nothing.
  - Every machine then presses A (packet number changed), and repeats it each second (up to 5 times) while still on the screen. After 2 minutes the host goes without the stragglers.
- The host's AI field: from the pace laps on, every 4th tick (~15/s) the host sends its AI cars' bodies by number (type 2: u16 count, f64 time, per car u16 NSID + 28 f32; ~4.8 KB). It leaves out its own car while racing and the cars of clients that are sending. Clients apply them like player cars, with the same interpolation and a clock offset of their own.
- Tested (scratch nettest4.mjs, two processes, Race Now Talladega, host #24 Gordon, client #25 Nemechek, 180 s):
  - Same race (EA SPORTS 500) and the same QUAL on both (top 4: DRID 36, 18, 27, 6). The client found the host's car in slot 9, the host the client's in slot 17.
  - The host waited for the client at 3/18 and 3/10. Pace start 27 ms apart; car state 3 (racing) 170 ms apart.
  - Same car on both machines (wall-clock comparison of processes running at different speeds): the two humans were within 0.5–22 ft. AI cars were within a median 5–50 ft, the p90 close to the median, i.e. a uniform time offset.
  - Without the AI field (the run before), AI cars drifted 400–2,800 ft apart, and an uncaught failed go press put the pace start 17 s apart.
- Still each machine's own: flags / cautions (yellows are decided locally from the shared positions), pit penalties, results, damage. An AI car a client hits is pushed on that client's screen only (the next host update moves it back).
- Protocol version 2; a version-1 client is refused with a message.

### Online racing, step 3: the host runs the flags, laps and finishing order (netplay.mjs v3)
- Race stages (group 2 of the Race process 0x2F3990; current = 0x1754B0 on [0x2F3990 + 0x14 + 2*4]: [+0x20] ? [+0x1C] : [+0x08]):
  - 0x1C start (0xB6C10 gives the green after the grid intro) and 0x1D racing.
  - Caution: 0x21 cooldown, 0x22 pace car, 0x23 wreck replay, 0x24 pitting, 0x25 pacing, 0x27 restart (0xB6C10 again).
  - 0x28 finish under caution, 0x29 checkered, 0x17 results.
  - The switch 0xAD960 runs the caution steps (0x21-0x28 always). In 0x1D it runs only while the flag [0x2BB104] (0xB9000; -1 none, 0 green, 1 yellow, 2 white, 3 checkered; set by the flag-message handler 0x69DA0 -> 0xB8D70) is yellow. Only then does 0xAD6B0 decide whether a yellow becomes a full caution.
  - RequestStage 0x175030 only queues; the stage changes on the process's next update.
- Host: sends every stage change ({t: stage, s, prev}).
- Client (in the host's race):
  - 0xAD6B0 and 0xB6C10 answer "no" unless the host's matching change came. The caution itself is brought out in afterTick as the game's 0x1D step does it, because 0xAD6B0 is only asked while this machine has a yellow out: 0x2BA9BC = 0, 0x2F3284 = 0, RequestStage(2, 0x21), 0xAAA40 with bl = 0.
  - The steps in between run by themselves.
  - First try: 0xB6C10 also gives the start's green in stage 0x1C, and holding it until a restart kept the client on the grid for 36 s. So the start is ruled too, by the host's 0x1C -> 0x1D.
- Laps: the owner's count. Every state packet carries the car's laps (race entry +0x5C, u16), and so does every car in the host's AI field. The receiver writes them with the body.
  - Why: a network-driven car is written slightly behind where the physics carried it, so near the line it can cross backwards. The game then does not count its next crossing (flag 0x2BB197 + 0x1C per car, 0xB4790).
  - In a 5-lap test before this, the client had the host's car on 2 laps and an AI car on 0. The client "won" on lap 5 while the host's field was still racing, and the two results lists had nothing in common.
- Finishing order (written, off by default: NT04_NET_FINISH=1): the host's.
  - The host times each car's state 7 after stage 0x29: its own and the AI cars by its clock; a client's car by the client's own crossing time ("fin", its game ms), brought over with the clock offset less half the ping, because the host sees remote cars late.
  - The host sends the order as car numbers. A client writes the running positions (race entry +0x5E) from it every tick from its checkered until the results.
- Harness note: unthrottled processes run at different speeds (one ran 3% faster: its race ended 15 s earlier), so the two-machine tests now pace frames to the wall clock (28 ms a frame on both).
- Tested (two processes, Race Now Talladega, 5 laps, caution forced 30 s after the green, frames paced to the wall clock):
  - The caution reached the client 14–33 ms after the host and the restart's green 32–36 ms after. The client's caution steps (cooldown, pace car, replay, pits, pacing) ran on their own within a second of the host's.
  - Laps of the same cars were the same on both machines all race long.
- Running positions: the game keeps its own distance for the order, and with laps shared the positions still differed between machines (an AI car 31st on the client all race, 10th-12th on the host), and so did the results lists.
  - Every position write goes through 0xBAFC0 (eax = race entry, dx = position; read 0xBAFB0).
  - The host's AI-field packet now ends with the positions of all cars (u8 count, u16 number + u16 position). On a client in the host's race, a hook on 0xBAFC0 replaces dx with the host's number for that car, so its order is the host's, its own car included.
- Full test after that (5 laps, caution forced 30 s in, paced frames):
  - Start 17 ms, caution 20 ms and restart green 23 ms after the host.
  - Laps and positions of the same cars matched through the race (within a place at sample moments).
  - Checkered 1.6 s after the host's.
  - The results order at stage 0x17 was identical on both machines (all 43 cars).
- The host-timed finishing order (finishOrder, NT04_NET_FINISH=1) is kept but off: with positions shared it is not needed. It would matter only if a client's own crossing should count over the host's late view of it at a photo finish.

### Online racing, step 4: lobby and relay (relay.mjs)
- `node relay.mjs [--port 27105]` runs on any machine all players can reach: a small VPS, or one PC with that one port forwarded. Hosts and joiners both connect out to it, so no player forwards a port.
- Endpoints:
  - GET /races lists the open races: id (6 hex digits), host name, race, phase, drivers, full.
  - WS /host?name= registers a race.
  - WS /join/<id> joins one.
  - Limits: 50 races, 8 joiners a race, 256 KB a message. A race closes with its host, and its joiners get "the host left".
- Link (one WebSocket per host):
  - Relay to host: binary u8 kind (1 text, 2 binary, 3 joiner connected, 4 joiner gone), u16 connection, payload; text {t: race, id}.
  - Host to relay: 1 / 2 messages to one joiner; 5 close one; 6 one frame copied to every joiner but one (u16 skip, u8 text/binary, payload), so the host uploads the AI field once, not once per joiner. Text frames carry the race info for the list every 3 s.
  - Joiners' traffic is plain netplay messages: the relay wraps it for the host and unwraps the host's for them.
- netplay.mjs:
  - The host's per-joiner handling is now connection(ws), used by both the direct server and hostVia(relay). In hostVia, joiners behind the relay are virtual sockets.
  - All sends to joiners go through broadcast(data, except).
  - join(raceId, { relay }) connects to ws://relay/join/<id>.
- main.mjs: `--net-relay <address[:port]>` with --net-host (registers, retrying until the relay answers; re-registers with a new race id if the link drops) or with --net-join <race id>.
- Launcher: a Relay server field. On Join it shows the relay's race list (fetched by the launcher, /api/net/races), and clicking a race fills in its id. Empty relay = direct connection as before.
- Tested: relay, host and joiner on one machine, Race Now. The joiner found the race in the list and joined. Card, start gates, AI field (1,995 packets) and car states all went through the relay. Racing states began 74 ms apart.

### Music at half speed on the 30 fps screens
- User: on the race results screen the music runs at half speed.
- The 30 fps scenes (2 vblank waits a frame) get frames of two 60 Hz periods, but the game threads ran once per frame. EA's sound thread fills its 50 ms software-mix ring only ~20 ms past the write cursor per wake, so at one wake per 33 ms the mixer played the ring's stale contents for the rest of each frame.
- Measured on the front-end music with frames of 2 periods (scratch aud30b.mjs): 49.7% of the non-silent samples equalled the sample 50 ms earlier, against 0% at 1 period.
- gamecode tick(): for a frame of n periods, KeTickCount moves on one period at a time and the threads get a slice after each of the first n - 1 (the last after the process tick as before). After that: 0% repeated at 2 periods; 1-period frames are unchanged.

### Replay screen at 60 fps
- User: the race replay looks choppy at 30 fps.
- The replay screen 3/3 waits for two vblanks a frame like the other race-weekend screens, but it plays the race back by the clock.
- Measured on a reel (scratch replay60.mjs) at 2 periods a frame and with the second wait passed without a vblank (1 period): the cars moved in 548 of 600 frames either way, at about the same distance per game second (193 / 175 vs 221 / 213 ft/s), so the playback speed is the same and 60 fps gives twice the pictures.
- d3d-hle: `oneWait` makes BlockUntilVerticalBlank return without a vblank. main.mjs sets it while 3/3 is open (NT04_REPLAY60=0 keeps 30 fps).
- 0x20614C still read 2 there, so this is not the frame delta the demo race times itself by; the other 30 fps scenes stay at 30.

### Results screen left over the front end after the attract demo
- User: after leaving the game running, the screen showed "Unofficial Results" with empty rows, "Demo Mode", and a lap-times bar (screens 3/8 3/5).
- Reproduced (scratch attract.mjs: idle from the title, frames paced like main.mjs). The first demo race ends at ~484 s game time with event 33 to the demo screen 3/5, which opens the results 3/8 in the race's UI context (16). At 504 s, 3/5 closes and the game goes back to the title, but 3/8 stayed open there and over every later demo. The same happened before the 30 fps thread-slice change, so that change did not cause it.
- Cause: unloading a UI context (0x759A0) calls 0x13AEB0(mgr), which closes every screen in the manager's own list ([mgr+0x38] count, [mgr+0x3C] 0x14 each) through 0x13A790 and clears [mgr] / [mgr+0xBC]. The VM keeps the screens itself, the list stays empty, so nothing was closed.
- Fix: hook 0x13AEB0. The VM screens of that context close (ui.closeContext); the front end's context 0 is left as it was (its screens are handled by the draw rules).
- Checked:
  - Demo ends: 3/8 closes with 3/5, the title comes back clean, and the next demo shows only 3/5.
  - Race Now to the replay 3/3 and out again: the post-race screens (3/16, 3/13, 3/6, 3/7) open as before.

### Online without port forwarding: UPnP and hole punching (upnp.mjs, netudp.mjs)
- UPnP (upnp.mjs, no server needed):
  - The game finds the router (SSDP M-SEARCH on 239.255.255.250:1900), reads its description and calls AddPortMapping on the WANIPConnection / WANPPPConnection service, retrying with a permanent lease for routers that refuse leases (725). GetExternalIPAddress gives the address to hand out. The mapping is renewed every 20 minutes and removed when hosting stops.
  - A direct host (`--net-host`) maps its TCP port and the status line gives the internet address.
  - With a relay, the host's UDP port is mapped too and offered as a second address to punch.
  - A private "external" address (double NAT, carrier-grade NAT 100.64/10) is reported as not reachable.
  - NT04_UPNP=0 turns it off; NT04_UPNP_LOCATION skips discovery.
  - Tested against a mock router (scratch mockigd.mjs): mapping, external address, removal, a refusal (718) and a CGNAT address all reported as expected. Not tried on a real router here.
- Hole punching (netudp.mjs; relay.mjs only introduces the two sides):
  - The relay answers UDP on its own port. The host registers its UDP socket every 3 s ({t: reg, race, key}; the key comes with the race id over the host's WebSocket). A joiner asks {t: p2p, race, nonce}; the relay sends each side the other's public address ({t: peer}), and both punch from the same socket for up to 10 s.
  - Over the link: JSON is reliable and in order (fragments acknowledged, resent every 200 ms, the link is dropped after 50 tries); car states and the AI field are sent once (fragments; an incomplete one is dropped after 1 s). Keepalive every second, link timeout 10 s.
  - The host treats a link like any joiner (connection()), and broadcast() sends to links directly besides the one relay frame. If no link forms, the joiner races through the relay as before. The relay's list marks races where a direct link is possible.
  - NT04_NET_P2P=0 turns it off.
- Tests:
  - Simulated routers (scratch punchtest.mjs: outside port per inside socket = "cone" or per destination = "symmetric", inbound only from addresses sent to):
    - Cone to cone: linked at once, also with 10% packet loss (26 resends; 10 KB message intact; 20 messages in order).
    - Any symmetric side: no link after the punch time, as expected; that joiner uses the relay.
  - In game (scratch nettest9.mjs, relay + two processes): the joiner linked directly to the host; the card, start gate and AI field went over the link.
  - One earlier run fell back to the relay because the host's event loop was busy longer than the 6 s punch window (a synchronous harness step). The window is now 10 s and the joiner asks the relay every 400 ms instead of waiting.

### Silly season (silly-season.mjs, launcher Career tab)
- The game's routine 0xB0260 (callers 0x9569A in native 0x95690, and 0x7B775) runs once after a career year, before
  0xAFCE0 starts the next. Only database queries (decoded with reversed names):
  - Gate: count(CARS CCRC == 1) > 49. Human drivers (CARS PLID > -1, at most 4) are excluded everywhere.
  - Candidates, list of 10 sorted by score (0xB0180: a driver found again adds his scores; full list keeps the top):
    champion of the year (DRST CWIN 1) when count(CWIN rows) == 8 -> 100; DRVR DSTT != 1/4, BYER < year-48,
    RKYR < year-4, started a race this year (RSTR > 0) -> rand(10) + 10 x (age - 48), max 99, by BYER asc;
    RKYR < year-4 and CRNK > 33 this year (the best-ranked DSTT 2 rookie excepted) -> rand(10) + 10 x (year - last
    year with CRNK <= 33, else count of CRNK > 33 years), max 99.
  - Count: n <= 2 all, else 2 + rand(min(n,3) - 1).
  - Each retiree: APRP rows deleted, (DRID, CRID) at 0x2BAB90 (3 slots, the report's "old car"), DSTT 1 RETY year;
    DDRV twin (either side) DSTT 1 RETY 0 and its cars CCRC 0.
  - Each retiree's car: rand(100) < 50 -> CCRC 0 + SPON IAVA 1 for its SPID. Else by CTYP - 1 (jump table 0xB0AF8):
    CTYP 1/2 -> ranked Busch (CTYP 3, DSTT != 1, RETY 0, DRST this year, order CRNK) first row: his Busch car DRID -1
    CCRC 0; none ranked -> random unranked Busch (the cursor's row index at +4 = rand(count)), his Busch car stays
    CCRC 1 and gets a pool driver (ranked CTYP 4, else random), the pool car going to the retiree (CCRC 0); no Busch
    at all -> random pool driver. CTYP 3 -> pool driver (ranked, else random), pool car to the retiree parked. CTYP 4
    -> parked. Others (0 legends) nothing. Every new driver DSTT 3, RETY year.
  - Ratings never change anywhere: no query writes DRVR DSPD/DCTL/DDEF/DAGR/DDUR/POTN or DSKL.
- Stock quirks seen in 20 compared off-seasons and 12-year runs: the Busch-series twin records (DDRV DDRD: Burton,
  Earnhardt Jr., Harvick, Waltrip) get promoted into a second Cup car while the person still drives his own; a twin
  retiring on its own retires the person and parks his Cup car; promoted ranked Busch drivers' cars are parked, so
  the Busch field shrinks (15 -> 4 in 12 years) and Cup with the 50 % folds (40 -> 28); a moved driver keeps RETY
  forever and is never picked again (pool -> Busch drivers never reach Cup); the pool includes the broadcasters
  (Barney Hall, born 1932, etc.).
- Off-season report = screen 4/4 (natives 0x80000001 0x95D20 builds the list: DSTT 1/3 with RETY year; RKYR = year+1
  for DSTT 3 without DRST rows; 0x80000002 0x95E50 then DSTT 3 -> 0 / 2). Rows: retirees with the DSTT 3 driver now in
  their old car as "Replacement" (N/A when folded). It never showed anything here: 0x95DE0 passes its cursor struct
  BY VALUE to 0x95BD0, and the query bridge found cursors only by address. Fixed in gamecode's fetch: an unknown
  address falls back to the handle in the struct's first word. Now "K. Wallace Retired R. Hornaday" etc.
- Career news: CNWS (NTYP, SNTP, DAT1..3 floats; capacity 25; saved with careers; cleared after each race by
  0xB658C -> 0x3F280). Ticker 0x3F370 (native 0x3F via 0x81830): category header = ECNT EDIS for NTYP (enum lookup
  0x5F150, already in JS), lines = 0x3ED80(ecx NTYP 0..3, [esp+4] SNTP, DAT1..3, esi out). NTYP 4 is free.
- silly-season.mjs: with config sillySeason.enabled the hook on 0xB0260 runs the same steps in JS on the same query
  engine with the game's random numbers (0x14A10) — identical DRVR/CARS/SPON/APRP/DDRV/DRST/GINF/DSKL and 0x2BAB90
  results to the native routine in 20 of 20 synthetic season ends (5 standings variants x 4 seeds, incl. an 8th
  title; scratch ss/eq.mjs). Every number is an option. Extras: fixes (twins never candidates or promoted; their Busch
  car refilled; a promoted ranked Busch driver's seat refilled; RETY marks from past years cleared), market (talent =
  0.7 x mean DSKL + 0.3 x DSPD; residual = talent rank - points rank; under-performers swap rides with over-performers
  not moved the year before; carFollowsDriver swaps TMID/OWNR/CTYP instead), callups (a Busch driver with talent >=
  a back-marker's + margin swaps cars with him), revival (parked Cup / Busch cars, not Create-A-Car 183..202, return
  with the best Busch driver or a pool pick while fewer than 40 / 15 run), rookies (customFirst: Roster pool drivers
  ranked first, pool picks younger than the retirement age; generate: carless DSTT -1 prospects DRID 700.., DSKL made
  from their DRVR ratings + id on every load, repairGenerated), news (CNWS NTYP 4 rows, ECNT 4 "Silly Season",
  formatted at display time by the hook on 0x3ED80; texts <= 56 characters with shorter variants), 0x95BB0 hooked
  for any number of retirees. 30-year run with everything on: Cup 34-38 cars, Busch 15, pool held at 12, no person in
  two Cup cars, DRVR 119 -> 166 rows.
- Roster tab: driver list "Rookie pool (careers)" = car class 4: the driver is a fill-in driver (DSTT -1) with his
  own pool car (CTYP 4, CCRC 1) like the game's fantasy drivers, so even the stock routine can pick him. A save where
  he was moved keeps him as saved (applyRoster: his own car, OWNR = him, now someone else's).
- Launcher Career tab (career-server.mjs, career-ui.js): roster/career.json { sillySeason }, merged by
  nt04-config withCareer (uis-run). main.mjs serves the last off-season at /silly-season; also <save>/silly-season.log.
- Not run end to end: a whole career year in the headless harness (career Post Race Stats 9/17 did not take the B
  press here), so the ticker lines were checked by calling 0x3ED80 / 0x5F150 directly and the report by opening 4/4
  after the routine.
- Team prestige and driver contracts (sillySeason.contracts, silly-season.mjs contractOffSeason): no such data in the
  game (TEAM is TMID + name; CONT is the player's sponsor contracts), so two tables of our own: SSCT (DRID i32, TMID
  u8 (255 = free agent since YEND), YEND u16 last season, LENG u8) and SSTP (TMID u8, PRES u8, pad). They are made in
  the JS database by applyConfig (ensureTables) with STAB rows {UFIL 2, ICRC 1}, so 0x5E400(cl 0, [esp+4] 2) flags
  them and career saves write them (checked in game: save flag set; writeDb/parseDb round trip). Emptied when
  0x148510 reloads DRVR (a new career) and when a loaded save image lacks SSCT.
  - Standing 0..100 = talent percentile among active drivers, half and half with the last two seasons' points
    positions (100 - 2.4 x (rank - 1), this year counted twice), 80 % of the percentile without results.
  - Prestige: first off-season = mean standing of the team's Cup drivers (+5 for CTYP 1 cars; Busch-only 45 % of its
    Busch drivers'); then each year moved prestigeSpeed % toward the mean result score of its Cup cars (+10 champion).
    The first version used the team's best car: one star made a whole team 99 and its team-mates "unworthy".
  - Cup seats ask standing >= prestige - tolerance to hire, prestige - 2 x tolerance to keep; Busch seats ask nothing
    (the game rates its Busch drivers 56-65, below its fill-in pool 60-78, so they would never qualify).
  - Retiree's car folds with foldChance x (100 - prestige) / 50 (clamped 0..2x); else an open seat. Expiring contracts
    (first year: everyone gets 1..maxYears left): keep re-sign with resign %, else free agent + open seat. Comebacks
    (revival) add parked cars as seats (not ones folded the same off-season). Seats filled Cup first, by prestige:
    best standing (+0..5 random, +15 Roster pool drivers with customFirst) among free agents, Busch drivers (Cup
    seats; contracts do not hold them back from moving up) and young pool drivers; eligible first, else the best there
    is; nobody at all -> parked. A free agent unsigned sitOut seasons retires.
  - 20-season run (fixes, contracts, rookies, revival): 1-10 drivers moving a year (about 5), against 8-15 with the
    market + call-ups; Cup 35-38 cars, Busch 13-15, no person in two Cup cars. Stock mode still identical to 0xB0260.
- Rookies tab (rookies-ui.js; roster-server.mjs POST /api/roster/rookie, /rookie/delete; roster.json "rookies"):
  prospects with no car: name, birth date, hometown, 5 ratings, 4 track skills, optional portrait / close-up
  (roster/textures/uis_drpo|uis_drps/<poid>.png, poids shared with the Roster drivers; "portrait" flag kept by the
  server so POID is 0 = generic face without one). Ids 500..699 (Roster drivers 250.., generated prospects 700..).
  nt04-config applyRookies (end of applyRoster, so also after a save load): a DRVR row copied from a game fill-in
  driver (DSTT -1, DSID 999, RKYR 0) + DSKL rows; a save's row (promoted, retired) is kept, POID refreshed. Only the
  JS silly season gives them rides (poolDrivers: carless DSTT -1 drivers from 250; customFirst counts 250..699); the
  game's own routine picks pool drivers through their CTYP 4 cars only. Roster class 4 is now labelled "Fill-in
  drivers (own car)". Checked: a 86-speed rookie got the #23 Bill Davis Racing seat with contracts + customFirst.

## Sponsor paint schemes (launcher Sponsors tab; user: "import their own paint schemes along with the pit crew uniforms ... without numbers so that numbers can be put on them")
- Library: roster/sponsors.json + roster/sponsors/<id>/paint_<make>.png (number-free, converted from the ea1252 layout
  when given that way) and crew.png (sponsors-server.mjs, sponsors-ui.js). Up to 63 schemes, tier 1-5, number font /
  fill / outline / second outline, number spots per make (draggable boxes in the tab), primary / secondary colours, an
  optional car to start on.
- Numbers (number-paint.mjs): the game's Create-A-Car number fonts, CARPARTS.DAT 192..206 (side) and 207..221 (roof),
  one per FONT row; 512 x 64 grey strips (fill ~210, outline ~50; cells 38 / 46 px apart). Default spots measured from the
  stock paints of each make (CMDL 0..3): upper door (rotated 180), roof, lower door, headlight, rear.
- In the game (gamecode withRosterPaints / sponsorPaint): CARDATA / CARRESFE entries 0x600 + i (cars schemes start on,
  sponsorStarts order) and 0x700 + slot (career deals, 256 slots): the scheme's paint of the car's make with the car's
  own CNMD drawn on, encoded in the format of a stock paint of that make; anything missing -> the car's own paint.
  Crews: CHARTEX 0x180 + scheme id (crew uniforms only show for the player's car, as in the stock game).
  Bug found while testing: a size getter in an entry object used `this` (the entry) -> self.
- Career (silly-season.mjs "sponsors" option, Career tab "Sponsors change teams"): table SSSP (SLOT, SCHM, CRID, YEND,
  the car's own CRSK values OCTI, ORTO, OPTX, ONAM, OPR/G/B, OSR/G/B), in career saves (STAB UFIL 2). Each off-season:
  deals past YEND renew (renew %) or end (car back to its own paint); also end when the car stops running, a human
  drives it or the scheme lost that make's paint. Then up to `moves` free schemes sign (chance %), with a running AI car
  of a make they have a paint for that no scheme is on, the car whose team prestige (SSTP, else 75/50/25 by car list)
  is nearest tier x 20. News kinds 11 (joins) and 10 (leaves). resetCareerTables now empties only the tables a loaded
  save lacks. Simulated 12 seasons: deals start, renew, end and move; every undressed CRSK row equals the original.

## Sponsor list: sponsors added to the game's own list (user: "Can we allow custom sponsors made by the users")
- The game's sponsors: SPIN (SPID, SSID speech, SPLG logo, CSBI, SNAM, SPCT) and SPON (one row per spot a sponsor can
  take: STYP 0..4 the five decal spots of the player's car (Sign Sponsors: Primary, ...), 5 an AI team's primary; SPLV
  level 0..4, CSPP payment (CSPL ranges per level), IAVA available, TTAV). Career offers: OFFR (3 per spot, drawn from
  the available sponsors of the levels reached); signed: CONT + SSTA.
- Logo index SPLG: menus UIS_SPON entry SPLG (an STYP 5 sponsor: SPLG + 45, 0x3E0A0 / 0x3E0D0), 128 x 128 DXT1; car
  decals: the part index 0x6D3D0 (table of bases, jump table 0x6D580 / type map 0x6D5A4) gives base + SPLG (0x6D3A0
  = SPIN.SPLG) for decal kinds 7..15: CARPARTS bases 226 (128 x 128, logo turned 90 cw), 271 (128 x 32), 316 (64 x 128,
  turned 90 ccw), 361 (128 x 32), 406 (128 x 32 turned 180), 451 / 496 / 541 / 586 (32 x 32); 45 stock associates each.
  Kind 19 (633 + ...) and 4..6 (numbers) do not use SPLG. CARPARTS decals are LIN_L8 (0x13), one level: indexes into
  the compositor's colour ramps from the car's two decal colours (0x6EE10 -> 0x6E2F0 / 0x6E310: 0x10-0x3F colour B ->
  black, 0x40-0xCF colour A -> colour B, 0xD0-0xFF black -> colour A; 0x00-0x0F clear).
- SPID must stay below 256: the signing code (0x3BDD9 CONT insert, SSTA) keeps it in a byte (an added SPID 401 was
  signed as 145, with garbage contract values). Added sponsors: SPID 187 + id (188..219), SSID 999 (no speech), SPLG
  0x800 + id * 0x300 (base + SPLG past CARPARTS' 693 entries; (e - 0x800) % 0x300 = the base names the kind; the menus
  read SPLG as int16, so id <= 32).
- sponsor-decals.mjs: decals made from the logo (cut out: transparency, or the corner colour of a flat picture),
  turned per kind and fitted in the median box of the stock decals of that kind; light parts -> colour A, dark parts
  -> colour B (index 0xCF - L * 0x8F). Compared side by side with the stock decals made from the stock menu logos: same
  places and orientation.
- nt04-config applyBrands (every nascar.db load) / reapplyBrands (a save's SPON without the rows); gamecode
  withBrandDecals on CARPARTS (RESIcarparts resident open and by name); the menu logo: uis_spon texture override
  roster/textures/uis_spon/<SPLG>.png written by the launcher (sponsors-server.mjs brand routes, brands-ui.js).
- Checked on the user's machine (uis-run, Career > Sign Sponsors, stock STYP 0 sponsors made unavailable): the added
  sponsor is offered with its logo, signs ($12K for 6 races, CONT / SSTA SPID 188) and the game loads its hood decal
  (CARPARTS entry 3042 = 226 + 0xB00). The composed car paint itself was not looked at (no 3D car in that run).

## Career: leaving the game's own rookie pool drivers out (user: "allow removing the game's own eligible rookies in career mode similar to how we do in just the normal roster")
- The pool = the drivers of the game's CTYP 4 cars (46: fill-in drivers, the SZ tutorial cars, an EA SPORTS promo car,
  a few others). Every pick of the game's silly season (and silly-season.mjs) needs RETY 0; RETY is otherwise only
  compared with a season year (off-season report; db_queries: no other use). So a left-out driver gets RETY = POOL_OUT
  (1): never picked, still in quick races and seasons (unlike the Roster tab's removal, which takes cars out everywhere).
- applyPoolRemoved(db, drids): marks listed drivers still in the pool (not retired, no car or a CTYP 4 car), takes the
  mark back from anyone else; on every nascar.db load (nt04-config, cfg.poolRemoved from roster/career.json via
  withCareer) and every career save load with DRVR (gamecode; also clears marks when the list was emptied).
  silly-season.mjs: the "fixes" RETY clean-up skips 1; the contracts seat filling (which reads CARS directly) skips
  RETY 1 drivers.
- Launcher: Career tab card "The game's rookie pool" (career-server /api/career/pool GET / POST, career.json
  poolRemoved); a button unticks the tutorial (SZ) and EA SPORTS cars.
- Simulated 20 seasons (synthetic DRST each year) with 18 of 46 left out, in game rules / fixes / custom-first /
  contracts + revival: 1 / 15 / 16 / 25 pool drivers got rides, none of the left-out ones. With every pool driver left
  out, the game's own rules park a seat they cannot fill.
- Busch drivers who stay in Busch (follow-up: "Aren't there certain busch drivers like coy gibbs that also are in this
  pool?" — no: Coy Gibbs drives the #18 Busch car (CTYP 3); Busch drivers are the game's candidates for open Cup seats,
  the CTYP 4 pool fills open Busch seats). sillySeason.noPromote [DRID]: never moved up to Cup by the ride filling
  (ranked / unranked CTYP 3 pick), the contracts seat filling, the call-ups or the revival. Only with "Use these
  settings" on: the RETY mark would also stop retirements (the retirement candidate query needs RETY 0). Career tab
  card lists the 11 Busch drivers who are not DDRV twins of Cup drivers. Simulated 20 seasons x 4 rule sets with 6 and
  with all 11 listed: none of the listed moved up; with all listed the Cup seats are filled from the pool.

## Career: ratings that change with age (silly-season.mjs "progression"; user picked it from the open list)
- The game never writes DSPD / DCTL / DDEF / DAGR / DDUR / POTN or DSKL (POTN is 75 or 80 for everyone: no use as a
  potential). DRVR is in career saves, DSKL is not.
- progressRatings (each off-season the JS silly season runs, before its early "too few active cars" return): per
  driver not retired (not "CustomCar" rows, human players' drivers only with "players"), age = next year - BYER: up to
  growUntil +growth x 0.5..1.5 a rating, scaled by (potential - rating) / 15 (0..1.5); potential = hash(DRID) -> 60..99,
  at least mean + 3; from declineFrom -decline x (1 + 10 % per year past) x weight (DSPD, DDUR 1, DAGR 0.5, DCTL / DDEF
  0.33); results: points position vs talent position in its series +-8 -> +-1 (not declining); randomness +-r/2.
  Whole numbers (random rounding, so small steps add up), 20..99.
- Track skills: snapshotSkills at the end of every applyConfig (nascar.db load); restoreSkills = base DSKL + (mean of
  speed / control / defense now - then), run after the progression and in resetCareerTables (every save load and the
  career reset), so a loaded career gets skills from its saved ratings and the next career starts from the stock ones.
  Drivers not in the snapshot (generated prospects): DSKL moved by the year's change (and rebuilt from DRVR on load).
- Report (/silly-season): drivers with a ride, counts better / worse and the 5 biggest up and down.
- Simulated 15 seasons (defaults, fixes, generated prospects, random results): Vickers 63 -> 77 at 29 -> 75 at 35;
  Earnhardt Jr. 92 -> 82 at 44; Kenseth 92 -> 82 at 46. The Cup field gets older (mean age 37 -> 44: the game's
  retirement rules retire 2-3 a year), so its mean rating drifts down (79 -> 68); in the game a declining driver also
  finishes worse and collects retirement points, which the random results of the simulation do not do.

## Roster: Busch drivers (user: "Can we allow adding more Busch drivers?")
- CARS CTYP 3 = the Busch drivers (15 in NASCAR.DB, CCRC 1; the Roster tab had called class 3 "Fantasy" and 4 "Custom":
  now "Busch" and "Fill-in (rookie pool)"). Roster drivers can now take class 3 (roster-server, roster-ui "Busch
  drivers", nt04-config applyRoster CTYP 3 with CCRC 1, DSTT 0). In races: fill-ins after primary / secondary, as the
  game's own; in careers: found by the game's Busch pick query (CCRC 1, DSTT != 1, RETY 0, CTYP 3: 16 rows with one
  added) and by silly-season.mjs. Career tab "stay in Busch" lists them too (from roster/roster.json; reloaded when the
  tab is opened).

## Roster: teams (user: "Can we allow adding new teams")
- TEAM is only TMID (u8) + TMNM (28 chars); CARS.TMID ties cars to teams (car select / results join it; careers: the
  contracts' hiring and prestige SSTP per TMID). No team logos in the game files (UIS_LOGO: 10 front-end pictures).
- roster.json: teams [{ id 200..254, name, prestige|null }] (255 stays out: SSCT uses TMID 255 for a free agent),
  teamNames { TMID: name } renaming the game's, carTeams { CRID: TMID } moving the game's cars. Drivers' car.team is a
  TMID; rosters from before kept a new team inside the driver ({ id, name }): moved into teams on load (roster-server
  teamsOf). applyRoster adds / renames TEAM rows and applies carTeams only on nascar.db loads (reapplyRoster on a save:
  { fresh: false }, so a career keeps the teams its silly season gave its cars). A team's prestige: the first
  off-season's SSTP value with contracts on (installSillySeason passes roster.teams prestige as options.teamPrestige).
- Launcher: Roster tab "Teams" card (add / rename / remove yours, rename the game's, move the game's cars between
  teams, bring a car in); the driver editor's team list has yours. Checked: TEAM rows 200 / 201 and the rename, car 200
  (Hermie Sadler) on the new team through the game's CARS-TEAM join, a save's own team kept, SSTP 201 = 60 at the
  first off-season.

## Unlock everything (user: "can we add a setting to unlock everything")
- The game's unlock pass 0x16840 (callers 0x5E862, 0x5F467, 0x8E820, 0xA0920, 0xA0CBA; profile start-up): ULDR
  emptied and refilled with every car not CTYP 6 / 8 / 9 / -1 for profiles 0..3 (query 0x1DE154), then 0x15DD0 for
  card types 2, 3, 1, 6, 4, 5, 0, 7: each ULCD card of that type through the handler table 0x21DC14 (0x6A680 none for
  0 / 3 / 6, 0x15C10 type 1 races, 0x15AE0 type 2 drivers, 0x15C90 / 0x15D00 types 4 / 5, 0x15D70 type 7). An award
  at run time is 0x16B10(card | level << 16, profile, silent): 0x16AA0 check, 0x159E0 ULCD insert / update (CRDE 1;
  with silent 0 also the notice 0x158D0), the type's handler, and the group cards 0xE1 / 0xE2 / 0xE6 / 0xE7 (0x161B0:
  award a list of cards) and 0xFF (0x16100).
- CARD: 225 rows, CRDN -8..-1 placeholders (CLVL -1), sponsors (type 0) 23 cards x levels 0..2, the rest level 0:
  171 cards; ULCD capacity 868 (= 217 x 4).
- gamecode unlockAllHook (NT04_UNLOCK_ALL=1 from the launcher's Game card "Unlock everything", or config.unlockAll):
  before 0x16840 runs, ULCD gets every card at its top level for PRID 0..3 (684 rows); after a profile save brings
  its own ULCD / ULDR the same again and 0x16840 is run (nested). No notices.
- Checked on the user's machine (uis-run to the main menu): ULDR 168 -> 452 rows (all cars but the 4 Create-A-Car
  slots, CTYP 6), RACE.RSEL 0 -> 1 on the 24 locked races (Dover 400 ... The All-Star, The Shootout, Lumberjack 325,
  Tiburon 500, 2002 Ford 400).

## Launcher presets (user: "settings presets that are kind of like containerized versions of the game ... switch
## between presets and their game or saves won't be affected")
- A preset = the player's own files: roster/ (roster.json, sponsors.json, career.json, schedules.json, tracks/,
  converted/, objects/, textures/, paint/, sponsors/) + save/ (XboxFs save root: profiles, seasons, careers, EA SPORTS
  Bio TDATA) + "Unlock everything". "default" (shown as "Main") = the folders beside the launcher, untouched; others:
  presets/<id>/ { preset.json { name, created, unlockAll, from }, roster/, save/ }. Shared: Data, textures/ (upscaled),
  models, exports, captures, nt04.config.json, the launcher's other settings.
- Game side: NT04_USER = the preset folder (launcher spawn env, not set for "default"): nt04-config userRoot() for every
  roster file (withRoster / withTracks / withCareer / withSponsors / withSchedules; rosterDir follows), gamecode save
  folder (NT04_SAVE, else NT04_USER/save, else beside the exe), uis-render roster texture root.
- Launcher: the five servers take user (default here) and are made per preset (srv()); /api/presets GET, POST
  { action: create (name, from, copySaves, switch) | switch | rename | delete }; switching / creating-with-switch
  refused while the game runs; the active one can't be removed, "default" never. UI: header preset switcher (reloads
  the page) and a Presets tab (cards with drivers / files / save sizes; new preset from nothing or a copy).
- Checked (scratch launcher + Playwright): preset copied from Main, a team added in it (3 of yours), Main still 2;
  withRoster with NT04_USER reads the preset's roster (and rosterDir), without it Main's.

## Slowdown loading to the main menu (user report)
- Measured on the user's machine (headless flow boot, intro skipped, START at the title, 10 s in the menu; CPU
  profile): the game's own frames were cheap (menu ~0.5 ms), the time went to file access: of 9.3 s profiled, 3.0 s
  reading files and 3.5 s readdir / stat. (Unlock everything and presets made no difference: 0x16840 runs a few times,
  ~10 ms in all.)
  - Resource opens 0x118A70 read whole archives: nspchdat.dat 448 MB (1.27 s), nmusic.dat 290 MB (0.78 s),
    nsound.dat 108 MB (0.30 s) during the title screen; ~850 MB kept in memory for a few streamed entries. Now
    file-bytes.mjs FileBytes (Buffer-like: length / subarray / readUInt* / toString, 64 KB block cache) for game files
    of 24 MB and up (gamecode resource opens, the file module 0x129070 and the stream handle 0x119260 path through
    fileFromBuffer); the boot frame went from ~870 ms to ~85 ms.
  - xbox-fs host() read every folder of a path on each NtCreateFile and stat() of a folder stat'ed all its entries
    (Z:\data, the cache partition: 37 opens). Now listings / stats cached (the disc's for good, the hard disk's dropped
    on any create / write / set information / delete: dirty()); the game module's findFile caches the Data folder's
    listings. Total profiled time 9.3 s -> 4.5 s, the worst title-screen frame 581 -> ~280 ms.
  - Left: the first-time compile of new code at the title -> menu switch (frames of 100-300 ms) and track-pack.mjs
    packKey walking the user's track packs at start-up (~0.4 s, before the window).
- Checked: menu music plays (streamed from FileBytes), a fresh preset creates its 4 profile saves and the next boot
  loads them (menu without the autosave question).

## "Enable Autosave?" on every boot of a new preset (user report)
- Reproduced (fresh save folder, Yes at the question, the main menu's autosave writes User Profile 1-4): the next
  boot asks again, every time. The question comes whenever there is no System Settings save; the settings slot
  (slot table 0x21F2C8 record 0: type 0, active, +0 / +4 = -1: no device yet) never looked changed (Yes stores
  CSYS.ASAV = 1 = nascar.db's value), so the autosave (0xD9 -> 0x5EC60 count of changed slots -> native 0x82 dialogs)
  skipped it. The user's Main folder has "System Settings 1" (made by a settings change at some point), so it never
  asked there. (Trying CSYS.ASAV = 2 before the question did not help: the slot's baseline is taken after it.)
- gamecode settingsSaveHook: a pre-hook on 0x5EC60: while record 0 has no device, its "unchanged" flag +0xD is cleared
  and the baseline checksum +0x14 moved, so it counts as changed; with Autosave on the main menu's autosave writes
  "System Settings 1" (to the hard disk: +0 = 0, +4 = 1 afterwards) with the profiles. NT04_SETTINGS_SAVE=0 turns it off.
- Checked on the user's machine: fresh preset folder, three boots: the first asks and saves System Settings 1 and the
  profiles, the next two do not ask. A copy of Main's saves: no question, nothing rewritten.
- Follow-up (user: stuck on "Please wait. Saving System Settings to hard disk."): their test preset got the save
  folder U:\4370E729B86B (22:40:50) and nothing in it; the box stayed up. Not reproduced here: on the user's machine
  through the Linux VM the same saves (copy of that preset before it) write SaveMeta.xbx, "System Settings 1" and
  saveimage.xbx and the next boot does not ask. With the empty folder left behind every later settings save fails
  ("Unable to save System Settings to hard disk. The maximum number of saved games already exist": NtCreateFile of
  the folder -> NAME_COLLISION, its SaveMeta.xbx opened empty).
  - xbox-fs: empty folders under E\UDATA\<title> are removed at start-up (logged "fs: removed the empty save folder");
    the file calls (create, open, close, read, write, query / set information, full attributes, query directory,
    remove) catch host errors: logged "fs: <call> failed: <message>", the call returns ACCESS_DENIED (DOS 5) instead
    of an exception through game code (the suspected way the box stayed up). (The VM cannot delete files, so the
    clean-up itself was not run here.)

## "Unable to save System Settings to hard disk" (fixed)
- fs.log on the user's machine: `create failed: TypeError: Cannot read properties of null (reading 'isDirectory')` at xbox-fs create, right after mkdir of the new save folder.
- Cause: the disc root is dirname(Data) = the game's folder, and the save roots (save/, presets/<name>/save/) sit inside it, so isDisc() said "disc" for save paths. Their stats/listings went into the permanent disc caches that dirty() never clears: the stat taken before mkdir (null) stayed, and the create threw. Existing saves (profiles) were unaffected; any new save folder failed (it worked on the VM only because the VM could not delete the leftover folder).
- Fix: isDisc() excludes paths under saveRoot; create() returns NAME_NOT_FOUND instead of throwing when the new entry can't be stat'ed. Tested with a copy of the preset inside the game folder: System Settings 1 saved in a new folder. fs.log now records only failures.

## Launcher Help tab (help-ui.js; user: "add a help and documentation section on the launcher for everything we have done")
- Page-side only: launcher.mjs serves /help.js, nav button "Help", <section id="help">. Topics (searchable, with a topic list): getting started, controls and page keys (F2/F3/F4/F6/F9/M, default key map from play-client DEFAULT_KEYS, pads, wheels), graphics, unlock everything, presets, roster drivers / removing game drivers / teams, rookies, career silly season, rating progression, rookie pool and Busch stay list, sponsors (sponsor list + paint schemes), tracks, schedules, textures/overrides/setup, online, saves and file locations (fs.log), troubleshooting.
- Keep it in step: a new launcher feature or game page key should get a line in help-ui.js's T list.

## Game files from a disc image (xiso.mjs; launcher Setup -> "Game files")
- XDVDFS reader in plain JS: finds the game partition (xiso at 0, Redump XGD1 0x18300000, XGD2 0xFD90000 / 0x89D80000, XGD3 0x2080000) by "MICROSOFT*XBOX*MEDIA" at +0x10000 (and +0x7EC of that sector); root dir sector/size at +0x14/+0x18; directory = binary tree of entries (u16 left, u16 right in dwords, u32 sector, u32 size, u8 attr 0x10 dir, u8 name len, name, dword-aligned; 0xFFFF = sector padding).
- The NT04 disc root is default.xbe + Data/ (69 files, 3272 MB), i.e. the launcher's layout, so paths are kept; $SystemUpdate skipped. Files are written as .part then renamed; same-size files are kept unless --force (re-running resumes).
- Verified on the user's "NASCAR Thunder 2004 (USA).xiso.iso": all 69 Data files and default.xbe byte-identical to the working copy.
- Launcher: POST /api/iso {path, force} runs `xiso.mjs extract <image> <dirname(DATA)>` as a job ([n/100] lines drive the bar); status has xbeFound / dataDir; Play tab shows "game files not set up" with a link when either is missing.
- Still to do for a Node-free release: default.exe (xbe2pe.py, Python) and recomp.wasm (clang) from the extracted XBE.

## xbe2pe in JavaScript (xbe2pe.mjs)
- Port of xbe2pe.py (kernel export table generated from the .py's KERNEL_EXPORTS, 371 ordinals). Output on the retail default.xbe is byte-identical to default.exe (md5 d9e28c0d…), --labels identical to kernel_imports.csv, --ordinals mode identical to the .py's.
- Used by xiso.mjs (extract makes default.exe after copying; again when the XBE was copied or with --force) and by uis-run.mjs at start-up (default.xbe beside Data but no default.exe -> made). Both verified identical. A setup from a disc image needs no Python now.
- Side observation, same run without recomp.wasm beside the exe (block compilers instead of clang output): reached the menus; title frames avg 4.5 ms vs 2.4 ms with recomp.wasm. A race comparison is still needed to judge whether clang can be left out of a release.

## Race benchmark: recomp.wasm vs the block compilers (_to_delete/bench/race-bench.mjs)
- Bot-driven Race Now (EA SPORTS 500), game code only (no drawing), Linux VM (2 cores), 900 race frames (first 300 = warm-up). Menu path: the Race Now weekend menu (3/12) needs one more A on "Race"; the race is screen group 10 (not 3/10 as recomp-sample.mjs expects).
- recomp.wasm: start-up 9 s, menus to race 19 s; race median 9.3 ms/frame (95% 13.5), 1 frame over 16.7 ms in 600.
- NT04_RECOMP=0 (block compilers): start-up 24 s, menus to race 60 s; race median 16.5 ms (95% 22.5), 282 of 600 frames over 16.7 ms, compile hitches up to 1.2-1.4 s.
- Conclusion: without the clang-built code the race runs at about half speed on this machine with long stalls: a release needs recomp.wasm built on the user's machine (clang + wasm-ld once at setup); the block compilers are only a fallback.

## Building recomp.wasm on the user's machine (recomp.mjs findClang / compileAll; launcher Setup -> "Game code")
- compileAll used xargs + sh (no Windows): now a Node pool in a child process (execFileSync(node -e pool), so build() stays synchronous), printing "[k/n] compiled" per unit (68 units for the full build) for the launcher's bar.
- findClang(): NT04_CLANG, tools/llvm/bin beside recomp.mjs, PATH, %ProgramFiles%\LLVM\bin, Homebrew llvm; needs the wasm32 target (-print-targets) and wasm-ld next to clang or on PATH; a clear message otherwise. All clang calls (wasm units + link, native links) use it.
- Inputs that ship (address lists, no code bytes): recomp-samples/-functions/-calls/-executed/-extra/-all/-hooks.json, x86_callee_pops.json. Outputs that don't: recomp.json, recomp.wasm(.gz), recomp-native-*.
- Test build from scratch here (clang 18.1.3, 2 cores): `node recomp.mjs --calls 369 --executed --all` -> 11748 functions, 127054 entries, same image hash; 937 s (clang 933 s); wasm 105,995,345 bytes (14.4 MB gzipped). Function order in the manifest differs from the old build (self-consistent with its wasm).
- Race bench in the plain extracted folder (_to_delete/xiso-ok, no roster add-ons): new build median 3.12 ms/frame, old build 3.15 ms; 0 frames over 16.7 ms after warm-up. Equivalent.
- Launcher: GET /api/status .recomp {exe, state ready|missing|other (manifest image vs sha256(default.exe)[0:16], cached by mtimes), compiler}; POST /api/recomp {} runs the build job, {check:true} looks for the compiler again.
- Observation to follow up: the same race in the main folder (user's roster, textures, track packs) ran at median 9.3 ms vs 3.1 ms in the plain folder: something in the user's set-up triples the per-frame game cost.
- Not checked yet: whether wasi-sdk publishes Windows/macOS packages (GitHub/PyPI not reachable from here); the LLVM Windows installer is the documented route for now.

## Release packages (make-release.mjs)
- `node make-release.mjs [--version V] [--platforms win-x64,macos-arm64,macos-x64,linux-x64] [--node vX] [--node-cache DIR] [--local-node]` -> release/NT04-Recomp-V-<platform>.zip (.tar.gz for Linux) + a list of the files shipped.
- File list: followed from launcher.mjs (static / dynamic / side-effect imports, new URL workers, join(here, "x") data files, Python "from x import"), plus EXTRA (v8-tuning.mjs, x86_callee_pops.json, kernel_imports.csv, xbe_symbols.json, recomp-native.c, relay.mjs, read_textures.py, nt04.config.example.json); run-time-created files (recomp.json, launcher-settings.json, roster.json...) skipped. Guards: DENY patterns (game files, recomp outputs, .wasm/.node/.dat..., player folders) and no file over 4 MB. Result: 101 files, 2.4 MB.
- Node: same version as the one running the script, from nodejs.org, SHA-256 checked against SHASUMS256.txt, cached in release/cache; only node(.exe) + LICENSE are taken. Zip / tar.gz writers and readers written here (no packages); unix modes kept (runtime/node, Launch.command, launch.sh 0755).
- Start files: Launch.bat (runtime\node.exe), Launch.command (macOS), launch.sh (Linux); README.txt with the set-up steps.
- Tested (Linux VM, no network: --local-node): the linux-x64 package (43.6 MB) unpacked into a clean folder; its launch.sh starts the launcher with the bundled Node; Setup -> Extract from the user's ISO (made default.exe); with a from-scratch recomp.wasm dropped in the launcher reports "ready"; boot + bot race from the package: lap 1, median 5.5 ms/frame, 0 frames over 16.7 ms. (The very first boot of an empty save folder stops the bench's fixed key sequence at the first-run prompts; the second boot races.) Zip / tar round trips checked with unzip, tar and Python's zipfile.
- Not tested here: the Windows and macOS packages (nodejs.org is blocked from this environment); run the script on a machine with internet.

## The "3x slower in the main folder" race was the test machine, not the set-up (re-measured)
- Same bench, main folder (user's roster, textures, track packs): median 3.5 / 3.9 / 3.3 ms per frame in three runs today; empty preset (NT04_USER = empty folder) 4.8 ms; plain extracted folder 3.1 ms. Yesterday's 9.3 ms (and the 16.5 ms without recomp) were measured during a slow stretch of the VM: nothing in the user's set-up costs measurable time.
- Without recomp.wasm, re-measured: warm block-compiler disk cache (jit-cache) median 6.5 ms, 6 of 600 frames over 16.7 ms, worst 44 ms; empty cache (a new player) median 6.8 ms, 34 of 600 over, pauses up to 0.7 s, menus to race 45 s. With recomp.wasm: median ~3.5 ms, none over.
- So recomp.wasm is still what a player should build (no pauses, half the CPU), but without it the game is playable once its cache is warm. The launcher card, Help and the release README now say this instead of "half speed".
- Bench note: the first boot of an empty save folder stops the fixed key sequence at the first-run prompts; compare runs that report "in race: true" (and the same lap/speed, as race state changes the cost: "lap 1 speed 217" runs are a later point of the race).

## Release packages include the C compiler (user picked "Option A")
- make-release.mjs bundles clang + wasm-ld per platform from wasi-sdk (github.com/WebAssembly/wasi-sdk releases, wasi-sdk-<V>.0-<arch>-<os>.tar.gz; --wasi-sdk 25 default; win-arm64 uses the x86_64-windows build) into NT04-Recomp/tools/llvm/bin, where recomp.mjs findClang() already looks. Links in the archive (clang -> clang-NN, wasm-ld -> lld, Windows hard links) are resolved to the real files; also bin/*.dll and lib/*.so*/*.dylib beside them if the build has any; licence files (required) and SOURCE.txt (archive name + SHA-256).
- Trust: first download's SHA-256 pinned in release/cache/pins.json; a changed file is refused. A platform whose compiler cannot be included is NOT made (exit code 1) unless --no-clang. --clang-archive plat=FILE for archives on disk.
- recomp.mjs: the generated C no longer includes <stdint.h> (typedefs from __INT*_TYPE__ macros) and the wasm build uses -nostdinc, so the bundled toolchain needs no headers or clang resource folder. Checked: --top 100 build compiles with -nostdinc (clang 18).
- findClang(): a tools/llvm clang that exists but cannot start gets its own message (macOS: allow it under Privacy & Security; Windows: antivirus); README (mac) says the same.
- Tested with stand-in archives laid out like wasi-sdk (Linux symlinks, Windows hard links, an extra clangd, a .dll): win-x64 zip and linux-x64 tar.gz contain byte-identical clang/wasm-ld at 0755, .dll, LICENSE, SOURCE.txt; clangd left out; pin mismatch refuses the package.
- NOT tested here (downloads blocked): the real wasi-sdk archives (names for this version, whether their clang runs standalone on each OS, the real size: expect tens of MB per platform). First real run: on the user's PC.

## Bundling wasi-sdk for real (first run on the user's PC: "no licence file found")
- wasi-sdk 25 archives (names wasi-sdk-25.0-{x86_64-windows,x86_64-linux,arm64-macos,x86_64-macos}.tar.gz, 104-520 MB) carry NO licence files (7187 entries; VERSION says llvm-version 19.1.5). make-release.mjs now fetches llvm/, clang/ and lld/LICENSE.TXT from llvm-project at tag llvmorg-<version> (raw.githubusercontent.com), caches and pins them, ships them as tools/llvm/LICENSE-{llvm,clang,lld}.txt.
- The archive is read as a stream (scanTarGz: names/links of all entries, data only for wanted ones): the 520 MB Windows archive is >2 GB unpacked. 27 s on the VM.
- Windows: clang.exe 58 MB + wasm-ld.exe 26 MB, self-contained (no DLLs) -> win-x64 zip 70.8 MB. Linux and macOS: clang-19 / lld are small and load lib/libLLVM + lib/libclang-cpp (.so.19.1-wasi-sdk / .dylib). libNeeds() reads ELF DT_NEEDED / Mach-O LC_LOAD_DYLIB, follows links in the archive, ships each library under the name asked for (zips hold no links): linux 85.7 MB, macos-arm64 71.9 MB.
- Linux package tested for real: bundled clang/wasm-ld run from the unpacked package with PATH empty of compilers; findClang() picks tools/llvm.
## LLVM 19 aborts on the generated code (found by building with the bundled compiler)
- "fatal error: error in backend: Do not know how to split this operator's operand!" in F_f1db0, at every -O level. Reduced (delete-a-line reducer, _to_delete/crash/reduce.py) to two constructs, both inline asm with a 128-bit operand: BAR(x) (`"+r"` on a u4, SSE logic ops) and the f32x4 SWOP/ORDOP helpers (add_4/mul_4/sub_4/div_4: "local.get ... f32x4.add" with "r" operands). Every vector type crashes in LLVM 19.1.5; LLVM 18.1.3 accepts them.
- Fix: VBAR(x) = asm volatile("" : "+m"(x)) for vectors (as the native build's BAR); f32x4 helpers lane by lane through the scalar f32 helpers unless RC_VASM. recomp.mjs vectorAsm() compiles a probe once per build: LLVM 18 -> -DRC_VASM (vector instructions as before), LLVM 19 -> lane by lane (same result per lane). Native builds always define RC_VASM (x86 SSE asm).
- --top 100 build now compiles with the bundled LLVM 19.
- Full build with the bundled wasi-sdk 25 clang (LLVM 19.1.5, Linux build run in the container): 11748 functions, 127054 entries, clang 847 s, wasm 106,030,587 bytes; vectorAsm() false (lane by lane).
- Race bench, plain extracted folder, same session, alternating: original LLVM 18 build (vector asm) median 3.10 ms/frame; bundled LLVM 19 build (lane by lane) 2.78 / 2.82 ms; 0 frames over 16.7 ms for both. The fallback costs nothing measurable (slightly faster).
- Still untested here: fetching the three LICENSE.TXT files (GitHub raw blocked in this environment; the user's PC reaches GitHub), and running the bundled Windows / macOS compilers.

## Release layout: start file on top, everything else in app/ (user request)
- Packages: NT04-Recomp/{Launch.bat | Launch.command | launch.sh, README.txt, app/}; app/ holds the framework, runtime/node, tools/llvm. Start files cd into app and run app's node (Launch.bat: cd /d "%~dp0app" + "%~dp0app\runtime\node.exe" launcher.mjs). The launcher's own folder is app/, so Data, default.xbe/exe, recomp.wasm, save/, roster/, presets/ also live there. README explains where things are and that extracting a newer version over the folder keeps the player's files in app/.
- Tested with stand-in archives: win zip top level = Launch.bat, README.txt, app (108 files in app/); Linux package started through launch.sh from another directory: launcher home = app/ (Data path app/Data), compiler looked up in app/tools/llvm.
