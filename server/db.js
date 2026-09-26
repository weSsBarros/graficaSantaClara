'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// Cada item do array é uma migração. Nunca altere uma migração já publicada:
// acrescente uma nova no final. A versão fica em PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role            TEXT NOT NULL CHECK (role IN ('dono','admin','secretaria','impressor','empacotador')),
    pin_hash        TEXT NOT NULL,
    must_change_pin INTEGER NOT NULL DEFAULT 1,
    active          INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE items (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category       TEXT NOT NULL CHECK (category IN ('papel','tinta','embalagem','outro')),
    source         TEXT NOT NULL DEFAULT 'compra' CHECK (source IN ('compra','producao')),
    unit           TEXT NOT NULL,
    pack_unit      TEXT,
    pack_size      REAL,
    quantity       REAL NOT NULL DEFAULT 0,
    min_stock      REAL NOT NULL DEFAULT 0,
    lead_time_days INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    active         INTEGER NOT NULL DEFAULT 1,
    alert_state    TEXT NOT NULL DEFAULT 'ok',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE processes (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind           TEXT NOT NULL CHECK (kind IN ('impressao','empacotamento')),
    input_item_id  INTEGER NOT NULL REFERENCES items(id),
    output_item_id INTEGER REFERENCES items(id),
    roles          TEXT NOT NULL DEFAULT '',
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL
  );

  -- Um lançamento (entrada, retirada, produção...). Agrupa um ou mais movimentos de estoque.
  CREATE TABLE operations (
    id             INTEGER PRIMARY KEY,
    type           TEXT NOT NULL CHECK (type IN ('entrada','retirada','ajuste','impressao','empacotamento','estorno')),
    user_id        INTEGER NOT NULL REFERENCES users(id),
    process_id     INTEGER REFERENCES processes(id),
    input_qty      REAL,
    output_qty     REAL,
    waste_qty      REAL,
    packages       INTEGER,
    per_package    REAL,
    client         TEXT,
    supplier       TEXT,
    reason         TEXT,
    note           TEXT,
    summary        TEXT NOT NULL,
    reverses_id    INTEGER REFERENCES operations(id),
    reversed_by_id INTEGER REFERENCES operations(id),
    occurred_at    TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX operations_occurred ON operations(occurred_at);
  CREATE INDEX operations_type ON operations(type, occurred_at);
  CREATE INDEX operations_user ON operations(user_id, created_at);

  -- Livro-razão do estoque: cada linha altera o saldo de um item. Nunca é editado nem apagado.
  CREATE TABLE movements (
    id            INTEGER PRIMARY KEY,
    operation_id  INTEGER NOT NULL REFERENCES operations(id),
    item_id       INTEGER NOT NULL REFERENCES items(id),
    delta         REAL NOT NULL,
    balance_after REAL NOT NULL,
    occurred_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX movements_item_time ON movements(item_id, occurred_at);
  CREATE INDEX movements_operation ON movements(operation_id);

  CREATE TABLE maintenance (
    id               INTEGER PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    machine          TEXT NOT NULL,
    type             TEXT NOT NULL CHECK (type IN ('preventiva','corretiva','limpeza','troca_peca','outro')),
    description      TEXT NOT NULL,
    downtime_minutes INTEGER,
    occurred_at      TEXT NOT NULL,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX maintenance_occurred ON maintenance(occurred_at);

  -- Registro de auditoria: tudo o que foi feito no sistema, por quem e quando.
  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id),
    user_name  TEXT,
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  INTEGER,
    summary    TEXT NOT NULL,
    details    TEXT,
    ip         TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_created ON audit_log(created_at);
  CREATE INDEX audit_user ON audit_log(user_id, created_at);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Garantia de integridade: histórico e auditoria são somente-inserção.
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'O registro de auditoria não pode ser alterado.'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'O registro de auditoria não pode ser apagado.'); END;
  CREATE TRIGGER movements_no_update BEFORE UPDATE ON movements
    BEGIN SELECT RAISE(ABORT, 'Movimentos de estoque não podem ser alterados; use estorno.'); END;
  CREATE TRIGGER movements_no_delete BEFORE DELETE ON movements
    BEGIN SELECT RAISE(ABORT, 'Movimentos de estoque não podem ser apagados; use estorno.'); END;
  `,
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

module.exports = { openDb, migrate, getSetting, setSetting };
