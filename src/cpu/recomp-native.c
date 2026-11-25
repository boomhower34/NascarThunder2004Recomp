/* recomp-native.c — Node add-on glue for a native build of the recompiled game code (recomp.mjs --native).
 *
 * The recompiled C (recomp.mjs) is compiled for the machine itself instead of WebAssembly and linked with this file
 * into recomp-native-<platform>-<arch>.node. It runs on the very same memory: the WebAssembly memory of the emulator
 * (wasm-jit.mjs MEM_PAGES), whose bytes the add-on gets once (init) and addresses as MB + guest address, exactly as the
 * WebAssembly build addresses its linear memory. Everything JavaScript shares with the recompiled code (CPU context,
 * page flags, the block map, enable bytes, the D3D state block) therefore stays where it is.
 *
 * JavaScript calls: init(memory buffer, imports, layout), entries(), setEntry(slot, entry number), clear(),
 * run(eip, budget) — the dispatcher loop of wasm-jit.mjs dispatcher(), natively — and nstate().
 * The recompiled code calls JavaScript for its imports (r8 … w32 slow memory paths, hook, fm, cvt, divzero, note),
 * as the WebAssembly build does. A JavaScript exception thrown inside an import (a divide error, a hook's error) leaves
 * the native code by longjmp to the run() it happened under and is rethrown to JavaScript from there.
 *
 * No C library and no Node import library: the N-API functions are found in the host process at load time
 * (Windows: GetProcAddress on the executable; elsewhere: the dynamic linker resolves them from node itself).
 */
#include <stdint.h>
#include <stddef.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_ref__ *napi_ref;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);

#define NAPI_LIST(X) \
  X(napi_get_cb_info, (napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**)) \
  X(napi_create_function, (napi_env, const char*, size_t, napi_callback, void*, napi_value*)) \
  X(napi_set_named_property, (napi_env, napi_value, const char*, napi_value)) \
  X(napi_get_named_property, (napi_env, napi_value, const char*, napi_value*)) \
  X(napi_get_value_uint32, (napi_env, napi_value, uint32_t*)) \
  X(napi_get_value_int32, (napi_env, napi_value, int32_t*)) \
  X(napi_get_value_double, (napi_env, napi_value, double*)) \
  X(napi_create_uint32, (napi_env, uint32_t, napi_value*)) \
  X(napi_create_int32, (napi_env, int32_t, napi_value*)) \
  X(napi_create_double, (napi_env, double, napi_value*)) \
  X(napi_get_arraybuffer_info, (napi_env, napi_value, void**, size_t*)) \
  X(napi_create_reference, (napi_env, napi_value, uint32_t, napi_ref*)) \
  X(napi_get_reference_value, (napi_env, napi_ref, napi_value*)) \
  X(napi_call_function, (napi_env, napi_value, napi_value, size_t, const napi_value*, napi_value*)) \
  X(napi_get_undefined, (napi_env, napi_value*)) \
  X(napi_is_exception_pending, (napi_env, _Bool*)) \
  X(napi_throw_error, (napi_env, const char*, const char*))

#ifdef _WIN32
/* resolved from node.exe (or the executable that embeds Node) when the module registers */
#define DECL(n, args) static napi_status (*n) args;
NAPI_LIST(DECL)
__declspec(dllimport) void *__stdcall GetModuleHandleA(const char*);
__declspec(dllimport) void *__stdcall GetProcAddress(void*, const char*);
static int resolveNapi(void) {
  void *h = GetModuleHandleA(0); if (!h) return 0;
#define RES(n, args) n = (napi_status (*) args)GetProcAddress(h, #n); if (!n) { void *h2 = GetModuleHandleA("node.dll"); if (h2) n = (napi_status (*) args)GetProcAddress(h2, #n); } if (!n) return 0;
  NAPI_LIST(RES)
  return 1; }
#define EXPORT __declspec(dllexport)
int _fltused = 0;                                    /* (the compiler's marker that floating point is used) */
/* stack probe for frames over a page (the large recompiled functions): touch each page down to the new stack top */
__asm__(".globl __chkstk\n__chkstk:\n"
  "  pushq %rcx\n  pushq %rax\n  leaq 24(%rsp), %rcx\n"
  "1: cmpq $0x1000, %rax\n  jb 2f\n  subq $0x1000, %rcx\n  orq $0, (%rcx)\n  subq $0x1000, %rax\n  jmp 1b\n"
  "2: subq %rax, %rcx\n  orq $0, (%rcx)\n  popq %rax\n  popq %rcx\n  ret\n");
#else
#define DECL(n, args) extern napi_status n args;
NAPI_LIST(DECL)
static int resolveNapi(void) { return 1; }
#define EXPORT __attribute__((visibility("default")))
#endif

