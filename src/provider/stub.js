// DEMO credit provider. Follows contract v1 so the game can be built and tested before Moneypenny is live.
// It keeps demo numbers in its own stub_* tables. It is refused for any company marked live (see index.js).
// The game itself never reads these tables: it only talks to the adapter methods.
import { ProviderError } from './errors.js';
import { newId } from '../util.js';
import { migrateDev } from '../db.js';

export class StubProvider {
  constructor(db, tenant, { now = () => Date.now() } = {}) {
    this.db = db; this.tenant = tenant; this.now = now; this.name = 'stub';
    // The demo tables live in migrations-dev/, never in the production schema. Create them here (local sqlite only).
    if (db.raw) migrateDev(db);
  }
  async capabilities() {
    return { hold: true, debit: true, reverse: true, expiry: true, batch: true, cash_out: false, spend: true, max_batch: 200 };
  }
  async link() { return { tenant_ref: this.tenant, capabilities: await this.capabilities() }; }
  async ensureAccount({ externalRef }) {
    const ref = 'acct_' + externalRef;
    await this.db.run('INSERT OR IGNORE INTO stub_account (ref, tenant) VALUES (?,?)', ref, this.tenant);
    return { account_ref: ref };
  }
  async #acct(ref) {
    const a = await this.db.first('SELECT * FROM stub_account WHERE ref = ? AND tenant = ?', ref, this.tenant);
    if (!a) throw new ProviderError('account_closed', 'No such account.');
    return a;
  }
  async #replay(idem) {
    if (!idem) return null;
    const e = await this.db.first('SELECT * FROM stub_entry WHERE idem = ?', idem);
    return e ? { ...JSON.parse(e.extra || '{}'), entry_id: e.id, duplicate: true } : null;
  }
  async getBalance({ accountRef }) {
    const a = await this.#acct(accountRef);
    const h = await this.db.first("SELECT COALESCE(SUM(remaining),0) s FROM stub_hold WHERE ref = ? AND kind = 'spend' AND state = 'open'", accountRef);
    return { balance: a.balance, spendable: a.balance - h.s, holds: h.s, next_expiry_at: null, unit_name: 'Moneypenny Credits' };
  }
  /** Funded budget: a named hold on the company wallet. The demo wallet is unlimited. */
  async reserveBudget({ amount, name, idem }) {
    if (!Number.isInteger(amount) || amount < 0) throw new ProviderError('bad_request', 'amount');
    const id = 'hold_' + (idem ? idem.replace(/[^a-z0-9]/gi, '').slice(-24) : newId('h'));
    const ex = await this.db.first('SELECT * FROM stub_hold WHERE id = ?', id);
    if (ex) return { hold_id: ex.id, remaining: ex.remaining, duplicate: true };
    await this.db.run("INSERT INTO stub_hold (id, tenant, ref, amount, remaining, kind) VALUES (?,?,?,?,?, 'budget')", id, this.tenant, name, amount, amount);
    return { hold_id: id, remaining: amount };
  }
  async releaseHold({ holdId, amount }) {
    const h = await this.db.first('SELECT * FROM stub_hold WHERE id = ? AND tenant = ?', holdId, this.tenant);
    if (!h) throw new ProviderError('hold_expired', 'No such hold.');
    const rel = Math.min(h.remaining, amount ?? h.remaining);
    await this.db.run('UPDATE stub_hold SET remaining = remaining - ? WHERE id = ?', rel, holdId);
    return { remaining: h.remaining - rel, released: rel };
  }
  async credit({ accountRef, amount, fromHoldId, reasonCode, ref, idem }) {
    const r = await this.#replay(idem);
    if (r) return r;
    if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('bad_request', 'amount');
    const a = await this.#acct(accountRef);
    const id = newId('e');
    if (fromHoldId) {
      const h = await this.db.first("SELECT * FROM stub_hold WHERE id = ? AND tenant = ? AND kind = 'budget'", fromHoldId, this.tenant);
      if (!h) throw new ProviderError('hold_expired', 'No such budget hold.');
      if (h.remaining < amount) throw new ProviderError('insufficient_budget', 'The budget hold is used up.');
    }
    const extra = JSON.stringify({ balance: a.balance + amount });
    const stmts = [
      ['INSERT INTO stub_entry (id, idem, ref, kind, amount, extra, at) VALUES (?,?,?,?,?,?,?)', id, idem ?? null, accountRef, 'credit:' + reasonCode + ':' + (ref ?? ''), amount, extra, this.now()],
      ['UPDATE stub_account SET balance = balance + ?, earned = earned + ? WHERE ref = ?', amount, amount, accountRef],
    ];
    if (fromHoldId) stmts.push(['UPDATE stub_hold SET remaining = remaining - ? WHERE id = ?', amount, fromHoldId]);
    await this.db.batch(stmts);
    return { entry_id: id, balance: a.balance + amount };
  }
  async creditBatch({ items }) {
    const out = [];
    for (const it of items) {
      try { out.push({ ok: true, ...(await this.credit(it)) }); } catch (e) { out.push({ ok: false, code: e.code ?? 'provider_down' }); }
    }
    return out;
  }
  /** Take back earned, unspent credits only. Never below zero. */
  async debit({ accountRef, amount, reasonCode, ref, idem }) {
    const r = await this.#replay(idem);
    if (r) return r;
    const a = await this.#acct(accountRef);
    const take = Math.max(0, Math.min(amount, a.balance));
    const id = newId('e');
    await this.db.batch([
      ['INSERT INTO stub_entry (id, idem, ref, kind, amount, extra, at) VALUES (?,?,?,?,?,?,?)', id, idem ?? null, accountRef, 'debit:' + reasonCode + ':' + (ref ?? ''), -take, JSON.stringify({ debited: take, balance: a.balance - take }), this.now()],
      ['UPDATE stub_account SET balance = balance - ? WHERE ref = ?', take, accountRef],
    ]);
    return { entry_id: id, debited: take, balance: a.balance - take };
  }
  async reverse({ entryId, reasonCode, idem }) {
    const r = await this.#replay(idem);
    if (r) return r;
    const e = await this.db.first('SELECT * FROM stub_entry WHERE id = ?', entryId);
    if (!e || e.amount <= 0) throw new ProviderError('bad_request', 'Only a credit can be reversed.');
    const a = await this.#acct(e.ref);
    const back = Math.min(e.amount, a.balance);
    const id = newId('e');
    await this.db.batch([
      ['INSERT INTO stub_entry (id, idem, ref, kind, amount, extra, at) VALUES (?,?,?,?,?,?,?)', id, idem ?? null, e.ref, 'reversal:' + reasonCode, -back, JSON.stringify({ reversed: back, owed: e.amount - back }), this.now()],
      ['UPDATE stub_account SET balance = balance - ? WHERE ref = ?', back, e.ref],
    ]);
    return { entry_id: id, reversed: back, owed: e.amount - back };
  }
  async reserveSpend({ accountRef, amount, ref, idem }) {
    const id = 'sp_' + String(idem ?? ref ?? newId('s')).replace(/[^a-z0-9]/gi, '').slice(-24);
    const ex = await this.db.first('SELECT * FROM stub_hold WHERE id = ?', id);
    if (ex) return { hold_id: ex.id, credit_applied: ex.amount, duplicate: true };
    const b = await this.getBalance({ accountRef });
    if (b.spendable < amount) throw new ProviderError('insufficient_credits', 'Not enough credits.');
    await this.db.run("INSERT INTO stub_hold (id, tenant, ref, amount, remaining, kind) VALUES (?,?,?,?,?, 'spend')", id, this.tenant, accountRef, amount, amount);
    return { hold_id: id, credit_applied: amount };
  }
  async captureSpend({ holdId, idem }) {
    const h = await this.db.first("SELECT * FROM stub_hold WHERE id = ? AND kind = 'spend'", holdId);
    if (!h) throw new ProviderError('hold_expired', 'No such hold.');
    if (h.state === 'captured') return { entry_id: 'cap_' + holdId, duplicate: true };
    if (h.state !== 'open') throw new ProviderError('hold_expired', 'Hold already ' + h.state);
    await this.db.batch([
      ["UPDATE stub_hold SET state = 'captured', remaining = 0 WHERE id = ?", holdId],
      ['UPDATE stub_account SET balance = balance - ? WHERE ref = ?', h.amount, h.ref],
      ['INSERT INTO stub_entry (id, idem, ref, kind, amount, extra, at) VALUES (?,?,?,?,?,?,?)', 'cap_' + holdId, idem ?? null, h.ref, 'spend', -h.amount, '{}', this.now()],
    ]);
    return { entry_id: 'cap_' + holdId };
  }
  async releaseSpend({ holdId }) {
    const h = await this.db.first("SELECT * FROM stub_hold WHERE id = ? AND kind = 'spend'", holdId);
    if (!h) throw new ProviderError('hold_expired', 'No such hold.');
    if (h.state === 'open') await this.db.run("UPDATE stub_hold SET state = 'released', remaining = 0 WHERE id = ?", holdId);
    return { released: h.state === 'open' ? h.amount : 0 };
  }
  async history({ accountRef, limit = 50 }) {
    const rows = await this.db.all('SELECT id, kind, amount, at FROM stub_entry WHERE ref = ? ORDER BY at DESC, rowid DESC LIMIT ?', accountRef, limit);
    return { lines: rows.map((r) => ({ entry_id: r.id, kind: r.kind.split(':')[0], amount: r.amount, ref: r.kind.split(':').slice(2).join(':'), at: new Date(r.at).toISOString() })) };
  }
  async startPurchase() { throw new ProviderError('unsupported', 'The demo provider sells nothing. No money moves here.'); }
}
