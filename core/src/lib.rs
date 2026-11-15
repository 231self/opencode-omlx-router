//! Pure decision engine for `opencode-omlx-router`.
//!
//! The core has no imports, no clock, no randomness, and no I/O. The host
//! adapter passes everything a decision needs in the JSON request and persists
//! whatever state comes back.
//!
//! ABI (see `docs/specs/*-design.md` §3):
//!
//! ```text
//! abi_version() -> u32
//! alloc(len) -> ptr
//! dealloc(ptr, len)
//! result_len() -> u32
//! route(ptr, len) -> ptr
//! optimise(ptr, len) -> ptr
//! ```

use std::slice;
use std::sync::Mutex;

use serde_json::{json, Value};

pub const ABI_VERSION: u32 = 1;

/// The last JSON result. The returned pointer stays valid until the next call.
static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate `len` bytes for the host to write a request into.
///
/// Returns null for a zero-length request; the host treats that as an error.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut buf = vec![0u8; len];
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free a buffer previously returned by [`alloc`].
///
/// # Safety
///
/// `ptr` and `len` must come from the same allocation.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Length in bytes of the last result.
#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT.lock().map(|guard| guard.len()).unwrap_or_default()
}

fn store(value: Value) -> *const u8 {
    let bytes =
        serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"abi\":1,\"action\":\"skip\"}".to_vec());
    let mut guard = RESULT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = bytes;
    guard.as_ptr()
}

fn read_request(ptr: *const u8, len: usize) -> Option<Value> {
    if ptr.is_null() || len == 0 {
        return None;
    }
    let input = unsafe { slice::from_raw_parts(ptr, len) };
    serde_json::from_slice(input).ok()
}

/// Decide the model for one turn.
///
/// # Safety
///
/// `ptr`/`len` must describe a readable buffer in this module's memory.
#[no_mangle]
pub unsafe extern "C" fn route(ptr: *const u8, len: usize) -> *const u8 {
    let request = match read_request(ptr, len) {
        Some(value) => value,
        None => {
            return store(json!({
                "abi": ABI_VERSION,
                "action": "skip",
                "reason": "invalid_input",
            }))
        }
    };
    store(handle_route(request))
}

/// Plan the context optimiser for one request.
///
/// # Safety
///
/// `ptr`/`len` must describe a readable buffer in this module's memory.
#[no_mangle]
pub unsafe extern "C" fn optimise(ptr: *const u8, len: usize) -> *const u8 {
    let request = match read_request(ptr, len) {
        Some(value) => value,
        None => {
            return store(json!({
                "abi": ABI_VERSION,
                "plan": [],
                "stats": {
                    "beforeTokens": 0,
                    "afterTokens": 0,
                    "partsPruned": 0,
                    "overflow": false,
                },
                "reason": "invalid_input",
            }))
        }
    };
    store(handle_optimise(request))
}

fn request_abi(value: &Value) -> Option<u64> {
    value.get("abi").and_then(Value::as_u64)
}

fn handle_route(request: Value) -> Value {
    if request_abi(&request) != Some(u64::from(ABI_VERSION)) {
        return json!({
            "abi": ABI_VERSION,
            "action": "skip",
            "reason": "abi_mismatch",
        });
    }

    // M1 skeleton: routing lands in M2.
    json!({
        "abi": ABI_VERSION,
        "action": "skip",
        "reason": "not_implemented",
    })
}

fn handle_optimise(request: Value) -> Value {
    if request_abi(&request) != Some(u64::from(ABI_VERSION)) {
        return json!({
            "abi": ABI_VERSION,
            "plan": [],
            "stats": {
                "beforeTokens": 0,
                "afterTokens": 0,
                "partsPruned": 0,
                "overflow": false,
            },
            "reason": "abi_mismatch",
        });
    }

    // M3: deterministic pruning plan. Under budget is a no-op.
    json!({
        "abi": ABI_VERSION,
        "plan": [],
        "stats": {
            "beforeTokens": 0,
            "afterTokens": 0,
            "partsPruned": 0,
            "overflow": false,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Native tests run in parallel and share the result buffer; serialize them.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn call_route(input: &str) -> Value {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let ptr = alloc(input.len());
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::copy_nonoverlapping(input.as_ptr(), ptr, input.len());
        }
        let out = unsafe { route(ptr, input.len()) };
        let len = result_len();
        let value = unsafe {
            let bytes = slice::from_raw_parts(out, len);
            serde_json::from_slice(bytes).expect("result is JSON")
        };
        unsafe { dealloc(ptr, input.len()) };
        value
    }

    fn call_optimise(input: &str) -> Value {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let ptr = alloc(input.len());
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::copy_nonoverlapping(input.as_ptr(), ptr, input.len());
        }
        let out = unsafe { optimise(ptr, input.len()) };
        let len = result_len();
        let value = unsafe {
            let bytes = slice::from_raw_parts(out, len);
            serde_json::from_slice(bytes).expect("result is JSON")
        };
        unsafe { dealloc(ptr, input.len()) };
        value
    }

    #[test]
    fn abi_version_is_one() {
        assert_eq!(abi_version(), 1);
    }

    #[test]
    fn alloc_and_dealloc_roundtrip() {
        let ptr = alloc(16);
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::write_bytes(ptr, 0xab, 16);
            assert_eq!(*ptr, 0xab);
            dealloc(ptr, 16);
        }
    }

    #[test]
    fn zero_length_alloc_is_null() {
        assert!(alloc(0).is_null());
    }

    #[test]
    fn invalid_json_skips() {
        let value = call_route("not json");
        assert_eq!(value["action"], "skip");
        assert_eq!(value["reason"], "invalid_input");
    }

    #[test]
    fn abi_mismatch_skips() {
        let value = call_route(r#"{"abi":99}"#);
        assert_eq!(value["action"], "skip");
        assert_eq!(value["reason"], "abi_mismatch");
    }

    #[test]
    fn valid_request_is_stubbed() {
        let value = call_route(r#"{"abi":1,"kind":"primary"}"#);
        assert_eq!(value["abi"], 1);
        assert_eq!(value["action"], "skip");
        assert_eq!(value["reason"], "not_implemented");
    }

    #[test]
    fn optimise_is_empty_plan() {
        let value = call_optimise(r#"{"abi":1,"messages":[]}"#);
        assert_eq!(value["abi"], 1);
        assert_eq!(value["plan"].as_array().map(Vec::len), Some(0));
        assert_eq!(value["stats"]["overflow"], false);
    }

    #[test]
    fn result_len_tracks_last_result() {
        let _ = call_route(r#"{"abi":1}"#);
        let len = result_len();
        assert!(len > 0);
    }
}
