# Оцінка ефективності менеджерів — технічний опис

Довідник пайплайну оцінки (доповнює [CLAUDE.md](CLAUDE.md)). Формат: стадія → що робить → де в коді.

## Два процеси (монорепо, ESM, один `.env`)

| Процес | Entry | Роль |
| --- | --- | --- |
| `obv-poller` | [src/jobs/index.js](src/jobs/index.js) | Інжест: cron `*/15`, `JOB_TYPE=poll`. Збирає, транскрибує, аналізує per-call, пише в БД. |
| `obv-bot` | [src/bot/index.js](src/bot/index.js) | Бот звітності (grammy, long-polling). Читає БД, будує доказові звіти. |

`migrate()` / `migrateKb()` створюють схему на старті. Джерело правди про оператора — Binotel (`manager_name`), локальної таблиці менеджерів немає.

---

## A. Інжест (per-call, рахується РАЗ)

Ланцюг: [pollNewCalls.js](src/jobs/pollNewCalls.js) → [processCalls.js](src/jobs/processCalls.js) → `core/*`.

1. **Поллінг** — `pollNewCalls()`: чекпоінт `app_state.last_polled_until` → тепер (не фіксоване вікно; діапазон ріжеться по 23 год — `splitIntoChunks`). Binotel: `listCallsForPeriod`, `getCallRecordUrl` ([binotel.js](src/core/binotel.js)).
2. **Фільтр** — `processOneCall`: `durationSec<=0` → skip; `recordingStatus!='uploaded'` → чергу `pending_calls` (ретрай до `MAX_PENDING_ATTEMPTS`, потім `status='failed'` + `sendAlert`).
3. **Транскрипція** — `transcribeAudio(url,{managerName})` → `{transcript, segments}` ([transcribe.js](src/core/transcribe.js)).
   - Первинно **ElevenLabs Scribe** ([elevenlabs.js](src/core/elevenlabs.js) `transcribeDiarized`).
   - **Стерео vs моно**: `probeChannels(blob)` (ffprobe, [audioMeta.js](src/core/audioMeta.js)). ≥2 канали → `sttDiarize(blob,{multichannel:true})` (`use_multi_channel`, `diarize:false`, `multichannel_output_style:combined`) → поділ мовців по каналах (точний). Моно → `diarize:true`.
   - `buildTurns(words)` групує слова в репліки за `speaker_id`/`channel_index`, зберігає `start/end`.
   - `pickManagerSpeaker(turns, speakerIds, managerName)` — хто менеджер: (1) `selfIntroManager` (самопредставлення іменем), (2) LLM, (3) `heuristicManager` (keyword-маркери). Роль → `segments[].role`.
   - **Fallback OpenAI** (нема ключа / API впав): текст без діаризації → `segments=null`.
4. **Атрибуція** — `resolveManagerName`: особистий номер → `employeeData.name`; спільний (`SHARED_EXTENSIONS`) → `identifyManager(transcript, roster)` ([identifyManager.js](src/core/identifyManager.js)). Виконується ДО MAP, бо ім'я менеджера — контекст для MAP.
5. **Per-call MAP (визначає МЕТУ ПЕРШОЮ)** — `analyzeCallBehaviors(transcript, segments, managerName)` ([analyzeCall.js](src/core/analyzeCall.js), `OPENAI_ANALYZE_MODEL`) → `{version, callPurpose, items[]}`:
   - `callPurpose`: `sales` | `info` | `other` (`CALL_PURPOSES`). **Тільки `sales` дає `items`**; `info`/`other` → `items:[]`.
   - `items[]`: `{type:'strength'|'error', stage, label, quote}`. Цитата приймається лише якщо `findQuote(segments, quote, {requireRole:'manager'})` знайшла її **в сегменті менеджера** → привʼязує `{start,end,segIndex}`. Інакше item відкидається (анти-фабрикація + анти-мисатрибуція).
   - `ANALYSIS_VERSION=2` (bump → re-map через беклог).
