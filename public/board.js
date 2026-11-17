/* The ring board, drawn as SVG. Own layout, own colours, own token art. No data is ever put in markup strings. */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  function s(tag, attrs, kids) {
    var e = document.createElementNS(NS, tag), k;
    if (attrs) for (k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) e.appendChild(kids[i]);
    return e;
  }
  function txt(tag, attrs, text) { var e = s(tag, attrs); e.textContent = text; return e; }

  var ZONE_COUNT = 6;
  var HEX_R = 330;                       // corner radius of the hexagonal track
  var APO = HEX_R * Math.cos(Math.PI / 6); // distance from the middle to the middle of a side
  var TILE = 68;                         // each square is a soft 68 x 68 tile

  /**
   * 24 squares on a hexagonal track, 6 sides of 4 (one zone per side), clockwise from just right of the top corner.
   * Tiles are spread by angle, so they sit evenly with the corners of the track falling between zones. No centre box.
   */
  function cellXY(i) {
    var deg = -90 + (i + 0.5) * 15;
    var phi = ((((deg + 90) % 60) + 60) % 60) - 30;
    var r = APO / Math.cos(phi * Math.PI / 180);
    var a = deg * Math.PI / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  }
  function hexPath() {
    var pts = [];
    for (var k = 0; k < 6; k++) { var a = (-90 + 60 * k) * Math.PI / 180; pts.push((HEX_R * Math.cos(a)).toFixed(1) + ' ' + (HEX_R * Math.sin(a)).toFixed(1)); }
    return 'M' + pts.join(' L') + ' Z';
  }
  /** Split a title over two lines when it is long, for the round badge. */
  function twoLines(t) {
    t = String(t || '');
    if (t.length <= 15) return [t];
    var mid = t.lastIndexOf(' ', 15);
    if (mid < 4) return [t.slice(0, 15), t.slice(15, 30)];
    return [t.slice(0, mid), t.slice(mid + 1, mid + 17)];
  }

  /** Small flat icons for each square type, drawn round 0,0 in about 36 units. */
  function icon(type) {
    var g = s('g', { 'class': 'ic' });
    var p = function (d) { g.appendChild(s('path', { d: d })); };
    if (type === 'start') { p('M-9 -15 V15'); p('M-9 -15 H11 L5 -8 L11 -1 H-9'); }
    else if (type === 'desk') { g.appendChild(s('rect', { x: -15, y: -7, width: 30, height: 10, rx: 3 })); p('M-11 3 V14 M11 3 V14'); }
    else if (type === 'note') { g.appendChild(s('rect', { x: -15, y: -10, width: 30, height: 20, rx: 3 })); p('M-15 -10 L0 3 L15 -10'); }
    else if (type === 'lane') { p('M-11 -11 L-1 0 L-11 11'); p('M3 -11 L13 0 L3 11'); }
    else if (type === 'rest') { g.appendChild(s('rect', { x: -15, y: 1, width: 30, height: 7, rx: 3 })); p('M-12 -10 H12 V1 M-12 -10 V1 M-11 8 V14 M11 8 V14'); }
    else if (type === 'hub') {
      p('M-11 7 L11 7 L0 -10 Z');
      [[-11, 7], [11, 7], [0, -10]].forEach(function (c) { g.appendChild(s('circle', { cx: c[0], cy: c[1], r: 4.5, 'class': 'tk-w' })); });
    } else { p('M0 -15 L4.5 -4.5 L15 -3.5 L7 4 L9.5 14.5 L0 9 L-9.5 14.5 L-7 4 L-15 -3.5 L-4.5 -4.5 Z'); }
    return g;
  }

  /** Own token art. Each is a few flat shapes inside a 40 x 40 box centred on 0,0. */
  function art(name) {
    var g = s('g', { 'class': 'tok-' + name });
    var A = function (tag, a, cls) { a['class'] = cls; g.appendChild(s(tag, a)); };
    if (name === 'mug') {
      A('path', { d: 'M10 -6 H15 A6 6 0 0 1 15 8 H10' }, 'tk-l');
      A('rect', { x: -14, y: -10, width: 24, height: 26, rx: 5 }, 'tk-a');
      A('rect', { x: -14, y: -10, width: 24, height: 8, rx: 4 }, 'tk-b');
      A('path', { d: 'M-6 -14 q3 -3 0 -6 M2 -14 q3 -3 0 -6' }, 'tk-l');
    } else if (name === 'plant') {
      A('path', { d: 'M0 4 C-14 0 -16 -12 -6 -16 C-4 -6 -2 -2 0 4 Z' }, 'tk-a');
      A('path', { d: 'M0 4 C14 0 16 -12 6 -16 C4 -6 2 -2 0 4 Z' }, 'tk-a');
      A('path', { d: 'M0 4 C-5 -6 -3 -14 0 -20 C3 -14 5 -6 0 4 Z' }, 'tk-a');
      A('path', { d: 'M-11 4 H11 L8 18 H-8 Z' }, 'tk-b');
    } else if (name === 'rocket') {
      A('path', { d: 'M-6 6 L-14 16 L-6 12 Z' }, 'tk-b');
      A('path', { d: 'M6 6 L14 16 L6 12 Z' }, 'tk-b');
      A('path', { d: 'M0 -20 C10 -9 10 5 6 12 H-6 C-10 5 -10 -9 0 -20 Z' }, 'tk-a');
      A('circle', { cx: 0, cy: -5, r: 4.5 }, 'tk-w');
      A('path', { d: 'M-3 14 L0 20 L3 14 Z' }, 'tk-b');
    } else if (name === 'lamp') {
      A('rect', { x: -1.5, y: -4, width: 3, height: 20 }, 'tk-l');
      A('rect', { x: -10, y: 14, width: 20, height: 5, rx: 2.5 }, 'tk-b');
      A('path', { d: 'M-13 -4 L-6 -19 H6 L13 -4 Z' }, 'tk-a');
    } else { // badge
      A('rect', { x: -13, y: -18, width: 26, height: 36, rx: 6 }, 'tk-a');
      A('rect', { x: -5, y: -14, width: 10, height: 4, rx: 2 }, 'tk-w');
      A('circle', { cx: 0, cy: -1, r: 7 }, 'tk-b');
      A('rect', { x: -8, y: 10, width: 16, height: 3, rx: 1.5 }, 'tk-w');
    }
    return g;
  }

  /** A stand-alone token icon (for the picker and lists). */
  function tokenSvg(name, label) {
    var svg = s('svg', { viewBox: '-24 -24 48 48', role: label ? 'img' : 'presentation', 'aria-hidden': label ? 'false' : 'true', focusable: 'false' });
    if (label) svg.setAttribute('aria-label', label);
    svg.appendChild(art(name));
    return svg;
  }

  /** Our own small coin: a round gold disc with a soft zig-zag mark. Decorative; the unit name is always written next to it. */
  function coinSvg() {
    var svg = s('svg', { viewBox: '-10 -10 20 20', 'class': 'coin', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(s('circle', { cx: 0, cy: 0, r: 8.6, 'class': 'o' }));
    svg.appendChild(s('path', { d: 'M-4.2 4 V-3.6 L0 1.2 L4.2 -3.6 V4' }));
    return svg;
  }

  var SLOTS =[[-18, 2], [0, 2], [18, 2], [-18, 20], [0, 20], [18, 20], [-9, -15], [9, -15]];

  /**
   * draw(host, opts)
   *   squares: [{idx,type,name,zone}]
   *   tokens:  [{id,name,avatar,position,me}]
   *   zones:   zone names (optional, for the key)
   *   center:  {title, sub}
   */
  function draw(host, opts) {
    var squares = opts.squares || [];
    var svg = s('svg', { viewBox: '-325 -372 650 744', role: 'img', focusable: 'false' });
    var who = (opts.tokens || []).map(function (t) { return t.name + ' on ' + ((squares[t.position] || {}).name || 'square ' + (t.position + 1)); });
    svg.setAttribute('aria-label', 'Board with 24 squares on a six-sided track. ' + who.join('. '));
    // The track: a soft hexagonal band under the tiles, and a round badge in the middle (no box).
    svg.appendChild(s('path', { d: hexPath(), 'class': 'track' }));
    svg.appendChild(s('circle', { cx: 0, cy: 0, r: 150, 'class': 'badge' }));
    var c = opts.center || {};
    var lines = [];
    twoLines(c.title).forEach(function (t) { if (t) lines.push([t, 'ctr1']); });
    if (c.sub) lines.push([String(c.sub).slice(0, 26), 'ctr2']);
    if (c.extra) lines.push([String(c.extra).slice(0, 26), 'ctr2']);
    var y0 = -((lines.length - 1) * 19);
    lines.forEach(function (ln, i) { svg.appendChild(txt('text', { x: 0, y: y0 + i * 38 + 8, 'text-anchor': 'middle', 'class': ln[1] }, ln[0])); });

    var perSquare = {};
    (opts.tokens || []).forEach(function (t) { (perSquare[t.position] = perSquare[t.position] || []).push(t); });

    squares.forEach(function (sq) {
      var xy = cellXY(sq.idx), x = xy[0], y = xy[1], h2 = TILE / 2;
      var zone = Math.floor(sq.idx / 4) % ZONE_COUNT;
      var g = s('g', {}, []);
      g.appendChild(txt('title', {}, (sq.idx + 1) + '. ' + sq.name + ' (' + sq.zone + ')'));
      g.appendChild(s('rect', { x: x - h2, y: y - h2, width: TILE, height: TILE, rx: 20, 'class': 'sq z' + zone + ' t-' + sq.type }));
      var n = (perSquare[sq.idx] || []).length;
      if (n < 4) {
        var ic = icon(sq.type);
        ic.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + (y + (n ? -12 : -4)).toFixed(1) + ') scale(' + (n ? 0.5 : 0.8) + ')');
        g.appendChild(ic);
      }
      g.appendChild(txt('text', { x: (x - 20).toFixed(1), y: (y + 27).toFixed(1), 'text-anchor': 'middle', 'class': 'sqn' }, String(sq.idx + 1)));
      svg.appendChild(g);
    });

    Object.keys(perSquare).forEach(function (pos) {
      var xy = cellXY(Number(pos)), list = perSquare[pos];
      var many = list.length > 1, scale = list.length > 3 ? 0.36 : many ? 0.46 : 0.66;
      list.slice(0, 8).forEach(function (t, i) {
        var o = many ? SLOTS[i] : [0, 9];
        var tx = xy[0] + o[0], ty = xy[1] + o[1];
        var g = s('g', { transform: 'translate(' + tx.toFixed(1) + ' ' + ty.toFixed(1) + ') scale(' + scale + ')' });
        g.appendChild(txt('title', {}, t.name));
        if (t.me) g.appendChild(s('circle', { cx: 0, cy: 0, r: 25, 'class': 'mering' }));
        g.appendChild(art(t.avatar || 'badge'));
        svg.appendChild(g);
      });
    });
    host.replaceChildren(svg);
    return svg;
  }

  window.Board = { draw: draw, tokenSvg: tokenSvg, coinSvg: coinSvg, cellXY: cellXY };
})();
