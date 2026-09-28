'use strict';

// Regra de conversão das folhas:
//   • a folha branca vira Amarelo grande (1 para 1);
//   • uma Amarelo grande, cortada na guilhotina, vira duas Amarelo pequeno;
//   • Oferta, Aproveite e Splash saem direto da folha branca.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/sqlite');
const { openDb, migrate, MIGRATIONS } = require('../server/db');
const { createApp } = require('../server/app');
const { seedIfEmpty, INITIAL_PIN } = require('../server/seed');

let db;
let server;
let base;

before(async () => {
  db = openDb(':memory:');
  seedIfEmpty(db, { log: () => {} });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Estoque inicial de papel branco para os testes
  const marcia = await login('Márcia');
  ok(await marcia.post('/api/ops/entrada', { item_id: itemId(PAPEL), quantity: 10000 }));
});

after(() => {
  server.close();
  db.close();
});

const PAPEL = 'Papel branco 94x66';
const GRANDE = 'Amarelo grande 94x66';
const PEQUENO = 'Amarelo pequeno 46x64';
const item = (name) => db.prepare('SELECT * FROM items WHERE name = ?').get(name);
const itemId = (name) => item(name).id;
const qty = (name) => item(name).quantity;
const snapshot = () => Object.fromEntries([PAPEL, GRANDE, PEQUENO, 'Oferta', 'Aproveite', 'Splash'].map((n) => [n, qty(n)]));

