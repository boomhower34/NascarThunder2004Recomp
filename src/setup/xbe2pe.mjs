// xbe2pe.mjs — repackage an original Xbox executable (default.xbe) as a 32-bit PE (default.exe): the image the
// recompiled code, gamecode.mjs and the analysis tools load. A JavaScript port of xbe2pe.py (same output, byte for
// byte), so setting up the game from the user's own disc needs no Python. The output is not runnable on Windows.
//
//   * Every XBE section stays at its virtual address (image base = XBE base, normally 0x10000); the file is a flat
//     image (raw data at file offset == RVA).
//   * The entry point and kernel thunk address are decoded (retail or debug XOR keys).
//   * The kernel thunk table becomes a PE import table from "xboxkrnl.exe" by name (nxdk export list, CC0-1.0); as
//     in an unbound PE the thunk slots hold pointers to the names (the XBE holds ordinals there).
//   * The PE TLS directory points at the XBE TLS structure (same layout).
//   * The XBE header stays in place (the game reads it at run time); the PE headers go after it, or, without room,
//     at 0x40 with a copy of the header in an extra section ".xbeh".
//
//   node xbe2pe.mjs default.xbe default.exe [--labels kernel_imports.csv] [--ordinals] [--subsystem N]
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_KEYS = { retail: 0xa8fc57ab, debug: 0x94859d4b }, THUNK_KEYS = { retail: 0x5b6d40b6, debug: 0xefb1f152 };
const XBE_SEC_WRITABLE = 0x1, XBE_SEC_EXECUTABLE = 0x4;
const PE_SCN_CNT_CODE = 0x20, PE_SCN_CNT_INIT = 0x40, PE_SCN_CNT_UNINIT = 0x80, PE_SCN_MEM_EXEC = 0x20000000, PE_SCN_MEM_READ = 0x40000000, PE_SCN_MEM_WRITE = 0x80000000;
const OPT_HDR_SIZE = 224;

