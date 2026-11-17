use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RouteRequest {
    pub abi: u32,
    pub now_ms: f64,
    pub host: String,
    pub kind: String,
    pub role: String,
    pub session: SessionInfo,
    pub turn: TurnInfo,
    pub pool: Vec<PoolModel>,
    pub settings: Settings,
    pub pin: Option<Pin>,
    pub judge: JudgeInput,
    pub stats: Stats,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionInfo {
    pub hash: String,
    pub parent_hash: Option<String>,
    #[serde(rename = "agentID")]
    pub agent_id: String,
    pub agent_mode: String,
    pub agent_model: Option<ModelRef>,
    pub current_model: Option<ModelRef>,
    pub parent_model: Option<ModelRef>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnInfo {
    pub prompt_text: String,
    pub prompt_tokens: Option<u64>,
    pub images: u32,
    pub last_context_tokens: u64,
    pub tool_failures: u32,
    pub turn_class_hint: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    pub variant: Option<String>,
}

impl ModelRef {
    pub fn label(&self) -> String {
        match &self.variant {
            Some(variant) if variant != "default" => {
                format!("{}/{}#{}", self.provider_id, self.id, variant)
            }
            _ => format!("{}/{}", self.provider_id, self.id),
        }
    }

    pub fn same_model(&self, other: &ModelRef) -> bool {
        self.provider_id == other.provider_id && self.id == other.id
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PoolModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
    pub name: String,
    pub variant: Option<String>,
    pub local: bool,
    pub cost: Vec<CostTier>,
    pub limit: ModelLimits,
    pub capabilities: Capabilities,
    pub reasoning: bool,
    pub status: String,
    pub quality_override: Option<f64>,
    pub latency_override_ms: Option<f64>,
}

impl PoolModel {
    pub fn reference(&self) -> ModelRef {
        ModelRef {
            provider_id: self.provider_id.clone(),
            id: self.model_id.clone(),
            variant: self.variant.clone(),
        }
    }

    pub fn label(&self) -> String {
        format!("{}/{}", self.provider_id, self.model_id)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelLimits {
    pub context: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub tools: bool,
    pub input: Vec<String>,
    pub output: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CostTier {
    pub tier: Option<CostTierDef>,
    pub input: f64,
    pub output: f64,
    pub cache: CacheCost,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CostTierDef {
    pub size: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CacheCost {
    pub read: f64,
    pub write: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WeightOverride {
    pub cost: Option<f64>,
    pub quality: Option<f64>,
    pub latency: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub policy: String,
    pub policy_weights: Option<WeightOverride>,
    pub policy_by_class: std::collections::BTreeMap<String, WeightOverride>,
    pub pool: PoolSettings,
    pub judge: JudgeSettings,
    pub limits: Limits,
    pub pin: PinSettings,
    pub quality: QualitySettings,
    pub latency: LatencySettings,
    pub subagents: SubagentSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            policy: "cost".to_string(),
            policy_weights: None,
            policy_by_class: std::collections::BTreeMap::new(),
            pool: PoolSettings::default(),
            judge: JudgeSettings::default(),
            limits: Limits::default(),
            pin: PinSettings::default(),
            quality: QualitySettings::default(),
            latency: LatencySettings::default(),
            subagents: SubagentSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PoolSettings {
    pub max_models: usize,
    pub require_tools: bool,
    pub min_context: u64,
}

impl Default for PoolSettings {
    fn default() -> Self {
        Self {
            max_models: 8,
            require_tools: true,
            min_context: 32_000,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JudgeSettings {
    pub enabled: bool,
}

impl Default for JudgeSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub shortfall_tolerance: f64,
    pub allow_local_for_complexity: u8,
    pub expected_output_tokens: u64,
    pub context_fit_ratio: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            shortfall_tolerance: 0.2,
            allow_local_for_complexity: 2,
            expected_output_tokens: 1200,
            context_fit_ratio: 0.9,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PinSettings {
    pub mode: String,
    pub switch_threshold: f64,
    pub idle_ttl_ms: f64,
    pub max_age_ms: f64,
    pub max_turns: u32,
    pub cost_switch_ratio: f64,
    pub flip_flop_turns: usize,
    pub cache_hit_ratio: f64,
}

impl Default for PinSettings {
    fn default() -> Self {
        Self {
            mode: "balanced".to_string(),
            switch_threshold: 0.12,
            idle_ttl_ms: 300_000.0,
            max_age_ms: 1_800_000.0,
            max_turns: 8,
            cost_switch_ratio: 4.0,
            flip_flop_turns: 3,
            cache_hit_ratio: 0.8,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QualitySettings {
    pub overrides: HashMap<String, f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LatencySettings {
    pub overrides: HashMap<String, f64>,
    pub local_providers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubagentSettings {
    pub enabled: bool,
    pub override_explicit_model: bool,
    pub default: AgentPolicy,
    pub agents: HashMap<String, AgentPolicy>,
}

impl Default for SubagentSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            override_explicit_model: false,
            default: AgentPolicy::default(),
            agents: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPolicy {
    pub policy: Option<String>,
    pub quality_floor: Option<f64>,
    pub min_context: Option<u64>,
    pub require_tools: Option<bool>,
    pub max_complexity: Option<u8>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pin {
    pub model: Option<ModelRef>,
    pub since: f64,
    pub last_turn_at: f64,
    pub last_turn_class: String,
    pub last_complexity: u8,
    pub switch_count: u32,
    pub pinned_turns: u32,
    pub away: Vec<Away>,
    pub source: String,
    pub forced: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Away {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    pub at: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JudgeInput {
    pub verdict: Option<Verdict>,
    pub cached: bool,
    pub unavailable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Verdict {
    pub task: String,
    pub complexity: u8,
    pub needs_tools: bool,
    pub needs_vision: bool,
    pub context_need: String,
    pub reasoning_need: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub decisions: u64,
    pub switches: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSummary {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    pub variant: Option<String>,
    pub score: f64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    pub variant: Option<String>,
    pub source: String,
    pub reason: String,
    pub pinned: bool,
    pub complexity: u8,
    pub turn_class: String,
    pub confidence: f64,
    pub top: Vec<CandidateSummary>,
}

#[derive(Debug, Clone, Default)]
pub struct Candidate {
    pub model: PoolModel,
    pub score: f64,
    pub cost_usd: f64,
    pub quality: f64,
    /// Required quality for the turn; read by escalation and tests.
    #[allow(dead_code)]
    pub required: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OptimiseRequest {
    pub abi: u32,
    pub model: OptimiseModel,
    pub settings: OptimiseSettings,
    pub messages: Vec<OptMessage>,
    pub system_tokens: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OptimiseModel {
    pub label: String,
    pub limit: ModelLimits,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OptimiseSettings {
    pub reserve_output_tokens: u64,
    pub safety_tokens: u64,
    pub max_tool_tokens: u64,
    pub keep_recent_tool_outputs: usize,
    pub keep_recent_turns: usize,
}

impl Default for OptimiseSettings {
    fn default() -> Self {
        Self {
            reserve_output_tokens: 8192,
            safety_tokens: 1024,
            max_tool_tokens: 2000,
            keep_recent_tool_outputs: 3,
            keep_recent_turns: 2,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OptMessage {
    pub index: usize,
    pub role: String,
    pub parts: Vec<OptPart>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OptPart {
    pub index: usize,
    #[serde(rename = "type")]
    pub kind: String,
    pub tool: Option<String>,
    pub tokens: u64,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAction {
    pub message: usize,
    pub part: usize,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail_chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_head_chars: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimiseStats {
    pub before_tokens: u64,
    pub after_tokens: u64,
    pub parts_pruned: usize,
    pub overflow: bool,
}
