CREATE TABLE town_residents (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  resident_id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, resident_id)
);

CREATE TABLE town_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, event_id),
  UNIQUE (session_id, sequence)
);

CREATE INDEX town_events_session_created_idx
  ON town_events(session_id, created_at, event_id);

CREATE TABLE town_relationships (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  resident_id_a TEXT NOT NULL,
  resident_id_b TEXT NOT NULL,
  relationship_json TEXT NOT NULL CHECK (json_valid(relationship_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, resident_id_a, resident_id_b),
  CHECK (resident_id_a < resident_id_b),
  FOREIGN KEY (session_id, resident_id_a)
    REFERENCES town_residents(session_id, resident_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, resident_id_b)
    REFERENCES town_residents(session_id, resident_id) ON DELETE CASCADE
);

CREATE TABLE town_world_states (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  version INTEGER NOT NULL CHECK (version >= 0),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE town_activity_instances (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  activity_instance_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, activity_instance_id)
);

CREATE INDEX town_activity_instances_active_idx
  ON town_activity_instances(session_id, activity_id, updated_at);

CREATE TABLE town_outings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  resident_id TEXT NOT NULL,
  outing_json TEXT NOT NULL CHECK (json_valid(outing_json)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id, resident_id)
    REFERENCES town_residents(session_id, resident_id) ON DELETE CASCADE
);

CREATE TABLE town_recovery_windows (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recovery_window_id TEXT NOT NULL,
  outing_json TEXT NOT NULL CHECK (json_valid(outing_json)),
  resident_definition_json TEXT NOT NULL CHECK (json_valid(resident_definition_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, recovery_window_id)
);

CREATE TABLE town_experience_cards (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  card_json TEXT NOT NULL CHECK (json_valid(card_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, card_id)
);

CREATE INDEX town_experience_cards_created_idx
  ON town_experience_cards(session_id, created_at, card_id);

CREATE TABLE town_experience_card_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (session_id, card_id, ordinal),
  UNIQUE (session_id, card_id, event_id),
  FOREIGN KEY (session_id, card_id)
    REFERENCES town_experience_cards(session_id, card_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id)
    REFERENCES town_events(session_id, event_id) ON DELETE CASCADE
);

CREATE TABLE public_showcase_items (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  is_public INTEGER NOT NULL CHECK (is_public = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, item_id)
);
