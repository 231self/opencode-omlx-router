//! Token estimation shared by the optimiser.
//!
//! Mirrors `@231self/opencode-shared/tokens.js` (`estimateTokens`) and the
//! router core's `envelope::estimate_tokens`; keep the three in sync.

/// Approximate token count: ASCII at ~4 chars/token, CJK at ~1.6 chars/token.
pub fn estimate_tokens(text: &str) -> u64 {
    let mut ascii = 0u64;
    let mut wide = 0u64;
    for character in text.chars() {
        if (character as u32) >= 0x2E80 {
            wide += 1;
        } else {
            ascii += 1;
        }
    }
    ((ascii as f64 / 4.0) + (wide as f64 / 1.6)).ceil() as u64
}
