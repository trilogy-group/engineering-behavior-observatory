# EBO 0.2.1 known limitations

Runtime pins and behavior are unchanged from 0.2.0. The
[0.2.0 support record](../0.2.0/KNOWN_LIMITATIONS.md) describes live-tested
routes, Cursor's separate Enterprise telemetry boundary, and the limits of
local SDK isolation.

The dependency audit still reports three entries (two moderate, one high)
through Cursor SDK, ConnectRPC, and Undici. No dependency upgrade or override
is included in this documentation release. Review those advisories before
deployment.

Apache-2.0 covers EBO's original code and documentation. Third-party SDKs,
dependencies, and upstream contract material retain their own licenses and
terms. Installing EBO does not grant model access or replace provider terms.

npm distribution includes the compiled CLI and documentation. The synthetic
Atlas demo generator and test fixtures require a source checkout.
