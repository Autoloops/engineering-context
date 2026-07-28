# Gold Guidance

The plan should treat radio/audio playback as a first-class layout mode inside the existing workspace shell.

Important facts to recover:
- M3U supports radio playlists and uses `libs/ui/playback` audio-player behavior.
- Audio/radio playback should not show video-only or EPG-heavy layout panels when they do not apply.
- The plan should inspect workspace layout, playback components, recent/favorites interactions, and provider-specific views.
- UI consistency matters because prior sessions tuned navigation, typography, density, and account/detail views across M3U/Xtream/Stalker.
- The plan should identify where playback type/mode should be derived and propagated so workspace shell behavior is not hardcoded in one visual component.
- The plan should preserve provider-specific flows for Xtream/Stalker/VOD/series while carving out a radio/audio-specific state.
- Validation should include both audio radio channels and normal video/VOD/series playback so the layout split does not regress other modes.

Anti-patterns:
- Hiding EPG globally for all playback.
- Styling a single component without checking workspace shell consequences.
- Ignoring light/dark theme and cross-provider consistency.
- Treating M3U radio as only a CSS variant of video playback.
