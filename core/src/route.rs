use serde_json::{json, Value};

use crate::envelope::{self, Envelope};
use crate::judge;
use crate::pin::{self, Mode};
use crate::score;
use crate::triage;
use crate::types::{AgentPolicy, Candidate, Decision, RouteRequest, Stats, Verdict};
use crate::ABI_VERSION;

fn is_subagent(request: &RouteRequest) -> bool {
    request.role == "subagent"
}

fn agent_policy(request: &RouteRequest) -> Option<AgentPolicy> {
    if !is_subagent(request) || !request.settings.subagents.enabled {
        return None;
    }
    request
        .settings
        .subagents
        .agents
        .get(&request.session.agent_id)
        .cloned()
        .or_else(|| Some(request.settings.subagents.default.clone()))
}

fn policy_for(request: &RouteRequest, agent: Option<&AgentPolicy>) -> String {
    agent
        .and_then(|policy| policy.policy.clone())
        .unwrap_or_else(|| request.settings.policy.clone())
}

fn envelope_json(envelope: &Envelope) -> Value {
    json!({
        "turnClass": envelope.turn_class,
        "complexityHint": envelope.complexity_hint,
        "promptTokens": envelope.prompt_tokens,
        "estimatedInputTokens": envelope.estimated_input_tokens,
        "signals": envelope.signals,
    })
}

fn state_json(stats: &Stats) -> Value {
    json!({
        "decisions": stats.decisions,
        "switches": stats.switches,
    })
}

fn skip(request: &RouteRequest, envelope: &Envelope, reason: &str) -> Value {
    json!({
        "abi": ABI_VERSION,
        "action": "skip",
        "reason": reason,
        "envelope": envelope_json(envelope),
        "log": {
            "ts": request.now_ms,
            "host": request.host,
            "role": if is_subagent(request) { "subagent" } else { "root" },
            "agent": request.session.agent_id,
            "session": request.session.hash,
            "kind": request.kind,
            "stage": format!("skip/{reason}"),
            "reason": reason,
            "poolSize": request.pool.len(),
            "chosen": null,
            "pinned": false,
            "source": "skip",
            "judge": { "used": false, "cached": false, "confidence": 0.0 },
            "top": [],
            "optimiser": null,
            "applied": "none",
            "error": null,
            "turnClass": envelope.turn_class,
            "complexity": envelope.complexity_hint,
            "policy": request.settings.policy,
            "tokens": {
                "prompt": envelope.prompt_tokens,
                "estimatedInput": envelope.estimated_input_tokens,
            },
        },
        "state": state_json(&request.stats),
    })
}

fn need_judge(request: &RouteRequest, envelope: &Envelope) -> Value {
    let (prompt, cache_key) = judge::build(request, envelope);
    json!({
        "abi": ABI_VERSION,
        "action": "need_judge",
        "judgeRequest": {
            "prompt": prompt,
            "cacheKey": cache_key,
        },
        "pin": request.pin,
        "envelope": envelope_json(envelope),
        "state": state_json(&request.stats),
    })
}

fn decide(
    request: &RouteRequest,
    envelope: &Envelope,
    verdict: &Verdict,
    selection: pin::Selection,
    policy: &str,
) -> Value {
    let stats = Stats {
        decisions: request.stats.decisions + 1,
        switches: request.stats.switches + u64::from(selection.switched),
    };
    let decision = Decision {
        provider_id: selection.chosen.provider_id.clone(),
        id: selection.chosen.id.clone(),
        variant: selection.chosen.variant.clone(),
        source: selection.source.clone(),
        reason: selection.reason.clone(),
        pinned: selection.pinned,
        complexity: verdict.complexity,
        turn_class: envelope.turn_class.clone(),
        confidence: verdict.confidence,
        top: selection.top.clone(),
    };
    let log = json!({
        "ts": request.now_ms,
        "host": request.host,
        "role": if is_subagent(request) { "subagent" } else { "root" },
        "agent": request.session.agent_id,
        "session": request.session.hash,
        "kind": request.kind,
        "stage": format!("{}/{policy}", selection.source),
        "reason": selection.reason,
        "poolSize": request.pool.len(),
        "chosen": selection.chosen.label(),
        "pinned": selection.pinned,
        "source": selection.source,
        "judge": {
            "used": request.judge.verdict.is_some(),
            "cached": request.judge.cached,
            "confidence": verdict.confidence,
        },
        "verdict": {
            "task": verdict.task,
            "complexity": verdict.complexity,
            "needsTools": verdict.needs_tools,
            "needsVision": verdict.needs_vision,
            "contextNeed": verdict.context_need,
            "reasoningNeed": verdict.reasoning_need,
            "confidence": verdict.confidence,
        },
        "top": selection.top,
        "optimiser": null,
        "applied": "same-turn",
        "error": null,
        "turnClass": envelope.turn_class,
        "complexity": verdict.complexity,
        "policy": policy,
        "tokens": {
            "prompt": envelope.prompt_tokens,
            "estimatedInput": envelope.estimated_input_tokens,
        },
    });

    json!({
        "abi": ABI_VERSION,
        "action": "decide",
        "decision": decision,
        "pin": selection.pin,
        "log": log,
        "state": state_json(&stats),
        "envelope": envelope_json(envelope),
    })
}

