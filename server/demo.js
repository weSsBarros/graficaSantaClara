'use strict';

// Gera um banco de DEMONSTRAÇÃO com ~90 dias de uso simulado e sobe o sistema.
// Serve para ver pedidos, painel, financeiro e gráficos funcionando antes de usar de verdade.
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
const orders = require('./services/orders');
const finance = require('./services/finance');

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

const CLIENTS = [
  ['Supermercado Cohama', '(98) 3235-1100', 'Av. Daniel de La Touche, Cohama'],
  ['Mercadinho São José', '(98) 98811-2233', 'Rua do Sol, Centro'],
  ['Supermercado Ilha Bela', '(98) 3222-4455', 'Av. dos Holandeses, Calhau'],
  ['Farmácia Vida', '(98) 98877-6655', 'Av. Guajajaras, Tirirical'],
  ['Atacadão do Turu', '(98) 3246-7788', 'Av. São Luís Rei de França, Turu'],
  ['Mercearia Renascença', '(98) 98722-1144', 'Rua dos Azulejos, Renascença'],
  ['Hortifruti da Ilha', '(98) 98600-3322', 'Av. Jerônimo de Albuquerque'],
  ['Açougue Boi Bom', '(98) 98133-9090', 'Feira do João Paulo'],
];

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
  const dayOf = (d) => addDays(startDay, d);
  // Horário local da gráfica (UTC-3), no dia `d` da simulação.
  const at = (d, hour, minute = 0) => startMs + d * 86400000 + hour * 3600000 + minute * 60000 + between(0, 59) * 1000;
  const weekdayOf = (d) => new RealDate(`${dayOf(d)}T12:00:00Z`).getUTCDay();
  // Define o "agora" simulado; hoje, nada acontece depois da hora real.
  const tick = (t) => {
    fakeNow = t;
    return t <= realNow;
  };

  fakeNow = at(0, 7, 30);
  seedIfEmpty(db, { log: () => {} });
  db.prepare('UPDATE users SET must_change_pin = 0').run();
  const user = (name) => db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  const [marcia, natan, eulir, wesley] = ['Márcia', 'Natan', 'Eulir', 'Wesley'].map(user);
  const item = (name) => db.prepare('SELECT * FROM items WHERE name = ?').get(name);
  const qty = (it) => db.prepare('SELECT quantity FROM items WHERE id = ?').get(it.id).quantity;
  const ctx = { ip: '192.168.0.10' };

  // Detalhes dos itens (o que a Márcia cadastraria).
  db.prepare("UPDATE items SET pack_unit = 'resma', pack_size = 250, brand = 'Suzano', grammage = 56 WHERE category = 'papel'").run();
  db.prepare("UPDATE items SET barcode = '7891000100011' WHERE name = 'Papel branco 46x66'").run();
  db.prepare("UPDATE items SET barcode = '7891000100028' WHERE name = 'Papel branco 96x64'").run();
  db.prepare('UPDATE items SET min_stock = 2000, alert_days = 2 WHERE category = ?').run('impresso');
  db.prepare("UPDATE items SET brand = 'Sun Chemical', code = 'SC-AM-01', min_stock = 4 WHERE name = 'Tinta amarela'").run();
  db.prepare("UPDATE items SET brand = 'Kodak', code = 'CH-0.15', min_stock = 15 WHERE category = 'chapa'").run();

  const paper = { '46x66': item('Papel branco 46x66'), '96x64': item('Papel branco 96x64') };
  // Cartaz de oferta: fundo amarelo, letras vermelhas e texto preto.
  const now0 = new SimDate().toISOString();
  const insInk = db.prepare(
    `INSERT INTO items (name, category, source, unit, color_name, color_hex, brand, alert_days, lead_time_days, min_stock, sort_order, created_at, updated_at)
     VALUES (?, 'tinta', 'compra', 'litro', ?, ?, 'Sun Chemical', 10, 10, 2, ?, ?, ?)`
  );
  insInk.run('Tinta vermelha', 'Vermelho', '#d62828', 51, now0, now0);
  insInk.run('Tinta preta', 'Preto', '#1a1a1a', 52, now0, now0);
  const tinta = item('Tinta amarela');
  // litros por 10.000 folhas impressas de cada cor
  const inks = [[tinta, 1.1], [item('Tinta vermelha'), 0.45], [item('Tinta preta'), 0.2]];
  const chapa = item('Chapa de impressão');
  const products = db.prepare("SELECT * FROM items WHERE category = 'impresso' ORDER BY sort_order").all();
  // Demanda relativa de cada modelo (Oferta vende mais).
  const weight = (p) => ({ Oferta: 5, Aproveite: 3, Splash: 2 }[p.model] || 1) * (p.size === '46x66' ? 2 : 1);
  const bag = products.flatMap((p) => Array(weight(p)).fill(p));
  const price = (p) => (p.size === '46x66' ? 0.45 : 0.85);
  const cost = { paper46: 0.18, paper96: 0.32, tinta: 55, chapa: 28 };

  const clientIds = CLIENTS.map(([name, phone, address]) => orders.createClient(db, marcia, { name, phone, address }, ctx));

  // Contagem inicial.
  stock.ajuste(db, marcia, { item_id: paper['46x66'].id, counted: 45000, note: 'Contagem inicial' }, ctx);
  stock.ajuste(db, marcia, { item_id: paper['96x64'].id, counted: 22000, note: 'Contagem inicial' }, ctx);
  for (const [ink, rate] of inks) stock.ajuste(db, marcia, { item_id: ink.id, counted: Math.round(rate * 14), note: 'Contagem inicial' }, ctx);
  stock.ajuste(db, marcia, { item_id: chapa.id, counted: 60, note: 'Contagem inicial' }, ctx);
  for (const p of products) stock.ajuste(db, marcia, { item_id: p.id, counted: 3000, note: 'Contagem inicial' }, ctx);

  const cat = (kind, name) => finance.categoryId(db, kind, name);
  const pendingPurchases = []; // { key, arrive: dia, fn }
  const toPay = []; // { date, id }
  const monthsDone = new Set();

  for (let day = 1; day <= DAYS; day++) {
    const weekday = weekdayOf(day);
    const date = dayOf(day);

    // Contas fixas do mês (lançadas no primeiro dia simulado de cada mês).
    const month = date.slice(0, 7);
    if (!monthsDone.has(month) && tick(at(day, 8, 5))) {
      monthsDone.add(month);
      const due = (d) => `${month}-${String(d).padStart(2, '0')}`;
      const fixed = [
        ['Aluguel do galpão', 'Aluguel', 2500, 5],
        ['Salários', 'Salários', 7800, 5],
        ['Conta de energia', 'Energia', between(780, 980), 12],
        ['Internet e telefone', 'Internet / telefone', 129.9, 15],
        ['Água', 'Água', between(90, 140), 18],
      ];
      for (const [desc, c, amount, d] of fixed) {
        const [e] = finance.createEntries(db, marcia, {
          kind: 'despesa', category_id: cat('despesa', c), description: desc, amount, date: due(1), due_date: due(d), paid: false,
        }, ctx);
        toPay.push({ date: due(d) < date ? date : due(d), id: e.id });
      }
    }

    // Chegada de compras encomendadas.
    for (const p of pendingPurchases.filter((x) => x.arrive === day)) {
      if (tick(at(day, 10, between(0, 50)))) p.fn();
    }

    if (weekday === 0) continue; // domingo
    const saturday = weekday === 6;
    const boost = day > DAYS - 21 ? 1.3 : 1;

    if (!tick(at(day, 7, between(0, 20)))) break;
    for (const u of [marcia, natan, eulir, wesley]) {
      audit(db, { actor: u, action: 'login', entity: 'user', entityId: u.id, ip: ctx.ip, summary: `${u.name} entrou no sistema.` });
    }

    // Márcia registra os pedidos que chegaram (telefone/WhatsApp).
    const nOrders = saturday ? between(0, 1) : Math.round(between(1, 2) * boost);
    for (let i = 0; i < nOrders; i++) {
      if (!tick(at(day, 8, between(0, 59)))) break;
      const lines = [];
      const used = new Set();
      for (let j = between(1, 2); j > 0; j--) {
        const p = pick(bag);
        if (used.has(p.id)) continue;
        used.add(p.id);
        lines.push({ item_id: p.id, quantity: between(2, 10) * 250, unit_price: price(p) });
      }
      orders.createOrder(db, marcia, { client_id: pick(clientIds), due_date: addDays(date, between(2, 5)), items: lines }, ctx);
    }

    // Natan imprime o que os pedidos em aberto vão precisar (mais uma folga).
    const demand = db
      .prepare(
        `SELECT oi.item_id, SUM(oi.quantity - oi.packed) AS need FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.status IN ('aberto','parcial') GROUP BY oi.item_id`
      )
      .all();
    const runs = demand
      .map((d) => ({ p: products.find((x) => x.id === d.item_id), need: d.need }))
      .map((r) => ({ ...r, short: r.need + 2500 - qty(r.p) }))
      .filter((r) => r.short > 0)
      .sort((a, b) => b.short - a.short)
      .slice(0, saturday ? 1 : 3);
    runs.forEach((r, i) => {
      if (!tick(at(day, 8 + i * 2, between(10, 50)))) return;
      const base = paper[r.p.size];
      const resmas = Math.min(Math.ceil((r.short + 1500) / 250), Math.floor(qty(base) / 250), 40);
      if (resmas < 2) return;
      const sheets = resmas * 250;
      stock.impressao(db, natan, {
        product_id: r.p.id, input_qty: resmas, input_unit: 'pack', waste_qty: Math.round(sheets * (0.004 + rand() * 0.014)),
        extras: [
          { item_id: chapa.id, quantity: 1 },
          ...inks.map(([ink, rate]) => ({ item_id: ink.id, quantity: Math.max(0.1, Math.round((sheets / 10000) * rate * 10) / 10) })),
        ],
      }, ctx);
    });

    // Eulir empacota os pedidos pela data de entrega.
    const open = orders.packableOrders(db, eulir).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    let slot = 0;
    for (const o of open.slice(0, saturday ? 2 : 6)) {
      for (const line of o.items.filter((l) => l.remaining > 0)) {
        const p = products.find((x) => x.id === line.item_id);
        const per = line.remaining % 500 === 0 && rand() < 0.5 ? 500 : 250;
        const packages = Math.min(Math.floor(line.remaining / per), Math.floor((qty(p) - 10) / per));
        if (packages < 1) continue;
        if (!tick(at(day, 9 + Math.floor(slot / 2), between(0, 59)))) break;
        slot += 1;
        stock.empacotamento(db, eulir, { order_item_id: line.id, packages, per_package: per, waste_qty: rand() < 0.1 ? between(1, 8) : 0 }, ctx);
      }
    }

    // Saída e entrega dos pedidos prontos (à tarde).
    const ready = db.prepare("SELECT id, due_date FROM orders WHERE status = 'pronto'").all();
    for (const { id, due_date: dueDate } of ready) {
      // entrega perto da data combinada (às vezes antes; às vezes atrasa um dia)
      if (dueDate > addDays(date, 1) && rand() < 0.8) continue;
      if (rand() < 0.1) continue;
      if (!tick(at(day, 14, between(0, 59)))) break;
      // Quase sempre o Wesley leva; às vezes o próprio cliente vem buscar.
      const pickup = rand() < 0.15;
      orders.shipOrder(db, pickup ? eulir : wesley, id, { carrier: pickup ? 'Cliente retirou' : 'Wesley' }, ctx);
      if (!tick(at(day, pickup ? 14 : 16, between(0, 59)))) break;
      orders.deliverOrder(db, pickup ? eulir : wesley, id, { received_by: pick(['Gerente', 'Encarregado do depósito', 'Caixa', 'Dono']) }, ctx);
      const rec = db.prepare('SELECT id FROM finance_entries WHERE order_id = ? AND canceled_at IS NULL AND paid_at IS NULL').get(id);
      if (rec && rand() < 0.92) toPay.push({ date: addDays(date, between(0, 6)), id: rec.id });
    }

    // Pagamentos e recebimentos do dia (Márcia).
    for (const p of toPay.filter((x) => x.date <= date && !x.done)) {
      if (!tick(at(day, 17, between(0, 40)))) break;
      p.done = true;
      const e = db.prepare('SELECT paid_at, canceled_at FROM finance_entries WHERE id = ?').get(p.id);
      if (!e.paid_at && !e.canceled_at) finance.payEntry(db, marcia, p.id, { paid_at: date, payment_method: pick(['Pix', 'Pix', 'Boleto', 'Transferência']) }, ctx);
    }

    // Compras: papel encomendado quando baixa (chega em 7 dias, boleto em 28), tinta e chapa quando acabando.
    for (const size of ['46x66', '96x64']) {
      const base = paper[size];
      const waiting = pendingPurchases.some((x) => x.key === size && x.arrive > day);
      if (!waiting && qty(base) < (size === '46x66' ? 30000 : 15000) && day < DAYS - 8) {
        const resmas = size === '46x66' ? 200 : 100;
        pendingPurchases.push({
          key: size,
          arrive: day + 7,
          fn: () => {
            const dueDate = addDays(localDate(new SimDate()), 28);
            const { operation } = stock.entrada(db, marcia, {
              item_id: base.id, quantity: resmas, unit: 'pack', supplier: 'Distribuidora Papel Norte',
              total_cost: resmas * 250 * (size === '46x66' ? cost.paper46 : cost.paper96), paid: false,
              due_date: dueDate, payment_method: 'Boleto', note: `NF ${between(10000, 99999)}`,
            }, ctx);
            const bill = db.prepare('SELECT id FROM finance_entries WHERE operation_id = ?').get(operation.id);
            toPay.push({ date: dueDate, id: bill.id });
          },
        });
      }
    }
    for (const [ink, rate] of inks) {
      const key = `tinta-${ink.id}`;
      if (qty(ink) < rate * 6 && !pendingPurchases.some((x) => x.key === key && x.arrive > day)) {
        const liters = Math.ceil(rate * 18);
        pendingPurchases.push({ key, arrive: day + 5, fn: () => stock.entrada(db, marcia, { item_id: ink.id, quantity: liters, supplier: 'Tintas Maranhão', total_cost: liters * cost.tinta, paid: true, payment_method: 'Pix' }, ctx) });
      }
    }
    if (qty(chapa) < 20 && !pendingPurchases.some((x) => x.key === 'chapa' && x.arrive > day)) {
      pendingPurchases.push({ key: 'chapa', arrive: day + 4, fn: () => stock.entrada(db, marcia, { item_id: chapa.id, quantity: 50, supplier: 'Grafitec', total_cost: 50 * cost.chapa, paid: true, payment_method: 'Pix' }, ctx) });
    }

    // Manutenção: limpeza aos sábados e um conserto no meio do período.
    const maint = (type, description, downtime) => {
      const now = new SimDate().toISOString();
      db.prepare('INSERT INTO maintenance (user_id, machine, type, description, downtime_minutes, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(natan.id, 'Impressora', type, description, downtime, now, now);
      audit(db, { actor: natan, action: 'manutencao', entity: 'maintenance', ip: ctx.ip, summary: `${type === 'limpeza' ? 'Limpeza' : 'Troca de peça'} — Impressora: ${description} (máquina parada ${downtime} min)` });
    };
    if (saturday && tick(at(day, 11, 30))) maint('limpeza', 'Limpeza dos rolos e do tinteiro', 40);
    if (day === 47 && tick(at(day, 13, 10))) {
      maint('troca_peca', 'Troca da correia do alimentador de papel', 150);
      finance.createEntries(db, marcia, { kind: 'despesa', category_id: cat('despesa', 'Manutenção'), description: 'Correia do alimentador + mão de obra', amount: 480, date, paid: true, payment_method: 'Pix', counterparty: 'Técnico Raimundo' }, ctx);
    }

    // Um erro de digitação desfeito na hora, para o histórico mostrar como fica.
    if (day === 60 && tick(at(day, 16, 5))) {
      const { operation } = stock.impressao(db, natan, { product_id: products[0].id, input_qty: 50000, waste_qty: 0 }, ctx);
      tick(at(day, 16, 9));
      stock.estorno(db, natan, operation.id, { reason: 'Digitei 50.000 em vez de 5.000' }, ctx);
    }
  }

  // Contagem mensal da Márcia, com uma pequena diferença.
  tick(Math.min(at(DAYS - 1, 17, 40), realNow - 60000));
  stock.ajuste(db, marcia, { item_id: tinta.id, counted: Math.max(0, Math.round((qty(tinta) - 0.5) * 10) / 10), note: 'Contagem mensal' }, ctx);

  fakeNow = null;
  global.Date = RealDate;
  stock.refreshAlerts(db);
  db.close();
  console.log(`[demo] Banco de demonstração criado em ${config.dbPath}`);
  console.log(`[demo] Entre com qualquer pessoa usando o PIN ${INITIAL_PIN}.`);
}

generate();
if (!process.argv.includes('--no-start')) require('./index');
