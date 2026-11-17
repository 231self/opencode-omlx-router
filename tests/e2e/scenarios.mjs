/**
 * Prompt-test scenarios.
 *
 * These are live integration fixtures: each step sends a real prompt to a real
 * host (OpenCode V2 or Kilo), while the router's judge is a deterministic local
 * stub. A scenario asserts the decision record *and* the model the host
 * actually used.
 *
 * The scoring expectations are derived from the Rust core with this catalog:
 * DeepSeek Flash costs 0.2/0.8 per 1M tokens, Pro costs 2/8, both advertise
 * 262k context, and the quality overrides below remove estimator noise.
 */

export const FLASH = "deepseek/deepseek-flash"
export const PRO = "deepseek/deepseek-v4-pro"

export const BASE_CONFIG = {
  enabled: true,
  policy: "cost",
  debug: false,
  pool: {
    source: "list",
    models: [FLASH, PRO],
    minContext: 32000,
    requireTools: true,
  },
  judge: {
    enabled: true,
    model: "stub-judge-4B",
    timeoutMs: 1500,
    cacheTtlMs: 600000,
    cacheSize: 128,
  },
  quality: {
    source: "manual",
    overrides: {
      [FLASH]: 0.55,
      [PRO]: 0.8,
    },
  },
  pin: {
    switchThreshold: 0.12,
    idleTtlMs: 300000,
    flipFlopTurns: 3,
    cacheHitRatio: 0.8,
  },
  optimiser: {
    enabled: true,
    reserveOutputTokens: 8192,
    safetyTokens: 1024,
    maxToolTokens: 2000,
    keepRecentToolOutputs: 3,
    keepRecentTurns: 2,
  },
  limits: {
    shortfallTolerance: 0.2,
    allowLocalForComplexity: 2,
    expectedOutputTokens: 1200,
    contextFitRatio: 0.9,
  },
  subagents: {
    enabled: true,
    overrideExplicitModel: false,
    default: { policy: "cost", qualityFloor: 0 },
    agents: {
      explore: { policy: "latency", qualityFloor: 0.45, minContext: 128000 },
      general: { policy: "cost", qualityFloor: 0.55 },
      review: { policy: "quality", qualityFloor: 0.75 },
      plan: { policy: "quality", qualityFloor: 0.8 },
    },
  },
}

const CODE_PROMPT =
  "In src/parser.rs, explain what the parse function should return for an unknown token."

const verdict = (complexity, reasoningNeed = "medium") => ({
  task: "edit",
  complexity,
  needsTools: true,
  needsVision: false,
  contextNeed: "small",
  reasoningNeed,
  confidence: 0.9,
})

const decision = (overrides) => ({
  role: "root",
  applied: "same-turn",
  pinned: false,
  judgeUsed: true,
  assistantMatchesChosen: true,
  ...overrides,
})

