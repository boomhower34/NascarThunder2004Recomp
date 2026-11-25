#!/usr/bin/env python3
"""
xbe2pe.py - repackage an original Xbox executable (.xbe) as a 32-bit PE (.exe)
for static analysis in Ghidra / REA. The output is NOT runnable on Windows.

What it does
  * Keeps every XBE section at its original virtual address (image base = XBE base,
    normally 0x10000), so addresses match the XBE, emulators and debuggers.
  * Decodes the XOR-encoded entry point and kernel thunk address (retail or debug key).
  * Builds a PE import table so the kernel thunk table becomes imports from
    "xboxkrnl.exe" by name (e.g. PsCreateSystemThreadEx), using the embedded
    nxdk export table. Like a normal unbound PE, the thunk slots in the file hold
    pointers to the names; the original XBE holds ordinals there instead.
    Use --ordinals to keep ordinal-only imports (shown as Ordinal_N).
  * Points the PE TLS directory at the XBE TLS structure (same layout).
  * Leaves the XBE header in place (game code reads it at runtime) and puts the
    PE headers after it. Only if there is no room are they placed at 0x40, with a
    copy of the original header kept in an extra section ".xbeh".
  * Optionally writes a CSV of kernel imports (thunk slot address, ordinal, name,
    stdcall argument bytes, data/function) for use in other tools (--labels).

File layout: each section's raw data sits at file offset == RVA (a flat image),
which keeps alignment simple and lets any address be found at offset VA - base.

Usage
  python xbe2pe.py default.xbe default.exe
  python xbe2pe.py default.xbe default.exe --labels kernel_imports.csv
  python xbe2pe.py default.xbe default.exe --subsystem 2   # Windows GUI subsystem
"""
import argparse
import struct
import sys

# XOR keys for the encoded entry point / kernel thunk address in the XBE header.
ENTRY_KEYS = {"retail": 0xA8FC57AB, "debug": 0x94859D4B}
THUNK_KEYS = {"retail": 0x5B6D40B6, "debug": 0xEFB1F152}

XBE_SEC_WRITABLE = 0x1
XBE_SEC_EXECUTABLE = 0x4

PE_SCN_CNT_CODE = 0x00000020
PE_SCN_CNT_INIT = 0x00000040
PE_SCN_CNT_UNINIT = 0x00000080
PE_SCN_MEM_EXEC = 0x20000000
PE_SCN_MEM_READ = 0x40000000
PE_SCN_MEM_WRITE = 0x80000000

OPT_HDR_SIZE = 224

