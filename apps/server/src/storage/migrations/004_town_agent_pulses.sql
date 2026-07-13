CREATE TABLE town_agent_pulses (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pulse_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, pulse_id),
  CHECK ((status = 'pending' AND result_json IS NULL) OR
         (status = 'complete' AND result_json IS NOT NULL))
);

CREATE INDEX town_agent_pulses_session_status_idx
  ON town_agent_pulses(session_id, status, updated_at);
