'use strict';

// Gera um banco de DEMONSTRAÇÃO com ~90 dias de uso simulado e sobe o sistema.
// Serve para ver o painel e os gráficos funcionando antes de usar de verdade.
//   npm run demo               -> gera data/demo.db e abre em http://localhost:3000
//   node server/demo.js --no-start
// O banco real (data/grafica.db) não é tocado.

const fs = require('node:fs');
const path = require('node:path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'demo.db');
process.env.BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'demo-backups');

const config = require('./config');
const { openDb } = require('./db');
const { seedIfEmpty, INITIAL_PIN } = require('./seed');
const { audit } = require('./audit');
const { localDate, localDayStartIso, addDays } = require('./util');
const stock = require('./services/stock');

// Relógio simulado: cada lançamento acontece "no passado", como se tivesse sido feito na hora.
const RealDate = Date;
let fakeNow = null;
class SimDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && fakeNow !== null) super(fakeNow);
    else super(...args);
  }
  static now() {
    return fakeNow ?? RealDate.now();
  }
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate() {
  for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) fs.rmSync(f, { force: true });
  const db = openDb(config.dbPath);
  global.Date = SimDate;
  const rand = mulberry32(20260926);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

  const DAYS = 90;
  const realNow = RealDate.now();
  const startDay = addDays(localDate(new RealDate(realNow)), -DAYS);
  const startMs = Date.parse(localDayStartIso(startDay));
  // Horário local da gráfica (UTC-3), no dia `dayOffset` da simulação.
  const at = (dayOffset, hour, minute = 0) =>
    startMs + dayOffset * 86400000 + hour * 3600000 + minute * 60000 + between(0, 59) * 1000;
  const weekdayOf = (dayOffset) => new RealDate(`${addDays(startDay, dayOffset)}T12:00:00Z`).getUTCDay();
  // Define o "agora" simulado; hoje, nada acontece depois da hora real.
  const tick = (t) => {
    fakeNow = t;
    return t <= realNow;
  };

  fakeNow = at(0, 7, 30);
  seedIfEmpty(db, { log: () => {} });
  db.prepare('UPDATE users SET must_change_pin = 0').run();
  const user = (name) => db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  const [marcia, gabi, natan, eulir] = ['Márcia', 'Gabrielle', 'Natan', 'Eulir'].map(user);
  const item = (name) => db.prepare('SELECT * FROM items WHERE name = ?').get(name);
  const branca = item('Folha branca');
  const amarela = item('Folha amarela (impressa)');
  const tinta = item('Tinta amarela');
  const [impressao, empacotamento] = db.prepare('SELECT * FROM processes ORDER BY id').all();
  const ctx = { ip: '192.168.0.10' };
  const qty = (it) => db.prepare('SELECT quantity FROM items WHERE id = ?').get(it.id).quantity;

  stock.ajuste(db, marcia, { item_id: branca.id, counted: 90000, note: 'Contagem inicial' }, ctx);
  stock.ajuste(db, marcia, { item_id: amarela.id, counted: 6000, note: 'Contagem inicial' }, ctx);
  stock.ajuste(db, marcia, { item_id: tinta.id, counted: 14, note: 'Contagem inicial' }, ctx);

  const clients = [
    'Padaria Pão Quente', 'Mercadinho São José', 'Farmácia Vida', 'Supermercado Cohama', 'Lanchonete Renascença',
    'Distribuidora Turu', 'Açougue Boi Bom', 'Mercearia Calhau', 'Restaurante Sabor da Ilha',
  ];
  let inkSinceRefill = 0;
  let paperOrderedAt = null;
  const usedPerDay = [];

  for (let day = 1; day <= DAYS; day++) {
    const weekday = weekdayOf(day);
    if (weekday === 0) continue; // domingo
    const saturday = weekday === 6;
    // Ritmo crescente nas últimas semanas (mais pedidos), para a previsão ficar interessante.
    const boost = day > DAYS - 21 ? 1.35 : 1;

    if (!tick(at(day, 7, between(0, 20)))) break;
    for (const u of [natan, eulir]) {
      audit(db, { actor: u, action: 'login', entity: 'user', entityId: u.id, ip: ctx.ip, summary: `${u.name} entrou no sistema.` });
    }

    // Impressão (Natan): algumas tiradas por dia, em resmas.
    const runs = saturday ? 1 : between(2, 3);
    let usedToday = 0;
    for (let r = 0; r < runs; r++) {
      if (!tick(at(day, 8 + r * 3, between(0, 50)))) break;
      const resmas = Math.round(between(5, 9) * boost);
      if (qty(branca) < resmas * 500) break;
      const waste = Math.round(resmas * 500 * (0.004 + rand() * 0.014));
      stock.producao(db, natan, { process_id: impressao.id, input_qty: resmas, input_unit: 'pack', waste_qty: waste }, ctx);
      inkSinceRefill += resmas * 500;
      usedToday += resmas * 500;
    }

    // Tinta: Natan tira 1 litro do estoque a cada ~7.500 folhas impressas.
    while (inkSinceRefill >= 7500 && qty(tinta) >= 1) {
      if (!tick(at(day, 9, between(0, 59)))) break;
      stock.retirada(db, natan, { item_id: tinta.id, quantity: 1, reason: 'Uso na máquina' }, ctx);
      inkSinceRefill -= 7500;
    }

    // Empacotamento (Eulir): pedidos de clientes, até perto do que foi impresso.
    const orders = saturday ? between(1, 3) : between(3, 6);
    for (let o = 0; o < orders; o++) {
      if (!tick(at(day, 9 + o * 2, between(0, 50)))) break;
      const per = pick([100, 200, 250, 500]);
      const available = qty(amarela);
      const packages = Math.min(Math.round(between(4, 18) * boost), Math.floor((available - 3500) / per));
      if (packages < 1) break;
      stock.producao(db, eulir, {
        process_id: empacotamento.id, packages, per_package: per, client: pick(clients),
        waste_qty: rand() < 0.15 ? between(2, 12) : 0,
      }, ctx);
    }

    // Compras (Gabrielle registra quando chega). Papel chega ~7 dias depois do pedido.
    usedPerDay.push(usedToday);
    // Gabrielle pede papel quando o estoque cobre menos de ~12 dias; chega 7 dias depois.
    const avg7 = usedPerDay.slice(-7).reduce((a, b) => a + b, 0) / 7;
    if (paperOrderedAt === null && qty(branca) < avg7 * 12 + 10000 && day < DAYS - 8) paperOrderedAt = day;
    if (paperOrderedAt !== null && day - paperOrderedAt >= 7 && tick(at(day, 14, between(0, 30)))) {
      stock.entrada(db, gabi, {
        item_id: branca.id, quantity: 160, unit: 'pack', supplier: 'Distribuidora Papel Norte',
        note: `NF ${between(10000, 99999)}`,
      }, ctx);
      paperOrderedAt = null;
    }
    if (qty(tinta) <= 6 && day < DAYS - 8 && tick(at(day, 15, between(0, 30)))) {
      stock.entrada(db, gabi, { item_id: tinta.id, quantity: 20, supplier: 'Tintas Maranhão', note: '5 galões de 4 L' }, ctx);
    }

    // Manutenção: limpeza aos sábados e um conserto no meio do período.
    if (saturday && tick(at(day, 11, 30))) {
      db.prepare(
        `INSERT INTO maintenance (user_id, machine, type, description, downtime_minutes, occurred_at, created_at)
         VALUES (?, 'Impressora', 'limpeza', 'Limpeza dos rolos e do tinteiro', 40, ?, ?)`
      ).run(natan.id, new SimDate().toISOString(), new SimDate().toISOString());
      audit(db, { actor: natan, action: 'manutencao', entity: 'maintenance', ip: ctx.ip, summary: 'Limpeza — Impressora: Limpeza dos rolos e do tinteiro (máquina parada 40 min)' });
    }
    if (day === 47 && tick(at(day, 13, 10))) {
      db.prepare(
        `INSERT INTO maintenance (user_id, machine, type, description, downtime_minutes, occurred_at, created_at)
         VALUES (?, 'Impressora', 'troca_peca', 'Troca da correia do alimentador de papel', 150, ?, ?)`
      ).run(natan.id, new SimDate().toISOString(), new SimDate().toISOString());
      audit(db, { actor: natan, action: 'manutencao', entity: 'maintenance', ip: ctx.ip, summary: 'Troca de peça — Impressora: Troca da correia do alimentador de papel (máquina parada 150 min)' });
    }

    // Um erro de digitação desfeito na hora, para o histórico mostrar como fica.
    if (day === 60) {
      fakeNow = at(day, 16, 5);
      const { operation } = stock.producao(db, natan, { process_id: impressao.id, input_qty: 50000, waste_qty: 0 }, ctx);
      fakeNow = at(day, 16, 9);
      stock.estorno(db, natan, operation.id, { reason: 'Digitei 50.000 em vez de 5.000' }, ctx);
    }
  }

  // Contagem mensal da Márcia, com uma pequena diferença.
  tick(Math.min(at(DAYS - 1, 17, 40), realNow - 60000));
  stock.ajuste(db, marcia, { item_id: tinta.id, counted: Math.max(0, qty(tinta) - 0.5), note: 'Contagem mensal' }, ctx);

  fakeNow = null;
  global.Date = RealDate;
  stock.refreshAlerts(db);
  db.close();
  console.log(`[demo] Banco de demonstração criado em ${config.dbPath}`);
  console.log(`[demo] Entre com qualquer pessoa usando o PIN ${INITIAL_PIN}.`);
}

generate();
if (!process.argv.includes('--no-start')) require('./index');
