import type { GreplicaConfig } from "../config/greplica-config.js";
import { managedApiUrl } from "../config/greplica-config.js";
import { managedToken, readManagedCredentials } from "../config/managed-credentials.js";
import { RepoInstallationStore } from "../install/repo-installation-store.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { SqliteRepository } from "../storage/sqlite/repository.js";
import { graphContextConfigFromGreplicaConfig } from "./graph-context/config.js";
import { LocalGraphMemoryProvider } from "./local-provider.js";
import { ManagedGraphMemoryClient } from "./managed-client.js";
import type { GraphMemoryProvider } from "./provider.js";
import { KnowledgeGraphService, type RepoRef } from "./service.js";

export function createGraphMemoryProvider(repo: RepoRef, config: GreplicaConfig): GraphMemoryProvider {
  const db = openDatabase();
  const installation = new RepoInstallationStore(db).require(repo);
  if (installation.activeMode === "local") {
    return new LocalGraphMemoryProvider(
      installation,
      repo,
      new KnowledgeGraphService(new SqliteRepository(db), graphContextConfigFromGreplicaConfig(config)),
      db,
    );
  }

  db.close();
  const credentials = readManagedCredentials();
  const token = managedToken(credentials);
  if (token === undefined) throw new Error("Managed Greplica is not authenticated. Run 'greplica login'.");
  return new ManagedGraphMemoryClient(installation, repo, {
    apiUrl: managedApiUrl(config),
    token,
    credentials,
  });
}

export const createKnowledgeGraphProvider = createGraphMemoryProvider;
