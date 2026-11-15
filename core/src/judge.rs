use crate::envelope::Envelope;
use crate::types::RouteRequest;

const PROMPT_BUDGET_CHARS: usize = 1200;

/// FNV-1a; no dependency and stable across platforms.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn fingerprint(text: &str) -> String {
    let lowered = text.to_lowercase();
    let bytes = lowered.as_bytes();
    let mut sample = Vec::with_capacity(bytes.len().min(4096) + 16);
    sample.extend_from_slice(&bytes[..bytes.len().min(4096)]);
    if bytes.len() > 4096 {
        sample.extend_from_slice(&bytes[bytes.len().saturating_sub(1024)..]);
    }
    sample.extend_from_slice(format!("|{}", bytes.len()).as_bytes());
    format!("{:016x}", fnv1a(&sample))
}

fn summarise(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut summary: String = collapsed.chars().take(PROMPT_BUDGET_CHARS).collect();
    if collapsed.chars().count() > PROMPT_BUDGET_CHARS {
        summary.push('…');
    }
    summary.replace('"', "'")
}

fn model_row(model: &crate::types::PoolModel, index: usize) -> String {
    let price = model.cost.first();
    let input = price.map_or(0.0, |tier| tier.input);
    let output = price.map_or(0.0, |tier| tier.output);
    format!(
        "{}. {}/{} ({}): context={}, tools={}, vision={}, in=${:.2}/M, out=${:.2}/M, local={}",
        index + 1,
        model.provider_id,
        model.model_id,
        model.name,
        model.limit.context,
        if model.capabilities.tools {
            "yes"
        } else {
            "no"
        },
        if model.capabilities.input.iter().any(|kind| kind == "image") {
            "yes"
        } else {
            "no"
        },
        input,
        output,
        if model.local { "yes" } else { "no" },
    )
}

/// Build the judge prompt and its cache key. The prompt contains at most a
/// truncated turn summary and the candidate table; never the full transcript.
pub fn build(request: &RouteRequest, envelope: &Envelope) -> (String, String) {
    let signals = &envelope.signals;
    let max_models = request.settings.pool.max_models.max(1);
    let rows: Vec<String> = request
        .pool
        .iter()
        .take(max_models)
        .enumerate()
        .map(|(index, model)| model_row(model, index))
        .collect();

    let prompt = format!(
        "You classify one turn for a coding agent. Reply with JSON only, no prose.\n\
\n\
Rules:\n\
- complexity 1=one-line question, 2=small edit, 3=multi-file change, 4=hard debugging or design, 5=deep research or large refactor.\n\
- needsTools=true for file, shell, test, or repo work.\n\
- needsVision only when images are present.\n\
- contextNeed: small under 15k tokens, medium 15k-60k, large over 60k.\n\
- reasoningNeed: low for direct answers, medium for edits, high for debugging, design, or security.\n\
- Choose values for the actual turn. Do not copy the example values.\n\
\n\
Examples:\n\
Turn: \"What does the --verbose flag do?\"\n\
Output: {{\"task\":\"research\",\"complexity\":1,\"needsTools\":false,\"needsVision\":false,\"contextNeed\":\"small\",\"reasoningNeed\":\"low\",\"confidence\":0.9}}\n\
Turn: \"Debug the panic in src/lexer.rs and add a regression test.\"\n\
Output: {{\"task\":\"debug\",\"complexity\":4,\"needsTools\":true,\"needsVision\":false,\"contextNeed\":\"small\",\"reasoningNeed\":\"high\",\"confidence\":0.9}}\n\
\n\
Turn: \"{}\"\n\
Signals: prompt_tokens={}, last_context_tokens={}, images={}, tool_failures={}, turn_class_hint={}, code={}, error={}, planning={}, review={}\n\
\n\
Models available (context only; do not choose one):\n{}\n\
\n\
JSON schema:\n\
{{\"task\":\"trivial|edit|debug|refactor|plan|research|review|ui\",\"complexity\":1,\"needsTools\":true,\"needsVision\":false,\"contextNeed\":\"small|medium|large\",\"reasoningNeed\":\"low|medium|high\",\"confidence\":0.0}}",
        summarise(&request.turn.prompt_text),
        envelope.prompt_tokens,
        request.turn.last_context_tokens,
        request.turn.images,
        request.turn.tool_failures,
        request.turn.turn_class_hint.as_deref().unwrap_or("none"),
        signals.code,
        signals.error_trace,
        signals.planning,
        signals.review,
        if rows.is_empty() {
            "(none)".to_string()
        } else {
            rows.join("\n")
        },
    );

    let pool_ids: String = request
        .pool
        .iter()
        .take(max_models)
        .map(|model| model.label())
        .collect::<Vec<_>>()
        .join(",");
    let cache_key = format!(
        "{:016x}",
        fnv1a(
            format!(
                "{}|{}|{}|{}|{}|{}|{}",
                request.kind,
                request.role,
                request.session.agent_id,
                request.settings.policy,
                fingerprint(&request.turn.prompt_text),
                pool_ids,
                request.turn.last_context_tokens,
            )
            .as_bytes()
        )
    );

    (prompt, cache_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope;
    use crate::types::{CacheCost, Capabilities, CostTier, ModelLimits, PoolModel, TurnInfo};

    fn request(text: &str) -> RouteRequest {
        RouteRequest {
            abi: 1,
            kind: "primary".to_string(),
            role: "root".to_string(),
            session: crate::types::SessionInfo {
                agent_id: "build".to_string(),
                ..crate::types::SessionInfo::default()
            },
            turn: TurnInfo {
                prompt_text: text.to_string(),
                ..TurnInfo::default()
            },
            pool: vec![PoolModel {
                provider_id: "acme".to_string(),
                model_id: "small".to_string(),
                name: "Small 4B".to_string(),
                cost: vec![CostTier {
                    tier: None,
                    input: 1.0,
                    output: 2.0,
                    cache: CacheCost::default(),
                }],
                limit: ModelLimits {
                    context: 100_000,
                    output: 8192,
                },
                capabilities: Capabilities {
                    tools: true,
                    input: vec!["text".to_string()],
                    output: vec!["text".to_string()],
                },
                status: "active".to_string(),
                ..PoolModel::default()
            }],
            ..RouteRequest::default()
        }
    }

    #[test]
    fn prompt_contains_schema_and_truncated_turn() {
        let request = request(&"x".repeat(2000));
        let envelope = envelope::build(&request.turn);
        let (prompt, _) = build(&request, &envelope);
        assert!(prompt.contains("JSON schema"));
        assert!(prompt.contains("Examples:"));
        assert!(prompt.contains("Do not copy"));
        assert!(prompt.contains("acme/small"));
        assert!(prompt.chars().count() < 3000);
    }

    #[test]
    fn cache_key_is_stable_and_prompt_sensitive() {
        let first = request("add a flag");
        let second = request("add a flag");
        let third = request("fix the parser");
        let key = |req: &RouteRequest| build(req, &envelope::build(&req.turn)).1;
        assert_eq!(key(&first), key(&second));
        assert_ne!(key(&first), key(&third));
    }
}
