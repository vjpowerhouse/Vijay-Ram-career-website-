/* Small SVG chart helpers. Colors come from CSS classes (style.css), so light and dark
   mode both work, and no style attributes are needed under the page's security policy. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = v => (root.MLAgent ? root.MLAgent.fmt(v) : String(v));

  function niceTicks(lo, hi, count) {
    if (!(hi > lo)) { hi = lo + 1; }
    const span = hi - lo, step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || step0;
    const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
    return ticks;
  }
  function widthOf(el) { return Math.max(300, Math.min(900, (el && el.clientWidth) || 600)); }
  function svg(w, h, label, body) {
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' + body + '</svg>';
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // Horizontal bars: magnitude comparison across named items.
  function hbar(el, items, opt) {
    opt = opt || {};
    const W = opt.width || widthOf(el), rowH = 28, top = 8, bottom = 26;
    const labelChars = Math.min(28, Math.max(...items.map(i => String(i.label).length), 4));
    const left = Math.min(W * 0.42, 14 + labelChars * 7), right = 64;
    const H = top + items.length * rowH + bottom;
    const lo = opt.min !== undefined ? opt.min : Math.min(0, ...items.map(i => i.value));
    let hi = opt.max !== undefined ? opt.max : Math.max(...items.map(i => i.value), opt.ref ? opt.ref.value : 0);
    if (!(hi > lo)) hi = lo + 1;
    const x = v => left + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (W - left - right);
    let b = '';
    for (const t of niceTicks(lo, hi, 4)) if (t >= lo && t <= hi) {
      b += '<line class="gridline" x1="' + x(t) + '" x2="' + x(t) + '" y1="' + top + '" y2="' + (H - bottom) + '"/>';
      b += '<text x="' + x(t) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(opt.tickFmt ? opt.tickFmt(t) : fmt(t)) + '</text>';
    }
    items.forEach((it, i) => {
      const y = top + i * rowH;
      const x0 = x(Math.max(lo, 0)), x1 = x(it.value);
      const bx = Math.min(x0, x1), bw = Math.max(1.5, Math.abs(x1 - x0));
      const tip = it.tip || it.label + ': ' + (it.text || fmt(it.value));
      b += '<g data-tip="' + esc(tip) + '">';
      b += '<rect class="hit" x="0" y="' + y + '" width="' + W + '" height="' + rowH + '"/>';
      b += '<text x="' + (left - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end"' + (it.cls && it.cls.indexOf('hi') >= 0 ? ' class="lbl-strong"' : '') + '>' + esc(trunc(it.label, labelChars)) + '</text>';
      b += '<rect class="bar ' + (it.cls || '') + '" x="' + bx + '" y="' + (y + 6) + '" width="' + bw + '" height="' + (rowH - 12) + '" rx="3"/>';
      b += '<text x="' + (Math.max(x0, x1) + 6) + '" y="' + (y + rowH / 2 + 4) + '"' + (it.cls && it.cls.indexOf('hi') >= 0 ? ' class="lbl-strong"' : '') + '>' + esc(it.text || fmt(it.value)) + '</text>';
      b += '</g>';
    });
    b += '<line class="axis" x1="' + x(Math.max(lo, 0)) + '" x2="' + x(Math.max(lo, 0)) + '" y1="' + top + '" y2="' + (H - bottom) + '"/>';
    if (opt.ref) {
      b += '<line class="ref" x1="' + x(opt.ref.value) + '" x2="' + x(opt.ref.value) + '" y1="' + (top - 4) + '" y2="' + (H - bottom) + '"/>';
    }
    el.innerHTML = svg(W, H, opt.label || 'Bar chart', b);
  }

  const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross', 'ring'];
  function marker(shape, cx, cy, r, cls) {
    const c = ' class="' + cls + '"';
    switch (shape) {
      case 'square': return '<rect' + c + ' x="' + (cx - r) + '" y="' + (cy - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" rx="1"/>';
      case 'triangle': return '<path' + c + ' d="M' + cx + ' ' + (cy - r * 1.2) + 'L' + (cx + r * 1.1) + ' ' + (cy + r * 0.8) + 'L' + (cx - r * 1.1) + ' ' + (cy + r * 0.8) + 'Z"/>';
      case 'diamond': return '<path' + c + ' d="M' + cx + ' ' + (cy - r * 1.3) + 'L' + (cx + r * 1.3) + ' ' + cy + 'L' + cx + ' ' + (cy + r * 1.3) + 'L' + (cx - r * 1.3) + ' ' + cy + 'Z"/>';
      case 'cross': return '<path' + c + ' d="M' + (cx - r) + ' ' + (cy - r / 3) + 'h' + (r * 2 / 3) + 'v' + (-r * 2 / 3) + 'h' + (r * 2 / 3) + 'v' + (r * 2 / 3) + 'h' + (r * 2 / 3) + 'v' + (r * 2 / 3) + 'h' + (-r * 2 / 3) + 'v' + (r * 2 / 3) + 'h' + (-r * 2 / 3) + 'v' + (-r * 2 / 3) + 'h' + (-r * 2 / 3) + 'Z"/>';
      case 'ring': return '<circle' + c + ' cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill-opacity=".35"/>';
      default: return '<circle' + c + ' cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>';
    }
  }
  function legend(items) {
    return '<ul class="legend">' + items.map(it =>
      '<li><svg viewBox="0 0 12 12" aria-hidden="true" class="chart">' + marker(it.shape || 'circle', 6, 6, 4.5, it.cls) + '</svg>' + esc(it.label) + '</li>').join('') + '</ul>';
  }

  // Scatter: relationship between two numbers. Optional y = x diagonal for predicted vs actual.
  function scatter(el, pts, opt) {
    opt = opt || {};
    const W = widthOf(el), H = Math.round(Math.min(420, W * 0.62)), L = 56, R = 14, T = 12, B = 42;
    let xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    let xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
    if (opt.diagonal) { xlo = ylo = Math.min(xlo, ylo); xhi = yhi = Math.max(xhi, yhi); }
    const pad = (a, b) => { const d = (b - a) || 1; return [a - d * 0.05, b + d * 0.05]; };
    [xlo, xhi] = pad(xlo, xhi); [ylo, yhi] = pad(ylo, yhi);
    const sx = v => L + (v - xlo) / (xhi - xlo) * (W - L - R);
    const sy = v => H - B - (v - ylo) / (yhi - ylo) * (H - T - B);
    let b = '';
    for (const t of niceTicks(ylo, yhi, 5)) if (t >= ylo && t <= yhi) b += '<line class="gridline" x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(t) + '" y2="' + sy(t) + '"/><text x="' + (L - 6) + '" y="' + (sy(t) + 4) + '" text-anchor="end">' + esc(fmt(t)) + '</text>';
    for (const t of niceTicks(xlo, xhi, 5)) if (t >= xlo && t <= xhi) b += '<text x="' + sx(t) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + esc(fmt(t)) + '</text>';
    b += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>';
    if (opt.diagonal) b += '<line class="diag" x1="' + sx(xlo) + '" y1="' + sy(xlo) + '" x2="' + sx(xhi) + '" y2="' + sy(xhi) + '"/>';
    const r = pts.length > 800 ? 3 : 4.5;
    for (const p of pts) b += '<g data-tip="' + esc(p.tip || '') + '">' + marker(p.shape || 'circle', sx(p.x), sy(p.y), r, p.cls || 'dot') + '</g>';
    if (opt.xLabel) b += '<text class="lbl-strong" x="' + ((L + W - R) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(opt.xLabel) + '</text>';
    if (opt.yLabel) b += '<text class="lbl-strong" transform="translate(14 ' + ((T + H - B) / 2) + ') rotate(-90)" text-anchor="middle">' + esc(opt.yLabel) + '</text>';
    el.innerHTML = svg(W, H, opt.label || 'Scatter plot', b);
  }

  // Lines over an ordered x (levels, k values). Shared y-axis when yDomain is given.
  function lines(el, series, opt) {
    opt = opt || {};
    const W = opt.width || widthOf(el), H = opt.height || Math.round(Math.min(300, W * 0.55)), L = 52, R = 16, T = 14, B = 40;
    const all = series.reduce((a, s) => a.concat(s.points), []);
    const xs = all.map(p => p.x);
    let [ylo, yhi] = opt.yDomain || [Math.min(...all.map(p => p.y)), Math.max(...all.map(p => p.y))];
    const d = (yhi - ylo) || 1; ylo -= d * 0.08; yhi += d * 0.08;
    const xlo = Math.min(...xs), xhi = Math.max(...xs);
    const sx = v => (xhi === xlo ? (L + W - R) / 2 : L + 12 + (v - xlo) / (xhi - xlo) * (W - L - R - 24));
    const sy = v => H - B - (v - ylo) / (yhi - ylo) * (H - T - B);
    let b = '';
    for (const t of niceTicks(ylo, yhi, 4)) if (t >= ylo && t <= yhi) b += '<line class="gridline" x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(t) + '" y2="' + sy(t) + '"/><text x="' + (L - 6) + '" y="' + (sy(t) + 4) + '" text-anchor="end">' + esc(fmt(t)) + '</text>';
    const xt = opt.xTicks || Array.from(new Set(xs)).sort((a, c) => a - c);
    const xLab = opt.xTickFmt || fmt;
    for (const t of xt) b += '<text x="' + sx(t) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + esc(xLab(t)) + '</text>';
    b += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>';
    series.forEach((s, si) => {
      const cls = s.cls || (si ? 's2' : '');
      b += '<path class="line ' + cls + '" d="' + s.points.map((p, i) => (i ? 'L' : 'M') + sx(p.x) + ' ' + sy(p.y)).join('') + '"/>';
      for (const p of s.points) b += '<g data-tip="' + esc(p.tip || (s.name ? s.name + ': ' : '') + fmt(p.y)) + '"><circle class="hit" cx="' + sx(p.x) + '" cy="' + sy(p.y) + '" r="12"/><circle class="pt ' + cls + '" cx="' + sx(p.x) + '" cy="' + sy(p.y) + '" r="' + (p.big ? 6.5 : 4.5) + '"/></g>';
    });
    if (opt.xLabel) b += '<text class="lbl-strong" x="' + ((L + W - R) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(opt.xLabel) + '</text>';
    if (opt.yLabel) b += '<text class="lbl-strong" transform="translate(13 ' + ((T + H - B) / 2) + ') rotate(-90)" text-anchor="middle">' + esc(opt.yLabel) + '</text>';
    el.innerHTML = svg(W, H, opt.label || 'Line chart', b);
  }

  // Confusion matrix: one steel hue, darker = more rows.
  function confusion(el, cm, classes) {
    const K = classes.length, W = widthOf(el);
    const lab = Math.min(110, 20 + Math.max(...classes.map(c => String(c).length)) * 7);
    const cell = Math.min(80, (W - lab - 30) / K), T = 30, H = T + cell * K + 30;
    const max = Math.max(1, ...cm.map(r => Math.max(...r)));
    let b = '<text class="lbl-strong" x="' + (lab + cell * K / 2) + '" y="14" text-anchor="middle">Predicted</text>';
    classes.forEach((c, j) => { b += '<text x="' + (lab + cell * j + cell / 2) + '" y="' + (T - 4) + '" text-anchor="middle">' + esc(trunc(c, 10)) + '</text>'; });
    cm.forEach((row, i) => {
      b += '<text x="' + (lab - 8) + '" y="' + (T + cell * i + cell / 2 + 4) + '" text-anchor="end">' + esc(trunc(classes[i], 14)) + '</text>';
      const tot = row.reduce((a, c) => a + c, 0) || 1;
      row.forEach((v, j) => {
        const op = 0.08 + 0.85 * v / max;
        b += '<g data-tip="' + esc('Actual ' + classes[i] + ', predicted ' + classes[j] + ': ' + v + ' rows (' + Math.round(100 * v / tot) + '% of actual ' + classes[i] + ')') + '">';
        b += '<rect class="cm" x="' + (lab + cell * j + 1) + '" y="' + (T + cell * i + 1) + '" width="' + (cell - 2) + '" height="' + (cell - 2) + '" rx="3" fill-opacity="' + op.toFixed(3) + '"/>';
        b += '<text class="cm-text' + (op > 0.55 ? ' inv' : '') + '" x="' + (lab + cell * j + cell / 2) + '" y="' + (T + cell * i + cell / 2 + 4) + '" text-anchor="middle">' + v + '</text></g>';
      });
    });
    b += '<text class="lbl-strong" transform="translate(10 ' + (T + cell * K / 2) + ') rotate(-90)" text-anchor="middle">Actual</text>';
    el.innerHTML = svg(Math.max(W, lab + cell * K + 10), H, 'Confusion matrix', b);
  }

  // One shared tooltip for every [data-tip] element on the page.
  function bindTips(tip) {
    const show = (e, text) => {
      tip.textContent = text; tip.hidden = false;
      const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
      tip.style.left = Math.max(4, x) + 'px'; tip.style.top = Math.max(4, y) + 'px';
    };
    document.addEventListener('pointermove', e => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && t.getAttribute('data-tip')) show(e, t.getAttribute('data-tip')); else tip.hidden = true;
    });
    document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
  }

  function wrap(text, max) {
    const words = String(text).split(' '), out = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > max && line) { out.push(line); line = w; } else line = (line + ' ' + w).trim();
    }
    if (line) out.push(line);
    return out.slice(0, 3).map((l, i, a) => (i === 2 && a.length === 3 && out.length > 3 ? trunc(l, max - 1) + '…' : trunc(l, max)));
  }

  /* Decision tree as a flowchart. opt.question(f, t) -> { q, leftIsYes }, opt.leaf(node) ->
     [line, line], opt.leafClass(node) -> css class, opt.path: Set of nodes to highlight,
     opt.maxDepth: deeper branches collapse into a "more questions" box. */
  function treeDiagram(el, tree, opt) {
    opt = opt || {};
    const colW = opt.colW || 132, rowH = opt.rowH || 92, boxH = 50, maxDepth = opt.maxDepth || 99;
    const nodes = [];
    let leafCount = 0;
    (function walk(node, depth) {
      const v = { node, depth, cut: !node.leaf && depth >= maxDepth };
      nodes.push(v);
      if (node.leaf || v.cut) { v.x = leafCount++ * colW + colW / 2; return v; }
      v.kids = [walk(node.left, depth + 1), walk(node.right, depth + 1)];
      v.x = (v.kids[0].x + v.kids[1].x) / 2;
      return v;
    })(tree, 0);
    const W = Math.max(leafCount * colW, 200), depthMax = Math.max(...nodes.map(n => n.depth));
    const H = (depthMax + 1) * rowH - rowH + boxH + 12;
    const bw = colW - 14, chars = Math.floor(bw / 6.6);
    const path = opt.path || new Set();
    let edges = '', boxes = '';
    for (const v of nodes) {
      const y = v.depth * rowH + 4;
      if (v.kids) {
        const qq = opt.question(v.node.f, v.node.t);
        v.kids.forEach((k, i) => {
          const yes = (i === 0) === qq.leftIsYes;
          const ky = k.depth * rowH + 4, on = path.has(v.node) && path.has(k.node);
          edges += '<path class="tedge' + (on ? ' on' : '') + '" d="M' + v.x + ' ' + (y + boxH) + ' C' + v.x + ' ' + (y + boxH + 22) + ' ' + k.x + ' ' + (ky - 22) + ' ' + k.x + ' ' + ky + '"/>';
          edges += '<text class="tedge-lbl" x="' + ((v.x + k.x) / 2 + (i ? 8 : -8)) + '" y="' + (y + boxH + 20) + '" text-anchor="' + (i ? 'start' : 'end') + '">' + (yes ? 'yes' : 'no') + '</text>';
        });
        const lines = wrap(qq.q, chars);
        boxes += '<g data-tip="' + esc(qq.q + '\n' + v.node.n + ' rows reach this question') + '"><rect class="tnode' + (path.has(v.node) ? ' on' : '') + '" x="' + (v.x - bw / 2) + '" y="' + y + '" width="' + bw + '" height="' + boxH + '" rx="6"/>';
        lines.forEach((l, i) => { boxes += '<text class="tq" x="' + v.x + '" y="' + (y + boxH / 2 + 4 + (i - (lines.length - 1) / 2) * 14) + '" text-anchor="middle">' + esc(l) + '</text>'; });
        boxes += '</g>';
      } else {
        const lines = v.cut ? ['more questions…', v.node.n + ' rows'] : opt.leaf(v.node);
        const cls = v.cut ? 'cut' : opt.leafClass ? opt.leafClass(v.node) : '';
        boxes += '<g data-tip="' + esc(lines.join('\n')) + '"><rect class="tleaf ' + cls + (path.has(v.node) ? ' on' : '') + '" x="' + (v.x - bw / 2) + '" y="' + y + '" width="' + bw + '" height="' + boxH + '" rx="' + (boxH / 2) + '"/>';
        lines.slice(0, 2).forEach((l, i) => { boxes += '<text class="' + (i ? 'tsub' : 'tq') + '" x="' + v.x + '" y="' + (y + 21 + i * 15) + '" text-anchor="middle">' + esc(trunc(l, chars)) + '</text>'; });
        boxes += '</g>';
      }
    }
    el.innerHTML = '<svg class="chart tree" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opt.label || 'Decision tree diagram') + '">' + edges + boxes + '</svg>';
    // Shrinks to fit narrow containers, but never grows past its natural size.
    el.firstChild.style.maxWidth = W + 'px';
  }

  root.Charts = { hbar, scatter, lines, confusion, legend, bindTips, treeDiagram, SHAPES, esc, niceTicks };
})(typeof globalThis !== 'undefined' ? globalThis : this);
