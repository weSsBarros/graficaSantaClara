'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./sqlite');

// Cada item do array é uma migração (SQL, ou uma função quando precisa de código). Nunca altere
// uma migração já publicada: acrescente uma nova no final. A versão fica em PRAGMA user_version.
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

  // ---------- v2: itens detalhados, pedidos/entrega, clientes e financeiro ----------
  `
  -- Itens: sai a lista fixa de categorias (agora validada no sistema) e entram os detalhes
  -- (modelo, formato, cor, marca, código de barras...), o papel-base dos impressos e
  -- os limites de alerta configuráveis. SQLite não altera CHECK: a tabela é recriada.
  CREATE TABLE items_new (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category          TEXT NOT NULL,
    source            TEXT NOT NULL DEFAULT 'compra' CHECK (source IN ('compra','producao')),
    unit              TEXT NOT NULL,
    pack_unit         TEXT,
    pack_size         REAL,
    quantity          REAL NOT NULL DEFAULT 0,
    min_stock         REAL NOT NULL DEFAULT 0,     -- avisar abaixo desta quantidade (0 = não avisa)
    alert_days        INTEGER NOT NULL DEFAULT 0,  -- avisar quando o saldo cobrir menos de N dias (0 = não avisa)
    lead_time_days    INTEGER NOT NULL DEFAULT 0,  -- prazo de entrega do fornecedor (sugestão de compra)
    notify            INTEGER NOT NULL DEFAULT 1,  -- mandar aviso por WhatsApp/e-mail/Telegram
    model             TEXT,                        -- modelo/linha (ex.: Oferta, Aproveite, Splash)
    size              TEXT,                        -- formato (ex.: 46x66, 96x64)
    grammage          REAL,                        -- gramatura (g/m²)
    color_name        TEXT,
    color_hex         TEXT,
    brand             TEXT,
    code              TEXT,                        -- referência do fornecedor
    barcode           TEXT,
    made_from_item_id INTEGER REFERENCES items(id), -- papel usado para imprimir este item
    last_unit_cost    REAL,                        -- último custo unitário pago
    notes             TEXT,
    active            INTEGER NOT NULL DEFAULT 1,
    alert_state       TEXT NOT NULL DEFAULT 'ok',
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  INSERT INTO items_new (id, name, category, source, unit, pack_unit, pack_size, quantity, min_stock, alert_days,
                         lead_time_days, notes, active, alert_state, sort_order, created_at, updated_at)
  SELECT id, name,
         CASE WHEN category = 'papel' AND source = 'producao' THEN 'impresso' ELSE category END,
         source, unit, pack_unit, pack_size, quantity, min_stock,
         CASE WHEN source = 'compra' THEN lead_time_days ELSE 0 END,
         lead_time_days, notes, active, alert_state, sort_order, created_at, updated_at
    FROM items;
  UPDATE items_new SET made_from_item_id =
    (SELECT p.input_item_id FROM processes p WHERE p.kind = 'impressao' AND p.output_item_id = items_new.id LIMIT 1);
  DROP TABLE items;
  ALTER TABLE items_new RENAME TO items;
  CREATE UNIQUE INDEX items_barcode ON items(barcode) WHERE barcode IS NOT NULL;

  -- A tabela processes fica só pelo histórico (v1). Desde a v2, quem pode imprimir/empacotar
  -- é definido nas permissões por função e o papel-base vem do cadastro de cada impresso.

  CREATE TABLE clients (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone      TEXT,
    email      TEXT,
    address    TEXT,
    document   TEXT,
    notes      TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Pedidos: aberto -> parcial (parte empacotada) -> pronto -> saiu (para entrega) -> entregue | cancelado
  CREATE TABLE orders (
    id             INTEGER PRIMARY KEY,
    client_id      INTEGER NOT NULL REFERENCES clients(id),
    status         TEXT NOT NULL DEFAULT 'aberto',
    due_date       TEXT,
    notes          TEXT,
    total          REAL NOT NULL DEFAULT 0,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    shipped_at     TEXT,
    shipped_by     INTEGER REFERENCES users(id),
    carrier        TEXT,
    delivered_at   TEXT,
    delivered_by   INTEGER REFERENCES users(id),
    received_by    TEXT,
    delivery_notes TEXT,
    canceled_at    TEXT,
    canceled_by    INTEGER REFERENCES users(id),
    cancel_reason  TEXT
  );
  CREATE INDEX orders_status ON orders(status, due_date);
  CREATE INDEX orders_client ON orders(client_id);

  CREATE TABLE order_items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id),
    item_id    INTEGER NOT NULL REFERENCES items(id),
    quantity   REAL NOT NULL,
    unit_price REAL NOT NULL DEFAULT 0,
    packed     REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX order_items_order ON order_items(order_id);

  ALTER TABLE operations ADD COLUMN order_id INTEGER REFERENCES orders(id);
  ALTER TABLE operations ADD COLUMN order_item_id INTEGER REFERENCES order_items(id);
  ALTER TABLE operations ADD COLUMN total_cost REAL;
  CREATE INDEX operations_order ON operations(order_id);

  CREATE TABLE finance_categories (
    id     INTEGER PRIMARY KEY,
    kind   TEXT NOT NULL CHECK (kind IN ('despesa','receita')),
    name   TEXT NOT NULL COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (kind, name)
  );
  INSERT INTO finance_categories (kind, name) VALUES
    ('despesa','Papel'), ('despesa','Tinta'), ('despesa','Chapa'), ('despesa','Outros materiais'),
    ('despesa','Manutenção'), ('despesa','Energia'), ('despesa','Água'), ('despesa','Aluguel'),
    ('despesa','Salários'), ('despesa','Transporte / entrega'), ('despesa','Impostos e taxas'),
    ('despesa','Internet / telefone'), ('despesa','Outras despesas'),
    ('receita','Vendas'), ('receita','Outras receitas');

  -- Contas a pagar e a receber. paid_at NULL = em aberto. Cancelamento é lógico (fica no histórico).
  CREATE TABLE finance_entries (
    id               INTEGER PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('despesa','receita')),
    category_id      INTEGER NOT NULL REFERENCES finance_categories(id),
    description      TEXT NOT NULL,
    amount           REAL NOT NULL CHECK (amount > 0),
    date             TEXT NOT NULL,
    due_date         TEXT,
    paid_at          TEXT,
    payment_method   TEXT,
    counterparty     TEXT,
    order_id         INTEGER REFERENCES orders(id),
    operation_id     INTEGER REFERENCES operations(id),
    recurrence_group TEXT,
    notes            TEXT,
    created_by       INTEGER NOT NULL REFERENCES users(id),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    canceled_at      TEXT,
    canceled_by      INTEGER REFERENCES users(id),
    cancel_reason    TEXT
  );
  CREATE INDEX finance_date ON finance_entries(date);
  CREATE INDEX finance_due ON finance_entries(due_date);
  CREATE INDEX finance_order ON finance_entries(order_id);
  CREATE INDEX finance_operation ON finance_entries(operation_id);
  `,

  // ---------- v3: equipe (setembro/2026) ----------
  // "Secretaria" passa a se chamar "Auxiliar administrativo" e entra a função "Entregador".
  // Em instalações que já existiam: a Gabrielle sai da equipe e o Wesley (entregas) entra.
  (db) => {
    db.exec(`
      CREATE TABLE users_new (
        id              INTEGER PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role            TEXT NOT NULL CHECK (role IN ('dono','admin','auxiliar','impressor','empacotador','entregador')),
        pin_hash        TEXT NOT NULL,
        must_change_pin INTEGER NOT NULL DEFAULT 1,
        active          INTEGER NOT NULL DEFAULT 1,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until    TEXT,
        created_at      TEXT NOT NULL
      );
      INSERT INTO users_new (id, name, role, pin_hash, must_change_pin, active, failed_attempts, locked_until, created_at)
        SELECT id, name, CASE role WHEN 'secretaria' THEN 'auxiliar' ELSE role END,
               pin_hash, must_change_pin, active, failed_attempts, locked_until, created_at
          FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    const perms = getSetting(db, 'role_perms', null);
    if (perms && perms.secretaria) {
      perms.auxiliar = perms.secretaria;
      delete perms.secretaria;
      setSetting(db, 'role_perms', perms);
    }

    // Banco novo (ainda sem ninguém): o cadastro inicial já cria a equipe atual.
    if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
    const { hashPin } = require('./auth');
    const { audit } = require('./audit');
    const { nowIso } = require('./util');
    const { INITIAL_PIN } = require('./seed');
    const gabi = db.prepare("SELECT id FROM users WHERE name = 'Gabrielle' AND active = 1").get();
    if (gabi) {
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gabi.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(gabi.id);
      audit(db, {
        action: 'pessoa_alterada', entity: 'user', entityId: gabi.id,
        summary: 'Gabrielle saiu da equipe: acesso desativado (os lançamentos dela continuam no histórico).',
      });
    }
    if (!db.prepare("SELECT 1 FROM users WHERE name = 'Wesley'").get()) {
      const id = db
        .prepare("INSERT INTO users (name, role, pin_hash, must_change_pin, created_at) VALUES ('Wesley', 'entregador', ?, 1, ?)")
        .run(hashPin(INITIAL_PIN), nowIso()).lastInsertRowid;
      audit(db, {
        action: 'pessoa_criada', entity: 'user', entityId: Number(id),
        summary: `Wesley entrou na equipe como Entregador (PIN inicial ${INITIAL_PIN}, troca no primeiro acesso).`,
      });
    }
  },

  // ---------- v4: produtos da gráfica, rendimento por folha, cidade do cliente, nota fiscal ----------
  // O papel é o branco 94x66 e cada produto diz quanto rende uma folha branca (Amarelo pequeno,
  // Oferta e Aproveite: 2; Splash: 8). Se o catálogo inicial antigo ainda não foi usado, é trocado.
  (db) => {
    db.exec(`
      ALTER TABLE items ADD COLUMN yield_per_sheet REAL NOT NULL DEFAULT 1;  -- unidades por folha de papel
      ALTER TABLE items ADD COLUMN package_sizes TEXT;                      -- pacotes usuais, ex.: '150,200'
      ALTER TABLE clients ADD COLUMN city TEXT;                             -- vazio = São Luís
      ALTER TABLE orders ADD COLUMN channel TEXT;                           -- por onde chegou (WhatsApp, e-mail...)
      ALTER TABLE orders ADD COLUMN invoice_number TEXT;                    -- nota fiscal
      ALTER TABLE orders ADD COLUMN invoice_at TEXT;
    `);
    if (!db.prepare('SELECT 1 FROM items LIMIT 1').get()) return; // banco novo: o cadastro inicial já vem certo
    const used = db.prepare('SELECT (SELECT COUNT(*) FROM movements) + (SELECT COUNT(*) FROM order_items) AS n').get().n;
    if (used) return; // já em uso: a administração ajusta os itens pela tela
    const OLD = ['Papel branco 46x66', 'Papel branco 96x64'];
    for (const m of ['Oferta', 'Aproveite', 'Splash']) OLD.push(`${m} 46x66`, `${m} 96x64`);
    const old = db.prepare(`SELECT id FROM items WHERE name IN (${OLD.map(() => '?').join(',')})`).all(...OLD).map((r) => r.id);
    if (!old.length) return;
    const list = old.join(',');
    db.exec(`UPDATE items SET made_from_item_id = NULL WHERE made_from_item_id IN (${list}) AND id NOT IN (${list})`);
    db.exec(`DELETE FROM items WHERE id IN (${list})`);
    const { insertSeedItems } = require('./seed');
    const { audit } = require('./audit');
    insertSeedItems(db);
    audit(db, {
      action: 'item_criado',
      summary: 'Catálogo atualizado: Papel branco 94x66 (pacote de 150), Amarelo grande 94x66, Amarelo pequeno 46x64, ' +
        'Oferta, Aproveite e Splash, com o rendimento de cada um por folha branca.',
    });
  },
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= MIGRATIONS.length) return;
  // Recriar tabelas (como na v2 e na v3) exige as chaves estrangeiras desligadas durante a migração;
  // no fim de cada etapa conferimos se nenhuma referência ficou quebrada.
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        const step = MIGRATIONS[v];
        if (typeof step === 'function') step(db);
        else db.exec(step);
        const broken = db.pragma('foreign_key_check');
        if (broken.length) throw new Error(`Migração ${v + 1}: referências quebradas em ${broken[0].table}`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openDatabase(file);
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

module.exports = { openDb, migrate, getSetting, setSetting, MIGRATIONS };
