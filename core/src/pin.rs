use crate::envelope::Envelope;
use crate::types::{Away, Candidate, CandidateSummary, ModelRef, Pin, Settings, Verdict};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Decide,
    Escalate,
}

pub struct Selection {
    pub chosen: ModelRef,
    pub pinned: bool,
    pub source: String,
    pub reason: String,
    pub top: Vec<CandidateSummary>,
    pub pin: Pin,
    pub switched: bool,
}

fn summary(candidate: &Candidate) -> CandidateSummary {
    CandidateSummary {
        provider_id: candidate.model.provider_id.clone(),
        id: candidate.model.model_id.clone(),
        variant: candidate.model.variant.clone(),
        score: (candidate.score * 1000.0).round() / 1000.0,
        cost_usd: (candidate.cost_usd * 1_000_000.0).round() / 1_000_000.0,
    }
}

fn top_candidates(
    candidates: &[Candidate],
    chosen: &ModelRef,
    limit: usize,
) -> Vec<CandidateSummary> {
    let mut top: Vec<CandidateSummary> = candidates.iter().take(limit).map(summary).collect();
    if !top
        .iter()
        .any(|entry| entry.provider_id == chosen.provider_id && entry.id == chosen.id)
    {
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| candidate.model.reference().same_model(chosen))
        {
            top.insert(0, summary(candidate));
        }
        top.truncate(limit);
    }
    top
}

fn is_blocked(pin: &Pin, model: &ModelRef, turns: usize) -> bool {
    let keep = turns.max(1);
    let start = pin.away.len().saturating_sub(keep);
    pin.away[start..]
        .iter()
        .any(|away| away.provider_id == model.provider_id && away.id == model.id)
}

fn choose(
    candidates: &[Candidate],
    mode: Mode,
    filter: impl Fn(&Candidate) -> bool,
) -> Option<Candidate> {
    let mut eligible: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| filter(candidate))
        .collect();
    if eligible.is_empty() {
        eligible = candidates.iter().collect();
    }
    let better = |left: &&Candidate, right: &&Candidate| {
        left.score
            .partial_cmp(&right.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .cost_usd
                    .partial_cmp(&left.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| right.model.limit.context.cmp(&left.model.limit.context))
            .then_with(|| right.model.label().cmp(&left.model.label()))
    };
    match mode {
        Mode::Decide => eligible.into_iter().max_by(better).cloned(),
        Mode::Escalate => eligible
            .into_iter()
            .max_by(|left, right| {
                left.quality
                    .partial_cmp(&right.quality)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        right
                            .cost_usd
                            .partial_cmp(&left.cost_usd)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            })
            .cloned(),
    }
}

