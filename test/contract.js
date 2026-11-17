// Contract v1 test suite for a credit provider. The same cases run against the demo provider and, with a fake
// Moneypenny server, against the real adapter. When the real Moneypenny is live, run it with MNP_LIVE=1 (see CONTRACT/README.md).
import assert from 'node:assert/strict';

export function contractSuite(test, make) {
  test('capabilities() says which optional features exist and spend is always honest', async () => {
    const p = await make();
    const c = await p.capabilities();
    for (const k of ['hold', 'debit', 'reverse', 'expiry', 'batch', 'cash_out', 'spend']) assert.equal(typeof c[k], 'boolean', k);
    assert.equal(c.cash_out, false, 'cash-out is never on');
  });
  test('ensureAccount then credit then balance: whole credits only', async () => {
    const p = await make();
    const { account_ref } = await p.ensureAccount({ externalRef: 'u1', email: 'u1@test.example' });
    assert.ok(account_ref);
    const r = await p.credit({ accountRef: account_ref, amount: 120, reasonCode: 'event', ref: 'r1', idem: 'event:e1:s' });
    assert.ok(r.entry_id);
    assert.equal((await p.getBalance({ accountRef: account_ref })).balance, 120);
    await assert.rejects(p.credit({ accountRef: account_ref, amount: 1.5, reasonCode: 'event', ref: 'r2', idem: 'k-frac' }));
    await assert.rejects(p.credit({ accountRef: account_ref, amount: 0, reasonCode: 'event', ref: 'r3', idem: 'k-zero' }));
  });
  test('a repeated idempotency key never pays twice', async () => {
    const p = await make();
    const { account_ref } = await p.ensureAccount({ externalRef: 'u2', email: 'u2@test.example' });
    await p.credit({ accountRef: account_ref, amount: 50, reasonCode: 'event', ref: 'a', idem: 'event:same:s' });
    await p.credit({ accountRef: account_ref, amount: 50, reasonCode: 'event', ref: 'a', idem: 'event:same:s' });
    assert.equal((await p.getBalance({ accountRef: account_ref })).balance, 50);
  });
  test('spend: reserve then capture takes the credits; reserve then release gives them back; too much is refused', async () => {
    const p = await make();
    if (!(await p.capabilities()).spend) return;
    const { account_ref } = await p.ensureAccount({ externalRef: 'u3', email: 'u3@test.example' });
    await p.credit({ accountRef: account_ref, amount: 300, reasonCode: 'event', ref: 'x', idem: 'event:s3:s' });
    const h1 = await p.reserveSpend({ accountRef: account_ref, amount: 100, ref: 'order1', idem: 'order:1', item: 'Lunch' });
    await p.captureSpend({ holdId: h1.hold_id, idem: 'cap:1' });
    assert.equal((await p.getBalance({ accountRef: account_ref })).balance, 200);
    const h2 = await p.reserveSpend({ accountRef: account_ref, amount: 50, ref: 'order2', idem: 'order:2', item: 'Lunch' });
    await p.releaseSpend({ holdId: h2.hold_id, idem: 'rel:2' });
    assert.equal((await p.getBalance({ accountRef: account_ref })).balance, 200);
    await assert.rejects(p.reserveSpend({ accountRef: account_ref, amount: 5000, ref: 'order3', idem: 'order:3', item: 'Big' }), (e) => e.code === 'insufficient_credits' || e.code === 'bad_request');
  });
  test('optional features either work or say unsupported; the game never fakes them', async () => {
    const p = await make();
    const c = await p.capabilities();
    const { account_ref } = await p.ensureAccount({ externalRef: 'u4', email: 'u4@test.example' });
    if (!c.debit) await assert.rejects(p.debit({ accountRef: account_ref, amount: 1, reasonCode: 'penalty', ref: 'p', idem: 'pen:1' }), (e) => e.code === 'unsupported');
    if (!c.hold) await assert.rejects(p.reserveBudget({ amount: 10, name: 's', idem: 'hold:s' }), (e) => e.code === 'unsupported');
    if (c.debit) {
      await p.credit({ accountRef: account_ref, amount: 30, reasonCode: 'event', ref: 'q', idem: 'event:q:s' });
      const d = await p.debit({ accountRef: account_ref, amount: 100, reasonCode: 'penalty', ref: 'p', idem: 'pen:2' });
      assert.equal(d.debited, 30, 'never below zero: only what is there');
      assert.equal((await p.getBalance({ accountRef: account_ref })).balance, 0);
    }
  });
  test('history lists the credits', async () => {
    const p = await make();
    const { account_ref } = await p.ensureAccount({ externalRef: 'u5', email: 'u5@test.example' });
    await p.credit({ accountRef: account_ref, amount: 10, reasonCode: 'event', ref: 'h', idem: 'event:h:s' });
    const h = await p.history({ accountRef: account_ref });
    assert.ok(Array.isArray(h.lines) && h.lines.length >= 1);
  });
}
