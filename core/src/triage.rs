use crate::envelope::Envelope;
use crate::types::Verdict;

pub const TASKS: &[&str] = &[
    "trivial", "edit", "debug", "refactor", "plan", "research", "review", "ui",
];
pub const REASONING: &[&str] = &["low", "medium", "high"];
pub const CONTEXT: &[&str] = &["small", "medium", "large"];

/// Deterministic verdict used when the judge is disabled, fails, or is skipped.
pub fn heuristic(envelope: &Envelope) -> Verdict {
    let signals = &envelope.signals;
    let task = if envelope.turn_class == "trivial" {
        "trivial"
    } else if signals.review {
        "review"
    } else if signals.planning {
        "plan"
    } else if signals.error_trace {
        "debug"
    } else if signals.code {
        "edit"
    } else {
        "research"
    };

    let reasoning_need = if signals.planning
        || signals.review
        || signals.error_trace
        || envelope.complexity_hint >= 4
    {
        "high"
    } else if envelope.complexity_hint >= 3 {
        "medium"
    } else {
        "low"
    };

    let context_need = if envelope.estimated_input_tokens > 60_000 {
        "large"
    } else if envelope.estimated_input_tokens > 15_000 {
        "medium"
    } else {
        "small"
    };

    Verdict {
        task: task.to_string(),
        complexity: envelope.complexity_hint.clamp(1, 5),
        needs_tools: envelope.turn_class != "trivial" || signals.code || signals.agentic,
        needs_vision: signals.has_images,
        context_need: context_need.to_string(),
        reasoning_need: reasoning_need.to_string(),
        confidence: 0.35,
    }
}

/// Escalation verdict after repeated identical tool failures.
pub fn escalation() -> Verdict {
    Verdict {
        task: "debug".to_string(),
        complexity: 5,
        needs_tools: true,
        needs_vision: false,
        context_need: "large".to_string(),
        reasoning_need: "high".to_string(),
        confidence: 0.6,
    }
}

/// Clamp and normalise a verdict from any source.
pub fn sanitize(mut verdict: Verdict) -> Verdict {
    verdict.complexity = verdict.complexity.clamp(1, 5);
    verdict.confidence = verdict.confidence.clamp(0.0, 1.0);
    if !TASKS.contains(&verdict.task.as_str()) {
        verdict.task = "edit".to_string();
    }
    if !REASONING.contains(&verdict.reasoning_need.as_str()) {
        verdict.reasoning_need = "medium".to_string();
    }
    if !CONTEXT.contains(&verdict.context_need.as_str()) {
        verdict.context_need = "medium".to_string();
    }
    verdict
}

fn severity(value: &str) -> u8 {
    match value {
        "high" => 3,
        "medium" => 2,
        _ => 1,
    }
}

fn context_severity(value: &str) -> u8 {
    match value {
        "large" => 3,
        "medium" => 2,
        _ => 1,
    }
}

/// Never let a weak judge downgrade the deterministic signals. The judge adds
/// nuance, but code, errors, planning, review, and large context set a floor.
pub fn reconcile(mut verdict: Verdict, envelope: &Envelope) -> Verdict {
    let heuristic = heuristic(envelope);
    verdict.complexity = verdict.complexity.max(heuristic.complexity).clamp(1, 5);
    if severity(&heuristic.reasoning_need) > severity(&verdict.reasoning_need) {
        verdict.reasoning_need = heuristic.reasoning_need;
    }
    if context_severity(&heuristic.context_need) > context_severity(&verdict.context_need) {
        verdict.context_need = heuristic.context_need;
    }
    verdict.needs_tools |= heuristic.needs_tools;
    if verdict.task == "trivial" && envelope.turn_class != "trivial" {
        verdict.task = heuristic.task;
    }
    verdict
}