export const SCENARIOS = [
  {
    id: "trivial-triage",
    host: "opencode",
    notes: "short greeting is classified without a judge call",
    steps: [
      {
        prompt: "Reply with exactly: OK",
        judge: null,
        expect: {
          judgeCalls: 0,
          decisions: [
            decision({
              chosen: FLASH,
              source: "triage",
              reason: "first-turn",
              stage: "triage/cost",
              policy: "cost",
              complexity: 1,
              judgeUsed: false,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "judge-cost",
    host: "opencode",
    notes: "a judged medium turn goes to the cheap model under cost policy",
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(2, "low"),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "judge",
              reason: "first-turn",
              stage: "judge/cost",
              policy: "cost",
              complexity: 2,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "quality-gate",
    host: "opencode",
    notes: "quality policy sends a complex turn to the stronger model, same turn",
    config: { policy: "quality" },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(4, "high"),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: PRO,
              source: "judge",
              reason: "first-turn",
              stage: "judge/quality",
              policy: "quality",
              complexity: 4,
              assistantModel: PRO,
              sessionModel: PRO,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "latency-policy",
    host: "opencode",
    notes: "latency overrides beat both price and quality",
    config: {
      policy: "latency",
      latency: {
        overrides: {
          [FLASH]: 4000,
          [PRO]: 100,
        },
      },
    },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(2),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: PRO,
              source: "judge",
              reason: "first-turn",
              stage: "judge/latency",
              policy: "latency",
              complexity: 2,
              assistantModel: PRO,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "pin-holds",
    host: "opencode",
    notes: "the incumbent survives a higher-scoring challenger inside the threshold",
    config: { pin: { switchThreshold: 0.3 } },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(3),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "judge",
              reason: "first-turn",
              stage: "judge/cost",
              policy: "cost",
              complexity: 3,
              assistantModel: FLASH,
            }),
          ],
        },
      },
      {
        prompt: CODE_PROMPT,
        judge: verdict(4),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "pin",
              reason: "pin-kept",
              stage: "pin/cost",
              policy: "cost",
              complexity: 4,
              pinned: true,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "complexity-jump",
    host: "opencode",
    notes: "a two-step complexity jump breaks the pin and escalates",
    config: { pin: { switchThreshold: 0.1 } },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(2),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "judge",
              reason: "first-turn",
              stage: "judge/cost",
              policy: "cost",
              complexity: 2,
              assistantModel: FLASH,
            }),
          ],
        },
      },
      {
        prompt: CODE_PROMPT,
        judge: verdict(4),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: PRO,
              source: "judge",
              reason: "complexity-jump",
              stage: "judge/cost",
              policy: "cost",
              complexity: 4,
              assistantModel: PRO,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "switch-mode",
    host: "opencode",
    notes: "pin mode switch takes the best model every turn and accepts cache misses",
    config: { pin: { mode: "switch" } },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(2),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "route",
              reason: "best-model",
              stage: "route/cost",
              policy: "cost",
              complexity: 2,
              pinned: false,
              assistantModel: FLASH,
            }),
          ],
        },
      },
      {
        prompt: CODE_PROMPT,
        judge: verdict(4),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: PRO,
              source: "route",
              reason: "best-model",
              stage: "route/cost",
              policy: "cost",
              complexity: 4,
              pinned: false,
              assistantModel: PRO,
            }),
          ],
        },
      },
      {
        prompt: CODE_PROMPT,
        judge: verdict(2),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "route",
              reason: "best-model",
              stage: "route/cost",
              policy: "cost",
              complexity: 2,
              pinned: false,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "judge-unreachable",
    host: "opencode",
    notes: "a dead judge endpoint falls back to deterministic heuristics",
    config: { judge: { baseURL: "http://127.0.0.1:1/v1", timeoutMs: 800 } },
    steps: [
      {
        prompt: "fix the parser bug in src/parser.rs and run the tests",
        judge: null,
        expect: {
          judgeCalls: 0,
          decisions: [
            decision({
              chosen: FLASH,
              source: "heuristic",
              reason: "first-turn",
              stage: "heuristic/cost",
              policy: "cost",
              judgeUsed: false,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "judge-malformed",
    host: "opencode",
    notes: "unparsable judge output is retried once, then falls back",
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: "malformed",
        expect: {
          judgeCalls: 2,
          decisions: [
            decision({
              chosen: FLASH,
              source: "heuristic",
              reason: "first-turn",
              stage: "heuristic/cost",
              policy: "cost",
              judgeUsed: false,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "user-override",
    host: "opencode",
    notes: "an explicit model switch becomes a forced pin that bypasses the judge",
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(2),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "judge",
              reason: "first-turn",
              stage: "judge/cost",
              policy: "cost",
              complexity: 2,
              assistantModel: FLASH,
            }),
          ],
        },
      },
      {
        prompt: CODE_PROMPT,
        model: PRO,
        judge: verdict(2),
        expect: {
          judgeCalls: 0,
          decisions: [
            decision({
              chosen: PRO,
              source: "user",
              reason: "forced",
              stage: "user/cost",
              policy: "cost",
              complexity: 2,
              pinned: true,
              judgeUsed: false,
              assistantModel: PRO,
              sessionModel: PRO,
            }),
          ],
        },
      },
      {
        prompt: CODE_PROMPT,
        judge: verdict(2),
        expect: {
          judgeCalls: 0,
          decisions: [
            decision({
              chosen: PRO,
              source: "user",
              reason: "forced",
              stage: "user/cost",
              policy: "cost",
              complexity: 2,
              pinned: true,
              judgeUsed: false,
              assistantModel: PRO,
              sessionModel: PRO,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "subagent-explore",
    host: "opencode",
    notes: "a child session uses the explore agent's latency policy independently",
    steps: [
      {
        prompt:
          'Call the subagent/task tool exactly once and delegate to the explore agent: "Inspect src/one.js and src/two.js and report the exported names." Do not inspect the files yourself; just call the task tool and report the result.',
        judge: verdict(2),
        auto: true,
        timeoutMs: 240000,
        expect: {
          judgeCalls: 2,
          decisions: [
            decision({
              role: "root",
              chosen: FLASH,
              source: "judge",
              reason: "first-turn",
              stage: "judge/cost",
              policy: "cost",
              complexity: 2,
              assistantModel: FLASH,
            }),
            decision({
              role: "subagent",
              agent: "explore",
              chosen: FLASH,
              source: "judge",
              reason: "first-turn",
              stage: "judge/latency",
              policy: "latency",
              complexity: 2,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "kilo-boundary",
    host: "kilo",
    notes: "Kilo keeps the current turn on the old model and applies the decision next boundary",
    config: { policy: "quality" },
    steps: [
      {
        prompt:
          "Plan a two-step approach to rename src/one.js to src/uno.js. Do not edit files; reply with the plan.",
        judge: verdict(3),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: PRO,
              source: "judge",
              reason: "first-turn",
              stage: "judge/quality",
              policy: "quality",
              complexity: 4,
              applied: "boundary",
              assistantMatchesChosen: false,
              assistantModel: FLASH,
              sessionModel: PRO,
            }),
          ],
        },
      },
      {
        prompt: "Reply with exactly: OK",
        judge: null,
        expect: {
          judgeCalls: 0,
          decisions: [
            decision({
              chosen: PRO,
              source: "pin",
              reason: "pin-kept",
              stage: "pin/quality",
              policy: "quality",
              complexity: 1,
              applied: "boundary",
              pinned: true,
              judgeUsed: false,
              assistantModel: PRO,
              sessionModel: PRO,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "favorites-pool",
    host: "opencode",
    notes: "the default pool source reads the host favorites file",
    favorites: [FLASH, PRO],
    config: { pool: { source: "favorites", models: [] } },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: verdict(2, "low"),
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: FLASH,
              source: "judge",
              reason: "first-turn",
              stage: "judge/cost",
              policy: "cost",
              complexity: 2,
              assistantModel: FLASH,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "judge-underclassifies",
    host: "opencode",
    notes: "a weak judge verdict is raised to the deterministic signal floor",
    config: { policy: "quality" },
    steps: [
      {
        prompt:
          "Review this authentication design for security issues: tokens are stored in localStorage. Do not use tools; list the risks and fixes.",
        judge: {
          task: "review",
          complexity: 1,
          needsTools: false,
          needsVision: false,
          contextNeed: "small",
          reasoningNeed: "low",
          confidence: 0.9,
        },
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: PRO,
              source: "judge",
              reason: "first-turn",
              stage: "judge/quality",
              policy: "quality",
              complexity: 3,
              verdict: {
                task: "review",
                complexity: 3,
                needsTools: true,
                reasoningNeed: "high",
                contextNeed: "small",
              },
              assistantModel: PRO,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "judge-underclassifies-multifile",
    host: "opencode",
    notes: "a multi-file refactor is raised to complexity 4 before the model is chosen",
    config: { policy: "cost" },
    steps: [
      {
        prompt:
          "Plan the reorganisation across src/parser.rs, src/lexer.rs, and src/ast.rs. Without tools, reply with the steps.",
        judge: {
          task: "plan",
          complexity: 3,
          needsTools: true,
          needsVision: false,
          contextNeed: "small",
          reasoningNeed: "medium",
          confidence: 0.9,
        },
        expect: {
          judgeCalls: 1,
          decisions: [
            decision({
              chosen: PRO,
              source: "judge",
              reason: "first-turn",
              stage: "judge/cost",
              policy: "cost",
              complexity: 4,
              verdict: {
                task: "plan",
                complexity: 4,
                needsTools: true,
                reasoningNeed: "high",
                contextNeed: "small",
              },
              assistantModel: PRO,
            }),
          ],
        },
      },
    ],
  },

  {
    id: "empty-favorites",
    host: "opencode",
    notes: "empty favorites pause routing instead of falling back to every model",
    favorites: [],
    config: { pool: { source: "favorites", models: [] } },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: null,
        expect: {
          judgeCalls: 0,
          decisions: [
            {
              role: "root",
              chosen: null,
              source: "skip",
              reason: "no_pool",
              stage: "skip/no_pool",
              applied: "none",
              pinned: false,
              judgeUsed: false,
              hintContains: "/router pool",
              assistantModel: FLASH,
            },
          ],
        },
      },
    ],
  },

  {
    id: "disabled",
    host: "opencode",
    notes: "the master switch leaves the host session untouched and writes no decision",
    config: { enabled: false },
    steps: [
      {
        prompt: CODE_PROMPT,
        judge: null,
        expect: {
          judgeCalls: 0,
          decisions: [],
          assistantModel: FLASH,
        },
      },
    ],
  },

  {
    id: "live-judge",
    host: "opencode",
    liveOnly: true,
    notes: "the real oMLX judge returns a verdict and the turn is routed by it",
    config: {
      judge: {
        baseURL: "http://127.0.0.1:1234/v1",
        model: "auto",
        timeoutMs: 5000,
      },
    },
    steps: [
      {
        prompt:
          "Plan a migration of the parser in src/parse.rs to a streaming API. Cover the trade-offs, failure modes, and a phased rollout.",
        judge: null,
        timeoutMs: 240000,
        expect: {
          judgeCalls: null,
          timing: { judgeMaxMs: 10000, modelMinMs: 1 },
          decisions: [
            decision({
              source: "judge",
              reason: "first-turn",
              judgeUsed: true,
              assistantMatchesChosen: true,
              chosen: null,
              assistantModel: null,
            }),
          ],
        },
      },
    ],
  },
]
