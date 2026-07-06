# Gold Guidance

The plan should understand IPTVnator's workspace/navigation model and the difference between global favorites, contextual favorites, recent items, and module-specific content types.

Important facts to recover:
- Global favorites currently risk being TV-stream focused while VOD and series need a coherent place in the model.
- Favorites/recently viewed views should account for M3U, Xtream, and Stalker differences instead of forcing one flat layout.
- The plan should reason about the workspace shell, route utilities, playlist-local actions, and whether TV/VOD/series should be split or unified.
- The desired fix is a navigation and information architecture plan first, not just styling.
- Prior workspace/header/playlist decisions are relevant; the plan should preserve the distinction between global app actions and playlist/provider-local actions.
- The plan should define storage/state ownership for favorites and recents across providers before proposing UI placement.
- Validation should include e2e or focused route/state tests for switching content types, clearing items, drag/drop or ordering behavior where relevant, and preserving existing playlist context.

Anti-patterns:
- Treating favorites as a single TV-only list.
- Moving local actions into the global header without considering the user's mental model.
- Ignoring Stalker/Xtream/M3U differences.
- Proposing a broad redesign without identifying the concrete workspace and portal surfaces.
- Solving this only with route labels or icons while leaving state semantics ambiguous.