6. **ГЕЙТ ЕФЕКТИВНОСТІ за метою** (Задача 1) — `classifyCall(transcript)` → `{isSuccess, weakestStage, communicationScore}` ([classifyCall.js](src/core/classifyCall.js); `OPENAI_ANALYZE_MODEL`) виконується **ЛИШЕ якщо `callPurpose === 'sales'`**. Для `info`/`other` `classifyCall` **не викликається взагалі** (нуль ресурсу на оцінку непродажного), поля = NULL. Стійкість: MAP впав (мета невідома) → трактуємо як `sales` і все ж робимо `classifyCall`, щоб транзієнтна помилка не з'їла оцінку.
   - `weakestStage` enum — спільна таксономія **4 етапів** [stages.js](src/core/stages.js): `SALES_STAGES` (та сама, що й `analyzeCall.item.stage`; + `null` коли етап не застосовний). **НЕ редагована** (Задача 2B).
   - `communicationScore` (1-10) — за **редагованою РУБРИКОЮ** (Задача 2A): `getScoreRubric()` = `app_state.score_rubric` (правив власник через `/rubric`) або `DEFAULT_SCORE_RUBRIC` (анкерована шкала 9-10…1-2). Рубрика інжектиться в system-промпт; редагується лише формулювання критеріїв — шкалу/структуру/enum тримає код.
7. **Збереження** — `saveCall(...)` ([store.js](src/core/store.js)): `transcript`, `segments`, `behaviors`, `analysis_version`, `call_purpose`, класифікація-або-NULL, `manager_name`. MAP не фатальний (фейл → `behaviors=null`, мета трактується як sales на кроці 6).
8. **Watchdog балансу** — `checkElevenLabsBalance()` ([pollNewCalls.js](src/jobs/pollNewCalls.js)): `getElevenLabsBalance()` → `character_limit-character_count`; USD-оцінка (`ELEVENLABS_USD_PER_1000_CREDITS`); `< ELEVENLABS_MIN_BALANCE_USD` → `sendAlert`. Дедуп `app_state.elevenlabs_balance_state` (`ok`/`low`/`no_permission`). Потребує права ключа `user_read`.

---

## B. Схема даних (`calls`, ключове)

