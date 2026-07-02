import type { ToolHandler } from "../middleware/compose.js";
import type { ProposalInput } from "../schemas.js";

export const validateProposal: ToolHandler<ProposalInput> = async (input, context) => {
  const installed = context.container.getInstalled(input.repo_root);
  const result = await installed.service.validateProposal(installed.repo, input.proposal);

  const text = result.valid
    ? "Proposal is valid."
    : `Proposal is invalid:\n${result.errors.map((error) => `- ${error}`).join("\n")}`;

  return {
    content: [{ type: "text", text }],
    structuredContent: { valid: result.valid, errors: result.errors },
  };
};
