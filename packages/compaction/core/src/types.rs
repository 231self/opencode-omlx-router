//! Request and result shapes for the `optimise` ABI.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelLimits {
    pub context: u64,
    pub output: u64,
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
