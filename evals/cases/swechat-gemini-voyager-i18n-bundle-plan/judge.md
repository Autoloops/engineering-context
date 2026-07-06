# Gold Guidance

The plan should understand this as an extension build/runtime i18n problem, not just a translation-file cleanup.

Important facts to recover:
- Locale JSON is used by the extension runtime and cannot be refactored blindly like ordinary app strings.
- The likely direction is build-time stripping or generation for fields that are useful in source but unnecessary in production.
- The plan should inspect Vite/custom plugin build hooks, extension manifest/locales, and runtime translation access.
- It should preserve Chrome extension i18n compatibility and avoid breaking popup/content-script text lookup.
- Tests/validation should compare development source messages, production output, bundle size, and runtime localized UI.

Anti-patterns:
- Moving all translations to a runtime service without checking extension constraints.
- Removing fields directly from source locale files when they are useful for maintainability.
- Ignoring build output verification.
