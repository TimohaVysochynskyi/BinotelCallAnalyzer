// Canonical sales-funnel stages — the SINGLE source of truth for the stage taxonomy, used
// EVERYWHERE effectiveness is evaluated:
//   • classifyCall  — the call's weakest stage (calls.weakest_stage, shown in the report header);
//   • analyzeCall   — the stage of each tagged manager behaviour (internal metadata for the reduce).
//
// NOT bot-editable by design: this is a fixed taxonomy, not tunable guidance. Keep it in exactly one
// place so the classifier enum and the behaviour-tagging enum can never drift apart again. Changing
// this list is a taxonomy change — per the CLAUDE.md invariant it would warrant bumping analyzeCall's
// ANALYSIS_VERSION + re-mapping (only relevant if you rely on the internal item.stage of old rows).
// TODO (заплановано, НЕ зроблено — див. CLAUDE.md "Поточний статус"): власник хоче замінити цей
// набір на "закриття угоди", "виявлення потреби", "допродаж послуг", "скрипт" (замість "робота із
// запереченнями"). "скрипт" ще й потребує окремої фічі (можливість додавати сам скрипт), тому
// рішено відкласти. Коли робитимеш: це enum і в classifyCall.js (weakestStage), і в analyzeCall.js
// (item.stage) — обидва читають ЛИШЕ звідси, тож досить поміняти тут; АЛЕ бампни analyzeCall.js:
// ANALYSIS_VERSION і прожени backfill:analysis (старі рядки таблиці calls.weakest_stage/
// behaviors.items[].stage лишаться зі старими назвами, поки їх не переанализувати).
export const SALES_STAGES = [
  'виявлення потреби',
  'робота із запереченнями',
  'допродаж',
  'закриття угоди',
];
