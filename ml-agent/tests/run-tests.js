/* ML Agent tests. Run with: node --test ml-agent/tests/run-tests.js
   Covers parsing, models, DOE math, the agent's decisions, and a privacy lint that fails
   if code that could send or store data is ever added. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));
const D = require(path.join(ROOT, 'doe.js'));
const A = require(path.join(ROOT, 'agent.js'));
const S = require(path.join(ROOT, 'samples.js'));

test('CSV parser handles quotes, BOM, tabs and blank lines', () => {
  const t = E.parseCSV('﻿Name,Note,Value\r\n"Smith, J","said ""hi""",3\n\nLee,,4\n');
  assert.deepStrictEqual(t.columns, ['Name', 'Note', 'Value']);
  assert.deepStrictEqual(t.rows, [['Smith, J', 'said "hi"', '3'], ['Lee', '', '4']]);
  const tab = E.parseCSV('a\tb\n1\t2\n');
  assert.deepStrictEqual(tab.columns, ['a', 'b']);
  const semi = E.parseCSV('a;b\n1,5;2\n');
  assert.deepStrictEqual(semi.rows[0], ['1,5', '2']);
});

test('profiling detects numbers, categories, IDs and missing values', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(['ID' + i, String(i * 1.5), i % 3 ? 'A' : 'B', i === 4 ? 'NA' : '1,2' + (i % 10) + '0', '5']);
  const p = E.profile({ columns: ['Sample ID', 'Temp', 'Line', 'Count', 'Const'], rows });
  const kinds = p.columns.map(c => c.kind);
  assert.deepStrictEqual(kinds, ['id', 'numeric', 'categorical', 'numeric', 'constant']);
  assert.strictEqual(p.columns[3].missing, 1);
  assert.strictEqual(p.columns[3].values[0], 1200);
});

test('t-distribution p-values match tables', () => {
  assert.ok(Math.abs(E.tTestP(2.228, 10) - 0.05) < 0.001);
  assert.ok(Math.abs(E.tTestP(1.96, 1e6) - 0.05) < 0.001);
  assert.ok(Math.abs(E.tTestP(0, 5) - 1) < 1e-9);
});

function linearData(n, seed) {
  const rand = E.rng(seed), rows = [];
  for (let i = 0; i < n; i++) {
    const x1 = rand() * 10, x2 = rand() * 5, g = rand() < 0.5 ? 'P' : 'Q';
    rows.push([x1.toFixed(3), x2.toFixed(3), g, (3 * x1 - 2 * x2 + (g === 'Q' ? 4 : 0) + (rand() - 0.5) * 0.5).toFixed(3)]);
  }
  return { columns: ['x1', 'x2', 'grp', 'y'], rows };
}

test('linear regression recovers a known relationship', () => {
  const prof = E.profile(linearData(120, 1));
  const [x1, x2, grp, y] = prof.columns;
  const data = E.supervisedData(prof, y, [x1, x2, grp], 'regression');
  const model = E.MODELS.find(m => m.id === 'linear');
  const folds = E.makeFolds(data.rows.length, 5, E.rng(1));
  const oof = E.crossValidate(model, data, 'regression', folds, 5, 1);
  assert.ok(E.regressionMetrics(data.y, oof).r2 > 0.99);
});

test('every model runs and beats the baseline on a clear signal', () => {
  const prof = E.profile(linearData(150, 2));
  const [x1, x2, grp, y] = prof.columns;
  const data = E.supervisedData(prof, y, [x1, x2, grp], 'regression');
  const folds = E.makeFolds(data.rows.length, 5, E.rng(2));
  for (const m of E.MODELS.filter(m => m.task !== 'classification')) {
    const r2 = E.regressionMetrics(data.y, E.crossValidate(m, data, 'regression', folds, 5, 2)).r2;
    if (m.id === 'baseline') assert.ok(r2 < 0.05, 'baseline ' + r2);
    else assert.ok(r2 > 0.7, m.id + ' r2 ' + r2);
  }
  // Classification: label is whether y is above its median.
  const med = E.median(data.y);
  const cTable = { columns: ['x1', 'x2', 'grp', 'label'], rows: linearData(150, 2).rows.map(r => [r[0], r[1], r[2], Number(r[3]) > med ? 'High' : 'Low']) };
  const cp = E.profile(cTable);
  const cd = E.supervisedData(cp, cp.columns[3], cp.columns.slice(0, 3), 'classification');
  const cf = E.makeFolds(cd.rows.length, 5, E.rng(3), cd.y);
  for (const m of E.MODELS.filter(m => m.task !== 'regression' && (!m.applicable || m.applicable(150, 3, 'classification', 2)))) {
    const met = E.classificationMetrics(cd.y, E.crossValidate(m, cd, 'classification', cf, 5, 3), 2);
    if (m.id === 'baseline') assert.ok(met.balancedAccuracy <= 0.55);
    else assert.ok(met.balancedAccuracy > 0.8, m.id + ' ' + met.balancedAccuracy);
  }
});

test('k-means finds well separated groups', () => {
  const rand = E.rng(5), X = [];
  for (const c of [[0, 0], [10, 10], [0, 10]]) for (let i = 0; i < 30; i++) X.push([c[0] + rand(), c[1] + rand()]);
  const km = E.kmeans(X, 3, E.rng(1), 5);
  for (let g = 0; g < 3; g++) assert.strictEqual(new Set(km.labels.slice(g * 30, g * 30 + 30)).size, 1);
  assert.ok(E.silhouette(X, km.labels, 3, E.rng(1)) > 0.8);
});

test('DOE designs have the right size and balance', () => {
  assert.strictEqual(D.fullFactorial(3).length, 8);
  const half = D.fractional(5, 1);
  assert.strictEqual(half.runs.length, 16);
  assert.strictEqual(half.resolution, 'V');
  const pb = D.plackettBurman(11);
  assert.strictEqual(pb.length, 12);
  for (let j = 0; j < 11; j++) {
    assert.strictEqual(pb.reduce((s, r) => s + r[j], 0), 0, 'column ' + j + ' balanced');
    for (let k = j + 1; k < 11; k++) assert.strictEqual(pb.reduce((s, r) => s + r[j] * r[k], 0), 0, 'columns orthogonal');
  }
  const pb20 = D.plackettBurman(15);
  for (let j = 0; j < 15; j++) for (let k = j + 1; k < 15; k++) assert.strictEqual(pb20.reduce((s, r) => s + r[j] * r[k], 0), 0);
  for (const k of [6, 7, 8]) {
    const f = D.fractional(k, k - 4);
    assert.strictEqual(f.runs.length, 16);
    for (let j = 0; j < k; j++) for (let m = j + 1; m < k; m++) assert.strictEqual(f.runs.reduce((s, r) => s + r[j] * r[m], 0), 0);
  }
  const ccd = D.generate([{ name: 'A', low: 10, high: 20 }, { name: 'B', low: 1, high: 3 }], { type: 'ccd', centerPoints: 5, randomize: false });
  assert.strictEqual(ccd.runs.length, 4 + 4 + 5);
  assert.ok(Math.abs(ccd.runs[4].actual[0] - (15 - 5 * Math.SQRT2)) < 0.01, 'rotatable alpha = 1.414');
  const bbd = D.generate(['A', 'B', 'C'].map(n => ({ name: n, low: 0, high: 1 })), { type: 'bbd', centerPoints: 3, randomize: false });
  assert.strictEqual(bbd.runs.length, 15);
  const cat = D.generate([{ name: 'T', low: 100, high: 200 }, { name: 'Supplier', low: 'North', high: 'East', categorical: true }], { type: 'full', centerPoints: 2, seed: 4 });
  assert.strictEqual(cat.runs.length, 6);
  assert.ok(cat.runs.every(r => ['North', 'East'].includes(r.actual[1])));
  assert.throws(() => D.generate([{ name: 'A', low: 0, high: 1 }], { type: 'bbd' }));
  const csv = D.toCSV(cat, [{ name: 'T' }, { name: 'Supplier' }], 'Yield');
  assert.ok(csv.startsWith('RunOrder,StdOrder,T,Supplier,Yield\n'));
});

test('DOE analysis recovers known effects from a replicated 2^3 factorial', () => {
  const rows = [];
  const rand = E.rng(9);
  for (let rep = 0; rep < 2; rep++) for (const x of D.fullFactorial(3)) {
    const [a, b, c] = x;
    rows.push([String(50 + 10 * a), String(5 + b), c > 0 ? 'Fast' : 'Slow', String(100 + 4 * a - 3 * b + 2 * a * b + (rand() - 0.5) * 0.2)]);
  }
  const prof = E.profile({ columns: ['Temp', 'Time', 'Mode', 'Y'], rows });
  const det = D.detect(prof, prof.columns.slice(0, 3), prof.columns[3]);
  assert.ok(det.isDOE, det.reason);
  const res = D.analyze(det, prof.columns[3]);
  const eff = n => res.terms.find(t => t.name === n);
  assert.ok(Math.abs(eff('Temp').effect - 8) < 0.2);
  assert.ok(Math.abs(eff('Time').effect + 6) < 0.2);
  assert.ok(Math.abs(eff('Temp × Time').effect - 4) < 0.2);
  assert.ok(eff('Temp').p < 0.001 && eff('Mode').p > 0.05);
  assert.strictEqual(res.optimum.max.settings[0].actual, 60);
});

test('DOE analysis flags aliasing in a half fraction', () => {
  const f = D.fractional(4, 1);
  const rows = f.runs.map(x => x.map(String).concat([String(10 + 3 * x[0] + 2 * x[1])]));
  const prof = E.profile({ columns: ['A', 'B', 'C', 'D', 'Y'], rows });
  const det = D.detect(prof, prof.columns.slice(0, 4), prof.columns[4]);
  const res = D.analyze(det, prof.columns[4]);
  assert.ok(res.aliases.length >= 3, 'two-factor interactions are aliased in pairs');
});

test('the agent picks the right task for each practice dataset', async () => {
  const expect = { molding: 'regression', factorial: 'regression', batches: 'classification', segments: 'clustering' };
  for (const s of S) {
    const rep = await A.run(E.parseCSV(s.make()), { target: s.target });
    assert.strictEqual(rep.task, expect[s.id], s.id);
    assert.ok(rep.insights.length > 0 && rep.nextSteps.length > 0);
    if (s.id === 'factorial') {
      assert.ok(rep.doe, 'factorial detected as a DOE');
      const sig = rep.doe.terms.filter(t => t.p < 0.05).map(t => t.name);
      assert.ok(sig.includes('Temperature') && sig.includes('Catalyst') && sig.includes('Temperature × Catalyst'));
    }
    if (s.id === 'molding') {
      assert.ok(rep.best.metrics.r2 > 0.8);
      assert.strictEqual(rep.importance[0].name, 'MeltTemp');
      assert.ok(rep.doeRecommendation && rep.doeRecommendation.factors.length >= 2);
    }
    if (s.id === 'segments') assert.strictEqual(rep.clustering.k, 3);
  }
});

test('the agent gives a clear error instead of crashing on bad input', async () => {
  await assert.rejects(A.run({ columns: ['a', 'b'], rows: [] }, {}), /No data rows/);
  await assert.rejects(A.run(E.parseCSV('id,y\n1,2\n2,3\n3,4\n'), { target: 'y' }), /No usable input|at least 8/);
});

// ---------- Privacy lint ----------
// Fails if any code that could send data off the device or keep it after the tab closes
// appears in the app. The privacy self-test probes are the only allowed exceptions, and
// each such line must carry the PRIVACY-SELF-TEST marker.
test('privacy lint: no network, storage or tracking code', () => {
  const forbidden = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/, /localStorage/, /sessionStorage/,
    /indexedDB/, /document\.cookie/, /serviceWorker/, /new\s+Worker/, /importScripts/, /new\s+Image\b/, /https?:\/\//, /\.src\s*=/, /window\.open/, /postMessage/];
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('PRIVACY-SELF-TEST')) return;
      const code = line.replace(/\/\/.*$/, '').replace(/'http:\/\/www\.w3\.org\/2000\/svg'/, '');
      for (const re of forbidden) if (re.test(code)) hits.push(f + ':' + (i + 1) + ' ' + re + ' → ' + line.trim());
    });
  }
  assert.deepStrictEqual(hits, []);
  const marked = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').split('\n').filter(l => l.includes('PRIVACY-SELF-TEST'));
  assert.ok(marked.every(l => /example\.com|new Image|document\.cookie/.test(l)), 'self-test lines only probe example.com');
});

test('privacy lint: every page locks itself down and loads nothing from other servers', () => {
  for (const page of ['index.html', 'learn.html']) checkPage(page);
});
function checkPage(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  for (const rule of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "script-src 'self'", "img-src data: blob:", "base-uri 'none'"]) {
    assert.ok(csp.includes(rule), 'CSP must include ' + rule);
  }
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), 'no unsafe CSP keywords');
  const srcs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  for (const s of srcs) assert.ok(!/^(https?:)?\/\//.test(s), 'external resource: ' + s);
  assert.ok(!/<script>[^<]/.test(html), 'no inline scripts');
  assert.ok(!/\son[a-z]+="/.test(html), 'no inline event handlers');
}

test('round trip: a generated run sheet, once filled in, is analyzed as a DOE', async () => {
  const factors = [{ name: 'Temp', low: 150, high: 180 }, { name: 'Time', low: 30, high: 60 }, { name: 'Supplier', low: 'North', high: 'East', categorical: true }];
  const design = D.generate(factors, { type: 'full', centerPoints: 4, replicates: 1, seed: 3 });
  const rand = E.rng(8);
  const lines = D.toCSV(design, factors, 'Yield').trim().split('\n');
  const filled = [lines[0]].concat(design.runs.map((r, i) => {
    const a = (r.actual[0] - 165) / 15, b = (r.actual[1] - 45) / 15;
    return lines[i + 1] + (60 + 5 * a + 2 * b + (r.actual[2] === 'East' ? 1 : 0) + (rand() - 0.5) * 0.4).toFixed(2);
  })).join('\n');
  const rep = await A.run(E.parseCSV(filled), { target: 'Yield' });
  assert.ok(rep.doe, 'detected as a designed experiment');
  assert.ok(rep.dropped.some(d => d.name === 'RunOrder') && rep.dropped.some(d => d.name === 'StdOrder'));
  const temp = rep.doe.terms.find(t => t.name === 'Temp');
  assert.ok(Math.abs(temp.effect - 10) < 0.5 && temp.p < 0.01);
});

test('action plan turns drivers into plain-English moves', async () => {
  const get = id => S.find(s => s.id === id);
  const mold = await A.run(E.parseCSV(get('molding').make()), { target: 'Yield', goal: 'max' });
  const items = mold.actionPlan.items;
  const temp = items.find(i => i.factor === 'MeltTemp');
  assert.strictEqual(temp.verb, 'Target', 'MeltTemp has a sweet spot');
  const mat = items.find(i => i.factor === 'Material');
  assert.ok(mat && /Resin C/.test(mat.text) && /Resin B/.test(mat.text), 'best and worst material named');
  assert.ok(items.find(i => i.factor === 'Pressure').verb === 'Increase');
  assert.ok(/would average/.test(mold.actionPlan.combined));
  // Flipping the goal flips the advice.
  const low = await A.run(E.parseCSV(get('molding').make()), { target: 'Yield', goal: 'min' });
  assert.strictEqual(low.actionPlan.items.find(i => i.factor === 'Pressure').verb, 'Decrease');

  const doe = await A.run(E.parseCSV(get('factorial').make()), { target: 'Yield' });
  assert.ok(doe.actionPlan.items.some(i => i.factor === 'Temperature' && i.verb === 'Increase'));
  assert.ok(doe.actionPlan.items.some(i => i.verb === 'Combine'), 'interaction becomes a "change together" action');
  assert.ok(doe.actionPlan.quiet.includes('Time'));

  const bat = await A.run(E.parseCSV(get('batches').make()), { target: 'Result' });
  assert.strictEqual(bat.classes[bat.favorable], 'Pass');
  assert.ok(bat.actionPlan.items.some(i => i.factor === 'Temperature' && i.verb === 'Decrease'));
  assert.ok(bat.explain.tree && bat.explain.trees.length === 3);
});

test('favorable outcome is guessed sensibly', () => {
  assert.strictEqual(A.guessFavorable(['Fail', 'Pass']), 1);
  assert.strictEqual(A.guessFavorable(['Late', 'OnTime']), 1);
  assert.strictEqual(A.guessFavorable(['Defect', 'OK']), 1);
  assert.strictEqual(A.guessFavorable(['Churned', 'Stayed']), 1);
  assert.strictEqual(A.guessFavorable(['0', '1']), 1);
});

test('every "learn more" link points to a lesson that exists', () => {
  const X = require(path.join(ROOT, 'explain.js'));
  const learn = fs.readFileSync(path.join(ROOT, 'learn.js'), 'utf8');
  const ids = new Set([...learn.matchAll(/id: '([a-z-]+)', group/g)].map(m => m[1]));
  assert.ok(ids.size >= 20, ids.size + ' lessons');
  for (const t of Object.values(X.MODEL_TOPIC)) assert.ok(ids.has(t), 'model topic ' + t);
  for (const [k, v] of Object.entries(X.READ)) assert.ok(ids.has(v[2]), 'chart ' + k + ' → ' + v[2]);
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
  for (const m of app.matchAll(/learnLink\('([a-z-]+)'/g)) assert.ok(ids.has(m[1]), 'link ' + m[1]);
});

test('columns that copy the target (data leakage) are set aside', async () => {
  const rand = E.rng(12), rows = [];
  for (let i = 0; i < 200; i++) {
    const t = 150 + rand() * 100, pass = (t > 190 && rand() > 0.2) ? 'Pass' : 'Fail';
    rows.push([t.toFixed(1), (rand() * 10).toFixed(2), pass === 'Pass' ? 'released' : 'scrapped', pass]);
  }
  const rep = await A.run({ columns: ['Temp', 'Noise', 'Disposition', 'Result'], rows }, { target: 'Result' });
  assert.ok(rep.dropped.some(d => d.name === 'Disposition' && /copy of the result/.test(d.reason)));
  assert.ok(!rep.features.includes('Disposition') && rep.features.includes('Temp'));
  assert.ok(rep.best.metrics.balancedAccuracy < 0.99, 'no fake perfect score');
  // A real but strong driver is not flagged.
  const reg = await A.run(E.parseCSV(S.find(s => s.id === 'molding').make()), { target: 'Yield' });
  assert.ok(!(reg.leaks || []).length);
});