async function login(name) {
  const userId = db.prepare('SELECT id FROM users WHERE name = ?').get(name).id;
  let cookie = '';
  const call = async (method, path, body) => {
    const headers = { 'X-Requested-With': 'gsc', 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + path, { method, headers, body: JSON.stringify(body ?? {}) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  const r = await call('POST', '/api/auth/login', { user_id: userId, pin: INITIAL_PIN });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { post: (p, b) => call('POST', p, b) };
}

const ok = (r) => {
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};

test('cadastro: amarela grande, Oferta, Aproveite e Splash saem da branca; a pequena sai da grande', () => {
  for (const n of [GRANDE, 'Oferta', 'Aproveite', 'Splash']) {
    assert.equal(item(n).made_from_item_id, itemId(PAPEL), `${n} deveria sair da folha branca`);
  }
  assert.equal(item(PEQUENO).made_from_item_id, itemId(GRANDE));
  assert.equal(item(GRANDE).yield_per_sheet, 1);
  assert.equal(item(PEQUENO).yield_per_sheet, 2);
  assert.equal(item('Oferta').yield_per_sheet, 2);
  assert.equal(item('Aproveite').yield_per_sheet, 2);
  assert.equal(item('Splash').yield_per_sheet, 8);
});

test('folha branca vira Amarelo grande, uma para uma', async () => {
  const natan = await login('Natan');
  const before = snapshot();
  const r = ok(await natan.post('/api/ops/impressao', { product_id: itemId(GRANDE), input_qty: 1000, waste_qty: 10 }));
  assert.match(r.operation.summary, /^Impressão de Amarelo grande 94x66: 1\.000 folhas \(6,67 pacotes\) de Papel branco 94x66 → 990 folhas boas/);
  assert.doesNotMatch(r.operation.summary, /por folha/);
  const now = snapshot();
  assert.equal(now[PAPEL], before[PAPEL] - 1000);
  assert.equal(now[GRANDE], before[GRANDE] + 990);
  assert.equal(now[PEQUENO], before[PEQUENO]); // a pequena só aparece no corte
});

test('uma Amarelo grande vira duas Amarelo pequeno, sem gastar papel branco', async () => {
  const natan = await login('Natan');
  const before = snapshot();
  const r = ok(await natan.post('/api/ops/impressao', { product_id: itemId(PEQUENO), input_qty: 100, good_qty: 197 }));
  assert.match(r.operation.summary, /^Corte de Amarelo pequeno 46x64: 100 folhas de Amarelo grande 94x66 \(2 por folha\) → 197 folhas boas \(perda de 3 folhas\)/);
  assert.equal(r.operation.waste_qty, 3);
  assert.deepEqual(r.warnings, []);
  const now = snapshot();
  assert.equal(now[GRANDE], before[GRANDE] - 100);
  assert.equal(now[PEQUENO], before[PEQUENO] + 197);
  assert.equal(now[PAPEL], before[PAPEL]);
  // não dá para tirar mais de duas pequenas de cada grande
  assert.equal((await natan.post('/api/ops/impressao', { product_id: itemId(PEQUENO), input_qty: 10, good_qty: 21 })).status, 400);
});

test('Oferta, Aproveite e Splash saem direto da branca, sem mexer nas amarelas', async () => {
  const natan = await login('Natan');
  for (const [name, input, perSheet] of [['Oferta', 50, 2], ['Aproveite', 40, 2], ['Splash', 10, 8]]) {
    const before = snapshot();
    const r = ok(await natan.post('/api/ops/impressao', { product_id: itemId(name), input_qty: input }));
    assert.match(r.operation.summary, new RegExp(`^Impressão de ${name}: .* de Papel branco 94x66 \\(${perSheet} por folha\\)`));
    const now = snapshot();
    assert.equal(now[PAPEL], before[PAPEL] - input, name);
    assert.equal(now[name], before[name] + input * perSheet, name);
    assert.equal(now[GRANDE], before[GRANDE], name);
    assert.equal(now[PEQUENO], before[PEQUENO], name);
  }
});

test('cortar mais Amarelo grande do que tem avisa que o saldo ficou negativo', async () => {
  const natan = await login('Natan');
  const have = qty(GRANDE);
  const r = ok(await natan.post('/api/ops/impressao', { product_id: itemId(PEQUENO), input_qty: have + 5 }));
  assert.equal(qty(GRANDE), -5);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Amarelo grande 94x66 ficou negativo/);
  // desfazer o corte devolve as grandes e tira as pequenas
  const before = snapshot();
  ok(await natan.post(`/api/ops/${r.operation.id}/estorno`, { reason: 'cortei a mais' }));
  const now = snapshot();
  assert.equal(now[GRANDE], have);
  assert.equal(now[PEQUENO], before[PEQUENO] - (have + 5) * 2);
  assert.equal(now[PAPEL], before[PAPEL]);
});

test('atualização v5 não mexe na Amarelo pequeno se a administração já mudou de onde ela sai', () => {
  const v4 = openDatabase(':memory:');
  for (const step of MIGRATIONS.slice(0, 4)) (typeof step === 'function' ? step(v4) : v4.exec(step));
  v4.pragma('user_version = 4');
  const now = new Date().toISOString();
  const ins = v4.prepare('INSERT INTO items (name, category, source, unit, made_from_item_id, yield_per_sheet, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const paper = Number(ins.run(PAPEL, 'papel', 'compra', 'folha', null, 1, now, now).lastInsertRowid);
  const other = Number(ins.run('Papel da Márcia', 'papel', 'compra', 'folha', null, 1, now, now).lastInsertRowid);
  ins.run(GRANDE, 'impresso', 'producao', 'folha', paper, 1, now, now);
  const small = Number(ins.run(PEQUENO, 'impresso', 'producao', 'folha', other, 2, now, now).lastInsertRowid);
  migrate(v4);
  assert.equal(v4.pragma('user_version', { simple: true }), MIGRATIONS.length);
  assert.equal(v4.prepare('SELECT made_from_item_id AS m FROM items WHERE id = ?').get(small).m, other);
  assert.equal(v4.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE summary LIKE 'Amarelo pequeno 46x64 passa%'").get().n, 0);
  v4.close();
});

test('atualização v5 registra no histórico a troca da Amarelo pequeno para a grande', () => {
  const v4 = openDatabase(':memory:');
  for (const step of MIGRATIONS.slice(0, 4)) (typeof step === 'function' ? step(v4) : v4.exec(step));
  v4.pragma('user_version = 4');
  const now = new Date().toISOString();
  const ins = v4.prepare('INSERT INTO items (name, category, source, unit, made_from_item_id, yield_per_sheet, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const paper = Number(ins.run(PAPEL, 'papel', 'compra', 'folha', null, 1, now, now).lastInsertRowid);
  const big = Number(ins.run(GRANDE, 'impresso', 'producao', 'folha', paper, 1, now, now).lastInsertRowid);
  const small = Number(ins.run(PEQUENO, 'impresso', 'producao', 'folha', paper, 2, now, now).lastInsertRowid);
  migrate(v4);
  const row = v4.prepare('SELECT made_from_item_id AS m, yield_per_sheet AS y FROM items WHERE id = ?').get(small);
  assert.deepEqual({ ...row }, { m: big, y: 2 });
  assert.equal(v4.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE summary LIKE 'Amarelo pequeno 46x64 passa%'").get().n, 1);
  v4.close();
});
