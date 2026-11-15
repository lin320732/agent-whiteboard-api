-- Editable account labels. principals.name remains the immutable actor identity used
-- for task ownership, scoring, and stored attribution.
CREATE TABLE IF NOT EXISTS principal_labels (
  principal_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL
);
