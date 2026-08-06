# Gold Guidance

The plan should understand Voyager's folder system, Gemini sidebar DOM integration, prompt generation, and import/merge behavior.

Important facts to recover:
- The feature should collect current sidebar conversation titles/links plus existing folder structure, then generate a prompt users can paste into Gemini.
- The plan should preserve existing folders, colors, ordering, and manually organized content rather than overwriting everything.
- The returned AI output needs a safe import/paste path, likely JSON or structured data, with validation and merge semantics.
- The prompt should be language-aware/localized and should include only the necessary unfiled or target conversations.
- It should inspect content scripts/sidebar scraping, popup or folder UI entry points, folder import dialog, storage schema, and localization files.
- Prior folder import/reorder/color decisions are central constraints; the plan should avoid inventing a second folder model.
- The plan should define privacy and consent boundaries: user-triggered prompt copy/paste, minimal data, validation before merge, and no silent external send.
- Validation should cover scraping, prompt copy, paste/import validation, merge versus overwrite behavior, dark/light UI, and failure handling for malformed output.

Anti-patterns:
- Sending all user conversation data to an external service automatically without user action.
- Overwriting the entire folder tree by default.
- Ignoring folder order/color metadata from earlier folder work.
- Building a generic AI feature without tying it to Voyager's existing folder import flow.
- Trusting model output without schema validation and merge preview.
