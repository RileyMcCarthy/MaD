# Platform-crate contract

A **platform crate** (e.g. `embsim-p2`) is the glue between one firmware's HAL
and embsim's generic peripherals. It exports a Rust `#[no_mangle] extern "C"`
function for every symbol the firmware leaves undefined, and implements
[`embsim_runtime::Platform`]. This document enumerates the contract.

## Why it exists

The firmware is compiled to a static library with its HAL **left undefined**.
When the emulator binary links that `.a`, the linker resolves each undefined
`HAL_*` (etc.) symbol against the `#[no_mangle]` functions in the platform crate.
There is no indirection table — symbol *names must match the firmware's HAL
headers exactly*, including any historical spellings (MaD's firmware spells it
`recieve`, so the trampoline is `HAL_serial_recieveByte`).

## ABI mapping rules

| C HAL type            | Rust trampoline type            | Notes |
|-----------------------|---------------------------------|-------|
| channel `int`         | `i32`                           | guard `>= 0`, then `as usize` for the peripheral |
| `bool`                | `bool`                          | |
| `uint8_t* / const uint8_t*` | `*mut u8 / *const u8`     | null-check; `slice::from_raw_parts*` |
| `uint32_t`            | `u32`                           | |
| `void*`               | `*mut core::ffi::c_void`        | |
| `void (*)(void*)`     | `Option<unsafe extern "C" fn(*mut c_void)>` | thread entry |

Every trampoline must **null/range-guard its arguments** before delegating to the
generic peripheral (the peripherals also guard, but the platform layer is the
ABI boundary). See `embsim/platforms/p2/src/ffi.rs` for the reference pattern.

## Required symbol domains

A platform must provide all symbols its firmware references. For the P2/MaD
firmware these are three domains:

### 1. HAL (the bulk — delegate to `embsim_peripherals`)

```
GPIO     HAL_GPIO_setActive  HAL_GPIO_getActive  HAL_GPIO_toggleActive
Serial   HAL_serial_start  HAL_serial_stop  HAL_serial_transmitData
         HAL_serial_recieveDataTimeout  HAL_serial_recieveByte
Encoder  HAL_encoder_start  HAL_encoder_value  HAL_encoder_set
PulseOut HAL_pulseOut_start  HAL_pulseOut_run  HAL_pulseOut_stop
Timer    HAL_time_getMs  HAL_time_getUs  HAL_time_waitMs  HAL_time_waitUs
         HAL_time_getCycles  HAL_time_getClockFreq
Lock     HAL_lock_create  HAL_lock_try  HAL_lock_release
System   HAL_system_init  HAL_system_reboot  HAL_system_startThread
I2C      i2c_setup  i2c_start  i2c_write  i2c_read  i2c_stop
```

(Your firmware's set will differ — provide what *its* HAL headers declare.)

### 2. Platform VFS / filesystem (FlexC VFS for the P2)

```
mount  umount  _vfs_open_sdcard
```

These bridge the firmware's filesystem calls to the host SD directory configured
via the builder's `.sd_path(...)`.

### 3. MCU intrinsics

```
_clkset  _hubset  _reboot
```

Compiler/CPU intrinsics the firmware emits inline on real silicon; stubbed for
the host.

## Init-before-entry ordering (handled by the runtime)

The platform crate provides the *symbols*; the **runtime** owns *initialization
order*. By the time the firmware entry point runs, `Emulator::run` has:

1. initialized the virtual clock (`Platform::clock_freq_hz`),
2. sized every peripheral from `Machine::peripheral_counts` (validated against
   each peripheral's `MAX_*` ceiling),
3. initialized locks/threads from `Platform::max_locks` / `max_cores`,
4. created the host PTY and bridged it to `Machine::host_serial_channel`,
5. run `Machine::wire`.

A platform/machine author never has to remember this sequence — but a trampoline
must tolerate being called the instant the entry point starts.

## Checklist for a new platform

- [ ] Implement `Platform` (clock freq, core count, lock count).
- [ ] One `#[no_mangle] extern "C"` trampoline per firmware HAL symbol, name-exact.
- [ ] Null/range-guard every pointer and channel argument.
- [ ] Stub MCU intrinsics / VFS your firmware references.
- [ ] Build the firmware `.a` with debug info (`-g`) so `memory-inspect` can read
      enums/structs.