/* --- what the recompiled code (recomp.mjs native prelude) expects from here */
uintptr_t MB;                                        /* the emulator memory's bytes: guest address a is at MB + a */
uint32_t (*imp_r8)(uint32_t); uint32_t (*imp_r16)(uint32_t); uint32_t (*imp_r32)(uint32_t);
void (*imp_w8)(uint32_t, uint32_t); void (*imp_w16)(uint32_t, uint32_t); void (*imp_w32)(uint32_t, uint32_t);
void (*imp_divzero)(uint32_t); uint32_t (*imp_hook)(uint32_t, uint32_t); double (*imp_fm)(uint32_t, double, double);
uint32_t (*imp_cvt)(float); void (*imp_note)(uint32_t, uint32_t);
extern uint32_t rc_entry_count(void);
typedef uint32_t (*efn_t)(void);
extern efn_t rc_entry(uint32_t k);
extern uint32_t nstate(void);

/* compilers may emit calls to these even in freestanding code */
#if defined(__clang__)
#pragma clang optimize off
#endif
void *memcpy(void *d, const void *s, size_t n) { uint8_t *a = d; const uint8_t *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, size_t n) { uint8_t *a = d; const uint8_t *b = s; if (a < b) while (n--) *a++ = *b++; else { a += n; b += n; while (n--) *--a = *--b; } return d; }
void *memset(void *d, int c, size_t n) { uint8_t *a = d; while (n--) *a++ = (uint8_t)c; return d; }
int memcmp(const void *x, const void *y, size_t n) { const uint8_t *a = x, *b = y; for (; n--; a++, b++) if (*a != *b) return *a - *b; return 0; }
#if defined(__clang__)
#pragma clang optimize on
#endif

/* --- calls into JavaScript */
static napi_env E;                                   /* the env of the innermost run() */
static napi_ref R_imp[11];                           /* r8 r16 r32 w8 w16 w32 divzero hook fm cvt note */
typedef struct Frame { void *jb[5]; struct Frame *up; napi_env env; } Frame;
static Frame *TOP;                                   /* innermost run(): where an exception in an import goes */
static void bail(void) { if (TOP) __builtin_longjmp(TOP->jb, 1); }
static napi_value callJs(int k, size_t argc, napi_value *argv) {
  napi_value f, u, r = 0; napi_get_reference_value(E, R_imp[k], &f); napi_get_undefined(E, &u);
  if (napi_call_function(E, u, f, argc, argv, &r) != 0) bail();
  _Bool p = 0; napi_is_exception_pending(E, &p); if (p) bail();
  return r; }
static napi_value U32(uint32_t v) { napi_value x; napi_create_uint32(E, v, &x); return x; }
static napi_value F64(double v) { napi_value x; napi_create_double(E, v, &x); return x; }
static uint32_t toU32(napi_value v) { uint32_t x = 0; if (v) napi_get_value_uint32(E, v, &x); return x; }
static double toF64(napi_value v) { double x = 0; if (v) napi_get_value_double(E, v, &x); return x; }
static uint32_t j_r8(uint32_t a) { napi_value v[1] = { U32(a) }; return toU32(callJs(0, 1, v)); }
static uint32_t j_r16(uint32_t a) { napi_value v[1] = { U32(a) }; return toU32(callJs(1, 1, v)); }
static uint32_t j_r32(uint32_t a) { napi_value v[1] = { U32(a) }; return toU32(callJs(2, 1, v)); }
static void j_w8(uint32_t a, uint32_t x) { napi_value v[2] = { U32(a), U32(x) }; callJs(3, 2, v); }
static void j_w16(uint32_t a, uint32_t x) { napi_value v[2] = { U32(a), U32(x) }; callJs(4, 2, v); }
static void j_w32(uint32_t a, uint32_t x) { napi_value v[2] = { U32(a), U32(x) }; callJs(5, 2, v); }
static void j_divzero(uint32_t pc) { napi_value v[1] = { U32(pc) }; callJs(6, 1, v); }
static uint32_t j_hook(uint32_t t, uint32_t cnt) { napi_value v[2] = { U32(t), U32(cnt) }; return toU32(callJs(7, 2, v)); }
static double j_fm(uint32_t k, double a, double b) { napi_value v[3] = { U32(k), F64(a), F64(b) }; return toF64(callJs(8, 3, v)); }
static uint32_t j_cvt(float x) { napi_value v[1] = { F64((double)x) }; return toU32(callJs(9, 1, v)); }
static void j_note(uint32_t k, uint32_t t) { napi_value v[2] = { U32(k), U32(t) }; callJs(10, 2, v); }

