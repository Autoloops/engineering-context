# Gold Guidance

The plan should identify this as an analytics data-shape/grouping problem spanning API data aggregation, route schema, and chart rendering.

Important facts to recover:
- The duplicate visible project is caused by grouping/identity using a path or unstable project identifier where the chart should group by exact project display/name for Project Trends.
- The relevant fix path includes API/service aggregation and response schema, not only frontend de-duplication.
- Frontend chart code should receive already-correct project trend series and render them without papering over backend identity mistakes.
- Prior Rudel analytics work involved slow overview queries and chart/legend changes; the plan should be mindful of query performance while changing grouping.

Anti-patterns:
- Suggesting only a React-side `Set`/dedupe in the chart.
- Ignoring API route/schema changes.
- Treating similar display names as fuzzy matches; the target is exact-name grouping for this chart.
- Proposing broad analytics rewrites rather than a focused grouping correction with tests.
