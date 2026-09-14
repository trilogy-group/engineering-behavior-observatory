# v0.2.10: Pi model identifiers

Pi configuration now accepts nonempty model-condition identifiers containing
slashes, dots and uppercase characters. Native provider and model values remain
separate and unchanged. Empty and non-string identifiers are still rejected.

Other harness native-model validators already accept these identifiers. Legacy
queue slug labels remain separate from native model IDs.

Harbor development and its runtime image remain on PR #46, outside this release.
See the [reproducibility manifest](reproducibility.json) and
[existing limitations](../0.2.9/KNOWN_LIMITATIONS.md).
