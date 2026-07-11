export const initialMigrationSql = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('player', 'agent', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, id)
);

CREATE INDEX messages_session_created_idx
  ON messages(session_id, created_at, id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id, source_message_id)
    REFERENCES messages(session_id, id)
    ON UPDATE CASCADE
);

CREATE INDEX memories_session_importance_idx
  ON memories(session_id, importance DESC, created_at DESC);

CREATE TRIGGER messages_clear_memory_source
BEFORE DELETE ON messages
FOR EACH ROW
BEGIN
  UPDATE memories
  SET source_message_id = NULL
  WHERE session_id = OLD.session_id AND source_message_id = OLD.id;
END;

CREATE TABLE world_states (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX events_session_created_idx
  ON events(session_id, created_at, id);

CREATE TABLE action_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action_json TEXT NOT NULL CHECK (json_valid(action_json)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')
  ),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX action_runs_session_status_idx
  ON action_runs(session_id, status, created_at, id);
`;
