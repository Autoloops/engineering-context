# Gold Guidance

The plan should understand that conversation forking crosses user gestures, new window/tab creation, async export work, and data transfer between tabs.

Important facts to recover:
- Firefox and Safari are stricter about popup blockers and user gesture preservation; `window.open` should happen synchronously before awaited work.
- Cross-tab fork data should not rely on fragile sessionStorage copy semantics across browsers.
- The plan should inspect the fork feature, export/markdown preparation, storage/message passing, and browser-specific utility abstractions.
- The fix direction should preserve the current fork UX while moving async preparation after a safe tab/window handle exists.
- The plan should account for cleanup/error states when the tab opens but data prep fails, and when popup creation is blocked.
- Prior cross-browser extension decisions should guide whether to use extension storage, messaging, URL tokens, or another handoff mechanism.
- Validation should cover Chrome, Firefox, and Safari-style behavior, including blocked popups, fork data cleanup, and failure messaging.

Anti-patterns:
- Treating this as a CSS/UI alignment issue.
- Adding arbitrary timeouts without addressing user gesture timing.
- Assuming sessionStorage behaves identically after `window.open` in every browser.
- Rewriting the whole fork feature instead of narrowing on browser lifecycle constraints.
- Fixing only Chrome or Chromium while claiming cross-browser support.
