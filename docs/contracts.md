# Task-packet and experiment contracts

EBO accepts externally authored task packets and experiment configurations as
versioned JSON documents. The schemas are the contract; this repository does
not contain an evaluation corpus or a fixed operating matrix.

## Task packets

`schemas/task-packet.v1.schema.json` divides a packet into two surfaces:

- `agentInput` is the only surface a workspace materializer may use. It holds
  the public prompt, a digest-verified sanitized TAR+gzip v1 archive with
  compressed-byte, expanded-byte, and member-count limits, and an explicit
  workspace-relative allowlist. A materializer verifies the archive digest and
  copies only entries selected by `includePaths`; it must not materialize a raw
  repository checkout or an entry outside that allowlist.
- Its archive locator is a secret-free, bundle-relative logical path. URLs,
  absolute local paths, credentials, and path traversal are invalid there. Its
  resolver rejects links and paths that leave the real task-bundle root.
  Include paths are canonical POSIX logical paths only; leading slashes, trailing
  slashes, backslashes,
  drive letters, UNC paths, and traversal forms are invalid.
- `verified-archive-literal-paths-v1` resolves each literal from the sanitized
  archive root. A file includes that file; a directory includes its complete
  descendant tree. Wildcards are intentionally unsupported.
- `verified-archive-literal-paths-no-links-v1` adds the required v1 link rule:
  enumerate every selected entry and selected directory descendant before copy,
  then reject every non-file/non-directory entry. Links are never copied or dereferenced. Every
  selected member name must be a canonical root-relative logical path before
  joining either archive or workspace roots.
- Archive membership and allowlist selection use exact canonical POSIX names.
  Case folding is used only to reject destination collisions across filesystems.
- `restricted` contains only digest-addressed references to the reference
  solution and verifier. It deliberately cannot embed their contents.

The packet records repository provenance, a controlled perturbation, admission
review status, sharing classification, and SHA-256 digests for every frozen
component. Every digest has one authority: the safe fixture source, controlled
perturbation artifact, and restricted component references carry their own. The schema
does not claim a separate agent-input digest without defining its canonical
bytes; admission-freeze tooling owns the whole-packet identity.

`proposed` packets explicitly set `admission.review` to `null`. `admitted` and
`rejected` packets require a reviewer, RFC 3339 `date-time` evidence, and the
restricted review-record reference. Repository provenance is a credential-free
HTTPS repository URI, optionally on an explicit port, plus a full immutable Git
object ID—not a branch or tag. A verifier is always required; `referenceSolution.status` may be
`not-provided` or `unsupported` for verifier-only work. Controlled perturbation
content is either an external, digest-addressed artifact or an explicit
`not-applied`/`unsupported` state; EBO does not prescribe a task-authoring
taxonomy.

Before scheduling, EBO requires an admitted packet's review time to be a valid
RFC 3339 calendar timestamp and its review record, provided reference solution,
and verifier bytes to match their pinned digests. The review record binds the
canonical pre-admission packet digest; the admitted packet can then hash its
review-record reference without requiring a circular digest. Each declared
materialization literal must select at least one verified archive file or
directory tree. A referenced controlled perturbation also hashes to its pinned
digest before scheduling; explicit unavailable states remain distinct from a
referenced artifact that fails to resolve.

### Admission and freeze

Task-packet tooling consumes an externally authored packet; it does not create
tasks or make a human review decision. `validate` checks the packet schema,
parses each declared TAR+gzip fixture, verifies its declared size/member/link
limits and literal allowlist, and resolves every declared perturbation,
reference solution, verifier, and review-record digest. `admit` additionally
requires the recorded admission status to be `admitted` and a complete human
review.

`freeze` writes a sibling
[`ebo.task-packet-freeze/v1`](../schemas/task-packet-freeze.v1.schema.json)
record. It records stable SHA-256 digests for the prompt, fixture, reference
solution, verifier, review record, controlled perturbation, and canonical
packet. The review record binds the canonical packet content with its
`admission` field omitted, using its `preAdmissionDigest` field and avoiding a
circular reference. The aggregate digest is derived from those identities, the
packet locator, and the recorded `frozenAt` timestamp. Repeating a freeze for
unchanged content retains the first published record and its timestamp.
An existing freeze is never silently replaced after a component changes.