# Xbox kernel exports: ordinal -> (name, stdcall argument bytes or None, is_data).
# Source: nxdk lib/xboxkrnl/xboxkrnl.exe.def (CC0-1.0).
KERNEL_EXPORTS = {
    1: ('AvGetSavedDataAddress', 0, False),
    2: ('AvSendTVEncoderOption', 16, False),
    3: ('AvSetDisplayMode', 24, False),
    4: ('AvSetSavedDataAddress', 4, False),
    5: ('DbgBreakPoint', 0, False),
    6: ('DbgBreakPointWithStatus', 4, False),
    7: ('DbgLoadImageSymbols', 12, False),
    8: ('DbgPrint', None, False),
    9: ('HalReadSMCTrayState', 8, False),
    10: ('DbgPrompt', 12, False),
    11: ('DbgUnLoadImageSymbols', 12, False),
    12: ('ExAcquireReadWriteLockExclusive', 4, False),
    13: ('ExAcquireReadWriteLockShared', 4, False),
    14: ('ExAllocatePool', 4, False),
    15: ('ExAllocatePoolWithTag', 8, False),
    16: ('ExEventObjectType', None, True),
    17: ('ExFreePool', 4, False),
    18: ('ExInitializeReadWriteLock', 4, False),
    19: ('ExInterlockedAddLargeInteger', 16, False),
    20: ('@ExInterlockedAddLargeStatistic', 8, False),
    21: ('@ExInterlockedCompareExchange64', 12, False),
    22: ('ExMutantObjectType', None, True),
    23: ('ExQueryPoolBlockSize', 4, False),
    24: ('ExQueryNonVolatileSetting', 20, False),
    25: ('ExReadWriteRefurbInfo', 12, False),
    26: ('ExRaiseException', 4, False),
    27: ('ExRaiseStatus', 4, False),
    28: ('ExReleaseReadWriteLock', 4, False),
    29: ('ExSaveNonVolatileSetting', 16, False),
    30: ('ExSemaphoreObjectType', None, True),
    31: ('ExTimerObjectType', None, True),
    32: ('@ExfInterlockedInsertHeadList', 8, False),
    33: ('@ExfInterlockedInsertTailList', 8, False),
    34: ('@ExfInterlockedRemoveHeadList', 4, False),
    35: ('FscGetCacheSize', 0, False),
    36: ('FscInvalidateIdleBlocks', 0, False),
    37: ('FscSetCacheSize', 4, False),
    38: ('@HalClearSoftwareInterrupt', 4, False),
    39: ('HalDisableSystemInterrupt', 4, False),
    40: ('HalDiskCachePartitionCount', None, True),
    41: ('HalDiskModelNumber', None, True),
    42: ('HalDiskSerialNumber', None, True),
    43: ('HalEnableSystemInterrupt', 8, False),
    44: ('HalGetInterruptVector', 8, False),
    45: ('HalReadSMBusValue', 16, False),
    46: ('HalReadWritePCISpace', 24, False),
    47: ('HalRegisterShutdownNotification', 8, False),
    48: ('@HalRequestSoftwareInterrupt', 4, False),
    49: ('HalReturnToFirmware', 4, False),
    50: ('HalWriteSMBusValue', 16, False),
    51: ('@InterlockedCompareExchange', 12, False),
    52: ('@InterlockedDecrement', 4, False),
    53: ('@InterlockedIncrement', 4, False),
    54: ('@InterlockedExchange', 8, False),
    55: ('@InterlockedExchangeAdd', 8, False),
    56: ('@InterlockedFlushSList', 4, False),
    57: ('@InterlockedPopEntrySList', 4, False),
    58: ('@InterlockedPushEntrySList', 8, False),
    59: ('IoAllocateIrp', 4, False),
    60: ('IoBuildAsynchronousFsdRequest', 24, False),
    61: ('IoBuildDeviceIoControlRequest', 36, False),
    62: ('IoBuildSynchronousFsdRequest', 28, False),
    63: ('IoCheckShareAccess', 20, False),
    64: ('IoCompletionObjectType', None, True),
    65: ('IoCreateDevice', 24, False),
    66: ('IoCreateFile', 40, False),
    67: ('IoCreateSymbolicLink', 8, False),
    68: ('IoDeleteDevice', 4, False),
    69: ('IoDeleteSymbolicLink', 4, False),
    70: ('IoDeviceObjectType', None, True),
    71: ('IoFileObjectType', None, True),
    72: ('IoFreeIrp', 4, False),
    73: ('IoInitializeIrp', 12, False),
    74: ('IoInvalidDeviceRequest', 8, False),
    75: ('IoQueryFileInformation', 20, False),
    76: ('IoQueryVolumeInformation', 20, False),
    77: ('IoQueueThreadIrp', 4, False),
    78: ('IoRemoveShareAccess', 8, False),
    79: ('IoSetIoCompletion', 20, False),
    80: ('IoSetShareAccess', 16, False),
    81: ('IoStartNextPacket', 4, False),
    82: ('IoStartNextPacketByKey', 8, False),
    83: ('IoStartPacket', 12, False),
    84: ('IoSynchronousDeviceIoControlRequest', 32, False),
    85: ('IoSynchronousFsdRequest', 20, False),
    86: ('@IofCallDriver', 8, False),
    87: ('@IofCompleteRequest', 8, False),
    88: ('KdDebuggerEnabled', None, True),
    89: ('KdDebuggerNotPresent', None, True),
    90: ('IoDismountVolume', 4, False),
    91: ('IoDismountVolumeByName', 4, False),
    92: ('KeAlertResumeThread', 4, False),
    93: ('KeAlertThread', 8, False),
    94: ('KeBoostPriorityThread', 8, False),
    95: ('KeBugCheck', 4, False),
    96: ('KeBugCheckEx', 20, False),
    97: ('KeCancelTimer', 4, False),
    98: ('KeConnectInterrupt', 4, False),
    99: ('KeDelayExecutionThread', 12, False),
    100: ('KeDisconnectInterrupt', 4, False),
    101: ('KeEnterCriticalRegion', 0, False),
    102: ('MmGlobalData', None, True),
    103: ('KeGetCurrentIrql', 0, False),
    104: ('KeGetCurrentThread', 0, False),
    105: ('KeInitializeApc', 28, False),
    106: ('KeInitializeDeviceQueue', 4, False),
    107: ('KeInitializeDpc', 12, False),
    108: ('KeInitializeEvent', 12, False),
    109: ('KeInitializeInterrupt', 28, False),
    110: ('KeInitializeMutant', 8, False),
    111: ('KeInitializeQueue', 8, False),
    112: ('KeInitializeSemaphore', 12, False),
    113: ('KeInitializeTimerEx', 8, False),
    114: ('KeInsertByKeyDeviceQueue', 12, False),
    115: ('KeInsertDeviceQueue', 8, False),
    116: ('KeInsertHeadQueue', 8, False),
    117: ('KeInsertQueue', 8, False),
    118: ('KeInsertQueueApc', 16, False),
    119: ('KeInsertQueueDpc', 12, False),
    120: ('KeInterruptTime', None, True),
    121: ('KeIsExecutingDpc', 0, False),
    122: ('KeLeaveCriticalRegion', 0, False),
    123: ('KePulseEvent', 12, False),
    124: ('KeQueryBasePriorityThread', 4, False),
    125: ('KeQueryInterruptTime', 0, False),
    126: ('KeQueryPerformanceCounter', 0, False),
    127: ('KeQueryPerformanceFrequency', 0, False),
    128: ('KeQuerySystemTime', 4, False),
    129: ('KeRaiseIrqlToDpcLevel', 0, False),
    130: ('KeRaiseIrqlToSynchLevel', 0, False),
    131: ('KeReleaseMutant', 16, False),
    132: ('KeReleaseSemaphore', 16, False),
    133: ('KeRemoveByKeyDeviceQueue', 8, False),
    134: ('KeRemoveDeviceQueue', 4, False),
    135: ('KeRemoveEntryDeviceQueue', 8, False),
    136: ('KeRemoveQueue', 12, False),
    137: ('KeRemoveQueueDpc', 4, False),
    138: ('KeResetEvent', 4, False),
    139: ('KeRestoreFloatingPointState', 4, False),
    140: ('KeResumeThread', 4, False),
    141: ('KeRundownQueue', 4, False),
    142: ('KeSaveFloatingPointState', 4, False),
    143: ('KeSetBasePriorityThread', 8, False),
    144: ('KeSetDisableBoostThread', 8, False),
    145: ('KeSetEvent', 12, False),
    146: ('KeSetEventBoostPriority', 8, False),
    147: ('KeSetPriorityProcess', 8, False),
    148: ('KeSetPriorityThread', 8, False),
    149: ('KeSetTimer', 16, False),
    150: ('KeSetTimerEx', 20, False),
    151: ('KeStallExecutionProcessor', 4, False),
    152: ('KeSuspendThread', 4, False),
    153: ('KeSynchronizeExecution', 12, False),
    154: ('KeSystemTime', None, True),
    155: ('KeTestAlertThread', 4, False),
    156: ('KeTickCount', None, True),
    157: ('KeTimeIncrement', None, True),
    158: ('KeWaitForMultipleObjects', 32, False),
    159: ('KeWaitForSingleObject', 20, False),
    160: ('@KfRaiseIrql', 4, False),
    161: ('@KfLowerIrql', 4, False),
    162: ('KiBugCheckData', None, True),
    163: ('@KiUnlockDispatcherDatabase', 4, False),
    164: ('LaunchDataPage', None, True),
    165: ('MmAllocateContiguousMemory', 4, False),
    166: ('MmAllocateContiguousMemoryEx', 20, False),
    167: ('MmAllocateSystemMemory', 8, False),
    168: ('MmClaimGpuInstanceMemory', 8, False),
    169: ('MmCreateKernelStack', 8, False),
    170: ('MmDeleteKernelStack', 8, False),
    171: ('MmFreeContiguousMemory', 4, False),
    172: ('MmFreeSystemMemory', 8, False),
    173: ('MmGetPhysicalAddress', 4, False),
    174: ('MmIsAddressValid', 4, False),
    175: ('MmLockUnlockBufferPages', 12, False),
    176: ('MmLockUnlockPhysicalPage', 8, False),
    177: ('MmMapIoSpace', 12, False),
    178: ('MmPersistContiguousMemory', 12, False),
    179: ('MmQueryAddressProtect', 4, False),
    180: ('MmQueryAllocationSize', 4, False),
    181: ('MmQueryStatistics', 4, False),
    182: ('MmSetAddressProtect', 12, False),
    183: ('MmUnmapIoSpace', 8, False),
    184: ('NtAllocateVirtualMemory', 20, False),
    185: ('NtCancelTimer', 8, False),
    186: ('NtClearEvent', 4, False),
    187: ('NtClose', 4, False),
    188: ('NtCreateDirectoryObject', 8, False),
    189: ('NtCreateEvent', 16, False),
    190: ('NtCreateFile', 36, False),
    191: ('NtCreateIoCompletion', 16, False),
    192: ('NtCreateMutant', 12, False),
    193: ('NtCreateSemaphore', 16, False),
    194: ('NtCreateTimer', 12, False),
    195: ('NtDeleteFile', 4, False),
    196: ('NtDeviceIoControlFile', 40, False),
    197: ('NtDuplicateObject', 12, False),
    198: ('NtFlushBuffersFile', 8, False),
    199: ('NtFreeVirtualMemory', 12, False),
    200: ('NtFsControlFile', 40, False),
    201: ('NtOpenDirectoryObject', 8, False),
    202: ('NtOpenFile', 24, False),
    203: ('NtOpenSymbolicLinkObject', 8, False),
    204: ('NtProtectVirtualMemory', 16, False),
    205: ('NtPulseEvent', 8, False),
    206: ('NtQueueApcThread', 20, False),
    207: ('NtQueryDirectoryFile', 40, False),
    208: ('NtQueryDirectoryObject', 24, False),
    209: ('NtQueryEvent', 8, False),
    210: ('NtQueryFullAttributesFile', 8, False),
    211: ('NtQueryInformationFile', 20, False),
    212: ('NtQueryIoCompletion', 8, False),
    213: ('NtQueryMutant', 8, False),
    214: ('NtQuerySemaphore', 8, False),
    215: ('NtQuerySymbolicLinkObject', 12, False),
    216: ('NtQueryTimer', 8, False),
    217: ('NtQueryVirtualMemory', 8, False),
    218: ('NtQueryVolumeInformationFile', 20, False),
    219: ('NtReadFile', 32, False),
    220: ('NtReadFileScatter', 32, False),
    221: ('NtReleaseMutant', 8, False),
    222: ('NtReleaseSemaphore', 12, False),
    223: ('NtRemoveIoCompletion', 20, False),
    224: ('NtResumeThread', 8, False),
    225: ('NtSetEvent', 8, False),
    226: ('NtSetInformationFile', 20, False),
    227: ('NtSetIoCompletion', 20, False),
    228: ('NtSetSystemTime', 8, False),
    229: ('NtSetTimerEx', 32, False),
    230: ('NtSignalAndWaitForSingleObjectEx', 20, False),
    231: ('NtSuspendThread', 8, False),
    232: ('NtUserIoApcDispatcher', 12, False),
    233: ('NtWaitForSingleObject', 12, False),
    234: ('NtWaitForSingleObjectEx', 16, False),
    235: ('NtWaitForMultipleObjectsEx', 24, False),
    236: ('NtWriteFile', 32, False),
    237: ('NtWriteFileGather', 32, False),
    238: ('NtYieldExecution', 0, False),
    239: ('ObCreateObject', 16, False),
    240: ('ObDirectoryObjectType', None, True),
    241: ('ObInsertObject', 16, False),
    242: ('ObMakeTemporaryObject', 4, False),
    243: ('ObOpenObjectByName', 16, False),
    244: ('ObOpenObjectByPointer', 12, False),
    245: ('ObpObjectHandleTable', None, True),
    246: ('ObReferenceObjectByHandle', 12, False),
    247: ('ObReferenceObjectByName', 20, False),
    248: ('ObReferenceObjectByPointer', 8, False),
    249: ('ObSymbolicLinkObjectType', None, True),
    250: ('@ObfDereferenceObject', 4, False),
    251: ('@ObfReferenceObject', 4, False),
    252: ('PhyGetLinkState', 4, False),
    253: ('PhyInitialize', 8, False),
    254: ('PsCreateSystemThread', 20, False),
    255: ('PsCreateSystemThreadEx', 40, False),
    256: ('PsQueryStatistics', 4, False),
    257: ('PsSetCreateThreadNotifyRoutine', 4, False),
    258: ('PsTerminateSystemThread', 4, False),
    259: ('PsThreadObjectType', None, True),
    260: ('RtlAnsiStringToUnicodeString', 12, False),
    261: ('RtlAppendStringToString', 8, False),
    262: ('RtlAppendUnicodeStringToString', 8, False),
    263: ('RtlAppendUnicodeToString', 8, False),
    264: ('RtlAssert', 16, False),
    265: ('RtlCaptureContext', 4, False),
    266: ('RtlCaptureStackBackTrace', 16, False),
    267: ('RtlCharToInteger', 12, False),
    268: ('RtlCompareMemory', 12, False),
    269: ('RtlCompareMemoryUlong', 12, False),
    270: ('RtlCompareString', 12, False),
    271: ('RtlCompareUnicodeString', 12, False),
    272: ('RtlCopyString', 8, False),
    273: ('RtlCopyUnicodeString', 8, False),
    274: ('RtlCreateUnicodeString', 8, False),
    275: ('RtlDowncaseUnicodeChar', 4, False),
    276: ('RtlDowncaseUnicodeString', 12, False),
    277: ('RtlEnterCriticalSection', 4, False),
    278: ('RtlEnterCriticalSectionAndRegion', 4, False),
    279: ('RtlEqualString', 12, False),
    280: ('RtlEqualUnicodeString', 12, False),
    281: ('RtlExtendedIntegerMultiply', 12, False),
    282: ('RtlExtendedLargeIntegerDivide', 16, False),
    283: ('RtlExtendedMagicDivide', 20, False),
    284: ('RtlFillMemory', 12, False),
    285: ('RtlFillMemoryUlong', 12, False),
    286: ('RtlFreeAnsiString', 4, False),
    287: ('RtlFreeUnicodeString', 4, False),
    288: ('RtlGetCallersAddress', 8, False),
    289: ('RtlInitAnsiString', 8, False),
    290: ('RtlInitUnicodeString', 8, False),
    291: ('RtlInitializeCriticalSection', 4, False),
    292: ('RtlIntegerToChar', 16, False),
    293: ('RtlIntegerToUnicodeString', 12, False),
    294: ('RtlLeaveCriticalSection', 4, False),
    295: ('RtlLeaveCriticalSectionAndRegion', 4, False),
    296: ('RtlLowerChar', 4, False),
    297: ('RtlMapGenericMask', 8, False),
    298: ('RtlMoveMemory', 12, False),
    299: ('RtlMultiByteToUnicodeN', 20, False),
    300: ('RtlMultiByteToUnicodeSize', 12, False),
    301: ('RtlNtStatusToDosError', 4, False),
    302: ('RtlRaiseException', 4, False),
    303: ('RtlRaiseStatus', 4, False),
    304: ('RtlTimeFieldsToTime', 8, False),
    305: ('RtlTimeToTimeFields', 8, False),
    306: ('RtlTryEnterCriticalSection', 4, False),
    307: ('@RtlUlongByteSwap', 4, False),
    308: ('RtlUnicodeStringToAnsiString', 12, False),
    309: ('RtlUnicodeStringToInteger', 12, False),
    310: ('RtlUnicodeToMultiByteN', 20, False),
    311: ('RtlUnicodeToMultiByteSize', 12, False),
    312: ('RtlUnwind', 16, False),
    313: ('RtlUpcaseUnicodeChar', 4, False),
    314: ('RtlUpcaseUnicodeString', 12, False),
    315: ('RtlUpcaseUnicodeToMultiByteN', 20, False),
    316: ('RtlUpperChar', 4, False),
    317: ('RtlUpperString', 8, False),
    318: ('@RtlUshortByteSwap', 4, False),
    319: ('RtlWalkFrameChain', 12, False),
    320: ('RtlZeroMemory', 8, False),
    321: ('XboxEEPROMKey', None, True),
    322: ('XboxHardwareInfo', None, True),
    323: ('XboxHDKey', None, True),
    324: ('XboxKrnlVersion', None, True),
    325: ('XboxSignatureKey', None, True),
    326: ('XeImageFileName', None, True),
    327: ('XeLoadSection', 4, False),
    328: ('XeUnloadSection', 4, False),
    329: ('READ_PORT_BUFFER_UCHAR', 12, False),
    330: ('READ_PORT_BUFFER_USHORT', 12, False),
    331: ('READ_PORT_BUFFER_ULONG', 12, False),
    332: ('WRITE_PORT_BUFFER_UCHAR', 12, False),
    333: ('WRITE_PORT_BUFFER_USHORT', 12, False),
    334: ('WRITE_PORT_BUFFER_ULONG', 12, False),
    335: ('XcSHAInit', 4, False),
    336: ('XcSHAUpdate', 12, False),
    337: ('XcSHAFinal', 8, False),
    338: ('XcRC4Key', 12, False),
    339: ('XcRC4Crypt', 12, False),
    340: ('XcHMAC', 28, False),
    341: ('XcPKEncPublic', 12, False),
    342: ('XcPKDecPrivate', 12, False),
    343: ('XcPKGetKeyLen', 4, False),
    344: ('XcVerifyPKCS1Signature', 12, False),
    345: ('XcModExp', 20, False),
    346: ('XcDESKeyParity', 8, False),
    347: ('XcKeyTable', 12, False),
    348: ('XcBlockCrypt', 20, False),
    349: ('XcBlockCryptCBC', 28, False),
    350: ('XcCryptService', 8, False),
    351: ('XcUpdateCrypto', 8, False),
    352: ('RtlRip', 12, False),
    353: ('XboxLANKey', None, True),
    354: ('XboxAlternateSignatureKeys', None, True),
    355: ('XePublicKeyData', None, True),
    356: ('HalBootSMCVideoMode', None, True),
    357: ('IdexChannelObject', None, True),
    358: ('HalIsResetOrShutdownPending', 0, False),
    359: ('IoMarkIrpMustComplete', 4, False),
    360: ('HalInitiateShutdown', 0, False),
    361: ('RtlSnprintf', None, False),
    362: ('RtlSprintf', None, False),
    363: ('RtlVsnprintf', None, False),
    364: ('RtlVsprintf', None, False),
    365: ('HalEnableSecureTrayEject', 0, False),
    366: ('HalWriteSMCScratchRegister', 4, False),
    374: ('MmDbgAllocateMemory', 8, False),
    375: ('MmDbgFreeMemory', 8, False),
    376: ('MmDbgQueryAvailablePages', 0, False),
    377: ('MmDbgReleaseAddress', 8, False),
    378: ('MmDbgWriteCheck', 8, False),
}


