# Gold Guidance

The plan should understand IPTVnator's playlist-import surfaces and the user's mental model around global app actions versus playlist/context actions.

Important facts to recover:
- M3U has multiple add modes, while Stalker and Xtream have credential/code-oriented flows, so a single entry point needs type-specific forms.
- The proposed direction is likely one add action opening a dialog with segmented type selection, not several unrelated buttons.
- The plan should inspect playlist import feature components, workspace shell action wiring, shared UI exports, and current e2e flows.
- The plan should preserve validation, error states, recent playlists, and existing module-specific behavior.
- The plan should distinguish global "add source" actions from playlist-local actions so the header/workspace mental model stays coherent.
- The plan should include migration/deprecation of fragmented entry points and guard against losing source-specific validation.
- Tests should cover adding/switching M3U URL/file/text, Stalker, and Xtream flows plus regression coverage for existing playlist navigation.

Anti-patterns:
- Treating all playlist sources as one form.
- Moving UI without considering workspace header action semantics.
- Ignoring existing import components and e2e tests.
- Proposing only visual polish without addressing flow structure.
- Removing existing add paths before the unified flow has parity.