// Xbox kernel exports: [ordinal, name, stdcall argument bytes (null: varargs / data), data export]
const KERNEL_LIST = [
  [1,"AvGetSavedDataAddress",0,0], [2,"AvSendTVEncoderOption",16,0], [3,"AvSetDisplayMode",24,0],
  [4,"AvSetSavedDataAddress",4,0], [5,"DbgBreakPoint",0,0], [6,"DbgBreakPointWithStatus",4,0],
  [7,"DbgLoadImageSymbols",12,0], [8,"DbgPrint",null,0], [9,"HalReadSMCTrayState",8,0], [10,"DbgPrompt",12,0],
  [11,"DbgUnLoadImageSymbols",12,0], [12,"ExAcquireReadWriteLockExclusive",4,0],
  [13,"ExAcquireReadWriteLockShared",4,0], [14,"ExAllocatePool",4,0], [15,"ExAllocatePoolWithTag",8,0],
  [16,"ExEventObjectType",null,1], [17,"ExFreePool",4,0], [18,"ExInitializeReadWriteLock",4,0],
  [19,"ExInterlockedAddLargeInteger",16,0], [20,"@ExInterlockedAddLargeStatistic",8,0],
  [21,"@ExInterlockedCompareExchange64",12,0], [22,"ExMutantObjectType",null,1], [23,"ExQueryPoolBlockSize",4,0],
  [24,"ExQueryNonVolatileSetting",20,0], [25,"ExReadWriteRefurbInfo",12,0], [26,"ExRaiseException",4,0],
  [27,"ExRaiseStatus",4,0], [28,"ExReleaseReadWriteLock",4,0], [29,"ExSaveNonVolatileSetting",16,0],
  [30,"ExSemaphoreObjectType",null,1], [31,"ExTimerObjectType",null,1], [32,"@ExfInterlockedInsertHeadList",8,0],
  [33,"@ExfInterlockedInsertTailList",8,0], [34,"@ExfInterlockedRemoveHeadList",4,0], [35,"FscGetCacheSize",0,0],
  [36,"FscInvalidateIdleBlocks",0,0], [37,"FscSetCacheSize",4,0], [38,"@HalClearSoftwareInterrupt",4,0],
  [39,"HalDisableSystemInterrupt",4,0], [40,"HalDiskCachePartitionCount",null,1], [41,"HalDiskModelNumber",null,1],
  [42,"HalDiskSerialNumber",null,1], [43,"HalEnableSystemInterrupt",8,0], [44,"HalGetInterruptVector",8,0],
  [45,"HalReadSMBusValue",16,0], [46,"HalReadWritePCISpace",24,0], [47,"HalRegisterShutdownNotification",8,0],
  [48,"@HalRequestSoftwareInterrupt",4,0], [49,"HalReturnToFirmware",4,0], [50,"HalWriteSMBusValue",16,0],
  [51,"@InterlockedCompareExchange",12,0], [52,"@InterlockedDecrement",4,0], [53,"@InterlockedIncrement",4,0],
  [54,"@InterlockedExchange",8,0], [55,"@InterlockedExchangeAdd",8,0], [56,"@InterlockedFlushSList",4,0],
  [57,"@InterlockedPopEntrySList",4,0], [58,"@InterlockedPushEntrySList",8,0], [59,"IoAllocateIrp",4,0],
  [60,"IoBuildAsynchronousFsdRequest",24,0], [61,"IoBuildDeviceIoControlRequest",36,0],
  [62,"IoBuildSynchronousFsdRequest",28,0], [63,"IoCheckShareAccess",20,0], [64,"IoCompletionObjectType",null,1],
  [65,"IoCreateDevice",24,0], [66,"IoCreateFile",40,0], [67,"IoCreateSymbolicLink",8,0], [68,"IoDeleteDevice",4,0],
  [69,"IoDeleteSymbolicLink",4,0], [70,"IoDeviceObjectType",null,1], [71,"IoFileObjectType",null,1],
  [72,"IoFreeIrp",4,0], [73,"IoInitializeIrp",12,0], [74,"IoInvalidDeviceRequest",8,0],
  [75,"IoQueryFileInformation",20,0], [76,"IoQueryVolumeInformation",20,0], [77,"IoQueueThreadIrp",4,0],
  [78,"IoRemoveShareAccess",8,0], [79,"IoSetIoCompletion",20,0], [80,"IoSetShareAccess",16,0],
  [81,"IoStartNextPacket",4,0], [82,"IoStartNextPacketByKey",8,0], [83,"IoStartPacket",12,0],
  [84,"IoSynchronousDeviceIoControlRequest",32,0], [85,"IoSynchronousFsdRequest",20,0], [86,"@IofCallDriver",8,0],
  [87,"@IofCompleteRequest",8,0], [88,"KdDebuggerEnabled",null,1], [89,"KdDebuggerNotPresent",null,1],
  [90,"IoDismountVolume",4,0], [91,"IoDismountVolumeByName",4,0], [92,"KeAlertResumeThread",4,0],
  [93,"KeAlertThread",8,0], [94,"KeBoostPriorityThread",8,0], [95,"KeBugCheck",4,0], [96,"KeBugCheckEx",20,0],
  [97,"KeCancelTimer",4,0], [98,"KeConnectInterrupt",4,0], [99,"KeDelayExecutionThread",12,0],
  [100,"KeDisconnectInterrupt",4,0], [101,"KeEnterCriticalRegion",0,0], [102,"MmGlobalData",null,1],
  [103,"KeGetCurrentIrql",0,0], [104,"KeGetCurrentThread",0,0], [105,"KeInitializeApc",28,0],
  [106,"KeInitializeDeviceQueue",4,0], [107,"KeInitializeDpc",12,0], [108,"KeInitializeEvent",12,0],
  [109,"KeInitializeInterrupt",28,0], [110,"KeInitializeMutant",8,0], [111,"KeInitializeQueue",8,0],
  [112,"KeInitializeSemaphore",12,0], [113,"KeInitializeTimerEx",8,0], [114,"KeInsertByKeyDeviceQueue",12,0],
  [115,"KeInsertDeviceQueue",8,0], [116,"KeInsertHeadQueue",8,0], [117,"KeInsertQueue",8,0],
  [118,"KeInsertQueueApc",16,0], [119,"KeInsertQueueDpc",12,0], [120,"KeInterruptTime",null,1],
  [121,"KeIsExecutingDpc",0,0], [122,"KeLeaveCriticalRegion",0,0], [123,"KePulseEvent",12,0],
  [124,"KeQueryBasePriorityThread",4,0], [125,"KeQueryInterruptTime",0,0], [126,"KeQueryPerformanceCounter",0,0],
  [127,"KeQueryPerformanceFrequency",0,0], [128,"KeQuerySystemTime",4,0], [129,"KeRaiseIrqlToDpcLevel",0,0],
  [130,"KeRaiseIrqlToSynchLevel",0,0], [131,"KeReleaseMutant",16,0], [132,"KeReleaseSemaphore",16,0],
  [133,"KeRemoveByKeyDeviceQueue",8,0], [134,"KeRemoveDeviceQueue",4,0], [135,"KeRemoveEntryDeviceQueue",8,0],
  [136,"KeRemoveQueue",12,0], [137,"KeRemoveQueueDpc",4,0], [138,"KeResetEvent",4,0],
  [139,"KeRestoreFloatingPointState",4,0], [140,"KeResumeThread",4,0], [141,"KeRundownQueue",4,0],
  [142,"KeSaveFloatingPointState",4,0], [143,"KeSetBasePriorityThread",8,0], [144,"KeSetDisableBoostThread",8,0],
  [145,"KeSetEvent",12,0], [146,"KeSetEventBoostPriority",8,0], [147,"KeSetPriorityProcess",8,0],
  [148,"KeSetPriorityThread",8,0], [149,"KeSetTimer",16,0], [150,"KeSetTimerEx",20,0],
  [151,"KeStallExecutionProcessor",4,0], [152,"KeSuspendThread",4,0], [153,"KeSynchronizeExecution",12,0],
  [154,"KeSystemTime",null,1], [155,"KeTestAlertThread",4,0], [156,"KeTickCount",null,1],
  [157,"KeTimeIncrement",null,1], [158,"KeWaitForMultipleObjects",32,0], [159,"KeWaitForSingleObject",20,0],
  [160,"@KfRaiseIrql",4,0], [161,"@KfLowerIrql",4,0], [162,"KiBugCheckData",null,1],
  [163,"@KiUnlockDispatcherDatabase",4,0], [164,"LaunchDataPage",null,1], [165,"MmAllocateContiguousMemory",4,0],
  [166,"MmAllocateContiguousMemoryEx",20,0], [167,"MmAllocateSystemMemory",8,0], [168,"MmClaimGpuInstanceMemory",8,0],
  [169,"MmCreateKernelStack",8,0], [170,"MmDeleteKernelStack",8,0], [171,"MmFreeContiguousMemory",4,0],
  [172,"MmFreeSystemMemory",8,0], [173,"MmGetPhysicalAddress",4,0], [174,"MmIsAddressValid",4,0],
  [175,"MmLockUnlockBufferPages",12,0], [176,"MmLockUnlockPhysicalPage",8,0], [177,"MmMapIoSpace",12,0],
  [178,"MmPersistContiguousMemory",12,0], [179,"MmQueryAddressProtect",4,0], [180,"MmQueryAllocationSize",4,0],
  [181,"MmQueryStatistics",4,0], [182,"MmSetAddressProtect",12,0], [183,"MmUnmapIoSpace",8,0],
  [184,"NtAllocateVirtualMemory",20,0], [185,"NtCancelTimer",8,0], [186,"NtClearEvent",4,0], [187,"NtClose",4,0],
  [188,"NtCreateDirectoryObject",8,0], [189,"NtCreateEvent",16,0], [190,"NtCreateFile",36,0],
  [191,"NtCreateIoCompletion",16,0], [192,"NtCreateMutant",12,0], [193,"NtCreateSemaphore",16,0],
  [194,"NtCreateTimer",12,0], [195,"NtDeleteFile",4,0], [196,"NtDeviceIoControlFile",40,0],
  [197,"NtDuplicateObject",12,0], [198,"NtFlushBuffersFile",8,0], [199,"NtFreeVirtualMemory",12,0],
  [200,"NtFsControlFile",40,0], [201,"NtOpenDirectoryObject",8,0], [202,"NtOpenFile",24,0],
  [203,"NtOpenSymbolicLinkObject",8,0], [204,"NtProtectVirtualMemory",16,0], [205,"NtPulseEvent",8,0],
  [206,"NtQueueApcThread",20,0], [207,"NtQueryDirectoryFile",40,0], [208,"NtQueryDirectoryObject",24,0],
  [209,"NtQueryEvent",8,0], [210,"NtQueryFullAttributesFile",8,0], [211,"NtQueryInformationFile",20,0],
  [212,"NtQueryIoCompletion",8,0], [213,"NtQueryMutant",8,0], [214,"NtQuerySemaphore",8,0],
  [215,"NtQuerySymbolicLinkObject",12,0], [216,"NtQueryTimer",8,0], [217,"NtQueryVirtualMemory",8,0],
  [218,"NtQueryVolumeInformationFile",20,0], [219,"NtReadFile",32,0], [220,"NtReadFileScatter",32,0],
  [221,"NtReleaseMutant",8,0], [222,"NtReleaseSemaphore",12,0], [223,"NtRemoveIoCompletion",20,0],
  [224,"NtResumeThread",8,0], [225,"NtSetEvent",8,0], [226,"NtSetInformationFile",20,0],
  [227,"NtSetIoCompletion",20,0], [228,"NtSetSystemTime",8,0], [229,"NtSetTimerEx",32,0],
  [230,"NtSignalAndWaitForSingleObjectEx",20,0], [231,"NtSuspendThread",8,0], [232,"NtUserIoApcDispatcher",12,0],
  [233,"NtWaitForSingleObject",12,0], [234,"NtWaitForSingleObjectEx",16,0], [235,"NtWaitForMultipleObjectsEx",24,0],
  [236,"NtWriteFile",32,0], [237,"NtWriteFileGather",32,0], [238,"NtYieldExecution",0,0], [239,"ObCreateObject",16,0],
  [240,"ObDirectoryObjectType",null,1], [241,"ObInsertObject",16,0], [242,"ObMakeTemporaryObject",4,0],
  [243,"ObOpenObjectByName",16,0], [244,"ObOpenObjectByPointer",12,0], [245,"ObpObjectHandleTable",null,1],
  [246,"ObReferenceObjectByHandle",12,0], [247,"ObReferenceObjectByName",20,0], [248,"ObReferenceObjectByPointer",8,0],
  [249,"ObSymbolicLinkObjectType",null,1], [250,"@ObfDereferenceObject",4,0], [251,"@ObfReferenceObject",4,0],
  [252,"PhyGetLinkState",4,0], [253,"PhyInitialize",8,0], [254,"PsCreateSystemThread",20,0],
  [255,"PsCreateSystemThreadEx",40,0], [256,"PsQueryStatistics",4,0], [257,"PsSetCreateThreadNotifyRoutine",4,0],
  [258,"PsTerminateSystemThread",4,0], [259,"PsThreadObjectType",null,1], [260,"RtlAnsiStringToUnicodeString",12,0],
  [261,"RtlAppendStringToString",8,0], [262,"RtlAppendUnicodeStringToString",8,0],
  [263,"RtlAppendUnicodeToString",8,0], [264,"RtlAssert",16,0], [265,"RtlCaptureContext",4,0],
  [266,"RtlCaptureStackBackTrace",16,0], [267,"RtlCharToInteger",12,0], [268,"RtlCompareMemory",12,0],
  [269,"RtlCompareMemoryUlong",12,0], [270,"RtlCompareString",12,0], [271,"RtlCompareUnicodeString",12,0],
  [272,"RtlCopyString",8,0], [273,"RtlCopyUnicodeString",8,0], [274,"RtlCreateUnicodeString",8,0],
  [275,"RtlDowncaseUnicodeChar",4,0], [276,"RtlDowncaseUnicodeString",12,0], [277,"RtlEnterCriticalSection",4,0],
  [278,"RtlEnterCriticalSectionAndRegion",4,0], [279,"RtlEqualString",12,0], [280,"RtlEqualUnicodeString",12,0],
  [281,"RtlExtendedIntegerMultiply",12,0], [282,"RtlExtendedLargeIntegerDivide",16,0],
  [283,"RtlExtendedMagicDivide",20,0], [284,"RtlFillMemory",12,0], [285,"RtlFillMemoryUlong",12,0],
  [286,"RtlFreeAnsiString",4,0], [287,"RtlFreeUnicodeString",4,0], [288,"RtlGetCallersAddress",8,0],
  [289,"RtlInitAnsiString",8,0], [290,"RtlInitUnicodeString",8,0], [291,"RtlInitializeCriticalSection",4,0],
  [292,"RtlIntegerToChar",16,0], [293,"RtlIntegerToUnicodeString",12,0], [294,"RtlLeaveCriticalSection",4,0],
  [295,"RtlLeaveCriticalSectionAndRegion",4,0], [296,"RtlLowerChar",4,0], [297,"RtlMapGenericMask",8,0],
  [298,"RtlMoveMemory",12,0], [299,"RtlMultiByteToUnicodeN",20,0], [300,"RtlMultiByteToUnicodeSize",12,0],
  [301,"RtlNtStatusToDosError",4,0], [302,"RtlRaiseException",4,0], [303,"RtlRaiseStatus",4,0],
  [304,"RtlTimeFieldsToTime",8,0], [305,"RtlTimeToTimeFields",8,0], [306,"RtlTryEnterCriticalSection",4,0],
  [307,"@RtlUlongByteSwap",4,0], [308,"RtlUnicodeStringToAnsiString",12,0], [309,"RtlUnicodeStringToInteger",12,0],
  [310,"RtlUnicodeToMultiByteN",20,0], [311,"RtlUnicodeToMultiByteSize",12,0], [312,"RtlUnwind",16,0],
  [313,"RtlUpcaseUnicodeChar",4,0], [314,"RtlUpcaseUnicodeString",12,0], [315,"RtlUpcaseUnicodeToMultiByteN",20,0],
  [316,"RtlUpperChar",4,0], [317,"RtlUpperString",8,0], [318,"@RtlUshortByteSwap",4,0], [319,"RtlWalkFrameChain",12,0],
  [320,"RtlZeroMemory",8,0], [321,"XboxEEPROMKey",null,1], [322,"XboxHardwareInfo",null,1], [323,"XboxHDKey",null,1],
  [324,"XboxKrnlVersion",null,1], [325,"XboxSignatureKey",null,1], [326,"XeImageFileName",null,1],
  [327,"XeLoadSection",4,0], [328,"XeUnloadSection",4,0], [329,"READ_PORT_BUFFER_UCHAR",12,0],
  [330,"READ_PORT_BUFFER_USHORT",12,0], [331,"READ_PORT_BUFFER_ULONG",12,0], [332,"WRITE_PORT_BUFFER_UCHAR",12,0],
  [333,"WRITE_PORT_BUFFER_USHORT",12,0], [334,"WRITE_PORT_BUFFER_ULONG",12,0], [335,"XcSHAInit",4,0],
  [336,"XcSHAUpdate",12,0], [337,"XcSHAFinal",8,0], [338,"XcRC4Key",12,0], [339,"XcRC4Crypt",12,0],
  [340,"XcHMAC",28,0], [341,"XcPKEncPublic",12,0], [342,"XcPKDecPrivate",12,0], [343,"XcPKGetKeyLen",4,0],
  [344,"XcVerifyPKCS1Signature",12,0], [345,"XcModExp",20,0], [346,"XcDESKeyParity",8,0], [347,"XcKeyTable",12,0],
  [348,"XcBlockCrypt",20,0], [349,"XcBlockCryptCBC",28,0], [350,"XcCryptService",8,0], [351,"XcUpdateCrypto",8,0],
  [352,"RtlRip",12,0], [353,"XboxLANKey",null,1], [354,"XboxAlternateSignatureKeys",null,1],
  [355,"XePublicKeyData",null,1], [356,"HalBootSMCVideoMode",null,1], [357,"IdexChannelObject",null,1],
  [358,"HalIsResetOrShutdownPending",0,0], [359,"IoMarkIrpMustComplete",4,0], [360,"HalInitiateShutdown",0,0],
  [361,"RtlSnprintf",null,0], [362,"RtlSprintf",null,0], [363,"RtlVsnprintf",null,0], [364,"RtlVsprintf",null,0],
  [365,"HalEnableSecureTrayEject",0,0], [366,"HalWriteSMCScratchRegister",4,0], [374,"MmDbgAllocateMemory",8,0],
  [375,"MmDbgFreeMemory",8,0], [376,"MmDbgQueryAvailablePages",0,0], [377,"MmDbgReleaseAddress",8,0],
  [378,"MmDbgWriteCheck",8,0],
];
export const KERNEL_EXPORTS = new Map(KERNEL_LIST.map(([o, name, argBytes, data]) => [o, { name, argBytes, data: !!data }]));

