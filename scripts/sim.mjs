import { pathToFileURL } from 'node:url';
const R = new URL('../', import.meta.url).href;
const imp = (p) => import(new URL(p, R).href);
const { world, exampleCard, SYSTEM, T0 } = await imp('test/helpers.js');
const E = await imp('src/events.js');
const Rw = await imp('src/rewards.js');
const P = await imp('src/periods.js');
const Pen = await imp('src/penalty.js');
const setup = await imp('src/setup.js');
const { verifyChain } = await imp('src/audit.js');
const { StubProvider } = await imp('src/provider/stub.js');
const { ProviderError } = await imp('src/provider/errors.js');
const { tick } = await imp('src/api.js');
const { settingsOf, DEFAULTS } = await imp('src/config.js');
const DAY = 86400_000;

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function run({ seed, variant, days = 100 }) {
  const rand = rng(seed); const ri = (n) => Math.floor(rand() * n);
  const settings = { daily_event_limit: 100000, cards_on: true, lap_bonus_credits: 15, penalty_credit_loss: variant !== 'mnp', ...(variant === 'tight' ? { cap_person_month: 900, cap_person_season: 2500, cap_period_bonus_person_period: 300 } : { cap_person_month: 1000000, cap_person_season: 1000000, cap_event: 1000000, cap_period_bonus_person_period: 1000000 }) };
  const budget = variant === 'tight' || variant === 'budget' ? 2500 : 5_000_000;
  const w = await world({ settings, budget, mode: variant === 'dice' ? 'dice' : 'steady' });
  const { ctx, company, admin } = w;
  let comp = company;
  await exampleCard(w);
  // card with day cap & note card
  await setup.addNoteCard(ctx, comp, admin, { text: 'bonus', effect: 'credits', amount: 25, kind: 'note' }).catch(() => {});
  const g3 = await setup.addTarget(ctx, comp, admin, { name: 'Weekly games', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', active_from: T0 - 30 * DAY, tiers: [{ count: 2, bonus: 40 }, { count: 4, bonus: 100 }], streak: { length: 3, bonus: 200, freeze_per_quarter: 1 } });
  await setup.addTarget(ctx, comp, admin, { name: 'Monthly leads', scope: 'person', period: 'month', event_type: 'lead', stage: 'entered', active_from: T0 - 30 * DAY, tiers: [{ count: 5, bonus: 100 }, { count: 10, bonus: 300 }] });
  await setup.addTarget(ctx, comp, admin, { name: 'Team verified', scope: 'team', period: 'month', event_type: 'lead', stage: 'verified', active_from: T0 - 30 * DAY, tiers: [{ count: 4, bonus: 200 }, { count: 8, bonus: 600 }] });
  const t2 = await setup.createTeam(ctx, comp, admin, { name: 'Ops', manager_id: w.people.mgr.id });
  const teams = [w.team, t2.id];
  const ppl = ['a', 'b', 'c', 'd'].map((k) => w.people[k]);
  // penalty rule: points on game created
  const pr = await setup.addPenaltyRule(ctx, comp, admin, { event_type: 'lead', effect: 'points', amount: 30 });
  await setup.publishPenaltyRule(ctx, comp, admin, pr.id);
  for (const u of Object.values(w.people)) await w.db.run('INSERT INTO consent (id, user_id, company_id, kind, version, at) VALUES (?,?,?,?,?,?)', `cn2_${u.id}`, u.id, comp.id, 'penalty_rules', 'v', w.clock.t + 1);

  // provider with outage switch
  const real = new StubProvider(w.db, comp.id, { now: () => w.clock.t });
  const st = { down: false, downReverse: false, flakyAfter: false };
  const caps = variant === 'mnp' ? { hold: false, debit: false, reverse: false, expiry: false, batch: false, cash_out: false, spend: false, max_batch: 1 } : null;
  const prov = new Proxy(real, { get: (t, k) => {
    if (k === 'capabilities' && caps) return async () => caps;
    if (k === 'credit') return async (x) => { if (st.down) throw new ProviderError('provider_down'); const r = await t.credit(x); if (st.flakyAfter && rand() < 0.5) throw new ProviderError('provider_down'); return r; };
    if (k === 'reverse') return async (x) => { if (st.downReverse) throw new ProviderError('provider_down'); return t.reverse(x); };
    return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
  } });
  ctx.provider = () => prov;
  const viol = []; const V = (m) => { viol.push(`[seed ${seed} ${variant} day ${w.day}] ${m}`); };
  const log = { events: 0, rev: 0, appeals: 0, outages: 0, pen: 0 };
  const evIds = []; let seq = 0;

  const sub = async (actor, o) => {
    const r = await E.submitEvent(ctx, comp, actor, { occurred_at: w.clock.t - ri(3) * DAY - ri(20) * 3600_000, ...o });
    if (r.ok) { log.events++; evIds.push(r.id); }
    return r;
  };
  const SEL = (n) => `SELECT * FROM ${n}`;
  async function invariants(label) {
    const db = w.db, cid = comp.id; const s = settingsOf(await w.reload());
    // (1) caps
    const rows = await db.all("SELECT * FROM reward WHERE company_id=?", cid);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const COUNT = new Set(['queued', 'sent', 'waiting', 'recorded']);
    const pm = new Map(), ps = new Map(), seasonFunded = new Map(), rowm = new Map();
    for (const r of rows) {
      if (!COUNT.has(r.state)) continue;
      let periodKind = ['tier', 'streak', 'team'].includes(r.kind);
      if (r.kind === 'reversal') { const o = byId.get(JSON.parse(r.note).orig); periodKind = o && ['tier', 'streak', 'team'].includes(o.kind); }
      if (!periodKind && r.kind !== 'penalty_return') { const k = r.person_id + '|' + r.month_key; pm.set(k, (pm.get(k) ?? 0) + r.amount); }
      if (r.season_id) { const k = r.person_id + '|' + r.season_id; ps.set(k, (ps.get(k) ?? 0) + r.amount); }
      if (r.group_key?.startsWith('card:')) { const k = r.person_id + '|' + r.group_key + '|' + r.month_key; rowm.set(k, (rowm.get(k) ?? 0) + r.amount); }
    }
    for (const [k, v] of pm) if (v > s.cap_person_month) V(`person-month cap ${k} ${v}>${s.cap_person_month}`);
    for (const [k, v] of ps) if (v > s.cap_person_season) V(`person-season cap ${k} ${v}`);
    for (const r of rows) if (r.state === 'queued' || r.state === 'sent') if (r.amount > 0) seasonFunded.set(r.season_id, (seasonFunded.get(r.season_id) ?? 0) + r.amount);
    for (const [sid, v] of seasonFunded) { if (!sid) { if (v && rows.some((r) => !r.season_id && r.kind !== 'penalty_return' && ['queued', 'sent'].includes(r.state) && r.amount > 0)) V('funded row without season'); continue; } const se = await db.first('SELECT budget FROM season WHERE id=?', sid); if (v > se.budget) V(`season budget ${sid} ${v}>${se.budget}`); }
    const cards = await db.all('SELECT event_type, stage, MAX(cap_month) c FROM rate_card GROUP BY 1,2');
    for (const [k, v] of rowm) { const [, g] = k.split('|'); const [, et, stg] = g.split(':'); const c = cards.find((x) => x.event_type === et && x.stage === stg); if (c && c.c > 0 && v > c.c) V(`row month cap ${k} ${v}>${c.c}`); }
    // period bonus cap per person/period
    const pbc = new Map();
    for (const r of rows) { if (!COUNT.has(r.state) || !['tier', 'streak', 'team'].includes(r.kind)) continue; const k = r.person_id + '|' + r.period_key; pbc.set(k, (pbc.get(k) ?? 0) + r.amount); }
    for (const [k, v] of pbc) if (v > s.cap_period_bonus_person_period) V(`period bonus cap ${k} ${v}`);
    // (2) events reversed/rejected
    for (const e of await db.all("SELECT * FROM event WHERE company_id=? AND status IN ('reversed','rejected')", cid)) {
      const rr = rows.filter((r) => r.event_id === e.id);
      if (e.status === 'rejected' && rr.length) V(`rejected event ${e.id} has rewards`);
      if (e.status === 'reversed') for (const r of rr) { if (r.kind === 'reversal' || r.amount <= 0) continue; if (!r.reversed) V(`reversed event ${e.id} row ${r.id} not reversed`); else if (!(r.state === 'void' || rr.some((x) => x.kind === 'reversal' && JSON.parse(x.note).orig === r.id))) V(`reversed row ${r.id} no reversal row`); }
    }
    for (const r of rows) if (r.reversed && r.kind !== 'reversal' && r.state !== 'void') { if (!rows.some((x) => x.kind === 'reversal' && JSON.parse(x.note).orig === r.id)) V(`reversed=1 sent row ${r.id} without reversal row`); }
    // events under reversal_pending with started: fine
    // (3) provider entries per reward
    const ents = await db.all("SELECT * FROM stub_entry WHERE kind LIKE 'credit:%'");
    const cnt = new Map();
    for (const e of ents) { const rid = e.kind.split(':').slice(2).join(':'); cnt.set(rid, (cnt.get(rid) ?? 0) + 1); }
    for (const [rid, n] of cnt) { const r = byId.get(rid); if (n > 1) V(`reward ${rid} credited ${n} times at provider`); if (!r) continue; if (['void', 'failed'].includes(r.state) && r.kind !== 'reversal') V(`reward ${rid} state ${r.state} but provider credited`); if (r.state === 'waiting') V(`waiting reward ${rid} credited at provider`); }
    for (const r of rows) if (r.state === 'sent' && r.provider_ref !== 'offset' && r.sent_amount > 0 && !cnt.has(r.id)) V(`sent row ${r.id} without provider entry`);
    for (const r of rows) if (r.state === 'sent' && cnt.has(r.id)) { const e = ents.find((x) => x.kind.endsWith(':' + r.id)); if (e.amount !== r.sent_amount) V(`sent_amount mismatch ${r.id} ${e.amount} vs ${r.sent_amount}`); }
    const idemDup = await db.all('SELECT idem_key, COUNT(*) n FROM reward GROUP BY 1 HAVING n>1'); if (idemDup.length) V('dup idem');
    // (4) corrections
    for (const c of await db.all('SELECT * FROM correction WHERE company_id=?', cid)) {
      if (c.recovered < 0 || c.recovered > c.amount) V(`correction ${c.id} recovered ${c.recovered}/${c.amount}`);
      if (c.state === 'cleared' && c.recovered < c.amount) V(`correction cleared early ${c.id}`);
      if (c.state === 'open' && c.recovered >= c.amount) V(`correction open but fully recovered ${c.id}`);
      let take = 0; for (const r of rows) { if (!['queued', 'sent'].includes(r.state) || r.reversed) continue; const n = JSON.parse(r.note || '{}'); for (const [cid2, t] of n.takes ?? []) if (cid2 === c.id) take += t; }
      // reversed (sent+reversal) rows gave takes back, void rows too
      if (take !== c.recovered) V(`correction ${c.id} recovered ${c.recovered} != live takes ${take}`);
    }
    for (const r of rows) { if (r.state === 'queued' || r.state === 'sent') { const n = JSON.parse(r.note || '{}'); if (r.kind !== 'reversal' && r.sent_amount !== undefined && r.provider_ref !== null && r.state === 'sent' && r.sent_amount > r.amount) V('sent>amount ' + r.id); if (n.offset && r.state === 'queued' && r.sent_amount !== r.amount - n.offset) V('sent_amount != amount-offset ' + r.id); } }
    // (5) tier entitlements: net <= max possible, and equal when uncapped
    if (variant !== 'tight' && variant !== 'budget') {
      for (const t of await db.all('SELECT * FROM period_target WHERE company_id=? AND scope=?', cid, 'person')) {
        const tiers = await P.tiersOf(ctx, t.id);
        const grp = await db.all("SELECT person_id, group_key, SUM(amount) s FROM reward WHERE company_id=? AND group_key LIKE ? AND state IN ('queued','sent','waiting','recorded') GROUP BY 1,2", cid, `tier:${t.id}:%`);
        for (const g of grp) { const pk = g.group_key.split(':').slice(2).join(':'); const pr = await db.first("SELECT period_key FROM reward WHERE group_key=? LIMIT 1", g.group_key); const per = (await imp('src/util.js')); const bounds = pr; void bounds; if (g.s > tiers.at(-1).bonus) V(`tier pay ${g.group_key} ${g.s} > max`); if (g.s < 0) V('negative tier net'); }
      }
    }
    // (6) audit
    const ch = await verifyChain(db, cid); if (!ch.ok) V('audit chain broken at ' + ch.brokenAt);
    const ac = async (a) => (await db.first('SELECT COUNT(*) n FROM audit WHERE company_id=? AND action=?', cid, a)).n;
    const nCreate = rows.filter((r) => r.kind !== 'reversal').length; if ((await ac('reward.create')) !== nCreate) V(`audit reward.create ${await ac('reward.create')} != rows ${nCreate}`);
    const nRev = rows.filter((r) => r.kind === 'reversal').length; if ((await ac('reward.reverse')) !== nRev) V(`audit reward.reverse ${await ac('reward.reverse')} != ${nRev}`);
    const nVoid = rows.filter((r) => r.state === 'void').length; if ((await ac('reward.void')) !== nVoid) V(`audit reward.void ${await ac('reward.void')} != ${nVoid}`);
    const nFail = rows.filter((r) => r.state === 'failed').length; if ((await ac('reward.failed')) !== nFail) V(`audit reward.failed ${await ac('reward.failed')} != ${nFail}`);
    const nEvRev = (await db.first("SELECT COUNT(*) n FROM event WHERE company_id=? AND status='reversed'", cid)).n; if ((await ac('event.reverse')) < nEvRev) V(`event.reverse lines ${await ac('event.reverse')} < reversed events ${nEvRev}`);
    const nPen = (await db.first('SELECT COUNT(*) n FROM penalty_case WHERE company_id=? AND applied_at IS NOT NULL', cid)).n; if ((await ac('penalty.apply')) !== nPen) V(`audit penalty.apply ${await ac('penalty.apply')} != ${nPen}`);
    // credit penalties: provider debit entries == applied credits
    for (const pc of await db.all("SELECT * FROM penalty_case WHERE company_id=? AND effect='credits'", cid)) { const d = await db.first("SELECT SUM(-amount) s FROM stub_entry WHERE kind LIKE ?", 'debit:penalty:' + pc.id); const back = await db.first("SELECT amount FROM reward WHERE idem_key=?", 'penrev:' + pc.id); if ((d?.s ?? 0) !== (pc.applied_credits ?? 0)) V(`penalty ${pc.id} debit ${d?.s} != applied ${pc.applied_credits}`); if (pc.state === 'reversed' && pc.applied_credits > 0 && !back) V(`penalty ${pc.id} reversed with no hand-back`); if (back && pc.state !== 'reversed') V('handback of non-reversed penalty'); }
    // board points not negative
    const neg = await db.first('SELECT COUNT(*) n FROM board_state WHERE points < 0 OR position < 0 OR position >= 24'); if (neg.n) V('board out of range');
  }

  async function doTick() { try { await tick(ctx, await w.reload()); } catch (e) { if (!(e instanceof ProviderError)) V('tick threw ' + e.message); } }
  w.day = 0;
  for (let day = 0; day < days; day++) {
    w.day = day; w.clock.t = T0 + day * DAY + 3600_000 * 9;
    st.down = rand() < 0.15; st.downReverse = rand() < 0.15; st.flakyAfter = rand() < 0.1; if (st.down) log.outages++;
    comp = await w.reload();
    // events
    const n = ri(7);
    for (let i = 0; i < n; i++) {
      const p = ppl[ri(4)]; const k = ri(6); seq++;
      try {
        if (k === 0) await sub(w.people.mgr, { person_id: p.id, event_type: 'game', stage: 'created', ext_id: 'GC' + seq, source: 'manual' });
        else if (k === 1) await sub(SYSTEM, { person_id: p.id, event_type: 'game', stage: 'completed', ext_id: 'GD' + seq, source: 'api' });
        else if (k === 2) await sub(w.people.mgr, { person_id: p.id, event_type: 'lead', stage: 'entered', ext_id: 'LE' + seq, dedupe_key: 'pr' + seq, source: 'manual' });
        else if (k === 3) { const r = await sub(w.people.mgr, { person_id: p.id, event_type: 'lead', stage: 'verified', ext_id: 'LV' + seq, source: 'manual' }); if (r.ok && r.status === 'pending') { try { await E.approveEvent(ctx, comp, w.people.hr, r.id); } catch {} if (rand() < 0.3) { /* leave pending */ } } }
        else if (k === 4) await sub(SYSTEM, { person_id: p.id, event_type: 'lead', stage: 'converted', ext_id: 'LC' + seq, source: 'api' });
        else { const r = await sub(w.people.mgr, { person_id: p.id, event_type: 'lead', stage: 'verified', ext_id: 'LX' + seq, source: 'manual' }); if (r.ok && r.status === 'pending') { try { await E.rejectEvent(ctx, comp, w.people.hr, r.id, 'no'); } catch {} } }
      } catch (e) { if (!(e instanceof ProviderError) && !e.status) V('submit threw ' + e.message); }
    }
    // reversal activity
    if (rand() < 0.5 && evIds.length) {
      const id = evIds[ri(evIds.length)];
      try {
        const kind = rand() < 0.5 ? 'sys' : 'mgr';
        await E.requestReversal(ctx, comp, kind === 'sys' ? SYSTEM : w.people.mgr, id, { reason: 'x', kind: 'refund' }); log.rev++;
        const ev = await w.db.first('SELECT * FROM event WHERE id=?', id);
        if (rand() < 0.4) { try { await E.appealReversal(ctx, comp, await w.db.first('SELECT * FROM app_user WHERE id=?', ev.person_id), id); log.appeals++; } catch {} }
        if (kind === 'mgr' && rand() < 0.6) { try { await E.approveReversal(ctx, comp, w.people.hr, id); } catch {} }
        if (rand() < 0.3) { try { await E.decideReversalAppeal(ctx, comp, w.people.hr, id, rand() < 0.5); } catch {} }
      } catch (e) { if (!e.status) V('reversal threw ' + e.message); }
    }
    // team move
    if (rand() < 0.15) await setup.assignTeam(ctx, comp, admin, ppl[ri(4)].id, teams[ri(2)]);
    // penalty proposals
    if (rand() < 0.2) {
      const p = ppl[ri(4)]; const eff = ['points', 'credits', 'steps_back', 'lane'][ri(4)];
      try { const pc = await Pen.proposePenalty(ctx, comp, admin, { person_id: p.id, effect: eff, amount: 80 + ri(100), reason: 'r' }); log.pen++; if (rand() < 0.8) await Pen.approvePenalty(ctx, comp, w.people.hr, pc.id); if (rand() < 0.3) { try { await Pen.appealPenalty(ctx, comp, p, pc.id); } catch {} } } catch (e) { if (!e.status) V('pen threw ' + e.message); }
    }
    for (const c of await w.db.all("SELECT * FROM penalty_case WHERE state='appealed' AND appeal_level=1")) if (rand() < 0.3) { try { await Pen.decideAppeal(ctx, comp, w.people.hr, c.id, rand() < 0.5, 'n'); } catch {} }
    // budget raise / season close
    if (day === 45 && (variant === 'tight' || variant === 'budget')) { const s = await w.db.first("SELECT * FROM season WHERE status='published'"); await setup.raiseBudget(ctx, comp, admin, s.id, s.budget + 1500); await Rw.releaseWaiting(ctx, comp); }
    if (day === 70) {
      const s = await w.db.first("SELECT * FROM season WHERE status='published'");
      await P.settleCompany(ctx, comp, w.clock.t, { force: true }); await setup.closeSeason(ctx, comp, admin, s.id);
      const ns = await setup.createSeason(ctx, comp, admin, { name: 'S2', starts_at: w.clock.t, ends_at: T0 + 400 * DAY, budget: variant === 'tight' || variant === 'budget' ? 2000 : 5_000_000, mode: variant === 'dice' ? 'dice' : 'steady' });
      if (day % 2 === 0 && variant === 'budget') { /* late publish */ w.clock.t += 2 * DAY; }
      await setup.publishSeason(ctx, comp, admin, ns.id, { allowStarted: true });
    }
    // interleaved ticks, crash/retry
    const mode = ri(4);
    if (mode === 0) await Promise.all([doTick(), doTick()]);
    else if (mode === 1) await Promise.all([doTick(), Rw.retryQueued(ctx, comp).catch(() => {}), P.settleCompany(ctx, comp, w.clock.t).catch((e) => { if (!(e instanceof ProviderError)) V('settle threw ' + e.message); })]);
    else { await doTick(); await doTick(); }
    if (day % 7 === 6) { st.down = false; st.downReverse = false; st.flakyAfter = false; await doTick(); }
    await invariants('day ' + day);
  }
  // recovery: provider fine, advance time beyond notice windows & late-close, tick to fixed point
  st.down = false; st.downReverse = false; st.flakyAfter = false;
  for (let i = 0; i < 4; i++) { w.clock.t += 12 * DAY; await doTick(); await doTick(); }
  await invariants('final');
  const snap = async () => JSON.stringify([(await w.db.first('SELECT COUNT(*) n FROM reward')).n, (await w.db.first('SELECT COUNT(*) n FROM correction')).n, (await w.db.first('SELECT COUNT(*) n FROM team_period_member')).n, (await w.db.first("SELECT COUNT(*) n, SUM(amount) s, SUM(recovered) r FROM correction")), (await w.db.first("SELECT SUM(amount) s FROM reward WHERE state IN ('queued','sent','recorded','waiting')"))]);
  const s1 = await snap(); const a1 = (await w.db.first('SELECT COUNT(*) n FROM audit')).n;
  await doTick(); await doTick(); await doTick();
  const s2 = await snap(); const a2 = (await w.db.first('SELECT COUNT(*) n FROM audit')).n;
  if (s1 !== s2) V(`not fixed point: ${s1} -> ${s2}`);
  const stuck = await w.db.all("SELECT state, COUNT(*) n FROM reward WHERE state IN ('queued','waiting') GROUP BY 1");
  const evstuck = await w.db.all("SELECT status, COUNT(*) n FROM event WHERE status IN ('approved','reversal_pending') GROUP BY 1");
  // after everything settles: person-scope tier entitlement exactly equals model (uncapped variants)
  if (variant !== 'tight' && variant !== 'budget') {
    const settleNow = async () => { await P.settleCompany(ctx, await w.reload(), w.clock.t, { force: true }); };
    await settleNow(); await settleNow(); await invariants('post-force');
    for (const t of await w.db.all("SELECT * FROM period_target WHERE scope='person'")) {
      const tiers = await P.tiersOf(ctx, t.id);
      const gs = await w.db.all("SELECT DISTINCT person_id, group_key, period_key FROM reward WHERE group_key LIKE ?", `tier:${t.id}:%`);
      for (const g of gs) {
        const per = await imp('src/util.js'); const pk = g.period_key;
        // find period bounds by scanning events' period
        const evs = await w.db.all("SELECT occurred_at FROM event WHERE person_id=? AND event_type=? AND stage=? AND status IN ('applied','reversal_pending')", g.person_id, t.event_type, t.stage);
        const mine = evs.filter((e) => per.periodOf(t.period, e.occurred_at, 4).key === pk).length;
        const tier = P.tierReached(tiers, mine);
        const net = (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE group_key=? AND person_id=? AND state IN ('queued','sent','waiting','recorded')", g.group_key, g.person_id)).s;
        if (net !== (tier?.bonus ?? 0) && process.env.DBG) console.log(JSON.stringify(await w.db.all("SELECT id,kind,amount,state,reversed,attempts,idem_key,last_error,event_id FROM reward WHERE group_key=? ORDER BY rowid", g.group_key)), JSON.stringify(await w.db.all("SELECT id,status,reversal_kind,reversal_due,reversal_appeal,occurred_at FROM event WHERE person_id=? AND event_type=? AND stage=?", g.person_id, t.event_type, t.stage)));
        if (net !== (tier?.bonus ?? 0)) V(`tier ${g.group_key} p=${g.person_id} net ${net} != entitled ${tier?.bonus ?? 0} (count ${mine})`);
      }
    }
  }
  return { seed, variant, viol, log, stuck, evstuck, auditGrowth: a2 - a1, rewards: (await w.db.first('SELECT COUNT(*) n FROM reward')).n, corr: (await w.db.first('SELECT COUNT(*) n FROM correction')).n };
}

const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number); const variants = (process.argv[3] ?? 'full').split(',');
let bad = 0;
for (const variant of variants) for (const seed of seeds) {
  try { const r = await run({ seed, variant }); if (r.viol.length) bad++; console.log(JSON.stringify({ seed, variant, viol: r.viol.length, log: r.log, stuck: r.stuck, evstuck: r.evstuck, auditGrowth: r.auditGrowth, rewards: r.rewards, corr: r.corr })); for (const v of [...new Set(r.viol.map((x) => x.replace(/day \d+/, 'day N').replace(/rw_\w+|cr_\w+|[a-z]{1,3}_[0-9a-f]{6,}/g, 'ID')))].slice(0, 8)) console.log('  ', v); if (r.viol[0]) console.log('   first:', r.viol[0]); }
  catch (e) { bad++; console.log('CRASH', seed, variant, e.stack.split('\n').slice(0, 4).join(' | ')); }
}
process.exit(bad ? 1 : 0);
