import { renderGraphContextMarkdown } from "../../../libs/knowledge-graph/graph-context/render.js";
import type { ToolHandler } from "../middleware/compose.js";
import type { QueryContextInput } from "../schemas.js";

export const queryContext: ToolHandler<QueryContextInput> = async (input, context) => {
  const installed = context.container.getInstalled(input.repo_root);
  const result = await installed.service.contextGraph(installed.repo, input.query);
  const markdown = renderGraphContextMarkdown(result);

  const content = input.debug
    ? [
        { type: "text" as const, text: markdown },
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ]
    : [{ type: "text" as const, text: markdown }];

  return { content, structuredContent: { markdown } };
};
