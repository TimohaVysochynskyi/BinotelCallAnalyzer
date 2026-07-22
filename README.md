# OBV Car Service Bot

Інжест-пайплайн дзвінків автосервісу. Один cron-джоб (`JOB_TYPE=poll`), що запускається кожні ~15 хв:

1. Бере нові дзвінки з Binotel з моменту останнього успішного запуску (чекпоінт, не фіксоване вікно)
2. Транскрибує запис через ElevenLabs (STT + розділення мовців в одному виклику) → зберігає готовий діалог **+ таймкоди реплік** (`calls.segments`, для аудіо-фрагментів у звіті); fallback — OpenAI, якщо ElevenLabs недоступний
3. Класифікує дзвінок (успішність / найслабший етап / оцінка 1–10) і робить **per-call аналіз поведінок** (`calls.behaviors` + тип дзвінка `call_purpose`: продажний/інформаційний — непродажні не потрапляють у findings; кеш для доказового звіту)
4. Визначає, **якому менеджеру** належить дзвінок, і зберігає все в Postgres

Звітності, PDF і Google Sheets у самому інжесті **немає свідомо** — це чистий збір даних. Звіти (тепер **доказові**: findings з реальними цитатами + аудіо-фрагменти), статистика й доступ до дзвінків — окремий Telegram-бот (`src/bot/`, `npm run bot`), що читає ту саму БД. Деталі бота — [`src/bot/README.md`](src/bot/README.md).

## Структура

Монорепо на ESM (`import`/`export`), feature-based:

```
src/
  core/     — спільне ядро (store, binotel, transcribe, elevenlabs, audioMeta, classifyCall, analyzeCall, quoteMatch, identifyManager, telegram, retry)
  jobs/     — задеплоєний cron-джоб інжесту (index.js + pollNewCalls + processCalls)
  scripts/  — одноразові тули (backfill, testSingleCall, reattributeShared, retranscribeRecent, backfillAnalysis)
  bot/      — Telegram-бот звітності (grammy, окремий токен): доказові звіти (текст+аудіо), статистика, архів розмов
```

## Ідентифікація оператора (джерело — Binotel)

Окремої таблиці менеджерів немає — джерело правди Binotel. Оператор ідентифікується **іменем** (`calls.manager_name`), по ньому ж групуються стата/архів/звіти. Логіка — `resolveManagerName` в `src/jobs/processCalls.js`:

- **Особисті номери** (903/904/905) — `manager_name` = `employeeData.name` від Binotel (як Binotel пише: "Роман", "Владимир", "Андрей").
- **Спільні слухавки** (`SHARED_EXTENSIONS`, дефолт `901,902`) — Binotel не знає, хто відповів. Тому `src/core/identifyManager.js` окремим OpenAI-запитом обирає, ХТО зі списку відомих операторів представився. Список кандидатів (roster) — динамічний: distinct імена, що Binotel уже давав на особистих номерах. AI повертає точно одне з них (сам зводить «Володя»→«Владимир») або `null` → лишається номер.

Нічого сідити/редагувати не треба: як тільки менеджер зробив дзвінок з особистого номера, його ім'я автоматично стає кандидатом для спільних. Клієнт має попросити операторів **представлятись** на 901/902 — від цього залежить якість.

Переприв'язати старі спільні дзвінки (з голим номером) через ту саму AI-ідентифікацію: `npm run reattribute:shared`.

## Сховище — Postgres (локальний PG18 на VPS)

1. `DATABASE_URL=postgres://obvbot:password@localhost:5432/obvbot` у `.env` (локальний Postgres на тому ж VPS). SSL авто-вимикається для localhost (`store.js: sslConfig()`); для віддаленого/managed з `sslmode=require` — лишається.
2. Таблиці (`calls` з `segments`/`behaviors`, `pending_calls`, `manager_notes`, `bot_users`, `app_state`) створюються автоматично при першому запуску (`migrate()`). База знань бота потребує **pgvector** (на локальному PG18 поставити пакетом — див. `DEPLOY.md`).

Після деплою одноразово прогнати `npm run backfill:analysis` (таймкоди + per-call аналіз для наявних дзвінків).

## Надійність — як уникаємо провалів у даних

- **Чекпоінт замість фіксованого вікна**: кожен успішний `poll` запам'ятовує, до якого моменту дзвінки оброблено (`app_state.last_polled_until`). Наступний запуск продовжує рівно звідти — пропущений cron не створює діру.
- **Черга `pending_calls`**: якщо запис ще не готовий (`recordingStatus != uploaded`) або сталась помилка — дзвінок не губиться, а ретраїться на кожному наступному `poll`, поки не вдасться (або поки не вичерпає `MAX_PENDING_ATTEMPTS`, дефолт 20 → `status='failed'` + алерт, дані лишаються для ручної перевірки).
- **Ретраї на кожному зовнішньому виклику**: Binotel/OpenAI/Telegram обгорнуті в `withRetry` (`src/core/retry.js`).

## Сповіщення про збої

`sendAlert()` (`src/core/telegram.js`) шле алерти у випадках:
- джоба впала з необробленою помилкою
- дзвінок у `pending_calls` вичерпав ліміт спроб
- **низький баланс ElevenLabs** (`< ELEVENLABS_MIN_BALANCE_USD`, дефолт $2) — перевіряється щопо-поллінгу, алерт при перетині порогу; потребує права `user_read` на ключі

Отримувачі алертів більше не в env — це список у БД (`app_state.alert_recipients`), яким керує директор у боті: `/settings` → «Сповіщення про поломки». Можна кількох одразу. Нема отримувачів → алерт лише в лог (не губиться). Алерти йдуть через той самий єдиний бот `@OBVCarServiceWork_bot` (вихідні виклики не конфліктують з `getUpdates` бота звітності).

**Залишок коштів OpenAI** — не через API (ендпоінт недокументований), а вбудованим лімітом у кабінеті: platform.openai.com → Settings → Limits.

## Команди

```
npm install
npm run poll                              # обробити нові дзвінки + ретрай pending
npm run bot                               # запустити бот звітності (long-polling)
npm run test:call -- <generalCallID>      # смок-тест транскрипції одного дзвінка (без БД)
npm run backfill -- "2026-07-01 00:00:00" "2026-07-03 23:59:59"   # історичний період
npm run reattribute:shared               # переприв'язати старі 901/902 до людей (AI)
npm run retranscribe:recent              # одноразово: останні 5 дзвінків кожного менеджера+Богдан → ElevenLabs (діаризація)
npm run retranscribe:last                # одноразово: останні 7 дзвінків глобально ФОРСОВАНО через ElevenLabs (після періоду без коштів → OpenAI-фолбек)
npm run backfill:analysis                # одноразово: останні 30/людину → таймкоди (segments) + per-call аналіз (behaviors) для доказового звіту
```

Backfill: дати в локальному часі машини, період ріжеться на шматки ≤23 год (ліміт Binotel), вже оброблені дзвінки пропускаються — безпечно перезапускати.

## Деплой

Див. `DEPLOY.md`. Коротко: VPS (AlmaLinux) + **pm2** (`ecosystem.config.cjs`) → **два процеси** з одного репо: `obv-poller` (`node src/jobs/index.js`, pm2 cron `*/15 * * * *`, `JOB_TYPE=poll`) і `obv-bot` (`node src/bot/index.js`, постійно online). Оновлення — `git pull && pm2 reload`.
