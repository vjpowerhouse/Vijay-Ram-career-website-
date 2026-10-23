/* ML Agent engine: CSV parsing, profiling, encoding, models, cross-validation.
   Pure computation only. This file makes no network calls and touches no storage,
   so the same code runs in the browser and in Node for the tests. */
(function (root) {
  'use strict';

  // ---------- Random numbers (seeded, so every run is reproducible) ----------
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function range(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }

  // ---------- Small stats helpers ----------
  function mean(a) { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : NaN; }
  function variance(a) {
    if (a.length < 2) return 0;
    const m = mean(a); let s = 0;
    for (const v of a) s += (v - m) * (v - m);
    return s / (a.length - 1);
  }
  function sd(a) { return Math.sqrt(variance(a)); }
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function median(a) { return quantile(a.slice().sort((x, y) => x - y), 0.5); }
  function pearson(x, y) {
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  // Student t two-sided p-value via the regularized incomplete beta function.
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function betacf(a, b, x) {
    const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d; let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function ibeta(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  function tTestP(t, df) {
    if (!isFinite(t)) return 0;
    if (df <= 0) return NaN;
    return ibeta(df / 2, 0.5, df / (df + t * t));
  }

  // ---------- CSV parsing ----------
  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/).find(l => l.trim().length) || '';
    let best = ',', bestCount = 0;
    for (const d of [',', '\t', ';', '|']) {
      let count = 0, inQ = false;
      for (const ch of firstLine) {
        if (ch === '"') inQ = !inQ;
        else if (ch === d && !inQ) count++;
      }
      if (count > bestCount) { best = d; bestCount = count; }
    }
    return best;
  }
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += ch;
      } else if (ch === '"' && field === '') inQ = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const clean = rows.filter(r => r.some(c => c.trim() !== ''));
    if (!clean.length) return { columns: [], rows: [] };
    const seen = {};
    const columns = clean[0].map((h, i) => {
      let name = h.trim() || 'Column ' + (i + 1);
      if (seen[name]) name = name + ' (' + (++seen[name]) + ')'; else seen[name] = 1;
      return name;
    });
    const body = clean.slice(1).map(r => {
      const out = r.slice(0, columns.length).map(c => c.trim());
      while (out.length < columns.length) out.push('');
      return out;
    });
    return { columns, rows: body };
  }

  // ---------- Profiling ----------
  const MISSING = new Set(['', 'na', 'n/a', 'nan', 'null', 'none', '-', '?', '#n/a', 'missing']);
  function isMissing(s) { return s == null || MISSING.has(String(s).trim().toLowerCase()); }
  function toNumber(s) {
    if (isMissing(s)) return null;
    let t = String(s).trim();
    if (/^-?[\d,]+(\.\d+)?%?$/.test(t)) t = t.replace(/,/g, '');
    if (t.endsWith('%')) t = t.slice(0, -1);
    if (t === '') return null;
    const v = Number(t);
    return isFinite(v) ? v : null;
  }
  const ID_NAME = /^(id|row|index|#|obs|observation|s\/?n|serial|run ?order|std ?order|order|sample ?id|record ?id|uuid|guid)$|[ _-]id$/i;

  function profileColumn(name, raw, index) {
    const n = raw.length;
    let missing = 0, numericOk = 0;
    const nums = new Array(n);
    for (let i = 0; i < n; i++) {
      if (isMissing(raw[i])) { missing++; nums[i] = null; continue; }
      const v = toNumber(raw[i]);
      nums[i] = v;
      if (v !== null) numericOk++;
    }
    const present = n - missing;
    const col = { name, index, n, missing, kind: 'categorical' };
    if (present === 0) { col.kind = 'empty'; col.values = raw.map(() => null); col.unique = 0; return col; }
    if (numericOk / present >= 0.95) {
      col.kind = 'numeric';
      col.values = nums;
      col.missing = nums.filter(v => v === null).length;
      const vals = nums.filter(v => v !== null);
      const sorted = vals.slice().sort((a, b) => a - b);
      const levels = Array.from(new Set(sorted));
      col.unique = levels.length;
      col.levels = levels.length <= 12 ? levels : null;
      col.stats = {
        mean: mean(vals), sd: sd(vals), min: sorted[0], max: sorted[sorted.length - 1],
        median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75),
        p10: quantile(sorted, 0.1), p90: quantile(sorted, 0.9)
      };
      let sequential = vals.length > 5;
      for (let i = 1; i < nums.length && sequential; i++) if (nums[i] === null || nums[i] - nums[i - 1] !== 1) sequential = false;
      if (col.unique <= 1) col.kind = 'constant';
      else if (ID_NAME.test(name.trim()) || sequential) col.kind = 'id';
    } else {
      col.values = raw.map(s => (isMissing(s) ? null : String(s).trim()));
      const counts = {};
      for (const v of col.values) if (v !== null) counts[v] = (counts[v] || 0) + 1;
      const levels = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1));
      col.unique = levels.length;
      col.counts = counts;
      col.levels = levels;
      if (col.unique <= 1) col.kind = 'constant';
      else if (ID_NAME.test(name.trim()) || (col.unique === present && present > 20)) col.kind = 'id';
      else if (col.unique > 50 && col.unique > 0.5 * present) col.kind = 'text';
    }
    return col;
  }
  function profile(table) {
    const cols = table.columns.map((name, j) => profileColumn(name, table.rows.map(r => r[j]), j));
    return { nRows: table.rows.length, nCols: cols.length, columns: cols };
  }
  function isUsableFeature(col) { return col.kind === 'numeric' || col.kind === 'categorical'; }

  // ---------- Encoding (fit on training rows only, to avoid leakage) ----------
  function fitEncoder(cols, rows) {
    const parts = [];
    for (const col of cols) {
      if (col.kind === 'numeric') {
        const vals = rows.map(r => col.values[r]).filter(v => v !== null);
        const med = vals.length ? median(vals) : 0;
        const m = vals.length ? mean(vals) : 0;
        const s = sd(vals) || 1;
        parts.push({ col, type: 'num', med, m, s, labels: [col.name] });
      } else {
        const counts = {};
        for (const r of rows) { const v = col.values[r]; if (v !== null) counts[v] = (counts[v] || 0) + 1; }
        const lv = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1));
        const kept = lv.slice(0, 12);
        const mode = lv[0];
        // First (most common) level is the reference, so it gets no column.
        const dummies = kept.slice(1);
        if (lv.length > 12) dummies.push('__other__');
        parts.push({ col, type: 'cat', kept, mode, dummies, labels: dummies.map(d => col.name + ' = ' + (d === '__other__' ? 'other' : d)) });
      }
    }
    const labels = [], groups = [];
    parts.forEach((p, gi) => { for (const l of p.labels) { labels.push(l); groups.push(gi); } });
    function encode(get) {
      const out = [];
      for (const p of parts) {
        if (p.type === 'num') {
          const v = get(p.col);
          out.push(((v === null || v === undefined ? p.med : v) - p.m) / p.s);
        } else {
          let v = get(p.col);
          if (v === null || v === undefined) v = p.mode;
          if (p.kept.indexOf(v) < 0) v = '__other__';
          for (const d of p.dummies) out.push(v === d ? 1 : 0);
        }
      }
      return out;
    }
    return {
      parts, labels, groups,
      transform: rows => rows.map(r => encode(col => col.values[r])),
      // Encodes one hand-entered row, given as { columnName: value }.
      encodeValues: obj => encode(col => obj[col.name])
    };
  }

  // ---------- Linear algebra ----------
  function solveSPD(A, b) {
    const n = A.length;
    for (let attempt = 0; attempt < 6; attempt++) {
      const jitter = attempt ? Math.pow(10, attempt - 9) * (1 + trace(A) / n) : 0;
      const L = A.map(r => new Float64Array(n));
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        for (let j = 0; j <= i; j++) {
          let s = A[i][j] + (i === j ? jitter : 0);
          for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
          if (i === j) { if (s <= 1e-14) { ok = false; break; } L[i][i] = Math.sqrt(s); }
          else L[i][j] = s / L[j][j];
        }
      }
      if (!ok) continue;
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
      const x = new Float64Array(n);
      for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
      return Array.from(x);
    }
    return new Array(n).fill(0);
  }
  function trace(A) { let s = 0; for (let i = 0; i < A.length; i++) s += A[i][i]; return s; }
  function invert(A) {
    const n = A.length;
    const M = A.map((r, i) => { const row = r.slice(); for (let j = 0; j < n; j++) row.push(i === j ? 1 : 0); return row; });
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      const t = M[c]; M[c] = M[piv]; M[piv] = t;
      const d = M[c][c];
      for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map(r => r.slice(n));
  }
  function gram(X) {
    const p = X[0] ? X[0].length : 0;
    const G = range(p).map(() => new Array(p).fill(0));
    for (const row of X) for (let i = 0; i < p; i++) { const v = row[i]; if (v) for (let j = 0; j <= i; j++) G[i][j] += v * row[j]; }
    for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) G[j][i] = G[i][j];
    return G;
  }

  // ---------- Models ----------
  // Every model: fit(X, y, ctx) -> { predict(X) } ; classifiers also predictProba(X).
  // ctx = { task, nClasses, rand }.

  function fitRidgeCore(X, y, lambda) {
    const n = X.length, p = X[0] ? X[0].length : 0;
    const xm = new Array(p).fill(0);
    for (const r of X) for (let j = 0; j < p; j++) xm[j] += r[j] / n;
    const ym = mean(y);
    const Xc = X.map(r => r.map((v, j) => v - xm[j]));
    const G = gram(Xc);
    for (let j = 0; j < p; j++) G[j][j] += lambda;
    const b = new Array(p).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) b[j] += Xc[i][j] * (y[i] - ym);
    const w = p ? solveSPD(G, b) : [];
    let b0 = ym; for (let j = 0; j < p; j++) b0 -= xm[j] * w[j];
    return { w, b0, predict: Xn => Xn.map(r => { let s = b0; for (let j = 0; j < p; j++) s += r[j] * w[j]; return s; }) };
  }
  function innerCVChoose(X, y, candidates, fitFn, rand) {
    // Picks a hyper-parameter by 3-fold CV inside the training data.
    const n = X.length;
    if (n < 12 || candidates.length === 1) return candidates[Math.floor(candidates.length / 2)];
    const folds = makeFolds(n, 3, rand);
    let best = candidates[0], bestErr = Infinity;
    for (const c of candidates) {
      let err = 0;
      for (let f = 0; f < 3; f++) {
        const tr = [], te = [];
        for (let i = 0; i < n; i++) (folds[i] === f ? te : tr).push(i);
        const m = fitFn(tr.map(i => X[i]), tr.map(i => y[i]), c);
        const pr = m.predict(te.map(i => X[i]));
        te.forEach((i, k) => { err += (pr[k] - y[i]) ** 2; });
      }
      if (err < bestErr - 1e-12) { bestErr = err; best = c; }
    }
    return best;
  }
  /* Adds squares and pairwise products. Only for `cols` (numeric columns; yes/no category
     columns stay linear), so many categories do not blow up the model size. */
  function quadExpand(X, cols) {
    cols = cols || range(X[0].length);
    return X.map(r => {
      const out = r.slice();
      for (let a = 0; a < cols.length; a++) for (let b = a; b < cols.length; b++) out.push(r[cols[a]] * r[cols[b]]);
      return out;
    });
  }
  function fitLasso(X, y, alpha, iters) {
    const n = X.length, p = X[0].length;
    const xm = new Array(p).fill(0);
    for (const r of X) for (let j = 0; j < p; j++) xm[j] += r[j] / n;
    const ym = mean(y);
    const cols = range(p).map(j => X.map(r => r[j] - xm[j]));
    const sq = cols.map(c => c.reduce((s, v) => s + v * v, 0) / n);
    const w = new Array(p).fill(0);
    const res = y.map(v => v - ym);
    for (let it = 0; it < (iters || 200); it++) {
      let maxDelta = 0;
      for (let j = 0; j < p; j++) {
        if (!sq[j]) continue;
        const c = cols[j];
        let rho = 0;
        for (let i = 0; i < n; i++) rho += c[i] * res[i];
        rho = rho / n + sq[j] * w[j];
        const nw = Math.sign(rho) * Math.max(Math.abs(rho) - alpha, 0) / sq[j];
        const d = nw - w[j];
        if (d) { for (let i = 0; i < n; i++) res[i] -= d * c[i]; w[j] = nw; maxDelta = Math.max(maxDelta, Math.abs(d)); }
      }
      if (maxDelta < 1e-6) break;
    }
    let b0 = ym; for (let j = 0; j < p; j++) b0 -= xm[j] * w[j];
    return { w, b0, predict: Xn => Xn.map(r => { let s = b0; for (let j = 0; j < p; j++) s += r[j] * w[j]; return s; }) };
  }

  // Decision tree (CART). Regression uses squared error, classification uses Gini.
  function buildTree(X, y, idx, opt, rand, depth) {
    const nC = opt.nClasses;
    // Every node keeps its row count and average, so trees can be drawn as diagrams.
    const nodeValue = () => {
      if (nC) { const p = new Array(nC).fill(0); for (const i of idx) p[y[i]] += 1 / idx.length; return p; }
      let s = 0; for (const i of idx) s += y[i]; return s / idx.length;
    };
    const leaf = () => ({ leaf: true, n: idx.length, value: opt.leafValue ? opt.leafValue(idx) : nodeValue() });
    if (depth >= opt.maxDepth || idx.length < 2 * opt.minLeaf) return leaf();
    // Pure node?
    let pure = true; for (let k = 1; k < idx.length && pure; k++) if (y[idx[k]] !== y[idx[0]]) pure = false;
    if (pure) return leaf();
    const p = X[0].length;
    let feats = range(p);
    if (opt.mtry && opt.mtry < p) feats = shuffle(feats, rand).slice(0, opt.mtry);
    let bestGain = -Infinity, bestF = -1, bestT = 0;
    const m = idx.length;
    // Parent score, for the gain comparison.
    let parent;
    if (nC) { const c = new Array(nC).fill(0); for (const i of idx) c[y[i]]++; parent = c.reduce((s, v) => s + v * v, 0) / m; }
    else { let s = 0; for (const i of idx) s += y[i]; parent = s * s / m; }
    for (const f of feats) {
      const ord = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
      if (X[ord[0]][f] === X[ord[m - 1]][f]) continue;
      if (nC) {
        const L = new Array(nC).fill(0), R = new Array(nC).fill(0);
        for (const i of ord) R[y[i]]++;
        let sl = 0, sr = 0; for (let c = 0; c < nC; c++) sr += R[c] * R[c];
        for (let k = 0; k < m - 1; k++) {
          const c = y[ord[k]];
          sl += 2 * L[c] + 1; L[c]++;
          sr -= 2 * R[c] - 1; R[c]--;
          const nl = k + 1, nr = m - nl;
          if (nl < opt.minLeaf || nr < opt.minLeaf) continue;
          const a = X[ord[k]][f], b = X[ord[k + 1]][f];
          if (a === b) continue;
          const g = sl / nl + sr / nr;
          if (g > bestGain) { bestGain = g; bestF = f; bestT = (a + b) / 2; }
        }
      } else {
        let total = 0; for (const i of ord) total += y[i];
        let sl = 0;
        for (let k = 0; k < m - 1; k++) {
          sl += y[ord[k]];
          const nl = k + 1, nr = m - nl;
          if (nl < opt.minLeaf || nr < opt.minLeaf) continue;
          const a = X[ord[k]][f], b = X[ord[k + 1]][f];
          if (a === b) continue;
          const sr = total - sl;
          const g = sl * sl / nl + sr * sr / nr;
          if (g > bestGain) { bestGain = g; bestF = f; bestT = (a + b) / 2; }
        }
      }
    }
    if (bestF < 0 || bestGain <= parent + 1e-12) return leaf();
    const li = [], ri = [];
    for (const i of idx) (X[i][bestF] <= bestT ? li : ri).push(i);
    return { f: bestF, t: bestT, n: idx.length, value: opt.leafValue ? null : nodeValue(), left: buildTree(X, y, li, opt, rand, depth + 1), right: buildTree(X, y, ri, opt, rand, depth + 1) };
  }
  function treePredictRow(node, r) { while (!node.leaf) node = r[node.f] <= node.t ? node.left : node.right; return node.value; }
  function treeLeafOf(node, r) { while (!node.leaf) node = r[node.f] <= node.t ? node.left : node.right; return node; }

  function argmax(a) { let b = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i; return b; }
  function classifier(predictProba) {
    return { predictProba, predict: X => predictProba(X).map(argmax) };
  }
  function softmax(z) {
    const m = Math.max.apply(null, z); const e = z.map(v => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0);
    return e.map(v => v / s);
  }
  function sqDist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; }
  // Indices of the k closest rows, nearest first. Keeps a short sorted list instead of
  // sorting every row, so it stays fast on thousands of rows.
  function nearest(Xtr, r, k) {
    const dist = [], idx = [];
    for (let i = 0; i < Xtr.length; i++) {
      const d = sqDist(Xtr[i], r);
      if (dist.length === k && d >= dist[k - 1]) continue;
      let j = dist.length < k ? dist.length : k - 1;
      while (j > 0 && dist[j - 1] > d) { if (j < k) { dist[j] = dist[j - 1]; idx[j] = idx[j - 1]; } j--; }
      dist[j] = d; idx[j] = i;
    }
    return idx;
  }

  const MODELS = [
    {
      id: 'baseline', name: 'Baseline (no model)', task: 'both', complexity: 0,
      plain: 'Always guesses the average (or the most common class). Any real model must beat this, like a control group.',
      fit(X, y, ctx) {
        if (ctx.task === 'regression') { const m = mean(y); return { predict: Xn => Xn.map(() => m) }; }
        const p = new Array(ctx.nClasses).fill(0); for (const v of y) p[v] += 1 / y.length;
        return classifier(Xn => Xn.map(() => p.slice()));
      }
    },
    {
      id: 'linear', name: 'Linear regression', task: 'regression', complexity: 1,
      plain: 'Draws the best straight-line relationship between each factor and the result. Easy to explain, like a recipe: each factor adds or subtracts a fixed amount.',
      fit(X, y) { return fitRidgeCore(X, y, 1e-8 * X.length); }
    },
    {
      id: 'ridge', name: 'Ridge regression', task: 'regression', complexity: 1.2,
      plain: 'A straight-line model with a "seat belt" that stops it from over-reacting to noise when factors move together.',
      fit(X, y, ctx) {
        const lam = innerCVChoose(X, y, [0.1, 1, 10, 100].map(v => v * X.length / 100 + v), (a, b, l) => fitRidgeCore(a, b, l), ctx.rand);
        return fitRidgeCore(X, y, lam);
      }
    },
    {
      id: 'lasso', name: 'Lasso regression', task: 'regression', complexity: 1.3,
      plain: 'A straight-line model that switches off factors that do not matter. Good at picking the vital few out of the trivial many.',
      fit(X, y, ctx) {
        const s = sd(y) || 1;
        const a = innerCVChoose(X, y, [0.001, 0.01, 0.05, 0.1, 0.3].map(v => v * s), (aX, ay, al) => fitLasso(aX, ay, al, 100), ctx.rand);
        return fitLasso(X, y, a, 300);
      }
    },
    {
      id: 'quadratic', name: 'Quadratic (curves + interactions)', task: 'regression', complexity: 2,
      plain: 'Like linear regression, but allows curves (a sweet spot) and interactions (factor A matters more when factor B is high). This is the classic response-surface model from DOE.',
      applicable: (n, p) => p >= 1 && p <= 12,
      fit(X, y, ctx) {
        const cols = range(X[0].length).filter(j => X.some(r => r[j] !== 0 && r[j] !== 1)).slice(0, 12);
        const Q = quadExpand(X, cols);
        const lam = innerCVChoose(Q, y, [0.01, 0.1, 1, 10], (a, b, l) => fitRidgeCore(a, b, l), ctx.rand);
        const m = fitRidgeCore(Q, y, lam);
        return { predict: Xn => m.predict(quadExpand(Xn, cols)) };
      }
    },
    {
      id: 'logistic', name: 'Logistic regression', task: 'classification', complexity: 1,
      plain: 'Weighs each factor to score the odds of each outcome. The classification version of a straight-line model, easy to explain.',
      fit(X, y, ctx) {
        const K = ctx.nClasses, p = X[0].length, n = X.length, lam = 1e-2;
        const W = range(K).map(() => new Array(p + 1).fill(0));
        const mW = W.map(r => r.map(() => 0)), vW = W.map(r => r.map(() => 0));
        const lr = 0.05, b1 = 0.9, b2 = 0.999;
        for (let it = 1; it <= 300; it++) {
          const G = W.map(r => r.map(() => 0));
          for (let i = 0; i < n; i++) {
            const r = X[i];
            const z = W.map(w => { let s = w[p]; for (let j = 0; j < p; j++) s += w[j] * r[j]; return s; });
            const pr = softmax(z);
            for (let k = 0; k < K; k++) {
              const g = pr[k] - (y[i] === k ? 1 : 0);
              for (let j = 0; j < p; j++) G[k][j] += g * r[j] / n;
              G[k][p] += g / n;
            }
          }
          for (let k = 0; k < K; k++) for (let j = 0; j <= p; j++) {
            const g = G[k][j] + (j < p ? lam * W[k][j] : 0);
            mW[k][j] = b1 * mW[k][j] + (1 - b1) * g;
            vW[k][j] = b2 * vW[k][j] + (1 - b2) * g * g;
            W[k][j] -= lr * (mW[k][j] / (1 - Math.pow(b1, it))) / (Math.sqrt(vW[k][j] / (1 - Math.pow(b2, it))) + 1e-8);
          }
        }
        const m = classifier(Xn => Xn.map(r => softmax(W.map(w => { let s = w[p]; for (let j = 0; j < p; j++) s += w[j] * r[j]; return s; }))));
        m.weights = W;
        return m;
      }
    },
    {
      id: 'naivebayes', name: 'Naive Bayes', task: 'classification', complexity: 1.1,
      plain: 'Builds a profile of what each class typically looks like, then asks "which profile does this new row resemble most?" Fast and robust on small data.',
      fit(X, y, ctx) {
        const K = ctx.nClasses, p = X[0].length;
        const stats = range(K).map(k => {
          const rows = X.filter((_, i) => y[i] === k);
          const mu = range(p).map(j => mean(rows.map(r => r[j])) || 0);
          const va = range(p).map(j => (rows.length > 1 ? variance(rows.map(r => r[j])) : 1) + 1e-2);
          return { prior: Math.log((rows.length + 1) / (X.length + K)), mu, va };
        });
        return classifier(Xn => Xn.map(r => softmax(stats.map(s => {
          let l = s.prior;
          for (let j = 0; j < p; j++) l -= 0.5 * Math.log(2 * Math.PI * s.va[j]) + (r[j] - s.mu[j]) ** 2 / (2 * s.va[j]);
          return l;
        }))));
      }
    },
    {
      id: 'knn', name: 'k-Nearest neighbours', task: 'both', complexity: 3,
      plain: 'Finds the most similar past rows and copies their result, like asking "what happened the last few times conditions looked like this?"',
      applicable: n => n <= 6000,
      fit(X, y, ctx) {
        const kMax = Math.max(1, X.length - 1);
        const ks = [3, 5, 7, 11, 15].filter(k => k <= kMax);
        if (!ks.length) ks.push(1);
        if (ctx.task === 'regression') {
          const make = (Xt, yt, k) => ({ predict: Xn => Xn.map(r => mean(nearest(Xt, r, k).map(i => yt[i]))) });
          // Pick k on one held-out third (up to 600 rows): find each row's 15 nearest once,
          // then score every k from that same list.
          let k = ks[Math.min(1, ks.length - 1)];
          if (X.length >= 12 && ks.length > 1) {
            const order = shuffle(range(X.length), ctx.rand);
            const te = order.slice(0, Math.min(600, Math.floor(X.length / 3))), tr = order.slice(te.length);
            const Xt = tr.map(i => X[i]), yt = tr.map(i => y[i]), kTop = Math.min(ks[ks.length - 1], tr.length);
            const err = ks.map(() => 0);
            for (const i of te) {
              const nb = nearest(Xt, X[i], kTop);
              ks.forEach((kk, c) => { const m = mean(nb.slice(0, kk).map(j => yt[j])); err[c] += (m - y[i]) ** 2; });
            }
            k = ks[err.indexOf(Math.min(...err))];
          }
          return make(X, y, k);
        }
        const k = ks[Math.min(1, ks.length - 1)];
        return classifier(Xn => Xn.map(r => {
          const p = new Array(ctx.nClasses).fill(0);
          const nb = nearest(X, r, k);
          for (const i of nb) p[y[i]] += 1 / nb.length;
          return p;
        }));
      }
    },
    {
      id: 'tree', name: 'Decision tree', task: 'both', complexity: 2.5,
      plain: 'A flowchart of yes/no questions ("Is temperature above 180?"). You can read it like a troubleshooting guide.',
      fit(X, y, ctx) {
        const opt = { maxDepth: 5, minLeaf: Math.max(2, Math.round(X.length / 50)), nClasses: ctx.task === 'classification' ? ctx.nClasses : 0 };
        const t = buildTree(X, y, range(X.length), opt, ctx.rand, 0);
        if (ctx.task === 'regression') return { tree: t, predict: Xn => Xn.map(r => treePredictRow(t, r)) };
        const m = classifier(Xn => Xn.map(r => treePredictRow(t, r).slice()));
        m.tree = t; return m;
      }
    },
    {
      id: 'forest', name: 'Random forest', task: 'both', complexity: 4,
      plain: 'Grows many decision trees, each on a different sample of the data, and averages their votes. Like asking 60 experienced operators and going with the consensus.',
      fit(X, y, ctx) {
        const p = X[0].length, n = X.length, nTrees = n > 2000 ? 40 : 60;
        const cls = ctx.task === 'classification';
        const opt = { maxDepth: 12, minLeaf: cls ? 1 : 3, nClasses: cls ? ctx.nClasses : 0, mtry: cls ? Math.max(1, Math.round(Math.sqrt(p))) : Math.max(1, Math.round(p / 3)) };
        const trees = [];
        for (let t = 0; t < nTrees; t++) {
          const idx = range(n).map(() => Math.floor(ctx.rand() * n));
          trees.push(buildTree(X, y, idx, opt, ctx.rand, 0));
        }
        if (!cls) return { trees, predict: Xn => Xn.map(r => { let s = 0; for (const t of trees) s += treePredictRow(t, r); return s / trees.length; }) };
        const m = classifier(Xn => Xn.map(r => {
          const pr = new Array(ctx.nClasses).fill(0);
          for (const t of trees) { const v = treePredictRow(t, r); for (let k = 0; k < pr.length; k++) pr[k] += v[k] / trees.length; }
          return pr;
        }));
        m.trees = trees; return m;
      }
    },
    {
      id: 'boosting', name: 'Gradient boosting', task: 'both', complexity: 4,
      plain: 'Builds small trees one after another, each fixing the mistakes of the ones before. Like continuous improvement: every round closes part of the remaining gap.',
      applicable: (n, p, task, K) => task === 'regression' || K === 2,
      fit(X, y, ctx) {
        const n = X.length, rounds = 100, lr = 0.1;
        const opt = { maxDepth: 3, minLeaf: Math.max(3, Math.round(n / 60)), nClasses: 0 };
        const trees = [];
        if (ctx.task === 'regression') {
          const f0 = mean(y), F = new Array(n).fill(f0);
          for (let m = 0; m < rounds; m++) {
            const r = y.map((v, i) => v - F[i]);
            const sub = shuffle(range(n), ctx.rand).slice(0, Math.max(opt.minLeaf * 2, Math.round(n * (n > 1500 ? 0.5 : 0.8))));
            const t = buildTree(X, r, sub, opt, ctx.rand, 0);
            trees.push(t);
            for (let i = 0; i < n; i++) F[i] += lr * treePredictRow(t, X[i]);
          }
          return { trees, f0, lr, predict: Xn => Xn.map(row => { let s = f0; for (const t of trees) s += lr * treePredictRow(t, row); return s; }) };
        }
        // Binary classification with log-loss; Newton step for leaf values.
        const pos = y.reduce((s, v) => s + v, 0) / n;
        const f0 = Math.log((pos + 1e-3) / (1 - pos + 1e-3));
        const F = new Array(n).fill(f0);
        const sig = z => 1 / (1 + Math.exp(-z));
        for (let m = 0; m < rounds; m++) {
          const pr = F.map(sig);
          const r = y.map((v, i) => v - pr[i]);
          const o = Object.assign({}, opt, {
            leafValue: idx => {
              let num = 0, den = 0;
              for (const i of idx) { num += r[i]; den += pr[i] * (1 - pr[i]); }
              return den > 1e-9 ? Math.max(-4, Math.min(4, num / den)) : 0;
            }
          });
          const sub = shuffle(range(n), ctx.rand).slice(0, Math.max(opt.minLeaf * 2, Math.round(n * (n > 1500 ? 0.5 : 0.8))));
          const t = buildTree(X, r, sub, o, ctx.rand, 0);
          trees.push(t);
          for (let i = 0; i < n; i++) F[i] += lr * treePredictRow(t, X[i]);
        }
        const m = classifier(Xn => Xn.map(row => {
          let s = f0; for (const t of trees) s += lr * treePredictRow(t, row);
          const p1 = sig(s); return [1 - p1, p1];
        }));
        Object.assign(m, { trees, f0, lr }); return m;
      }
    }
  ];

  // ---------- Cross-validation ----------
  function makeFolds(n, k, rand, yClass) {
    const folds = new Array(n);
    if (yClass) {
      const byClass = {};
      yClass.forEach((c, i) => { (byClass[c] = byClass[c] || []).push(i); });
      let offset = 0;
      for (const c of Object.keys(byClass)) {
        const idx = shuffle(byClass[c].slice(), rand);
        idx.forEach((i, j) => { folds[i] = (j + offset) % k; });
        offset += idx.length;
      }
    } else {
      shuffle(range(n), rand).forEach((i, j) => { folds[i] = j % k; });
    }
    return folds;
  }

  function regressionMetrics(y, pred) {
    const m = mean(y);
    let sse = 0, sst = 0, sae = 0;
    for (let i = 0; i < y.length; i++) { sse += (y[i] - pred[i]) ** 2; sst += (y[i] - m) ** 2; sae += Math.abs(y[i] - pred[i]); }
    return { r2: sst ? 1 - sse / sst : 0, rmse: Math.sqrt(sse / y.length), mae: sae / y.length };
  }
  function classificationMetrics(y, pred, K) {
    const cm = range(K).map(() => new Array(K).fill(0));
    for (let i = 0; i < y.length; i++) cm[y[i]][pred[i]]++;
    let correct = 0; for (let k = 0; k < K; k++) correct += cm[k][k];
    const recalls = [], f1s = [];
    for (let k = 0; k < K; k++) {
      const actual = cm[k].reduce((a, b) => a + b, 0);
      const predicted = cm.reduce((s, r) => s + r[k], 0);
      if (!actual) continue;
      const rec = cm[k][k] / actual, prec = predicted ? cm[k][k] / predicted : 0;
      recalls.push(rec); f1s.push(prec + rec ? 2 * prec * rec / (prec + rec) : 0);
    }
    return { accuracy: correct / y.length, balancedAccuracy: mean(recalls), macroF1: mean(f1s), confusion: cm };
  }

  /* Builds the supervised dataset. Returns rows with a valid target, the target vector,
     and the feature columns. */
  function supervisedData(prof, targetCol, featureCols, task) {
    const rows = range(prof.nRows).filter(r => targetCol.values[r] !== null);
    let y, classes = null;
    if (task === 'classification') {
      const lv = Array.from(new Set(rows.map(r => String(targetCol.values[r]))));
      lv.sort((a, b) => (isFinite(a) && isFinite(b) ? a - b : a < b ? -1 : a > b ? 1 : 0));
      classes = lv;
      y = rows.map(r => lv.indexOf(String(targetCol.values[r])));
    } else y = rows.map(r => targetCol.values[r]);
    return { rows, y, classes, featureCols };
  }

  function crossValidate(model, data, task, folds, k, seed) {
    const n = data.rows.length;
    const K = data.classes ? data.classes.length : 0;
    const oof = new Array(n);
    for (let f = 0; f < k; f++) {
      const tr = [], te = [];
      for (let i = 0; i < n; i++) (folds[i] === f ? te : tr).push(i);
      if (!te.length || !tr.length) continue;
      const enc = fitEncoder(data.featureCols, tr.map(i => data.rows[i]));
      const Xtr = enc.transform(tr.map(i => data.rows[i]));
      const Xte = enc.transform(te.map(i => data.rows[i]));
      const fitted = model.fit(Xtr, tr.map(i => data.y[i]), { task, nClasses: K, rand: rng(seed + f) });
      const pr = fitted.predict(Xte);
      te.forEach((i, j) => { oof[i] = pr[j]; });
    }
    return oof;
  }

  function fitFull(model, data, task, seed) {
    const enc = fitEncoder(data.featureCols, data.rows);
    const X = enc.transform(data.rows);
    const K = data.classes ? data.classes.length : 0;
    const fitted = model.fit(X, data.y, { task, nClasses: K, rand: rng(seed) });
    return { enc, X, fitted };
  }

  // How much the score drops when one original column is scrambled.
  function permutationImportance(full, data, task, seed) {
    const { enc, X, fitted } = full;
    const K = data.classes ? data.classes.length : 0;
    const score = pred => task === 'regression' ? regressionMetrics(data.y, pred).r2 : classificationMetrics(data.y, pred, K).balancedAccuracy;
    const base = score(fitted.predict(X));
    const rand = rng(seed);
    return enc.parts.map((part, gi) => {
      const cols = []; enc.groups.forEach((g, j) => { if (g === gi) cols.push(j); });
      let drop = 0;
      const reps = 3;
      for (let rep = 0; rep < reps; rep++) {
        const perm = shuffle(range(X.length), rand);
        const Xp = X.map((r, i) => { const o = r.slice(); for (const j of cols) o[j] = X[perm[i]][j]; return o; });
        drop += (base - score(fitted.predict(Xp))) / reps;
      }
      return { name: part.col.name, importance: Math.max(0, drop) };
    }).sort((a, b) => b.importance - a.importance);
  }

  /* Partial dependence: set one column to each value on a grid for every row, and average
     the model's prediction. Shows how the result moves with that column, other things equal.
     For classifiers it tracks the probability of class `cls`. */
  function partialDependence(full, data, col, cls) {
    const { enc, fitted } = full;
    const raw = data.rows;
    let grid;
    if (col.kind === 'numeric') {
      const vals = raw.map(r => col.values[r]).filter(v => v !== null).sort((a, b) => a - b);
      const lo = quantile(vals, 0.05), hi = quantile(vals, 0.95);
      if (!(hi > lo)) return null;
      grid = range(13).map(i => lo + (hi - lo) * i / 12);
    } else {
      const counts = {};
      for (const r of raw) { const v = col.values[r]; if (v !== null) counts[v] = (counts[v] || 0) + 1; }
      grid = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10);
    }
    // Score on a sample of rows to keep it fast.
    const sample = raw.length > 400 ? raw.filter((_, i) => i % Math.ceil(raw.length / 400) === 0) : raw;
    const getRow = r => { const o = {}; for (const p of enc.parts) o[p.col.name] = p.col.values[r]; return o; };
    const base = sample.map(getRow);
    const ys = grid.map(g => {
      const X = base.map(o => { const c = Object.assign({}, o); c[col.name] = g; return enc.encodeValues(c); });
      const pr = fitted.predictProba ? fitted.predictProba(X).map(p => p[cls]) : fitted.predict(X);
      return mean(pr);
    });
    const vals = raw.map(r => col.values[r]).filter(v => v !== null);
    const typical = col.kind === 'numeric' ? median(vals) : col.levels[0];
    return { name: col.name, kind: col.kind, grid, ys, typical };
  }

  // ---------- Unsupervised ----------
  function kmeans(X, k, rand, nInit) {
    let best = null;
    for (let init = 0; init < (nInit || 5); init++) {
      // k-means++ seeding
      const centers = [X[Math.floor(rand() * X.length)].slice()];
      while (centers.length < k) {
        const d = X.map(r => Math.min.apply(null, centers.map(c => sqDist(r, c))));
        const tot = d.reduce((a, b) => a + b, 0);
        let u = rand() * tot, pick = 0;
        for (let i = 0; i < d.length; i++) { u -= d[i]; if (u <= 0) { pick = i; break; } }
        centers.push(X[pick].slice());
      }
      let labels = new Array(X.length).fill(0);
      for (let it = 0; it < 100; it++) {
        let changed = false;
        for (let i = 0; i < X.length; i++) {
          let bi = 0, bd = Infinity;
          for (let c = 0; c < k; c++) { const dd = sqDist(X[i], centers[c]); if (dd < bd) { bd = dd; bi = c; } }
          if (labels[i] !== bi) { labels[i] = bi; changed = true; }
        }
        for (let c = 0; c < k; c++) {
          const members = X.filter((_, i) => labels[i] === c);
          if (members.length) for (let j = 0; j < X[0].length; j++) centers[c][j] = mean(members.map(r => r[j]));
        }
        if (!changed && it > 0) break;
      }
      let inertia = 0; for (let i = 0; i < X.length; i++) inertia += sqDist(X[i], centers[labels[i]]);
      if (!best || inertia < best.inertia) best = { labels: labels.slice(), centers: centers.map(c => c.slice()), inertia };
    }
    // Relabel clusters by size so cluster 1 is the largest (stable colors).
    const sizes = range(k).map(c => best.labels.filter(l => l === c).length);
    const order = range(k).sort((a, b) => sizes[b] - sizes[a]);
    const map = {}; order.forEach((c, i) => { map[c] = i; });
    best.labels = best.labels.map(l => map[l]);
    best.centers = order.map(c => best.centers[c]);
    return best;
  }
  function silhouette(X, labels, k, rand) {
    let idx = range(X.length);
    if (idx.length > 800) idx = shuffle(idx, rand).slice(0, 800);
    let total = 0, cnt = 0;
    for (const i of idx) {
      const sums = new Array(k).fill(0), counts = new Array(k).fill(0);
      for (const j of idx) { if (i === j) continue; sums[labels[j]] += Math.sqrt(sqDist(X[i], X[j])); counts[labels[j]]++; }
      const own = labels[i];
      if (!counts[own]) continue;
      const a = sums[own] / counts[own];
      let b = Infinity; for (let c = 0; c < k; c++) if (c !== own && counts[c]) b = Math.min(b, sums[c] / counts[c]);
      if (!isFinite(b)) continue;
      total += (b - a) / Math.max(a, b); cnt++;
    }
    return cnt ? total / cnt : 0;
  }
  function jacobiEigen(S) {
    const n = S.length;
    const A = S.map(r => r.slice());
    const V = range(n).map(i => range(n).map(j => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
      if (off < 1e-18) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
    const vals = range(n).map(i => A[i][i]);
    const order = range(n).sort((a, b) => vals[b] - vals[a]);
    return { values: order.map(i => vals[i]), vectors: order.map(i => V.map(r => r[i])) };
  }
  function pca(X) {
    const n = X.length, p = X[0].length;
    const m = range(p).map(j => mean(X.map(r => r[j])));
    const Xc = X.map(r => r.map((v, j) => v - m[j]));
    const S = gram(Xc).map(r => r.map(v => v / Math.max(1, n - 1)));
    const eig = jacobiEigen(S);
    const total = eig.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const comps = eig.vectors.slice(0, 2);
    return {
      explained: eig.values.map(v => Math.max(0, v) / total),
      loadings: comps,
      scores: Xc.map(r => comps.map(c => c.reduce((s, w, j) => s + w * r[j], 0)))
    };
  }

  root.MLEngine = {
    rng, shuffle, range, mean, sd, variance, quantile, median, pearson, tTestP, invert, gram,
    parseCSV, profile, isUsableFeature, toNumber, fitEncoder, fitRidgeCore, fitLasso, buildTree,
    MODELS, makeFolds, crossValidate, fitFull, regressionMetrics, classificationMetrics,
    supervisedData, permutationImportance, partialDependence, treePredictRow, kmeans, silhouette, pca
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MLEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
