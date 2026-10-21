-- Agent task mailbox. All original model-stage business logic remains in the engine.
CREATE TABLE agent_model_requests (
  id text PRIMARY KEY,
  purpose text NOT NULL,
  subject text NOT NULL,
  prompt_version text NOT NULL,
  request jsonb NOT NULL,
  response jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','invalid','applied')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  applied_at timestamptz
);