/* --- the dispatcher (wasm-jit.mjs dispatcher(), the same loop): MAP[eip] -> slot, NTAB[slot] = its first block */
static uint32_t L_map, L_ntab, L_span, L_ctx, L_slots;
static efn_t *SLOT;                                  /* slot -> native entry (null: not native) */
static efn_t SLOTS[1 << 20];
static napi_value args(napi_env env, napi_callback_info info, size_t n, napi_value *a) { size_t k = n; napi_get_cb_info(env, info, &k, a, 0, 0); return 0; }
static napi_value retU(napi_env env, uint32_t v) { napi_value x; napi_create_uint32(env, v, &x); return x; }
static napi_value n_run(napi_env env, napi_callback_info info) {
  napi_value a[2]; args(env, info, 2, a); uint32_t eip = 0, rem = 0; napi_get_value_uint32(env, a[0], &eip); napi_get_value_uint32(env, a[1], &rem);
  Frame fr; fr.up = TOP; fr.env = E; TOP = &fr; E = env;
  volatile uint32_t *ctx = (volatile uint32_t*)(MB + L_ctx); const uint32_t *map = (const uint32_t*)(MB + L_map); const uint8_t *ntab = (const uint8_t*)(MB + L_ntab);
  if (__builtin_setjmp(fr.jb)) { TOP = fr.up; E = fr.env; return 0; }   /* an import threw: the exception is pending */
  ctx[56 / 4] = 0; uint32_t tot = 0;
  for (;;) {
    if (eip >= L_span) break;
    uint32_t idx = map[eip]; if (!idx || idx >= L_slots) break;
    efn_t f = SLOT[idx]; if (!f || ntab[idx] > rem) break;
    ctx[40 / 4] = tot; ctx[0x1c0 / 4] = rem;
    eip = f();
    uint32_t n = ctx[36 / 4]; tot += n; rem -= n;
    if (ctx[56 / 4]) break;
  }
  ctx[40 / 4] = tot;
  TOP = fr.up; E = fr.env;
  return retU(env, eip); }
static napi_value n_init(napi_env env, napi_callback_info info) {
  napi_value a[3]; args(env, info, 3, a); void *data = 0; size_t len = 0;
  if (napi_get_arraybuffer_info(env, a[0], &data, &len) != 0 || !data) { napi_throw_error(env, 0, "recomp-native: no memory"); return 0; }
  MB = (uintptr_t)data;
  static const char *names[11] = { "r8", "r16", "r32", "w8", "w16", "w32", "divzero", "hook", "fm", "cvt", "note" };
  for (int k = 0; k < 11; k++) { napi_value f; napi_get_named_property(env, a[1], names[k], &f); napi_create_reference(env, f, 1, &R_imp[k]); }
  napi_value v; const char *lay[5] = { "map", "ntab", "span", "ctx", "slots" }; uint32_t *dst[5] = { &L_map, &L_ntab, &L_span, &L_ctx, &L_slots };
  for (int k = 0; k < 5; k++) { napi_get_named_property(env, a[2], lay[k], &v); napi_get_value_uint32(env, v, dst[k]); }
  if (L_slots > (1u << 20)) L_slots = 1u << 20;
  SLOT = SLOTS;
  imp_r8 = j_r8; imp_r16 = j_r16; imp_r32 = j_r32; imp_w8 = j_w8; imp_w16 = j_w16; imp_w32 = j_w32;
  imp_divzero = j_divzero; imp_hook = j_hook; imp_fm = j_fm; imp_cvt = j_cvt; imp_note = j_note;
  return retU(env, (uint32_t)len >> 16); }
static napi_value n_entries(napi_env env, napi_callback_info info) { (void)info; return retU(env, rc_entry_count()); }
static napi_value n_setEntry(napi_env env, napi_callback_info info) {
  napi_value a[2]; args(env, info, 2, a); uint32_t s = 0, k = 0; napi_get_value_uint32(env, a[0], &s); napi_get_value_uint32(env, a[1], &k);
  if (s < L_slots && k < rc_entry_count()) SLOT[s] = rc_entry(k); return 0; }
static napi_value n_clear(napi_env env, napi_callback_info info) { (void)env; (void)info; for (uint32_t i = 0; i < L_slots; i++) SLOT[i] = 0; return 0; }
static napi_value n_nstate(napi_env env, napi_callback_info info) { (void)info; return retU(env, nstate()); }

EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  if (!resolveNapi()) return exports;
  struct { const char *n; napi_callback f; } fs[] = { { "init", n_init }, { "run", n_run }, { "entries", n_entries }, { "setEntry", n_setEntry }, { "clear", n_clear }, { "nstate", n_nstate } };
  for (unsigned i = 0; i < sizeof fs / sizeof fs[0]; i++) { napi_value f; napi_create_function(env, fs[i].n, (size_t)-1, fs[i].f, 0, &f); napi_set_named_property(env, exports, fs[i].n, f); }
  return exports; }
#ifndef _WIN32
/* node_module_version-independent registration (N-API): Node looks the symbol up by name */
#endif
