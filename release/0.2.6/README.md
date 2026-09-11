# v0.2.6: Contain workspace capture failures

Workspace outcome capture accepts absolute symbolic links that resolve inside
the source workspace. The derived patch or snapshot uses portable relative
links; the source workspace is unchanged. External, dangling, and cyclic links
remain rejected for workspace packaging.

A workspace packaging failure no longer rewrites native completion as an
infrastructure failure. Capture records the missing outcome and retains the
source for recovery. Native semantic evidence can be normalized and analyzed
independently of workspace qualification. Verified task outcomes still require
a verifier bound to the captured workspace. Export safety checks are unchanged.

The run-manifest v1 schema now permits completed observational runs without a
workspace artifact. Consumers must use qualification dimensions when deciding
which evidence supports their analysis, rather than infer completeness from
terminal state.

Regression coverage includes absolute-link patch/snapshot relocation, preserved
source links, invalid-target rejection, cleanup containment, and normalization
with missing workspace evidence. A real retained xhigh trajectory generated 21
structural observations without its workspace artifact and without model calls.

See [known limitations](KNOWN_LIMITATIONS.md), the
[reproducibility manifest](reproducibility.json), and the
[evidence guide](../../docs/guides/evidence-and-sharing.md).
