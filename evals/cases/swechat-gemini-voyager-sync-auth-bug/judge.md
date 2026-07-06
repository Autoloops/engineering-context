# Gold Guidance

The plan should understand this as a browser-extension cloud sync/auth lifecycle issue, not a generic OAuth setup task.

Important facts to recover:
- The likely issue is calling browser identity/auth token APIs too eagerly, especially on startup or when sync is disabled/unavailable.
- The plan should inspect cloud sync service code, extension manifest/permissions, popup/content integration, and browser-specific behavior.
- The desired direction is to avoid unnecessary `getAuthToken` calls unless sync is enabled or the user explicitly triggers sync, while preserving existing sync behavior for enabled users.
- The plan should include browser-specific validation for Chrome-like browsers and note that not all users reproduce the issue.
- Prior sessions include popup/content UX and sync-service work, so a good plan should use that context without changing unrelated extension features.
- The plan should separate auth-token acquisition, startup initialization, settings/feature gates, and user-triggered sync actions rather than treating sync as always-on.
- The plan should include a staged rollout/risk check because the bug is intermittent and browser-specific.

Anti-patterns:
- Assuming the OAuth client configuration is definitely wrong without checking call timing.
- Removing sync or broadening permissions as the first fix.
- Ignoring disabled-sync/startup paths.
- Proposing a web-only fix that does not account for extension APIs.
- Refactoring all cloud sync storage when the likely failure is lifecycle and auth timing.
