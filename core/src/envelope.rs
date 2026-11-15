use crate::types::TurnInfo;

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signals {
    pub code: bool,
    pub agentic: bool,
    pub error_trace: bool,
    pub planning: bool,
    pub review: bool,
    pub trivial: bool,
    pub has_images: bool,
    pub large_context: bool,
    pub repeated_failures: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub turn_class: String,
    pub complexity_hint: u8,
    pub prompt_tokens: u64,
    pub estimated_input_tokens: u64,
    pub signals: Signals,
}

const CODE_MARKERS: &[&str] = &[
    "```", ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".kt", ".swift", ".c", ".h",
    ".cpp", ".rb", ".sh", "cargo ", "bun ", "npm ", "git ",
];

const ERROR_MARKERS: &[&str] = &[
    "panic",
    "traceback",
    "stack trace",
    "exception",
    "error:",
    "failed",
    "failure",
    "exit code",
    "segfault",
    "typeerror",
    "referenceerror",
];

const AGENTIC_MARKERS: &[&str] = &[
    "implement",
    "fix",
    "refactor",
    "migrate",
    "debug",
    "investigate",
    "add ",
    "change ",
    "update ",
    "remove ",
    "rename ",
    "run ",
    "build ",
    "test ",
    "write ",
];

const PLANNING_MARKERS: &[&str] = &[
    "plan",
    "design",
    "architect",
    "approach",
    "strategy",
    "trade-off",
    "tradeoff",
    "proposal",
    "spec",
    "specification",
];

const REVIEW_MARKERS: &[&str] = &[
    "review",
    "audit",
    "critique",
    "code smell",
    "look for bugs",
    "check for",
    "security",
];

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn contains_word(haystack: &str, word: &str) -> bool {
    haystack
        .split(|character: char| !character.is_alphanumeric() && character != '-')
        .any(|token| token == word)
}

/// Word-like markers match whole tokens; punctuation and phrases use substring
/// matching. Without this, `Inspect` would match `spec` and `prefix` would
/// match `fix`.
fn contains_marker(haystack: &str, marker: &str) -> bool {
    if marker.chars().all(|character| character.is_alphanumeric()) {
        contains_word(haystack, marker)
    } else {
        haystack.contains(marker)
    }
}

fn contains_any_marker(haystack: &str, needles: &[&str]) -> bool {
    needles
        .iter()
        .any(|needle| contains_marker(haystack, needle))
}

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

pub fn build(turn: &TurnInfo) -> Envelope {
    let text = turn.prompt_text.to_lowercase();
    let prompt_tokens = turn
        .prompt_tokens
        .unwrap_or_else(|| estimate_tokens(&turn.prompt_text));
    let estimated_input_tokens = prompt_tokens + turn.last_context_tokens;

    let signals = Signals {
        code: contains_any(&text, CODE_MARKERS),
        agentic: contains_any_marker(&text, AGENTIC_MARKERS),
        error_trace: contains_any_marker(&text, ERROR_MARKERS),
        planning: contains_any_marker(&text, PLANNING_MARKERS),
        review: contains_any_marker(&text, REVIEW_MARKERS),
        trivial: false,
        has_images: turn.images > 0,
        large_context: estimated_input_tokens > 60_000,
        repeated_failures: turn.tool_failures >= 3,
    };

    let trivial = prompt_tokens < 150
        && turn.tool_failures == 0
        && !signals.code
        && !signals.agentic
        && !signals.error_trace
        && !signals.planning
        && !signals.review
        && !signals.has_images
        && turn.last_context_tokens < 8_000;

    let signals = Signals { trivial, ..signals };

    let turn_class = if trivial {
        "trivial"
    } else if signals.review {
        "review"
    } else if signals.planning {
        "planning"
    } else if turn
        .turn_class_hint
        .as_deref()
        .is_some_and(|hint| hint == "tool_continuation")
    {
        "tool_continuation"
    } else if signals.repeated_failures || signals.error_trace || signals.code || signals.agentic {
        "agentic"
    } else {
        "routine"
    };

    let mut complexity = 1u8;
    complexity += u8::from(signals.code);
    complexity += u8::from(signals.agentic);
    complexity += u8::from(signals.error_trace);
    complexity += u8::from(signals.planning || signals.review);
    complexity += u8::from(estimated_input_tokens > 8_000);
    complexity += u8::from(turn.tool_failures > 0);
    complexity = complexity.clamp(1, 5);

    Envelope {
        turn_class: turn_class.to_string(),
        complexity_hint: complexity,
        prompt_tokens,
        estimated_input_tokens,
        signals,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(text: &str) -> TurnInfo {
        TurnInfo {
            prompt_text: text.to_string(),
            ..TurnInfo::default()
        }
    }

    #[test]
    fn estimates_ascii_and_cjk() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert!(estimate_tokens("日本語のテキスト") >= 4);
    }

    #[test]
    fn short_question_is_trivial() {
        let envelope = build(&turn("what does this flag do?"));
        assert_eq!(envelope.turn_class, "trivial");
        assert!(envelope.signals.trivial);
    }

    #[test]
    fn code_edit_is_agentic() {
        let envelope = build(&turn("fix the bug in src/main.rs and run cargo test"));
        assert_eq!(envelope.turn_class, "agentic");
        assert!(envelope.signals.code);
        assert!(envelope.signals.agentic);
    }

    #[test]
    fn planning_wins_over_agentic() {
        let envelope = build(&turn(
            "design an approach and plan the refactor of src/lib.rs",
        ));
        assert_eq!(envelope.turn_class, "planning");
    }

    #[test]
    fn markers_use_word_boundaries() {
        let inspect = build(&turn("Inspect the files"));
        assert!(!inspect.signals.planning);
        let prefix = build(&turn("prefix the string"));
        assert!(!prefix.signals.agentic);
        let preview = build(&turn("preview the diff"));
        assert!(!preview.signals.review);
        let design = build(&turn("design the API"));
        assert!(design.signals.planning);
        let specification = build(&turn("write the specification"));
        assert!(specification.signals.planning);
        let review = build(&turn("review the code"));
        assert!(review.signals.review);
    }

    #[test]
    fn review_and_planning_raise_complexity() {
        let review = build(&turn("review the authentication middleware in src/auth.rs"));
        assert!(review.signals.review);
        assert!(review.complexity_hint >= 3);
        let planning = build(&turn("design a migration plan for src/parse.rs"));
        assert!(planning.signals.planning);
        assert!(planning.complexity_hint >= 3);
    }

    #[test]
    fn error_trace_raises_complexity() {
        let envelope = build(&turn("panic: index out of bounds in parser.rs"));
        assert!(envelope.signals.error_trace);
        assert!(envelope.complexity_hint >= 3);
    }

    #[test]
    fn images_are_never_trivial() {
        let mut input = turn("hi");
        input.images = 1;
        assert_ne!(build(&input).turn_class, "trivial");
    }

    #[test]
    fn failed_tools_are_agentic() {
        let mut input = turn("continue");
        input.tool_failures = 3;
        let envelope = build(&input);
        assert_eq!(envelope.turn_class, "agentic");
        assert!(envelope.signals.repeated_failures);
    }
}
