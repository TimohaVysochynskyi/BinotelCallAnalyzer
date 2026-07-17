# Деплой на VPS (AlmaLinux) — покрокова інструкція

Хостинг — власний VPS на **AlmaLinux 10**. Два процеси з одного репо тримає **pm2**:

| Процес       | Команда                                    | Режим                                                                                                                     |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `obv-bot`    | `node src/bot/index.js`                    | Постійно онлайн 24/7 (long-polling) — бот звітності + авто-звіти 13:00/19:30 (Kyiv)                                       |
| `obv-poller` | `node src/jobs/index.js` (`JOB_TYPE=poll`) | Разова задача кожні 15 хв: тягне нові дзвінки з Binotel → транскрибує → класифікує → визначає менеджера → пише в Postgres |

Обидва читають один `.env` з кореня проєкту (кожен entrypoint робить `import 'dotenv/config'`). Розклад поллера й тримання бота живим — усе через pm2 (`ecosystem.config.cjs` у репо), окремий system-cron чи Docker не потрібні.

Схема БД створюється сама при першому старті (`migrate()` / `migrateKb()`) — **ніяких ручних seed-кроків немає**.

## Крок 1 — Node.js 20+ і git

Підключись по SSH (PuTTY: Host = IP, Port 22, логін+пароль). Перевір, що є:

```bash
node -v; git --version
```

Якщо Node немає або версія < 20 — постав Node 20 з NodeSource:

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs git
node -v   # має бути v20.x
```

## Крок 2 — Клонувати репо і поставити залежності

```bash
cd ~
git clone https://github.com/TimohaVysochynskyi/OBVCarService.Bot.git
cd OBVCarService.Bot
npm install --omit=dev
```

## Крок 3 — Файл `.env`

Створи `.env` у корені (`nano .env`) з реальними значеннями. Повний список і коментарі — `.env.example`. Ключове:

```ini
DATABASE_URL=postgres://...neon.tech/...?sslmode=require
BINOTEL_API_KEY=...
BINOTEL_API_SECRET=...
BINOTEL_BASE_URL=https://api.binotel.com/api/4.0
OPENAI_API_KEY=...
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_ANALYZE_MODEL=gpt-4o-mini
OPENAI_EMBED_MODEL=text-embedding-3-small
CALL_LANGUAGE=
JOB_TYPE=poll
POLL_WINDOW_MINUTES=20
SHARED_EXTENSIONS=901,902
MAX_PENDING_ATTEMPTS=20
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...            # alerts (a group) + report fallback
BOT_ALLOWED_CHAT_IDS=...        # bootstrap: user ids seeded as directors
BOT_REPORT_CHAT_ID=...          # where auto-reports are sent
BOT_REPORT_TIMES=13:00,19:30
OPERATOR_ALIASES=
```

База знань бота потребує **pgvector** — `migrateKb()` створює розширення сам (`CREATE EXTENSION IF NOT EXISTS vector`); Neon підтримує (перевірено, v0.8.1). Нема розширення → база знань просто вимкнеться, решта бота живе.

Бот і поллер використовують **один** `TELEGRAM_BOT_TOKEN` (`@OBVCarServiceWork_bot`): поллер шле ним лише вихідні алерти, бот — інтерактив + звіти; конфлікту `getUpdates` немає.

## Крок 4 — pm2: запуск обох процесів

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 status
```

`ecosystem.config.cjs` уже в репо: `obv-bot` (autorestart, тримається online) і `obv-poller` (`autorestart:false` + `cron_restart: */15 * * * *` — pm2 перезапускає його кожні 15 хв; між запусками статус `stopped` — це нормально).

## Крок 5 — Автозапуск після ребуту

```bash
pm2 save
pm2 startup
```

`pm2 startup` виведе готовий рядок `sudo env PATH=... pm2 startup systemd -u <user> ...` — скопіюй і виконай його. Після цього pm2 підніме обидва процеси після будь-якого перезавантаження VPS.

> Вхідні порти відкривати не треба: бот працює на long-polling (лише вихідні з'єднання), inbound не використовується.

## Крок 6 — Перевірка

```bash
pm2 logs obv-bot --lines 30      # старт grammy без помилок
pm2 logs obv-poller --lines 30   # [poll], [binotel], [processCalls]
```

У Telegram відкрий `@OBVCarServiceWork_bot` → `/start` → `/menu`.

## Оновлення коду

```bash
cd ~/OBVCarService.Bot
git pull
npm install --omit=dev
pm2 reload ecosystem.config.cjs
```

## Корисні команди pm2

- `pm2 status` — стан процесів
- `pm2 logs` — живі логи обох
- `pm2 restart obv-bot` / `pm2 restart obv-poller`
- `pm2 reload ecosystem.config.cjs` — застосувати оновлення без простою

## Вартість

VPS (постійний, бо бот живе 24/7) + змінна частина OpenAI. Neon Postgres — безкоштовний тариф із запасом.