/// For trivial turns, force a cheap classification.
pub fn trivial(envelope: &Envelope) -> Verdict {
    Verdict {
        task: "trivial".to_string(),
        complexity: 1,
        needs_tools: false,
        needs_vision: envelope.signals.has_images,
        context_need: "small".to_string(),
        reasoning_need: "low".to_string(),
        confidence: 0.5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope;
    use crate::types::TurnInfo;

    #[test]
    fn heuristic_is_agentic_for_code() {
        let envelope = envelope::build(&TurnInfo {
            prompt_text: "fix src/main.rs".to_string(),
            ..TurnInfo::default()
        });
        let verdict = heuristic(&envelope);
        assert_eq!(verdict.task, "edit");
        assert!(verdict.needs_tools);
        assert!(verdict.complexity >= 2);
    }

    #[test]
    fn sanitize_clamps_and_repairs() {
        let verdict = sanitize(Verdict {
            task: "nonsense".to_string(),
            complexity: 42,
            confidence: 9.0,
            reasoning_need: "extreme".to_string(),
            ..Verdict::default()
        });
        assert_eq!(verdict.complexity, 5);
        assert_eq!(verdict.confidence, 1.0);
        assert_eq!(verdict.task, "edit");
        assert_eq!(verdict.reasoning_need, "medium");
    }

    #[test]
    fn reconcile_raises_judge_underclassification() {
        let envelope = envelope::build(&TurnInfo {
            prompt_text: "Debug the panic in src/lexer.rs and add a test".to_string(),
            ..TurnInfo::default()
        });
        let lowered = Verdict {
            task: "debug".to_string(),
            complexity: 1,
            needs_tools: false,
            context_need: "small".to_string(),
            reasoning_need: "low".to_string(),
            confidence: 0.9,
            ..Verdict::default()
        };
        let verdict = reconcile(lowered, &envelope);
        assert!(verdict.complexity >= 3);
        assert_eq!(verdict.reasoning_need, "high");
        assert!(verdict.needs_tools);
    }

    #[test]
    fn reconcile_raises_review_and_planning_underclassification() {
        let review_envelope = envelope::build(&TurnInfo {
            prompt_text: "Review src/auth.rs for security issues".to_string(),
            ..TurnInfo::default()
        });
        let review = reconcile(
            Verdict {
                task: "review".to_string(),
                complexity: 1,
                needs_tools: false,
                context_need: "small".to_string(),
                reasoning_need: "low".to_string(),
                confidence: 0.9,
                ..Verdict::default()
            },
            &review_envelope,
        );
        assert!(review.complexity >= 3);
        assert_eq!(review.reasoning_need, "high");
        assert!(review.needs_tools);

        let planning_envelope = envelope::build(&TurnInfo {
            prompt_text: "Design a migration plan for src/parse.rs".to_string(),
            ..TurnInfo::default()
        });
        let planning = reconcile(
            Verdict {
                task: "plan".to_string(),
                complexity: 1,
                needs_tools: false,
                context_need: "small".to_string(),
                reasoning_need: "low".to_string(),
                confidence: 0.9,
                ..Verdict::default()
            },
            &planning_envelope,
        );
        assert!(planning.complexity >= 3);
        assert_eq!(planning.reasoning_need, "high");
        assert!(planning.needs_tools);
    }

    #[test]
    fn reconcile_lifts_large_context() {
        let envelope = envelope::build(&TurnInfo {
            prompt_text: "continue the refactor".to_string(),
            last_context_tokens: 90_000,
            ..TurnInfo::default()
        });
        let lowered = Verdict {
            task: "refactor".to_string(),
            complexity: 1,
            context_need: "small".to_string(),
            reasoning_need: "low".to_string(),
            ..Verdict::default()
        };
        let verdict = reconcile(lowered, &envelope);
        assert!(verdict.complexity >= 3);
        assert_eq!(verdict.context_need, "large");
    }

    #[test]
    fn reconcile_keeps_a_simple_turn_simple() {
        let envelope = envelope::build(&TurnInfo {
            prompt_text: "what is this?".to_string(),
            ..TurnInfo::default()
        });
        let judged = Verdict {
            task: "research".to_string(),
            complexity: 1,
            context_need: "small".to_string(),
            reasoning_need: "low".to_string(),
            ..Verdict::default()
        };
        let verdict = reconcile(judged, &envelope);
        assert_eq!(verdict.complexity, 1);
        assert_eq!(verdict.reasoning_need, "low");
    }

    #[test]
    fn escalation_is_maximal() {
        let verdict = escalation();
        assert_eq!(verdict.complexity, 5);
        assert_eq!(verdict.reasoning_need, "high");
        assert!(verdict.needs_tools);
    }
}
