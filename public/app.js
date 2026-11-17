/* Office floor game: browser app. Vanilla JS, no build step. All server text goes in with textContent, never as markup. */
(function () {
  'use strict';

  var S = { cfg: null, me: null, uidN: 0 };
  var ROLE_HOME = { admin: '#/admin', manager: '#/team', hr: '#/hr', employee: '#/' };

  // ---------- tiny DOM helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function append(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === null || k === void 0 || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(k && k.nodeType ? k : document.createTextNode(String(k)));
    }
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === void 0 || v === false || k === 'style') return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }
  function uid() { S.uidN += 1; return 'f' + S.uidN; }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function when(ms) { if (!ms) return ''; try { return new Date(Number(ms)).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }
  function day(ms) { if (!ms) return ''; try { return new Date(Number(ms)).toLocaleDateString([], { dateStyle: 'medium' }); } catch (e) { return ''; } }
  function human(k) { var t = String(k).replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }
  function tail(id) { return String(id || '').slice(-4); }
  function coCfg() { return (S.me && S.me.company) || S.cfg || {}; }
  function unitName() { return coCfg().unit_name || 'moneypenny'; }
  function unitCap() { var u = unitName(); return u.charAt(0).toUpperCase() + u.slice(1); }
  /** The real-money price beside a credit amount, from settings only (credits_per_usd, local_*). */
  function priceOf(credits, mv) {
    var co = coCfg(), per = Number(co.credits_per_usd) || 0, usd = null;
    if (mv && typeof mv.usd === 'number') usd = mv.usd; else if (per > 0) usd = Number(credits || 0) / per;
    if (usd === null) return '';
    var t = '= US$' + usd.toFixed(2), loc = null;
    if (mv && mv.local && mv.local.currency) loc = { currency: mv.local.currency, amount: Number(mv.local.amount) };
    else if (co.local_currency && Number(co.local_per_usd) > 0) loc = { currency: co.local_currency, amount: usd * Number(co.local_per_usd) };
    if (loc) t += ' (about ' + loc.currency + ' ' + loc.amount.toLocaleString(void 0, { maximumFractionDigits: 2 }) + ', for reference)';
    return t;
  }
  /** Amount with our coin icon, the unit word, and the real-money price. */
  function cur(credits, mv, unit) {
    return h('span', { 'class': 'cur' }, Board.coinSvg(), h('b', { text: num(credits) + ' ' + (unit || unitName()) }), ' ', h('span', { 'class': 'price', text: priceOf(credits, mv) }));
  }
  function curText(credits) { var p = priceOf(credits); return num(credits) + ' ' + unitName() + (p ? ' ' + p : ''); }

  // ---------- messages, dialogs ----------
  var toastTimer = 0;
  function toast(msg, bad) {
    var box = $('#toast'), m = $('#toast-msg');
    m.setAttribute('role', bad ? 'alert' : 'status');
    m.textContent = msg;
    box.className = 'toast' + (bad ? ' bad' : '');
    box.hidden = false;
    clearTimeout(toastTimer);
    if (!bad) toastTimer = setTimeout(function () { box.hidden = true; }, 6000);
  }
  function ask(o) {
    return new Promise(function (resolve) {
      var dlg = $('#dlg'), field = $('#dlg-field'), input = null;
      $('#dlg-title').textContent = o.title || 'Please confirm';
      $('#dlg-msg').textContent = o.message || '';
      $('#dlg-ok').textContent = o.ok || 'OK';
      field.replaceChildren();
      if (o.label) {
        var id = uid();
        input = h(o.long ? 'textarea' : 'input', { id: id, type: o.long ? null : 'text', maxlength: 300 });
        field.appendChild(h('div', { class: 'field' }, h('label', { 'for': id, text: o.label }), input));
      }
      var done = false;
      function finish(v) { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); }
      $('#dlg-form').onsubmit = function (e) { e.preventDefault(); if (input && o.required && !input.value.trim()) { input.focus(); return; } finish(input ? input.value.trim() : true); };
      $('#dlg-no').onclick = function () { finish(null); };
      dlg.oncancel = function () { finish(null); };
      dlg.showModal();
      if (input) input.focus(); else $('#dlg-ok').focus();
    });
  }

  // ---------- API ----------
  var REASONS = {
    missing_fields: 'Please fill in person, event type, stage and reference.', bad_date: 'That date is not accepted.', unknown_person: 'We could not find that person.',
    not_allowed: 'You cannot do this one.', not_your_team: 'That person is not on your team.', outside_season: 'There is no open season for that date.',
    no_rate_card: 'No reward is set up for that event and stage.', duplicate: 'This event was already entered.', duplicate_lead: 'This looks like a repeat of an earlier lead.',
    needs_system_source: 'This stage is confirmed by the other system, not by hand.', system_only: 'Only the connected system can send this.',
  };
  function ApiErr(code, message) { var e = new Error(message); e.code = code; return e; }
  async function api(method, path, body) {
    var o = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { o.headers['x-floor'] = '1'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body || {}); }
    var r, j = null;
    try { r = await fetch(path, o); } catch (e) { throw ApiErr('network', 'Cannot reach the server. Please check your connection and try again.'); }
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok === false) {
      var er = (j && j.error) || (j && j.reason ? { code: j.reason, message: REASONS[j.reason] || human(j.reason) + '.' } : { code: 'http_' + r.status, message: 'Something went wrong. Please try again.' });
      if (er.code === 'sign_in' && S.me) { S.me = null; location.hash = '#/'; route(); }
      throw ApiErr(er.code, er.message);
    }
    return j;
  }
  var get = function (p) { return api('GET', p); };
  var post = function (p, b) { return api('POST', p, b); };

  /** Click handler wrapper: disables the button while working and reports errors in the live region. */
  function guard(fn) {
    return async function (ev) {
      var b = ev.currentTarget;
      if (b) b.disabled = true;
      try { await fn(ev); } catch (e) { toast(e.message, true); } finally { if (b) b.disabled = false; }
    };
  }
  function form(onSubmit) {
    var f = h('form', { novalidate: false });
    append(f, Array.prototype.slice.call(arguments, 1));
    f.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var b = f.querySelector('button[type="submit"]');
      if (b) b.disabled = true;
      try { await onSubmit(f, ev); } catch (e) { toast(e.message, true); } finally { if (b) b.disabled = false; }
    });
    return f;
  }
  function submitBtn(text) { return h('button', { type: 'submit', 'class': 'primary', text: text }); }
  function button(text, onclick, cls) { return h('button', { type: 'button', 'class': cls || '', text: text, onclick: guard(onclick) }); }

  // ---------- fields ----------
  function field(label, attrs, hint) {
    var id = uid(), a = Object.assign({ id: id }, attrs || {}), tag = a.tag || 'input';
    delete a.tag;
    var ctl = h(tag, a);
    if (tag === 'input' && attrs && attrs.value !== void 0) ctl.value = attrs.value;
    var kids = [h('label', { 'for': id, text: label }), ctl];
    if (hint) { var hid = id + 'h'; ctl.setAttribute('aria-describedby', hid); kids.push(h('span', { 'class': 'hint', id: hid, text: hint })); }
    return { row: h('div', { 'class': 'field' }, kids), ctl: ctl };
  }
  function selectField(label, options, value, hint) {
    var f = field(label, { tag: 'select' }, hint);
    options.forEach(function (o) {
      var op = h('option', { value: o[0], text: o[1] });
      if (String(o[0]) === String(value)) op.selected = true;
      f.ctl.appendChild(op);
    });
    return f;
  }
  function checkField(label, checked) {
    var id = uid(), ctl = h('input', { type: 'checkbox', id: id });
    ctl.checked = !!checked;
    return { row: h('div', { 'class': 'check' }, ctl, h('label', { 'for': id, text: label })), ctl: ctl };
  }
  function secretBox(label, value) {
    var id = uid(), inp = h('input', { id: id, type: 'text', readonly: true, value: value });
    inp.value = value;
    return h('div', { 'class': 'secret' }, h('label', { 'for': id, text: label }), inp,
      button('Copy', async function () {
        try { await navigator.clipboard.writeText(value); toast('Copied.'); } catch (e) { inp.focus(); inp.select(); toast('Press Ctrl+C (or copy) to copy it.'); }
      }, 'small'));
  }

  // ---------- layout pieces ----------
  var panelN = 0;
  function panel(title, loader, extraClass) {
    panelN += 1;
    var id = 'p' + panelN, body = h('div', { 'class': 'body' }, h('p', { 'class': 'muted', text: 'Loading...' }));
    var sec = h('section', { 'class': 'card ' + (extraClass || ''), 'aria-labelledby': id }, h('h2', { id: id, text: title }), body);
    var reload = async function () {
      try {
        var out = await loader(reload);
        body.replaceChildren();
        append(body, [out]);
      } catch (e) { body.replaceChildren(h('p', { 'class': 'err', role: 'alert', text: e.message })); }
    };
    reload();
    return sec;
  }
  function card(title) {
    var kids = Array.prototype.slice.call(arguments, 1);
    return h('section', { 'class': 'card' }, title ? h('h2', { text: title }) : null, kids);
  }
  function chip(text, kind) { return h('span', { 'class': 'chip ' + (kind || ''), text: text }); }
  function empty(text) { return h('p', { 'class': 'muted', text: text }); }
  function kv(obj, skip) {
    var dl = h('dl', { 'class': 'kv' });
    Object.keys(obj).forEach(function (k) {
      if (skip && skip.indexOf(k) >= 0) return;
      var v = obj[k];
      if (v && typeof v === 'object') v = JSON.stringify(v);
      dl.appendChild(h('dt', { text: human(k) }));
      dl.appendChild(h('dd', { text: v === null || v === void 0 ? '-' : String(v) }));
    });
    return dl;
  }
  function table(cols, rows) {
    var t = h('table', null, h('thead', null, h('tr', null, cols.map(function (c) { return h('th', { scope: 'col', text: c }); }))), h('tbody', null, rows.map(function (r) {
      return h('tr', null, r.map(function (c) { return h('td', null, c); }));
    })));
    return h('div', { 'class': 'tablewrap' }, t);
  }
  function money(mv) { return mv ? cur(mv.credits, mv, mv.unit) : ''; }
  function moneyBlock(mv) {
    return h('div', null, h('p', { 'class': 'stat-big' }, cur(mv.credits, mv, mv.unit)),
      h('p', { 'class': 'muted small', text: 'The price in real money is shown for reference only. This product does not move money.' }));
  }
  /** Bonus roll: the base reward is fixed first; the die only sizes a small bonus on top. Show the die and the percentage. */
  function rollNote(roll, isBonus) {
    if (roll && roll.die !== void 0 && roll.pct !== void 0) {
      return h('p', { 'class': 'small' }, h('span', { 'class': 'die', text: String(roll.die) }), 'Bonus roll: the die gave +' + num(roll.pct) + '% on top of your fixed reward.');
    }
    return isBonus ? h('p', { 'class': 'muted small', text: 'A bonus roll on top of your fixed reward.' }) : null;
  }
  function stat(label, value) { return h('div', { 'class': 'stat' }, h('b', { text: String(value) }), h('span', { text: label })); }
  function tokenChip(avatar, label) { return h('span', { 'class': 'mini' }, Board.tokenSvg(avatar || 'badge', null), label ? ' ' + label : ''); }

  var STATUS = {
    pending: ['Waiting for approval', 'warn'], held: ['On hold', 'warn'], approved: ['Approved', 'good'], applied: ['Counted', 'good'], rejected: ['Not counted', 'bad'],
    reversal_pending: ['Being reviewed', 'warn'], reversed: ['Reversed', ''], queued: ['On the way', 'warn'], sent: ['Delivered', 'good'], waiting: ['Waiting for budget', 'warn'],
    proposed: ['Proposed', 'warn'], appealed: ['Appeal open', 'warn'], upheld: ['Upheld', ''], captured: ['Done', 'good'], released: ['Released', ''], reserved: ['Waiting for approval', 'warn'],
    draft: ['Draft', ''], published: ['Published', 'good'], closed: ['Closed', ''], open: ['Open', 'warn'], frozen: ['Paused', 'warn'],
  };
  function statusChip(st) { var s = STATUS[st] || [human(st), '']; return chip(s[0], s[1]); }
  var EFFECT = { steps_back: 'board steps back', steps: 'board steps', points: 'board points', lane: 'a visit to the Catch-up Lane' };
  /** What a penalty does. A money effect is shown with the unit name and the real price beside it (a node), board effects are plain text. */
  function effectText(effect, amount) {
    if (effect === 'lane') return 'A visit to the Catch-up Lane';
    if (effect === 'credits') return cur(amount);
    return num(amount) + ' ' + (EFFECT[effect] || human(effect).toLowerCase());
  }
  function moveEffect(e, squares) {
    switch (e.t) {
      case 'cooldown': case 'lap': return e.text;
      case 'land': return 'Landed on ' + e.square + '.';
      case 'note': return 'Surprise Note: ' + e.text;
      case 'lap_credits': return ['Lap gift: ', cur(e.credits), '.'];
      case 'note_credits': return ['Note gift: ', cur(e.credits), '.'];
      case 'visit_fee': return 'Visit at ' + e.desk + ': ' + num(e.points) + ' board points from the team pool went to ' + e.to + '.';
      default: return e.text || human(e.t || 'update');
    }
  }

  // ---------- shell ----------
  function productName() { return (S.me && S.me.company.product_name) || (S.cfg && S.cfg.product_name) || 'Office floor game'; }
  function role() { return S.me ? S.me.user.role : null; }
  function demoBanner() {
    var d = $('#demo'), c = S.me && S.me.company;
    if (c && (c.provider === 'stub' || !c.live)) { d.textContent = 'Demo mode: no real ' + unitName() + ' move.'; d.hidden = false; } else d.hidden = true;
  }
  function renderTop(current) {
    var top = $('#top');
    document.title = productName();
    top.replaceChildren(h('a', { 'class': 'brand', href: '#/', text: productName() }));
    if (!S.me) return;
    var r = role(), items = [['#/', 'My board'], ['#/progress', 'My progress'], ['#/shop', 'Shop']];
    if (r !== 'employee' || S.me.company.leaderboard) items.push(['#/league', 'League']);
    if (r === 'manager' || r === 'admin') items.push(['#/team', 'My team']);
    if (r === 'hr' || r === 'admin') items.push(['#/hr', 'HR desk']);
    if (r === 'admin') items.push(['#/admin', 'Admin']);
    items.push(['#/profile', 'Profile']);
    top.appendChild(button('Sign out', async function () {
      try { await post('/api/auth/logout', {}); } catch (e) { /* signing out anyway */ }
      S.me = null; location.hash = '#/'; route();
    }, 'ghost small'));
    if (S.me.consents.employee_notice && S.me.consents.penalty_rules) {
      top.appendChild(h('nav', { 'class': 'nav', 'aria-label': 'Main' }, items.map(function (it) {
        var cur = (it[0] === '#/' ? current === '' : '#/' + current === it[0]);
        return h('a', { href: it[0], 'aria-current': cur ? 'page' : null, text: it[1] });
      })));
    }
  }
  function renderFoot() {
    var f = $('#foot'), url = S.cfg && S.cfg.terms_url;
    f.textContent = (S.cfg && S.cfg.footer) || '';
    if (typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(url)) {
      f.appendChild(document.createTextNode(' | '));
      f.appendChild(h('a', { href: url, rel: 'noopener noreferrer', target: '_blank', text: 'Terms' }));
    }
  }

  // ---------- sign in ----------
  function viewLogin() {
    renderTop(''); demoBanner();
    var main = $('#main');
    var email = field('Work e-mail', { type: 'email', autocomplete: 'username', required: true, inputmode: 'email' });
    var code = field('Sign-in code', { type: 'text', autocomplete: 'one-time-code', required: true, autocapitalize: 'characters', spellcheck: 'false' }, 'Your company admin gives you this code.');
    var msg = h('p', { 'class': 'note', role: 'status', hidden: true });
    var f = form(async function () {
      await post('/api/auth/login', { email: email.ctl.value.trim(), code: code.ctl.value.trim() });
      await boot();
    }, email.row, code.row, msg, h('div', { 'class': 'row' }, submitBtn('Sign in'), button('Ask for a code', async function () {
      if (!email.ctl.value.trim()) { email.ctl.focus(); throw new Error('Please type your work e-mail first.'); }
      var r = await post('/api/auth/request-code', { email: email.ctl.value.trim() });
      msg.textContent = r.message || 'If this e-mail is registered, a code is on its way.';
      msg.hidden = false;
    }, 'ghost')));
    main.replaceChildren(h('div', { 'class': 'card login' }, h('h1', { text: 'Sign in' }), h('p', { 'class': 'muted', text: (S.cfg && S.cfg.tagline) || '' }), f));
    email.ctl.focus();
  }

  // ---------- first-login notice ----------
  function viewConsent() {
    renderTop(''); demoBanner();
    var c = S.me.consents, boxes = [], main = $('#main');
    var kids = [h('h1', { text: 'Before you start' }), h('p', { text: 'Two short notices. Please read them and tick each box yourself. You can ask to see or correct your data at any time.' })];
    if (!c.employee_notice) {
      var cb1 = checkField('I have read the notice about how my work activity is used.', false);
      boxes.push(['employee_notice', cb1.ctl]);
      kids.push(card('How this works',
        h('ul', null,
          h('li', { text: 'Real work events, entered by you, your manager or a connected system, move your token round the board and can earn rewards.' }),
          h('li', { text: 'Only what is needed is kept: the event, its date, who entered it and what it earned. Your name can be hidden from teammates in your profile.' }),
          h('li', { text: 'Your manager sees your team\'s events and progress. HR sees only what a case needs. Every look at another person is logged.' }),
          h('li', { text: 'You can download your data, ask for a correction, or ask us to stop using it, from your Profile page.' }),
          h('li', { text: 'Board points are a game score. They are never ' + unitName() + ' and never money.' })), cb1.row));
    }
    if (!c.penalty_rules) {
      var cb2 = checkField('I have read how penalty notices work.', false);
      boxes.push(['penalty_rules', cb2.ctl]);
      kids.push(card('How penalty notices work',
        h('ul', null,
          h('li', { text: 'A manager can propose a small board step-back, a few board points, or a friendly visit to the Catch-up Lane. ' + unitCap() + ' are only touched if your company has switched that on, and it is capped.' }),
          h('li', { text: 'HR approves every notice first. You are told before anything happens, and you have a window to appeal.' }),
          h('li', { text: 'Nothing is ever applied to anything that happened before the rule was published.' }),
          h('li', { text: 'The ' + unitName() + ' you have already earned stay yours when you take a fresh start.' })), cb2.row));
    }
    var go = button('Save and continue', async function () {
      var todo = boxes.filter(function (b) { return b[1].checked; });
      if (todo.length !== boxes.length) throw new Error('Please tick each box to continue. Nothing is ticked for you.');
      for (var i = 0; i < todo.length; i++) await post('/api/me/consent', { kind: todo[i][0], accepted: true });
      await boot();
    }, 'primary');
    kids.push(h('div', { 'class': 'row' }, go));
    main.replaceChildren(h('div', { 'class': 'login' }, kids));
    main.focus();
  }

  // ---------- zone key ----------
  function zoneKey(squares) {
    var seen = [], ul = h('ul', { 'class': 'legend', 'aria-label': 'Zones' });
    squares.forEach(function (sq) {
      if (seen.indexOf(sq.zone) >= 0) return;
      seen.push(sq.zone);
      ul.appendChild(h('li', null, h('span', { 'class': 'sw z' + (seen.length - 1) }), sq.zone));
    });
    return ul;
  }
  function squareName(squares, i) { return (squares[i] || {}).name || ('Square ' + (i + 1)); }

  // ---------- player home ----------
  async function viewBoard() {
    var b = await get('/api/me/board'), sq = b.squares[b.position] || { name: '', zone: '' };
    var out = [h('h1', { text: 'My board' })];
    var host = h('div', { 'class': 'boardwrap' });
    Board.draw(host, { squares: b.squares, tokens: [{ id: S.me.user.id, name: 'You', avatar: b.avatar || S.me.user.avatar, position: b.position, me: true }], center: { title: sq.name, sub: sq.zone, extra: b.levelName } });
    out.push(card(null,
      h('p', { 'aria-live': 'polite' }, 'You are on ', h('b', { text: sq.name }), ' in the ' + sq.zone + '.'),
      host, zoneKey(b.squares),
      h('div', { 'class': 'stats' }, stat('Board points', num(b.points)), stat('Level', b.levelName || '-'), stat('Laps', num(b.laps)), stat('Fresh starts', num(b.resets)))));

    if (b.inLane || (b.laneTasks && b.laneTasks.length)) {
      out.push(card('Catch-up Lane',
        h('p', { 'class': 'note', text: 'A friendly pause, nothing more. Your next work event brings you straight back onto the ring. A small coaching task is here to help.' }),
        b.laneTasks && b.laneTasks.length ? h('ul', { 'class': 'list' }, b.laneTasks.map(function (t) { return h('li', { text: t.task }); })) : empty('No task right now.')));
    }

    var moves = b.moves.length ? h('ul', { 'class': 'list' }, b.moves.map(function (m) {
      var steps = (m.to_pos - m.from_pos + 24) % 24;
      return h('li', null,
        h('b', { text: squareName(b.squares, m.from_pos) + ' to ' + squareName(b.squares, m.to_pos) }),
        h('span', { 'class': 'muted', text: ' | ' + steps + ' step' + (steps === 1 ? '' : 's') + (m.dice && m.dice.length ? ' | dice ' + m.dice.join(' + ') : '') + ' | ' + when(m.at) }),
        m.effects && m.effects.length ? h('ul', null, m.effects.map(function (e) { return h('li', null, moveEffect(e)); })) : null);
    })) : empty('No moves yet. Your first counted work event moves your token.');
    out.push(card('Last moves', moves));

    var desks = b.desks.length ? h('ul', { 'class': 'list' }, b.desks.map(function (d) {
      var cost = d.price_points * (d.owned ? d.level : 1);
      var line = d.owned ? 'Level ' + d.level + ' of ' + d.max_level : 'Not yet yours';
      var act = null;
      if (!d.owned) act = button('Claim for ' + num(d.price_points) + ' points', async function () { await post('/api/board/claim', { desk_id: d.id }); toast('Desk claimed.'); refresh(); }, 'small');
      else if (d.level < d.max_level) act = button('Upgrade for ' + num(cost) + ' points', async function () { await post('/api/board/upgrade', { desk_id: d.id }); toast('Desk upgraded.'); refresh(); }, 'small');
      return h('li', null, h('b', { text: d.name }), h('span', { 'class': 'muted', text: ' | ' + squareName(b.squares, d.square_idx) + ' | ' + line + (d.target_id ? ' | upgrades need repeat target wins' : '') }),
        act ? h('div', { 'class': 'row' }, act) : null);
    })) : empty('No desks have been set up yet.');
    out.push(card('Milestone desks', h('p', { 'class': 'muted', text: 'You have ' + num(b.points) + ' board points. Desks you hold earn thanks from teammates who visit them.' }), desks));

    out.push(swapsPanel(b));

    out.push(card('Fresh start', h('p', { text: 'Want to begin again? Your token goes back to the Start Desk and your board points are refilled. The ' + unitName() + ' you earned stay yours.' }),
      button('Fresh start', async function () {
        var ok = await ask({ title: 'Start fresh?', message: 'Your token goes back to the Start Desk and your board points reset. The ' + unitName() + ' you earned stay yours.', ok: 'Yes, fresh start' });
        if (!ok) return;
        await post('/api/board/reset', {}); toast('Fresh start done. Your ' + unitName() + ' are untouched.'); refresh();
      })));
    return out;
  }

  // ---------- swaps between teammates ----------
  function swapsPanel(b) {
    return panel('Swaps and help offers', async function (reload) {
      var offers = [], mates = [];
      try { offers = (await get('/api/swaps')).offers || []; } catch (e) { offers = []; }
      try { mates = ((await get('/api/team/board')).tokens || []).filter(function (t) { return t.id !== S.me.user.id; }); } catch (e) { mates = []; }
      var mine = (b.desks || []).filter(function (d) { return d.owned; });
      var label = function (id) { var m = mates.filter(function (t) { return t.id === id; })[0]; return m ? m.name : 'Person ' + tail(id); };
      var incoming = offers.filter(function (o) { return o.state === 'open' && o.from_person !== S.me.user.id; });
      var kids = [h('p', { 'class': 'muted small', text: 'A swap trades two desks between teammates, or offers help. No ' + unitName() + ' are ever part of a swap.' })];
      kids.push(h('h3', { text: 'Offers for you' }));
      kids.push(incoming.length ? h('ul', { 'class': 'list' }, incoming.map(function (o) {
        return h('li', null, h('b', { text: label(o.from_person) + ' offers a swap' }), o.help_text ? h('p', { 'class': 'small', text: o.help_text }) : null,
          h('div', { 'class': 'row' },
            button('Accept', async function () { await post('/api/swaps/' + encodeURIComponent(o.id) + '/answer', { accept: true }); toast('Accepted.'); reload(); }, 'small primary'),
            button('Decline', async function () { await post('/api/swaps/' + encodeURIComponent(o.id) + '/answer', { accept: false }); toast('Declined.'); reload(); }, 'small')));
      })) : empty('No offers waiting.'));
      var sent = offers.filter(function (o) { return o.from_person === S.me.user.id; });
      if (sent.length) kids.push(h('h3', { text: 'Offers you made' }), h('ul', { 'class': 'list' }, sent.map(function (o) {
        return h('li', null, 'To ' + label(o.to_person || ''), ' ', statusChip(o.state === 'accepted' ? 'applied' : o.state === 'declined' ? 'rejected' : 'open'), o.help_text ? h('div', { 'class': 'small', text: o.help_text }) : null);
      })));
      if (mates.length) {
        var to = selectField('Teammate', mates.map(function (t) { return [t.id, t.name]; }));
        var df = selectField('Your desk to give (optional)', [['', 'None, just a help offer']].concat(mine.map(function (d) { return [d.id, d.name]; })));
        var dt = field('Their desk id (optional)', { type: 'text', maxlength: 60 }, 'Only needed for a desk swap.');
        var ht = field('A few words', { tag: 'textarea', maxlength: 200 }, 'For example: I can cover your demo if you take my report.');
        kids.push(h('h3', { text: 'Make an offer' }), form(async function () {
          var body = { to_person_id: to.ctl.value, help_text: ht.ctl.value.trim() };
          if (df.ctl.value && dt.ctl.value.trim()) { body.desk_from = df.ctl.value; body.desk_to = dt.ctl.value.trim(); }
          await post('/api/swaps', body); ht.ctl.value = ''; dt.ctl.value = ''; toast('Offer sent.'); reload();
        }, to.row, df.row, dt.row, ht.row, submitBtn('Send offer')));
      }
      return kids;
    });
  }

  // ---------- progress ----------
  function viewProgress() {
    var out = [h('h1', { text: 'My progress' })];
    out.push(panel('Balance', async function () {
      var b = await get('/api/me/balance');
      return [moneyBlock(b), b.spendable !== void 0 && b.spendable !== null ? h('p', null, 'Ready to spend: ', cur(b.spendable, null, b.unit)) : null,
        b.next_expiry_at ? h('p', { 'class': 'muted', text: 'Next expiry: ' + day(b.next_expiry_at) }) : null];
    }));
    out.push(panel('Targets', async function () {
      var t = (await get('/api/me/targets')).targets;
      if (!t.length) return empty('No targets are open right now.');
      return h('ul', { 'class': 'list' }, t.map(function (x) {
        var next = x.tiers.filter(function (r) { return r.count > x.count; })[0], top = x.tiers.length ? x.tiers[x.tiers.length - 1] : null;
        var goal = next ? next.count : (top ? top.count : Math.max(1, x.count));
        var pid = uid();
        return h('li', null, h('b', { text: x.name }), h('span', { 'class': 'muted', text: ' | ' + human(x.period) + ' | ends ' + day(x.ends_at) }),
          h('label', { 'for': pid, 'class': 'small', text: x.count + ' of ' + goal + (next ? ' for the next tier' : ' (all tiers reached)') }),
          h('progress', { id: pid, max: goal, value: Math.min(x.count, goal) }),
          h('ul', { 'class': 'small' }, x.tiers.map(function (r, i) {
            var hit = x.count >= r.count;
            return h('li', null, 'Tier ' + (i + 1) + ': ' + r.count + ' events, +', cur(r.bonus), hit ? ' (reached)' : '');
          })));
      }));
    }));
    out.push(panel('My events', async function (reload) {
      var ev = (await get('/api/me/events')).events;
      if (!ev.length) return empty('No events yet.');
      return h('ul', { 'class': 'list' }, ev.map(function (e) {
        var why = e.why || (e.status !== 'applied' && e.reason ? e.reason : null);
        return h('li', null, h('b', { text: human(e.event_type) + ' - ' + e.stage }), ' ', statusChip(e.status),
          h('div', { 'class': 'muted small', text: when(e.occurred_at) + (e.approvals_required > 1 ? ' | approvals ' + e.approvals_done + ' of ' + e.approvals_required : '') }),
          why ? h('p', { 'class': 'small', text: 'Why it is not counted: ' + why }) : null,
          e.status === 'reversal_pending' ? button('Ask for a second look', async function () { await post('/api/events/' + e.id + '/reverse/appeal', {}); toast('Your appeal is in.'); reload(); }, 'small') : null);
      }));
    }));
    out.push(panel('Rewards', async function () {
      var r = await get('/api/me/rewards'), kids = [];
      if (r.corrections && r.corrections.length) {
        kids.push(h('div', { 'class': 'note warn' }, h('b', { text: 'Corrections waiting' }),
          h('ul', null, r.corrections.map(function (c) { return h('li', null, cur(c.amount), ' to recover, ', cur(c.recovered), ' so far. ' + (c.reason || '') + ' (' + (STATUS[c.state] ? STATUS[c.state][0] : c.state) + ')'); })),
          h('p', { 'class': 'small', text: 'Corrections only ever take a part of a future reward. Ask HR if something looks wrong.' })));
      }
      kids.push(r.rewards.length ? h('ul', { 'class': 'list' }, r.rewards.map(function (x) {
        var rl = x.roll || (x.die !== void 0 && x.pct !== void 0 ? { die: x.die, pct: x.pct } : null);
        return h('li', null, x.amount >= 0 ? '+' : '', cur(x.amount, x, x.unit), ' ', statusChip(x.state),
          h('div', { 'class': 'muted small', text: (x.kind === 'bonus_roll' ? 'Bonus roll' : human(x.kind)) + ' | ' + when(x.created_at) }),
          rollNote(rl, x.kind === 'bonus_roll'));
      })) : empty('No rewards yet.'));
      return kids;
    }));
    out.push(panel('Penalty notices', async function (reload) {
      var c = (await get('/api/me/penalties')).cases;
      if (!c.length) return empty('Nothing here. That is the usual state.');
      return [h('p', { 'class': 'muted small', text: 'These only touch your board, are small, and can be appealed in the window shown.' }), h('ul', { 'class': 'list' }, c.map(function (x) {
        var canAppeal = x.appeal_by && x.appeal_by > Date.now() && (x.state === 'pending' || x.state === 'applied');
        return h('li', null, h('b', null, effectText(x.effect, x.amount)), ' ', statusChip(x.state),
          h('p', { 'class': 'small', text: x.reason || '' }),
          x.apply_at && x.state === 'pending' ? h('p', { 'class': 'muted small', text: 'Applies on ' + day(x.apply_at) + ' unless you appeal.' }) : null,
          x.appeal_by ? h('p', { 'class': 'muted small', text: 'Appeal by ' + when(x.appeal_by) }) : null,
          x.decision_note ? h('p', { 'class': 'small', text: 'Decision note: ' + x.decision_note }) : null,
          canAppeal ? button('Appeal this notice', async function () {
            var ok = await ask({ title: 'Appeal this notice?', message: 'A reviewer will look at it again. Nothing is applied while it is open.', ok: 'Send appeal' });
            if (!ok) return;
            await post('/api/penalties/' + x.id + '/appeal', {}); toast('Appeal sent.'); reload();
          }, 'small') : null);
      }))];
    }));
    return out;
  }

  // ---------- shop ----------
  function viewShop() {
    var out = [h('h1', { text: 'Shop' })], names = {};
    out.push(panel('Choose something', async function (reload) {
      var items = (await get('/api/shop/items')).items;
      items.forEach(function (i) { names[i.id] = i.name; });
      if (!items.length) return empty('The shop is empty for now.');
      return h('ul', { 'class': 'list' }, items.map(function (i) {
        return h('li', null, h('b', { text: i.name }), h('div', null, cur(i.credits), i.needs_approval ? h('span', { 'class': 'muted', text: ' | needs an approval' }) : null),
          h('div', { 'class': 'row' }, button('Order', async function () {
            var ok = await ask({ title: 'Order ' + i.name + '?', message: 'This uses ' + curText(i.credits) + '. If it needs approval, the ' + unitName() + ' are held until it is decided and released if it is declined.', ok: 'Order' });
            if (!ok) return;
            var r = await post('/api/shop/order', { item_id: i.id });
            toast(r.state === 'captured' ? 'Done. Enjoy.' : 'Order placed. It is waiting for approval.'); reload();
          }, 'small')));
      }));
    }));
    out.push(panel('My orders', async function () {
      var o = (await get('/api/shop/orders')).orders;
      if (!o.length) return empty('No orders yet.');
      return h('ul', { 'class': 'list' }, o.map(function (x) {
        return h('li', null, h('b', { text: names[x.item_id] || 'Item' }), ' ', statusChip(x.state), h('div', { 'class': 'muted small' }, cur(x.credits), ' | ' + when(x.created_at)));
      }));
    }));
    return out;
  }

  // ---------- profile and privacy ----------
  function viewProfile() {
    var u = S.me.user, tokens = (S.cfg && S.cfg.tokens) || ['badge', 'mug', 'plant', 'rocket', 'lamp'];
    var out = [h('h1', { text: 'Profile' })];
    var hide = checkField('Hide my name from teammates (they see "Player" and a number).', u.hide_name);
    var radios = tokens.map(function (t) {
      var id = uid(), r = h('input', { type: 'radio', name: 'token', id: id, value: t });
      r.checked = t === u.avatar;
      return { t: t, r: r, el: h('label', { 'for': id }, r, h('span', { 'class': 'tkbox' }, Board.tokenSvg(t, null)), h('span', { text: human(t) })) };
    });
    out.push(card('My token and name', h('p', { text: 'Signed in as ' + u.name + ' (' + u.email + ').' }), form(async function () {
      var pick = radios.filter(function (x) { return x.r.checked; })[0];
      await api('PUT', '/api/me/profile', { avatar: pick ? pick.t : u.avatar, hide_name: hide.ctl.checked });
      S.me = await get('/api/me'); toast('Saved.');
    }, h('fieldset', null, h('legend', { text: 'Token' }), h('div', { 'class': 'tokpick' }, radios.map(function (x) { return x.el; }))), hide.row, submitBtn('Save'))));

    var kind = selectField('What would you like?', [['access', 'Show me what you hold about me'], ['correction', 'Correct something'], ['end_use', 'Stop using my data']]);
    var note = field('Anything we should know? (optional)', { tag: 'textarea', maxlength: 300 });
    out.push(card('Privacy', h('p', { text: 'Your data is yours to see. You can download everything we hold about you, or send a request to the company team.' }),
      button('Download my data', async function () {
        var r = await fetch('/api/me/export', { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Could not prepare your data. Please try again.');
        var blob = await r.blob(), a = h('a', { href: URL.createObjectURL(blob), download: 'my-data.json' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        toast('Your file is downloading.');
      }),
      h('h3', { text: 'Send a request' }),
      form(async function () {
        await post('/api/me/rights', { kind: kind.ctl.value, note: note.ctl.value.trim() });
        note.ctl.value = ''; toast('Request sent. The company team will pick it up.');
      }, kind.row, note.row, submitBtn('Send request'))));
    return out;
  }

  // ---------- league ----------
  function viewLeague() {
    var out = [h('h1', { text: 'Team league' }), h('p', { 'class': 'muted', text: 'Ranked by verified achievements per person, so small teams are not left behind.' })];
    var body = h('div'), sel = selectField('Period', [['month', 'This month'], ['week', 'This week']], 'month');
    var sec = h('section', { 'class': 'card' });
    async function load() {
      try {
        var r = await get('/api/league?period=' + sel.ctl.value);
        body.replaceChildren(r.league.length ? table(['Rank', 'Team', 'Per person', 'People', 'Achievements'], r.league.map(function (x) {
          return [String(x.rank), x.team, String(x.per_head), x.members === void 0 ? '' : String(x.members), x.achievements === void 0 ? '' : String(x.achievements)];
        })) : empty('No teams yet.'));
      } catch (e) { body.replaceChildren(h('p', { 'class': e.code === 'leaderboard_off' ? 'note' : 'err', role: 'alert', text: e.code === 'leaderboard_off' ? 'The league is switched off for your company.' : e.message })); }
    }
    sel.ctl.addEventListener('change', load);
    sec.appendChild(sel.row); sec.appendChild(body);
    out.push(sec); load();
    return out;
  }

  // ---------- manager ----------
  async function people() { return (await get('/api/people')).people; }
  function personLabel(p) { return p.name || ('Person ' + tail(p.id)); }

  function eventLine(e) { return human(e.event_type) + ' - ' + e.stage + ' (' + e.ext_id + ')'; }

  function pendingPanel(extraStatuses) {
    return panel('Waiting for approval', async function (reload) {
      var rows = (await get('/api/events?status=pending')).events;
      try { rows = rows.concat((await get('/api/events?status=held')).events); } catch (e) { /* held list is optional */ }
      if (!rows.length) return empty('Nothing is waiting. Nice.');
      return h('ul', { 'class': 'list' }, rows.map(function (e) {
        return h('li', null, h('b', { text: e.person + ': ' + eventLine(e) }), ' ', statusChip(e.status),
          h('div', { 'class': 'muted small', text: when(e.occurred_at) + ' | via ' + e.source + (e.approvals_required > 1 ? ' | approvals ' + e.approvals_done + ' of ' + e.approvals_required : '') }),
          e.reason ? h('p', { 'class': 'small', text: e.reason }) : null,
          h('div', { 'class': 'row' },
            button('Approve', async function () { await post('/api/events/' + e.id + '/approve', {}); toast('Approved.'); reload(); }, 'small primary'),
            button('Not counted', async function () {
              var why = await ask({ title: 'Do not count this event?', message: 'Say why in a kind sentence. The person will see it.', label: 'Reason', required: true, ok: 'Confirm' });
              if (!why) return;
              await post('/api/events/' + e.id + '/reject', { reason: why }); toast('Marked as not counted.'); reload();
            }, 'small')));
      }));
    });
  }

  function penaltiesPanel(canAct) {
    return panel('Penalty notices', async function (reload) {
      var names = {};
      if (role() !== 'hr') { try { (await people()).forEach(function (p) { names[p.id] = p.name; }); } catch (e) { /* ids only */ } }
      var cases = (await get('/api/penalties')).cases;
      if (!cases.length) return empty('No penalty notices.');
      return h('ul', { 'class': 'list' }, cases.map(function (c) {
        var acts = [];
        if (canAct && c.state === 'proposed') {
          acts.push(button('Approve', async function () { await post('/api/penalties/' + c.id + '/approve', {}); toast('Approved. The person is told first and can appeal.'); reload(); }, 'small primary'));
          acts.push(button('Do not proceed', async function () {
            var n = await ask({ title: 'Do not proceed?', message: 'Add a short note.', label: 'Note', ok: 'Confirm' });
            if (n === null) return;
            await post('/api/penalties/' + c.id + '/reject', { note: n }); toast('Closed.'); reload();
          }, 'small'));
        }
        if (canAct && c.state === 'appealed') {
          var decide = function (forPerson, label) {
            return button(label, async function () {
              var n = await ask({ title: label + '?', message: 'Add a short note for the person.', label: 'Note', ok: 'Confirm' });
              if (n === null) return;
              await post('/api/penalties/' + c.id + '/decide', { for_person: forPerson, note: n }); toast('Decision saved.'); reload();
            }, 'small');
          };
          acts.push(decide(true, 'Decide for the person'), decide(false, 'Keep the notice'));
        }
        return h('li', null, h('b', null, (names[c.person_id] || 'Person ' + tail(c.person_id)) + ': ', effectText(c.effect, c.amount)), ' ', statusChip(c.state),
          h('p', { 'class': 'small', text: c.reason || '' }),
          c.apply_at ? h('p', { 'class': 'muted small', text: 'Applies ' + when(c.apply_at) }) : null,
          acts.length ? h('div', { 'class': 'row' }, acts) : null);
      }));
    });
  }

  function viewTeam() {
    var out = [h('h1', { text: 'My team' })], boardHost = h('div');
    function loadBoard(teamId) {
      boardHost.replaceChildren(panel('Team board', async function () {
        var r = await get('/api/team/board' + (teamId ? '?team_id=' + encodeURIComponent(teamId) : ''));
        var host = h('div', { 'class': 'boardwrap' });
        Board.draw(host, { squares: r.squares, tokens: r.tokens.map(function (t) { return { id: t.id, name: t.name, avatar: t.avatar, position: t.position }; }), center: { title: r.team.name, sub: 'Team pool: ' + num(r.pool_points) + ' points' } });
        return [host, zoneKey(r.squares), r.tokens.length ? h('ul', { 'class': 'list' }, r.tokens.map(function (t) {
          return h('li', null, tokenChip(t.avatar, t.name), h('span', { 'class': 'muted small', text: ' | ' + squareName(r.squares, t.position) + ' | level ' + t.level + ' | laps ' + t.laps }));
        })) : empty('No one is on this team yet.')];
      }));
    }
    if (role() === 'admin') {
      var tsel = selectField('Team', [['', 'Loading...']]);
      out.push(card(null, tsel.row));
      get('/api/admin/teams').then(function (r) {
        tsel.ctl.replaceChildren();
        r.teams.forEach(function (t) { tsel.ctl.appendChild(h('option', { value: t.id, text: t.name })); });
        if (r.teams.length) loadBoard(r.teams[0].id); else boardHost.replaceChildren(card(null, empty('No teams yet.')));
      }).catch(function (e) { toast(e.message, true); });
      tsel.ctl.addEventListener('change', function () { loadBoard(tsel.ctl.value); });
    } else loadBoard(null);
    out.push(boardHost);
    out.push(pendingPanel());

    out.push(panel('Enter an event', async function () {
      var ppl = await people();
      var who = selectField('Person', ppl.map(function (p) { return [p.id, personLabel(p)]; }));
      var type = field('Event type', { type: 'text', required: true, maxlength: 60 }, 'For example: sale, project, training. It must match a reward set up by your admin.');
      var stage = field('Stage', { type: 'text', required: true, maxlength: 40 });
      var ext = field('Reference', { type: 'text', required: true, maxlength: 120 }, 'The id from your other system. The same reference is never counted twice.');
      var dd = field('Dedupe key (optional)', { type: 'text', maxlength: 200 }, 'For example a lead e-mail, so repeats are spotted.');
      var date = field('Date (optional)', { type: 'date' }, 'Leave empty for today. Dates in the future are not accepted.');
      var rolled = h('div', { 'aria-live': 'polite' });
      return form(async function (f) {
        var body = { person_id: who.ctl.value, event_type: type.ctl.value.trim(), stage: stage.ctl.value.trim(), ext_id: ext.ctl.value.trim() };
        if (dd.ctl.value.trim()) body.dedupe_key = dd.ctl.value.trim();
        if (date.ctl.value) body.occurred_at = Date.parse(date.ctl.value + 'T12:00:00');
        var r = await post('/api/events', body);
        toast('Saved. Status: ' + ((STATUS[r.status] || [r.status])[0]) + '.');
        var rr = r.roll || (r.result && r.result.roll) || null, bonus = r.bonus !== void 0 ? r.bonus : (r.result && r.result.bonus);
        rolled.replaceChildren();
        if (rr) rolled.appendChild(h('div', { 'class': 'note' }, rollNote(rr, true), bonus ? h('p', { 'class': 'small' }, 'Bonus paid: ', cur(bonus)) : null));
        ext.ctl.value = ''; dd.ctl.value = '';
      }, who.row, type.row, stage.row, ext.row, dd.row, date.row, submitBtn('Save event'), rolled);
    }));

    out.push(csvPanel());

    out.push(panel('Who contributed this month', async function () {
      var r = await get('/api/team/contributions');
      if (!r.contributions.length) return empty('No people yet.');
      return [h('p', { 'class': 'muted small', text: 'Period ' + r.period + '. Counted events only.' }), table(['Person', 'Counted events'], r.contributions.map(function (c) { return [c.person, String(c.events)]; }))];
    }));

    out.push(panel('Propose a penalty notice', async function () {
      var ppl = (await people()).filter(function (p) { return p.id !== S.me.user.id; });
      var who = selectField('Person', ppl.map(function (p) { return [p.id, personLabel(p)]; }));
      var eff = selectField('What happens on the board', [['steps_back', 'A few steps back'], ['points', 'A few board points'], ['lane', 'A friendly visit to the Catch-up Lane']]);
      var amt = field('How many (steps or points)', { type: 'number', min: 0, max: 1000, value: '1' }, 'Keep it small. Not used for the Catch-up Lane.');
      var why = field('What happened, and how can we help?', { tag: 'textarea', maxlength: 300, required: true }, 'Kind, specific words. The person reads this.');
      return [h('p', { 'class': 'note', text: 'HR approves first. The person is told before anything happens and can appeal. Only people who have read the penalty notice can be proposed for.' }),
        form(async function () {
          var r = await post('/api/penalties', { person_id: who.ctl.value, effect: eff.ctl.value, amount: Number(amt.ctl.value) || 0, reason: why.ctl.value.trim() });
          toast('Proposed. HR will review it.'); why.ctl.value = '';
        }, who.row, eff.row, amt.row, why.row, submitBtn('Propose'))];
    }));

    out.push(penaltiesPanel(false));

    out.push(panel('Catch-up Lane tasks', async function () {
      var ppl = await people();
      var who = selectField('Person', ppl.map(function (p) { return [p.id, personLabel(p)]; }), '', 'Looking at a person is logged for privacy.');
      var res = h('div');
      async function look() {
        var r = await get('/api/people/' + who.ctl.value + '/summary');
        var tasks = r.board.laneTasks || [];
        res.replaceChildren(h('p', { text: r.person.name + ' is on ' + squareName(r.board.squares, r.board.position) + '.' }),
          tasks.length ? h('ul', { 'class': 'list' }, tasks.map(function (t) {
            return h('li', null, h('span', { text: t.task }), h('div', { 'class': 'row' }, button('Mark as done', async function () { await post('/api/lane/' + t.id + '/finish', {}); toast('Done. They are back on the ring.'); await look(); }, 'small primary')));
          })) : empty('No open coaching task.'));
      }
      return [who.row, button('Show tasks', look), res];
    }));

    out.push(panel('Counted events (to correct a mistake)', async function (reload) {
      var rows = (await get('/api/events?status=applied')).events;
      if (!rows.length) return empty('Nothing counted yet.');
      return [h('p', { 'class': 'muted small', text: 'If an event was counted by mistake, ask to reverse it. A reversal needs a second look and the person can appeal.' }), h('ul', { 'class': 'list' }, rows.slice(0, 60).map(function (e) {
        return h('li', null, h('b', { text: e.person + ': ' + eventLine(e) }), h('div', { 'class': 'muted small', text: when(e.occurred_at) }),
          button('Reverse', async function () {
            var why = await ask({ title: 'Reverse this event?', message: 'Say why. The person is told.', label: 'Reason', required: true, ok: 'Ask for reversal' });
            if (!why) return;
            await post('/api/events/' + e.id + '/reverse', { reason: why }); toast('Reversal requested.'); reload();
          }, 'small'));
      }))];
    }));
    return out;
  }

  function csvPanel() {
    return panel('Upload a CSV', async function () {
      var ta = field('CSV text', { tag: 'textarea', rows: 6, spellcheck: 'false' }, 'Columns: work_email, event_type, stage, ext_id, occurred_at (optional), dedupe_key (optional). First row is the header.');
      var file = field('Or choose a file', { type: 'file', accept: '.csv,text/csv' });
      file.ctl.addEventListener('change', async function () {
        var f = file.ctl.files && file.ctl.files[0];
        if (f) { ta.ctl.value = await f.text(); toast('File loaded. Now press Preview.'); }
      });
      var out = h('div', { 'aria-live': 'polite' });
      var previewBtn = button('Preview', async function () {
        if (!ta.ctl.value.trim()) throw new Error('Add some CSV first.');
        var r = await post('/api/events/csv', { csv: ta.ctl.value, commit: false });
        var kids = [h('p', null, h('b', { text: r.accepted + ' of ' + r.rows + ' rows will count' }), ' | ', cur(r.total_credits), ' in total.'),
          r.needs_second_person ? h('p', { 'class': 'note warn', text: 'This is a big file, so each event needs a second approver.' }) : null];
        if (r.rejected.length) kids.push(h('p', { text: 'These rows will be skipped:' }), table(['Row', 'Why'], r.rejected.map(function (x) { return [String(x.row), (REASONS[x.reason] || human(x.reason))]; })));
        if (r.accepted > 0) kids.push(button('Confirm and import', async function () {
          var c = await post('/api/events/csv', { csv: ta.ctl.value, commit: true });
          out.replaceChildren(h('p', { 'class': 'note', text: 'Imported.' }), table(['Reference', 'Result'], (c.results || []).map(function (x) { return [x.ext_id, x.ok ? ((STATUS[x.status] || [x.status || 'saved'])[0]) : (REASONS[x.reason] || human(x.reason || 'skipped'))]; })));
        }, 'primary'));
        out.replaceChildren.apply(out, kids.filter(Boolean));
      });
      return [ta.row, file.row, h('div', { 'class': 'row' }, previewBtn), out];
    });
  }

  // ---------- HR ----------
  var OVERVIEW_LABELS = { people: 'People', events_pending: 'Events waiting', rewards_on_the_way: 'Rewards on the way', rewards_waiting_budget: 'Rewards waiting for budget', open_corrections: 'Open corrections', penalties_open: 'Open penalty notices', rights_open: 'Open privacy requests' };
  function overviewPanel() {
    return panel('Overview', async function () {
      var o = await get('/api/admin/overview'), dl = h('dl', { 'class': 'kv' });
      Object.keys(OVERVIEW_LABELS).forEach(function (k) { dl.appendChild(h('dt', { text: OVERVIEW_LABELS[k] })); dl.appendChild(h('dd', { text: num(o[k]) })); });
      dl.appendChild(h('dt', { text: unitCap() + ' used this season' })); dl.appendChild(h('dd', null, cur(o.used_budget)));
      if (o.season) { dl.appendChild(h('dt', { text: 'Season' })); dl.appendChild(h('dd', null, o.season.name + ' | budget ', cur(o.season.budget), ' | ends ' + day(o.season.ends_at))); }
      return dl;
    });
  }
  function reversalsPanel() {
    return panel('Reversals to approve', async function (reload) {
      var rows = (await get('/api/events?status=reversal_pending')).events;
      if (!rows.length) return empty('No reversals waiting.');
      return h('ul', { 'class': 'list' }, rows.map(function (e) {
        var acts = [button('Approve reversal', async function () { await post('/api/events/' + e.id + '/reverse/approve', {}); toast('Reversal approved.'); reload(); }, 'small primary')];
        if (e.reversal_appeal) {
          acts.push(button('Keep the reversal', async function () { await post('/api/events/' + e.id + '/reverse/decide', { uphold: true }); toast('Decision saved.'); reload(); }, 'small'));
          acts.push(button('Cancel the reversal', async function () { await post('/api/events/' + e.id + '/reverse/decide', { uphold: false }); toast('Decision saved.'); reload(); }, 'small'));
        }
        return h('li', null, h('b', { text: e.person + ': ' + eventLine(e) }), ' ', chip(e.reversal_kind === 'system' ? 'Asked by the source system' : 'Asked by a manager', 'warn'), e.reversal_appeal ? ' ' : null, e.reversal_appeal ? chip('Person appealed', 'warn') : null,
          e.reversal_due ? h('div', { 'class': 'muted small', text: 'Due ' + day(e.reversal_due) }) : null, h('div', { 'class': 'row' }, acts));
      }));
    });
  }
  function auditPanel() {
    var sel = selectField('How many lines', [['50', '50'], ['100', '100'], ['300', '300']], '100');
    var sec = h('section', { 'class': 'card', 'aria-labelledby': 'auditH' }, h('h2', { id: 'auditH', text: 'Audit trail' }), sel.row);
    var body = h('div');
    sec.appendChild(body);
    async function load() {
      try {
        var r = await get('/api/admin/audit?limit=' + sel.ctl.value), v = r.verify;
        var okText = v && typeof v === 'object' ? (v.ok === false ? 'The chain check found a problem.' : 'The chain check passed.') : 'Chain checked.';
        body.replaceChildren(h('p', { 'class': (v && v.ok === false) ? 'err' : 'note', role: 'status', text: okText }),
          table(['No.', 'When', 'Who', 'What', 'Details'], r.rows.map(function (x) { return [String(x.n), when(x.at), tail(x.actor), x.action, String(x.data || '').slice(0, 160)]; })));
      } catch (e) { body.replaceChildren(h('p', { 'class': 'err', role: 'alert', text: e.message })); }
    }
    sel.ctl.addEventListener('change', load);
    load();
    return sec;
  }
  function rightsPanel() {
    return panel('Privacy requests', async function (reload) {
      var rq = (await get('/api/admin/rights')).requests;
      if (!rq.length) return empty('No requests.');
      var kinds = { access: 'See my data', correction: 'Correct my data', end_use: 'Stop using my data' };
      return h('ul', { 'class': 'list' }, rq.map(function (x) {
        var open = x.state === 'open';
        return h('li', null, h('b', { text: kinds[x.kind] || human(x.kind) }), ' ', statusChip(x.state), h('div', { 'class': 'muted small', text: 'Person ' + tail(x.person_id) + ' | ' + when(x.created_at) }), x.note ? h('p', { 'class': 'small', text: x.note }) : null,
          open ? h('div', { 'class': 'row' }, button('Mark as resolved', async function () {
            var ok = await ask({ title: 'Mark this request as resolved?', message: 'Only do this once the person has what they asked for. The step is written to the audit trail.', ok: 'Resolve' });
            if (!ok) return;
            var r = await post('/api/admin/rights/' + encodeURIComponent(x.id) + '/resolve', {});
            toast(r && r.ok === false ? 'It was already resolved.' : 'Request resolved.'); reload();
          }, 'small primary')) : null);
      }));
    });
  }
  function viewHr() {
    return [h('h1', { text: 'HR desk' }), overviewPanel(), penaltiesPanel(true), reversalsPanel(), rightsPanel(), auditPanel()];
  }

  // ---------- admin ----------
  var ADMIN_TABS = [['overview', 'Overview'], ['settings', 'Settings'], ['people', 'People and teams'], ['rates', 'Rewards'], ['targets', 'Targets'], ['seasons', 'Seasons'], ['simulate', 'Budget check'], ['content', 'Board content'], ['keys', 'Connections'], ['shop', 'Shop'], ['ai', 'AI access'], ['run', 'Run now']];
  var createdRules = [];
  var SCOPES = [['ingest', 'Send work events (CRM, game server)'], ['widgets', 'Partner Circle dashboard widgets'], ['ai_read', 'AI helper (reads summaries and asks; a person decides)'], ['provider_webhook', 'Credit provider messages']];

  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }
  function dateMs(v) { return v ? Date.parse(v + 'T00:00:00') : 0; }

  function viewAdmin(parts) {
    var sub = parts[1] || 'overview';
    var out = [h('h1', { text: 'Admin' }), h('nav', { 'class': 'subnav', 'aria-label': 'Admin sections' }, ADMIN_TABS.map(function (t) {
      return h('a', { href: '#/admin/' + t[0], 'aria-current': t[0] === sub ? 'page' : null, text: t[1] });
    }))];
    var fn = { overview: adminOverview, settings: adminSettings, people: adminPeople, rates: adminRates, targets: adminTargets, seasons: adminSeasons, simulate: adminSimulate, content: adminContent, keys: adminKeys, shop: adminShop, ai: adminAi, run: adminRun }[sub] || adminOverview;
    return out.concat(fn());
  }
  function adminOverview() {
    return [overviewPanel(), h('p', null, h('a', { href: '#/league', text: 'See the league' }), ' | ', h('a', { href: '#/hr', text: 'Open the HR desk' }), ' | ', h('a', { href: '#/team', text: 'Open the team view' }))];
  }

  function adminSettings() {
    return [panel('Company settings', async function () {
      var r = await get('/api/admin/settings'), s = r.settings, fields = [], skip = ['cash_out', 'squares'];
      var intro = h('p', { 'class': 'muted', text: 'Provider: ' + r.provider + (r.live ? ' (live)' : ' (demo: no real ' + unitName() + ' move)') + '. Rules only get stricter from next month, never backwards.' });
      Object.keys(s).forEach(function (k) {
        if (skip.indexOf(k) >= 0) return;
        var v = s[k], f, lbl = human(k).replace(/credits/gi, unitName());
        if (typeof v === 'boolean') f = checkField(lbl, v);
        else if (k === 'mode') f = selectField('Movement', [['steady', 'Steady (fixed moves)'], ['dice', 'Dice (bonus roll on top)']], v);
        else if (typeof v === 'number') f = field(lbl, { type: 'number', value: String(v) });
        else f = field(lbl, { type: 'text', value: String(v), maxlength: 40 });
        fields.push({ k: k, f: f, orig: v });
      });
      return [intro, form(async function () {
        var patch = {};
        fields.forEach(function (x) {
          var cur = x.f.ctl.type === 'checkbox' ? x.f.ctl.checked : (typeof x.orig === 'number' ? Number(x.f.ctl.value) : x.f.ctl.value);
          if (cur !== x.orig) patch[x.k] = cur;
        });
        if (!Object.keys(patch).length) { toast('Nothing changed.'); return; }
        await api('PUT', '/api/admin/settings', patch);
        S.me = await get('/api/me'); renderTop('admin'); demoBanner();
        toast('Settings saved.');
      }, fields.map(function (x) { return x.f.row; }), submitBtn('Save settings'))];
    })];
  }

  function adminPeople() {
    var reveal = h('div', { 'aria-live': 'polite' });
    function showCode(label, code) { reveal.replaceChildren(h('div', { 'class': 'note warn', text: 'Shown once. Copy it now and give it to the person. It works for 7 days.' }), secretBox(label, code)); reveal.scrollIntoView({ block: 'center' }); }
    var teamsBox = panel('Teams', async function (reload) {
      var teams = (await get('/api/admin/teams')).teams, ppl = await people();
      var mgrs = ppl.filter(function (p) { return p.role === 'manager'; });
      var nm = field('Team name', { type: 'text', required: true, maxlength: 80 });
      var mg = selectField('Manager (optional)', [['', 'No manager yet']].concat(mgrs.map(function (p) { return [p.id, personLabel(p)]; })));
      var byId = {}; ppl.forEach(function (p) { byId[p.id] = p.name; });
      return [teams.length ? h('ul', { 'class': 'list' }, teams.map(function (t) { return h('li', null, h('b', { text: t.name }), h('span', { 'class': 'muted', text: t.manager_id ? ' | manager ' + (byId[t.manager_id] || tail(t.manager_id)) : ' | no manager' })); })) : empty('No teams yet.'),
        h('h3', { text: 'Add a team' }), form(async function () {
          await post('/api/admin/teams', { name: nm.ctl.value.trim(), manager_id: mg.ctl.value || null });
          toast('Team added.'); reload();
        }, nm.row, mg.row, submitBtn('Add team'))];
    });
    var peopleBox = panel('People', async function (reload) {
      var teams = (await get('/api/admin/teams')).teams, ppl = await people();
      var tname = {}; teams.forEach(function (t) { tname[t.id] = t.name; });
      var email = field('Work e-mail', { type: 'email', required: true }), nm = field('Name', { type: 'text', required: true, maxlength: 80 }), wid = field('Work id (optional)', { type: 'text', maxlength: 60 });
      var rl = selectField('Role', [['employee', 'Employee'], ['manager', 'Manager'], ['hr', 'HR'], ['admin', 'Admin']], 'employee');
      var tm = selectField('Team (optional)', [['', 'No team']].concat(teams.map(function (t) { return [t.id, t.name]; })));
      return [h('ul', { 'class': 'list' }, ppl.map(function (p) {
        var pick = selectField('Move ' + p.name + ' to', [['', 'No team']].concat(teams.map(function (t) { return [t.id, t.name]; })), p.team_id || '');
        return h('li', null, tokenChip(p.avatar, null), h('b', { text: ' ' + p.name }), ' ', chip(p.role), h('div', { 'class': 'muted small', text: p.email + (p.team_id ? ' | ' + (tname[p.team_id] || 'team') : ' | no team') }),
          pick.row,
          h('div', { 'class': 'row' },
            button('Set team', async function () { await post('/api/admin/people/' + p.id + '/team', { team_id: pick.ctl.value || null }); toast('Team updated.'); reload(); }, 'small'),
            button('New sign-in code', async function () { var r = await post('/api/admin/people/' + p.id + '/code', {}); showCode('Code for ' + p.name, r.code); }, 'small'),
            p.id === S.me.user.id ? null : button('Remove', async function () {
              var ok = await ask({ title: 'Remove ' + p.name + '?', message: 'They can no longer sign in. Their history is kept.', ok: 'Remove' });
              if (!ok) return;
              await post('/api/admin/people/' + p.id + '/remove', {}); toast('Removed.'); reload();
            }, 'small')));
      })),
        h('h3', { text: 'Add a person' }), form(async function () {
          var r = await post('/api/admin/people', { email: email.ctl.value.trim(), name: nm.ctl.value.trim(), work_id: wid.ctl.value.trim() || null, role: rl.ctl.value, team_id: tm.ctl.value || null });
          showCode('Invite code for ' + nm.ctl.value.trim(), r.invite_code);
          email.ctl.value = ''; nm.ctl.value = ''; wid.ctl.value = ''; reload();
        }, email.row, nm.row, wid.row, rl.row, tm.row, submitBtn('Add person'))];
    });
    var csvBox = panel('Add people from a CSV', async function () {
      var ta = field('CSV text', { tag: 'textarea', rows: 5, spellcheck: 'false' }, 'Columns: name, work_email, work_id, role, team_id. First row is the header.');
      var out = h('div', { 'aria-live': 'polite' });
      return [ta.row, h('div', { 'class': 'row' }, button('Preview', async function () {
        var r = await post('/api/admin/people/csv', { csv: ta.ctl.value, commit: false });
        out.replaceChildren.apply(out, [table(['Name', 'E-mail looks ok'], r.rows.map(function (x) { return [x.name || '', x.email_ok ? 'Yes' : 'No']; })),
          r.rows.length ? button('Confirm and add', async function () {
            var c = await post('/api/admin/people/csv', { csv: ta.ctl.value, commit: true });
            var lines = c.rows.filter(function (x) { return x.ok; }).map(function (x) { return x.id + ': ' + x.invite_code; }).join('\n');
            var bad = c.rows.filter(function (x) { return !x.ok; }).length;
            out.replaceChildren(h('p', { 'class': 'note warn', text: 'Shown once. ' + (c.rows.length - bad) + ' added, ' + bad + ' skipped. Copy the codes now.' }), h('textarea', { readonly: true, rows: 6, 'aria-label': 'Invite codes, shown once', text: lines }));
          }, 'primary') : null].filter(Boolean));
      }, null)), out];
    });
    return [reveal, peopleBox, teamsBox, csvBox];
  }

  function adminRates() {
    return [panel('Reward rates', async function (reload) {
      var rows = (await get('/api/admin/rate-card')).rows;
      var f = {
        type: field('Event type', { type: 'text', required: true, maxlength: 60 }), stage: field('Stage', { type: 'text', required: true, maxlength: 40 }),
        no: field('Stage number', { type: 'number', min: 1, max: 20, value: '1' }), cr: field(unitCap() + ' for one event', { type: 'number', min: 0, value: '0' }),
        cm: field('Monthly cap (0 = none)', { type: 'number', min: 0, value: '0' }), cd: field('Daily cap (0 = none)', { type: 'number', min: 0, value: '0' }),
        sn: selectField('Who confirms it', [['auto', 'Counts at once'], ['manager', 'A manager approves'], ['system', 'The source system confirms']]),
        md: selectField('Counts for', [['individual', 'The person'], ['team', 'The team'], ['both', 'Both']]),
        ro: field('Dice rolls', { type: 'number', min: 1, max: 6, value: '1' }), mv: field('Steps (steady mode)', { type: 'number', min: 0, max: 24, value: '1' }),
        from: field('Starts on (optional)', { type: 'date' }, 'Kinder changes start at once. Stricter ones start next month. Nothing applies backwards.'),
      };
      var tbl = rows.length ? table(['Event', 'Stage', 'No.', unitCap(), 'Month cap', 'Day cap', 'Confirmed by', 'Counts for', 'Rolls', 'Steps', 'Version', 'From', 'Until'], rows.map(function (r) {
        return [r.event_type, r.stage, String(r.stage_no), cur(r.credits), r.cap_month ? cur(r.cap_month) : '-', r.cap_day ? cur(r.cap_day) : '-', r.state_needed, r.mode, String(r.rolls), String(r.moves), 'v' + r.version, day(r.active_from), r.active_to ? day(r.active_to) : 'Current'];
      })) : empty('No rates yet.');
      var keys = ['type', 'stage', 'no', 'cr', 'cm', 'cd', 'sn', 'md', 'ro', 'mv', 'from'];
      return [tbl, h('h3', { text: 'Add or change a rate' }), form(async function () {
        var body = { event_type: f.type.ctl.value.trim(), stage: f.stage.ctl.value.trim(), stage_no: int(f.no.ctl.value), credits: int(f.cr.ctl.value), cap_month: int(f.cm.ctl.value), cap_day: int(f.cd.ctl.value), state_needed: f.sn.ctl.value, mode: f.md.ctl.value, rolls: int(f.ro.ctl.value), moves: int(f.mv.ctl.value) };
        if (f.from.ctl.value) body.active_from = dateMs(f.from.ctl.value);
        var r = await post('/api/admin/rate-card', body);
        toast('Saved as version ' + r.version + ', starting ' + day(r.active_from) + '.'); reload();
      }, keys.map(function (k) { return f[k].row; }), submitBtn('Save rate'))];
    })];
  }

  function adminTargets() {
    return [panel('Period targets', async function (reload) {
      var ts = (await get('/api/admin/targets')).targets;
      var f = {
        name: field('Name', { type: 'text', required: true, maxlength: 80 }), scope: selectField('For', [['person', 'Each person'], ['team', 'The team']]),
        period: selectField('Period', [['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['half', 'Half year'], ['year', 'Year']], 'month'),
        type: field('Event type', { type: 'text', required: true, maxlength: 60 }), stage: field('Stage', { type: 'text', required: true, maxlength: 40 }),
        tiers: field('Tiers', { tag: 'textarea', rows: 4, required: true }, 'One per line: count, bonus in ' + unitName() + '. Each tier needs more events and a higher bonus than the one before. Example: 5, 100'),
        sl: field('Streak length (optional)', { type: 'number', min: 2, max: 60 }), sb: field('Streak bonus', { type: 'number', min: 0 }), sf: field('Streak freezes per quarter', { type: 'number', min: 0, value: '1' }),
      };
      return [ts.length ? h('ul', { 'class': 'list' }, ts.map(function (t) {
        return h('li', null, h('b', { text: t.name }), h('span', { 'class': 'muted', text: ' | ' + human(t.scope) + ' | ' + t.period + ' | ' + t.event_type + ' - ' + t.stage }),
          h('ul', { 'class': 'small' }, t.tiers.map(function (x, i) { return h('li', null, 'Tier ' + (i + 1) + ': ' + x.count + ' events, bonus ', cur(x.bonus)); })),
          t.streak ? h('p', { 'class': 'small' }, 'Streak: ' + t.streak.length + ' periods in a row, bonus ', cur(t.streak.bonus), ', ' + t.streak.freeze_per_quarter + ' freeze per quarter') : null);
      })) : empty('No targets yet.'),
        h('h3', { text: 'Add a target' }), form(async function () {
          var tiers = f.tiers.ctl.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) { var p = l.split(/[,\s]+/); return { count: int(p[0]), bonus: int(p[1]) }; });
          var body = { name: f.name.ctl.value.trim(), scope: f.scope.ctl.value, period: f.period.ctl.value, event_type: f.type.ctl.value.trim(), stage: f.stage.ctl.value.trim(), tiers: tiers };
          if (f.sl.ctl.value) body.streak = { length: int(f.sl.ctl.value), bonus: int(f.sb.ctl.value), freeze_per_quarter: int(f.sf.ctl.value) };
          await post('/api/admin/targets', body); toast('Target added.'); reload();
        }, ['name', 'scope', 'period', 'type', 'stage', 'tiers', 'sl', 'sb', 'sf'].map(function (k) { return f[k].row; }), submitBtn('Add target'))];
    })];
  }

  function adminSeasons() {
    return [panel('Seasons', async function (reload) {
      var ss = (await get('/api/admin/seasons')).seasons;
      var nm = field('Name', { type: 'text', required: true, maxlength: 80 }), st = field('Starts', { type: 'date', required: true }, 'Rules are never changed under people, so pick a future start.'), en = field('Ends', { type: 'date', required: true });
      var bd = field('Budget (' + unitName() + ')', { type: 'number', min: 0, required: true }), md = selectField('Movement', [['steady', 'Steady'], ['dice', 'Dice']]);
      return [ss.length ? h('ul', { 'class': 'list' }, ss.map(function (x) {
        var acts = [];
        if (x.status === 'draft') acts.push(button('Publish', async function () { await post('/api/admin/seasons/' + x.id + '/publish', {}); toast('Published.'); reload(); }, 'small primary'));
        if (x.status === 'published') {
          acts.push(button('Raise budget', async function () {
            var v = await ask({ title: 'Raise the budget', message: 'The budget now is ' + curText(x.budget) + '. Type the new total in ' + unitName() + '. It can only go up.', label: 'New budget (' + unitName() + ')', required: true, ok: 'Raise' });
            if (v) { var okRaise = await ask({ title: 'Raise to ' + curText(int(v)) + '?', message: 'The new total budget will be ' + curText(int(v)) + '.', ok: 'Raise' }); if (!okRaise) return; }
            if (!v) return;
            await post('/api/admin/seasons/' + x.id + '/budget', { budget: int(v) }); toast('Budget raised. Waiting rewards are released.'); reload();
          }, 'small'));
          acts.push(button('Close season', async function () {
            var ok = await ask({ title: 'Close this season?', message: 'This settles the period first and cannot be undone.', ok: 'Close it' });
            if (!ok) return;
            await post('/api/admin/seasons/' + x.id + '/close', {}); toast('Season closed.'); reload();
          }, 'small'));
        }
        return h('li', null, h('b', { text: x.name }), ' ', statusChip(x.status), h('div', { 'class': 'muted small' }, day(x.starts_at) + ' to ' + day(x.ends_at) + ' | budget ', cur(x.budget), ' | ' + x.mode), acts.length ? h('div', { 'class': 'row' }, acts) : null);
      })) : empty('No seasons yet.'),
        h('h3', { text: 'Create a season' }), form(async function () {
          await post('/api/admin/seasons', { name: nm.ctl.value.trim(), starts_at: dateMs(st.ctl.value), ends_at: dateMs(en.ctl.value) + 86399000, budget: int(bd.ctl.value), mode: md.ctl.value });
          toast('Season saved as a draft.'); reload();
        }, nm.row, st.row, en.row, bd.row, md.row, submitBtn('Create draft'))];
    })];
  }

  function adminSimulate() {
    return [panel('Budget check', async function () {
      var rows = (await get('/api/admin/rate-card')).rows.filter(function (r) { return !r.active_to; });
      var pp = field('How many people', { type: 'number', min: 1, max: 100000, value: '10', required: true });
      var vols = rows.map(function (r) { return { key: r.event_type + ':' + r.stage, f: field(human(r.event_type) + ' - ' + r.stage + ' per person per month', { type: 'number', min: 0, value: '0' }) }; });
      var out = h('div', { 'aria-live': 'polite' });
      return [h('p', { 'class': 'muted', text: 'A worst-case estimate before you set a season budget.' }), form(async function () {
        var per = {}; vols.forEach(function (v) { per[v.key] = int(v.f.ctl.value); });
        var r = await post('/api/admin/simulate', { people: int(pp.ctl.value), per_person: per });
        out.replaceChildren(h('dl', { 'class': 'kv' },
          h('dt', { text: 'Worst case total' }), h('dd', null, cur(r.worstCase)),
          h('dt', { text: 'Per person' }), h('dd', null, cur(r.perHead)),
          h('dt', { text: 'Target bonuses, at most' }), h('dd', null, cur(r.tierMax)),
          h('dt', { text: 'Streak bonuses, at most' }), h('dd', null, cur(r.streakMax))));
      }, pp.row, vols.map(function (v) { return v.f.row; }), submitBtn('Work it out')), out];
    })];
  }

  function adminContent() {
    var notes = panel('Surprise notes', async function (reload) {
      var cards = (await get('/api/admin/notes')).cards;
      var tx = field('Note text', { type: 'text', required: true, maxlength: 240 }), ef = selectField('Gives', [['message', 'A message only'], ['points', 'Board points'], ['steps', 'Steps forward'], ['credits', unitCap()]]);
      var am = field('Amount', { type: 'number', min: 0, max: 1000, value: '0' }, 'Notes only ever give. Nothing is taken away.'), kd = selectField('Kind', [['note', 'Personal'], ['team', 'Team']]), od = field('Order', { type: 'number', min: 0, value: '0' });
      return [cards.length ? h('ul', { 'class': 'list' }, cards.map(function (c) { return h('li', null, c.text + ' (' + (c.effect === 'credits' ? unitName() : c.effect), c.effect === 'message' ? '' : (c.effect === 'credits' ? [' ', cur(c.amount)] : ' ' + c.amount), ')'); })) : empty('No notes yet.'),
        h('h3', { text: 'Add a note' }), form(async function () {
          await post('/api/admin/notes', { text: tx.ctl.value.trim(), effect: ef.ctl.value, amount: int(am.ctl.value), kind: kd.ctl.value, order_no: int(od.ctl.value) });
          toast('Note added.'); tx.ctl.value = ''; reload();
        }, tx.row, ef.row, am.row, kd.row, od.row, submitBtn('Add note'))];
    });
    var desks = panel('Milestone desks', async function () {
      var b = await get('/api/me/board'), ts = (await get('/api/admin/targets')).targets;
      var sq = selectField('Square', b.squares.filter(function (x) { return x.type === 'desk'; }).map(function (x) { return [x.idx, (x.idx + 1) + '. ' + x.name + ' (' + x.zone + ')']; }));
      var nm = field('Desk name', { type: 'text', required: true, maxlength: 80 });
      var tg = selectField('Linked target (optional)', [['', 'None']].concat(ts.map(function (t) { return [t.id, t.name]; })), '', 'Upgrades then need repeat target wins.');
      var pr = field('Price in board points', { type: 'number', min: 0, value: '200' }), fee = field('Thanks per visit (board points)', { type: 'number', min: 0, value: '20' });
      return [h('p', { 'class': 'muted', text: 'Desks are paid for with board points, never ' + unitName() + '. Visits are thanked from a company-funded pool.' }), form(async function () {
        await post('/api/admin/desks', { square_idx: int(sq.ctl.value), name: nm.ctl.value.trim(), target_id: tg.ctl.value || null, price_points: int(pr.ctl.value), base_fee: int(fee.ctl.value) });
        toast('Desk added.'); nm.ctl.value = '';
      }, sq.row, nm.row, tg.row, pr.row, fee.row, submitBtn('Add desk'))];
    });
    var pool = panel('Collaboration pool', async function () {
      var teams = (await get('/api/admin/teams')).teams;
      var tm = selectField('Team', teams.map(function (t) { return [t.id, t.name]; })), pt = field('Board points to add', { type: 'number', min: 0, max: 1000000, value: '500' });
      if (!teams.length) return empty('Add a team first.');
      return [h('p', { 'class': 'muted', text: 'The pool pays the thanks when teammates visit each other\'s desks. Board points only.' }), form(async function () {
        await post('/api/admin/pool', { team_id: tm.ctl.value, points: int(pt.ctl.value) }); toast('Pool topped up.');
      }, tm.row, pt.row, submitBtn('Add to pool'))];
    });
    var rules = panel('Penalty rules', async function () {
      var s = (await get('/api/admin/settings')).settings;
      var effs = [['steps_back', 'A few steps back'], ['points', 'A few board points'], ['lane', 'A friendly Catch-up Lane visit']];
      if (s.penalty_credit_loss) effs.push(['credits', unitCap() + ' (capped)']);
      var ty = field('Event type it applies to', { type: 'text', required: true, maxlength: 60 }), ef = selectField('Effect', effs), am = field('Amount', { type: 'number', min: 0, value: '1' });
      var pubId = field('Publish by rule id', { type: 'text' }, 'A rule only applies to events after it is published. Never backwards.');
      var listBox = h('ul', { 'class': 'list' });
      function drawList() {
        listBox.replaceChildren.apply(listBox, createdRules.map(function (r) {
          return h('li', null, h('b', null, human(r.event_type) + ': ', effectText(r.effect, r.amount)), h('div', { 'class': 'muted small', text: 'Rule ' + r.id + (r.published ? ' | published' : ' | draft') }),
            r.published ? null : button('Publish', async function () { await post('/api/admin/penalty-rules/' + r.id + '/publish', {}); r.published = true; toast('Published.'); drawList(); }, 'small primary'));
        }));
      }
      drawList();
      return [h('p', { 'class': 'muted', text: 'Rules created in this visit are listed below so you can publish them.' }), listBox, form(async function () {
        var r = await post('/api/admin/penalty-rules', { event_type: ty.ctl.value.trim(), effect: ef.ctl.value, amount: int(am.ctl.value) });
        createdRules.push({ id: r.id, event_type: ty.ctl.value.trim(), effect: ef.ctl.value, amount: int(am.ctl.value), published: false }); drawList(); toast('Rule saved as a draft.');
      }, ty.row, ef.row, am.row, submitBtn('Save rule')),
        h('h3', { text: 'Publish an older rule' }), form(async function () {
          await post('/api/admin/penalty-rules/' + encodeURIComponent(pubId.ctl.value.trim()) + '/publish', {}); toast('Published.'); pubId.ctl.value = '';
        }, pubId.row, submitBtn('Publish'))];
    });
    return [notes, desks, pool, rules];
  }

  function adminKeys() {
    return [panel('Connections for other systems', async function () {
      var sc = selectField('What it is for', SCOPES), lb = field('Label', { type: 'text', maxlength: 60, required: true }), out = h('div', { 'aria-live': 'polite' });
      var rid = field('Key id to switch off', { type: 'text' }), reid = field('Key id to re-issue', { type: 'text' }, 'Older keys made before secrets were stored sealed should be re-issued once. The old secret stops working at once.');
      return [h('p', { 'class': 'muted', text: 'Keys let your CRM, game server or Partner Circle widgets talk to this app. The secret is shown once.' }), form(async function () {
        var r = await post('/api/admin/keys', { scope: sc.ctl.value, label: lb.ctl.value.trim() });
        out.replaceChildren(h('div', { 'class': 'note warn', text: 'Shown once. Copy both now and keep them safe.' }), secretBox('Key id', r.key_id), secretBox('Secret', r.secret));
        lb.ctl.value = '';
      }, sc.row, lb.row, submitBtn('Create key')), out,
        h('h3', { text: 'Re-issue a key secret' }), form(async function () {
          var ok = await ask({ title: 'Re-issue this key?', message: 'A new secret is made and shown once. Systems using the old secret stop working.', ok: 'Re-issue' });
          if (!ok) return;
          var r = await post('/api/admin/keys/' + encodeURIComponent(reid.ctl.value.trim()) + '/reissue', {});
          out.replaceChildren(h('div', { 'class': 'note warn', text: 'Shown once. Copy it now and keep it safe.' }), secretBox('Key id', r.key_id), secretBox('New secret', r.secret)); reid.ctl.value = '';
        }, reid.row, submitBtn('Re-issue')),
        h('h3', { text: 'Switch a key off' }), form(async function () {
          var ok = await ask({ title: 'Switch this key off?', message: 'Systems using it stop working straight away.', ok: 'Switch off' });
          if (!ok) return;
          await post('/api/admin/keys/' + encodeURIComponent(rid.ctl.value.trim()) + '/revoke', {}); toast('Key switched off.'); rid.ctl.value = '';
        }, rid.row, submitBtn('Switch off'))];
    })];
  }

  function adminShop() {
    var items = panel('Catalogue', async function (reload) {
      var list = (await get('/api/shop/items')).items;
      var nm = field('Item name', { type: 'text', required: true, maxlength: 80 }), cr = field(unitCap() + ' it costs', { type: 'number', min: 1, required: true }), ap = checkField('Needs approval before it is delivered', true);
      return [list.length ? h('ul', { 'class': 'list' }, list.map(function (i) { return h('li', null, i.name + ' | ', cur(i.credits), i.needs_approval ? ' | needs approval' : ''); })) : empty('No items yet.'),
        h('h3', { text: 'Add an item' }), form(async function () {
          await post('/api/admin/items', { name: nm.ctl.value.trim(), credits: int(cr.ctl.value), needs_approval: ap.ctl.checked }); toast('Item added.'); reload();
        }, nm.row, cr.row, ap.row, submitBtn('Add item'))];
    });
    var orders = panel('Orders', async function (reload) {
      var names = {}, who = {};
      (await get('/api/shop/items')).items.forEach(function (i) { names[i.id] = i.name; });
      try { (await people()).forEach(function (p) { who[p.id] = p.name; }); } catch (e) { /* ids only */ }
      var o = (await get('/api/admin/orders')).orders;
      if (!o.length) return empty('No orders yet.');
      return h('ul', { 'class': 'list' }, o.map(function (x) {
        return h('li', null, h('b', { text: (names[x.item_id] || 'Item') + ' for ' + (who[x.person_id] || 'person ' + tail(x.person_id)) }), ' ', statusChip(x.state),
          h('div', { 'class': 'muted small' }, cur(x.credits), ' | ' + when(x.created_at)),
          x.state === 'reserved' ? h('div', { 'class': 'row' },
            button('Approve', async function () { await post('/api/admin/orders/' + x.id + '/decide', { accept: true }); toast('Approved.'); reload(); }, 'small primary'),
            button('Decline', async function () { await post('/api/admin/orders/' + x.id + '/decide', { accept: false }); toast('Declined. The ' + unitName() + ' are released.'); reload(); }, 'small')) : null);
      }));
    });
    var buy = panel('Buy ' + unitName(), async function () {
      var amt = field('How many ' + unitName() + ' to buy', { type: 'number', min: 100, max: 10000000, required: true, value: '1000' }, 'At least 100. This starts a purchase with the credit provider. This product itself never takes or moves money.');
      var prev = h('p', { 'aria-live': 'polite' }), res = h('div', { 'aria-live': 'polite' });
      function showPrice() { var n = int(amt.ctl.value); prev.replaceChildren(); if (n > 0) prev.appendChild(cur(n)); }
      amt.ctl.addEventListener('input', showPrice); showPrice();
      return [form(async function () {
        var n = int(amt.ctl.value);
        var ok = await ask({ title: 'Start this purchase?', message: curText(n) + '. You will finish payment with the credit provider, not here.', ok: 'Start purchase' });
        if (!ok) return;
        var r = await post('/api/admin/buy', { credits: n, request_id: 'ui-' + Date.now() });
        var o = Object.assign({}, r); delete o.ok;
        res.replaceChildren(h('div', { 'class': 'note' }, h('b', { text: 'Purchase started.' }), kv(o)));
        if (typeof r.url === 'string' && /^https:\/\//i.test(r.url)) res.appendChild(h('p', null, h('a', { href: r.url, rel: 'noopener noreferrer', target: '_blank', text: 'Open the provider page to finish' })));
      }, amt.row, prev, submitBtn('Start purchase')), res];
    });
    return [items, orders, buy];
  }

  // What a person sees before accepting a machine request: the operation in words, whether it can move money, every field it carries, the expiry, the key.
  var OP_LABEL = {
    'event.submit': 'Record a work event', 'event.approve': 'Approve an event', 'event.reject': 'Reject an event', 'reward.award': 'Award a reward',
    'reward.reverse': 'Reverse a reward', 'ratecard.change': 'Change a reward rate', 'target.change': 'Change a target', 'penalty.propose': 'Propose a board penalty', 'penalty.rule.change': 'Change a penalty rule',
  };
  function opLabel(op) { return OP_LABEL[op] || human(String(op || 'request').replace(/\./g, ' ')); }
  function isInterrupted(x) { return x.state === 'approved' && !!x.result && x.result.state === 'running'; }
  /** Every payload field, one line each. Text goes in as text. Money amounts show the unit and the real price. Nothing is printed for a field that is not there. */
  function payloadList(x) {
    var p = x.payload && typeof x.payload === 'object' && !Array.isArray(x.payload) ? x.payload : {}, dl = h('dl', { 'class': 'kv' }), n = 0;
    Object.keys(p).forEach(function (k) {
      var v = p[k], val;
      if (v === null || v === void 0 || v === '') return;
      if (k === 'person_id') val = 'Person ' + tail(v);
      else if (k === 'credits' || k === 'bonus' || (k === 'amount' && /^reward\./.test(String(x.op)))) val = typeof v === 'number' ? cur(v) : String(v);
      else if (k === 'amount' && /^penalty\./.test(String(x.op))) val = effectText(p.effect, v);
      else if (typeof v === 'object') val = JSON.stringify(v);
      else val = String(v);
      dl.appendChild(h('dt', { text: k === 'person_id' ? 'Who' : k === 'ext_id' ? 'Reference' : human(k) }));
      dl.appendChild(h('dd', null, val));
      n += 1;
    });
    return n ? dl : h('p', { 'class': 'muted small', text: 'No details were sent with this request.' });
  }

  function adminAi() {
    var intro = card(null, h('p', { 'class': 'muted', text: 'AI access lets approved people use an AI helper through keys held by your company. Keys never show their secrets here. Switching AI off stops all use at once.' }));
    var master = panel('AI for this company', async function (reload) {
      var st = null;
      try { st = await get('/api/admin/ai/status'); } catch (e) { st = null; }
      var on = st && (st.enabled === true || st.ai_enabled === true);
      return [h('p', null, 'AI is currently ', chip(st ? (on ? 'On' : 'Off') : 'Unknown', on ? 'good' : 'warn'), '.'),
        h('div', { 'class': 'row' },
          button('Switch AI on', async function () { await post('/api/admin/ai/toggle', { enabled: true }); toast('AI is on.'); reload(); }, 'small primary'),
          button('Switch AI off', async function () {
            var ok = await ask({ title: 'Switch AI off for everyone?', message: 'All AI keys stop working for your company until you switch it on again.', ok: 'Switch off' });
            if (!ok) return;
            await post('/api/admin/ai/toggle', { enabled: false }); toast('AI is off.'); reload();
          }, 'small'))];
    });
    var keys = panel('Keys and their class', async function () {
      var ks = (await get('/api/admin/keys')).keys.filter(function (k) { return k.class || k.key_class || /ai/i.test(String(k.scope)); });
      if (!ks.length) return empty('No AI keys yet.');
      return h('ul', { 'class': 'list' }, ks.map(function (k) {
        return h('li', null, h('b', { text: k.label || k.key_id }), ' ', chip('Class: ' + (k.class || k.key_class || human(k.scope)), ''), ' ', chip(human(k.status || 'unknown'), k.status === 'active' ? 'good' : 'warn'),
          h('div', { 'class': 'muted small', text: 'Key ' + tail(k.key_id) + ' | ' + when(k.created_at) }));
      }));
    });
    var reqs = panel('Requests waiting', async function (reload) {
      var r;
      try { r = (await get('/api/admin/ai-requests')).requests; } catch (e) { return empty('AI requests are not available yet.'); }
      var pend = (r || []).filter(function (x) { return !x.state || x.state === 'pending' || x.state === 'open' || isInterrupted(x); });
      if (!pend.length) return empty('No requests waiting.');
      return h('ul', { 'class': 'list' }, pend.map(function (x) {
        var interrupted = isInterrupted(x), money = x.money_op === true;
        var decide = function (accept) {
          return async function () { await post('/api/admin/ai-requests/' + encodeURIComponent(x.id) + '/decide', { accept: accept }); toast(accept ? (interrupted ? 'Finished.' : 'Accepted.') : 'Rejected.'); reload(); };
        };
        var acceptBtn = button(interrupted ? 'Finish it' : 'Accept', async function () {
          var ok = await ask({ title: (interrupted ? 'Finish: ' : 'Accept: ') + opLabel(x.op) + '?', message: (money ? 'This can move ' + unitName() + ' once it goes through the normal checks. ' : 'This only records your approval. ') + 'Key class ' + (x.class || 'unknown') + (x.expires_at ? ', expires ' + when(x.expires_at) : '') + '.', ok: interrupted ? 'Finish' : 'Accept' });
          if (ok) await decide(true)();
        }, 'small primary');
        return h('li', null,
          h('b', { text: opLabel(x.op) }), ' ', chip(x.op || 'unknown', ''), ' ',
          chip(money ? 'Can move ' + unitName() : 'Does not move ' + unitName(), money ? 'bad' : 'good'), ' ',
          chip('Key class: ' + (x.class || x.key_class || 'unknown'), 'warn'), interrupted ? [' ', chip('Run interrupted', 'warn')] : null,
          h('div', { 'class': 'muted small', text: 'Key ' + (x.key_id ? tail(x.key_id) : '-') + ' | asked ' + when(x.created_at) + ' | expires ' + (x.expires_at ? when(x.expires_at) : 'never') }),
          payloadList(x),
          x.reason || x.note ? h('p', { 'class': 'small' }, h('b', { text: 'Reason given: ' }), x.reason || x.note) : null,
          h('div', { 'class': 'row' }, acceptBtn, interrupted ? null : button('Reject', decide(false), 'small')));
      }));
    });
    return [intro, master, keys, reqs];
  }

  function adminRun() {
    var out = h('div', { 'aria-live': 'polite' });
    var force = checkField('Settle even if the period is not over (use with care)', false);
    function show(title, r) { var o = Object.assign({}, r); delete o.ok; out.replaceChildren(h('h3', { text: title }), kv(o)); }
    return [card('Run now', h('p', { 'class': 'muted', text: 'Sends queued rewards, releases waiting ones, applies approved items and due notices, and settles finished periods. Safe to run again.' }),
      h('div', { 'class': 'row' }, button('Run now', async function () { show('Run finished', await post('/api/admin/tick', {})); toast('Done.'); }, 'primary')),
      h('h3', { text: 'Settle periods' }), force.row,
      h('div', { 'class': 'row' }, button('Settle', async function () { show('Settled', await post('/api/admin/settle', { force: force.ctl.checked })); toast('Done.'); })), out)];
  }

  // ---------- router ----------
  var routeSeq = 0;
  async function route(keep) {
    var seq = ++routeSeq;
    if (!S.me) { viewLogin(); renderFoot(); return; }
    var c = S.me.consents;
    if (!c.employee_notice || !c.penalty_rules) { viewConsent(); renderFoot(); return; }
    var parts = (location.hash || '#/').replace(/^#\/?/, '').split('/'), name = parts[0] || '', r = role();
    var allowed = { team: ['manager', 'admin'], hr: ['hr', 'admin'], admin: ['admin'] }[name];
    renderTop(name); demoBanner(); renderFoot();
    var main = $('#main');
    if (allowed && allowed.indexOf(r) < 0) { main.replaceChildren(h('div', { 'class': 'card' }, h('h1', { text: 'Not for your role' }), h('p', { text: 'This page is for someone else on the team.' }), h('a', { href: '#/', text: 'Back to my board' }))); return; }
    if (!keep) main.replaceChildren(h('p', { 'class': 'muted pad', text: 'Loading...' }));
    try {
      var views = { '': viewBoard, progress: viewProgress, shop: viewShop, profile: viewProfile, league: viewLeague, team: viewTeam, hr: viewHr, admin: viewAdmin };
      var nodes = await (views[name] || viewBoard)(parts);
      if (seq !== routeSeq) return;
      main.replaceChildren();
      append(main, [nodes]);
    } catch (e) {
      if (seq !== routeSeq) return;
      main.replaceChildren(h('div', { 'class': 'card' }, h('p', { 'class': 'err', role: 'alert', text: e.message })));
    }
    if (!keep) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
  }
  function refresh() { var y = window.scrollY; route(true).then(function () { window.scrollTo(0, y); }); }

  async function boot() {
    if (!S.cfg) { try { S.cfg = await get('/api/config'); } catch (e) { S.cfg = null; } }
    try { S.me = await get('/api/me'); } catch (e) { S.me = null; }
    route();
  }

  window.addEventListener('hashchange', function () { route(); });
  $('#toast-x').addEventListener('click', function () { $('#toast').hidden = true; });
  boot();
})();
