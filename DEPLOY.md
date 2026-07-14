# Деплой на Render — покрокова інструкція

Репозиторій на GitHub (`TimohaVysochynskyi/BinotelCallAnalyzer`), Render сам збирає образ з `Dockerfile` при кожному пуші в `main`.

## Крок 0 — що вже готово

- [x] Docker Desktop, локальний білд перевірено
- [x] Репозиторій на GitHub, підключений до Render
- [x] `DATABASE_URL` (Neon), `BINOTEL_API_KEY/SECRET`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN` — всі є
- [x] `binotel-poller` створено й задеплоєно

## Два сервіси з одного репо/образу

| Сервіс | Тип | Команда / Schedule | Що робить |
|---|---|---|---|
| `binotel-poller` | Cron Job | `*/15 * * * *`, `JOB_TYPE=poll` (CMD за замовч. `node src/jobs/index.js`) | Кожні 15 хв: тягне нові дзвінки з Binotel, транскрибує, класифікує, визначає менеджера, зберігає в Postgres |
| `binotel-bot` | Background Worker | Docker Command → `node src/bot/index.js` | Постійно онлайн: інтерактивний бот звітності + авто-звіти о 13:00/19:30 (Kyiv) |

Обидва — з того самого `Dockerfile` (образ спільний, бот лише перевизначає стартову команду). Regione обох — **Frankfurt (EU Central)** (як Neon). Cron Job — **Starter**; Background Worker — найдешевший постійний план (~$7/міс, бо процес живе 24/7).

## Env-змінні

`binotel-poller` (Cron Job):
```
BINOTEL_API_KEY, BINOTEL_API_SECRET, BINOTEL_BASE_URL,
OPENAI_API_KEY, OPENAI_TRANSCRIBE_MODEL, OPENAI_ANALYZE_MODEL, CALL_LANGUAGE,
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ADMIN_CHAT_ID,
DATABASE_URL, POLL_WINDOW_MINUTES, SHARED_EXTENSIONS, MAX_PENDING_ATTEMPTS,
JOB_TYPE=poll
```

`binotel-bot` (Background Worker):
```
TELEGRAM_BOT_TOKEN        (той самий єдиний бот @OBVCarServiceWork_bot, що й у поллера)
TELEGRAM_CHAT_ID          (owner chat: дефолт для allowlist і отримувача звітів)
BOT_ALLOWED_CHAT_IDS      (comma-separated user IDs, owner-only; дефолт — TELEGRAM_CHAT_ID)
BOT_REPORT_CHAT_ID        (куди слати авто-звіти; дефолт — TELEGRAM_CHAT_ID)
BOT_REPORT_TIMES=13:00,19:30
DATABASE_URL, OPENAI_API_KEY, OPENAI_ANALYZE_MODEL, OPENAI_EMBED_MODEL,
BINOTEL_API_KEY, BINOTEL_API_SECRET, BINOTEL_BASE_URL   (для "прослухати запис")
```

База знань бота потребує розширення **pgvector** — `migrateKb()` створює його автоматично (`CREATE EXTENSION IF NOT EXISTS vector`); Neon підтримує (перевірено, v0.8.1). Якщо його раптом нема — база знань просто вимкнеться, решта бота працює.

Обидва сервіси використовують **один** `TELEGRAM_BOT_TOKEN` (новий чистий бот). Поллер шле ним лише вихідні алерти, бот — інтерактив + звіти; конфлікту немає.

## Перший запуск таблиці менеджерів

Один раз (локально або будь-де з доступом до `DATABASE_URL`):

```
npm run seed:managers
```

Заповнює `managers` трьома відомими менеджерами (Роман/903, Андрій/904, Володимир/905). Idempotent — можна перезапускати, ручні правки не затирає.

## Перевірка на Render

Вкладка **Logs** сервіса `binotel-poller` — той самий вивід, що й локально (`[poll]`, `[binotel]`, `[processCalls]`). Кожен запуск: ретрай pending → поллінг нових дзвінків від чекпоінта → транскрипція/класифікація/атрибуція/збереження.

## Оновлення коду

Просто `git push` у `main` — Render автоматично пересобере й передеплоїть.

## Вартість

Мінімум $1/міс (один сервіс), плюс змінна частина OpenAI.
