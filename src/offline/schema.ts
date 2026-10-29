// A single SQLite authority; browsers never maintain a second financial ledger.
export const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE allocations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT;
CREATE TABLE budgets(allocation_id TEXT NOT NULL REFERENCES allocations(id), resource_id INTEGER NOT NULL,
 remaining INTEGER NOT NULL CHECK(remaining>=0), PRIMARY KEY(allocation_id,resource_id)) STRICT;
CREATE TABLE grants(id TEXT PRIMARY KEY, cashier_id TEXT NOT NULL, body TEXT NOT NULL, token TEXT NOT NULL,
 salt TEXT NOT NULL, pin_hash TEXT NOT NULL, record_signature TEXT NOT NULL) STRICT;
CREATE TABLE login_limits(slot TEXT PRIMARY KEY, attempts INTEGER NOT NULL, started_at INTEGER NOT NULL) STRICT;
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE drafts(cashier_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL UNIQUE, input TEXT NOT NULL) STRICT;
CREATE TABLE sales(id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, cashier_id TEXT NOT NULL,
 grant_id TEXT NOT NULL REFERENCES grants(id), input_hash TEXT NOT NULL, envelope TEXT NOT NULL, signature TEXT NOT NULL) STRICT;
CREATE TABLE outbox(sale_id TEXT PRIMARY KEY REFERENCES sales(id), state TEXT NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','attempting','outcome_unknown','acknowledged','needs_review')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, acknowledgement TEXT) STRICT;
CREATE TABLE hardware(id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id),
 kind TEXT NOT NULL CHECK(kind IN ('drawer','receipt')), state TEXT NOT NULL
 CHECK(state IN ('ready','pending','submitted','rejected','outcome_unknown')), claimed_at INTEGER, detail TEXT) STRICT;
CREATE TRIGGER immutable_sale_update BEFORE UPDATE ON sales BEGIN SELECT RAISE(ABORT,'immutable_sale'); END;
CREATE TRIGGER immutable_sale_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT,'immutable_sale'); END;
CREATE TRIGGER immutable_grant_update BEFORE UPDATE ON grants BEGIN SELECT RAISE(ABORT,'immutable_grant'); END;
CREATE TRIGGER immutable_grant_delete BEFORE DELETE ON grants BEGIN SELECT RAISE(ABORT,'immutable_grant'); END;
CREATE TRIGGER immutable_allocation_update BEFORE UPDATE ON allocations BEGIN SELECT RAISE(ABORT,'immutable_allocation'); END;
CREATE TRIGGER immutable_allocation_delete BEFORE DELETE ON allocations BEGIN SELECT RAISE(ABORT,'immutable_allocation'); END;
PRAGMA user_version=1;
`;
