/* ML Agent DOE module: detect designed experiments, analyze them (effects, p-values,
   optimum), and generate new designs (full/fractional factorial, Plackett-Burman,
   central composite, Box-Behnken). Pure computation; no network, no storage. */
(function (root) {
  'use strict';
  const E = root.MLEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const { mean, range, invert, tTestP, median, pearson } = E;

  const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'.split('');

  // ---------- Detection ----------
  /* A dataset looks like a designed experiment when every predictor sits at a handful
     of set levels (2-5) and the factors are close to uncorrelated (orthogonal). */
  function detect(prof, featureCols, targetCol) {
    if (!targetCol || targetCol.kind !== 'numeric') return { isDOE: false, reason: 'Response is not numeric.' };
    if (featureCols.length < 2 || featureCols.length > 15) return { isDOE: false, reason: 'Needs 2 to 15 factors.' };
    const rows = range(prof.nRows).filter(r => targetCol.values[r] !== null && featureCols.every(c => c.values[r] !== null));
    if (rows.length < 4 || rows.length > 300) return { isDOE: false, reason: 'Run count outside a typical DOE.' };
    const factors = [];
    for (const c of featureCols) {
      const lv = Array.from(new Set(rows.map(r => c.values[r])));
      if (c.kind === 'numeric') {
        lv.sort((a, b) => a - b);
        if (lv.length < 2 || lv.length > 5) return { isDOE: false, reason: c.name + ' has ' + lv.length + ' levels.' };
        const lo = lv[0], hi = lv[lv.length - 1];
        // CCD star points sit outside the cube; use the inner pair as -1/+1 when 5 levels.
        const cubeLo = lv.length === 5 ? lv[1] : lo, cubeHi = lv.length === 5 ? lv[3] : hi;
        factors.push({ name: c.name, col: c, categorical: false, levels: lv, low: cubeLo, high: cubeHi, center: (cubeLo + cubeHi) / 2, half: (cubeHi - cubeLo) / 2 });
      } else {
        if (lv.length !== 2) return { isDOE: false, reason: c.name + ' is categorical with ' + lv.length + ' levels.' };
        lv.sort();
        factors.push({ name: c.name, col: c, categorical: true, levels: lv, low: lv[0], high: lv[1] });
      }
    }
    factors.forEach((f, i) => { f.letter = LETTERS[i]; });
    const coded = rows.map(r => factors.map(f => code(f, f.col.values[r])));
    for (let i = 0; i < factors.length; i++) for (let j = i + 1; j < factors.length; j++) {
      const r = pearson(coded.map(x => x[i]), coded.map(x => x[j]));
      if (Math.abs(r) > 0.3) return { isDOE: false, reason: factors[i].name + ' and ' + factors[j].name + ' move together (r = ' + r.toFixed(2) + ').' };
    }
    return { isDOE: true, factors, rows };
  }
  function code(f, v) {
    if (f.categorical) return v === f.high ? 1 : -1;
    return f.half ? (v - f.center) / f.half : 0;
  }
  function decode(f, c) {
    if (f.categorical) return c > 0 ? f.high : f.low;
    return f.center + c * f.half;
  }

  // ---------- Analysis ----------
  function termValue(term, x) { let v = 1; for (const i of term.idx) v *= x[i]; return v; }

  function analyze(det, targetCol) {
    const { factors, rows } = det;
    const k = factors.length;
    const X = rows.map(r => factors.map(f => code(f, f.col.values[r])));
    const y = rows.map(r => targetCol.values[r]);
    const n = y.length;

    // Candidate terms in hierarchy order: main effects, 2-factor interactions, squares.
    const cands = factors.map((f, i) => ({ idx: [i], label: f.letter, kind: 'main' }));
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) cands.push({ idx: [i, j], label: factors[i].letter + factors[j].letter, kind: 'interaction' });
    factors.forEach((f, i) => { if (!f.categorical && f.levels.length >= 3) cands.push({ idx: [i, i], label: f.letter + '²', kind: 'square' }); });

    // Add terms while they are estimable; terms that duplicate an existing column are aliased.
    const terms = [], cols = [new Array(n).fill(1)], aliases = [];
    const basis = [unit(cols[0])];
    for (const t of cands) {
      if (cols.length >= n) { aliases.push({ term: t.label, with: 'no runs left to estimate it' }); continue; }
      const v = X.map(x => termValue(t, x));
      const resid = orthResidual(v, basis);
      const norm = Math.sqrt(resid.reduce((s, a) => s + a * a, 0));
      if (norm < 1e-6 * Math.sqrt(n)) {
        const twin = terms.find((tt, ti) => Math.abs(pearson(cols[ti + 1], v)) > 0.999);
        aliases.push({ term: t.label, with: twin ? twin.label : 'a combination of other terms', squares: t.kind === 'square' && !!twin && twin.kind === 'square' });
        continue;
      }
      terms.push(t); cols.push(v); basis.push(resid.map(a => a / norm));
    }

    // With only center points, every squared term is the same column: report one pooled curvature term.
    const curvatureOnly = aliases.some(a => a.squares);
    if (curvatureOnly) terms.filter(t => t.kind === 'square').forEach(t => { t.label = 'Curv'; t.pooled = true; });
    const p = cols.length;
    const D = y.map((_, i) => cols.map(c => c[i]));
    const XtX = range(p).map(a => range(p).map(b => D.reduce((s, r) => s + r[a] * r[b], 0)));
    const inv = invert(XtX);
    const Xty = range(p).map(a => D.reduce((s, r, i) => s + r[a] * y[i], 0));
    const beta = inv ? inv.map(row => row.reduce((s, v, j) => s + v * Xty[j], 0)) : new Array(p).fill(0);
    const fitted = D.map(r => r.reduce((s, v, j) => s + v * beta[j], 0));
    const resid = y.map((v, i) => v - fitted[i]);
    const ym = mean(y);
    const sse = resid.reduce((s, v) => s + v * v, 0);
    const sst = y.reduce((s, v) => s + (v - ym) ** 2, 0);
    const dfe = n - p;
    const r2 = sst ? 1 - sse / sst : 0;
    const adjR2 = dfe > 0 && sst ? 1 - (sse / dfe) / (sst / (n - 1)) : null;
    let press = null;
    if (dfe > 0 && inv) {
      press = 0;
      for (let i = 0; i < n; i++) {
        const h = D[i].reduce((s, v, a) => s + v * D[i].reduce((t, w, b) => t + inv[a][b] * w, 0), 0);
        press += (resid[i] / Math.max(1e-9, 1 - h)) ** 2;
      }
    }
    const predR2 = press !== null && sst ? 1 - press / sst : null;

    let method, effects;
    if (dfe > 0 && inv) {
      method = 'Least squares with ' + dfe + ' degrees of freedom for error';
      const mse = sse / dfe;
      effects = terms.map((t, ti) => {
        const j = ti + 1, se = Math.sqrt(Math.max(0, mse * inv[j][j]));
        const tv = se ? beta[j] / se : Infinity;
        return { term: t.label, kind: t.kind, idx: t.idx, coef: beta[j], effect: 2 * beta[j], se, t: tv, p: tTestP(tv, dfe) };
      });
    } else {
      // Saturated design: no error estimate, so use Lenth's pseudo standard error.
      method = "Lenth's method (saturated design, no replicate error)";
      const c = terms.map((_, ti) => Math.abs(beta[ti + 1]));
      const s0 = 1.5 * median(c);
      const small = c.filter(v => v < 2.5 * s0);
      const pse = 1.5 * (small.length ? median(small) : s0) || 1e-12;
      const df = Math.max(1, terms.length / 3);
      effects = terms.map((t, ti) => {
        const tv = beta[ti + 1] / pse;
        return { term: t.label, kind: t.kind, idx: t.idx, coef: beta[ti + 1], effect: 2 * beta[ti + 1], se: pse, t: tv, p: tTestP(tv, df) };
      });
    }
    effects.forEach((e, i) => { if (terms.find(t => t.label === e.term && t.pooled)) e.name = 'Curvature'; });
    effects.forEach(e => { if (e.name) return; e.name = e.idx.length === 2 && e.idx[0] === e.idx[1] ? factors[e.idx[0]].name + '²' : e.idx.map(i => factors[i].name).join(' × '); });
    effects.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));

    // Curvature check from center points.
    const isCenter = x => x.every((v, i) => factors[i].categorical || Math.abs(v) < 1e-9);
    const isCorner = x => x.every(v => Math.abs(Math.abs(v) - 1) < 1e-9);
    const cy = y.filter((_, i) => isCenter(X[i])), fy = y.filter((_, i) => isCorner(X[i]));
    const hasSquares = terms.some(t => t.kind === 'square');
    let curvature = null;
    if (cy.length && fy.length) {
      const diff = mean(cy) - mean(fy);
      let pval = null;
      if (cy.length > 1) {
        const s2 = cy.reduce((s, v) => s + (v - mean(cy)) ** 2, 0) / (cy.length - 1);
        const se = Math.sqrt(s2 * (1 / cy.length + 1 / fy.length));
        pval = se ? tTestP(diff / se, cy.length - 1) : null;
      }
      curvature = { centerMean: mean(cy), cornerMean: mean(fy), diff, p: pval, nCenter: cy.length };
    }

    // Mean response at each level of each factor (main effects plot).
    const mainEffects = factors.map((f, i) => {
      const lv = Array.from(new Set(X.map(x => x[i]))).sort((a, b) => a - b);
      return { name: f.name, points: lv.map(c => ({ coded: c, actual: decode(f, c), mean: mean(y.filter((_, r) => X[r][i] === c)) })) };
    });

    const predict = x => cols.length && [1].concat(terms.map(t => termValue(t, x))).reduce((s, v, j) => s + v * beta[j], 0);

    // Interaction plot for the strongest interaction.
    const topInt = effects.find(e => e.kind === 'interaction');
    let interaction = null;
    if (topInt) {
      const [a, b] = topInt.idx;
      const base = factors.map(() => 0);
      interaction = {
        a: factors[a].name, b: factors[b].name, term: topInt.term, p: topInt.p,
        lines: [-1, 1].map(bv => ({
          bLevel: decode(factors[b], bv),
          points: [-1, 1].map(av => { const x = base.slice(); x[a] = av; x[b] = bv; return { aLevel: decode(factors[a], av), y: predict(x) }; })
        }))
      };
    }

    // Grid search inside the tested region for best settings.
    const grid = factors.map(f => (f.categorical ? [-1, 1] : k <= 6 ? [-1, -0.5, 0, 0.5, 1] : [-1, 0, 1]));
    let best = { max: null, min: null };
    const total = grid.reduce((s, g) => s * g.length, 1);
    if (total <= 200000) {
      const x = new Array(k).fill(0);
      const walk = d => {
        if (d === k) {
          const v = predict(x);
          if (!best.max || v > best.max.y) best.max = { y: v, x: x.slice() };
          if (!best.min || v < best.min.y) best.min = { y: v, x: x.slice() };
          return;
        }
        for (const g of grid[d]) { x[d] = g; walk(d + 1); }
      };
      walk(0);
    } else {
      const sign = s => factors.map((_, i) => { const e = effects.find(t => t.kind === 'main' && t.idx[0] === i); return e ? Math.sign(e.coef) * s || -1 : -1; });
      best.max = { x: sign(1), y: predict(sign(1)) }; best.min = { x: sign(-1), y: predict(sign(-1)) };
    }
    const describe = b => b && { y: b.y, settings: factors.map((f, i) => ({ name: f.name, coded: b.x[i], actual: decode(f, b.x[i]) })) };

    return {
      n, k, factors, terms: effects, aliases, curvatureOnly, method, r2, adjR2, predR2,
      s: dfe > 0 ? Math.sqrt(sse / dfe) : null, dfe, curvature, hasSquares,
      mainEffects, interaction, optimum: { max: describe(best.max), min: describe(best.min) },
      residuals: resid, fitted, y
    };
  }
  function unit(v) { const n = Math.sqrt(v.reduce((s, a) => s + a * a, 0)); return v.map(a => a / n); }
  function orthResidual(v, basis) {
    let r = v.slice();
    for (let pass = 0; pass < 2; pass++) for (const b of basis) {
      const d = r.reduce((s, a, i) => s + a * b[i], 0);
      r = r.map((a, i) => a - d * b[i]);
    }
    return r;
  }

  // ---------- Design generation ----------
  function fullFactorial(k) {
    const runs = [];
    for (let i = 0; i < 1 << k; i++) runs.push(range(k).map(j => ((i >> j) & 1 ? 1 : -1)));
    return runs;
  }
  // Standard minimum-aberration generators (letters index the base factors).
  const FRACTIONS = {
    '3-1': { gens: ['AB'], res: 'III' },
    '4-1': { gens: ['ABC'], res: 'IV' },
    '5-1': { gens: ['ABCD'], res: 'V' },
    '6-1': { gens: ['ABCDE'], res: 'VI' },
    '6-2': { gens: ['ABC', 'BCD'], res: 'IV' },
    '7-1': { gens: ['ABCDEF'], res: 'VII' },
    '7-3': { gens: ['ABC', 'BCD', 'ACD'], res: 'IV' },
    '8-4': { gens: ['BCD', 'ACD', 'ABC', 'ABD'], res: 'IV' }
  };
  function fractional(k, p) {
    const spec = FRACTIONS[k + '-' + p];
    if (!spec) return null;
    const base = fullFactorial(k - p);
    const runs = base.map(r => r.concat(spec.gens.map(g => g.split('').reduce((s, ch) => s * r[LETTERS.indexOf(ch)], 1))));
    const genText = spec.gens.map((g, i) => LETTERS[k - p + i] + ' = ' + g);
    return { runs, resolution: spec.res, generators: genText };
  }
  function plackettBurman(k) {
    const gens = {
      12: '++-+++---+-',
      20: '++--++++-+-+----++-'
    };
    const N = k <= 11 ? 12 : k <= 19 ? 20 : null;
    if (!N) return null;
    const g = gens[N].split('').map(c => (c === '+' ? 1 : -1));
    const runs = [];
    for (let i = 0; i < N - 1; i++) runs.push(range(N - 1).map(j => g[(j - i + N - 1) % (N - 1)]));
    runs.push(new Array(N - 1).fill(-1));
    return runs.map(r => r.slice(0, k));
  }
  function centralComposite(k, faceCentered) {
    const cube = k >= 5 ? fractional(k, 1).runs : fullFactorial(k);
    const alpha = faceCentered ? 1 : Math.pow(cube.length, 0.25);
    const axial = [];
    for (let i = 0; i < k; i++) for (const s of [-alpha, alpha]) { const r = new Array(k).fill(0); r[i] = s; axial.push(r); }
    return { runs: cube.concat(axial), alpha };
  }
  function boxBehnken(k) {
    if (k < 3 || k > 7) return null;
    const runs = [];
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const r = new Array(k).fill(0); r[i] = a; r[j] = b; runs.push(r);
    }
    return runs;
  }

  const DESIGNS = {
    full: { name: 'Full factorial (2 levels)', min: 1, max: 7, purpose: 'Estimates every main effect and every interaction. The gold standard when you have 2 to 4 factors.' },
    half: { name: 'Fractional factorial (half fraction)', min: 3, max: 7, purpose: 'Half the runs of a full factorial. Some interactions are confounded (aliased), so it suits 4 to 6 factors.' },
    res4: { name: 'Fractional factorial (16 runs, resolution IV)', min: 6, max: 8, purpose: 'Screens 6 to 8 factors in 16 runs. Main effects are clean; two-factor interactions are aliased with each other.' },
    pb: { name: 'Plackett-Burman screening', min: 2, max: 19, purpose: 'Screens many factors (up to 11 in 12 runs, 19 in 20 runs) to find the vital few. Main effects only.' },
    ccd: { name: 'Central composite (response surface)', min: 2, max: 6, purpose: 'Finds curvature and the sweet spot. Use after screening, on the 2 to 5 factors that matter.' },
    ccf: { name: 'Face-centered central composite', min: 2, max: 6, purpose: 'Response surface that never leaves the low-high box. Use when going beyond the limits is unsafe.' },
    bbd: { name: 'Box-Behnken (response surface)', min: 3, max: 7, purpose: 'Response surface with 3 levels per factor and no extreme corner runs. Good when corners are risky or costly.' }
  };

  /* factors: [{name, low, high}] ; opts: {type, centerPoints, replicates, randomize, seed} */
  function generate(factors, opts) {
    const k = factors.length;
    const type = opts.type;
    const spec = DESIGNS[type];
    if (!spec) throw new Error('Unknown design type');
    if (k < spec.min || k > spec.max) throw new Error(spec.name + ' needs ' + spec.min + ' to ' + spec.max + ' factors; you have ' + k + '.');
    let coded, notes = [];
    if (type === 'full') coded = fullFactorial(k);
    else if (type === 'half') {
      const f = fractional(k, 1); coded = f.runs;
      notes.push('Resolution ' + f.resolution + '. Generator: ' + f.generators.join(', ') + '.');
    } else if (type === 'res4') {
      const f = fractional(k, k - 4); coded = f.runs;
      notes.push('Resolution ' + f.resolution + '. Generators: ' + f.generators.join(', ') + '.');
    } else if (type === 'pb') {
      coded = plackettBurman(k);
      notes.push('Main effects are partly confounded with two-factor interactions. Follow up on the vital few.');
    } else if (type === 'ccd' || type === 'ccf') {
      const c = centralComposite(k, type === 'ccf'); coded = c.runs;
      notes.push('Axial distance alpha = ' + c.alpha.toFixed(3) + (type === 'ccd' ? ' (rotatable). Axial runs go beyond your low/high settings; check they are safe.' : ' (axial runs on the box faces).'));
    } else if (type === 'bbd') coded = boxBehnken(k);
    const reps = Math.max(1, opts.replicates || 1);
    let all = [];
    for (let r = 0; r < reps; r++) all = all.concat(coded.map(x => x.slice()));
    let centers = Math.max(0, opts.centerPoints || 0);
    if ((type === 'ccd' || type === 'ccf' || type === 'bbd') && centers < 3) { centers = Math.max(centers, 3); notes.push('At least 3 center points are included to estimate pure error and curvature.'); }
    for (let c = 0; c < centers; c++) all.push(new Array(k).fill(0));
    if ((type === 'ccd' || type === 'ccf' || type === 'bbd') && factors.some(f => f.categorical)) throw new Error('Response-surface designs need numeric factors. Hold categorical factors fixed or use a factorial design.');
    const rows = all.map((x, i) => ({ std: i + 1, coded: x, actual: x.map((c, j) => decodeRange(factors[j], c, i)) }));
    if (opts.randomize !== false) {
      const order = E.shuffle(range(rows.length), E.rng(opts.seed || Date.now()));
      order.forEach((ri, pos) => { rows[ri].run = pos + 1; });
      rows.sort((a, b) => a.run - b.run);
    } else rows.forEach(r => { r.run = r.std; });
    return { type, name: spec.name, purpose: spec.purpose, k, runs: rows, notes };
  }
  function decodeRange(f, c, i) {
    // Categorical factors have no middle; center runs alternate between the two levels.
    if (f.categorical) return c > 0 ? f.high : c < 0 ? f.low : (i % 2 ? f.high : f.low);
    const lo = Number(f.low), hi = Number(f.high);
    const v = (lo + hi) / 2 + c * (hi - lo) / 2;
    const step = Math.abs(hi - lo) / 1000 || 1e-6;
    const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))));
    return Number(v.toFixed(decimals));
  }

  // Picks a design for k factors given what the agent learned.
  function recommend(k, opts) {
    opts = opts || {};
    if (opts.curvature && k <= 5) return { type: 'ccd', centerPoints: 3, why: 'There is evidence of curvature, so a response-surface design will locate the sweet spot.' };
    if (k <= 4) return { type: 'full', centerPoints: 3, why: 'With ' + k + ' factors a full factorial is affordable (' + (1 << k) + ' runs) and shows every interaction. Center points test for curvature.' };
    if (k === 5) return { type: 'half', centerPoints: 3, why: '5 factors in 16 runs at resolution V: main effects and two-factor interactions are all clear.' };
    if (k <= 8) return { type: 'res4', centerPoints: 2, why: k + ' factors in 16 runs. Screens main effects cleanly; follow up on interactions of the factors that matter.' };
    return { type: 'pb', centerPoints: 0, why: k + ' candidate factors is a lot. A Plackett-Burman screen finds the vital few cheaply.' };
  }

  function toCSV(design, factors, responseName) {
    const esc = s => (/[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
    const head = ['RunOrder', 'StdOrder'].concat(factors.map(f => f.name)).concat([responseName || 'Response']);
    const lines = [head.map(esc).join(',')];
    for (const r of design.runs) lines.push([r.run, r.std].concat(r.actual).concat(['']).map(esc).join(','));
    return lines.join('\n') + '\n';
  }

  root.MLDoe = { detect, analyze, generate, recommend, toCSV, DESIGNS, fullFactorial, fractional, plackettBurman, centralComposite, boxBehnken, code, decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MLDoe;
})(typeof globalThis !== 'undefined' ? globalThis : this);
