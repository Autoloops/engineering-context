import type { GreplicaConfig } from "../config/greplica-config.js";
import { graphContextConfigFromGreplicaConfig } from "./graph-context/config.js";
import { createLocalKnowledgeGraphProvider } from "./local-provider.js";
import { ManagedKnowledgeGraphClient } from "./managed-client.js";
import type { KnowledgeGraphProvider } from "./provider.js";

export function createKnowledgeGraphProvider(config: GreplicaConfig): KnowledgeGraphProvider {
  if (config.mode === "managed") {
    if (config.managed === undefined) {
      throw new Error("Greplica is configured for managed mode, but managed API settings are missing.");
    }
    return new ManagedKnowledgeGraphClient(config.managed);
  }

  return createLocalKnowledgeGraphProvider(graphContextConfigFromGreplicaConfig(config), config.session);
}
