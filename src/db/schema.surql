-- Discordlancer schema for SurrealDB 4. Safe to run again: every definition uses OVERWRITE.
-- Applied by `npm run db:migrate` and at startup. See PLAN.md, "Data model".
--
-- Money is integer micro-USDC (6 decimals). Times are set by the database.
-- History tables (event, spec, quote, agreement, payment) are append-only: an event
-- throws on UPDATE or DELETE, because table permissions don't bind system users.

-- Projects ------------------------------------------------------------------

DEFINE TABLE OVERWRITE project SCHEMAFULL;
DEFINE FIELD OVERWRITE name ON project TYPE string ASSERT string::matches($value, /^[a-z0-9]+(-[a-z0-9]+)*$/);
DEFINE FIELD OVERWRITE channel_id ON project TYPE string;
DEFINE FIELD OVERWRITE repo ON project TYPE string;
DEFINE FIELD OVERWRITE invite_code ON project TYPE option<string>;
DEFINE FIELD OVERWRITE client_id ON project TYPE option<string>;
DEFINE FIELD OVERWRITE client_github ON project TYPE option<string>;
DEFINE FIELD OVERWRITE client_wallet ON project TYPE option<string>;
DEFINE FIELD OVERWRITE delivery_marked_at ON project TYPE option<datetime>;
DEFINE FIELD OVERWRITE delivery_note ON project TYPE option<string>;
-- SHA-256 of the key Boran's Claude Code session uses to post progress updates (never the key).
DEFINE FIELD OVERWRITE dev_key_hash ON project TYPE option<string>;
DEFINE FIELD OVERWRITE stage ON project TYPE string ASSERT $value IN [
  "created", "joined", "specs_agreed", "quote_accepted", "paid",
  "in_development", "delivered", "support", "cancelled", "archived"
];
DEFINE FIELD OVERWRITE created_at ON project TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON project TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE project_name ON project FIELDS name UNIQUE;
DEFINE INDEX OVERWRITE project_channel ON project FIELDS channel_id UNIQUE;
DEFINE INDEX OVERWRITE project_dev_key ON project FIELDS dev_key_hash;

-- Event log (append-only) ---------------------------------------------------

DEFINE TABLE OVERWRITE event SCHEMAFULL;
DEFINE FIELD OVERWRITE at ON event TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD OVERWRITE project ON event TYPE option<record<project>>;
DEFINE FIELD OVERWRITE actor ON event TYPE string ASSERT $value IN ["owner", "client", "bot"];
DEFINE FIELD OVERWRITE actor_id ON event TYPE option<string>;
DEFINE FIELD OVERWRITE action ON event TYPE string;
DEFINE FIELD OVERWRITE outcome ON event TYPE string ASSERT $value IN ["ok", "refused", "failed"];
DEFINE FIELD OVERWRITE data ON event TYPE option<object> FLEXIBLE;
DEFINE INDEX OVERWRITE event_project_at ON event FIELDS project, at;
DEFINE EVENT OVERWRITE append_only ON event WHEN $event IN ["UPDATE", "DELETE"] THEN {
  THROW "event records are append-only";
};

-- Specs (append-only) -------------------------------------------------------

DEFINE TABLE OVERWRITE spec SCHEMAFULL;
DEFINE FIELD OVERWRITE project ON spec TYPE record<project>;
DEFINE FIELD OVERWRITE version ON spec TYPE int ASSERT $value >= 1;
DEFINE FIELD OVERWRITE markdown ON spec TYPE string;
DEFINE FIELD OVERWRITE changes ON spec TYPE array<string>;
DEFINE FIELD OVERWRITE open_questions ON spec TYPE array<string>;
DEFINE FIELD OVERWRITE message_count ON spec TYPE int;
DEFINE FIELD OVERWRITE model ON spec TYPE string;
DEFINE FIELD OVERWRITE prompt_version ON spec TYPE string;
DEFINE FIELD OVERWRITE created_at ON spec TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX OVERWRITE spec_version ON spec FIELDS project, version UNIQUE;
DEFINE EVENT OVERWRITE append_only ON spec WHEN $event IN ["UPDATE", "DELETE"] THEN {
  THROW "spec records are append-only";
};

-- Quotes (append-only) ------------------------------------------------------

