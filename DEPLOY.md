# Деплой на Render — покрокова інструкція

Без GitHub: образ збирається локально й пушиться напряму в Docker Hub, Render тягне його звідти. Перевірено локально: `docker build` + `docker run --env-file .env` відпрацював ідентично звичайному `npm run`.

## Крок 0 — що вже потрібно мати готовим

- [x] Docker Desktop встановлено й запущено (перевірено на цій машині)
- [x] `DATABASE_URL` (Neon) — є в `.env`
- [x] `BINOTEL_API_KEY` / `BINOTEL_API_SECRET` — є в `.env`
- [x] `OPENAI_API_KEY` — є в `.env`
- [x] `TELEGRAM_BOT_TOKEN` — є в `.env`
- [ ] `TELEGRAM_CHAT_ID` — підставлено (`1043029184`), але поки не підтверджено доставку (див. розділ "Що ще потрібно" нижче)
- [ ] Акаунт Docker Hub
- [ ] Акаунт Render

## Крок 1 — Docker Hub

1. Зареєструватись на [hub.docker.com](https://hub.docker.com) (безкоштовно, email)
2. Локально увійти: `docker login` (введеш свій логін/пароль Docker Hub)
3. Запам'ятай свій логін — він піде в назву образу

## Крок 2 — зібрати і запушити образ

У папці проєкту (`BinotelCallAnalyzer`):

```
docker build -t <твій-докерхаб-логін>/binotel-call-analyzer:latest .
docker push <твій-докерхаб-логін>/binotel-call-analyzer:latest
```

Перше збереться швидко (~5 сек, вже перевірено), друге залежить від швидкості інтернету (образ невеликий, ~150 МБ).

## Крок 3 — акаунт Render

Зареєструватись на [render.com](https://render.com) (email, без картки для Cron Job теж не питають на старті, але для оплати $1+/міс зрештою треба буде прив'язати спосіб оплати).

## Крок 4 — перший сервіс: `binotel-poller`

1. Render dashboard → **New** → **Cron Job**
2. **Source**: обрати "Existing Image" → вказати `<твій-докерхаб-логін>/binotel-call-analyzer:latest`
   - Якщо образ приватний — Render попросить Docker Hub креденшли для доступу
3. **Name**: `binotel-poller`
4. **Schedule**: `*/15 * * * *` (кожні 15 хв)
5. **Environment Variables** — додати всі з `.env` окрім `JOB_TYPE`, плюс:
   ```
   JOB_TYPE=poll
   ```
   Повний список: `BINOTEL_API_KEY`, `BINOTEL_API_SECRET`, `BINOTEL_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_ANALYZE_MODEL`, `CALL_LANGUAGE`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_CHAT_ID`, `DATABASE_URL`, `POLL_WINDOW_MINUTES`, `MAX_PENDING_ATTEMPTS`, `JOB_TYPE=poll`
6. Створити сервіс

## Крок 5 — другий сервіс: `binotel-daily-report`

Те саме, але:
- **Name**: `binotel-daily-report`
- **Schedule**: `0 8 * * *` (щодня о 8:00 UTC = 11:00 за Києвом влітку)
- Ті самі env-змінні, крім `JOB_TYPE=report`

Обидва сервіси використовують один і той самий образ і одну й ту саму базу Neon — вони незалежні, але діляться даними через Postgres.

## Крок 6 — перевірка

- В Render dashboard кожен Cron Job має вкладку **Logs** — після першого запланованого запуску (або натиснути "Trigger Run" вручну) там має з'явитись той самий консольний вивід (`[poll]`, `[binotel]`, `[processCalls]` тощо), що й локально
- Якщо `binotel-poller` відпрацював без помилок і чекпоінт посунувся — все ок
- `binotel-daily-report` варто один раз запустити вручну ("Trigger Run"), щоб побачити реальне повідомлення в Telegram (за умови, що є транскрипти за останні 24 год)

## Крок 7 — оновлення коду після змін

```
docker build -t <твій-докерхаб-логін>/binotel-call-analyzer:latest .
docker push <твій-докерхаб-логін>/binotel-call-analyzer:latest
```

Потім у Render, на кожному з двох сервісів: **Manual Deploy → Deploy latest image** (або викликати deploy hook URL сервісу через `curl` — знайдеш у Settings сервісу).

## Вартість

Cron Job тарифікується посекундно, мінімум $1/міс на сервіс → **~$2/міс за обидва**, плюс змінна частина OpenAI (див. окремий розрахунок витрат).
