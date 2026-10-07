# Evidence packets

An evidence packet is one folder a partner can open: pages that work from disk,
and the interactive Atlas viewer when the folder is served over HTTP. It is
built from an [Atlas bundle](atlas-bundles.md) and links the layers of a study:

| Layer | Content | Where |
| :--- | :--- | :--- |
| L0 narrative | study summary, contents, how to verify | `index.html`, `README.md`, `AGENTS.md` |
| L1 claims | each number with how it recomputes; supporting evaluations | `claims/` |
| L2 behavior evaluations | judge assessments: rationale, alternative explanation, factual claims, cited native lines | `evaluations/` |
| L3 metrics and cohorts | the cohort aggregation reports (certified tallies) | `metrics/` |
| L4 qualified evidence | attempt audits and native records | `evidence/`, `viewer/bundle/native/` |
| L5 machine data and viewer | the bundle and the viewer | `viewer/`, `viewer/bundle/` |

```sh
ebo packet build <bundle-dir> <output-dir> --variant internal|partner|restricted
ebo packet verify <packet-dir>
```

## Variants

- `internal`: all data, no redactions.
- `partner`: all data, shared by the export pipeline's rules in every
  text-bearing file, including Parquet tables and the cloud's units: secrets
  redacted (secret-named fields replaced whole), environment values of the
  building process redacted, absolute local paths, `file://` URIs and home
  directories as `[LOCAL_PATH]`, user assignments as `[LOCAL_USER]`, local path
  fields dropped, and hidden reasoning removed from native records and event
  content. A string the final scan still flags is withheld whole. The cloud is
  re-embedded locally from the shared unit text, and `viewer/bundle/manifest.json`
  is regenerated for the shared files with `derivedFrom` naming the source
  bundle. The manifest records the number of redactions per file.
- `restricted`: narrative, claims, evaluations, metrics and the viewer. Unit
  text becomes a structural label (kind, role, tool, check, status); commands,
  targets and error text are removed; code in judgments is redacted; cited
  native lines, native records, attempt audits and tables are withheld and
  listed in the manifest with their SHA-256.

A shared native record that sanitizing changed carries its own SHA-256 and
length, with the original's as `source_sha256`. A final scan (credential
patterns, absolute local paths, home paths) runs over every shared text file
and every Parquet and Arrow value; any finding fails the build.

Partner and restricted packets are built only from a bundle with claims, and
only when every claim validates; an
internal packet shows a claim that no longer holds as such. A packet is built in
a temporary sibling directory and published by rename; the destination must be
new or empty.

## Verification

`manifest.json` (`ebo.packet/v1`) lists every file with its SHA-256, size, media
type, layer and, in redacted variants, its redaction count, plus withheld files
with their digests. `ebo packet verify` recomputes them, checks that
`ro-crate-metadata.json` is exactly the description generated from the
manifest, rejects manifest paths outside the packet, and reports changed,
missing and unlisted files; `verify.html` does the same in the browser.
`ro-crate-metadata.json` is an RO-Crate 1.2 description generated from the
manifest, which stays authoritative.

The manifest reserves an `assistant` block for a future in-viewer assistant;
it is disabled (`enabled: false`) and the viewer makes no network request
outside the packet.
