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

// Como a gráfica trabalha: compra papel branco 94x66 (pacotes de 150 folhas) e vende assim mesmo
// ou transforma em produtos. A folha branca vira Amarelo grande; a Amarelo grande, cortada ao meio
// na guilhotina, vira duas Amarelo pequeno. "Rende" = quantas unidades saem de uma folha do material
// de origem (made_from).
const PAPER = {
  key: 'papel', name: 'Papel branco 94x66', category: 'papel', source: 'compra', unit: 'folha', size: '94x66',
  pack_unit: 'pacote', pack_size: 150, package_sizes: '150,100', alert_days: 10, lead_time_days: 7, sort_order: 10,
  notes: 'Papel virgem, comprado em pacotes de 150. Vendido assim (branco) ou transformado nos produtos.',
};
const PRODUCTS = [
  {
    key: 'amarelo-grande', name: 'Amarelo grande 94x66', size: '94x66', yield_per_sheet: 1, package_sizes: '150,100',
    color_name: 'Amarelo', color_hex: '#f5c400', notes: 'Cada folha branca vira uma folha amarela.',
  },
  {
    key: 'amarelo-pequeno', name: 'Amarelo pequeno 46x64', size: '46x64', made_from: 'amarelo-grande', yield_per_sheet: 2,
    package_sizes: '150,200', color_name: 'Amarelo', color_hex: '#f5c400',
    notes: 'Amarelo grande cortada ao meio na guilhotina: cada folha grande vira 2 pequenas.',
  },
  { key: 'oferta', name: 'Oferta', yield_per_sheet: 2, package_sizes: '150,200', notes: 'Cartaz "Oferta": cabem 2 numa folha grande.' },
  { key: 'aproveite', name: 'Aproveite', yield_per_sheet: 2, package_sizes: '150,200', notes: 'Cartaz "Aproveite": cabem 2 numa folha grande.' },
  {
    key: 'splash', name: 'Splash', unit: 'unidade', yield_per_sheet: 8, package_sizes: '150,200',
    notes: 'Balões para escrever o preço: cabem 8 numa folha grande.',
  },
];

// Cadastro inicial. Tudo pode ser alterado em Configurações → Itens (inclusive os alertas:
// o papel começa avisando quando o estoque cobrir menos de 10 dias; os produtos, sem aviso).
function seedItems() {
  return [
    PAPER,
    ...PRODUCTS.map((p, i) => ({
      category: 'impresso', source: 'producao', unit: 'folha', made_from: 'papel', alert_days: 0, lead_time_days: 0,
      sort_order: 20 + i, ...p,
    })),
    {
      key: 'tinta-amarela', name: 'Tinta amarela', category: 'tinta', source: 'compra', unit: 'litro',
      color_name: 'Amarelo', color_hex: '#f5c400', alert_days: 10, lead_time_days: 10, sort_order: 50,
    },
    {
      key: 'chapa', name: 'Chapa de impressão', category: 'chapa', source: 'compra', unit: 'chapa',
      alert_days: 10, lead_time_days: 7, sort_order: 60,
    },
  ];
}

/** Cadastra os itens iniciais que ainda não existem (pelo nome). Devolve quantos cadastrou. */
function insertSeedItems(db, now = nowIso()) {
  const ins = db.prepare(
    `INSERT INTO items (name, category, source, unit, pack_unit, pack_size, model, size, color_name, color_hex, alert_days,
                        lead_time_days, made_from_item_id, yield_per_sheet, package_sizes, notes, sort_order, created_at, updated_at)
     VALUES (@name, @category, @source, @unit, @pack_unit, @pack_size, @model, @size, @color_name, @color_hex, @alert_days,
             @lead_time_days, @made_from_item_id, @yield_per_sheet, @package_sizes, @notes, @sort_order, @now, @now)`
  );
  const ids = {};
  let added = 0;
  for (const it of seedItems()) {
    const existing = db.prepare('SELECT id FROM items WHERE name = ?').get(it.name);
    if (existing) {
      ids[it.key] = existing.id;
      continue;
    }
    ids[it.key] = Number(
      ins.run({
        pack_unit: null, pack_size: null, model: null, size: null, color_name: null, color_hex: null, notes: null,
        yield_per_sheet: 1, package_sizes: null, ...it, made_from_item_id: it.made_from ? ids[it.made_from] : null, now,
      }).lastInsertRowid
    );
    added += 1;
  }
  return added;
}

function seedIfEmpty(db, { log = console.log } = {}) {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUsers) return false;
  const now = nowIso();
  db.transaction(() => {
    const insUser = db.prepare('INSERT INTO users (name, role, pin_hash, must_change_pin, created_at) VALUES (?, ?, ?, 1, ?)');
    const pinHash = hashPin(INITIAL_PIN);
    for (const u of USERS) insUser.run(u.name, u.role, pinHash, now);

    const added = insertSeedItems(db, now);
    audit(db, {
      action: 'instalacao',
      summary: `Sistema instalado: ${USERS.length} pessoas e ${added} itens cadastrados.`,
    });
  })();
  log(`[instalação] Banco criado. PIN inicial de todos: ${INITIAL_PIN} (cada pessoa troca no primeiro acesso).`);
  return true;
}

module.exports = { seedIfEmpty, insertSeedItems, seedItems, INITIAL_PIN, USERS, PAPER, PRODUCTS };