/// Choose the model for this turn and return the next pin state.
#[allow(clippy::too_many_arguments)]
pub fn select(
    candidates: &[Candidate],
    envelope: &Envelope,
    verdict: &Verdict,
    settings: &Settings,
    pin: Option<&Pin>,
    now: f64,
    source: &str,
    mode: Mode,
) -> Selection {
    let mut state = pin.cloned().unwrap_or_default();
    if state.since == 0.0 {
        state.since = now;
    }

    let best = choose(candidates, mode, |_| true).expect("candidates are non-empty");
    let turnover = settings.pin.flip_flop_turns.max(1);
    let best_model = best.model.reference();
    let unblocked = if is_blocked(&state, &best_model, turnover) {
        choose(candidates, mode, |candidate| {
            !is_blocked(&state, &candidate.model.reference(), turnover)
        })
        .unwrap_or_else(|| best.clone())
    } else {
        best.clone()
    };
    let best = unblocked;

    let incumbent_ref = state.model.clone();
    let incumbent = incumbent_ref.as_ref().and_then(|reference| {
        candidates
            .iter()
            .find(|candidate| candidate.model.reference().same_model(reference))
    });

    let reason;
    let chosen_candidate: Option<Candidate>;
    let mut switched = false;

    if state.forced {
        let reference = incumbent_ref
            .clone()
            .unwrap_or_else(|| best.model.reference());
        state.last_turn_at = now;
        state.last_turn_class = envelope.turn_class.clone();
        state.last_complexity = verdict.complexity;
        state.source = if state.source.is_empty() {
            source.to_string()
        } else {
            state.source.clone()
        };
        let top = top_candidates(candidates, &reference, 3);
        return Selection {
            chosen: reference,
            pinned: true,
            source: "user".to_string(),
            reason: "forced".to_string(),
            top,
            pin: state,
            switched,
        };
    }

    match incumbent {
        None => {
            reason = if incumbent_ref.is_some() {
                "incumbent-missing".to_string()
            } else {
                "first-turn".to_string()
            };
            chosen_candidate = Some(best.clone());
            switched = true;
        }
        Some(current) => {
            let idle = settings.pin.idle_ttl_ms > 0.0
                && state.last_turn_at > 0.0
                && now - state.last_turn_at > settings.pin.idle_ttl_ms;
            let jump = state.last_complexity > 0
                && verdict.complexity.abs_diff(state.last_complexity) >= 2;
            let delta = best.score - current.score;
            let challenger_blocked = is_blocked(&state, &best.model.reference(), turnover);
            let keep = !idle && !jump && delta <= settings.pin.switch_threshold;
            if keep || (challenger_blocked && delta <= settings.pin.switch_threshold.max(0.0)) {
                state.last_turn_at = now;
                state.last_turn_class = envelope.turn_class.clone();
                state.last_complexity = verdict.complexity;
                return Selection {
                    chosen: current.model.reference(),
                    pinned: true,
                    source: "pin".to_string(),
                    reason: if jump {
                        "jump-kept".to_string()
                    } else {
                        "pin-kept".to_string()
                    },
                    top: top_candidates(candidates, &current.model.reference(), 3),
                    pin: state,
                    switched,
                };
            }
            reason = if idle {
                "idle-switch".to_string()
            } else if jump {
                "complexity-jump".to_string()
            } else {
                "better-model".to_string()
            };
            chosen_candidate = Some(best.clone());
            switched = true;
        }
    }

    let chosen_candidate = chosen_candidate.expect("a switch has a chosen candidate");
    if let Some(previous) = state.model.clone() {
        if !previous.same_model(&chosen_candidate.model.reference()) {
            state.away.push(Away {
                provider_id: previous.provider_id,
                id: previous.id,
                at: now,
            });
            let keep = turnover * 2;
            if state.away.len() > keep {
                let drain = state.away.len() - keep;
                state.away.drain(0..drain);
            }
        }
    }
    let chosen = chosen_candidate.model.reference();
    state.model = Some(chosen.clone());
    state.since = if state.since > 0.0 { state.since } else { now };
    state.switch_count = state.switch_count.saturating_add(1);
    state.last_turn_at = now;
    state.last_turn_class = envelope.turn_class.clone();
    state.last_complexity = verdict.complexity;
    state.source = source.to_string();
    state.forced = false;

    Selection {
        chosen: chosen.clone(),
        pinned: false,
        source: source.to_string(),
        reason,
        top: top_candidates(candidates, &chosen, 3),
        pin: state,
        switched,
    }
}

