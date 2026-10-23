/* ML Agent page logic. Reads files with the browser's FileReader (local only), runs the
   agent, and draws results. Data lives only in the `state` object below. "Finish and delete"
   (or 30 idle minutes, or leaving the page) drops it and every result from the page. */
(function () {
  'use strict';
  const A = window.MLAgent, D = window.MLDoe, E = window.MLEngine, C = window.Charts, X = window.MLExplain;
  const h = C.esc, fmt = A.fmt, pct = A.pct;
  const $ = id => document.getElementById(id);
  const IDLE_MS = 30 * 60 * 1000;

  const state = { table: null, prof: null, name: '', report: null, sampleTarget: null, factors: null, design: null };
  const DEFAULT_FACTORS = () => [{ name: 'Temperature', low: 150, high: 180 }, { name: 'Time', low: 30, high: 60 }, { name: 'Catalyst', low: 'Type A', high: 'Type B' }];

  // ---------- Loading ----------
  function showError(id, msg) { const el = $(id); el.textContent = msg; el.hidden = !msg; }

  function loadText(text, name, sampleTarget) {
    showError('load-error', ''); $('deleted-note').hidden = true;
    let table;
    try { table = E.parseCSV(text); } catch (e) { return showError('load-error', 'Could not read that data: ' + e.message); }
    if (!table.columns.length || !table.rows.length) return showError('load-error', 'No data found. The first row should hold column names, with one row per observation below it.');
    if (table.columns.length < 2) return showError('load-error', 'Only one column found. If your file uses another separator, try pasting the cells from Excel instead.');
    state.table = table; state.name = name; state.sampleTarget = sampleTarget || null;
    state.prof = E.profile(table);
    state.report = null;
    $('results').hidden = true; $('next').hidden = true; $('progress').hidden = true; showError('run-error', '');
    $('delete-top').hidden = false;
    renderSetup();
    $('setup').hidden = false;
    touch();
    $('setup').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function readFile(file) {
    if (!file) return;
    if (/\.(xlsx|xls|xlsm)$/i.test(file.name)) return showError('load-error', 'Excel workbooks need one extra step: in Excel use File → Save As → CSV, or copy the cells and paste them in the box.');
    if (file.size > 50 * 1024 * 1024) return showError('load-error', 'That file is over 50 MB. Try a sample of the rows, or remove columns you do not need.');
    const reader = new FileReader();
    reader.onload = () => { const text = String(reader.result); $('file').value = ''; loadText(text, file.name); };
    reader.onerror = () => showError('load-error', 'Could not read the file.');
    reader.readAsText(file);
  }

  // ---------- Setup ----------
  const KIND_LABEL = { numeric: 'number', categorical: 'category', id: 'ID', constant: 'constant', text: 'free text', empty: 'empty' };

  function renderSetup() {
    const prof = state.prof;
    $('data-summary').innerHTML = '<b>' + h(state.name) + '</b>: ' + prof.nRows.toLocaleString() + ' rows × ' + prof.nCols + ' columns. The agent has checked each column below.';
    const usable = prof.columns.filter(E.isUsableFeature);
    const guess = state.sampleTarget || A.guessTarget(prof);
    $('target').innerHTML = usable.map(c => '<option value="' + h(c.name) + '"' + (c.name === guess ? ' selected' : '') + '>' + h(c.name) + '</option>').join('') +
      '<option value="__none__"' + (guess === '__none__' ? ' selected' : '') + '>Nothing: find groups and patterns (unsupervised)</option>';
    $('task').value = 'auto';
    renderProfile();
    const pv = state.table.rows.slice(0, 8);
    $('preview').innerHTML = '<thead><tr>' + state.table.columns.map(c => '<th>' + h(c) + '</th>').join('') + '</tr></thead><tbody>' +
      pv.map(r => '<tr>' + r.map(v => '<td>' + h(v) + '</td>').join('') + '</tr>').join('') + '</tbody>';
  }

  function renderGoal(col, task) {
    const sel = $('goal');
    if (!col) { sel.innerHTML = '<option value="max">Not needed for finding groups</option>'; sel.disabled = true; return; }
    sel.disabled = false;
    if (task === 'classification') {
      const classes = (col.levels || []).map(String);
      const fav = A.guessFavorable(classes);
      sel.innerHTML = classes.map((c, i) => '<option value="class:' + h(c) + '"' + (i === fav ? ' selected' : '') + '>More "' + h(c) + '" is better</option>').join('');
    } else {
      sel.innerHTML = '<option value="max">Higher ' + h(col.name) + ' is better</option><option value="min">Lower ' + h(col.name) + ' is better</option>';
      if (/defect|scrap|cost|time|delay|downtime|error|waste|reject|cycle|lead|days|hours/i.test(col.name)) sel.value = 'min';
    }
  }

  function renderProfile() {
    const target = $('target').value;
    const excluded = new Set(Array.from(document.querySelectorAll('#profile input[data-col]')).filter(i => !i.checked).map(i => i.getAttribute('data-col')));
    const rows = state.prof.columns.map(c => {
      const isT = c.name === target;
      const usable = E.isUsableFeature(c);
      let detail = '';
      if (c.stats) detail = h(fmt(c.stats.min) + ' to ' + fmt(c.stats.max) + ', median ' + fmt(c.stats.median));
      else if (c.levels) detail = c.levels.slice(0, 4).map(h).join(', ') + (c.levels.length > 4 ? ', …' : '');
      const chip = isT ? '<span class="chip target">target</span>' : usable ? '<span class="chip">' + KIND_LABEL[c.kind] + '</span>' : '<span class="chip off">' + KIND_LABEL[c.kind] + ', set aside</span>';
      const box = usable && !isT ? '<input type="checkbox" aria-label="Use ' + h(c.name) + '" data-col="' + h(c.name) + '"' + (excluded.has(c.name) ? '' : ' checked') + '>' : '';
      return '<tr' + (usable ? '' : ' class="dim"') + '><td>' + box + '</td><td><b>' + h(c.name) + '</b></td><td>' + chip + '</td><td class="num-cell">' + (c.missing ? c.missing + ' (' + pct(c.missing / c.n) + ')' : '0') + '</td><td class="num-cell">' + c.unique + '</td><td>' + detail + '</td></tr>';
    });
    $('profile').innerHTML = '<thead><tr><th>Use</th><th>Column</th><th>Type</th><th class="num-cell">Missing</th><th class="num-cell">Distinct</th><th>Range or values</th></tr></thead><tbody>' + rows.join('') + '</tbody>';
    const col = state.prof.columns.find(c => c.name === target);
    const task = col && A.decideTask(col, $('task').value);
    renderGoal(col, task);
    $('target-hint').textContent = !col ? 'No target: the agent will look for natural groups (clustering), main directions of variation (PCA) and unusual rows.'
      : task === 'regression' ? '"' + target + '" is a number, so the agent will run regression models and check whether the data is a designed experiment.'
        : '"' + target + '" is a category, so the agent will run classification models.';
  }

  // ---------- Run ----------
  async function runAgent() {
    if (!state.table) return;
    showError('run-error', '');
    const btn = $('run'); btn.disabled = true; btn.textContent = 'Running…';
    $('progress').hidden = false; $('agent-log').innerHTML = ''; $('progress-bar').value = 2; $('progress-text').textContent = 'Starting';
    const exclude = Array.from(document.querySelectorAll('#profile input[data-col]')).filter(i => !i.checked).map(i => i.getAttribute('data-col'));
    try {
      const rep = await A.run(state.table, { target: $('target').value, task: $('task').value, goal: $('goal').value, exclude }, p => {
        if (p.log) $('agent-log').innerHTML = p.log.map(l => '<li class="log-' + l.kind + '">' + h(l.text) + '</li>').join('');
        if (p.total) { $('progress-bar').value = 5 + 90 * p.done / p.total; $('progress-text').textContent = 'Testing ' + p.model + ' (' + (p.done + 1) + ' of ' + p.total + ')'; }
      });
      if (!state.table) return; // deleted while running
      $('progress-bar').value = 100; $('progress-text').textContent = 'Finished';
      state.report = rep;
      renderResults(rep);
    } catch (e) {
      showError('run-error', e.message || String(e));
      $('progress-text').textContent = 'Stopped';
    } finally {
      btn.disabled = false; btn.textContent = 'Run the agent';
    }
  }

  // ---------- Result building blocks ----------
  function learnLink(topic, text) { return '<a class="learn-link" href="learn.html#' + topic + '" target="_blank" rel="noopener noreferrer">' + h(text || 'Learn how this works') + ' ↗</a>'; }
  function howTo(key, extra) {
    const r = X.READ[key];
    return '<details class="howto"><summary>How to read this</summary><p>' + h(r[0]) + (extra ? ' ' + h(extra) : '') + '</p><p class="analogy">' + h(r[1]) + '</p><p>' + learnLink(r[2]) + '</p></details>';
  }
  function tile(label, val, sub, hero) { return '<div class="tile' + (hero ? ' hero-tile' : '') + '"><div class="lbl">' + h(label) + '</div><div class="val">' + h(val) + '</div><div class="sub">' + h(sub || '') + '</div></div>'; }
  function card(title, sub, inner, readKey, extra) { return '<div class="card"><h3>' + h(title) + '</h3>' + (sub ? '<p class="sub-head">' + sub + '</p>' : '') + inner + (readKey ? howTo(readKey, extra) : '') + '</div>'; }
  function append(parent, html, cls) {
    const d = document.createElement('div');
    d.innerHTML = html;
    if (cls) { d.className = cls; parent.appendChild(d); return d; }
    const el = d.firstElementChild; parent.appendChild(el); return el;
  }

  function renderResults(rep) {
    const tiles = [];
    if (rep.task === 'clustering') {
      const c = rep.clustering;
      tiles.push(tile('Problem type', 'Unsupervised', 'Finding groups and patterns'));
      tiles.push(tile('Groups found', String(c.k), 'k-means, best of 2 to ' + (c.tries.length + 1), true));
      tiles.push(tile('Separation', c.silhouette.toFixed(2), 'silhouette, −1 to 1 (above 0.5 is clear)'));
      tiles.push(tile('Unusual rows', String(c.outliers.length), 'far from every group'));
    } else {
      const b = rep.best, reg = rep.task === 'regression';
      tiles.push(tile('Problem type', reg ? 'Regression' : 'Classification', reg ? 'Predicting the number ' + rep.target : 'Predicting the category ' + rep.target));
      tiles.push(tile('Best model', b.name, X.MODEL_ANALOGY[b.id] || rep.bestReason, true));
      tiles.push(reg ? tile('Variation explained', pct(Math.max(0, b.metrics.r2)), 'R² on unseen rows · error ±' + fmt(b.metrics.rmse))
        : tile('Accuracy', pct(b.metrics.accuracy), 'on unseen rows · balanced ' + pct(b.metrics.balancedAccuracy)));
      tiles.push(rep.doe ? tile('Designed experiment', rep.doe.k + ' factors', rep.doe.n + ' runs, effects analysis below')
        : tile('Rows used', (rep.nUsed || 0).toLocaleString(), (rep.folds === rep.nUsed ? 'leave-one-out' : rep.folds + '-fold') + ' cross-validation' + (rep.sampled ? ', sampled' : '')));
    }
    $('tiles').innerHTML = tiles.join('');
    renderPlan(rep);
    $('insights').innerHTML = rep.insights.map(i => '<li class="' + i.level + '">' + h(i.text) + '</li>').join('');

    const blocks = $('result-blocks');
    blocks.innerHTML = '';
    $('results').hidden = false;
    if (rep.doe) renderDOE(rep, blocks);
    if (rep.task === 'clustering') renderClusters(rep, blocks);
    else renderSupervised(rep, blocks);
    renderCorrelations(rep, blocks);

    $('next-steps').innerHTML = rep.nextSteps.map(s => '<li class="p-' + s.phase + '"><span class="phase">' + h(s.phase) + '</span><b>' + h(s.title) + '</b><p>' + h(s.text) + '</p></li>').join('');
    $('next').hidden = false;
    if (rep.doeRecommendation && rep.doeRecommendation.factors.length) prefillDOE(rep);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderPlan(rep) {
    const p = rep.actionPlan, el = $('plan');
    if (!p || !p.items.length) { el.innerHTML = '<h3>Action plan</h3><p>No clear levers stood out in this data. See the findings below, and consider collecting the drivers the team believes matter.</p>'; return; }
    const confText = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence: treat as hints' }[p.confidence];
    el.innerHTML = '<h3>Action plan in plain English <span class="conf ' + p.confidence + '">' + confText + '</span></h3>' +
      '<p class="sub-head">' + h(p.headline) + '</p><ol class="plan-list">' +
      p.items.map(i => '<li><span class="verb ' + i.verb + '">' + h(i.verb) + '</span><div><b>' + h(i.text) + '</b>' + (i.impactText ? '<span class="impact">' + h(i.impactText) + '</span>' : '') + '</div></li>').join('') + '</ol>' +
      (p.quiet && p.quiet.length ? '<p><b>Little effect:</b> ' + h(p.quiet.join(', ')) + '. In the range you have run, these barely move the result, so set them for cost, speed or convenience.</p>' : '') +
      (p.combined ? '<p><b>All together:</b> ' + h(p.combined) + '</p>' : '') +
      '<p class="hint">' + h(p.caveat) + ' ' + learnLink('reading-results', 'How the action plan is worked out') + '</p>';
  }

  function renderSupervised(rep, blocks) {
    const reg = rep.task === 'regression', key = rep.metricKey;
    const lb = rep.leaderboard.filter(m => m.metrics);
    append(blocks,
      card('Model leaderboard', (reg ? 'R²: share of variation explained' : 'Balanced accuracy') + ' on rows each model never saw. Yellow = chosen.', '<div id="lb-chart"></div>' +
        '<div class="models"><details><summary>Scores table</summary><div class="table-scroll"><table><thead><tr><th>Model</th>' +
        (reg ? '<th class="num-cell">R²</th><th class="num-cell">RMSE</th><th class="num-cell">MAE</th>' : '<th class="num-cell">Accuracy</th><th class="num-cell">Balanced</th><th class="num-cell">Macro F1</th>') +
        '</tr></thead><tbody>' + lb.map(m => '<tr' + (m === rep.best ? ' class="best"' : '') + '><td>' + h(m.name) + '</td>' +
          (reg ? '<td class="num-cell">' + m.metrics.r2.toFixed(3) + '</td><td class="num-cell">' + fmt(m.metrics.rmse) + '</td><td class="num-cell">' + fmt(m.metrics.mae) + '</td>'
            : '<td class="num-cell">' + pct(m.metrics.accuracy) + '</td><td class="num-cell">' + pct(m.metrics.balancedAccuracy) + '</td><td class="num-cell">' + m.metrics.macroF1.toFixed(2) + '</td>') + '</tr>').join('') +
        '</tbody></table></div></details><details><summary>What each model does, in plain words</summary><dl>' +
        lb.map(m => '<dt>' + h(m.name) + '</dt><dd>' + h(m.plain) + ' <i>' + h(X.MODEL_ANALOGY[m.id] || '') + '</i> ' + learnLink(X.MODEL_TOPIC[m.id], 'Visual lesson') + '</dd>').join('') + '</dl></details></div>', 'leaderboard') +
      card(reg ? 'Predicted vs actual' : 'Confusion matrix', reg ? 'Each dot is a row, predicted while hidden from the model. Dots on the dashed line are perfect.' : 'Rows on the diagonal were classified correctly. Hover a cell for details.', '<div id="fit-chart"></div>', reg ? 'fitScatter' : 'confusion'),
      'block-grid');
    C.hbar($('lb-chart'), lb.map(m => ({
      label: m.name, value: Math.max(0, m.metrics[key]), cls: m === rep.best ? 'accent hi' : '',
      text: reg ? m.metrics.r2.toFixed(2) : pct(m.metrics[key]),
      tip: m.name + '\n' + (reg ? 'R² ' + m.metrics.r2.toFixed(3) + ' · RMSE ' + fmt(m.metrics.rmse) : 'Accuracy ' + pct(m.metrics.accuracy) + ' · balanced ' + pct(m.metrics.balancedAccuracy)) + '\nScored in ' + m.ms + ' ms'
    })), { min: 0, max: 1, tickFmt: t => pct(t), label: 'Model scores' });
    if (reg) {
      C.scatter($('fit-chart'), rep.actual.map((y, i) => ({ x: y, y: rep.best.oof[i], tip: 'Actual ' + fmt(y) + '\nPredicted ' + fmt(rep.best.oof[i]) })),
        { diagonal: true, xLabel: 'Actual ' + rep.target, yLabel: 'Predicted', label: 'Predicted versus actual' });
    } else C.confusion($('fit-chart'), rep.best.metrics.confusion, rep.classes);

    const imp = (rep.importance || []).slice(0, 12);
    append(blocks,
      card('What drives ' + rep.target, 'How much the best model\'s score drops when each column is scrambled. Bigger = more important.', imp.length ? '<div id="imp-chart"></div>' : '<p>No drivers to show.</p>', 'drivers') +
      card('What-if simulator', 'Change the top drivers to see what the best model predicts. Other columns stay at their typical value.', '<div class="whatif"><div class="whatif-inputs" id="wi-inputs"></div><div class="whatif-out" id="wi-out" aria-live="polite"></div></div>', 'whatif'),
      'block-grid');
    if (imp.length) C.hbar($('imp-chart'), imp.map((v, i) => ({ label: v.name, value: v.share, text: pct(v.share), cls: i < 3 ? 'hi' : '' })), { min: 0, tickFmt: t => pct(t), label: 'Driver importance' });
    renderWhatIf(rep);
    renderPD(rep, blocks);
    renderPeek(rep, blocks);
  }

  function renderPD(rep, blocks) {
    if (!rep.pd || !rep.pd.length) return;
    const cls = rep.task === 'classification';
    const what = cls ? 'chance of ' + rep.classes[rep.favorable] : rep.target;
    const c = append(blocks, card('How each driver moves ' + rep.target, 'Model-expected ' + h(what) + ' as one driver changes, with everything else as it was. Same scale on every panel; the large dot is your typical value.', '<div class="me-grid pd-grid"></div>', 'pd'));
    const grid = c.querySelector('.pd-grid');
    const all = rep.pd.reduce((s, p) => s.concat(p.ys), []);
    const dom = [Math.min(...all), Math.max(...all)];
    const yf = v => (cls ? pct(v) : fmt(v));
    for (const p of rep.pd) {
      const div = document.createElement('div'); grid.appendChild(div);
      if (p.kind === 'numeric') {
        const near = Math.min(...p.grid.map(q => Math.abs(q - p.typical)));
        C.lines(div, [{ name: p.name, points: p.grid.map((g, i) => {
          const typ = Math.abs(g - p.typical) === near;
          return { x: g, y: p.ys[i], big: typ, tip: p.name + ' = ' + fmt(g) + '\nExpected ' + what + ': ' + yf(p.ys[i]) + (typ ? '\n(near your typical value)' : '') };
        }) }], { yDomain: dom, xLabel: p.name, xTicks: [p.grid[0], p.grid[6], p.grid[12]], xTickFmt: v => fmt(Number(v.toPrecision(3))), width: 280, height: 190, label: 'Effect of ' + p.name });
      } else {
        C.hbar(div, p.grid.map((g, i) => ({ label: g, value: p.ys[i], text: yf(p.ys[i]) })), { width: 280, min: cls ? 0 : Math.min(...p.ys) - (Math.max(...p.ys) - Math.min(...p.ys)) * 0.3, label: 'Effect of ' + p.name, tickFmt: yf });
        const t = document.createElement('p'); t.className = 'pd-cap'; t.textContent = p.name; div.appendChild(t);
      }
    }
  }

  function renderPeek(rep, blocks) {
    const ex = rep.explain;
    if (!ex) return;
    const cls = rep.task === 'classification';
    const leaf = node => {
      if (!cls) return [rep.target + ' ≈ ' + fmt(node.value), node.n + ' rows'];
      const k = node.value.indexOf(Math.max(...node.value));
      return [rep.classes[k] + ' ' + pct(node.value[k]), node.n + ' rows'];
    };
    // Regression leaves: best third green, worst third red (by the chosen goal).
    const leafVals = [];
    (function walk(n) { if (n.leaf) leafVals.push(n.value); else { walk(n.left); walk(n.right); } })(ex.tree);
    const lo = Math.min(...leafVals), hi = Math.max(...leafVals), up = rep.goal !== 'min';
    const leafClass = node => {
      if (cls) return node.value.indexOf(Math.max(...node.value)) === rep.favorable ? 'good' : 'bad';
      const r = hi > lo ? (node.value - lo) / (hi - lo) : 0.5, score = up ? r : 1 - r;
      return score >= 0.67 ? 'good' : score <= 0.33 ? 'bad' : '';
    };
    const scoreText = cls ? 'gets ' + pct(ex.score) + ' of rows right' : 'explains ' + pct(Math.max(0, ex.score)) + ' of the variation';
    let html = '<p class="sub-head">A simplified 3-question tree trained on your data. It ' + scoreText + ' (on the rows it learned from), versus ' +
      (cls ? pct(rep.best.metrics.accuracy) : pct(Math.max(0, rep.best.metrics.r2))) + ' for the chosen ' + h(rep.best.name) + ' on unseen rows.</p><div class="table-scroll peek-tree"></div>' + howTo('tree');
    const ensemble = ex.trees && (rep.best.id === 'forest' || rep.best.id === 'boosting');
    if (ensemble) html += '<h3 class="peek-sub">Inside your ' + (rep.best.id === 'forest' ? 'random forest' : 'gradient boosting chain') + '</h3><div class="trees-row"></div>' + howTo(rep.best.id === 'forest' ? 'forest' : 'boosting');
    if (ex.recipe) html += '<h3 class="peek-sub">The recipe your ' + h(rep.best.name.toLowerCase()) + ' learned</h3><div class="recipe"></div>' + howTo('recipe');
    const c = append(blocks, '<div class="card"><h3>Peek inside the model</h3>' + html + '</div>');
    C.treeDiagram(c.querySelector('.peek-tree'), ex.tree, { question: ex.question, leaf, leafClass, label: 'Simplified decision tree' });
    if (ensemble) {
      const row = c.querySelector('.trees-row');
      const boostLeaf = node => {
        const v = node.value * 0.1;
        if (cls) return [v >= 0 ? 'nudge toward ' + rep.classes[1] : 'nudge toward ' + rep.classes[0], node.n + ' rows'];
        return [(v >= 0 ? '+' : '−') + fmt(Math.abs(v)) + ' correction', node.n + ' rows'];
      };
      ex.trees.forEach((t, i) => {
        const d = document.createElement('div');
        d.innerHTML = '<h4>' + (rep.best.id === 'forest' ? 'Tree ' + (i + 1) + ' of many' : i === 0 ? 'Tree 1: first correction' : 'Tree ' + (i + 1) + ': fixes what is left') + '</h4><div class="table-scroll"></div>';
        row.appendChild(d);
        C.treeDiagram(d.querySelector('div'), t, { question: ex.question, leaf: rep.best.id === 'forest' ? leaf : boostLeaf, leafClass: rep.best.id === 'forest' ? leafClass : null, maxDepth: 2, colW: 118, label: 'Tree ' + (i + 1) });
      });
    }
    if (ex.recipe) {
      C.hbar(c.querySelector('.recipe'), ex.recipe.slice(0, 10).map(x => ({
        label: x.label, value: x.effectRange,
        text: (x.perUnit >= 0 ? '+' : '−') + fmt(Math.abs(x.perUnit)) + (x.numeric ? ' per unit' : ' vs ' + x.ref),
        tip: x.numeric ? 'Each +1 in ' + x.label + ' changes ' + rep.target + ' by ' + fmt(x.perUnit) + '\nAcross its usual range: ' + fmt(x.effectRange) : x.label + ' changes ' + rep.target + ' by ' + fmt(x.perUnit) + ' compared with ' + x.ref
      })), { label: 'Recipe coefficients' });
    }
  }

  function renderWhatIf(rep) {
    const cols = state.prof.columns;
    const names = (rep.importance && rep.importance.length ? rep.importance.map(v => v.name) : rep.features).slice(0, 6);
    $('wi-inputs').innerHTML = names.map((n, i) => {
      const c = cols.find(x => x.name === n);
      if (c.kind === 'numeric') {
        const step = (c.stats.max - c.stats.min) / 100 || 1;
        return '<label>' + h(n) + ' <span class="val" id="wi-v' + i + '">' + fmt(c.stats.median) + '</span><input type="range" data-wi="' + i + '" min="' + c.stats.min + '" max="' + c.stats.max + '" step="' + step + '" value="' + c.stats.median + '"></label>';
      }
      return '<label>' + h(n) + '<select data-wi="' + i + '">' + c.levels.slice(0, 30).map(l => '<option>' + h(l) + '</option>').join('') + '</select></label>';
    }).join('');
    const update = () => {
      if (!state.report) return;
      const vals = {};
      names.forEach((n, i) => {
        const el = document.querySelector('[data-wi="' + i + '"]'); const c = cols.find(x => x.name === n);
        if (c.kind === 'numeric') { vals[n] = Number(el.value); $('wi-v' + i).textContent = fmt(Number(el.value)); } else vals[n] = el.value;
      });
      const out = rep.predict(vals);
      if (out.proba) {
        $('wi-out').innerHTML = '<div class="lbl">Most likely</div><div class="big">' + h(out.label) + '</div><div class="proba">' +
          rep.classes.map((c, k) => '<div><span>' + h(c) + '</span><progress max="1" value="' + out.proba[k] + '"></progress><span>' + pct(out.proba[k]) + '</span></div>').join('') + '</div>';
      } else {
        $('wi-out').innerHTML = '<div class="lbl">Predicted ' + h(rep.target) + '</div><div class="big">' + fmt(out.value) + '</div><div class="hint">Typical error ±' + fmt(rep.best.metrics.rmse) + '</div>';
      }
    };
    $('wi-inputs').oninput = update;
    update();
  }

  function tCritical(df) {
    let lo = 0, hi = 200;
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (E.tTestP(mid, df) > 0.05) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  function renderDOE(rep, blocks) {
    const a = rep.doe;
    const df = a.dfe > 0 ? a.dfe : Math.max(1, a.terms.length / 3);
    const tc = tCritical(df);
    const goal = rep.goal === 'min' ? a.optimum.min : a.optimum.max;
    const nm = v => (typeof v === 'number' ? fmt(v) : v);
    append(blocks,
      card('DOE: Pareto of effects', 'Standardized effect size |t|. Bars past the red dashed line (t = ' + tc.toFixed(2) + ') are significant at p &lt; 0.05. Dark bars are significant.', '<div id="pareto"></div>', 'pareto') +
      card('DOE: effects table', h(a.method) + '. R² ' + pct(a.r2) + (a.adjR2 !== null ? ', adjusted ' + pct(a.adjR2) : '') + (a.predR2 !== null ? ', predicted ' + pct(Math.max(0, a.predR2)) : '') + '.',
        '<div class="table-scroll"><table><thead><tr><th>Term</th><th class="num-cell">Effect</th><th class="num-cell">Coef.</th><th class="num-cell">t</th><th class="num-cell">p</th><th></th></tr></thead><tbody>' +
        a.terms.map(t => '<tr' + (t.p < 0.05 ? '' : ' class="dim"') + '><td>' + h(t.name) + '</td><td class="num-cell">' + (t.kind === 'square' ? '–' : fmt(t.effect)) + '</td><td class="num-cell">' + fmt(t.coef) + '</td><td class="num-cell">' + (isFinite(t.t) ? t.t.toFixed(2) : '∞') + '</td><td class="num-cell">' + (isFinite(t.p) ? (t.p < 0.001 ? '&lt;0.001' : t.p.toFixed(3)) : '–') + '</td><td>' +
          (t.p < 0.05 ? '<span class="chip">significant</span>' : t.p < 0.1 ? '<span class="chip off">borderline</span>' : '') + '</td></tr>').join('') +
        '</tbody></table></div><p class="hint">Factor letters: ' + a.factors.map(f => f.letter + ' = ' + h(f.name)).join(', ') + '.</p>', 'effects'),
      'block-grid');
    C.hbar($('pareto'), a.terms.slice(0, 15).map(t => ({ label: t.name, value: Math.min(Math.abs(t.t), 999), cls: t.p < 0.05 ? 'hi' : '', text: Math.abs(t.t) > 999 ? '>999' : Math.abs(t.t).toFixed(1), tip: t.name + '\nEffect ' + fmt(t.effect) + ' · p ' + (isFinite(t.p) ? t.p.toFixed(4) : '–') })), { min: 0, ref: { value: tc }, label: 'Pareto chart of standardized effects' });

    append(blocks, card('DOE: main effects', 'Average ' + h(rep.target) + ' at each level of each factor. Steeper = stronger. Same scale on every panel.', '<div class="me-grid" id="me-grid"></div>', 'mainEffects'));
    append(blocks,
      card('DOE: ' + (a.interaction ? 'strongest interaction' : 'interactions'), a.interaction ? 'Model prediction for ' + h(a.interaction.a) + ' at each level of ' + h(a.interaction.b) + '. Non-parallel lines mean the factors interact.' : '', a.interaction ? '<div id="int-chart"></div><div id="int-legend"></div>' : '<p>No interaction terms could be estimated in this design.</p>', 'interaction') +
      card('Best settings found', 'Goal: ' + (rep.goal === 'min' ? 'minimize' : 'maximize') + ' ' + h(rep.target) + ', searching inside the tested range only.',
        goal ? '<div class="table-scroll"><table><tbody>' + goal.settings.map(s => '<tr><td>' + h(s.name) + '</td><td class="num-cell"><b>' + h(nm(s.actual)) + '</b></td></tr>').join('') +
          '<tr class="best"><td>Predicted ' + h(rep.target) + '</td><td class="num-cell"><b>' + fmt(goal.y) + '</b></td></tr></tbody></table></div><p class="hint">Confirm with 3 to 5 runs at these settings before changing the process.</p>' : '<p>Not available.</p>', 'optimum'),
      'block-grid');
    const all = a.mainEffects.reduce((s, m) => s.concat(m.points.map(p => p.mean)), []);
    const dom = [Math.min(...all), Math.max(...all)];
    a.mainEffects.forEach(m => {
      const div = document.createElement('div'); $('me-grid').appendChild(div);
      const lab = {}; m.points.forEach(p => { lab[p.coded] = nm(p.actual); });
      C.lines(div, [{ name: m.name, points: m.points.map(p => ({ x: p.coded, y: p.mean, tip: m.name + ' = ' + lab[p.coded] + '\nMean ' + fmt(p.mean) })) }],
        { yDomain: dom, xLabel: m.name, xTickFmt: c => lab[c], width: 280, height: 190, label: 'Main effect of ' + m.name });
    });
    if (a.interaction) {
      const it = a.interaction;
      const lab = { '-1': String(nm(it.lines[0].points[0].aLevel)), '1': String(nm(it.lines[0].points[1].aLevel)) };
      C.lines($('int-chart'), it.lines.map((l, i) => ({ name: it.b + ' = ' + nm(l.bLevel), cls: i ? 's2' : '', points: l.points.map((p, j) => ({ x: j ? 1 : -1, y: p.y, tip: it.a + ' = ' + nm(p.aLevel) + ', ' + it.b + ' = ' + nm(l.bLevel) + '\nPredicted ' + fmt(p.y) })) })),
        { xLabel: it.a, yLabel: rep.target, xTickFmt: c => lab[String(c)], label: 'Interaction plot' });
      $('int-legend').innerHTML = C.legend(it.lines.map((l, i) => ({ label: it.b + ' = ' + nm(l.bLevel), cls: i ? 'pt s2' : 'pt' })));
    }
  }

  function renderClusters(rep, blocks) {
    const c = rep.clustering;
    append(blocks,
      card('Groups in the data', c.pca ? 'Rows plotted on the two main directions of variation (PCA: ' + pct(c.pca.explained[0]) + ' + ' + pct(c.pca.explained[1]) + ' of the spread). Color and shape show the group.' : '', c.pca ? '<div id="pca-chart"></div><div id="pca-legend"></div>' : '<p>Need at least two inputs to plot.</p>', 'pca') +
      card('How many groups?', 'Silhouette score for each number of groups: higher means tighter, better separated groups. The largest dot is the agent\'s choice. Splits that leave a group of only a few rows are skipped: those rows are outliers, not a segment.', '<div id="sil-chart"></div>', 'silhouette'),
      'block-grid');
    if (c.pca) {
      C.scatter($('pca-chart'), c.pca.scores.map((s, i) => ({ x: s[0], y: s[1], cls: 'c' + (c.labels[i] % 6 + 1), shape: C.SHAPES[c.labels[i] % 6], tip: 'Row ' + (c.rows[i] + 2) + '\nGroup ' + (c.labels[i] + 1) })),
        { xLabel: 'Component 1', yLabel: 'Component 2', label: 'PCA scatter by group' });
      $('pca-legend').innerHTML = C.legend(c.profiles.map(p => ({ label: 'Group ' + p.cluster + ' (' + p.size + ')', cls: 'c' + ((p.cluster - 1) % 6 + 1), shape: C.SHAPES[(p.cluster - 1) % 6] })));
    }
    C.lines($('sil-chart'), [{ name: 'Silhouette', points: c.tries.map(t => ({ x: t.k, y: t.silhouette, big: t.k === c.k, tip: t.k + ' groups: silhouette ' + t.silhouette.toFixed(2) + (t.tiny ? '\nSkipped: one group has only a few rows' : '') })) }], { xLabel: 'Number of groups', yLabel: 'Silhouette', label: 'Silhouette by number of groups' });

    const numCols = state.prof.columns.filter(col => rep.features.includes(col.name) && col.kind === 'numeric');
    const prof = '<div class="table-scroll"><table><thead><tr><th>Group</th><th class="num-cell">Rows</th>' + numCols.map(col => '<th class="num-cell">' + h(col.name) + '</th>').join('') + '<th>Stands out for</th></tr></thead><tbody>' +
      c.profiles.map(p => '<tr><td><b>Group ' + p.cluster + '</b></td><td class="num-cell">' + p.size + ' (' + pct(p.share) + ')</td>' +
        numCols.map(col => { const t = p.means.find(m => m.name === col.name); return '<td class="num-cell">' + (t ? fmt(t.mean) : '–') + '</td>'; }).join('') +
        '<td>' + h(p.traits.map(t => t.text).join('; ')) + '</td></tr>').join('') +
      '<tr class="dim"><td>All rows</td><td class="num-cell">' + c.rows.length + '</td>' + numCols.map(col => '<td class="num-cell">' + fmt(col.stats.mean) + '</td>').join('') + '<td></td></tr></tbody></table></div>';
    const out = c.outliers.length ? '<p class="hint">Unusual rows (spreadsheet row numbers, header = row 1): ' + c.outliers.slice(0, 20).map(o => o.row).join(', ') + (c.outliers.length > 20 ? '…' : '') + '</p>' : '';
    append(blocks, card('Group profiles', 'Average of each numeric column per group, and what makes each group different.', prof + out, 'profiles'));
  }

  function renderCorrelations(rep, blocks) {
    const cs = (rep.correlations || []).filter(c => Math.abs(c.r) >= 0.3).slice(0, 8);
    if (!cs.length) return;
    append(blocks, card('Strongest relationships between numeric columns', 'Pearson correlation, −1 to 1.',
      '<div class="table-scroll"><table><thead><tr><th>Column</th><th>Column</th><th class="num-cell">r</th><th>Reads as</th></tr></thead><tbody>' +
      cs.map(c => '<tr><td>' + h(c.a) + '</td><td>' + h(c.b) + '</td><td class="num-cell">' + c.r.toFixed(2) + '</td><td>' + (Math.abs(c.r) >= 0.7 ? 'strong' : 'moderate') + (c.r > 0 ? ', rise together' : ', one rises as the other falls') + '</td></tr>').join('') + '</tbody></table></div>', 'correlations'));
  }

  // ---------- DOE builder ----------
  function isNum(v) { return v !== '' && v !== null && isFinite(Number(v)); }
  function factorList() {
    return state.factors.map(f => ({ name: String(f.name).trim(), low: f.low, high: f.high, categorical: !(isNum(f.low) && isNum(f.high)) }));
  }
  function renderFactors() {
    $('factors').innerHTML = '<thead><tr><th>Factor</th><th>Low level</th><th>High level</th><th></th></tr></thead><tbody>' +
      state.factors.map((f, i) => '<tr><td><input type="text" data-i="' + i + '" data-k="name" value="' + h(f.name) + '" aria-label="Factor ' + (i + 1) + ' name"></td>' +
        '<td><input type="text" data-i="' + i + '" data-k="low" value="' + h(f.low) + '" aria-label="Factor ' + (i + 1) + ' low level"></td>' +
        '<td><input type="text" data-i="' + i + '" data-k="high" value="' + h(f.high) + '" aria-label="Factor ' + (i + 1) + ' high level"></td>' +
        '<td><button class="icon-btn" type="button" data-remove="' + i + '" aria-label="Remove factor ' + (i + 1) + '">✕</button></td></tr>').join('') + '</tbody>';
    renderDesignTypes();
  }
  function designPurpose() { $('design-purpose').innerHTML = h(D.DESIGNS[$('design-type').value].purpose) + ' ' + learnLink('designs', 'See the design shapes'); }
  function renderDesignTypes(preferred) {
    const k = state.factors.length;
    const sel = $('design-type');
    const current = preferred || sel.value;
    sel.innerHTML = Object.keys(D.DESIGNS).map(t => {
      const d = D.DESIGNS[t], ok = k >= d.min && k <= d.max;
      return '<option value="' + t + '"' + (ok ? '' : ' disabled') + '>' + h(d.name) + (ok ? '' : ' (needs ' + d.min + '–' + d.max + ' factors)') + '</option>';
    }).join('');
    const d = D.DESIGNS[current];
    sel.value = d && k >= d.min && k <= d.max ? current : D.recommend(k).type;
    if (!D.DESIGNS[sel.value] || sel.selectedOptions[0].disabled) sel.value = 'pb';
    designPurpose();
  }
  function generateDesign(seed) {
    showError('doe-error', '');
    const fs = factorList();
    const names = fs.map(f => f.name);
    if (names.some(n => !n)) return showError('doe-error', 'Every factor needs a name.');
    if (new Set(names).size !== names.length) return showError('doe-error', 'Factor names must be different.');
    const bad = fs.find(f => String(f.low).trim() === '' || String(f.high).trim() === '' || String(f.low).trim() === String(f.high).trim());
    if (bad) return showError('doe-error', '"' + bad.name + '" needs two different levels.');
    let design;
    try {
      design = D.generate(fs.map(f => ({ name: f.name, low: f.categorical ? String(f.low).trim() : Number(f.low), high: f.categorical ? String(f.high).trim() : Number(f.high), categorical: f.categorical })), {
        type: $('design-type').value, centerPoints: Number($('centers').value) || 0, replicates: Number($('reps').value) || 1,
        randomize: $('randomize').checked, seed: seed || (Date.now() % 1e9)
      });
    } catch (e) { return showError('doe-error', e.message); }
    state.design = { design, factors: fs, response: $('response-name').value.trim() || 'Response' };
    const resp = state.design.response;
    $('design-out').innerHTML = '<div class="design-summary"><p><b>' + h(design.name) + ': ' + design.runs.length + ' runs</b> for ' + design.k + ' factor' + (design.k > 1 ? 's' : '') + '.</p><p>' + h(design.purpose) + '</p>' +
      design.notes.map(n => '<p>' + h(n) + '</p>').join('') +
      '<p>Run the experiments in <b>RunOrder</b> (randomized to protect against drift), record ' + h(resp) + ', then load the file in step 1. The agent will recognize the design and analyze it.</p></div>' +
      '<div class="row-actions"><button class="btn primary" type="button" id="download-design">Download run sheet (.csv)</button></div>' +
      '<div class="table-scroll"><table class="runsheet"><thead><tr><th class="num-cell">Run</th><th class="num-cell">Std</th>' + fs.map(f => '<th class="num-cell">' + h(f.name) + '</th>').join('') + '<th>' + h(resp) + '</th></tr></thead><tbody>' +
      design.runs.map(r => '<tr><td class="num-cell">' + r.run + '</td><td class="num-cell">' + r.std + '</td>' + r.actual.map(v => '<td class="num-cell">' + h(v) + '</td>').join('') + '<td class="blank"></td></tr>').join('') + '</tbody></table></div>';
    $('download-design').addEventListener('click', () => download('doe-run-sheet.csv', D.toCSV(design, fs, resp), 'text/csv'));
  }
  function prefillDOE(rep) {
    const rec = rep.doeRecommendation;
    state.factors = rec.factors.map(f => ({ name: f.name, low: f.low, high: f.high }));
    renderFactors();
    renderDesignTypes(rec.type);
    $('centers').value = rec.centerPoints || 0;
    $('reps').value = rec.replicates || 1;
    $('response-name').value = rep.target;
    $('doe-intro').innerHTML = '<b>Pre-filled by the agent.</b> ' + h(rec.why) + ' Adjust the levels to what is safe and practical, then regenerate.';
    generateDesign(rep.seed);
  }
  function resetDOE() {
    state.factors = DEFAULT_FACTORS(); state.design = null;
    renderFactors(); renderDesignTypes('full');
    $('centers').value = 3; $('reps').value = 1; $('response-name').value = 'Response';
    $('design-out').innerHTML = ''; showError('doe-error', '');
    $('doe-intro').textContent = 'Plan a designed experiment from scratch, or let the agent pre-fill it after a run. Set each factor\'s low and high level; words (like Supplier A / Supplier B) make a categorical factor.';
  }

  // ---------- Report ----------
  function download(name, text, type) {
    // Builds the file in memory and hands it to the browser's own download. Nothing is sent anywhere.
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function pageCSS() {
    // Copies this page's own stylesheet (already loaded, nothing fetched) into the report.
    try { return Array.from(document.styleSheets).map(s => Array.from(s.cssRules).map(r => r.cssText).join('\n')).join('\n'); } catch (e) { return ''; }
  }
  function reportHTML(rep) {
    const clone = id => {
      const n = $(id).cloneNode(true);
      n.querySelectorAll('.whatif').forEach(x => { const c = x.closest('.card'); if (c) c.remove(); });
      n.querySelectorAll('button, input, select, textarea, .row-actions, a.learn-link').forEach(x => x.remove());
      n.querySelectorAll('details').forEach(d => { d.open = true; });
      n.removeAttribute('hidden');
      return n.outerHTML;
    };
    const glossary = '<div class="card"><h3>Glossary</h3><table><tbody>' + X.GLOSSARY.map(g => '<tr><td><b>' + h(g[0]) + '</b></td><td>' + h(g[1]) + '</td></tr>').join('') + '</tbody></table></div>';
    const models = rep.leaderboard ? '<div class="card"><h3>The models, in plain words</h3><dl>' + rep.leaderboard.filter(m => m.metrics).map(m => '<dt><b>' + h(m.name) + '</b>' + (m === rep.best ? ' (chosen)' : '') + '</dt><dd>' + h(m.plain) + ' <i>' + h(X.MODEL_ANALOGY[m.id] || '') + '</i></dd>').join('') + '</dl></div>' : '';
    let doe = '';
    if (state.design) {
      const out = $('design-out').cloneNode(true);
      out.querySelectorAll('.row-actions').forEach(x => x.remove());
      doe = '<section class="wrap step"><div class="step-head"><span class="num">5</span><h2>Recommended experiment</h2></div><div class="card"><p>' + $('doe-intro').innerHTML + '</p>' + out.innerHTML + '</div></section>';
    }
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">' +
      '<title>ML Agent report: ' + h(state.name) + '</title><style>' + pageCSS() + '</style></head><body><main>' +
      '<section class="hero"><div class="wrap"><p class="eyebrow">ML Agent report · ' + h(new Date().toLocaleString()) + '</p><h1>' + h(state.name) + '</h1><p class="lede">' + rep.profile.nRows.toLocaleString() + ' rows × ' + rep.profile.nCols + ' columns. ' +
      (rep.target ? 'Target: ' + h(rep.target) + '.' : 'No target: unsupervised analysis.') + ' Computed entirely in the browser; no data left the device.</p></div></section>' +
      clone('results') + '<section class="wrap step">' + models + glossary + '</section>' + clone('next') + doe +
      '</main><footer class="foot"><div class="wrap"><p>Generated by ML Agent. Charts and tables summarize your data; keep or delete this file as your data policy requires.</p></div></footer></body></html>';
  }

  // ---------- Privacy self-test ----------
  async function selfTest() {
    const out = $('self-test-out');
    out.textContent = 'Testing…';
    const blocked = [];
    const onViolation = e => blocked.push(e.violatedDirective || e.effectiveDirective);
    document.addEventListener('securitypolicyviolation', onViolation);
    // The probes below carry no data. They exist only to show that the browser refuses them.
    let fetchBlocked = false;
    try { await fetch('https://example.com/ml-agent-privacy-self-test', { mode: 'no-cors', cache: 'no-store' }); } catch (e) { fetchBlocked = true; } // PRIVACY-SELF-TEST
    const imgBlocked = await new Promise(res => {
      const img = new Image(); // PRIVACY-SELF-TEST
      const timer = setTimeout(() => res(true), 4000);
      img.onload = () => { clearTimeout(timer); res(false); };
      img.onerror = () => { clearTimeout(timer); res(true); };
      img.src = 'https://example.com/ml-agent-pixel.gif'; // PRIVACY-SELF-TEST
    });
    await new Promise(r => setTimeout(r, 150));
    document.removeEventListener('securitypolicyviolation', onViolation);
    const noCookies = document.cookie === ''; // PRIVACY-SELF-TEST
    const ok = fetchBlocked && imgBlocked;
    const row = (pass, text) => '<li class="' + (pass ? 'pass' : 'fail') + '">' + (pass ? '✓ ' : '✗ ') + text + '</li>';
    out.innerHTML = '<p class="' + (ok ? 'pass' : 'fail') + '">' + (ok ? 'Passed. This page cannot send data out.' : 'Something got through. Please report this.') + '</p><ul>' +
      row(fetchBlocked, 'Data request to an outside server: blocked') +
      row(imgBlocked, 'Tracking pixel (hidden image) to an outside server: blocked') +
      row(noCookies, 'Cookies set by this page: none') +
      row(true, state.table ? 'Your data is held only in this tab\'s memory. Use "Finish and delete my data" when you are done.' : 'No data is held in this tab right now') +
      '</ul><p class="hint">The browser\'s security policy stopped ' + blocked.length + ' attempt' + (blocked.length === 1 ? '' : 's') + (blocked.length ? ' (' + Array.from(new Set(blocked)).join(', ') + ')' : '') + '. That is the lock working.</p>';
  }

  // ---------- Delete ----------
  function deleteData(reason) {
    const had = !!state.table;
    clearTimeout(idleTimer);
    state.table = state.prof = state.report = null; state.name = ''; state.sampleTarget = null;
    $('paste').value = ''; $('file').value = '';
    ['setup', 'results', 'next', 'progress'].forEach(id => { $(id).hidden = true; });
    ['result-blocks', 'insights', 'tiles', 'agent-log', 'plan', 'profile', 'preview', 'target', 'goal', 'next-steps', 'self-test-out'].forEach(id => { $(id).innerHTML = ''; });
    $('data-summary').textContent = ''; $('target-hint').textContent = '';
    showError('load-error', ''); showError('run-error', '');
    resetDOE();
    $('delete-top').hidden = true;
    const note = $('deleted-note');
    note.textContent = had ? (reason || 'Your data and all results have been deleted from this page.') + ' Nothing was saved or sent anywhere.' : 'Cleared. There was no data loaded. Nothing was saved or sent anywhere.';
    note.hidden = false;
    $('load').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  let idleTimer = null;
  function touch() {
    clearTimeout(idleTimer);
    if (state.table && $('auto-delete').checked) idleTimer = setTimeout(() => deleteData('Auto-delete: after 30 minutes without activity, your data and results were removed.'), IDLE_MS);
  }

  // ---------- Wiring ----------
  function init() {
    C.bindTips($('tip'));
    $('samples').innerHTML = window.MLSamples.map(s => '<button type="button" class="sample" data-sample="' + s.id + '"><span class="k">' + h(s.kind) + '</span><b>' + h(s.title) + '</b><span>' + h(s.blurb) + '</span></button>').join('');
    $('samples').addEventListener('click', e => {
      const b = e.target.closest('[data-sample]'); if (!b) return;
      const s = window.MLSamples.find(x => x.id === b.getAttribute('data-sample'));
      loadText(s.make(), s.title + ' (practice data)', s.target);
    });
    $('file').addEventListener('change', e => readFile(e.target.files[0]));
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', e => { e.preventDefault(); readFile(e.dataTransfer.files[0]); });
    $('use-paste').addEventListener('click', () => { const t = $('paste').value; if (t.trim()) { $('paste').value = ''; loadText(t, 'Pasted data'); } else showError('load-error', 'Paste some data first.'); });
    ['clear', 'delete-top', 'delete-bottom'].forEach(id => $(id).addEventListener('click', () => deleteData()));
    $('target').addEventListener('change', renderProfile);
    $('task').addEventListener('change', renderProfile);
    $('run').addEventListener('click', runAgent);
    $('download-report').addEventListener('click', () => state.report && download('ml-agent-report.html', reportHTML(state.report), 'text/html'));
    $('print').addEventListener('click', () => window.print());
    $('self-test').addEventListener('click', selfTest);
    ['pointerdown', 'keydown', 'scroll', 'input'].forEach(t => document.addEventListener(t, touch, { passive: true, capture: true }));
    $('auto-delete').addEventListener('change', touch);
    // Leaving the page wipes the data, so the browser's back/forward cache cannot bring it back.
    window.addEventListener('pagehide', () => { if (state.table) deleteData(); });

    state.factors = DEFAULT_FACTORS();
    renderFactors();
    $('factors').addEventListener('input', e => {
      const i = e.target.getAttribute('data-i'); if (i === null) return;
      state.factors[Number(i)][e.target.getAttribute('data-k')] = e.target.value;
    });
    $('factors').addEventListener('click', e => {
      const r = e.target.closest('[data-remove]'); if (!r) return;
      if (state.factors.length <= 1) return showError('doe-error', 'A design needs at least one factor.');
      state.factors.splice(Number(r.getAttribute('data-remove')), 1); renderFactors();
    });
    $('add-factor').addEventListener('click', () => {
      if (state.factors.length >= 19) return showError('doe-error', 'Up to 19 factors are supported.');
      state.factors.push({ name: 'Factor ' + (state.factors.length + 1), low: -1, high: 1 }); renderFactors();
    });
    $('design-type').addEventListener('change', designPurpose);
    $('generate').addEventListener('click', () => generateDesign());
  }
  init();
})();
