use serde_json::{json, Value};

use crate::envelope::estimate_tokens;
use crate::types::{OptimiseRequest, OptimiseStats, PlanAction};
use crate::ABI_VERSION;

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn looks_like_error(text: &str) -> bool {
    let lowered = text.to_lowercase();
    ["error", "failed", "panic", "exception", "traceback"]
        .iter()
        .any(|marker| lowered.contains(marker))
}

fn placeholder_for(tool: &str, tokens: u64, label: &str, duplicate: bool) -> String {
    if duplicate {
        format!("[omlx-router: duplicate {tool} output, ~{tokens} tokens omitted]")
    } else if label.is_empty() {
        format!("[omlx-router: pruned {tool} output, ~{tokens} tokens omitted]")
    } else {
        format!(
            "[omlx-router: pruned {tool} output, ~{tokens} tokens omitted to fit {label} context]"
        )
    }
}

fn finish(plan: Vec<PlanAction>, before: u64, after: u64, overflow: bool) -> Value {
    let stats = OptimiseStats {
        before_tokens: before,
        after_tokens: after,
        parts_pruned: plan.len(),
        overflow,
    };
    json!({
        "abi": ABI_VERSION,
        "plan": plan,
        "stats": stats,
    })
}

struct Candidate<'a> {
    order: usize,
    message: usize,
    part: usize,
    tokens: u64,
    text: &'a str,
    tool: &'a str,
    planned: bool,
}

