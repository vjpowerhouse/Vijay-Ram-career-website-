/* Plain-English explanations shared by the results page, the downloadable report and the
   Learn page, so a concept is explained the same way everywhere. Text only. */
(function (root) {
  'use strict';

  // Which Learn lesson explains each model.
  const MODEL_TOPIC = {
    baseline: 'scores', linear: 'linear', ridge: 'ridge-lasso', lasso: 'ridge-lasso', quadratic: 'quadratic',
    logistic: 'logistic', naivebayes: 'naive-bayes', knn: 'knn', tree: 'tree', forest: 'forest', boosting: 'boosting'
  };

  const MODEL_ANALOGY = {
    baseline: 'A control group: always guess the average. Every real model has to beat it.',
    linear: 'A recipe: each ingredient adds or subtracts a fixed amount.',
    ridge: 'A recipe with a seat belt, so it does not over-react to noisy or overlapping ingredients.',
    lasso: 'A recipe that crosses out the ingredients that do not matter: the vital few, not the trivial many.',
    quadratic: 'Baking temperature: too low or too high both ruin the cake. It finds the sweet spot.',
    logistic: 'A credit-score card that adds up points and turns them into odds.',
    naivebayes: 'A detective matching a suspect to the profile each group usually fits.',
    knn: 'Asking the neighbours: "what happened the last few times conditions looked like this?"',
    tree: 'A troubleshooting flowchart, or a game of 20 questions.',
    forest: 'Asking 60 experienced operators separately and going with the majority.',
    boosting: 'Golf: each shot corrects the miss of the one before.'
  };

  // "How to read this" text for each result chart: [what it shows, analogy, lesson id].
  const READ = {
    leaderboard: ['Each bar is one model\'s score on rows it never saw while learning. An R² of 0.80 means the model explains 80% of the ups and downs in the result; 0 means no better than always guessing the average. The yellow bar is the model the agent chose: the simplest one within a hair of the best.',
      'It is like grading students on a surprise exam, not on homework they could have copied.', 'cross-validation'],
    fitScatter: ['Each dot is one row. Left to right is what actually happened; bottom to top is what the model predicted without seeing that row. Dots hugging the dashed line are good predictions. A fan shape means the model is less reliable at that end. Dots far from the line are rows worth a closer look.',
      'Think of a target: the dashed line is the bullseye.', 'scores'],
    confusion: ['Rows are what really happened; columns are what the model said. The diagonal holds the correct calls. The other cells are the two kinds of mistakes.',
      'Like a smoke alarm: one mistake is a false alarm, the other is a missed fire. Decide which one costs you more.', 'scores'],
    drivers: ['The agent scrambled one column at a time and checked how much worse the model got. A big drop means the model leans on that column: a key driver. It measures predictive power, not cause and effect.',
      'Like removing one player from a team to see how much the score suffers.', 'reading-results'],
    pd: ['Each panel shows what the model expects as one driver changes while everything else stays as it was. A rising line means more of this driver goes with a higher result. A hump is a sweet spot. A flat line means it barely matters in this range. The dashed marker is your typical value.',
      'Like turning one knob on a mixing desk while leaving the others alone and listening to the change.', 'reading-results'],
    whatif: ['Move the sliders to try settings and see what the chosen model predicts. Columns not shown stay at their typical value. Stay within the ranges in your data; outside them the model is guessing.',
      'A flight simulator: safe for practice, but confirm in the real world.', 'reading-results'],
    tree: ['Read it like a troubleshooting flowchart: start at the top, answer each question, and follow yes or no down to a rounded box with the expected result. Green boxes are the best outcomes, red the worst. This is a simplified 3-question tree trained on your data to show the main patterns. The chosen model is more detailed.',
      'It is the game of 20 questions, played with your data.', 'tree'],
    forest: ['Your random forest grew many trees. Here are the top levels of three of them. Each tree saw a different random sample of rows and columns, so each asks different questions. The forest averages all their answers, which cancels out the quirks of any single tree.',
      'Wisdom of the crowd: many independent opinions beat one expert who might be having a bad day.', 'forest'],
    boosting: ['Gradient boosting builds small trees in a chain. The first tree makes a rough guess, and every later tree learns only the part the earlier trees still got wrong. Here are the first three; the rounded boxes show the correction each one adds.',
      'Golf: each shot corrects the miss of the one before, until you are on the green.', 'boosting'],
    recipe: ['Start from the base value, then each column adds or subtracts a fixed amount per unit. Category columns are compared with the most common category.',
      'A recipe card: two more spoons of sugar always adds the same sweetness.', 'linear'],
    pareto: ['Each bar is one effect, scaled by how much it stands out from noise. Bars that cross the red dashed line are real effects: there is less than a 5% chance that noise alone would produce them.',
      'Signal versus static on a radio: the tall bars are the voices you can actually hear.', 'significance'],
    effects: ['Effect = how much the result changes when a factor goes from its low to its high level. The p-value is the chance of seeing an effect this big from noise alone; below 0.05 counts as real. A coefficient is half the effect, because coded levels run from −1 to +1.',
      'p-value: if nothing were really going on, how surprised should you be?', 'significance'],
    mainEffects: ['Each panel plots the average result at each level of one factor. A steeper line is a stronger factor. A flat line means the factor does not matter in this range. All panels share one scale, so you can compare them.',
      'Like comparing how hard each pedal on a bike pushes you forward.', 'factorial'],
    interaction: ['If the two lines are parallel, the factors act independently. If they spread apart or cross, the effect of one factor depends on the setting of the other.',
      'Fertilizer only helps when there is enough water: the two work together.', 'interactions'],
    optimum: ['The agent searched the tested region for the settings its model expects to give the best result. It does not look beyond the levels you ran.',
      'A map is only reliable for the area that was surveyed.', 'reading-results'],
    pca: ['PCA squeezes many columns into the two directions in which rows differ the most, so you can see the whole dataset on one flat chart. Points close together are similar rows. Color and shape show the group each row was put in.',
      'Like photographing a 3D object from its most informative angle.', 'pca'],
    silhouette: ['For every row, silhouette compares how close it is to its own group with how close it is to the next nearest group. Near 1 means clear, separate groups; near 0 means groups that overlap.',
      'Like checking whether each guest is clearly sitting at one table, or standing between two.', 'kmeans'],
    profiles: ['Average of each numeric column in each group, next to the overall average. The last column says what makes each group different from the rest.',
      'A customer persona card, written from the data.', 'kmeans'],
    correlations: ['Correlation runs from −1 to 1 and says how tightly two columns move together. Close to ±1 is a strong link; near 0 is no straight-line link. It never proves that one causes the other.',
      'Ice-cream sales and sunburns rise together, but neither causes the other: the sun drives both.', 'why-doe']
  };

  const GLOSSARY = [
    ['Target', 'The column you want to predict or improve (the Y).'],
    ['Driver / factor', 'An input column that may influence the target (an X).'],
    ['Regression', 'Predicting a number, such as yield or cycle time.'],
    ['Classification', 'Predicting a category, such as pass or fail.'],
    ['Unsupervised', 'Finding structure (groups, unusual rows) when there is no target.'],
    ['Cross-validation', 'Scoring a model only on rows it did not learn from, round by round.'],
    ['R²', 'Share of the variation in the target that the model explains (0 to 1).'],
    ['RMSE', 'Typical size of a prediction error, in the target\'s own units.'],
    ['Balanced accuracy', 'Average of the hit rate for each class, so a rare class counts as much as a common one.'],
    ['Overfitting', 'Memorizing noise in the training data instead of learning the real pattern.'],
    ['p-value', 'Chance of seeing an effect this large from noise alone. Below 0.05 is usually called significant.'],
    ['Interaction', 'When the effect of one factor depends on the level of another.'],
    ['Center point', 'A DOE run with every factor in the middle of its range; it tests for curvature.'],
    ['Aliasing', 'When a smaller design cannot tell two effects apart.']
  ];

  root.MLExplain = { MODEL_TOPIC, MODEL_ANALOGY, READ, GLOSSARY };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MLExplain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
