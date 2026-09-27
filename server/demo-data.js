'use strict';

// Dados fictícios para testar o sistema: alguns meses de uso simulado da gráfica, passando por
// todas as funções (compras, impressão com o rendimento de cada produto, empacotamento, pedidos
// com nota fiscal, clientes de fora de São Luís, entregas, financeiro, estornos, contagens).
// Usado pelo `npm run demo` e pelo botão "Gerar dados fictícios" em Configurações → Sistema.

const { seedIfEmpty, insertSeedItems } = require('./seed');
const { getSetting, setSetting } = require('./db');
const { audit } = require('./audit');
const { localDate, localDayStartIso, addDays } = require('./util');
const stock = require('./services/stock');
const orders = require('./services/orders');
const finance = require('./services/finance');

// [nome, telefone, endereço, cidade (vazio = São Luís)]
const CLIENTS = [
  ['Supermercado Cohama', '(98) 3235-1100', 'Av. Daniel de La Touche, Cohama', ''],
  ['Mercadinho São José', '(98) 98811-2233', 'Rua do Sol, Centro', ''],
  ['Supermercado Ilha Bela', '(98) 3222-4455', 'Av. dos Holandeses, Calhau', ''],
  ['Farmácia Vida', '(98) 98877-6655', 'Av. Guajajaras, Tirirical', ''],
  ['Atacadão do Turu', '(98) 3246-7788', 'Av. São Luís Rei de França, Turu', ''],
  ['Mercearia Renascença', '(98) 98722-1144', 'Rua dos Azulejos, Renascença', ''],
  ['Hortifruti da Ilha', '(98) 98600-3322', 'Av. Jerônimo de Albuquerque, Cohafuma', ''],
  ['Açougue Boi Bom', '(98) 98133-9090', 'Feira do João Paulo', ''],
  ['Supermercado Tocantins', '(99) 3524-8800', 'Av. Getúlio Vargas, Centro', 'Imperatriz'],
  ['Comercial Bacabal', '(99) 3621-4040', 'Rua Magalhães de Almeida, Centro', 'Bacabal'],
  ['Mercantil Caxiense', '(99) 3521-7070', 'Praça Gonçalves Dias, Centro', 'Caxias'],
];

// Saída de cada produto (quem vende mais aparece mais nos pedidos) e preço por unidade.
const DEMAND = {
  Oferta: { weight: 6, price: 0.45 },
  Aproveite: { weight: 4, price: 0.45 },
  'Amarelo pequeno 46x64': { weight: 3, price: 0.35 },
  Splash: { weight: 3, price: 0.12 },
  'Amarelo grande 94x66': { weight: 2, price: 0.75 },
  'Papel branco 94x66': { weight: 1, price: 0.55 },
};
// Avisos por produto, de acordo com a saída de cada um (o que vende mais avisa antes).
const ALERTS = {
  'Papel branco 94x66': { alert_days: 10, min_stock: 3000 },
  Oferta: { alert_days: 4, min_stock: 3000 },
  Aproveite: { alert_days: 4, min_stock: 2000 },
  'Amarelo pequeno 46x64': { alert_days: 3, min_stock: 1500 },
  Splash: { alert_days: 3, min_stock: 2400 },
  'Amarelo grande 94x66': { alert_days: 3, min_stock: 600 },
};

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** O sistema ainda não tem lançamentos, pedidos nem contas (pode receber dados fictícios). */
function isFresh(db) {
  return !db.prepare('SELECT (SELECT COUNT(*) FROM operations) + (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM finance_entries) AS n').get().n;
}

/**
 * Gera os dados fictícios num banco sem movimento. `days` = quantos dias para trás simular.
 * `unlockPins` (só na demonstração local) tira a troca obrigatória do PIN inicial.
 */