/// Return a forced selection without scoring (user override or explicit agent model).
pub fn forced(
    reference: ModelRef,
    source: &str,
    envelope: &Envelope,
    verdict: &Verdict,
    pin: Option<&Pin>,
    now: f64,
) -> Selection {
    let mut state = pin.cloned().unwrap_or_default();
    if state.since == 0.0 {
        state.since = now;
    }
    state.model = Some(reference.clone());
    state.forced = true;
    state.source = source.to_string();
    state.last_turn_at = now;
    state.last_turn_class = envelope.turn_class.clone();
    state.last_complexity = verdict.complexity;
    Selection {
        chosen: reference,
        pinned: true,
        source: source.to_string(),
        reason: "forced".to_string(),
        top: Vec::new(),
        pin: state,
        switched: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope;
    use crate::types::{CacheCost, Capabilities, CostTier, ModelLimits, PoolModel, TurnInfo};

    fn candidate(id: &str, score: f64, quality: f64, cost: f64) -> Candidate {
        Candidate {
            model: PoolModel {
                provider_id: "acme".to_string(),
                model_id: id.to_string(),
                name: id.to_string(),
                variant: None,
                local: false,
                cost: vec![CostTier {
                    tier: None,
                    input: cost,
                    output: cost,
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
                reasoning: false,
                status: "active".to_string(),
                quality_override: Some(quality),
                latency_override_ms: None,
            },
            score,
            cost_usd: cost,
            quality,
            required: 0.5,
        }
    }

    fn envelope() -> Envelope {
        envelope::build(&TurnInfo {
            prompt_text: "do the thing".to_string(),
            ..TurnInfo::default()
        })
    }

    fn verdict(complexity: u8) -> Verdict {
        Verdict {
            complexity,
            needs_tools: true,
            reasoning_need: "low".to_string(),
            ..Verdict::default()
        }
    }

    fn settings() -> Settings {
        Settings::default()
    }

    #[test]
    fn first_turn_takes_the_best() {
        let candidates = vec![candidate("a", 0.4, 0.5, 1.0), candidate("b", 0.9, 0.7, 2.0)];
        let selection = select(
            &candidates,
            &envelope(),
            &verdict(2),
            &settings(),
            None,
            1000.0,
            "judge",
            Mode::Decide,
        );
        assert_eq!(selection.chosen.id, "b");
        assert!(selection.switched);
        assert_eq!(selection.pin.switch_count, 1);
    }

    #[test]
    fn close_challenger_keeps_the_pin() {
        let candidates = vec![
            candidate("a", 0.80, 0.7, 1.0),
            candidate("b", 0.85, 0.7, 2.0),
        ];
        let pin = Pin {
            model: Some(candidates[0].model.reference()),
            since: 900.0,
            last_turn_at: 950.0,
            last_turn_class: "routine".to_string(),
            last_complexity: 2,
            ..Pin::default()
        };
        let selection = select(
            &candidates,
            &envelope(),
            &verdict(2),
            &settings(),
            Some(&pin),
            1000.0,
            "judge",
            Mode::Decide,
        );
        assert_eq!(selection.chosen.id, "a");
        assert!(selection.pinned);
        assert!(!selection.switched);
    }

    #[test]
    fn a_much_better_challenger_switches() {
        let candidates = vec![
            candidate("a", 0.40, 0.7, 1.0),
            candidate("b", 0.90, 0.7, 2.0),
        ];
        let pin = Pin {
            model: Some(candidates[0].model.reference()),
            since: 900.0,
            last_turn_at: 950.0,
            last_turn_class: "routine".to_string(),
            last_complexity: 2,
            ..Pin::default()
        };
        let selection = select(
            &candidates,
            &envelope(),
            &verdict(2),
            &settings(),
            Some(&pin),
            1000.0,
            "judge",
            Mode::Decide,
        );
        assert_eq!(selection.chosen.id, "b");
        assert!(selection.switched);
        assert_eq!(selection.pin.away.len(), 1);
    }

    #[test]
    fn missing_incumbent_switches() {
        let candidates = vec![candidate("a", 0.40, 0.7, 1.0)];
        let pin = Pin {
            model: Some(ModelRef {
                provider_id: "acme".to_string(),
                id: "gone".to_string(),
                variant: None,
            }),
            since: 900.0,
            last_turn_at: 950.0,
            ..Pin::default()
        };
        let selection = select(
            &candidates,
            &envelope(),
            &verdict(2),
            &settings(),
            Some(&pin),
            1000.0,
            "judge",
            Mode::Decide,
        );
        assert_eq!(selection.chosen.id, "a");
        assert!(selection.switched);
    }

    #[test]
    fn flip_flop_guard_avoids_the_recent_model() {
        let candidates = vec![
            candidate("a", 0.40, 0.7, 1.0),
            candidate("b", 0.90, 0.7, 2.0),
        ];
        let pin = Pin {
            model: Some(candidates[0].model.reference()),
            since: 900.0,
            last_turn_at: 950.0,
            last_turn_class: "routine".to_string(),
            last_complexity: 2,
            away: vec![Away {
                provider_id: "acme".to_string(),
                id: "b".to_string(),
                at: 940.0,
            }],
            ..Pin::default()
        };
        let selection = select(
            &candidates,
            &envelope(),
            &verdict(2),
            &settings(),
            Some(&pin),
            1000.0,
            "judge",
            Mode::Decide,
        );
        assert_eq!(selection.chosen.id, "a");
        assert!(selection.pinned);
    }

    #[test]
    fn forced_pin_wins() {
        let candidates = vec![candidate("a", 0.40, 0.7, 1.0)];
        let reference = candidates[0].model.reference();
        let pin = Pin {
            model: Some(reference.clone()),
            forced: true,
            ..Pin::default()
        };
        let selection = select(
            &candidates,
            &envelope(),
            &verdict(2),
            &settings(),
            Some(&pin),
            1000.0,
            "judge",
            Mode::Decide,
        );
        assert_eq!(selection.chosen.id, reference.id);
        assert!(selection.pin.forced);
    }

    #[test]
    fn idling_switches_back_to_the_best() {
        let candidates = vec![
            candidate("a", 0.40, 0.7, 1.0),
            candidate("b", 0.90, 0.7, 2.0),
        ];
        let pin = Pin {
            model: Some(candidates[0].model.reference()),
            since: 0.0,
            last_turn_at: 0.0,
            last_turn_class: "routine".to_string(),
            last_complexity: 2,
            ..Pin::default()
        };
        let selection = select(
            &candidates,
            &envelope(),
            &verdict(2),
            &settings(),
            Some(&pin),
            10_000_000.0,
            "judge",
            Mode::Decide,
        );
        assert_eq!(selection.chosen.id, "b");
        assert!(selection.switched);
    }
}
