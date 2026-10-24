// Test only: a tiny Postgres client speaking the wire protocol, offering the same small slice of the
// `postgres` package's interface that the app uses (sql`...` tagged queries, sql.json, sql.begin).
// The real app uses the `postgres` package; this lets the tests run against a real Postgres here.

import net from 'node:net';

class JsonParam { constructor(v) { this.value = v; } }

const PARSERS = {
  16: (v) => v === 't',
  21: Number, 23: Number, 26: Number, 700: Number, 701: Number,
  114: JSON.parse, 3802: JSON.parse,
  1082: String,
  1114: (v) => new Date(`${v.replace(' ', 'T')}Z`),
  1184: (v) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')),
};

function connect({ host, port, user, database }) {
  const socket = net.connect({ host, port });
  let buf = Buffer.alloc(0);
  let waiter = null;
  const messages = [];
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) break;
      messages.push({ type: String.fromCharCode(buf[0]), body: buf.subarray(5, len + 1) });
      buf = buf.subarray(len + 1);
    }
    if (waiter) { const w = waiter; waiter = null; w(); }
  });
  const next = async () => {
    while (!messages.length) await new Promise((r) => { waiter = r; });
    return messages.shift();
  };
  const msg = (type, payload) => {
    const head = Buffer.alloc(type ? 5 : 4);
    if (type) { head.write(type, 0); head.writeInt32BE(payload.length + 4, 1); } else head.writeInt32BE(payload.length + 4, 0);
    return Buffer.concat([head, payload]);
  };
  const cstr = (s) => Buffer.from(`${s}\0`);
  const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
  const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

  const ready = (async () => {
    await new Promise((r) => socket.once('connect', r));
    socket.write(msg(null, Buffer.concat([int32(196608), cstr('user'), cstr(user), cstr('database'), cstr(database), cstr('')])));
    for (;;) {
      const m = await next();
      if (m.type === 'E') throw new Error(parseError(m.body).message);
      if (m.type === 'Z') return;
    }
  })();

  function parseError(body) {
    const out = {};
    let i = 0;
    while (body[i]) { const code = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); out[code] = body.subarray(i + 1, end).toString(); i = end + 1; }
    const err = new Error(out.M);
    err.code = out.C;
    err.detail = out.D;
    return err;
  }

  async function query(text, params) {
    await ready;
    if (!params.length) {
      // Simple-query protocol: allows several statements at once (used for the migration file)
      socket.write(msg('Q', cstr(text)));
      return collect();
    }
    const oids = params.map((p) => (p instanceof JsonParam ? 3802 : typeof p === 'boolean' ? 16 : 0));
    const vals = params.map((p) => {
      if (p === null || p === undefined) return null;
      if (p instanceof JsonParam) return Buffer.from(JSON.stringify(p.value));
      if (p instanceof Date) return Buffer.from(p.toISOString());
      if (typeof p === 'boolean') return Buffer.from(p ? 't' : 'f');
      if (typeof p === 'object') throw new Error('Unsupported parameter (use sql.json for objects)');
      return Buffer.from(String(p));
    });
    socket.write(Buffer.concat([
      msg('P', Buffer.concat([cstr(''), cstr(text), int16(oids.length), ...oids.map(int32)])),
      msg('B', Buffer.concat([cstr(''), cstr(''), int16(0), int16(vals.length),
        ...vals.flatMap((v) => (v === null ? [int32(-1)] : [int32(v.length), v])), int16(0)])),
      msg('D', Buffer.concat([Buffer.from('P'), cstr('')])),
      msg('E', Buffer.concat([cstr(''), int32(0)])),
      msg('S', Buffer.alloc(0)),
    ]));
    return collect();
  }

  async function collect() {
    let fields = [];
    const rows = [];
    let error = null;
    let count = 0;
    for (;;) {
      const m = await next();
      if (m.type === 'T') {
        const n = m.body.readInt16BE(0);
        let i = 2;
        fields = [];
        for (let f = 0; f < n; f++) {
          const end = m.body.indexOf(0, i);
          const name = m.body.subarray(i, end).toString();
          i = end + 1;
          const oid = m.body.readInt32BE(i + 6);
          i += 18;
          fields.push({ name, oid });
        }
      } else if (m.type === 'D') {
        const n = m.body.readInt16BE(0);
        let i = 2;
        const row = {};
        for (let f = 0; f < n; f++) {
          const len = m.body.readInt32BE(i);
          i += 4;
          if (len === -1) { row[fields[f].name] = null; continue; }
          const raw = m.body.subarray(i, i + len).toString();
          i += len;
          const parse = PARSERS[fields[f].oid];
          row[fields[f].name] = parse ? parse(raw) : raw;
        }
        rows.push(row);
      } else if (m.type === 'C') {
        const tag = m.body.subarray(0, m.body.length - 1).toString();
        count = Number(tag.split(' ').pop()) || 0;
      } else if (m.type === 'E') {
        error = parseError(m.body);
      } else if (m.type === 'Z') {
        if (error) throw error;
        rows.count = count;
        return rows;
      }
    }
  }
  return { query, close: () => socket.end() };
}

export function createSql(opts) {
  const conn = connect(opts);
  let chain = Promise.resolve();
  const lock = () => {
    let release;
    const prev = chain;
    chain = new Promise((r) => { release = r; });
    return prev.then(() => release);
  };
  const build = (strings, values) => ({ text: strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), ''), values });

  const make = (inTx) => {
    const sql = async (strings, ...values) => {
      const { text, values: params } = build(strings, values);
      if (inTx) return conn.query(text, params);
      const release = await lock();
      try { return await conn.query(text, params); } finally { release(); }
    };
    sql.json = (v) => new JsonParam(v);
    sql.begin = async (fn) => {
      if (inTx) return fn(sql);
      const release = await lock();
      const tx = make(true);
      try {
        await conn.query('begin', []);
        const result = await fn(tx);
        await conn.query('commit', []);
        return result;
      } catch (err) {
        await conn.query('rollback', []).catch(() => {});
        throw err;
      } finally { release(); }
    };
    sql.end = async () => conn.close();
    // For tests that look straight into the database: plain SQL with $1, $2… placeholders
    // Like the postgres package, the result also offers .simple() (multi-statement mode)
    sql.unsafe = (text, params = []) => {
      const run = inTx ? conn.query(text, params) : (async () => {
        const release = await lock();
        try { return await conn.query(text, params); } finally { release(); }
      })();
      run.simple = () => run;
      return run;
    };
    return sql;
  };
  return make(false);
}
