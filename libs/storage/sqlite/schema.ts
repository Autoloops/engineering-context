export const schemaSql = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  remote_url TEXT UNIQUE,
  root_path TEXT UNIQUE,
  repo_name TEXT NOT NULL,
  default_branch TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_scopes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_scope_id TEXT REFERENCES graph_scopes(id) ON DELETE SET NULL,
  ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(repo_id, kind, name)
);

CREATE TABLE IF NOT EXISTS memory_commits (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES graph_scopes(id) ON DELETE CASCADE,
  parent_memory_commit_id TEXT REFERENCES memory_commits(id) ON DELETE SET NULL,
  git_commit_sha TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  code_anchor TEXT,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS flows (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS claims (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  truth TEXT NOT NULL,
  intent TEXT NOT NULL,
  code_anchors TEXT,
  anchor_fingerprints TEXT,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS sources (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS edges (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata TEXT,
  PRIMARY KEY(repo_id, id)
);

CREATE TABLE IF NOT EXISTS graph_memberships (
  scope_id TEXT NOT NULL REFERENCES graph_scopes(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  memory_commit_id TEXT NOT NULL REFERENCES memory_commits(id) ON DELETE CASCADE,
  PRIMARY KEY(scope_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS graph_object_embeddings (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, object_type, object_id, provider, model, dimensions)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  platform TEXT NOT NULL,
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  transcript_path TEXT,
  cwd TEXT,
  guidance_injected_at TEXT,
  stops_since_memory_current INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  last_memory_current_at TEXT,
  PRIMARY KEY(platform, session_id)
);

CREATE TABLE IF NOT EXISTS agent_worker_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  locked_until_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS graph_scopes_repo_idx ON graph_scopes(repo_id);
CREATE INDEX IF NOT EXISTS memory_commits_scope_idx ON memory_commits(scope_id);
CREATE INDEX IF NOT EXISTS graph_memberships_scope_idx ON graph_memberships(scope_id);
CREATE INDEX IF NOT EXISTS graph_memberships_subject_idx ON graph_memberships(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS graph_object_embeddings_repo_idx ON graph_object_embeddings(repo_id);
CREATE INDEX IF NOT EXISTS agent_sessions_repo_idx ON agent_sessions(repo_id);
CREATE INDEX IF NOT EXISTS agent_sessions_seen_idx ON agent_sessions(last_seen_at);
CREATE INDEX IF NOT EXISTS agent_worker_locks_until_idx ON agent_worker_locks(locked_until_at);
`;
