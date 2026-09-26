'use strict';

const { hashPin } = require('./auth');
const { audit } = require('./audit');
const { nowIso } = require('./util');

// PIN inicial de todo mundo. No primeiro acesso o sistema obriga cada pessoa a trocar.
const INITIAL_PIN = '2580';

const USERS = [
  { name: 'Joatan', role: 'dono' },
  { name: 'Márcia', role: 'admin' },
  { name: 'Gabrielle', role: 'secretaria' },
  { name: 'Natan', role: 'impressor' },
  { name: 'Eulir', role: 'empacotador' },
];

// Cadastro inicial sugerido. Tudo pode ser alterado depois em Configurações > Itens.
const ITEMS = [
  {
    name: 'Folha branca', category: 'papel', source: 'compra', unit: 'folha', pack_unit: 'resma', pack_size: 500,
    min_stock: 10000, lead_time_days: 7, sort_order: 1,
    notes: 'Papel virgem, antes de passar na impressora.',
  },
  {
    name: 'Folha amarela (impressa)', category: 'papel', source: 'producao', unit: 'folha', pack_unit: null, pack_size: null,
    min_stock: 2000, lead_time_days: 0, sort_order: 2,
    notes: 'Folha que já saiu da impressora e aguarda empacotamento.',
  },
  {
    name: 'Tinta amarela', category: 'tinta', source: 'compra', unit: 'litro', pack_unit: null, pack_size: null,
    min_stock: 2, lead_time_days: 10, sort_order: 3,
    notes: 'Ajuste a unidade (litro, kg, cartucho, lata...) conforme a tinta usada na máquina.',
  },
];

function seedIfEmpty(db, { log = console.log } = {}) {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUsers) return false;
  const now = nowIso();
  db.transaction(() => {
    const insUser = db.prepare('INSERT INTO users (name, role, pin_hash, must_change_pin, created_at) VALUES (?, ?, ?, 1, ?)');
    const pinHash = hashPin(INITIAL_PIN);
    for (const u of USERS) insUser.run(u.name, u.role, pinHash, now);

    const insItem = db.prepare(
      `INSERT INTO items (name, category, source, unit, pack_unit, pack_size, min_stock, lead_time_days, notes, sort_order, created_at, updated_at)
       VALUES (@name, @category, @source, @unit, @pack_unit, @pack_size, @min_stock, @lead_time_days, @notes, @sort_order, @now, @now)`
    );
    const ids = ITEMS.map((it) => Number(insItem.run({ ...it, now }).lastInsertRowid));

    const insProc = db.prepare(
      'INSERT INTO processes (name, kind, input_item_id, output_item_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insProc.run('Impressão', 'impressao', ids[0], ids[1], 'impressor', now);
    insProc.run('Empacotamento', 'empacotamento', ids[1], null, 'empacotador', now);

    audit(db, {
      action: 'instalacao',
      summary: `Sistema instalado: ${USERS.length} pessoas, ${ITEMS.length} itens e 2 processos cadastrados.`,
    });
  })();
  log(`[instalação] Banco criado. PIN inicial de todos: ${INITIAL_PIN} (cada pessoa troca no primeiro acesso).`);
  return true;
}

module.exports = { seedIfEmpty, INITIAL_PIN, USERS, ITEMS };
