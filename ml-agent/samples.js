/* Built-in practice datasets, generated in the browser from fixed seeds.
   They are synthetic: no real company or person data. */
(function (root) {
  'use strict';
  const E = root.MLEngine || require('./engine.js');

  function noise(rand) { // approx. standard normal (Box-Muller)
    const u = Math.max(1e-12, rand()), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;
  const toCSV = (cols, rows) => [cols.join(',')].concat(rows.map(r => r.join(','))).join('\n');

  const SAMPLES = [
    {
      id: 'molding', title: 'Injection molding yield', kind: 'Regression · process data',
      blurb: '150 production lots. Which settings drive yield %?', target: 'Yield',
      make() {
        const rand = E.rng(7), rows = [];
        const mats = ['Resin A', 'Resin B', 'Resin C'];
        for (let i = 0; i < 150; i++) {
          const temp = 200 + 30 * rand(), press = 60 + 40 * rand(), cool = 8 + 10 * rand(), speed = 40 + 40 * rand();
          const mat = mats[Math.floor(rand() * 3)];
          const humidity = 30 + 40 * rand();
          let y = 88 - 0.04 * (temp - 218) ** 2 + 0.12 * (press - 60) + 0.35 * cool - 0.0009 * (press - 80) * (cool - 13) * 10
            + (mat === 'Resin B' ? -2.5 : mat === 'Resin C' ? 1.2 : 0) + 1.3 * noise(rand);
          y = Math.min(99.5, y);
          rows.push(['L' + (1001 + i), r1(temp), r1(press), r1(cool), r1(speed), mat, r1(humidity), r2(y)]);
        }
        return toCSV(['LotID', 'MeltTemp', 'Pressure', 'CoolingTime', 'ScrewSpeed', 'Material', 'Humidity', 'Yield'], rows);
      }
    },
    {
      id: 'factorial', title: '2⁴ factorial DOE + center points', kind: 'DOE analysis',
      blurb: '19 runs: temperature, time, catalyst, stirring vs. yield.', target: 'Yield',
      make() {
        const rand = E.rng(11), rows = [];
        const runs = [];
        for (let i = 0; i < 16; i++) runs.push([0, 1, 2, 3].map(j => ((i >> j) & 1 ? 1 : -1)));
        for (let c = 0; c < 3; c++) runs.push([0, 0, 0, 0]);
        runs.forEach((x, i) => {
          const [A, B, C, Dd] = x;
          const y = 70 + 6 * A + 3.5 * C + 0.4 * B + 0.3 * Dd + 2.8 * A * C - 1.6 * (A === 0 ? 1 : 0) + 0.9 * noise(rand);
          rows.push([i + 1, 160 + 20 * A, 30 + 10 * B, 1.5 + 0.5 * C, 300 + 100 * Dd, r2(y)]);
        });
        return toCSV(['StdOrder', 'Temperature', 'Time', 'Catalyst', 'Stirring', 'Yield'], rows);
      }
    },
    {
      id: 'batches', title: 'Batch release pass/fail', kind: 'Classification',
      blurb: '300 batches. What predicts a failed release test?', target: 'Result',
      make() {
        const rand = E.rng(23), rows = [];
        const sup = ['North', 'East', 'West'];
        for (let i = 0; i < 300; i++) {
          const ph = 6.4 + 1.2 * rand(), temp = 34 + 6 * rand(), mix = 20 + 40 * rand(), hold = 2 + 22 * rand();
          const s = sup[Math.floor(rand() * 3)];
          const score = -1.2 + 3.2 * Math.abs(ph - 7) + 0.35 * (temp - 37) + 0.06 * (hold - 12) + (s === 'West' ? 1.1 : 0) - 0.01 * mix + 0.6 * noise(rand);
          rows.push(['B' + (5000 + i), r2(ph), r1(temp), r1(mix), r1(hold), s, score > 0.6 ? 'Fail' : 'Pass']);
        }
        return toCSV(['BatchID', 'pH', 'Temperature', 'MixingTime', 'HoldHours', 'Supplier', 'Result'], rows);
      }
    },
    {
      id: 'segments', title: 'Customer segments', kind: 'Unsupervised · clustering',
      blurb: '240 customers, no outcome column. What groups exist?', target: '__none__',
      make() {
        const rand = E.rng(31), rows = [];
        const groups = [
          { n: 110, spend: 120, visits: 2, tenure: 14, disc: 5 },
          { n: 80, spend: 640, visits: 9, tenure: 48, disc: 3 },
          { n: 50, spend: 260, visits: 5, tenure: 6, disc: 22 }
        ];
        let id = 1;
        for (const g of groups) for (let i = 0; i < g.n; i++) {
          rows.push(['C' + (id++), Math.max(10, Math.round(g.spend * (1 + 0.18 * noise(rand)))), Math.max(1, Math.round(g.visits + 1.2 * noise(rand))),
            Math.max(1, Math.round(g.tenure * (1 + 0.25 * noise(rand)))), Math.max(0, r1(g.disc + 2.5 * noise(rand)))]);
        }
        rows.push(['C' + id++, 4200, 1, 2, 0]);
        E.shuffle(rows, rand);
        return toCSV(['CustomerID', 'MonthlySpend', 'VisitsPerMonth', 'TenureMonths', 'DiscountPct'], rows);
      }
    }
  ];

  root.MLSamples = SAMPLES;
  if (typeof module !== 'undefined' && module.exports) module.exports = SAMPLES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
