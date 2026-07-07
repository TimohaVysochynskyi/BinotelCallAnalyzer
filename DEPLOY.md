# Деплой на Render — покрокова інструкція

Репозиторій на GitHub (`TimohaVysochynskyi/BinotelCallAnalyzer`), Render сам збирає образ з `Dockerfile` при кожному пуші в `main`.

## Крок 0 — що вже готово

- [x] Docker Desktop, локальний білд перевірено
- [x] Репозиторій на GitHub, підключений до Render
- [x] `DATABASE_URL` (Neon), `BINOTEL_API_KEY/SECRET`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN` — всі є
- [x] `binotel-poller` створено й задеплоєно

## Один Render Cron Job сервіс

| Сервіс | Schedule | `JOB_TYPE` | Що робить |
|---|---|---|---|
| `binotel-poller` | `*/15 * * * *` | `poll` | Кожні 15 хв: тягне нові дзвінки з Binotel, транскрибує, зберігає. Додатково — раз на добу, коли київський час доходить до `REPORT_HOUR` (за замовчуванням 8:00) — сам генерує й надсилає в Telegram звіт за попередню повну добу |

Більше сервісів на Render не потрібно — і polling, і щоденний звіт живуть в одному job'і, розрізняючись лише внутрішньою логікою за часом доби (`src/pollNewCalls.js` → `maybeSendDailyReport()`).

Region — **Frankfurt (EU Central)** (той самий регіон, що й Neon). Instance Type — **Starter**.

## Env-змінні

```
BINOTEL_API_KEY, BINOTEL_API_SECRET, BINOTEL_BASE_URL,
OPENAI_API_KEY, OPENAI_TRANSCRIBE_MODEL, OPENAI_ANALYZE_MODEL, CALL_LANGUAGE,
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ADMIN_CHAT_ID,
DATABASE_URL, POLL_WINDOW_MINUTES, MAX_PENDING_ATTEMPTS, REPORT_HOUR,
JOB_TYPE=poll
```

## Ручний форс-тест звіту (локально, без Render)

```
npm run report
```

Ганяє звіт за попередню добу відразу, незалежно від часу й від того, чи вже надсилався сьогоднішній автоматичний звіт (це окрема, незалежна від `poll` дія — не займає денну позначку `last_report_date`, тож не заважає завтрашньому автоматичному запуску).

## Перевірка на Render

Вкладка **Logs** сервіса `binotel-poller` — той самий вивід, що й локально (`[poll]`, `[binotel]`, `[processCalls]`). Раз на добу, коли надходить `REPORT_HOUR`, там же з'являться рядки `[poll] Kyiv hour is ... generating now` і `[report] ...` — це і є автоматичний щоденний звіт.

## Оновлення коду

Просто `git push` у `main` — Render автоматично пересобере й передеплоїть.

## Вартість

Мінімум $1/міс (один сервіс), плюс змінна частина OpenAI.
