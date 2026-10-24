# Claude Code: project context

Follow [`AGENTS.md`](AGENTS.md) and the [assessment-only checklist](docs/specifications/assessment-scope.md) before changing this codebase. Do not treat optional compatibility and engineering features as employer requirements. Read the [authoritative specification registry](docs/specifications/README.md) and its [MPEG](docs/specifications/mpeg-1-layer-iii.md), [metadata](docs/specifications/tags-and-encoder-headers.md), [API](docs/specifications/http-api.md), and [conformance](docs/specifications/conformance.md) documents for the task area.

**Do not silently change `frameCount` semantics:** the project currently counts physical MPEG frames (assessment sample 6090) and optionally excludes a verified initial encoder metadata frame (6089); which default the evaluator wants is still unresolved. [Decision record](docs/frame-count-contract.md).

TypeScript frame parsing is original code, not a third-party NPM MPEG parser. MPEG-2, MPEG-2.5 and non-Layer-III audio remain outside the assessment. Keep streaming memory bounded and prove changes with independent fixtures/tests.
