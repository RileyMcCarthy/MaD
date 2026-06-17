//! Coverage for `link_firmware_static`.
//!
//! The function reads the process-global env vars `EMBSIM_FIRMWARE_LIB_DIR` /
//! `EMBSIM_FIRMWARE_LIB_NAME`, emits cargo directives to stdout (captured and
//! ignored by the test harness), and PANICS if the directory cannot be
//! canonicalized or `lib<name>.a` is missing.
//!
//! Because env is process-global, every test serializes on a crate-local
//! `TEST_LOCK` and saves/restores both vars around its body (recovering from
//! poison the way `pulse_out.rs` does). We assert ONLY panic / no-panic — the
//! emitted directives are inert outside a real build script.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use embsim_build::link_firmware_static;

const DIR_VAR: &str = "EMBSIM_FIRMWARE_LIB_DIR";
const NAME_VAR: &str = "EMBSIM_FIRMWARE_LIB_NAME";

/// Serializes env mutation across tests.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn lock_or_recover() -> MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|p| {
        TEST_LOCK.clear_poison();
        p.into_inner()
    })
}

/// Snapshot + restore of the two env vars, so a panic in the body cannot leak
/// state into the next test (its `Drop` runs during unwinding).
struct EnvGuard {
    dir: Option<String>,
    name: Option<String>,
}

impl EnvGuard {
    fn capture() -> Self {
        Self {
            dir: env::var(DIR_VAR).ok(),
            name: env::var(NAME_VAR).ok(),
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        restore(DIR_VAR, &self.dir);
        restore(NAME_VAR, &self.name);
    }
}

fn restore(key: &str, val: &Option<String>) {
    match val {
        Some(v) => env::set_var(key, v),
        None => env::remove_var(key),
    }
}

/// Monotonic suffix so each test's temp directory is unique.
static SEQ: AtomicU32 = AtomicU32::new(0);

/// A fresh, unique temp directory created on disk.
fn fresh_temp_dir(tag: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let dir = env::temp_dir().join(format!("embsim_build_{tag}_{pid}_{n}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// Create an empty `lib<name>.a` inside `dir`.
fn touch_lib(dir: &Path, name: &str) {
    fs::write(dir.join(format!("lib{name}.a")), b"").expect("write lib stub");
}

// ============================================================
// Happy path: dir + lib present -> no panic
// ============================================================

/// Pointing the env-var dir at a real directory that contains `libfoo.a` with
/// name `foo` does NOT panic.
#[test]
fn present_lib_does_not_panic() {
    let _g = lock_or_recover();
    let _env = EnvGuard::capture();

    let dir = fresh_temp_dir("present");
    touch_lib(&dir, "foo");

    env::set_var(DIR_VAR, &dir);
    env::set_var(NAME_VAR, "foo");

    // Defaults are deliberately bogus to prove the env overrides win.
    link_firmware_static("/nonexistent/default", "defaultname");
}

/// With only the dir overridden, the default *name* is honored — `lib<default>.a`
/// present means no panic.
#[test]
fn default_name_is_used_when_name_var_unset() {
    let _g = lock_or_recover();
    let _env = EnvGuard::capture();

    let dir = fresh_temp_dir("defname");
    touch_lib(&dir, "firmware"); // matches the default_name below

    env::set_var(DIR_VAR, &dir);
    env::remove_var(NAME_VAR); // force fallback to default_name

    link_firmware_static("/nonexistent/default", "firmware");
}

/// With NO env vars set, the default dir + name path is taken; a real dir +
/// matching lib passed as the defaults means no panic. (Proves both fall back
/// to the arguments.)
#[test]
fn falls_back_to_arguments_when_no_env() {
    let _g = lock_or_recover();
    let _env = EnvGuard::capture();

    let dir = fresh_temp_dir("args");
    touch_lib(&dir, "bar");

    env::remove_var(DIR_VAR);
    env::remove_var(NAME_VAR);

    link_firmware_static(dir.to_str().unwrap(), "bar");
}

// ============================================================
// Failure paths: panic
// ============================================================

/// A real dir that is MISSING `lib<name>.a` panics.
#[test]
#[should_panic(expected = "not found")]
fn missing_lib_in_existing_dir_panics() {
    let _g = lock_or_recover();
    let _env = EnvGuard::capture();

    let dir = fresh_temp_dir("nolib"); // exists, but empty
    env::set_var(DIR_VAR, &dir);
    env::set_var(NAME_VAR, "foo"); // libfoo.a does not exist here

    link_firmware_static("/nonexistent/default", "defaultname");
}

/// A nonexistent directory (cannot be canonicalized) panics.
#[test]
#[should_panic(expected = "not found")]
fn nonexistent_dir_panics() {
    let _g = lock_or_recover();
    let _env = EnvGuard::capture();

    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let bogus = env::temp_dir().join(format!("embsim_build_DOES_NOT_EXIST_{pid}_{n}"));
    // Make sure it truly doesn't exist.
    let _ = fs::remove_dir_all(&bogus);

    env::set_var(DIR_VAR, &bogus);
    env::set_var(NAME_VAR, "foo");

    link_firmware_static("/also/nonexistent/default", "defaultname");
}

/// Even when the *default* dir is bogus, an env override that points at a real
/// dir with the lib wins — i.e. the env var, not the argument, is consulted
/// first for the directory.
#[test]
fn env_dir_overrides_bogus_default() {
    let _g = lock_or_recover();
    let _env = EnvGuard::capture();

    let dir = fresh_temp_dir("override");
    touch_lib(&dir, "zap");

    env::set_var(DIR_VAR, &dir);
    env::set_var(NAME_VAR, "zap");

    // The default dir below does not exist; if it were consulted this panics.
    link_firmware_static("/this/default/dir/does/not/exist", "ignored");
}
