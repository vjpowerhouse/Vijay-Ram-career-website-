# ML Agent

A private, in-browser machine learning agent. Drop in a CSV and it:

1. **Profiles the data.** It finds numbers, categories, IDs, missing values and correlated inputs.
2. **Decides the problem type.** A numeric target means regression, a category means classification, and no target means unsupervised (clustering, PCA, outliers). Data that looks like a designed experiment also gets a full DOE effects analysis.
3. **Runs every suitable model with cross-validation** and keeps the simplest one within 0.01 of the top score:
   - Regression: linear, ridge, lasso, quadratic (response surface), k-nearest neighbours, decision tree, random forest, gradient boosting.
   - Classification: logistic regression, naive Bayes, k-nearest neighbours, decision tree, random forest, gradient boosting (binary).
   - Unsupervised: k-means with silhouette-based choice of k, PCA, outlier scoring.
   - DOE: effects, t and p values (or Lenth's method for saturated designs), aliasing, curvature from center points, main-effect and interaction plots, and the best settings.
4. **Explains the result** in plain language: top drivers, which direction they push, a what-if simulator, and warnings about small samples, gaps, imbalance and overfitting.
5. **Writes next steps mapped to DMAIC** and pre-fills a **DOE builder** with the drivers it found: full or fractional factorial, Plackett-Burman, central composite or Box-Behnken. It produces a randomized run sheet. Fill in the results, load the sheet back, and the agent analyzes it.

Live: `https://<your-pages-domain>/ml-agent/` (served by GitHub Pages from this folder).

## Privacy guarantees

| Guarantee | How it is enforced |
|---|---|
| Data is never uploaded | Files are read with the browser's `FileReader`. All math is local JavaScript in this folder. |
| Nothing can be sent out, even by mistake | The page's Content-Security-Policy sets `connect-src 'none'`, `img-src data: blob:`, `form-action 'none'` and `default-src 'none'`, so the browser itself refuses outgoing requests. |
| Nothing is stored | No cookies, local storage, IndexedDB or service worker. Closing the tab erases everything. |
| No LLM or AI service | The agent is classical statistics and ML plus written rules. There are no API keys or prompts. |
| No third parties | No CDN, analytics, ads or web fonts. Every file is served from this repository. |
| Stays true over time | `tests/run-tests.js` includes a privacy lint that fails CI if network, storage or tracking code is ever added. |

**Verify it yourself:** open DevTools → Network and run the agent, or press **Run privacy self-test** on the page. It deliberately tries to reach an outside server and shows that the browser blocks it.

**Fine print:** GitHub Pages, like any web host, logs that the page was opened. It never receives your data. Browser extensions can read any page you open, so use a clean browser profile for sensitive data. For the strictest setup, download this folder and open `index.html` from disk with Wi-Fi off. It works fully offline.

## Run locally

```sh
python3 -m http.server 8000   # from the repo root, then open http://localhost:8000/ml-agent/
node --test ml-agent/tests/run-tests.js
```

## Files

| File | Role |
|---|---|
| `engine.js` | CSV parsing, profiling, encoding, models, cross-validation, k-means, PCA |
| `doe.js` | DOE detection, analysis and design generation |
| `agent.js` | Orchestration, model choice, findings and DMAIC next steps |
| `charts.js` | Dependency-free SVG charts |
| `app.js` | Page logic and privacy self-test |
| `samples.js` | Synthetic practice datasets |

Limits: up to 3,000 rows are used for modeling (a random sample above that), classification supports up to 20 classes, and gradient boosting for classification is binary only.