`status` compares the current packet and resolved bytes with the freeze record
and reports the named mismatching component before a later materializer or
scheduler can consume it. The model-visible projection is only `agentInput`;
reference solutions, verifier bytes, and review records remain restricted.

## Experiments

`schemas/experiment.v1.schema.json` treats task, model, and harness sets;
trial count; ordering seed; coordinator wall-clock budget; and capture profile
as data. Each condition set is an ID-keyed map, so one identity can expand to
only one matrix condition. Every referenced configuration has a SHA-256 digest.
Each harness condition separately names source-specific native-limits and
native-tool-policy configurations; EBO does not define a shared turn count or
tool namespace.

Every experiment configuration reference is a portable bundle-relative logical
path, resolved from the experiment bundle root rather than the current working
directory. The resolver checks each component without following symbolic links
and rejects a path that leaves the real bundle root. URLs, absolute paths,
traversal, aliases such as `./`, and backslashes are invalid. A
`permuted` order also names a digest-pinned permutation-algorithm reference;
that versioned artifact defines how the supplied seed orders matrix cells. Each
resolved model, harness, native-limit, native-tool-policy, capture-profile, and
permutation artifact must hash to its pinned digest before scheduling.

`declared` ordering carries explicit task, model, and harness ID lists. Matrix
compilers use those lists, never object-property enumeration, and reject a list
unless it is an exact permutation of its condition-set IDs. Before expansion, a
compiler resolves every task packet, checks the reference digest, and requires
`admission.status` to be `admitted`. Capture profiles use the same digest-pinned
configuration-reference shape as other immutable experiment inputs.

For declared matrices, traversal is task outermost, then model, then harness,
with one-based trial replicas innermost. The compiler rejects duplicate task
packet digests across task IDs before expansion. The declared cell iterator is
lazy, so externally supplied trial counts do not allocate a full matrix.

The fixtures include a generic 18-cell matrix and a differently shaped matrix
to show that no study dimensions are built into the contract. Parsed numeric
controls are limited to JavaScript safe integers.

## Run queues

`compileRunQueue` expands an experiment into a persisted
`ebo.run-queue/v1` document. Every entry contains the task-packet freeze
identity, digest-pinned model and harness configuration references, and a
one-based trial identity; the queue also retains the selected capture-profile
reference and coordinator budget. A scheduling digest covers those controls,
the matrix, seed, and ordering policy; run IDs include that digest so
standalone consumers reject mutations to any persisted scheduling input. When
the API is used without a bundle root, each admitted task resolution must carry
the complete schema-valid freeze record that supplied task identities are
checked against. Freeze locators are distinct from every packet/configuration
artifact path and from each other; persisted custom locators are reused when
queues are revalidated without a bundle root.

The compiler supports sequential (`declared` is retained as its legacy name),
seeded-shuffle (`permuted` is retained as its legacy name), and balanced
interleaving. Interleaving round-robins the selected dimension (model by
default) and preserves every cell exactly once, including matrices whose
groups have different sizes. Configuration references are resolved before
compilation, and every task packet must have a matching, admitted freeze
record. A seeded-shuffle with a permutation reference reads that verified
artifact and currently accepts the declared `fisher-yates-v1` algorithm;
unknown algorithm definitions fail closed. The normalized queue records the
resolved algorithm name, so experiment-only validation remains reproducible;
passing a bundle root additionally rechecks the pinned artifact. Queue writes
use the existing atomic artifact writer and do not execute work or coordinate
across machines.

The CLI exposes `ebo matrix compile <experiment.json> <bundle-root>
<queue.json> [--freeze-locator <task-id>=<path>]`, `ebo queue inspect
<queue.json>`, and `ebo queue validate
<queue.json> [experiment.json] [--bundle-root <bundle-root>]`. Supplying the
bundle root lets queue validation recheck each freeze and pinned algorithm
artifact. The 18-cell fixture is only a generality test;
the compiler has no fixed task, model, harness, or trial count, subject to the
bounded 100,000-entry local queue limit; larger matrices require a future
streaming queue implementation.

Unknown schema versions and sharing classifications are invalid. Consumers must
validate a document before materializing a workspace or scheduling a run.
