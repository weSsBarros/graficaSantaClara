'use strict';

// Driver do SQLite.
// Usa o better-sqlite3 (mais rápido). Se ele não carregar — por exemplo, numa hospedagem
// compartilhada onde o módulo compilado não funciona —, usa o SQLite que já vem dentro do
// Node.js (node:sqlite, Node 22.13 ou mais novo), com a mesma interface que o resto do sistema usa.
// Para forçar o driver embutido: SQLITE_DRIVER=node.

let Better = null;
let betterError = null;
if (process.env.SQLITE_DRIVER !== 'node') {
  try {
    Better = require('better-sqlite3');
  } catch (err) {
    betterError = err;
  }
}

/**
 * Consulta preparada. Diferente do better-sqlite3, o node:sqlite recusa parâmetros nomeados
 * que a consulta não usa; aqui eles são filtrados antes.
 */
class NodeStatement {
  constructor(stmt, sql) {
    this.stmt = stmt;
    this.names = [...new Set((sql.match(/[@:$][A-Za-z_]\w*/g) || []).map((n) => n.slice(1)))];
  }

  args(list) {
    const [first] = list;
    if (list.length !== 1 || !first || typeof first !== 'object' || Array.isArray(first) || Buffer.isBuffer(first)) return list;
    const only = {};
    for (const n of this.names) if (n in first) only[n] = first[n];
    return [only];
  }

  run(...a) {
    return this.stmt.run(...this.args(a));
  }

  get(...a) {
    return this.stmt.get(...this.args(a));
  }

  all(...a) {
    return this.stmt.all(...this.args(a));
  }
}

/** Adaptador do node:sqlite com os métodos do better-sqlite3 usados no sistema. */
class NodeSqliteDatabase {
  constructor(file) {
    let DatabaseSync;
    // O Node avisa que o módulo é "experimental"; o aviso só confundiria quem lê o registro do servidor.
    const emitWarning = process.emitWarning;
    process.emitWarning = (w, ...rest) => (/SQLite/.test(String(w?.message ?? w)) ? undefined : emitWarning.call(process, w, ...rest));
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      const why = betterError ? ` (better-sqlite3: ${betterError.message})` : '';
      throw new Error(`Não foi possível abrir o banco: use o Node.js 22.13 ou mais novo${why}.`);
    } finally {
      process.emitWarning = emitWarning;
    }
    this.db = new DatabaseSync(file);
    this.depth = 0;
  }

  prepare(sql) {
    return new NodeStatement(this.db.prepare(sql), sql);
  }

  exec(sql) {
    this.db.exec(sql);
    return this;
  }

  pragma(source, { simple = false } = {}) {
    const rows = this.prepare(`PRAGMA ${source}`).all();
    if (!simple) return rows;
    return rows.length ? Object.values(rows[0])[0] : undefined;
  }

  /** Como no better-sqlite3: devolve uma função que roda `fn` numa transação (aninhável). */
  transaction(fn) {
    return (...args) => {
      const outer = this.depth === 0;
      const savepoint = `sp_${this.depth}`;
      this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      this.depth += 1;
      try {
        const result = fn(...args);
        this.depth -= 1;
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        this.depth -= 1;
        this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw err;
      }
    };
  }

  async backup(file) {
    this.db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
  }

  close() {
    this.db.close();
  }
}

function openDatabase(file) {
  return Better ? new Better(file) : new NodeSqliteDatabase(file);
}

const driverName = () => (Better ? 'better-sqlite3' : 'node:sqlite (embutido no Node)');

module.exports = { openDatabase, driverName };
