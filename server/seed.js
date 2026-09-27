'use strict';

const { hashPin } = require('./auth');
const { audit } = require('./audit');
const { nowIso } = require('./util');

// PIN inicial de todo mundo. No primeiro acesso o sistema obriga cada pessoa a trocar.
const INITIAL_PIN = '2580';

const USERS = [
  { name: 'Joatan', role: 'dono' },
  { name: 'Márcia', role: 'admin' },
  { name: 'Natan', role: 'impressor' },
  { name: 'Eulir', role: 'empacotador' },
  { name: 'Wesley', role: 'entregador' },
];

const MODELS = ['Oferta', 'Aproveite', 'Splash'];
const SIZES = ['46x66', '96x64'];

// Cadastro inicial. Tudo pode ser alterado em Configurações → Itens (inclusive os alertas:
// começam avisando quando o estoque cobrir menos de 10 dias, e sem limite por quantidade).
function seedItems() {
  const items = [];
  SIZES.forEach((size, i) => {
    items.push({
      key: `papel-${size}`, name: `Papel branco ${size}`, category: 'papel', source: 'compra', unit: 'folha', size,
      alert_days: 10, lead_time_days: 7, sort_order: 10 + i, notes: 'Papel virgem, antes de passar na impressora.',
    });
  });
  SIZES.forEach((size, i) => {
    MODELS.forEach((model, j) => {
      items.push({
        key: `${model}-${size}`, name: `${model} ${size}`, category: 'impresso', source: 'producao', unit: 'folha',
        model, size, made_from: `papel-${size}`, alert_days: 0, lead_time_days: 0, sort_order: 20 + i * 10 + j,
        notes: 'Folha impressa (amarela), aguardando empacotamento.',
      });
    });
  });
  items.push({
    key: 'tinta-amarela', name: 'Tinta amarela', category: 'tinta', source: 'compra', unit: 'litro',
    color_name: 'Amarelo', color_hex: '#f5c400', alert_days: 10, lead_time_days: 10, sort_order: 50,
  });
  items.push({
    key: 'chapa', name: 'Chapa de impressão', category: 'chapa', source: 'compra', unit: 'chapa',
    alert_days: 10, lead_time_days: 7, sort_order: 60,
  });
  return items;
}

function seedIfEmpty(db, { log = console.log } = {}) {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUsers) return false;
  const now = nowIso();
  const items = seedItems();
  db.transaction(() => {
    const insUser = db.prepare('INSERT INTO users (name, role, pin_hash, must_change_pin, created_at) VALUES (?, ?, ?, 1, ?)');
    const pinHash = hashPin(INITIAL_PIN);
    for (const u of USERS) insUser.run(u.name, u.role, pinHash, now);

    const insItem = db.prepare(
      `INSERT INTO items (name, category, source, unit, model, size, color_name, color_hex, alert_days, lead_time_days,
                          made_from_item_id, notes, sort_order, created_at, updated_at)
       VALUES (@name, @category, @source, @unit, @model, @size, @color_name, @color_hex, @alert_days, @lead_time_days,
               @made_from_item_id, @notes, @sort_order, @now, @now)`
    );
    const ids = {};
    for (const it of items) {
      ids[it.key] = Number(
        insItem.run({
          model: null, size: null, color_name: null, color_hex: null, notes: null, ...it,
          made_from_item_id: it.made_from ? ids[it.made_from] : null, now,
        }).lastInsertRowid
      );
    }
    audit(db, {
      action: 'instalacao',
      summary: `Sistema instalado: ${USERS.length} pessoas e ${items.length} itens cadastrados.`,
    });
  })();
  log(`[instalação] Banco criado. PIN inicial de todos: ${INITIAL_PIN} (cada pessoa troca no primeiro acesso).`);
  return true;
}

module.exports = { seedIfEmpty, INITIAL_PIN, USERS, MODELS, SIZES };