fn forced_reference(
    request: &RouteRequest,
    agent: Option<&AgentPolicy>,
) -> Option<(crate::types::ModelRef, &'static str)> {
    if let Some(pin) = &request.pin {
        if pin.forced {
            if let Some(model) = pin
                .model
                .clone()
                .or_else(|| request.session.current_model.clone())
            {
                return Some((model, "user"));
            }
        }
    }
    if is_subagent(request)
        && request.settings.subagents.enabled
        && !request.settings.subagents.override_explicit_model
    {
        let _ = agent;
        if let Some(model) = request.session.agent_model.clone() {
            return Some((model, "agent"));
        }
    }
    None
}

fn rank_escalation(candidates: &mut [Candidate]) {
    candidates.sort_by(|left, right| {
        right
            .quality
            .partial_cmp(&left.quality)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.cost_usd
                    .partial_cmp(&right.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
}

pub fn handle(request: RouteRequest) -> Value {
    if request.abi != ABI_VERSION {
        return json!({
            "abi": ABI_VERSION,
            "action": "skip",
            "reason": "abi_mismatch",
        });
    }

    let envelope = envelope::build(&request.turn);

    if !request.settings.enabled {
        return skip(&request, &envelope, "disabled");
    }
    if is_subagent(&request) && !request.settings.subagents.enabled {
        return skip(&request, &envelope, "subagents_disabled");
    }
    if request.pool.is_empty() {
        return skip(&request, &envelope, "no_pool");
    }

    let agent = agent_policy(&request);
    let policy = policy_for(&request, agent.as_ref());

    let mut verdict = triage::heuristic(&envelope);
    let mut source = "heuristic";
    let mut mode = Mode::Decide;

    if envelope.signals.trivial {
        verdict = triage::trivial(&envelope);
        source = "triage";
    } else if request.turn.tool_failures >= 3 {
        verdict = triage::escalation();
        source = "escalation";
        mode = Mode::Escalate;
    } else if let Some(provided) = request.judge.verdict.clone() {
        verdict = triage::reconcile(triage::sanitize(provided), &envelope);
        source = "judge";
    }

    if let Some((reference, force_source)) = forced_reference(&request, agent.as_ref()) {
        let selection = pin::forced(
            reference,
            force_source,
            &envelope,
            &verdict,
            request.pin.as_ref(),
            request.now_ms,
        );
        return decide(&request, &envelope, &verdict, selection, &policy);
    }

    if source == "heuristic" && request.settings.judge.enabled && !request.judge.unavailable {
        return need_judge(&request, &envelope);
    }

    let context = score::ScoreContext {
        settings: &request.settings,
        verdict: &verdict,
        envelope: &envelope,
        pin: request.pin.as_ref(),
        agent: agent.as_ref(),
        parent: request.session.parent_model.as_ref(),
        policy: &policy,
    };
    let mut candidates = score::evaluate(&request.pool, &context);
    if candidates.is_empty() {
        return skip(&request, &envelope, "no_candidates");
    }
    if mode == Mode::Escalate {
        rank_escalation(&mut candidates);
    }

    let selection = pin::select(
        &candidates,
        &envelope,
        &verdict,
        &request.settings,
        request.pin.as_ref(),
        request.now_ms,
        source,
        mode,
    );
    decide(&request, &envelope, &verdict, selection, &policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AgentPolicy, CacheCost, Capabilities, CostTier, ModelLimits, Pin, PoolModel, SessionInfo,
        Settings, TurnInfo,
    };

    fn model(id: &str, input: f64, output: f64) -> PoolModel {
        PoolModel {
            provider_id: "acme".to_string(),
            model_id: id.to_string(),
            name: format!("{id} 8B"),
            cost: vec![CostTier {
                tier: None,
                input,
                output,
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
        }
    }

    fn request(pool: Vec<PoolModel>) -> RouteRequest {
        RouteRequest {
            abi: 1,
            now_ms: 1000.0,
            kind: "primary".to_string(),
            role: "root".to_string(),
            session: SessionInfo {
                agent_id: "build".to_string(),
                ..SessionInfo::default()
            },
            turn: TurnInfo {
                prompt_text: "implement the thing".to_string(),
                last_context_tokens: 2000,
                ..TurnInfo::default()
            },
            pool,
            settings: Settings::default(),
            judge: crate::types::JudgeInput {
                unavailable: true,
                ..crate::types::JudgeInput::default()
            },
            ..RouteRequest::default()
        }
    }

    #[test]
    fn empty_pool_skips() {
        let value = handle(request(Vec::new()));
        assert_eq!(value["action"], "skip");
        assert_eq!(value["reason"], "no_pool");
    }

    #[test]
    fn decides_with_a_heuristic() {
        let value = handle(request(vec![
            model("cheap", 0.1, 0.2),
            model("pricey", 5.0, 10.0),
        ]));
        assert_eq!(value["action"], "decide");
        assert_eq!(value["decision"]["providerID"], "acme");
        assert_eq!(value["decision"]["source"], "heuristic");
        assert!(value["decision"]["top"]
            .as_array()
            .is_some_and(|top| !top.is_empty()));
        assert_eq!(value["log"]["applied"], "same-turn");
    }

    #[test]
    fn decision_log_contains_the_effective_verdict() {
        let value = handle(request(vec![model("cheap", 0.1, 0.2)]));
        assert_eq!(value["action"], "decide");
        assert!(value["log"]["verdict"]["complexity"].as_u64().is_some());
        assert!(value["log"]["verdict"]["needsTools"].is_boolean());
        assert!(value["log"]["verdict"]["reasoningNeed"].is_string());
    }

    #[test]
    fn trivial_turn_is_triage() {
        let mut input = request(vec![model("cheap", 0.1, 0.2)]);
        input.turn.prompt_text = "what is this?".to_string();
        let value = handle(input);
        assert_eq!(value["action"], "decide");
        assert_eq!(value["decision"]["source"], "triage");
    }

    #[test]
    fn judge_is_requested_when_available() {
        let mut input = request(vec![model("cheap", 0.1, 0.2)]);
        input.judge.unavailable = false;
        let value = handle(input);
        assert_eq!(value["action"], "need_judge");
        assert!(value["judgeRequest"]["cacheKey"]
            .as_str()
            .is_some_and(|key| key.len() == 16));
        assert!(value["judgeRequest"]["prompt"]
            .as_str()
            .is_some_and(|text| text.contains("JSON")));
    }

    #[test]
    fn forced_user_pin_wins_without_scoring() {
        let mut input = request(vec![model("cheap", 0.1, 0.2), model("pricey", 5.0, 10.0)]);
        input.pin = Some(Pin {
            model: Some(crate::types::ModelRef {
                provider_id: "acme".to_string(),
                id: "pricey".to_string(),
                variant: None,
            }),
            forced: true,
            ..Pin::default()
        });
        let value = handle(input);
        assert_eq!(value["decision"]["id"], "pricey");
        assert_eq!(value["decision"]["source"], "user");
    }

    #[test]
    fn repeated_tool_failures_escalate() {
        let mut input = request(vec![model("cheap", 0.1, 0.2), model("pricey", 5.0, 10.0)]);
        input.turn.tool_failures = 3;
        input.turn.prompt_text = "continue".to_string();
        let value = handle(input);
        assert_eq!(value["decision"]["source"], "escalation");
        assert_eq!(value["decision"]["id"], "pricey");
    }

    #[test]
    fn subagent_policy_comes_from_agent_config() {
        let mut input = request(vec![model("cheap", 0.1, 0.2), model("pricey", 5.0, 10.0)]);
        input.role = "subagent".to_string();
        input.session.agent_id = "explore".to_string();
        input.settings.subagents.agents.insert(
            "explore".to_string(),
            AgentPolicy {
                policy: Some("quality".to_string()),
                quality_floor: Some(0.5),
                ..AgentPolicy::default()
            },
        );
        let value = handle(input);
        assert_eq!(value["log"]["policy"], "quality");
        assert_eq!(value["decision"]["source"], "heuristic");
    }

    #[test]
    fn explicit_agent_model_forces_without_judging() {
        let mut input = request(vec![model("cheap", 0.1, 0.2), model("pricey", 5.0, 10.0)]);
        input.role = "subagent".to_string();
        input.session.agent_id = "general".to_string();
        input.session.agent_model = Some(crate::types::ModelRef {
            provider_id: "acme".to_string(),
            id: "pricey".to_string(),
            variant: None,
        });
        input.judge.unavailable = false;
        let value = handle(input);
        assert_eq!(value["action"], "decide");
        assert_eq!(value["decision"]["id"], "pricey");
        assert_eq!(value["decision"]["source"], "agent");
    }

    #[test]
    fn disabled_and_subagent_toggles_skip() {
        let mut disabled = request(vec![model("cheap", 0.1, 0.2)]);
        disabled.settings.enabled = false;
        assert_eq!(handle(disabled)["reason"], "disabled");

        let mut subagent = request(vec![model("cheap", 0.1, 0.2)]);
        subagent.role = "subagent".to_string();
        subagent.settings.subagents.enabled = false;
        assert_eq!(handle(subagent)["reason"], "subagents_disabled");
    }
}
