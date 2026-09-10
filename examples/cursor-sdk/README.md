# Cursor SDK input example

These five records are the minimal Cursor-specific inputs referenced by an EBO
experiment. Copy them into the caller-owned bundle, replace the model
placeholder with an exact ID returned by `Cursor.models.list()`, compute the
normal EBO artifact digests, and reference them from the experiment's model,
harness, native-limits, native-tool-policy, and capture-profile fields.

Use the standard `task-packet admit`, `task-packet freeze`, `matrix compile`,
`queue validate`, and `cursor run` commands. No Cursor-specific preparation
script or cloud agent is required.