const alignUp = (x, a) => Math.ceil(x / a) * a;
const fail = m => { throw new Error(m); };

// xbe: a Buffer with the XBE. Returns { exe (Buffer), report (lines), labels (CSV text) }.
export function xbeToPe(data, { subsystem = 14, ordinals: byOrdinal = false } = {}) {
  if (data.length < 0x178 || data.toString("latin1", 0, 4) !== "XBEH") fail("not an XBE file (missing 'XBEH' magic)");
  const u32 = o => data.readUInt32LE(o);
  const base = u32(0x104), hdrSize = u32(0x108), imgSize = u32(0x10c), timedate = u32(0x114), nsec = u32(0x11c), secHdrVa = u32(0x120);
  const entryEnc = u32(0x128), tlsVa = u32(0x12c), stackCommit = u32(0x130), heapReserve = u32(0x134), heapCommit = u32(0x138);
  const thunkEnc = u32(0x158), nonkernelImports = u32(0x15c);
  if (hdrSize > data.length) fail(`header size 0x${hdrSize.toString(16)} is larger than the file`);
  const hdrOff = (va, what) => { const off = va - base; if (!(off >= 0 && off < hdrSize)) fail(`${what} at 0x${va.toString(16)} is outside the XBE header`); return off; };

  // ---- sections
  const secs = [], so = hdrOff(secHdrVa, "section headers");
  for (let i = 0; i < nsec; i++) {
    const o = so + i * 56, [flags, va, vsize, raw, rsize, nameVa] = [0, 4, 8, 12, 16, 20].map(k => u32(o + k));
    const no = hdrOff(nameVa, `section ${i} name`), end = data.indexOf(0, no);
    const name = data.toString("latin1", no, end >= 0 && end < hdrSize ? end : no + 8);
    if (va < base) fail(`section ${name} VA 0x${va.toString(16)} is below image base`);
    if (raw + rsize > data.length) fail(`section ${name} raw data runs past end of file`);
    secs.push({ name, flags, va, rva: va - base, vsize, raw, rsize, rlen: Math.min(rsize, vsize) });
  }
  if (!secs.length) fail("XBE has no sections");
  const readVa = (va, n) => {
    if (base <= va && va + n <= base + hdrSize) return data.subarray(va - base, va - base + n);
    for (const s of secs) if (s.va <= va && va + n <= s.va + s.rlen) { const o = s.raw + va - s.va; return data.subarray(o, o + n); }
    return null;
  };
  const inExec = va => secs.some(s => s.flags & XBE_SEC_EXECUTABLE && s.va <= va && va < s.va + s.vsize);

  // ---- entry point and kernel thunk
  let kind = null, entry, thunk;
  for (const k of Object.keys(ENTRY_KEYS)) {
    const ep = (entryEnc ^ ENTRY_KEYS[k]) >>> 0, th = (thunkEnc ^ THUNK_KEYS[k]) >>> 0, first = readVa(th, 4);
    if (inExec(ep) && first && first.readUInt32LE(0) & 0x80000000) { kind = k; entry = ep; thunk = th; break; }
  }
  if (!kind) fail("could not decode entry point / kernel thunk with retail or debug keys (unusual XBE, e.g. Chihiro?)");
  const ordinals = [];
  for (let va = thunk; ; va += 4) {
    const b = readVa(va, 4); if (!b) fail("kernel thunk table runs off the end of its section");
    const v = b.readUInt32LE(0); if (v === 0) break;
    if (!(v & 0x80000000)) fail(`kernel thunk entry 0x${v.toString(16)} at 0x${va.toString(16)} is not an ordinal import`);
    ordinals.push(v & 0x7fffffff); if (ordinals.length > 1024) fail("kernel thunk table has no terminator");
  }

  // ---- layout
  const report = [];
  let align = 0x1000; while (align > 1 && secs.some(s => s.rva % align)) align /= 2;
  if (align < 0x20) report.push(`warning: section addresses only share ${align}-byte alignment`);
  const imageEnd = Math.max(...secs.map(s => s.rva + s.vsize)), firstRva = Math.min(...secs.map(s => s.rva));
  let ntOff = alignUp(hdrSize, 8);
  const keepHeader = ntOff + 4 + 20 + OPT_HDR_SIZE + 40 * (secs.length + 1) <= firstRva;
  if (!keepHeader) { ntOff = 0x40; report.push("warning: no room after the XBE header; PE headers overwrite it (original kept in section .xbeh)"); }
  const nsecTotal = secs.length + (keepHeader ? 1 : 2), secTableOff = ntOff + 4 + 20 + OPT_HDR_SIZE, hdrNeeded = secTableOff + 40 * nsecTotal;
  const sizeOfHeaders = alignUp(hdrNeeded, align);
  if (sizeOfHeaders > firstRva) fail(`not enough room for PE headers (need 0x${sizeOfHeaders.toString(16)} bytes, first section at RVA 0x${firstRva.toString(16)})`);
  let nextRva = alignUp(Math.max(imageEnd, imgSize), align), xbehRva = 0, xbehLen = 0;
  if (!keepHeader) { xbehRva = nextRva; xbehLen = hdrSize; nextRva = alignUp(xbehRva + xbehLen, align); }

  // import section: descriptor + null descriptor, lookup table, DLL name, hint/name entries (hint = ordinal)
  const dllName = Buffer.from("xboxkrnl.exe\0", "latin1"), iltOff = 40, nameOff = iltOff + 4 * (ordinals.length + 1), hnOff = alignUp(nameOff + dllName.length, 2);
  const impRva = nextRva, parts = [Buffer.alloc(hnOff)]; let impLen = hnOff;
  const thunkValues = [], unnamed = [];
  for (const o of ordinals) {
    const e = KERNEL_EXPORTS.get(o);
    if (byOrdinal || !e) { if (!e) unnamed.push(o); thunkValues.push((0x80000000 | o) >>> 0); }
    else {
      thunkValues.push(impRva + impLen);
      let hn = Buffer.concat([Buffer.from([o & 0xff, o >> 8]), Buffer.from(e.name + "\0", "ascii")]);
      if ((impLen + hn.length) % 2) hn = Buffer.concat([hn, Buffer.alloc(1)]);
      parts.push(hn); impLen += hn.length;
    }
  }
  const imp = Buffer.concat(parts);
  [impRva + iltOff, 0, 0, impRva + nameOff, thunk - base].forEach((v, i) => imp.writeUInt32LE(v >>> 0, 4 * i));
  thunkValues.forEach((v, i) => imp.writeUInt32LE(v, iltOff + 4 * i));
  dllName.copy(imp, nameOff);
  const sizeOfImage = alignUp(impRva + imp.length, align);

  // ---- flat image
  const flat = Buffer.alloc(sizeOfImage);
  data.copy(flat, 0, 0, hdrSize);
  for (const s of secs) data.copy(flat, s.rva, s.raw, s.raw + s.rlen);
  if (xbehLen) data.copy(flat, xbehRva, 0, hdrSize);
  imp.copy(flat, impRva);
  thunkValues.forEach((v, i) => flat.writeUInt32LE(v, thunk - base + 4 * i));   // IAT slots, as in an unbound PE
  if (keepHeader) flat.fill(0, ntOff, hdrNeeded); else flat.fill(0, 0, hdrNeeded);
  flat.write("MZ", 0, "latin1"); flat.writeUInt32LE(ntOff, 0x3c); flat.write("PE\0\0", ntOff, "latin1");
  // COFF header: i386, executable, 32-bit, relocations stripped
  let p = ntOff + 4;
  const H = v => { flat.writeUInt16LE(v, p); p += 2; }, I = v => { flat.writeUInt32LE(v >>> 0, p); p += 4; }, B = v => { flat[p++] = v; };
  H(0x14c); H(nsecTotal); I(timedate); I(0); I(0); H(OPT_HDR_SIZE); H(0x0103);
  const execSecs = secs.filter(s => s.flags & XBE_SEC_EXECUTABLE), dataSecs = secs.filter(s => !(s.flags & XBE_SEC_EXECUTABLE));
  const sizeCode = execSecs.reduce((n, s) => n + alignUp(s.rlen, align), 0), sizeInit = dataSecs.filter(s => s.rlen).reduce((n, s) => n + alignUp(s.rlen, align), 0);
  const sizeUninit = dataSecs.filter(s => !s.rlen).reduce((n, s) => n + alignUp(s.vsize, align), 0), stack = stackCommit || 0x10000;
  const opt = ntOff + 4 + 20; p = opt;
  H(0x10b); B(6); B(0); I(sizeCode); I(sizeInit); I(sizeUninit); I(entry - base); I(execSecs[0]?.rva ?? 0); I(dataSecs[0]?.rva ?? 0); I(base);
  I(align); I(align); H(4); H(0); H(0); H(0); H(4); H(0); I(0); I(sizeOfImage); I(sizeOfHeaders); I(0); H(subsystem); H(0);
  I(stack); I(stack); I(heapReserve || 0x100000); I(heapCommit || 0x1000); I(0); I(16);
  const dirs = opt + 96, dir = (k, a, n) => { flat.writeUInt32LE(a >>> 0, dirs + 8 * k); flat.writeUInt32LE(n >>> 0, dirs + 8 * k + 4); };
  dir(1, impRva, 40); if (tlsVa) dir(9, tlsVa - base, 24); dir(12, thunk - base, 4 * (ordinals.length + 1));
  // section table
  const putSection = (idx, name, vsize, rva, rlen, chars) => {
    const rsz = rlen ? Math.min(alignUp(rlen, align), sizeOfImage - rva) : 0, o = secTableOff + 40 * idx;
    const nm = Buffer.alloc(8); Buffer.from(name, "latin1").copy(nm, 0, 0, 8); nm.copy(flat, o);
    [vsize, rva, rsz, rsz ? rva : 0, 0, 0].forEach((v, i) => flat.writeUInt32LE(v >>> 0, o + 8 + 4 * i));
    flat.writeUInt16LE(0, o + 32); flat.writeUInt16LE(0, o + 34); flat.writeUInt32LE(chars >>> 0, o + 36);
  };
  secs.forEach((s, i) => {
    let chars = PE_SCN_MEM_READ;
    if (s.flags & XBE_SEC_EXECUTABLE) chars |= PE_SCN_CNT_CODE | PE_SCN_MEM_EXEC; else chars |= s.rlen ? PE_SCN_CNT_INIT : PE_SCN_CNT_UNINIT;
    if (s.flags & XBE_SEC_WRITABLE) chars |= PE_SCN_MEM_WRITE;
    putSection(i, s.name, s.vsize, s.rva, s.rlen, chars);
  });
  putSection(secs.length, ".kimport", imp.length, impRva, imp.length, PE_SCN_CNT_INIT | PE_SCN_MEM_READ);
  if (xbehLen) putSection(secs.length + 1, ".xbeh", xbehLen, xbehRva, xbehLen, PE_SCN_CNT_INIT | PE_SCN_MEM_READ);

  // ---- labels (CSV of kernel imports) and report
  const hex = v => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const labels = "thunk_address,ordinal,name,stdcall_arg_bytes,kind\n" + ordinals.map((o, i) => {
    const e = KERNEL_EXPORTS.get(o) ?? { name: `Ordinal_${o}`, argBytes: null, data: false };
    return `${hex(thunk + 4 * i)},${o},${e.name},${e.argBytes ?? ""},${e.data ? "data" : "function"}\n`;
  }).join("");
  report.push(`XBE kind      : ${kind}`, `image base    : ${hex(base)}`, `entry point   : ${hex(entry)}`,
    `kernel thunk  : ${hex(thunk)} (${ordinals.length} imports from xboxkrnl.exe, ${byOrdinal ? "by ordinal" : `${ordinals.length - unnamed.length} named`})`);
  if (unnamed.length) report.push(`warning: no name known for ordinals ${unnamed.join(", ")}`);
  if (tlsVa) report.push(`TLS directory : ${hex(tlsVa)}`);
  if (nonkernelImports) report.push(`warning: XBE has a non-kernel import directory at ${hex(nonkernelImports)} (not converted)`);
  report.push(`sections      : ${secs.length} + .kimport${xbehLen ? " + .xbeh" : ""}; XBE header ${keepHeader ? `kept in place (PE headers at +0x${ntOff.toString(16)})` : "overwritten; see .xbeh"}`);
  return { exe: flat, report, labels, kind, base, entry, thunk };
}

// default.xbe -> default.exe (written whole under a temporary name, then renamed)
export function convertXbe(xbePath, exePath, opts = {}) {
  const r = xbeToPe(readFileSync(xbePath), opts);
  writeFileSync(exePath + ".part", r.exe); renameSync(exePath + ".part", exePath);
  if (opts.labels) writeFileSync(opts.labels, r.labels);
  return r;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), flag = n => { const i = a.indexOf(n); return i < 0 ? undefined : a.splice(i, 2)[1]; };
  const labels = flag("--labels"), subsystem = flag("--subsystem"), ordinals = a.includes("--ordinals"), [inp, out] = a.filter(x => !x.startsWith("--"));
  if (!inp || !out) { console.log("usage: node xbe2pe.mjs default.xbe default.exe [--labels kernel_imports.csv] [--ordinals] [--subsystem N]"); process.exit(1); }
  try { const r = convertXbe(inp, out, { labels, ordinals, subsystem: subsystem ? +subsystem : 14 }); console.log(r.report.join("\n")); console.log(`wrote ${out} (${r.exe.length} bytes)`); }
  catch (e) { console.error("error: " + e.message); process.exit(1); }
}
