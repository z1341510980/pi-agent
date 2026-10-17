# Novel Refactoring Interface Matrix

This matrix is the Phase C audit index for the Novel plugin. Route paths omit the
`/api/plugins/novel` prefix. Detailed field definitions are authoritative in the
route TypeBox schemas, handler Zod schemas, and the page-specific design docs
listed in the source column.

| Page / workflow | Route modules and user path | Request/response field source | External systems | Reuse and boundary | Ambiguous items |
| --- | --- | --- | --- | --- | --- |
| Project and recycle bin | `project-routes`, `POST/PATCH /projects`, project settings -> edit/trash/restore | project route schemas; project route contract tests | SQLite | `NovelStore` facade -> project store/repository | Whether purge needs an extra confirmation policy is a product decision |
| Volume and chapter tree | `volume-routes`, `chapter-routes`; project -> volume/chapter tree | volume schemas; chapter route tests | SQLite | chapter store/repositories; shared project params | Pagination is not added until measured as a bottleneck |
| Chapter creation flow | `creation-flow-routes`, `interject-routes`; chapter -> create/resume/checkpoint/cancel/interject | creation lifecycle state/events; interject Zod/TypeBox schemas | LLM Provider, AG-UI/SSE, SQLite | `CreationRunLifecycle`, event tail, confirmation manager | Exact UI wording for checkpoint decisions remains product-owned |
| Chapter chat | `chapter-chat-routes`; chapter -> chat/history/reconnect | chapter-chat route contracts and runner tests | SQLite, AG-UI/SSE | shared chapter route helpers and event audit | Whether chat history should be paged depends on observed history size |
| Narrative entities | `entity-plot-routes`, `narrative-routes`; matrix -> foreshadow/conflict/hook/clue/relationship/narrative CRUD | field-level TypeBox plus Zod domain schemas; entity-plot contract tests | SQLite | entity stores, graph edge service | Relationship direction and dynamic-vs-static semantics are documented in the matrix design |
| World settings | `world-setting-routes`; world tab -> rules/style guides/constraints/info layers | world-setting TypeBox/Zod schemas and contract tests | SQLite | world store and edge service | Information-layer reveal timing remains configurable |
| World entities | `world-entity-routes`; world tab -> factions/locations/items/world elements | world-entity TypeBox/Zod schemas and PATCH no-default regression tests | SQLite | world store; shared entity params | Cross-project owner references are rejected by store/domain checks |
| Writing style | `writing-style-routes`; style tab -> profile/experts/samples/preview/quality | writing-style TypeBox/Zod schemas and style tests | SQLite, reference analysis, LLM Provider | PromptBuilder and reference-analysis stores | Expert `prompt` vs `distilledPrompt` compatibility is retained |
| Reference analysis | `reference-analysis-routes`, `reference-run-routes`; reference tab -> import/analyze/review | reference route contracts and run-store tests | File API/Base64, SQLite, LLM Provider | reference analysis/run/profile stores | Source extraction and semantic coverage policies remain configurable |
| Reference templates | `reference-template-routes`; template tab -> template/version/binding/validation | P8 binding TypeBox schemas and route-storage tests | SQLite, LLM Provider | binding/template/run stores | Validation cost confirmation remains a UI policy |
| Prompt and agent settings | `prompt-routes`, `agent-config-routes`, `agent-log-routes`; settings -> prompts/agent config/logs | prompt/config/log route schemas and handler validation | SQLite, LLM Provider | PromptManager, agent manager, cost logs | Provider/model availability is external configuration |
| Matrix and graph | `graph-routes`, `story-ledger-routes`, `narrative-revision-routes`; matrix -> graph/timeline/ledger/revision | route schemas plus Story Matrix design | SQLite, React Flow | entity CRUD, ledger, graph stores | Timeline/Gantt visualization remains an optional client choice |
| Memory and observability | `memory-routes`, `observability-routes`, `cache-routes`, `context-preview-routes`; audit -> memory/cache/context reports | observability/cache tests and query schemas | SQLite, PromptManager | shared run/event stores and prompt builder | Report retention and sampling limits are operational settings |
| Markers and deletion | `marker-routes`, `entity-delete-routes`; timeline -> markers/delete/recycle actions | marker/delete route schemas and route tests | SQLite | entity stores and chapter cleanup services | Destructive purge confirmation follows host policy |

## Cross-cutting evidence

- `novel-route-contract-completeness.test.ts` verifies all 294 registered Novel routes carry params, query, body where applicable, and response metadata.
- `route-storage-boundary.test.ts` rejects direct SQLite access from route modules.
- Field-level contracts are migrated first in project, volume, reference-template, world-setting, world-entity, writing-style, and entity-plot modules; legacy modules retain Zod handler validation behind the registration-boundary contract until their bounded migration slice.
- External references and reuse decisions are expanded in `docs/novel/STORY_MATRIX_EVENT_LEDGER_DESIGN.md` and `docs/novel-pluginization-plan.md`.
