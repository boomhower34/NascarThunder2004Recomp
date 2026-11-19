// v8-tuning.mjs — V8 settings for the emulator, applied at startup (import this module first).
//
// The recompiled game runs as thousands of small JS functions (x86-jit.mjs blocks), many entered a few hundred
// times per frame. With V8's default thresholds (TurboFan after ~3000 calls, and again 500 calls after any
// inline-cache change) a large share of them stayed in the baseline tier; lowering them gave ~22% less CPU per race
// frame (cpu ms/frame median 38.9 -> 30.1; more aggressive values were not better). NT04_V8_DEFAULTS=1 keeps V8's.
import v8 from "node:v8";
if (!process.env.NT04_V8_DEFAULTS) v8.setFlagsFromString("--invocation-count-for-turbofan=600 --minimum-invocations-after-ic-update=100");