| Колонка | Тип | Зміст |
| --- | --- | --- |
| `manager_name` | TEXT | Ключ групування всюди (ім'я від Binotel). |
| `transcript` | TEXT | Готовий діалог «Менеджер:/Клієнт:» (миттєвий архів). |
| `segments` | JSONB | `[{role:'manager'|'client', text, start, end}]` — таймкоди для аудіо. `null` на OpenAI-fallback. |
| `behaviors` | JSONB | `{version, callPurpose, items:[{type,stage,label,quote,start,end,segIndex}]}`. Кешований MAP. |
| `call_purpose` | TEXT | `sales`/`info`/`other`. NULL = не аналізовано (трактується як sales). |
| `analysis_version` | INT | =2. |
| `is_success`,`weakest_stage`,`communication_score` | — | Класифікація. |

`app_state`: `last_polled_until`, `analyze_prompt`, `score_rubric` (рубрика `communicationScore`, `/rubric`), `report_recipients`/`alert_recipients`, `report_times`, `delivered_report_slots` (дедуп доставлених слотів авто-звіту), `elevenlabs_balance_state`.

**`report_segments`** (Задача 3) — кеш аналітики по `(manager_name × [period_start,period_end] × kind)`: `findings`/`phrases`/`stats`/`call_ids` JSONB, `candidate_count`, `analysis_version`, `meta` (`{rubricHash,promptHash,model,passes}`). `kind` = `scheduled` (незмінний ряд росту, self-consistency) / `manual_tail` (ефемерний, дедуп по `call_ids`, GC >2 діб). Пише БОТ. Функції в `store.js`: `getStoredSegment/getLatestManualTail/getScheduledSegmentsInRange/upsertReportSegment/getCallIdsForOperator/deleteOldManualTails` + `getDeliveredSlots/markSlotDelivered`.

---

## C. Звіт (персистентна аналітика по відрізках — Задача 3, Фаза 1)

Тригери: кнопка/`/report` (`sendManualReport`), «Статистика менеджера» (`stat:go` → `deliverManagerReport`), розклад (`maybeSendScheduledReport`). Оркестрація — [report.js](src/bot/report.js), кеш/збірка — [segments.js](src/bot/segments.js).

**Ідея:** дорогий REDUCE рахується РАЗ на день-обмежений відрізок і **замерзає** в `report_segments`; звіти лише агрегують заморожене + свіжий хвіст. Це прибрало повтори (подвійний клік, авто+ручний) і дало часовий ряд для РОСТУ.

- **Відрізки** — межі доби Київ, розбиті слотами (`time.js: kyivDaySegments`): `[00:00,слот1),…,[остСлот,24:00)`, без дір.
- **`assembleReport(name,start,end)`** ([segments.js](src/bot/segments.js)): числа live (`getOperatorStats`) → перелічити день-обмежені відрізки в періоді → кожен ПОВНИЙ = `getOrComputeScheduledSegment` (reuse замороженого / порахувати+зберегти) → залишок `[остання межа, now]` = `computeTail` (ефемерний `manual_tail`). Повертає **блоки** `[{start,end,kind,findings,phrases}]`.
- **REDUCE із self-consistency** — `reduceFindingsConsistent(name,calls,stats,passes)`: `runReducePass` × `SEGMENT_CONSISTENCY_PASSES`(3) → `assembleFindings` кожен → `corroborate` (кластер за перетином доказів, лишити підтверджені строгою більшістю прогонів) → один `verifyFindingsRelevance`. Заморожені відрізки — з повними passes; ефемерний хвіст — 1 pass.
- **Код-верифікація** `assembleFindings` (як раніше): id→кандидат, тип збігається, `findQuote(requireRole:'manager')`, дедуп, `< MIN_EVIDENCE`(3) → відкид, errors-first.
- **Дедуп/цілісність** — подвійний клік: `manual_tail` з тим самим `call_ids` віддається без аналізу. Grace: слот віддається через `SEGMENT_GRACE_MIN`(10) хв. Self-heal: недавній (≤24 год) заморожений відрізок зі зміненим `call_ids` перераховується.
- **Готові фрази** — `recommended_phrases` від моделі (об'єднання по прогонах, дедуп, ≤7).

Блок finding: `{type, claim, why, action, evidence:[{callId, startTime, quote, start, end}]}`. ⚠️ Тиждень/місяць/квартал у «Статистиці менеджера» поки на живому single-reduce (`buildManagerEvidenceReport`, один блок); Фаза 2 → список відрізків + тренд.

---

## D. Доставка (Telegram)

`deliverReport(api, chatId, report, {clips})` ([report.js](src/bot/report.js)):
- header (`headerText`, Markdown): всього / продажних / інформаційних, конверсія й найслабший етап **по продажних** (по всьому періоду, live);
- **блоки по відрізках** (`report.blocks`): якщо блоків >1 — підзаголовок `blockHeader` з інтервалом (основа відстеження росту); findings (`findingText`, plain — цитати можуть містити `_*[`);
- **аудіо лише під `error`-findings**: `prepareClips(report)` ([audioClip.js](src/bot/audioClip.js)) — системний ffmpeg вирізає `[start−pad, end+pad]` (`AUDIO_CLIP_PAD_SEC`), ≤3 кліпи/finding, кеш завантаження mp3 на дзвінок; нема ffmpeg → текст (preflight `ffmpegAvailable`, не падає); `sendClip`;
- готові фрази;
- **рендериться ЗАВЖДИ**: нема findings → «критичних патернів не зафіксовано» / «продажних дзвінків не було».

Fan-out: `sendScheduledReport` будує звіт+кліпи ОДИН раз на менеджера, розсилає всім `report_recipients`.

---

## E. Гарантії (забезпечує КОД, не промпт)

1. Цитата існує в транскрипті — `findQuote`.
2. Цитата — репліка **менеджера** — `requireRole:'manager'`.
3. Непродажні дзвінки не дають findings — `call_purpose` gate у MAP + `buildCandidates`.
4. Мінімум 3 докази — `MIN_EVIDENCE` в `assembleFindings`.
5. Без дублів — глобальний `usedIds`.
6. Релевантність — `verifyFindingsRelevance`.
7. Промпт `/prompt` керує ЛИШЕ тоном/формулюваннями звіту; рубрика `/rubric` — ЛИШЕ критеріями балу 1-10. Структуру, правила доказів, шкалу й таксономію етапів (`core/stages.js`) — код.

---

## F. Ролі / доступ ([access.js](src/bot/access.js), таблиця `bot_users`)

- `director`/`marketer` (admin) — повний доказовий звіт (`deliverManagerReport`, audio) + редагування промпта звіту (`/prompt`) і рубрики оцінки (`/rubric`).
- `manager` — ЛИШЕ числовий блок про себе (`me:go` у [stats.js](src/bot/stats.js)), БЕЗ findings/аудіо. Ідентичність — `bot_users.operator_name`.
- `mechanic` — лише база знань.
- Gate: `featureOf(ctx)` + `canAccess(role, feature)`. Меню — `mainMenu(role)` ([keyboards.js](src/bot/keyboards.js)).

---

## G. Розклад / надійність

- Слоти звітів — `app_state.report_times` (`/settings`, дефолт `13:00,19:30` Kyiv), `setInterval` 30с у боті (не cron).
- Чекпоінт + `pending_calls` + `withRetry` ([retry.js](src/core/retry.js)) → нічого не губиться мовчки.
- Kyiv-час — [bot/time.js](src/bot/time.js) (`Intl.DateTimeFormat`).

---

## H. Env (ключове; повний — [.env.example](.env.example))

| Env | Дефолт | Для чого |
| --- | --- | --- |
| `OPENAI_ANALYZE_MODEL` | `gpt-4o-mini` | classify + per-call MAP + identify. |
| `OPENAI_REPORT_MODEL` | `gpt-4o` | REDUCE + перевірка релевантності. |
| `ELEVENLABS_API_KEY` | — | STT (порожньо → OpenAI-fallback). Треба право `user_read` для балансу. |
| `FFMPEG_PATH`/`FFPROBE_PATH` | `ffmpeg`/`ffprobe` | Кліпи / детекція стерео. |
| `AUDIO_CLIP_PAD_SEC` | `3` | Паддинг кліпу. |
| `ELEVENLABS_MIN_BALANCE_USD` | `2` | Поріг алерту балансу. |
| `ELEVENLABS_USD_PER_1000_CREDITS` | `0.22` | Кредити→USD (калібрувати під дашборд). |
| `SHARED_EXTENSIONS` | `901,902` | Спільні номери → `identifyManager`. |
| `BACKFILL_LIMIT` / `RETRANSCRIBE_LAST_LIMIT` | `30` / `7` | Глибина беклогу / re-run. |
| `SEGMENT_CONSISTENCY_PASSES` | `3` | Скільки прогонів REDUCE на заморожений відрізок (self-consistency). |
| `SEGMENT_GRACE_MIN` | `10` | Затримка віддачі слота авто-звіту (щоб ретраї встигли до заморозки відрізка). |

---

## I. Одноразові скрипти ([src/scripts/](src/scripts/))

| npm | Що |
| --- | --- |
| `backfill:analysis` | Останні 30/людину → re-STT (segments) + MAP (behaviors + call_purpose). Ідемпотентно (skip якщо `analysis_version>=2`). Наповнює історію для звіту. |
| `backfill:purpose` | ДЕШЕВО: усім історичним дзвінкам з `call_purpose IS NULL` проставити мету — тільки per-call MAP по НАЯВНОМУ транскрипту, БЕЗ re-STT/ElevenLabs (`getCallsMissingPurpose` → `analyzeCallBehaviors` → `updateCallAnalysis`, наявні segments зберігаються). Прибирає «NULL=sales» для всієї історії. Ідемпотентно (лише NULL-мета). Легкий брат `backfill:analysis`. |
| `retranscribe:last` | Останні 7 дзвінків глобально ФОРСОВАНО через ElevenLabs (без OpenAI-fallback) + re-map. Після періоду без коштів. |
| `retranscribe:recent` | Останні 5/людину → ElevenLabs, оновити лише transcript. |
| `reattribute:shared` | Переатрибуція старих 901/902 через `identifyManager`. |
| `backfill` | Довільний історичний період через основний інжест. |
| `test:call -- <id>` | Смок-тест транскрипції одного дзвінка (без БД). |

---

## J. Інваріанти / пастки

- MAP рахується **раз на дзвінок** (інжест). Звіти НЕ переаналізовують дзвінки — лише агрегують `behaviors`. Зміна таксономії → bump `ANALYSIS_VERSION` + `backfill:analysis`.
- `segments=null` (OpenAI-fallback / старі рядки) → цитати без аудіо (текст лишається).
- Точність ролей на **моно** обмежена (LLM+евристики); на **стерео** — точна (канали). Голосовий відбиток — планова задача.
- Стара якість `behaviors` (v1) підтягнеться лише після `backfill:analysis`.
- Баланс ElevenLabs у **кредитах**, не доларах → USD це оцінка (`ELEVENLABS_USD_PER_1000_CREDITS`).
- SSL БД: `sslConfig()` вимикає SSL для localhost (локальний PG18).
