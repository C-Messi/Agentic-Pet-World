DROP INDEX action_runs_session_status_idx;

ALTER TABLE action_runs RENAME TO action_runs_v1;

CREATE TABLE action_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_correlation_id TEXT NOT NULL,
  action_json TEXT NOT NULL CHECK (json_valid(action_json)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')
  ),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_world_hash TEXT,
  result_world_json TEXT CHECK (
    result_world_json IS NULL OR json_valid(result_world_json)
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (result_json IS NULL AND result_world_hash IS NULL AND result_world_json IS NULL)
    OR
    (result_json IS NOT NULL AND result_world_hash IS NOT NULL AND result_world_json IS NOT NULL)
  )
);

INSERT INTO action_runs (
  id,
  session_id,
  turn_correlation_id,
  action_json,
  status,
  result_json,
  result_world_hash,
  result_world_json,
  created_at,
  updated_at
)
SELECT
  id,
  session_id,
  'legacy-' || printf('%016x', rowid),
  action_json,
  status,
  result_json,
  CASE
    WHEN result_json IS NULL THEN NULL
    ELSE '5c4f0f7b3d50292828cbe3cbee4e929cc73b77c6aed113b3a4eb7997175b2e71'
  END,
  CASE
    WHEN result_json IS NULL THEN NULL
    ELSE '{"cat":{"position":{"x":0,"y":0},"emotion":"idle"},"objects":[]}'
  END,
  created_at,
  updated_at
FROM action_runs_v1;

DROP TABLE action_runs_v1;

CREATE INDEX action_runs_session_status_idx
  ON action_runs(session_id, status, created_at, id);

CREATE UNIQUE INDEX action_runs_turn_action_idx
  ON action_runs(session_id, turn_correlation_id, json_extract(action_json, '$.id'));