def die(msg):
    sys.exit("error: " + msg)


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def align_up(x, a):
    return (x + a - 1) // a * a


def main():
    ap = argparse.ArgumentParser(description="Convert an Xbox XBE to a PE for static analysis.")
    ap.add_argument("xbe", help="input .xbe")
    ap.add_argument("out", help="output .exe")
    ap.add_argument("--subsystem", type=int, default=14,
                    help="PE subsystem value (default 14 = Xbox; use 2 for Windows GUI "
                         "if a tool rejects the Xbox subsystem)")
    ap.add_argument("--ordinals", action="store_true",
                    help="import kernel functions by ordinal only (no names)")
    ap.add_argument("--labels", metavar="CSV",
                    help="also write a CSV of kernel imports to this path")
    args = ap.parse_args()

    data = open(args.xbe, "rb").read()
    if len(data) < 0x178 or data[:4] != b"XBEH":
        die("not an XBE file (missing 'XBEH' magic)")

    base = u32(data, 0x104)
    hdr_size = u32(data, 0x108)
    img_size = u32(data, 0x10C)
    timedate = u32(data, 0x114)
    nsec = u32(data, 0x11C)
    sec_hdr_va = u32(data, 0x120)
    entry_enc = u32(data, 0x128)
    tls_va = u32(data, 0x12C)
    stack_commit = u32(data, 0x130)
    heap_reserve = u32(data, 0x134)
    heap_commit = u32(data, 0x138)
    thunk_enc = u32(data, 0x158)
    nonkernel_imports = u32(data, 0x15C)

    if hdr_size > len(data):
        die("header size 0x%X is larger than the file" % hdr_size)

    def hdr_off(va, what):
        off = va - base
        if not 0 <= off < hdr_size:
            die("%s at 0x%08X is outside the XBE header" % (what, va))
        return off

    # ---- sections -------------------------------------------------------
    secs = []
    so = hdr_off(sec_hdr_va, "section headers")
    for i in range(nsec):
        o = so + i * 56
        flags, va, vsize, raw, rsize, name_va = struct.unpack_from("<6I", data, o)
        no = hdr_off(name_va, "section %d name" % i)
        end = data.find(b"\0", no, hdr_size)
        name = data[no:end if end >= 0 else no + 8].decode("latin-1")
        if va < base:
            die("section %s VA 0x%08X is below image base" % (name, va))
        if raw + rsize > len(data):
            die("section %s raw data runs past end of file" % name)
        secs.append({"name": name, "flags": flags, "va": va, "rva": va - base,
                     "vsize": vsize, "raw": raw, "rsize": rsize,
                     "rlen": min(rsize, vsize)})
    if not secs:
        die("XBE has no sections")

    def read_va(va, n):
        """Bytes at a virtual address, from the header or a section's raw data."""
        if base <= va and va + n <= base + hdr_size:
            return data[va - base:va - base + n]
        for s in secs:
            if s["va"] <= va and va + n <= s["va"] + s["rlen"]:
                o = s["raw"] + va - s["va"]
                return data[o:o + n]
        return None

    def in_exec_section(va):
        return any(s["flags"] & XBE_SEC_EXECUTABLE and s["va"] <= va < s["va"] + s["vsize"]
                   for s in secs)

    # ---- decode entry point + kernel thunk ------------------------------
    kind = entry = thunk = None
    for k in ENTRY_KEYS:
        ep = entry_enc ^ ENTRY_KEYS[k]
        th = thunk_enc ^ THUNK_KEYS[k]
        first = read_va(th, 4)
        if in_exec_section(ep) and first is not None and u32(first, 0) & 0x80000000:
            kind, entry, thunk = k, ep, th
            break
    if kind is None:
        die("could not decode entry point / kernel thunk with retail or debug keys "
            "(unusual XBE, e.g. Chihiro?)")

    ordinals = []
    va = thunk
    while True:
        b = read_va(va, 4)
        if b is None:
            die("kernel thunk table runs off the end of its section")
        v = u32(b, 0)
        if v == 0:
            break
        if not v & 0x80000000:
            die("kernel thunk entry 0x%08X at 0x%08X is not an ordinal import" % (v, va))
        ordinals.append(v & 0x7FFFFFFF)
        va += 4
        if len(ordinals) > 1024:
            die("kernel thunk table has no terminator")

    # ---- layout ---------------------------------------------------------
    align = 0x1000
    while align > 1 and any(s["rva"] % align for s in secs):
        align //= 2
    if align < 0x20:
        print("warning: section addresses only share %d-byte alignment" % align)

    image_end = max(s["rva"] + s["vsize"] for s in secs)
    first_rva = min(s["rva"] for s in secs)

    # Game code reads XBE header fields at runtime (base + 0x104.., certificate, TLS
    # info), so the header must stay intact. The PE "NT headers" go right after the
    # XBE header; only "MZ" (over the XBE magic) and e_lfanew (inside the unused
    # 256-byte signature) touch the original bytes. If there is no room, fall back
    # to putting the NT headers at 0x40 and keeping a copy of the header in .xbeh.
    nt_off = align_up(hdr_size, 8)
    keep_header = nt_off + 4 + 20 + OPT_HDR_SIZE + 40 * (len(secs) + 1) <= first_rva
    if not keep_header:
        nt_off = 0x40
        print("warning: no room after the XBE header; PE headers overwrite it "
              "(original kept in section .xbeh)")
    extra = 1 if keep_header else 2          # .kimport [+ .xbeh]
    nsec_total = len(secs) + extra
    sec_table_off = nt_off + 4 + 20 + OPT_HDR_SIZE
    hdr_needed = sec_table_off + 40 * nsec_total
    size_of_headers = align_up(hdr_needed, align)
    if size_of_headers > first_rva:
        die("not enough room for PE headers (need 0x%X bytes, first section at RVA 0x%X)"
            % (size_of_headers, first_rva))

    next_rva = align_up(max(image_end, img_size), align)
    xbeh_rva = xbeh_len = 0
    if not keep_header:
        xbeh_rva, xbeh_len = next_rva, hdr_size
        next_rva = align_up(xbeh_rva + xbeh_len, align)

    # Import section: descriptor + null descriptor, lookup table, DLL name,
    # then hint/name entries (hint = ordinal) when importing by name.
    dll_name = b"xboxkrnl.exe\0"
    ilt_off = 40
    name_off = ilt_off + 4 * (len(ordinals) + 1)
    hn_off = align_up(name_off + len(dll_name), 2)
    imp_rva = next_rva
    imp = bytearray(hn_off)
    thunk_values = []
    unnamed = []
    for o in ordinals:
        entry_info = KERNEL_EXPORTS.get(o)
        if args.ordinals or entry_info is None:
            if entry_info is None:
                unnamed.append(o)
            thunk_values.append(0x80000000 | o)
        else:
            thunk_values.append(imp_rva + len(imp))
            imp += struct.pack("<H", o) + entry_info[0].encode("ascii") + b"\0"
            if len(imp) % 2:
                imp += b"\0"
    struct.pack_into("<5I", imp, 0, imp_rva + ilt_off, 0, 0, imp_rva + name_off, thunk - base)
    for i, v in enumerate(thunk_values):
        struct.pack_into("<I", imp, ilt_off + 4 * i, v)
    imp[name_off:name_off + len(dll_name)] = dll_name

    size_of_image = align_up(imp_rva + len(imp), align)

    # ---- flat image -----------------------------------------------------
    flat = bytearray(size_of_image)
    flat[0:hdr_size] = data[:hdr_size]
    for s in secs:
        flat[s["rva"]:s["rva"] + s["rlen"]] = data[s["raw"]:s["raw"] + s["rlen"]]
    if xbeh_len:
        flat[xbeh_rva:xbeh_rva + xbeh_len] = data[:hdr_size]
    flat[imp_rva:imp_rva + len(imp)] = imp
    for i, v in enumerate(thunk_values):  # IAT slots, as in an unbound PE
        struct.pack_into("<I", flat, thunk - base + 4 * i, v)
    if keep_header:
        flat[nt_off:hdr_needed] = bytes(hdr_needed - nt_off)
    else:
        flat[0:hdr_needed] = bytes(hdr_needed)

    # DOS header + PE signature
    flat[0:2] = b"MZ"
    struct.pack_into("<I", flat, 0x3C, nt_off)
    flat[nt_off:nt_off + 4] = b"PE\0\0"

    # COFF header: i386, executable, 32-bit, relocations stripped
    struct.pack_into("<HHIIIHH", flat, nt_off + 4, 0x14C, nsec_total, timedate, 0, 0,
                     OPT_HDR_SIZE, 0x0103)

    exec_secs = [s for s in secs if s["flags"] & XBE_SEC_EXECUTABLE]
    data_secs = [s for s in secs if not s["flags"] & XBE_SEC_EXECUTABLE]
    size_code = sum(align_up(s["rlen"], align) for s in exec_secs)
    size_init = sum(align_up(s["rlen"], align) for s in data_secs if s["rlen"])
    size_uninit = sum(align_up(s["vsize"], align) for s in data_secs if not s["rlen"])
    stack = stack_commit or 0x10000

    opt = nt_off + 4 + 20
    struct.pack_into("<HBBIIIIIII", flat, opt, 0x10B, 6, 0, size_code, size_init, size_uninit,
                     entry - base,
                     exec_secs[0]["rva"] if exec_secs else 0,
                     data_secs[0]["rva"] if data_secs else 0,
                     base)
    struct.pack_into("<II6HIIII2H6I", flat, opt + 32,
                     align, align,
                     4, 0, 0, 0, 4, 0,
                     0, size_of_image, size_of_headers, 0,
                     args.subsystem, 0,
                     stack, stack, heap_reserve or 0x100000, heap_commit or 0x1000,
                     0, 16)
    dirs = opt + 96
    struct.pack_into("<II", flat, dirs + 8 * 1, imp_rva, 40)                       # import
    if tls_va:
        struct.pack_into("<II", flat, dirs + 8 * 9, tls_va - base, 24)             # TLS
    struct.pack_into("<II", flat, dirs + 8 * 12, thunk - base, 4 * (len(ordinals) + 1))  # IAT

    # section table
    def put_section(idx, name, vsize, rva, rlen, chars):
        rsz = min(align_up(rlen, align), size_of_image - rva) if rlen else 0
        struct.pack_into("<8sIIIIIIHHI", flat, sec_table_off + 40 * idx,
                         name.encode("latin-1")[:8].ljust(8, b"\0"),
                         vsize, rva, rsz, rva if rsz else 0, 0, 0, 0, 0, chars)

    for i, s in enumerate(secs):
        chars = PE_SCN_MEM_READ
        if s["flags"] & XBE_SEC_EXECUTABLE:
            chars |= PE_SCN_CNT_CODE | PE_SCN_MEM_EXEC
        elif s["rlen"]:
            chars |= PE_SCN_CNT_INIT
        else:
            chars |= PE_SCN_CNT_UNINIT
        if s["flags"] & XBE_SEC_WRITABLE:
            chars |= PE_SCN_MEM_WRITE
        put_section(i, s["name"], s["vsize"], s["rva"], s["rlen"], chars)
    put_section(len(secs), ".kimport", len(imp), imp_rva, len(imp),
                PE_SCN_CNT_INIT | PE_SCN_MEM_READ)
    if xbeh_len:
        put_section(len(secs) + 1, ".xbeh", xbeh_len, xbeh_rva, xbeh_len,
                    PE_SCN_CNT_INIT | PE_SCN_MEM_READ)

    with open(args.out, "wb") as f:
        f.write(flat)

    if args.labels:
        with open(args.labels, "w", newline="") as f:
            f.write("thunk_address,ordinal,name,stdcall_arg_bytes,kind\n")
            for i, o in enumerate(ordinals):
                name, argb, is_data = KERNEL_EXPORTS.get(o, ("Ordinal_%d" % o, None, False))
                f.write("0x%08X,%d,%s,%s,%s\n" % (thunk + 4 * i, o, name,
                                                  "" if argb is None else argb,
                                                  "data" if is_data else "function"))

    # ---- report ---------------------------------------------------------
    print("XBE kind      : %s" % kind)
    print("image base    : 0x%08X" % base)
    print("entry point   : 0x%08X" % entry)
    print("kernel thunk  : 0x%08X (%d imports from xboxkrnl.exe, %s)"
          % (thunk, len(ordinals), "by ordinal" if args.ordinals else
             "%d named" % (len(ordinals) - len(unnamed))))
    if unnamed:
        print("warning: no name known for ordinals %s" % unnamed)
    if tls_va:
        print("TLS directory : 0x%08X" % tls_va)
    if nonkernel_imports:
        print("warning: XBE has a non-kernel import directory at 0x%08X (not converted)"
              % nonkernel_imports)
    print("alignment     : 0x%X" % align)
    print("sections:")
    for s in secs:
        tag = "X" if s["flags"] & XBE_SEC_EXECUTABLE else ("W" if s["flags"] & XBE_SEC_WRITABLE else "R")
        short = s["name"][:8]
        note = "" if short == s["name"] else "   (PE name '%s')" % short
        print("  %-12s %s  0x%08X  vsize 0x%08X  raw 0x%08X%s"
              % (s["name"], tag, s["va"], s["vsize"], s["rlen"], note))
    print("  %-12s R  0x%08X  (PE import table)" % (".kimport", base + imp_rva))
    if xbeh_len:
        print("  %-12s R  0x%08X  (copy of original XBE header)" % (".xbeh", base + xbeh_rva))
    print("XBE header    : %s" % ("kept in place at 0x%08X (PE headers at +0x%X)" % (base, nt_off)
                                  if keep_header else "overwritten; see .xbeh"))
    print("wrote %s (%d bytes)" % (args.out, len(flat)))


if __name__ == "__main__":
    main()
