"""Read-only Apple Silicon process counters; no root or Activity Monitor required."""
import ctypes
import json
import plistlib
import re
import subprocess
import sys


def assert_unlocked():
    cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cg.CGSessionCopyCurrentDictionary.restype = ctypes.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cf.CFDictionaryGetValue.restype = ctypes.c_void_p
    cf.CFBooleanGetValue.argtypes = [ctypes.c_void_p]
    cf.CFBooleanGetValue.restype = ctypes.c_bool
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    session = cg.CGSessionCopyCurrentDictionary()
    if not session:
        raise RuntimeError('Foreground measurement requires a logged-in graphical session')
    key = cf.CFStringCreateWithCString(None, b'CGSSessionScreenIsLocked', 0x08000100)
    try:
        locked = cf.CFDictionaryGetValue(session, key)
        if locked and cf.CFBooleanGetValue(locked):
            raise RuntimeError('Screen is locked; unlock the Mac before measuring foreground usage')
    finally:
        cf.CFRelease(key)
        cf.CFRelease(session)


def snapshot(pids):
    assert_unlocked()
    lib = ctypes.CDLL('/usr/lib/libproc.dylib')
    clock = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    timebase = (ctypes.c_uint32 * 2)()
    clock.mach_timebase_info(timebase)
    clock.mach_absolute_time.restype = ctypes.c_uint64
    def now_ns():
        return clock.mach_absolute_time() * timebase[0] / timebase[1]
    cpu = {}
    for pid in pids:
        usage = (ctypes.c_uint64 * 100)()
        if lib.proc_pid_rusage(pid, 4, ctypes.byref(usage)) != 0:
            raise RuntimeError(f'Cannot read CPU counter for {pid}')
        cpu[str(pid)] = (usage[2] + usage[3]) * timebase[0] / timebase[1]
    cpu_time = now_ns()
    registry = plistlib.loads(subprocess.check_output(
        ['ioreg', '-r', '-c', 'AGXAccelerator', '-a', '-l']))
    gpu = {}

    def visit(entry):
        if isinstance(entry, list):
            for child in entry:
                visit(child)
        elif isinstance(entry, dict):
            creator = re.match(r'pid (\d+),', entry.get('IOUserClientCreator', ''))
            if creator and int(creator[1]) in pids and entry.get('AppUsage'):
                key = str(entry['IORegistryEntryID'])
                gpu[key] = {'pid': int(creator[1]), 'ns': sum(
                    app['accumulatedGPUTime'] for app in entry['AppUsage'])}
            for child in entry.get('IORegistryEntryChildren', []):
                visit(child)

    visit(registry)
    return {'cpuNs': cpu, 'cpuTimeNs': cpu_time, 'gpu': gpu,
            'gpuTimeNs': now_ns()}


if __name__ == '__main__':
    print(json.dumps(snapshot([int(pid) for pid in sys.argv[1:]])))
