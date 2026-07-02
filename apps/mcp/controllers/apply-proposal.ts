import type { ToolHandler } from "../middleware/compose.js";
import type { ProposalInput } from "../schemas.js";

export const applyProposal: ToolHandler<ProposalInput> = async (input, context) => {
  const installed = context.container.getInstalled(input.repo_root);

  // Validation happens once, inside service.applyProposal. Its "Proposal is
  // invalid" throw is classified to PROPOSAL_INVALID by the error middleware.
  const result = await installed.service.applyProposal(installed.repo, input.proposal);
  context.container.invalidateGraph(installed.repoId);

  const { created } = result;
  const summary = [
    "Applied proposal to working memory.",
    `commit=${result.memory_commit_id}`,
    `components=${created.components}`,
    `flows=${created.flows}`,
    `claims=${created.claims}`,
    `sources=${created.sources}`,
    `edges=${created.edges}`,
  ].join(" ");

  return {
    content: [{ type: "text", text: summary }],
    structuredContent: {
      memory_commit_id: result.memory_commit_id,
      scope_id: result.scope_id,
      created: result.created,
      embedding_status: result.embedding_status,
    },
  };
};
