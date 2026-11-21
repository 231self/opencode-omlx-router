# Changelog

## 0.1.0 — 2026-11-21

### Added

- Initial release. The context optimiser moves out of `@231self/opencode-router`
  (which becomes pure model selection): the `optimise` WASM core with its
  explicit ABI (`alloc`, `dealloc`, `optimise`, `result_len`, `abi_version`),
  the request builder and in-place plan application, the V2 `context` hook
  (optimise + pin measurement), and the Kilo
  `experimental.chat.messages.transform` path.