pub fn handle(request: OptimiseRequest) -> Value {
    if request.abi != ABI_VERSION {
        return json!({
            "abi": ABI_VERSION,
            "plan": [],
            "stats": OptimiseStats::default(),
            "reason": "abi_mismatch",
        });
    }

    let limit = &request.model.limit;
    if limit.context == 0 {
        let before = request.system_tokens
            + request
                .messages
                .iter()
                .flat_map(|message| message.parts.iter())
                .map(|part| part.tokens)
                .sum::<u64>();
        return finish(Vec::new(), before, before, true);
    }

    let reserve = request
        .settings
        .reserve_output_tokens
        .min(limit.output.max(1));
    let budget = limit
        .context
        .saturating_sub(reserve)
        .saturating_sub(request.settings.safety_tokens);

    let before = request.system_tokens
        + request
            .messages
            .iter()
            .flat_map(|message| message.parts.iter())
            .map(|part| part.tokens)
            .sum::<u64>();

    if before <= budget {
        return finish(Vec::new(), before, before, false);
    }
    if request.system_tokens >= budget {
        return finish(Vec::new(), before, before, true);
    }

    let protected_after = request
        .messages
        .len()
        .saturating_sub(request.settings.keep_recent_turns);
    let first_user = request
        .messages
        .iter()
        .position(|message| message.role == "user");

    let mut candidates: Vec<Candidate<'_>> = Vec::new();
    for (position, message) in request.messages.iter().enumerate() {
        let protected = message.role == "system"
            || position >= protected_after
            || first_user.is_some_and(|first| first == position);
        if protected {
            continue;
        }
        for part in &message.parts {
            if part.kind != "tool" || part.tokens == 0 {
                continue;
            }
            let Some(text) = part.text.as_deref() else {
                continue;
            };
            if text.is_empty() {
                continue;
            }
            candidates.push(Candidate {
                order: candidates.len(),
                message: message.index,
                part: part.index,
                tokens: part.tokens,
                text,
                tool: part.tool.as_deref().unwrap_or("tool"),
                planned: false,
            });
        }
    }

    if candidates.is_empty() {
        return finish(Vec::new(), before, before, true);
    }

    let mut plan: Vec<PlanAction> = Vec::new();
    let mut total = before;
    let label = request.model.label.as_str();

    // 1. Deduplicate identical tool outputs, keeping the newest.
    let mut latest: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        latest.insert(fnv1a(candidate.text.as_bytes()), index);
    }
    for (index, candidate) in candidates.iter().enumerate() {
        if latest.get(&fnv1a(candidate.text.as_bytes())) == Some(&index) {
            continue;
        }
        let placeholder = placeholder_for(candidate.tool, candidate.tokens, label, true);
        let replacement = estimate_tokens(&placeholder);
        if replacement >= candidate.tokens {
            continue;
        }
        total = total.saturating_sub(candidate.tokens - replacement);
        plan.push(PlanAction {
            message: candidate.message,
            part: candidate.part,
            action: "stub".to_string(),
            placeholder: Some(placeholder),
            ..PlanAction::default()
        });
    }
    if total <= budget {
        return finish(plan, before, total, false);
    }

    // 2. Truncate oversized outputs, newest first is irrelevant here.
    let max_tokens = request.settings.max_tool_tokens;
    if max_tokens > 0 {
        for candidate in candidates.iter_mut() {
            if plan
                .iter()
                .any(|action| action.message == candidate.message && action.part == candidate.part)
            {
                candidate.planned = true;
                continue;
            }
            if candidate.tokens <= max_tokens {
                continue;
            }
            let chars = candidate.text.chars().count();
            let target_chars =
                ((max_tokens as usize).saturating_mul(4)).min(chars.saturating_sub(1));
            if target_chars < 32 {
                continue;
            }
            let head_chars = target_chars * 6 / 10;
            let tail_chars = target_chars.saturating_sub(head_chars);
            let removed = candidate.tokens.saturating_sub(max_tokens);
            let marker = format!("\n\n[...truncated ~{removed} tokens...]\n\n");
            let replacement = max_tokens + estimate_tokens(&marker);
            if replacement >= candidate.tokens {
                continue;
            }
            total = total.saturating_sub(candidate.tokens - replacement);
            candidate.planned = true;
            plan.push(PlanAction {
                message: candidate.message,
                part: candidate.part,
                action: "truncate".to_string(),
                head_chars: Some(head_chars),
                tail_chars: Some(tail_chars),
                marker: Some(marker),
                ..PlanAction::default()
            });
            if total <= budget {
                return finish(plan, before, total, false);
            }
        }
    }

    // 3. Stub old outputs, largest first, keeping the newest N tool results.
    let keep = request.settings.keep_recent_tool_outputs;
    let mut old: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| !candidate.planned)
        .collect();
    old.sort_by_key(|candidate| candidate.order);
    let cut = old.len().saturating_sub(keep);
    let mut stubbable: Vec<&Candidate> = old.into_iter().take(cut).collect();
    stubbable.sort_by(|left, right| {
        right
            .tokens
            .cmp(&left.tokens)
            .then(left.order.cmp(&right.order))
    });

    for candidate in stubbable {
        let placeholder = placeholder_for(candidate.tool, candidate.tokens, label, false);
        let keep_head = if looks_like_error(candidate.text) {
            Some(200)
        } else {
            None
        };
        let mut replacement = estimate_tokens(&placeholder);
        if let Some(chars) = keep_head {
            let head: String = candidate.text.chars().take(chars).collect();
            replacement += estimate_tokens(&head);
        }
        if replacement >= candidate.tokens {
            continue;
        }
        total = total.saturating_sub(candidate.tokens - replacement);
        plan.push(PlanAction {
            message: candidate.message,
            part: candidate.part,
            action: "stub".to_string(),
            placeholder: Some(placeholder),
            keep_head_chars: keep_head,
            ..PlanAction::default()
        });
        if total <= budget {
            return finish(plan, before, total, false);
        }
    }

    // Cannot fit: do not apply a partial plan; let the host compact.
    finish(Vec::new(), before, before, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ModelLimits;
    use crate::types::{OptMessage, OptPart, OptimiseModel, OptimiseSettings};

    fn tool_message(index: usize, tool: &str, tokens: u64, text: &str) -> OptMessage {
        OptMessage {
            index,
            role: "assistant".to_string(),
            parts: vec![OptPart {
                index: 0,
                kind: "tool".to_string(),
                tool: Some(tool.to_string()),
                tokens,
                text: Some(text.to_string()),
            }],
        }
    }

    fn request(messages: Vec<OptMessage>, context: u64) -> OptimiseRequest {
        OptimiseRequest {
            abi: 1,
            model: OptimiseModel {
                label: "test/model".to_string(),
                limit: ModelLimits {
                    context,
                    output: 8192,
                },
            },
            settings: OptimiseSettings {
                reserve_output_tokens: 1024,
                safety_tokens: 0,
                max_tool_tokens: 2000,
                keep_recent_tool_outputs: 1,
                keep_recent_turns: 1,
            },
            messages,
            system_tokens: 0,
        }
    }

    #[test]
    fn under_budget_is_a_no_op() {
        let value = handle(request(
            vec![tool_message(0, "read", 100, "short")],
            100_000,
        ));
        assert_eq!(value["plan"].as_array().map(Vec::len), Some(0));
        assert_eq!(value["stats"]["overflow"], false);
        assert_eq!(
            value["stats"]["beforeTokens"],
            value["stats"]["afterTokens"]
        );
    }

    #[test]
    fn oversized_output_is_truncated() {
        let text = "x".repeat(40_000);
        let mut input = request(vec![tool_message(0, "read", 10_000, &text)], 8_000);
        input.settings.keep_recent_turns = 0;
        let value = handle(input);
        let plan = value["plan"].as_array().unwrap();
        assert_eq!(plan[0]["action"], "truncate");
        assert!(plan[0]["headChars"].as_u64().unwrap() > 0);
        assert_eq!(value["stats"]["overflow"], false);
        assert!((value["stats"]["afterTokens"].as_u64().unwrap()) <= 8_000);
    }

    #[test]
    fn duplicate_outputs_collapse_to_the_newest() {
        let text = "identical output";
        let messages = vec![
            tool_message(0, "read", 1000, text),
            tool_message(1, "read", 1000, text),
        ];
        let mut input = request(messages, 1_300);
        input.settings.keep_recent_tool_outputs = 2;
        input.settings.keep_recent_turns = 0;
        for message in input.messages.iter_mut() {
            message.parts[0].tokens = 200;
        }
        let value = handle(input);
        assert_eq!(value["plan"].as_array().map(Vec::len), Some(1));
        assert_eq!(value["stats"]["overflow"], false);
    }

    #[test]
    fn old_outputs_are_stubbed_before_recent_ones() {
        let messages: Vec<OptMessage> = (0..6)
            .map(|index| tool_message(index, "read", 1500, &format!("output-{index}")))
            .collect();
        let mut input = request(messages, 6_000);
        input.settings.keep_recent_tool_outputs = 2;
        input.settings.keep_recent_turns = 0;
        input.model.limit.context = 5_500;
        let value = handle(input);
        let plan = value["plan"].as_array().unwrap();
        assert!(!plan.is_empty());
        assert_eq!(plan[0]["action"], "stub");
        // Newest messages must not be stubbed.
        let stubbed: Vec<u64> = plan
            .iter()
            .filter_map(|action| action["message"].as_u64())
            .collect();
        assert!(!stubbed.contains(&4));
        assert!(!stubbed.contains(&5));
    }

    #[test]
    fn user_and_recent_messages_are_protected() {
        let mut input = request(
            vec![
                OptMessage {
                    index: 0,
                    role: "user".to_string(),
                    parts: vec![OptPart {
                        index: 0,
                        kind: "text".to_string(),
                        tool: None,
                        tokens: 100,
                        text: Some("user text".to_string()),
                    }],
                },
                tool_message(1, "read", 5000, &"x".repeat(40_000)),
            ],
            4_000,
        );
        input.settings.keep_recent_turns = 0;
        let value = handle(input);
        let plan = value["plan"].as_array().unwrap();
        assert!(!plan.is_empty());
        assert!(plan
            .iter()
            .all(|action| action["message"].as_u64() == Some(1)));
    }

    #[test]
    fn cannot_fit_returns_overflow_without_a_plan() {
        let mut input = request(vec![tool_message(0, "read", 10_000, "x")], 4_000);
        input.system_tokens = 5_000;
        let value = handle(input);
        assert_eq!(value["stats"]["overflow"], true);
        assert_eq!(value["plan"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn error_outputs_keep_a_prefix() {
        let _ = looks_like_error("Error: failed to parse");
        assert!(looks_like_error("panic: bad"));
        assert!(!looks_like_error("all good"));
    }
}
