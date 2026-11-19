# NT04 Recomp

A static recompilation of **EA SPORTS NASCAR Thunder 2004** (original Xbox) that runs the game on Windows, macOS and
Linux through Node.js and your web browser, with a launcher for setting up rosters, teams, sponsors, tracks, schedules
and careers.

> **You need your own copy of the game.** This repository contains no game files and none of the game's code. The
> game's executable and data come from a disc image (`.iso` / `.xiso`) of a copy you own; the recompiled code is built
> from it on your own computer.

NASCAR Thunder 2004 is a trademark of its owners. This project is not affiliated with or endorsed by Electronic Arts,
NASCAR or Microsoft.

## Playing

1. Download the package for your system from [Releases](../../releases) and extract it anywhere.
   Node.js and the C compiler are included: nothing to install.
2. Start **Launch.bat** (Windows), **Launch.command** (macOS) or **launch.sh** (Linux). The launcher opens in your browser.
3. **Setup tab → Game files:** paste the path of your disc image and press **Extract**.
4. **Setup tab → Game code:** press **Build game code** (5–15 minutes, once).
5. **Play tab → Start game.**

The launcher's **Help** tab covers everything else: controls, graphics options, presets, and all the editors.

## What it adds

- **Roster:** add drivers (portraits, ratings, numbers, paint schemes, pit signs, crew uniforms), take out the
  game's drivers, add or rename teams, add Busch and fill-in drivers.
- **Career:** a configurable silly season covering retirements, folding and returning teams, team prestige and
  contracts, the driver market, Busch call-ups, sponsors changing teams, rookie prospects and ratings that change
  with age.
- **Sponsors:** your own sponsors in the game's sponsor list (Create-A-Car, Sign Sponsors), and paint schemes without
  numbers for career teams.
- **Tracks:** track packs from glTF models, NASCAR Racing 2003 track conversion, an object library, and a schedule
  editor.
- **Presets:** separate set-ups and saves you can switch between.
- **Also:** unlock everything, online races, a live leaderboard, steering wheel support, render scale /
  antialiasing / texture filtering, and AI picture upscaling.

## How it works

The game's x86 code is translated to C and compiled to WebAssembly (`recomp.mjs`, using clang). It runs on a
re-implementation of the parts of the Xbox the game needs:

| Area | Files |
|---|---|
| Kernel, threads, file system | `gamecode.mjs`, `xbox-threads.mjs`, `xbox-fs.mjs` |
| Graphics: Direct3D to WebGL | `d3d-hle.mjs`, `nv2a-vsh.mjs`, `gl-remote.mjs` |
| Sound: DirectSound to Web Audio | `dsound-hle.mjs`, `audio-mix.mjs` |
| Input | `xinput-hle.mjs` |
| The game's menu engine | `uis-vm.mjs`, `uis-render.mjs` |
| CPU fallback when nothing is recompiled | interpreter `x86emu.mjs`, translators `x86-jit.mjs` and `wasm-jit.mjs` |

Setup from a disc image:

- `xiso.mjs` reads the XDVDFS image.
- `xbe2pe.mjs` turns `default.xbe` into the PE image the code runs from.
- `recomp.mjs` builds `recomp.wasm` for that exact executable.

`docs/analysis_notes.md` is the running record of the reverse engineering: memory layouts, functions, the database,
the bugs found along the way. `docs/research/` holds analysis tables (stages, components, UI natives).

## Developing

You need [Node.js](https://nodejs.org) 22 or newer, and for building the game code, LLVM's clang with the WebAssembly
target and `wasm-ld` (any LLVM 18 or newer). There are no npm packages.

```sh
node xiso.mjs extract "path/to/NASCAR Thunder 2004.iso" .   # Data/, default.xbe and default.exe here
node recomp.mjs --calls 369 --executed --all                 # recomp.wasm + recomp.json for this default.exe
node launcher.mjs                                            # the launcher, at http://localhost:8800
```

Optional: Python 3 with numpy and pillow for picture upscaling (`upscale_textures.py`; AI models also need PyTorch
and spandrel).

### Release packages

```sh
node make-release.mjs                 # release/NT04-Recomp-<date>-<platform>.zip / .tar.gz
```

`make-release.mjs` does the following:

- Collects the files the launcher reaches by following the code from `launcher.mjs`.
- Refuses anything from the game, or built from it.
- Adds the official Node.js build for each platform, checked against nodejs.org's checksums.
- Adds clang and wasm-ld from [wasi-sdk](https://github.com/WebAssembly/wasi-sdk), with LLVM's licence texts.

Downloads are cached and pinned in `release/cache`. Packages have only the start file and `README.txt` at the top,
with everything else in `app/`.

### Data files in this repository

The recompile's function lists (`recomp-*.json`), `x86_callee_pops.json`, `kernel_imports.csv` and `xbe_symbols.json`
are tables of addresses and names found by analysing the executable. They contain no code or data from the game.

## Credits

- [Node.js](https://nodejs.org) (MIT), bundled in release packages.
- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) / [LLVM](https://llvm.org) (Apache-2.0 WITH LLVM-exception):
  clang and wasm-ld, bundled in release packages.
- [XbSymbolDatabase](https://github.com/Cxbx-Reloaded/XbSymbolDatabase) (MIT): used to identify the XDK library
  functions (`xbe_symbols.json`).
- [nxdk](https://github.com/XboxDev/nxdk) (CC0-1.0): the Xbox kernel export names (`xbe2pe.mjs`).

## Licence

The code in this repository is released under the [MIT Licence](LICENSE). It does not cover NASCAR Thunder 2004 or
any of its files.
