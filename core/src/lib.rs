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

// `unsafe` is confined to the C ABI boundary below. Keep it that way: every
// other line of this crate must stay safe.
#![deny(unsafe_code)]

use std::slice;
use std::sync::Mutex;

use serde_json::{json, Value};

mod envelope;
mod judge;
mod optimise;
mod pin;
mod route;
mod score;
mod triage;
mod types;

pub const ABI_VERSION: u32 = 1;

/// Hard limits so a pathological request cannot exhaust host memory or time.
/// The host adapter enforces the same caps before calling in.
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_POOL: usize = 1024;
const MAX_MESSAGES: usize = 5_000;
const MAX_PARTS: usize = 50_000;

/// The last JSON result. The returned pointer stays valid until the next call.
static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate `len` bytes for the host to write a request into.
///
/// Returns null for a zero-length request; the host treats that as an error.
#[allow(unsafe_code)]
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
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Length in bytes of the last result.
#[allow(unsafe_code)]
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

#[allow(unsafe_code)]
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
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn route(ptr: *const u8, len: usize) -> *const u8 {
    if len > MAX_REQUEST_BYTES {
        return store(skip("too_large"));
    }
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
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn optimise(ptr: *const u8, len: usize) -> *const u8 {
    if len > MAX_REQUEST_BYTES {
        return store(empty_plan("too_large"));
    }
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

fn skip(reason: &str) -> Value {
    json!({ "abi": ABI_VERSION, "action": "skip", "reason": reason })
}

fn empty_plan(reason: &str) -> Value {
    json!({
        "abi": ABI_VERSION,
        "plan": [],
        "stats": {
            "beforeTokens": 0,
            "afterTokens": 0,
            "partsPruned": 0,
            "overflow": false,
        },
        "reason": reason,
    })
}

/// Structural caps: a request that would cost more than its worth is refused
/// before any allocation sized by its contents.
fn oversized(request: &Value) -> bool {
    let pool = request.get("pool").and_then(Value::as_array);
    if pool.is_some_and(|pool| pool.len() > MAX_POOL) {
        return true;
    }
    request
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages.len() > MAX_MESSAGES
                || messages
                    .iter()
                    .filter_map(|message| message.get("parts").and_then(Value::as_array))
                    .map(|parts| parts.len())
                    .sum::<usize>()
                    > MAX_PARTS
        })
}

fn handle_route(request: Value) -> Value {
    if request_abi(&request) != Some(u64::from(ABI_VERSION)) {
        return skip("abi_mismatch");
    }
    if oversized(&request) {
        return skip("too_large");
    }

    match serde_json::from_value::<types::RouteRequest>(request) {
        Ok(parsed) => route::handle(parsed),
        Err(error) => json!({
            "abi": ABI_VERSION,
            "action": "skip",
            "reason": "invalid_input",
            "error": error.to_string(),
        }),
    }
}

fn handle_optimise(request: Value) -> Value {
    if request_abi(&request) != Some(u64::from(ABI_VERSION)) {
        return empty_plan("abi_mismatch");
    }
    if oversized(&request) {
        return empty_plan("too_large");
    }

    match serde_json::from_value::<types::OptimiseRequest>(request) {
        Ok(parsed) => optimise::handle(parsed),
        Err(error) => {
            let mut value = empty_plan("invalid_input");
            value["error"] = json!(error.to_string());
            value
        }
    }
}

#[cfg(test)]
#[allow(unsafe_code)]
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
    fn valid_request_without_pool_skips() {
        let value = call_route(r#"{"abi":1,"kind":"primary"}"#);
        assert_eq!(value["abi"], 1);
        assert_eq!(value["action"], "skip");
        assert_eq!(value["reason"], "no_pool");
    }

    #[test]
    fn minimal_request_decides() {
        let input = r#"{
          "abi": 1,
          "nowMs": 1000,
          "kind": "primary",
          "role": "root",
          "turn": {"promptText": "implement the parser", "lastContextTokens": 2000},
          "pool": [{
            "providerID": "acme",
            "modelID": "m8",
            "name": "Acme 8B",
            "cost": [{"input": 1.0, "output": 2.0, "cache": {"read": 0.1, "write": 0.1}}],
            "limit": {"context": 100000, "output": 8192},
            "capabilities": {"tools": true, "input": ["text"], "output": ["text"]},
            "status": "active"
          }],
          "judge": {"unavailable": true}
        }"#;
        let value = call_route(input);
        assert_eq!(value["action"], "decide");
        assert_eq!(value["decision"]["providerID"], "acme");
        assert_eq!(value["decision"]["id"], "m8");
    }

    #[test]
    fn optimise_is_empty_plan() {
        let value = call_optimise(
            r#"{"abi":1,"messages":[],"model":{"limit":{"context":100000,"output":8192}}}"#,
        );
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

    #[test]
    fn requests_over_the_byte_cap_are_refused() {
        let value = call_route(&"a".repeat(1_500_000));
        assert_eq!(value["reason"], "too_large");
    }

    #[test]
    fn oversized_pools_are_refused() {
        let model = r#"{"providerID":"acme","modelID":"m","name":"M8B","cost":[],"limit":{"context":100000,"output":8192},"capabilities":{"tools":true,"input":["text"],"output":["text"]},"status":"active"}"#;
        let pool = vec![model; 2000].join(",");
        let input = format!(
            r#"{{"abi":1,"turn":{{"promptText":"hi","promptTokens":1}},"pool":[{pool}],"settings":{{}}}}"#
        );
        let value = call_route(&input);
        assert_eq!(value["reason"], "too_large");
    }

    #[test]
    fn oversized_transcripts_are_refused() {
        let part = r#"{"index":0,"type":"text","tokens":4}"#;
        let message = format!(r#"{{"index":0,"role":"assistant","parts":[{part}]}}"#);
        let messages = vec![message; 6_000].join(",");
        let input = format!(
            r#"{{"abi":1,"messages":[{messages}],"model":{{"limit":{{"context":100000,"output":8192}}}}}}"#
        );
        let value = call_optimise(&input);
        assert_eq!(value["reason"], "too_large");
        assert_eq!(value["plan"].as_array().map(Vec::len), Some(0));
    }
}
