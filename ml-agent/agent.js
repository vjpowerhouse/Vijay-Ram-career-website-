/* ML Agent orchestrator: decides what kind of problem the data is, runs every suitable
   model with cross-validation, picks the winner, and writes plain-language findings and
   next steps (including a recommended DOE). Rule-based: no LLM, no network, no storage. */
(function (root) {
  'use strict';
  const E = root.MLEngine || require('./engine.js');
  const D = root.MLDoe || require('./doe.js');
  const { range, mean, rng, shuffle, pearson } = E;

  const MAX_ROWS = 3000;
  const TARGET_NAME = /^(y|target|response|output|outcome|label|class|result|yield|quality|pass|passfail|pass\/fail|defects?|score|price|sales|revenue)$/i;
  const tick = () => new Promise(r => setTimeout(r, 0));

  function guessTarget(prof) {
    const usable = prof.columns.filter(E.isUsableFeature);
    const byName = usable.find(c => TARGET_NAME.test(c.name.trim()));
    if (byName) return byName.name;
    return usable.length ? usable[usable.length - 1].name : null;
  }
  function decideTask(col, override) {
    if (override === 'regression' && col.kind === 'numeric') return 'regression';
    if (override === 'classification') return 'classification';
    if (col.kind === 'categorical') return 'classification';
    return col.unique <= 2 ? 'classification' : 'regression';
  }
  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    const a = Math.abs(v);
    const digits = d !== undefined ? d : a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  }
  function pct(v) { return isFinite(v) ? Math.round(v * 100) + '%' : '–'; }

  /* table: {columns, rows}; options: {target ('' = auto, '__none__' = find patterns),
     task ('auto'|'regression'|'classification'), exclude: [names], goal ('max'|'min'), seed } */
  async function run(table, options, onProgress) {
    options = options || {};
    const progress = onProgress || (() => {});
    const seed = options.seed || 42;
    const log = [];
    const say = (text, kind) => { log.push({ text, kind: kind || 'step' }); progress({ log: log.slice() }); };

    const prof = E.profile(table);
    if (!prof.nRows) throw new Error('No data rows found. Check that the first row holds column names.');
    say('Read ' + prof.nRows.toLocaleString() + ' rows and ' + prof.nCols + ' columns.');
    const exclude = new Set(options.exclude || []);
    const report0 = {};
    const dropped = [];
    for (const c of prof.columns) {
      if (exclude.has(c.name)) dropped.push({ name: c.name, reason: 'excluded by you' });
      else if (c.kind === 'id') dropped.push({ name: c.name, reason: 'looks like an ID or row counter' });
      else if (c.kind === 'constant') dropped.push({ name: c.name, reason: 'has only one value' });
      else if (c.kind === 'empty') dropped.push({ name: c.name, reason: 'is empty' });
      else if (c.kind === 'text') dropped.push({ name: c.name, reason: 'is free text or has too many categories' });
    }
    if (dropped.length) say('Set aside ' + dropped.length + ' column' + (dropped.length > 1 ? 's' : '') + ': ' + dropped.map(d => d.name + ' (' + d.reason + ')').join('; ') + '.');

    let targetName = options.target === '__none__' ? null : options.target || guessTarget(prof);
    const targetCol = targetName ? prof.columns.find(c => c.name === targetName) : null;
    if (targetName && !targetCol) throw new Error('Target column "' + targetName + '" not found.');
    if (targetCol && !E.isUsableFeature(targetCol)) throw new Error('"' + targetName + '" cannot be predicted: it ' + (dropped.find(d => d.name === targetName) || { reason: 'is not usable' }).reason + '.');
    let features = prof.columns.filter(c => c !== targetCol && E.isUsableFeature(c) && !exclude.has(c.name));
    if (targetCol) {
      const leaks = findLeaks(prof, targetCol, features, decideTask(targetCol, options.task));
      for (const l of leaks) {
        dropped.push({ name: l.name, reason: 'predicts ' + targetCol.name + ' almost perfectly on its own (' + l.why + '), so it is probably a copy of the result or recorded after it' });
        say('Set aside "' + l.name + '": it predicts "' + targetCol.name + '" almost perfectly on its own (' + l.why + '). That usually means it is a copy of the result or recorded after the fact (data leakage), which would make every model look perfect.', 'result');
      }
      features = features.filter(c => !leaks.some(l => l.name === c.name));
      report0.leaks = leaks;
    }
    if (!features.length) throw new Error('No usable input columns left. Include at least one numeric or category column besides the target.');

    const report = Object.assign(report0, { profile: prof, dropped, log, features: features.map(c => c.name), goal: options.goal || 'max', seed });
    report.correlations = correlations(prof, features.concat(targetCol && targetCol.kind === 'numeric' ? [targetCol] : []));

    if (!targetCol) {
      report.task = 'clustering';
      say('No target chosen, so this is unsupervised learning: looking for natural groups, hidden structure and unusual rows.');
      await tick();
      report.clustering = await cluster(prof, features, seed, say);
    } else {
      report.task = decideTask(targetCol, options.task);
      report.target = targetCol.name;
      say('Target is "' + targetCol.name + '" (' + (targetCol.kind === 'numeric' ? 'numeric, ' + targetCol.unique + ' distinct values' : targetCol.unique + ' categories') + '), so this is ' +
        (report.task === 'regression' ? 'a regression problem: predict a number.' : 'a classification problem: predict a category.'));
      if (report.task === 'classification' && targetCol.unique > 20) throw new Error('"' + targetCol.name + '" has ' + targetCol.unique + ' categories. Pick a target with 20 or fewer, or treat it as a number.');
      await supervised(report, prof, targetCol, features, seed, say, progress);
    }
    report.actionPlan = actionPlan(report);
    report.insights = insights(report, prof, targetCol, features);
    report.nextSteps = nextSteps(report, prof, targetCol, features);
    say('Done. Findings and next steps are ready.', 'done');
    return report;
  }

  /* Data leakage: an input that on its own almost exactly reproduces the target (for example
     "alive" next to "survived", or "total_price" next to "price"). */
  function findLeaks(prof, target, features, task) {
    const out = [];
    const rows = range(prof.nRows).filter(r => target.values[r] !== null);
    if (rows.length < 20) return out;
    for (const c of features) {
      const rr = rows.filter(r => c.values[r] !== null);
      if (rr.length < 0.8 * rows.length) continue;
      if (task === 'regression') {
        if (c.kind !== 'numeric') continue;
        const r = pearson(rr.map(i => c.values[i]), rr.map(i => target.values[i]));
        if (Math.abs(r) >= 0.995) out.push({ name: c.name, why: 'correlation ' + r.toFixed(3) });
      } else {
        if (c.kind === 'numeric' && c.unique > 20) continue;
        // Purity: share of rows whose class is the most common class for their value of c.
        const tab = {};
        for (const i of rr) { const k = String(c.values[i]), t = String(target.values[i]); (tab[k] = tab[k] || {})[t] = (tab[k][t] || 0) + 1; }
        const keys = Object.keys(tab);
        if (keys.length > Math.max(2, rr.length / 10)) continue;
        const hit = keys.reduce((s, k) => s + Math.max(...Object.values(tab[k])), 0) / rr.length;
        const base = Math.max(...Object.values(rr.reduce((m, i) => { const t = String(target.values[i]); m[t] = (m[t] || 0) + 1; return m; }, {}))) / rr.length;
        if (hit >= 0.99 && base < 0.95) out.push({ name: c.name, why: pct(hit) + ' match' });
      }
    }
    return out;
  }

  function correlations(prof, cols) {
    const num = cols.filter(c => c.kind === 'numeric');
    const out = [];
    for (let i = 0; i < num.length; i++) for (let j = i + 1; j < num.length; j++) {
      const rows = range(prof.nRows).filter(r => num[i].values[r] !== null && num[j].values[r] !== null);
      if (rows.length < 5) continue;
      out.push({ a: num[i].name, b: num[j].name, r: pearson(rows.map(r => num[i].values[r]), rows.map(r => num[j].values[r])) });
    }
    return out.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  }

  async function supervised(report, prof, targetCol, features, seed, say, progress) {
    const task = report.task;
    let data = E.supervisedData(prof, targetCol, features, task);
    const missingTarget = prof.nRows - data.rows.length;
    if (missingTarget) say(missingTarget + ' row' + (missingTarget > 1 ? 's have' : ' has') + ' no value for the target and were skipped.');
    if (data.rows.length < 8) throw new Error('Only ' + data.rows.length + ' rows have a target value. The agent needs at least 8.');
    if (data.rows.length > MAX_ROWS) {
      const keep = shuffle(range(data.rows.length), rng(seed)).slice(0, MAX_ROWS).sort((a, b) => a - b);
      data = Object.assign({}, data, { rows: keep.map(i => data.rows[i]), y: keep.map(i => data.y[i]) });
      report.sampled = MAX_ROWS;
      say('Large file: using a random sample of ' + MAX_ROWS.toLocaleString() + ' rows so it runs quickly in your browser.');
    }
    report.classes = data.classes;
    report.nUsed = data.rows.length;

    // DOE check first: designed experiments get a classic effects analysis too.
    if (task === 'regression') {
      const det = D.detect(prof, features, targetCol);
      if (det.isDOE) {
        report.doe = D.analyze(det, targetCol);
        const lv = det.factors.map(f => f.levels.length);
        say('This looks like a designed experiment: ' + det.factors.length + ' factors at ' + Array.from(new Set(lv)).join('/') + ' levels in ' + det.rows.length + ' runs, with factors that do not move together. Ran a DOE effects analysis.');
      } else report.doeCheck = det.reason;
    }

    const n = data.rows.length;
    const K = data.classes ? data.classes.length : 0;
    const k = n <= 20 ? n : n <= 100 ? 10 : 5;
    const folds = E.makeFolds(n, k, rng(seed), task === 'classification' ? data.y : null);
    report.folds = k;
    say('Testing models with ' + (k === n ? 'leave-one-out' : k + '-fold') + ' cross-validation: each model is scored only on rows it never saw while learning.');

    const p = features.length;
    const models = E.MODELS.filter(m => (m.task === 'both' || m.task === task) && (!m.applicable || m.applicable(n, p, task, K)));
    const board = [];
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      progress({ log: report.log.slice(), model: m.name, done: i, total: models.length });
      await tick();
      const t0 = Date.now();
      try {
        const oof = E.crossValidate(m, data, task, folds, k, seed);
        const metrics = task === 'regression' ? E.regressionMetrics(data.y, oof) : E.classificationMetrics(data.y, oof, K);
        board.push({ id: m.id, name: m.name, plain: m.plain, complexity: m.complexity, metrics, oof, ms: Date.now() - t0 });
      } catch (err) {
        board.push({ id: m.id, name: m.name, plain: m.plain, complexity: m.complexity, error: String(err && err.message || err) });
      }
    }
    const key = task === 'regression' ? 'r2' : 'balancedAccuracy';
    const ok = board.filter(b => b.metrics);
    ok.sort((a, b) => b.metrics[key] - a.metrics[key]);
    const top = ok.filter(b => b.id !== 'baseline')[0] || ok[0];
    // Parsimony: among models within 0.01 of the top score, keep the simplest.
    const close = ok.filter(b => b.id !== 'baseline' && top.metrics[key] - b.metrics[key] <= 0.01);
    const best = close.sort((a, b) => a.complexity - b.complexity)[0] || top;
    report.leaderboard = ok.concat(board.filter(b => b.error));
    report.metricKey = key;
    report.best = best;
    report.bestReason = best === top ? 'highest cross-validated score' : 'within 0.01 of the top score (' + top.name + ') but simpler, so easier to trust and explain';
    say('Best model: ' + best.name + ' (' + report.bestReason + ').', 'result');

    // Refit the winner on all rows for drivers and what-if predictions.
    await tick();
    const model = E.MODELS.find(m => m.id === best.id);
    const full = E.fitFull(model, data, task, seed);
    const trainPred = full.fitted.predict(full.X);
    report.trainMetrics = task === 'regression' ? E.regressionMetrics(data.y, trainPred) : E.classificationMetrics(data.y, trainPred, K);
    report.importance = best.id === 'baseline' ? [] : E.permutationImportance(full, data, task, seed);
    const totalImp = report.importance.reduce((s, v) => s + v.importance, 0) || 1;
    report.importance.forEach(v => { v.share = v.importance / totalImp; });
    if (task === 'classification') {
      const g = String(report.goal || '');
      let fav = g.indexOf('class:') === 0 ? data.classes.indexOf(g.slice(6)) : -1;
      if (fav < 0) fav = guessFavorable(data.classes);
      report.favorable = fav;
    }
    // How the result moves with each top driver, other things equal.
    report.pd = [];
    for (const imp of report.importance.filter(v => v.share >= 0.03).slice(0, 6)) {
      const col = features.find(c => c.name === imp.name);
      const pdv = col && E.partialDependence(full, data, col, report.favorable);
      if (pdv) { pdv.share = imp.share; report.pd.push(pdv); }
    }
    await tick();
    explainModel(report, full, data, best, task, K);
    // Average prediction over past rows with some columns overridden (the "apply all" estimate).
    const sample = data.rows.filter((_, i) => i % Math.max(1, Math.ceil(data.rows.length / 400)) === 0);
    report.averageWith = overrides => {
      const X = sample.map(r => { const o = {}; for (const p of full.enc.parts) o[p.col.name] = p.col.values[r]; return full.enc.encodeValues(Object.assign(o, overrides)); });
      const pr = full.fitted.predictProba ? full.fitted.predictProba(X).map(q => q[report.favorable]) : full.fitted.predict(X);
      return E.mean(pr);
    };
    report.actual = data.y;
    report.targetSD = E.sd(task === 'regression' ? data.y : []);
    report.predict = values => {
      const x = full.enc.encodeValues(values);
      if (full.fitted.predictProba) { const pr = full.fitted.predictProba([x])[0]; return { proba: pr, label: data.classes[pr.indexOf(Math.max.apply(null, pr))] }; }
      return { value: full.fitted.predict([x])[0] };
    };
  }

  async function cluster(prof, features, seed, say) {
    let rows = range(prof.nRows);
    if (rows.length > MAX_ROWS) rows = shuffle(rows, rng(seed)).slice(0, MAX_ROWS).sort((a, b) => a - b);
    if (rows.length < 6) throw new Error('Need at least 6 rows to look for groups.');
    const enc = E.fitEncoder(features, rows);
    const X = enc.transform(rows);
    const tries = [];
    const kMax = Math.min(6, rows.length - 1);
    for (let k = 2; k <= kMax; k++) {
      await tick();
      const km = E.kmeans(X, k, rng(seed + k), 5);
      tries.push({ k, inertia: km.inertia, silhouette: E.silhouette(X, km.labels, k, rng(seed)), km });
    }
    // A "group" of one or two rows is an outlier, not a segment, so such splits rank last.
    const minSize = Math.max(3, Math.ceil(0.02 * rows.length));
    const tiny = t => range(t.k).some(c => t.km.labels.filter(l => l === c).length < minSize);
    const best = tries.slice().sort((a, b) => (tiny(a) - tiny(b)) || b.silhouette - a.silhouette)[0];
    say('Tried 2 to ' + kMax + ' groups with k-means. ' + best.k + ' groups separate best (silhouette ' + best.silhouette.toFixed(2) + ' on a -1 to 1 scale).', 'result');
    const pc = X[0].length >= 2 ? E.pca(X) : null;
    if (pc) say('Principal components: the first two directions capture ' + pct(pc.explained[0] + pc.explained[1]) + ' of the spread.');

    // Profile each cluster: which columns make it different from the overall average.
    const labels = best.km.labels;
    const profiles = range(best.k).map(c => {
      const members = rows.filter((_, i) => labels[i] === c);
      const traits = [];
      for (const col of features) {
        if (col.kind === 'numeric') {
          const vals = members.map(r => col.values[r]).filter(v => v !== null);
          const z = col.stats.sd ? (mean(vals) - col.stats.mean) / col.stats.sd : 0;
          traits.push({ name: col.name, z, text: (z > 0 ? 'higher' : 'lower') + ' ' + col.name + ' (avg ' + fmt(mean(vals)) + ' vs ' + fmt(col.stats.mean) + ')', mean: mean(vals) });
        } else {
          const counts = {}; for (const r of members) { const v = col.values[r]; if (v !== null) counts[v] = (counts[v] || 0) + 1; }
          const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
          if (!top) continue;
          const share = counts[top] / members.length, overall = (col.counts[top] || 0) / (prof.nRows - col.missing);
          traits.push({ name: col.name, z: (share - overall) * 3, text: pct(share) + ' are ' + col.name + ' = ' + top + ' (vs ' + pct(overall) + ' overall)' });
        }
      }
      traits.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      return { cluster: c + 1, size: members.length, share: members.length / rows.length, traits: traits.slice(0, 3), means: traits };
    });

    // Unusual rows: far from their own cluster center.
    const dist = X.map((x, i) => Math.sqrt(x.reduce((s, v, j) => s + (v - best.km.centers[labels[i]][j]) ** 2, 0)));
    const md = E.median(dist), mad = E.median(dist.map(d => Math.abs(d - md))) || 1e-9;
    const outliers = dist.map((d, i) => ({ row: rows[i] + 2, score: (d - md) / (1.4826 * mad) }))
      .filter(o => o.score > 3.5).sort((a, b) => b.score - a.score);

    return {
      k: best.k, silhouette: best.silhouette, tries: tries.map(t => ({ k: t.k, inertia: t.inertia, silhouette: t.silhouette, tiny: tiny(t) })),
      labels, rows, profiles, outliers, pca: pc && { explained: pc.explained, scores: pc.scores, loadings: pc.loadings, labels: enc.labels }
    };
  }

  // ---------- Plain-language findings ----------
  function insights(rep, prof, targetCol, features) {
    const out = [];
    const add = (level, text) => out.push({ level, text });
    const n = rep.nUsed || prof.nRows;
    if (n < 30) add('warn', 'Only ' + n + ' rows. Treat results as directional; small samples can mislead. A planned experiment gets more from few runs than historical data does.');
    else if (features.length && n < 10 * features.length) add('warn', n + ' rows for ' + features.length + ' inputs. Rule of thumb is 10+ rows per input; more data would firm up the results.');
    for (const l of rep.leaks || []) add('warn', '"' + l.name + '" was set aside because it matches ' + rep.target + ' almost exactly on its own (' + l.why + '). It is most likely recorded after the result or derived from it. If it truly is an input you control, you do not need machine learning for it: it already decides the result.');
    const gappy = prof.columns.filter(c => c.n && c.missing / c.n > 0.05 && c.kind !== 'empty');
    if (gappy.length) add('warn', 'Missing values in ' + gappy.map(c => c.name + ' (' + pct(c.missing / c.n) + ')').join(', ') + '. Gaps were filled with the median or most common value. Fix at the source if you can.');
    const strong = (rep.correlations || []).filter(c => Math.abs(c.r) >= 0.85 && c.a !== rep.target && c.b !== rep.target);
    if (strong.length) add('warn', 'Inputs that move together: ' + strong.slice(0, 3).map(c => c.a + ' & ' + c.b + ' (r = ' + c.r.toFixed(2) + ')').join(', ') + '. Historical data cannot tell which one is the real driver. A DOE can, because it sets them independently.');

    if (rep.task === 'regression' || rep.task === 'classification') {
      const b = rep.best, key = rep.metricKey;
      const base = rep.leaderboard.find(m => m.id === 'baseline');
      if (rep.task === 'regression') {
        const r2 = b.metrics.r2;
        const verdict = r2 >= 0.8 ? 'strong' : r2 >= 0.5 ? 'moderate' : r2 >= 0.2 ? 'weak' : 'very weak';
        add(r2 >= 0.5 ? 'good' : 'warn', b.name + ' explains ' + pct(Math.max(0, r2)) + ' of the variation in ' + rep.target + ' on unseen rows (' + verdict + '). Typical prediction error is ±' + fmt(b.metrics.rmse) + '.');
        if (r2 < 0.2) add('warn', 'The inputs here do not explain much. Key drivers are probably missing from the data (raw material, operator, environment, measurement). Run a fishbone with the team to find candidates.');
      } else {
        const acc = b.metrics.accuracy, bal = b.metrics.balancedAccuracy;
        add(bal >= 0.7 ? 'good' : 'warn', b.name + ' classifies ' + pct(acc) + ' of unseen rows correctly (balanced accuracy ' + pct(bal) + ', vs ' + pct(base ? base.metrics.balancedAccuracy : 1 / rep.classes.length) + ' by guessing).');
        const counts = {}; rep.actual.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
        const minority = Math.min.apply(null, Object.values(counts)) / rep.actual.length;
        if (minority < 0.15) add('warn', 'Classes are imbalanced: the rarest class is only ' + pct(minority) + ' of rows. Judge the model on balanced accuracy and on how well it catches the rare class (see the confusion matrix).');
      }
      if (base && b.id !== 'baseline' && b.metrics[key] - base.metrics[key] < 0.02) add('warn', 'The best model barely beats guessing. The inputs carry little signal about ' + rep.target + '.');
      const gap = rep.task === 'regression' ? rep.trainMetrics.r2 - b.metrics.r2 : rep.trainMetrics.balancedAccuracy - b.metrics.balancedAccuracy;
      if (gap > 0.2) add('info', 'The winner scores ' + pct(gap) + ' better on data it learned from than on unseen data. Some of what it learned is noise; trust the cross-validated score, not the training score.');
      const lin = rep.leaderboard.find(m => m.id === (rep.task === 'regression' ? 'linear' : 'logistic'));
      const nonlin = rep.leaderboard.filter(m => ['quadratic', 'forest', 'boosting', 'tree', 'knn'].includes(m.id) && m.metrics);
      const bestNon = nonlin.sort((a, c) => c.metrics[key] - a.metrics[key])[0];
      if (lin && lin.metrics && bestNon && bestNon.metrics[key] - lin.metrics[key] > 0.05) {
        rep.nonlinear = true;
        add('info', 'Curved or interacting models beat the straight-line model by ' + pct(bestNon.metrics[key] - lin.metrics[key]) + '. Expect sweet spots or factor interactions. A DOE should include center points and interaction terms.');
      } else if (lin && lin.metrics && bestNon) add('info', 'A straight-line model does about as well as complex ones. The relationships are close to linear, which makes them easy to act on.');
      const top = (rep.importance || []).filter(v => v.share > 0.05).slice(0, 3);
      if (top.length) add('good', 'Top drivers of ' + rep.target + ': ' + top.map(t => t.name + ' (' + pct(t.share) + ' of importance)').join(', ') + '.');
    }
    if (rep.doe) {
      const a = rep.doe;
      const sig = a.terms.filter(t => t.p < 0.05);
      add(sig.length ? 'good' : 'warn', sig.length ? 'DOE: significant effects (p < 0.05): ' + sig.map(t => t.name + ' (effect ' + (t.effect >= 0 ? '+' : '') + fmt(t.effect) + ')').join(', ') + '.' : 'DOE: no effect is significant at p < 0.05. The factor ranges may be too narrow, or noise too high; consider replicates.');
      add('info', 'DOE model R² = ' + pct(a.r2) + (a.adjR2 !== null ? ', adjusted ' + pct(a.adjR2) : '') + (a.predR2 !== null ? ', predicted ' + pct(Math.max(0, a.predR2)) : '') + '. ' + a.method + '.');
      if (a.curvature && a.curvature.p !== null && a.curvature.p < 0.05) add('warn', 'Curvature: center points average ' + fmt(a.curvature.centerMean) + ' vs ' + fmt(a.curvature.cornerMean) + ' at the corners (p = ' + a.curvature.p.toFixed(3) + '). The response is not a flat plane, so there may be a sweet spot inside the range.');
      if (a.curvatureOnly) add('info', 'Center points show whether the response curves, but not which factor causes it, so all squared terms are pooled into one "Curvature" term.');
      const aliases = a.aliases.filter(x => !x.squares);
      if (aliases.length) add('info', 'Aliased terms (cannot be separated in this design): ' + aliases.slice(0, 4).map(x => x.term + ' with ' + x.with).join('; ') + (aliases.length > 4 ? '…' : '') + '.');
    }
    if (rep.clustering) {
      const c = rep.clustering;
      add(c.silhouette >= 0.5 ? 'good' : c.silhouette >= 0.25 ? 'info' : 'warn', 'Found ' + c.k + ' groups. Separation is ' + (c.silhouette >= 0.5 ? 'clear' : c.silhouette >= 0.25 ? 'reasonable' : 'weak; groups overlap, so treat them as a rough split') + ' (silhouette ' + c.silhouette.toFixed(2) + ').');
      for (const p of c.profiles) add('info', 'Group ' + p.cluster + ' (' + p.size + ' rows, ' + pct(p.share) + '): ' + p.traits.map(t => t.text).join('; ') + '.');
      if (c.outliers.length) add('warn', c.outliers.length + ' unusual row' + (c.outliers.length > 1 ? 's' : '') + ' sit far from every group: row ' + c.outliers.slice(0, 6).map(o => o.row).join(', ') + (c.outliers.length > 6 ? '…' : '') + ' (spreadsheet row numbers). Check them for data errors or special causes.');
    }
    return out;
  }

  // ---------- Next steps, mapped to DMAIC ----------
  function nextSteps(rep, prof, targetCol, features) {
    const steps = [];
    const add = (phase, title, text) => steps.push({ phase, title, text });
    const goalWord = rep.goal === 'min' ? 'minimize' : 'maximize';

    if (rep.doe) {
      const a = rep.doe;
      const sig = a.terms.filter(t => t.p < 0.05);
      const best = rep.goal === 'min' ? a.optimum.min : a.optimum.max;
      const curved = (a.curvature && a.curvature.p !== null && a.curvature.p < 0.05) || a.terms.some(t => t.kind === 'square' && t.p < 0.05);
      const keyIdx = Array.from(new Set(sig.reduce((s, t) => s.concat(t.idx), [])));
      const keyFactors = (keyIdx.length ? keyIdx : a.terms.filter(t => t.kind === 'main').slice(0, 3).map(t => t.idx[0])).map(i => a.factors[i]);
      if (best) add('Improve', 'Run confirmation runs at the best settings', 'To ' + goalWord + ' ' + rep.target + ', the model points to ' + best.settings.map(s => s.name + ' = ' + (typeof s.actual === 'number' ? fmt(s.actual) : s.actual)).join(', ') + ' (predicted ' + fmt(best.y) + '). Run 3 to 5 confirmation runs there. If results land near the prediction, the model holds.');
      if (curved && keyFactors.filter(f => !f.categorical).length >= 2) add('Improve', 'Map the curve with a response-surface design', 'Curvature is present, so the best point may be inside your range. A central composite design on ' + keyFactors.filter(f => !f.categorical).map(f => f.name).join(', ') + ' will find it. A draft is in the DOE builder below.');
      if (a.aliases.some(x => !x.squares)) add('Analyze', 'Separate aliased effects', 'Some effects are confounded. A fold-over (re-running the design with signs flipped) or a few added runs will separate them.');
      if (a.dfe <= 0) add('Measure', 'Add replicates', 'This design has no replicate runs, so significance comes from Lenth\'s method, which is less sensitive. Replicating 2 to 4 runs (or center points) gives a true error estimate.');
      const inert = a.terms.filter(t => t.kind === 'main' && t.p > 0.2);
      if (inert.length) add('Improve', 'Set the inactive factors for cost or convenience', inert.map(t => t.name).join(', ') + ' showed no meaningful effect in this range. Set them where they are cheapest or easiest, and recheck if the range changes.');
      rep.doeRecommendation = Object.assign(
        curved && keyFactors.filter(f => !f.categorical).length >= 2 && keyFactors.length <= 5
          ? { type: 'ccd', centerPoints: 3, why: 'Response-surface follow-up on the factors that matter.' }
          : Object.assign(D.recommend(keyFactors.length), { why: 'Follow-up on the factors that matter, with replication to confirm effects. ' + D.recommend(keyFactors.length).why }),
        { factors: (curved ? keyFactors.filter(f => !f.categorical) : keyFactors).map(f => ({ name: f.name, low: f.low, high: f.high, categorical: f.categorical })) }
      );
      if (!curved && rep.doeRecommendation.type === 'full') rep.doeRecommendation.replicates = 2;
    } else if (rep.task === 'regression' || rep.task === 'classification') {
      const drivers = (rep.importance || []).filter(v => v.share >= 0.05).slice(0, 7);
      const cols = drivers.map(d => features.find(c => c.name === d.name)).filter(Boolean);
      add('Analyze', 'Sanity-check the top drivers with the people who run the process', 'Show the driver chart to operators and engineers. Drivers that make physical sense are worth testing; surprising ones may point to a data issue or a hidden variable riding along.');
      if (cols.length) {
        const factors = cols.map(c => {
          if (c.kind === 'numeric') return { name: c.name, low: round(c.stats.p10), high: round(c.stats.p90), categorical: false };
          return { name: c.name, low: c.levels[0], high: c.levels[1] || c.levels[0], categorical: true };
        });
        const rec = D.recommend(factors.length, { curvature: rep.nonlinear && factors.length <= 3 && factors.every(f => !f.categorical) });
        rep.doeRecommendation = Object.assign(rec, { factors });
        add('Improve', 'Prove cause and effect with a DOE', 'These results come from historical data, which shows correlation, not cause. A designed experiment on ' + factors.map(f => f.name).join(', ') + ' will confirm which ones really move ' + rep.target + ' and by how much. ' + rec.why + ' Levels are set at the 10th and 90th percentiles you already run at; widen them if it is safe. The run sheet is ready below.');
      }
      add('Improve', 'Use the what-if tool for quick scenarios', 'Try settings in the what-if panel to see the predicted ' + rep.target + '. Stay inside the ranges in your data; predictions outside them are guesses.');
      if (rep.task === 'classification') add('Control', 'Use it as an early warning', 'Score new batches or orders before they finish and flag the high-risk ones for review. Track how often the flags turn out right.');
    } else if (rep.clustering) {
      add('Analyze', 'Name the groups with subject-matter experts', 'Look at each group\'s profile and give it a name people recognize (for example "high-volume, low-margin"). Groups nobody can explain may be data artefacts.');
      if (rep.clustering.outliers.length) add('Measure', 'Investigate the unusual rows', 'Check the flagged rows for typos, unit mix-ups or special-cause events before you act on the groups.');
      add('Improve', 'Act on the groups', 'Use the groups to stratify: different targets, standard work or service levels per group. In a DOE, use the group as a blocking factor.');
      add('Define', 'Pick an outcome to predict', 'If you have a result column (yield, defects, revenue, churn), choose it as the target and rerun. The agent will then find the drivers and design an experiment.');
    }
    add('Control', 'Sustain the gain', 'Once a change is proven, update the standard work and put a control chart (I-MR or X-bar R) on ' + (rep.target || 'the key metric') + ' and its top driver, so drift is caught early.');
    const order = { Define: 0, Measure: 1, Analyze: 2, Improve: 3, Control: 4 };
    return steps.sort((a, b) => order[a.phase] - order[b.phase]);
  }
  function round(v) {
    // Three significant figures keeps suggested DOE levels practical (182.4 rather than 182.3871).
    return isFinite(v) ? Number(Number(v).toPrecision(3)) : v;
  }

  const GOOD_CLASS = /^(pass|passed|good|yes|y|true|1|success|successful|ok|accept|accepted|approved|win|won|on ?time|in ?spec|conforming|compliant|retained|active)$/i;
  const BAD_CLASS = /(fail|bad|^no$|^n$|false|^0$|defect|reject|late|scrap|churn|lost|out ?of ?spec|nonconform|error|delay)/i;
  function guessFavorable(classes) {
    const g = classes.findIndex(c => GOOD_CLASS.test(String(c).trim()));
    if (g >= 0) return g;
    if (classes.length === 2) { const b = classes.findIndex(c => BAD_CLASS.test(String(c))); if (b >= 0) return 1 - b; }
    return classes.length - 1;
  }

  // Turns an encoded split (feature index, threshold) back into a question in the user's units.
  function splitQuestion(enc, f, t) {
    const part = enc.parts[enc.groups[f]];
    if (part.type === 'num') return { q: part.col.name + ' ≤ ' + fmt(t * part.s + part.m) + '?', leftIsYes: true };
    const lv = enc.labels[f].slice(part.col.name.length + 3);
    return { q: part.col.name + ' = ' + lv + '?', leftIsYes: false };
  }

  /* Material for the "peek inside the model" view: a simple 3-level tree trained on the same
     data, real trees from forests and boosting, and a per-unit "recipe" for linear models. */
  function explainModel(rep, full, data, best, task, K) {
    const n = full.X.length;
    const opt = { maxDepth: 3, minLeaf: Math.max(3, Math.round(n / 40)), nClasses: task === 'classification' ? K : 0 };
    const tree = E.buildTree(full.X, data.y, range(n), opt, rng(rep.seed), 0);
    const pr = full.X.map(r => E.treePredictRow(tree, r));
    const score = task === 'regression' ? E.regressionMetrics(data.y, pr).r2
      : E.classificationMetrics(data.y, pr.map(p => p.indexOf(Math.max.apply(null, p))), K).accuracy;
    const question = (f, t) => splitQuestion(full.enc, f, t);
    rep.explain = { tree, score, question };
    if (full.fitted.trees) rep.explain.trees = full.fitted.trees.slice(0, 3);
    if (['linear', 'ridge', 'lasso'].includes(best.id) && full.fitted.w) {
      rep.explain.recipe = full.fitted.w.map((w, j) => {
        const part = full.enc.parts[full.enc.groups[j]];
        if (part.type === 'num') return { label: part.col.name, numeric: true, perUnit: w / part.s, effectRange: w / part.s * ((part.col.stats.p90 - part.col.stats.p10) || 0) };
        return { label: full.enc.labels[j], numeric: false, ref: part.kept[0], perUnit: w, effectRange: w };
      }).filter(r => Math.abs(r.effectRange) > 1e-9).sort((a, b) => Math.abs(b.effectRange) - Math.abs(a.effectRange));
    }
  }

  // ---------- Plain-English action plan ----------
  function actionPlan(rep) {
    if (rep.doe) return doeActions(rep);
    if (rep.clustering) return clusterActions(rep);
    if (!rep.pd) return null;
    const cls = rep.task === 'classification';
    const maximize = cls || rep.goal !== 'min';
    const outcome = cls ? 'the chance of ' + rep.target + ' = ' + rep.classes[rep.favorable] : rep.target;
    const better = (a, b) => (maximize ? a > b : a < b);
    const show = d => {
      if (cls ? Math.abs(d) < 0.005 : Math.abs(d) < 0.02 * (rep.targetSD || 1)) return 'about the same';
      return cls ? (d >= 0 ? '+' : '−') + Math.abs(Math.round(d * 100)) + ' percentage points' : (d >= 0 ? '+' : '−') + fmt(Math.abs(d));
    };
    const r3 = v => (typeof v === 'number' ? Number(v.toPrecision(3)) : v);
    const unitOf = v => (typeof v === 'number' ? fmt(v) : v);
    const spanRef = cls ? 0.03 : 0.1 * (rep.targetSD || 1);
    const maxSpan = Math.max(0, ...rep.pd.map(p => Math.max(...p.ys) - Math.min(...p.ys)));
    const items = [], quiet = [], best = {};
    for (const p of rep.pd) {
      const span = Math.max(...p.ys) - Math.min(...p.ys);
      if (span < spanRef || span < 0.15 * maxSpan) { quiet.push(p.name); continue; }
      let bi = 0; p.ys.forEach((v, i) => { if (better(v, p.ys[bi])) bi = i; });
      let ti = 0;
      if (p.kind === 'numeric') p.grid.forEach((g, i) => { if (Math.abs(g - p.typical) < Math.abs(p.grid[ti] - p.typical)) ti = i; });
      else ti = Math.max(0, p.grid.indexOf(p.typical));
      const gain = (p.ys[bi] - p.ys[ti]) * (maximize ? 1 : -1);
      best[p.name] = r3(p.grid[bi]);
      let verb, text;
      if (p.kind === 'numeric') {
        const last = p.grid.length - 1, close = Math.abs(gain) < 0.2 * span, typ = fmt(r3(p.typical)), to = fmt(r3(p.grid[bi]));
        if (bi >= last - 1) {
          verb = close ? 'Hold' : 'Increase';
          text = close ? 'Higher ' + p.name + ' is better, and your typical ' + typ + ' is already near the top of its useful range. Keep it there; lowering it would hurt ' + outcome + '.'
            : 'Raise ' + p.name + ' from its typical ' + typ + ' toward ' + to + ', the high end of what your data covers.';
        } else if (bi <= 1) {
          verb = close ? 'Hold' : 'Decrease';
          text = close ? 'Lower ' + p.name + ' is better, and your typical ' + typ + ' is already near the bottom of its useful range. Keep it there; raising it would hurt ' + outcome + '.'
            : 'Lower ' + p.name + ' from its typical ' + typ + ' toward ' + to + ', the low end of what your data covers.';
        } else {
          verb = 'Target';
          text = 'Keep ' + p.name + ' near ' + to + '. That is a sweet spot: going higher or lower both make ' + outcome + ' worse.' + (close ? ' Your typical ' + typ + ' is already close.' : '');
        }
      } else {
        let wi = 0; p.ys.forEach((v, i) => { if (better(p.ys[wi], v)) wi = i; });
        verb = 'Choose';
        text = 'Use ' + p.name + ' = ' + p.grid[bi] + ' where you can' + (p.grid[wi] !== p.grid[bi] ? '; ' + p.grid[wi] + ' gives the worst ' + (cls ? 'odds' : 'results') : '') + '.';
        if (Math.abs(gain) < 0.2 * span) { verb = 'Hold'; text = 'Keep using ' + p.name + ' = ' + p.grid[bi] + ' (already the most common choice)' + (p.grid[wi] !== p.grid[bi] ? ' and avoid ' + p.grid[wi] : '') + '.'; }
      }
      items.push({ verb, factor: p.name, text, impact: gain, impactText: 'Expected change vs typical: ' + (cls ? 'chance of ' + rep.target + ' = ' + rep.classes[rep.favorable] + ' ' : rep.target + ' ') + show(gain), span });
    }
    items.sort((a, b) => b.span - a.span);
    const plan = {
      headline: (cls ? 'To raise the chance of ' + rep.target + ' = ' + rep.classes[rep.favorable] : (maximize ? 'To increase ' : 'To decrease ') + rep.target) + ', starting with the strongest lever:',
      items: items.slice(0, 5), quiet,
      confidence: confidence(rep)
    };
    const levers = items.slice(0, 5);
    if (levers.length && rep.averageWith) {
      const tuned = {};
      for (const it of levers) tuned[it.factor] = best[it.factor];
      const now = rep.averageWith({}), after = rep.averageWith(tuned);
      plan.combined = 'If every past row had used these settings, the model estimates ' + (cls
        ? 'the chance of ' + rep.target + ' = ' + rep.classes[rep.favorable] + ' would average ' + pct(after) + ' instead of ' + pct(now) + '.'
        : rep.target + ' would average ' + fmt(after) + ' instead of ' + fmt(now) + '.');
      plan.settings = levers.map(it => ({ name: it.factor, value: unitOf(tuned[it.factor]) }));
    }
    plan.caveat = 'These come from patterns in past data, which show what moves together, not what causes what. Make one change at a time or, better, confirm with the DOE pre-filled below before changing the process. Stay inside the ranges you have run before.';
    return plan;
  }
  function confidence(rep) {
    if (rep.doe) return rep.doe.r2 >= 0.8 && rep.doe.dfe > 0 ? 'high' : rep.doe.r2 >= 0.6 ? 'medium' : 'low';
    if (!rep.best) return 'medium';
    const v = rep.best.metrics[rep.metricKey];
    if (rep.task === 'regression') return v >= 0.7 ? 'high' : v >= 0.4 ? 'medium' : 'low';
    return v >= 0.85 ? 'high' : v >= 0.7 ? 'medium' : 'low';
  }
  function doeActions(rep) {
    const a = rep.doe, maximize = rep.goal !== 'min';
    const opt = maximize ? a.optimum.max : a.optimum.min;
    if (!opt) return null;
    const sig = a.terms.filter(t => t.p < 0.05);
    const active = new Set(sig.reduce((s, t) => s.concat(t.idx), []));
    const mains = a.terms.filter(t => t.kind === 'main').sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));
    const items = [], quiet = [];
    for (const m of mains) {
      const i = m.idx[0], f = a.factors[i], st = opt.settings[i];
      if (!active.has(i)) { quiet.push(f.name); continue; }
      const val = typeof st.actual === 'number' ? fmt(st.actual) : st.actual;
      const verb = f.categorical ? 'Choose' : st.coded > 0.5 ? 'Increase' : st.coded < -0.5 ? 'Decrease' : 'Target';
      const text = f.categorical ? 'Use ' + f.name + ' = ' + val + '.'
        : st.coded > 0.5 ? 'Set ' + f.name + ' high, at ' + val + ' (the top of the tested range).'
          : st.coded < -0.5 ? 'Set ' + f.name + ' low, at ' + val + ' (the bottom of the tested range).'
            : 'Set ' + f.name + ' to about ' + val + ', inside the tested range.';
      items.push({ verb, factor: f.name, text, impact: m.effect, impactText: 'Going from low to high changes ' + rep.target + ' by ' + (m.effect >= 0 ? '+' : '−') + fmt(Math.abs(m.effect)) + (m.p < 0.05 ? '' : ' on its own (it matters through an interaction)') });
    }
    for (const t of sig.filter(t => t.kind === 'interaction')) {
      const [i, j] = t.idx;
      items.push({ verb: 'Combine', factor: a.factors[i].name + ' × ' + a.factors[j].name, text: a.factors[i].name + ' and ' + a.factors[j].name + ' work together: the effect of one depends on the setting of the other. Change them as a pair, using the settings above.', impact: t.effect, impactText: 'Interaction effect ' + (t.effect >= 0 ? '+' : '−') + fmt(Math.abs(t.effect)) });
    }
    return {
      headline: (maximize ? 'To increase ' : 'To decrease ') + rep.target + ', based on your experiment:',
      items, quiet, confidence: confidence(rep),
      combined: 'At these settings the model predicts ' + rep.target + ' of about ' + fmt(opt.y) + ', vs an average of ' + fmt(E.mean(a.y)) + ' across your runs.',
      settings: opt.settings.map(s => ({ name: s.name, value: typeof s.actual === 'number' ? fmt(s.actual) : s.actual })),
      caveat: 'A designed experiment does show cause and effect, but only inside the ranges you tested. Confirm with 3 to 5 runs at these settings before you change the standard.'
    };
  }
  function clusterActions(rep) {
    const c = rep.clustering;
    const items = c.profiles.map(p => ({
      verb: 'Segment', factor: 'Group ' + p.cluster,
      text: 'Group ' + p.cluster + ' (' + pct(p.share) + ' of rows) stands out for ' + p.traits.slice(0, 2).map(t => t.text.replace(/ \(.*\)$/, '')).join(' and ') + '. Treat it as its own segment: give it its own targets or service level, and ask the team why it differs.',
      impactText: p.size + ' rows'
    }));
    if (c.outliers.length) items.push({ verb: 'Check', factor: 'Unusual rows', text: 'Look at the ' + c.outliers.length + ' unusual rows first (row ' + c.outliers.slice(0, 5).map(o => o.row).join(', ') + (c.outliers.length > 5 ? '…' : '') + '). They are either data errors or special causes worth understanding.', impactText: '' });
    return { headline: 'What to do with these groups:', items, quiet: [], confidence: c.silhouette >= 0.5 ? 'high' : c.silhouette >= 0.25 ? 'medium' : 'low', caveat: 'Groups describe the data; they do not explain it. Name them with people who know the process.' };
  }

  root.MLAgent = { run, guessTarget, decideTask, guessFavorable, fmt, pct, MAX_ROWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MLAgent;
})(typeof globalThis !== 'undefined' ? globalThis : this);
