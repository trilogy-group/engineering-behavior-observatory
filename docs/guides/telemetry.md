# Telemetry and behavioral evidence

EBO keeps two complementary views:

- **Native trajectory evidence** tells you what the agent or harness emitted:
  messages, tools, context changes, lifecycle, and workspace outcomes.
- **OpenTelemetry signals** supply exposed timing and resource evidence. OTLP
  is a delivery protocol, not a behavior ontology.

A trace is useful for latency and operation structure. A behavioral assessment
also needs task context, cited native records, and an interpretation that can
be reviewed.

## Know what the adapter can capture

| Harness | Telemetry boundary |
| :--- | :--- |
| Claude Agent SDK | Optional native exporters; content opt-in, traces beta, detailed hook spans separately gated |
| Codex | Owned local OTLP/HTTP JSON receiver; logs, traces, metrics checked independently |
| Cursor | No selected SDK-local OTLP receipt API; Enterprise server-side metrics/logs are a separate integration |
| Pi | No verified native OTLP receipt surface at the pinned SDK |
| OpenHands | Exposed server/API evidence is not proof of complete native OTLP delivery |
| DeepSeek Harness | Session telemetry and durable events follow the selected runtime composition; do not infer unseen signals |

See [harness guides](../harnesses/README.md) for pins and exact capabilities.
Availability changes by runtime; record what was observed for each attempt.

## Configuration is not receipt

Short export intervals **and** clean shutdown reduce loss from buffered
telemetry. Neither guarantees delivery. Inspect receipt state for each signal:
`received`, `missing`, `not-checked`, `disabled`, or `unsupported`
where the source contract supports it.

Keep content capture off unless explicitly approved. Never use a console
exporter on stdout when stdout is the SDK or JSON-RPC message channel.
Diagnostics belong on the source's supported diagnostic channel.

## Grafana: two different data paths

EBO's [Atlas Grafana integration](atlas.md#grafana) queries derived EBO JSON
through Infinity. That provides cohort tables and links to cited evidence;
it does **not** ingest OTLP or store traces.

To inspect native traces, use a separately configured trace backend such as
Tempo and a Grafana data source. The Atlas request can link an exact run/attempt
to a known trace ID. The existing backend must already contain that trace;
Atlas neither replays retained data nor invents a temporal join.

Keep collector storage and dashboards local or in an approved environment.
Native telemetry can contain restricted metadata even when prompt capture is off.

## Interpret resource metrics carefully

Usage channels may report increments, cumulative snapshots, final totals, or
billing readback. Follow the adapter's authority rules; adding every snapshot
double-counts work.

Preserve input, output, cache, and reasoning categories as supplied. A cache or
reasoning subset is not necessarily an additional token category to add to a
total. A reported dollar estimate is not automatically a charge, and neither
tokens nor that estimate establish subscription quota consumption. Record any
separate quota observation with its source and time.

[Structural observations](../evaluation/structural-observations.md) documents
the implemented accounting and availability rules.
