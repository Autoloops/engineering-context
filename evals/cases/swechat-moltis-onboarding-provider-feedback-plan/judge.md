# Gold Guidance

The plan should turn broad user feedback into a concrete Moltis implementation plan across onboarding, providers, voice, and channel setup.

Important facts to recover:
- Moltis has onboarding/provider configuration flows where model lists, preferred model ordering, and provider-specific auth/probe behavior matter.
- Prior work touched STT onboarding auth, Telegram channel configuration, GitHub Copilot provider behavior, and test coverage around provider/onboarding flows.
- The plan should inspect both backend provider/channel config code and web UI onboarding/settings surfaces.
- Voice feedback should not be treated as only UI copy; it may involve STT provider support, test endpoints, and auth/path differences.
- The fix direction should be prioritized and incremental: quick UX/config fixes first, then provider/voice/channel reliability and targeted tests.
- Validation should include provider unit/integration tests and at least one onboarding or web UI/e2e path.

Anti-patterns:
- Treating the feedback as one frontend-only redesign.
- Changing model/provider behavior without checking existing provider abstractions and tests.
- Ignoring previous fixes for STT auth, Telegram config, or GitHub Copilot provider routing.
- Proposing broad architecture rewrites before triaging the feedback into actionable slices.