function generateDemo(db, { days = 90, unlockPins = false, by = null } = {}) {
  const RealDate = global.Date;
  const realNow = RealDate.now();
  let fakeNow = null;
  // Relógio simulado: cada lançamento acontece "no passado", como se tivesse sido feito na hora.
  class SimDate extends RealDate {
    constructor(...args) {
      if (args.length === 0 && fakeNow !== null) super(fakeNow);
      else super(...args);
    }

    static now() {
      return fakeNow ?? RealDate.now();
    }
  }

  const rand = mulberry32(20260927);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const DAYS = days;
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

  let setMinValue = false;
  global.Date = SimDate;
  try {
    fakeNow = at(0, 7, 30);
    seedIfEmpty(db, { log: () => {} });
    insertSeedItems(db); // se algum item do cadastro inicial foi renomeado ou apagado
    if (unlockPins) db.prepare('UPDATE users SET must_change_pin = 0').run();
    const user = (name) => db.prepare('SELECT * FROM users WHERE name = ? AND active = 1').get(name)
      || db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id").get();
    const marcia = user('Márcia');
    const natan = user('Natan');
    const eulir = user('Eulir');
    const wesley = user('Wesley');
    const item = (name) => db.prepare('SELECT * FROM items WHERE name = ?').get(name);
    const qty = (it) => db.prepare('SELECT quantity FROM items WHERE id = ?').get(it.id).quantity;
    const ctx = { ip: '192.168.0.10' };

    // O que a Márcia cadastraria: detalhes, avisos por produto, mais cores de tinta e o saco dos pacotes.
    const now0 = new SimDate().toISOString();
    db.prepare("UPDATE items SET brand = 'Suzano', grammage = 56, barcode = COALESCE(barcode, '7891000100011') WHERE name = 'Papel branco 94x66'").run();
    for (const [name, a] of Object.entries(ALERTS)) db.prepare('UPDATE items SET alert_days = ?, min_stock = ? WHERE name = ?').run(a.alert_days, a.min_stock, name);
    db.prepare("UPDATE items SET brand = 'Sun Chemical', code = 'SC-AM-01', min_stock = 4 WHERE name = 'Tinta amarela'").run();
    db.prepare("UPDATE items SET brand = 'Kodak', code = 'CH-0.15', min_stock = 15 WHERE name = 'Chapa de impressão'").run();
    const addItem = db.prepare(
      `INSERT INTO items (name, category, source, unit, pack_unit, pack_size, color_name, color_hex, brand, alert_days, lead_time_days,
                          min_stock, sort_order, created_at, updated_at)
       VALUES (@name, @category, 'compra', @unit, @pack_unit, @pack_size, @color_name, @color_hex, @brand, @alert_days, @lead, @min, @sort, @now, @now)`
    );
    const extraItems = [
      { name: 'Tinta vermelha', category: 'tinta', unit: 'litro', color_name: 'Vermelho', color_hex: '#d62828', brand: 'Sun Chemical', alert_days: 10, lead: 10, min: 2, sort: 51 },
      { name: 'Tinta preta', category: 'tinta', unit: 'litro', color_name: 'Preto', color_hex: '#1a1a1a', brand: 'Sun Chemical', alert_days: 10, lead: 10, min: 2, sort: 52 },
      { name: 'Saco plástico para pacote', category: 'embalagem', unit: 'unidade', pack_unit: 'pacote', pack_size: 100, alert_days: 7, lead: 3, min: 300, sort: 70 },
    ];
    for (const it of extraItems) {
      if (!item(it.name)) addItem.run({ pack_unit: null, pack_size: null, color_name: null, color_hex: null, brand: null, ...it, now: now0 });
    }

    const paper = item('Papel branco 94x66');
    const tinta = item('Tinta amarela');
    const chapa = item('Chapa de impressão');
    const bags = item('Saco plástico para pacote');
    const inks = { amarela: tinta, vermelha: item('Tinta vermelha'), preta: item('Tinta preta') };
    const products = db.prepare("SELECT * FROM items WHERE source = 'producao' AND active = 1 ORDER BY sort_order").all()
      .filter((p) => DEMAND[p.name]);
    const sellable = [...products, paper];
    const bag = sellable.flatMap((p) => Array(DEMAND[p.name].weight).fill(p));
    const packSizes = (p) => String(p.package_sizes || '150').split(',').map(Number);
    const cost = { paper: 0.62, tinta: 55, chapa: 28, bags: 9 };
    // Tinta (litros por 10.000 folhas brancas impressas): o amarelo vai em tudo; vermelho e preto nos cartazes.
    const inkUse = (p) => ({ amarela: 1.1, ...(/Amarelo/.test(p.name) ? {} : { vermelha: 0.45, preta: 0.2 }) });

    // Regras dos pedidos: mínimo de 300 unidades; para fora de São Luís, valor mínimo de R$ 400
    // (só se a administração ainda não tiver definido um valor).
    setMinValue = !getSetting(db, 'min_order_value_outside', 0);
    if (setMinValue) setSetting(db, 'min_order_value_outside', 400);
    const clientIds = CLIENTS.map(([name, phone, address, city]) => {
      const found = db.prepare('SELECT id FROM clients WHERE name = ?').get(name);
      return found ? found.id : orders.createClient(db, marcia, { name, phone, address, city: city || null }, ctx);
    });
    const outsideIds = new Set(clientIds.filter((_, i) => CLIENTS[i][3]));

    // Contagem inicial.
    stock.ajuste(db, marcia, { item_id: paper.id, counted: 150 * 180, note: 'Contagem inicial (180 pacotes)' }, ctx);
    for (const ink of Object.values(inks)) stock.ajuste(db, marcia, { item_id: ink.id, counted: ink === tinta ? 16 : 7, note: 'Contagem inicial' }, ctx);
    stock.ajuste(db, marcia, { item_id: chapa.id, counted: 60, note: 'Contagem inicial' }, ctx);
    stock.ajuste(db, marcia, { item_id: bags.id, counted: 1500, note: 'Contagem inicial' }, ctx);
    for (const p of products) stock.ajuste(db, marcia, { item_id: p.id, counted: p.name === 'Splash' ? 4000 : 2400, note: 'Contagem inicial' }, ctx);

    const cat = (kind, name) => finance.categoryId(db, kind, name);
    const pendingPurchases = []; // { key, arrive: dia, fn }
    const toPay = []; // { date, id, skip? }
    const monthsDone = new Set();
    let nf = 1200;
    const laterNf = new Set();
    let exceptionDone = false;
    let canceledDone = false;

    for (let day = 1; day <= DAYS; day++) {
      const weekday = weekdayOf(day);
      const date = dayOf(day);
      const lastDay = day === DAYS;

      // Contas fixas do mês (lançadas no primeiro dia simulado de cada mês) e a venda das aparas.
      const month = date.slice(0, 7);
      if (!monthsDone.has(month) && tick(at(day, 8, 5))) {
        monthsDone.add(month);
        const due = (d) => `${month}-${String(d).padStart(2, '0')}`;
        const fixed = [
          ['Aluguel do galpão', 'Aluguel', 2500, 5],
          ['Salários', 'Salários', 9200, 5],
          ['Conta de energia', 'Energia', between(780, 980), 12],
          ['Internet e telefone', 'Internet / telefone', 129.9, 15],
          ['Água', 'Água', between(90, 140), 18],
        ];
        for (const [desc, c, amount, d] of fixed) {
          const [e] = finance.createEntries(db, marcia, {
            kind: 'despesa', category_id: cat('despesa', c), description: desc, amount, date: due(1), due_date: due(d), paid: false,
          }, ctx);
          // A água do último mês fica em aberto (para aparecer como conta vencida).
          toPay.push({ date: due(d) < date ? date : due(d), id: e.id, skip: c === 'Água' && day > DAYS - 30 });
        }
        finance.createEntries(db, marcia, {
          kind: 'receita', category_id: cat('receita', 'Outras receitas'), description: 'Venda das aparas de papel',
          amount: between(120, 260), date: due(1), paid: true, payment_method: 'Pix', counterparty: 'Reciclagem São Luís',
        }, ctx);
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

      // Pedidos que chegaram por WhatsApp ou e-mail: a Márcia lança e já tira a nota fiscal.
      const nOrders = saturday ? between(0, 1) : Math.round(between(1, 3) * boost);
      for (let i = 0; i < nOrders; i++) {
        if (!tick(at(day, 8, between(0, 59)))) break;
        const clientId = pick(clientIds);
        const outside = outsideIds.has(clientId);
        const lines = [];
        const used = new Set();
        for (let j = between(1, outside ? 3 : 2); j > 0; j--) {
          const p = pick(bag);
          if (used.has(p.id)) continue;
          used.add(p.id);
          const per = pick(packSizes(p));
          const packages = p.name === 'Splash' ? between(3, 16) : between(outside ? 6 : 2, outside ? 16 : 10);
          lines.push({ item_id: p.id, quantity: per * packages, unit_price: DEMAND[p.name].price });
        }
        // Fora de São Luís o pedido precisa passar do valor mínimo.
        while (outside && lines.reduce((a, l) => a + l.quantity * l.unit_price, 0) < 450) lines[0].quantity *= 2;
        const withNf = rand();
        const o = orders.createOrder(db, marcia, {
          client_id: clientId, due_date: addDays(date, between(2, 5)), items: lines,
          channel: pick(['WhatsApp', 'WhatsApp', 'WhatsApp', 'E-mail', 'E-mail', 'Telefone']),
          invoice_number: withNf < 0.8 ? String(++nf) : null,
        }, ctx);
        if (withNf >= 0.8 && withNf < 0.95) laterNf.add(o.id);
      }

      // Uma exceção ao pedido mínimo, liberada pela administração.
      if (!exceptionDone && day >= DAYS / 3 && !saturday && tick(at(day, 9, 30))) {
        exceptionDone = true;
        orders.createOrder(db, marcia, {
          client_id: clientIds[3], due_date: addDays(date, 1), channel: 'Telefone', invoice_number: String(++nf),
          items: [{ item_id: products.find((p) => p.name === 'Oferta').id, quantity: 150, unit_price: 0.5 }],
          notes: 'Cliente antigo, pedido de urgência.', ignore_minimum: true,
        }, ctx);
      }
      // Um pedido cancelado pelo cliente.
      if (!canceledDone && day >= DAYS / 2 && tick(at(day, 11, 0))) {
        const open = db.prepare("SELECT id FROM orders WHERE status = 'aberto' ORDER BY id DESC LIMIT 1").get();
        if (open) {
          canceledDone = true;
          orders.cancelOrder(db, marcia, open.id, { reason: 'Cliente desistiu (fechou a promoção antes)' }, ctx);
        }
      }

      // Natan produz o que os pedidos em aberto vão precisar (mais uma folga), respeitando o rendimento da folha.
      const demand = db
        .prepare(
          `SELECT oi.item_id, SUM(oi.quantity - oi.packed) AS need FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.status IN ('aberto','parcial') GROUP BY oi.item_id`
        )
        .all();
      const runs = demand
        .map((d) => ({ p: products.find((x) => x.id === d.item_id), need: d.need }))
        .filter((r) => r.p)
        .map((r) => ({ ...r, short: r.need + (r.p.name === 'Splash' ? 3000 : 1500) - qty(r.p) }))
        .filter((r) => r.short > 0)
        .sort((a, b) => b.short - a.short)
        .slice(0, saturday ? 1 : 3);
      runs.forEach((r, i) => {
        if (lastDay && i > 0) return;
        if (!tick(at(day, 8 + i * 2, between(10, 50)))) return;
        const perSheet = r.p.yield_per_sheet || 1;
        const packs = Math.min(Math.ceil((r.short + 600) / perSheet / 150), Math.floor(qty(paper) / 150), 60);
        if (packs < 1) return;
        const sheets = packs * 150;
        const inkExtras = Object.entries(inkUse(r.p)).map(([k, rate]) => ({
          item_id: inks[k].id, quantity: Math.max(0.1, Math.round((sheets / 10000) * rate * 10) / 10),
        }));
        stock.impressao(db, natan, {
          product_id: r.p.id, input_qty: packs, input_unit: 'pack',
          waste_qty: Math.round(sheets * perSheet * (0.004 + rand() * 0.014)),
          extras: [{ item_id: chapa.id, quantity: 1 }, ...inkExtras],
        }, ctx);
      });

      // Eulir separa o bom do ruim, empacota os pedidos pela data de entrega e deixa separados para o Wesley.
      const open = orders.packableOrders(db, eulir).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
      let slot = 0;
      let packagesToday = 0;
      for (const o of open.slice(0, lastDay ? 1 : saturday ? 2 : 6)) {
        for (const line of o.items.filter((l) => l.remaining > 0)) {
          const p = sellable.find((x) => x.id === line.item_id);
          const per = packSizes(p).find((n) => line.remaining % n === 0) || packSizes(p)[0];
          const packages = Math.min(Math.floor(line.remaining / per), Math.floor((qty(p) - 10) / per));
          if (packages < 1) continue;
          if (!tick(at(day, 9 + Math.floor(slot / 2), between(0, 59)))) break;
          slot += 1;
          packagesToday += packages;
          stock.empacotamento(db, eulir, { order_item_id: line.id, packages, per_package: per, waste_qty: rand() < 0.1 ? between(1, 6) : 0 }, ctx);
        }
      }
      // Sacos usados nos pacotes do dia.
      if (packagesToday && tick(at(day, 12, between(0, 30)))) {
        stock.retirada(db, eulir, { item_id: bags.id, quantity: packagesToday, reason: 'Empacotamento do dia' }, ctx);
      }
      // De vez em quando uma chapa estraga.
      if (day % 17 === 0 && tick(at(day, 13, 20))) {
        stock.retirada(db, natan, { item_id: chapa.id, quantity: 1, reason: 'Chapa danificada' }, ctx);
      }

      // O Wesley busca os pedidos separados à tarde e leva às lojas (às vezes o cliente vem buscar).
      const ready = db.prepare("SELECT id, due_date FROM orders WHERE status = 'pronto' ORDER BY due_date").all();
      for (const { id, due_date: dueDate } of ready) {
        if (dueDate > addDays(date, 1) && rand() < 0.8) continue;
        if (rand() < 0.1) continue;
        if (!tick(at(day, 14, between(0, 59)))) break;
        if (laterNf.has(id)) {
          orders.setInvoice(db, marcia, id, { invoice_number: String(++nf) }, ctx);
          laterNf.delete(id);
        }
        const pickup = rand() < 0.12;
        orders.shipOrder(db, pickup ? eulir : wesley, id, { carrier: pickup ? 'Cliente retirou' : wesley.name }, ctx);
        if (lastDay) break; // o último fica "saiu para entrega"
        if (!tick(at(day, pickup ? 14 : 16, between(0, 59)))) break;
        orders.deliverOrder(db, pickup ? eulir : wesley, id, { received_by: pick(['Gerente', 'Encarregado do depósito', 'Caixa', 'Dono']) }, ctx);
        const rec = db.prepare('SELECT id FROM finance_entries WHERE order_id = ? AND canceled_at IS NULL AND paid_at IS NULL').get(id);
        if (rec && rand() < 0.92) toPay.push({ date: addDays(date, between(0, 6)), id: rec.id });
      }

      // Pagamentos e recebimentos do dia (Márcia).
      for (const p of toPay.filter((x) => x.date <= date && !x.done && !x.skip)) {
        if (!tick(at(day, 17, between(0, 40)))) break;
        p.done = true;
        const e = db.prepare('SELECT paid_at, canceled_at FROM finance_entries WHERE id = ?').get(p.id);
        if (!e.paid_at && !e.canceled_at) finance.payEntry(db, marcia, p.id, { paid_at: date, payment_method: pick(['Pix', 'Pix', 'Boleto', 'Transferência']) }, ctx);
      }

      // Compras: papel encomendado quando baixa (chega em 7 dias, boleto em 28); tinta, chapa e sacos quando acabando.
      if (!pendingPurchases.some((x) => x.key === 'papel' && x.arrive > day) && qty(paper) < 150 * 90 && day < DAYS - 8) {
        pendingPurchases.push({
          key: 'papel',
          arrive: day + 7,
          fn: () => {
            const dueDate = addDays(localDate(new SimDate()), 28);
            const packs = 160;
            const { operation } = stock.entrada(db, marcia, {
              item_id: paper.id, quantity: packs, unit: 'pack', supplier: 'Distribuidora Papel Norte',
              total_cost: Math.round(packs * 150 * cost.paper), paid: false, due_date: dueDate, payment_method: 'Boleto',
              note: `NF ${between(10000, 99999)}`,
            }, ctx);
            const bill = db.prepare('SELECT id FROM finance_entries WHERE operation_id = ?').get(operation.id);
            toPay.push({ date: dueDate, id: bill.id });
          },
        });
      }
      for (const [k, ink] of Object.entries(inks)) {
        const rate = k === 'amarela' ? 1.1 : 0.4;
        if (qty(ink) < rate * 4 && !pendingPurchases.some((x) => x.key === k && x.arrive > day)) {
          const liters = Math.ceil(rate * 14);
          pendingPurchases.push({ key: k, arrive: day + 5, fn: () => stock.entrada(db, marcia, { item_id: ink.id, quantity: liters, supplier: 'Tintas Maranhão', total_cost: liters * cost.tinta, paid: true, payment_method: 'Pix' }, ctx) });
        }
      }
      if (qty(chapa) < 20 && !pendingPurchases.some((x) => x.key === 'chapa' && x.arrive > day)) {
        pendingPurchases.push({ key: 'chapa', arrive: day + 4, fn: () => stock.entrada(db, marcia, { item_id: chapa.id, quantity: 50, supplier: 'Grafitec', total_cost: 50 * cost.chapa, paid: true, payment_method: 'Pix' }, ctx) });
      }
      if (qty(bags) < 600 && !pendingPurchases.some((x) => x.key === 'sacos' && x.arrive > day)) {
        pendingPurchases.push({ key: 'sacos', arrive: day + 2, fn: () => stock.entrada(db, natan, { item_id: bags.id, quantity: 20, unit: 'pack', supplier: 'Casa das Embalagens' }, ctx) });
      }

      // Conserto da impressora no meio do período (entra como despesa).
      if (day === Math.round(DAYS / 2) + 2 && tick(at(day, 13, 10))) {
        finance.createEntries(db, marcia, { kind: 'despesa', category_id: cat('despesa', 'Manutenção'), description: 'Correia do alimentador + mão de obra', amount: 480, date, paid: true, payment_method: 'Pix', counterparty: 'Técnico Raimundo' }, ctx);
      }

      // Um erro de digitação desfeito na hora, para o histórico mostrar como fica.
      if (day === Math.round(DAYS * 0.66) && tick(at(day, 16, 5))) {
        const { operation } = stock.impressao(db, natan, { product_id: products[0].id, input_qty: 5000, waste_qty: 0 }, ctx);
        tick(at(day, 16, 9));
        stock.estorno(db, natan, operation.id, { reason: 'Digitei 5.000 folhas em vez de 500' }, ctx);
      }
    }

    // Hoje: pedidos novos esperando produção e empacotamento, um pela metade e um a caminho da loja.
    const byName = (n) => products.find((p) => p.name === n);
    const today = localDate(new RealDate(realNow));
    tick(realNow - 55 * 60000);
    const fresh = orders.createOrder(db, marcia, {
      client_id: clientIds[0], due_date: addDays(today, 2), channel: 'WhatsApp', invoice_number: String(++nf),
      items: [{ item_id: byName('Oferta').id, quantity: 1200, unit_price: 0.45 }, { item_id: byName('Splash').id, quantity: 1600, unit_price: 0.12 }],
    }, ctx);
    tick(realNow - 45 * 60000);
    orders.createOrder(db, marcia, {
      client_id: clientIds[8], due_date: addDays(today, 4), channel: 'E-mail',
      items: [{ item_id: byName('Amarelo pequeno 46x64').id, quantity: 2000, unit_price: 0.35 }, { item_id: paper.id, quantity: 600, unit_price: 0.55 }],
    }, ctx);
    tick(realNow - 35 * 60000);
    stock.empacotamento(db, eulir, { order_item_id: fresh.items[0].id, packages: 4, per_package: 150 }, ctx);
    const waiting = db.prepare("SELECT id FROM orders WHERE status = 'pronto' ORDER BY due_date LIMIT 1").get();
    if (waiting) {
      tick(realNow - 25 * 60000);
      orders.shipOrder(db, wesley, waiting.id, { carrier: wesley.name }, ctx);
    }

    // Contagem mensal da Márcia, com uma pequena diferença.
    tick(Math.min(at(DAYS - 1, 17, 40), realNow - 60000));
    stock.ajuste(db, marcia, { item_id: tinta.id, counted: Math.max(0, Math.round((qty(tinta) - 0.5) * 10) / 10), note: 'Contagem mensal' }, ctx);
  } finally {
    fakeNow = null;
    global.Date = RealDate;
  }
  stock.refreshAlerts(db);
  setSetting(db, 'demo_data', { at: new Date().toISOString(), days, by: by ? by.name : null, set_min_value: setMinValue });
  audit(db, {
    actor: by, action: 'dados_ficticios',
    summary: `Gerou dados fictícios para teste (${days} dias de uso simulado). Para começar de verdade: Configurações → Sistema → Zerar o sistema.`,
  });
}

module.exports = { generateDemo, isFresh, CLIENTS };