DEFINE TABLE OVERWRITE quote SCHEMAFULL;
DEFINE FIELD OVERWRITE project ON quote TYPE record<project>;
DEFINE FIELD OVERWRITE version ON quote TYPE int ASSERT $value >= 1;
DEFINE FIELD OVERWRITE amount_micro ON quote TYPE int ASSERT $value > 0;
DEFINE FIELD OVERWRITE deadline ON quote TYPE datetime;
DEFINE FIELD OVERWRITE spec_version ON quote TYPE int ASSERT $value >= 1;
DEFINE FIELD OVERWRITE terms ON quote TYPE string;
DEFINE FIELD OVERWRITE created_at ON quote TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX OVERWRITE quote_version ON quote FIELDS project, version UNIQUE;
DEFINE EVENT OVERWRITE append_only ON quote WHEN $event IN ["UPDATE", "DELETE"] THEN {
  THROW "quote records are append-only";
};

-- Agreements (append-only) --------------------------------------------------

DEFINE TABLE OVERWRITE agreement SCHEMAFULL;
DEFINE FIELD OVERWRITE project ON agreement TYPE record<project>;
DEFINE FIELD OVERWRITE kind ON agreement TYPE string ASSERT $value IN ["spec", "quote"];
DEFINE FIELD OVERWRITE version ON agreement TYPE int ASSERT $value >= 1;
DEFINE FIELD OVERWRITE party ON agreement TYPE string ASSERT $value IN ["owner", "client"];
DEFINE FIELD OVERWRITE user_id ON agreement TYPE string;
DEFINE FIELD OVERWRITE at ON agreement TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX OVERWRITE agreement_unique ON agreement FIELDS project, kind, version, party UNIQUE;
DEFINE EVENT OVERWRITE append_only ON agreement WHEN $event IN ["UPDATE", "DELETE"] THEN {
  THROW "agreement records are append-only";
};

-- Payment requests ----------------------------------------------------------

DEFINE TABLE OVERWRITE payment_request SCHEMAFULL;
DEFINE FIELD OVERWRITE project ON payment_request TYPE record<project>;
DEFINE FIELD OVERWRITE quote_version ON payment_request TYPE int ASSERT $value >= 1;
DEFINE FIELD OVERWRITE amount_micro ON payment_request TYPE int ASSERT $value > 0;
DEFINE FIELD OVERWRITE reference ON payment_request TYPE string;
DEFINE FIELD OVERWRITE status ON payment_request TYPE string ASSERT $value IN ["open", "paid", "expired"];
DEFINE FIELD OVERWRITE created_at ON payment_request TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON payment_request TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE payment_request_reference ON payment_request FIELDS reference UNIQUE;

-- Payments (append-only) ----------------------------------------------------

DEFINE TABLE OVERWRITE payment SCHEMAFULL;
DEFINE FIELD OVERWRITE project ON payment TYPE record<project>;
DEFINE FIELD OVERWRITE request ON payment TYPE option<record<payment_request>>;
DEFINE FIELD OVERWRITE signature ON payment TYPE string;
DEFINE FIELD OVERWRITE from_wallet ON payment TYPE string;
DEFINE FIELD OVERWRITE to_wallet ON payment TYPE string;
DEFINE FIELD OVERWRITE amount_micro ON payment TYPE int ASSERT $value > 0;
DEFINE FIELD OVERWRITE slot ON payment TYPE int;
DEFINE FIELD OVERWRITE block_time ON payment TYPE option<datetime>;
DEFINE FIELD OVERWRITE verified_at ON payment TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX OVERWRITE payment_signature ON payment FIELDS signature UNIQUE;
DEFINE EVENT OVERWRITE append_only ON payment WHEN $event IN ["UPDATE", "DELETE"] THEN {
  THROW "payment records are append-only";
};

-- Change requests -----------------------------------------------------------

DEFINE TABLE OVERWRITE change_request SCHEMAFULL;
DEFINE FIELD OVERWRITE project ON change_request TYPE record<project>;
DEFINE FIELD OVERWRITE text ON change_request TYPE string;
DEFINE FIELD OVERWRITE triage ON change_request TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE status ON change_request TYPE string ASSERT $value IN [
  "triaged", "needs_info", "approved", "declined", "issue_opened", "pr_open", "merged", "closed"
];
DEFINE FIELD OVERWRITE issue_number ON change_request TYPE option<int>;
DEFINE FIELD OVERWRITE pr_number ON change_request TYPE option<int>;
DEFINE FIELD OVERWRITE created_at ON change_request TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON change_request TYPE datetime VALUE time::now();
