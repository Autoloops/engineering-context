# Gold Guidance

The plan should understand Voyager's changelog/version notification surfaces and how the prompt-manager floating button can carry lightweight status.

Important facts to recover:
- The desired direction is an option between direct changelog popup and a less intrusive NEW badge on the floating prompt-manager trigger.
- Badge mode should open the changelog modal directly, not send users to GitHub.
- Dismissal state matters: the badge should clear after the changelog is viewed and should update when the user changes notification mode.
- The plan should account for the floating button being hidden or not mounted.
- Storage/settings should follow existing extension patterns and support localization/copy updates.
- The plan should reason about version comparison, notification mode transitions, and fallback behavior when the normal trigger surface is unavailable.
- Prior prompt-manager/floating-button and localized release UI work should constrain where the badge lives.
- Validation should include first update, mode toggle, hidden trigger, reload, and major/minor/manual notification behavior.

Anti-patterns:
- Always showing a modal for every update.
- Only changing text links while keeping the interruption behavior.
- Ignoring badge dismissal state.
- Routing users out to GitHub for the normal in-app changelog path.
- Adding a badge without a durable version/dismissal model.
