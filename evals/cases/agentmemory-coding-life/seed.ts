import type { Session } from "./dataset.js";

const PROJECT_COMPONENT_ID = "component.shipctl_project";

export interface SeedProposal {
  title: string;
  summary: string;
  creates: {
    components: Array<{ id: string; name: string }>;
    flows: never[];
    claims: Array<{
      id: string;
      kind: "fact";
      text: string;
      truth: "source_verified";
      intent: "intended";
      about: string[];
    }>;
    sources: never[];
    edges: never[];
  };
}

function claimIdFor(sessionId: string): string {
  return `claim.${sessionId.replace(/[^a-z0-9]+/gi, "_")}`;
}

// Each session becomes one source-verified claim attached to a single umbrella
// component, so greplica's retrieval has per-session memory to rank and return.
// The session id and timestamp are kept in the claim text so a retrieving agent
// can cite which session an answer came from.
export function buildSeedProposal(sessions: Session[]): SeedProposal {
  const claims = sessions.map((session) => ({
    id: claimIdFor(session.id),
    kind: "fact" as const,
    text: `Session ${session.id}${session.timestamp ? ` (${session.timestamp})` : ""}: ${session.content}`,
    truth: "source_verified" as const,
    intent: "intended" as const,
    about: [PROJECT_COMPONENT_ID],
  }));

  return {
    title: "AgentMemory coding-agent-life-v1 session memory",
    summary:
      "Per-session memory for the fictional shipctl CLI project, seeded from the coding-agent-life-v1 corpus so greplica retrieval can answer recall queries.",
    creates: {
      components: [{ id: PROJECT_COMPONENT_ID, name: "shipctl CLI project" }],
      flows: [],
      claims,
      sources: [],
      edges: [],
    },
  };
}
