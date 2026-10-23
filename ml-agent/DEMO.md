# Executive demo script (about 12 minutes)

Every step below was run end to end. The times are from a laptop browser; your numbers should match closely because the agent uses fixed random seeds.

## 0. Before you start (2 minutes, not in front of the audience)
- Open the agent and the Academy (`learn.html`) in two tabs.
- Have `demo-data/` open in a file window, ready to drag.
- Optional: switch Wi-Fi off. Everything below still works, which is the strongest privacy proof you can give.

## 1. Privacy first (1 minute)
- Point to the green badge: "Private: data never leaves this browser".
- Scroll to **How your data stays private** and press **Run privacy self-test**. The page tries to contact an outside server and the browser blocks it.
- Key line: *"There is no server, no database and no AI service. The math runs on this laptop, and the browser itself is told to block any outgoing connection."*

## 2. From data to an action plan: concrete strength (3 minutes)
- Drag `concrete-strength.csv` in. Target: `strength`. Goal: **Higher strength is better**. Run.
- Expect about 5 seconds, **Gradient boosting** chosen, about **90% of variation explained**.
- Read the **Action plan** aloud: raise cement, lower water, raise slag, and a sweet spot for age.
- Talking point: *"The agent doesn't know concrete. It found that more cement and less water make stronger concrete, which any civil engineer would confirm. It also flags `age` as a lever, but age is test age, not something you set. That is why the subject-matter expert stays in the loop."*
- Open **Peek inside the model** to show the readable decision tree.

## 3. Designed experiments: built-in 2⁴ factorial (2 minutes)
- Click the practice dataset **2⁴ factorial DOE + center points**, run.
- Show the **Pareto of effects**: Temperature, Catalyst and their interaction are significant.
- Show the **interaction plot** and the **best settings**.
- Scroll to the **DOE builder**: the next experiment is already drafted. Download the run sheet.
- Talking point: *"Historical data tells us where to look; a DOE proves cause and effect. The tool does both and hands over the run sheet."*

## 4. Honesty: wine quality (1 minute, optional; takes about 15 to 20 seconds)
- Drag `wine-quality-white.csv`, target `quality`, run.
- Expect **Random forest**, about **45% explained**, flagged as **weak**.
- Talking point: *"It tells us when the data isn't good enough. Taste depends on things not in this file. A tool that always sounds confident is dangerous; this one isn't."*

## 5. Finding groups with no target: penguins (1 minute)
- Drag `penguins.csv`, choose **Nothing: find groups and patterns**, run.
- Show the groups chart and profiles: one group is entirely Gentoo penguins on Biscoe island. The agent found the species without being told.

## 6. Teaching (2 minutes)
- Switch to the Academy tab, lesson **Random forest**. Click the map and flip through the five trees to show them voting.
- Talking point: *"Anyone in the team can learn what the model is doing, with analogies, in their own time."*

## 7. Close (1 minute)
- Back in the agent, press **Finish and delete my data**. Everything is gone.
- Ask: *"Where would we use this first?"* Have one internal use case ready, such as yield drivers on one line or a DOE for one stubborn defect.

## Questions executives usually ask

| Question | Answer |
|---|---|
| Where does our data go? | Nowhere. It stays in the browser tab and is wiped on delete, after 30 idle minutes, or when the tab closes. The page is technically blocked from sending anything. |
| Does it use ChatGPT or another AI service? | No. It uses classical statistics and machine learning that run on the laptop. No data is shared with any AI vendor. |
| What does IT need to host it? | A folder of static files on any internal web server. No database, no backend, no internet access. See `DEPLOY.md`. |
| Is it validated for GxP decisions? | No. It is a decision-support and learning tool. Use it to find hypotheses and design experiments, and use your validated systems for release decisions. |
| How big a file can it take? | Up to 50 MB. It models up to 3,000 rows (a random sample above that), so even large files finish in under about 20 seconds. |
| Who maintains it? | The code is small, dependency-free and covered by automated tests, including a test that fails if anyone adds code that could send data out. |
