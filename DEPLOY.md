# Деплой на VPS (AlmaLinux) — покрокова інструкція

Хостинг — власний VPS на **AlmaLinux 10**. Два процеси з одного репо тримає **pm2**:

| Процес       | Команда                                    | Режим                                                                                                                     |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `obv-bot`    | `node src/bot/index.js`                    | Постійно онлайн 24/7 (long-polling) — бот звітності + авто-звіти 13:00/19:30 (Kyiv)                                       |
| `obv-poller` | `node src/jobs/index.js` (`JOB_TYPE=poll`) | Разова задача кожні 15 хв: тягне нові дзвінки з Binotel → транскрибує → класифікує → визначає менеджера → пише в Postgres |

Обидва читають один `.env` з кореня проєкту (кожен entrypoint робить `import 'dotenv/config'`). Розклад поллера й тримання бота живим — усе через pm2 (`ecosystem.config.cjs` у репо), окремий system-cron чи Docker не потрібні.

Схема БД створюється сама при першому старті (`migrate()` / `migrateKb()`) — **ніяких ручних seed-кроків немає**.

## Крок 1 — Node.js 20+, git і ffmpeg

Підключись по SSH (PuTTY: Host = IP, Port 22, логін+пароль). Перевір, що є:

```bash
node -v; git --version; ffmpeg -version | head -1
```

Якщо Node немає або версія < 20 — постав Node 20 з NodeSource:

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs git
node -v   # має бути v20.x
```

**ffmpeg** потрібен для нарізки аудіо-фрагментів у доказовому звіті бота (кліпи навколо цитат). На AlmaLinux він у RPM Fusion:

```bash
sudo dnf install -y epel-release
sudo dnf install -y "https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm"
sudo dnf install -y ffmpeg
ffmpeg -version | head -1
```

> Без ffmpeg бот НЕ падає — доказовий звіт просто йде текстом без аудіо-кліпів (preflight-перевірка в `src/bot/audioClip.js`). Якщо ffmpeg не на PATH — вкажи шлях у `.env`: `FFMPEG_PATH=/usr/bin/ffmpeg`.

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
DATABASE_URL=postgres://obvbot:password@localhost:5432/obvbot   # local PG18; SSL auto-off for localhost
BINOTEL_API_KEY=...
BINOTEL_API_SECRET=...
BINOTEL_BASE_URL=https://api.binotel.com/api/4.0
OPENAI_API_KEY=...
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_ANALYZE_MODEL=gpt-4o-mini  # classification + per-call behavior MAP
OPENAI_REPORT_MODEL=gpt-4o        # report REDUCE (aggregation into findings); rare, so a stronger tier
OPENAI_EMBED_MODEL=text-embedding-3-small
CALL_LANGUAGE=
ELEVENLABS_API_KEY=...            # primary transcriber (STT + diarization/multichannel + timecodes); empty = OpenAI fallback
ELEVENLABS_STT_MODEL=scribe_v1
ELEVENLABS_NUM_SPEAKERS=2
ELEVENLABS_MIN_BALANCE_USD=2      # low-balance alert threshold (needs `user_read` permission on the key)
ELEVENLABS_USD_PER_1000_CREDITS=0.22  # credits→USD estimate; calibrate to your ElevenLabs dashboard
FFMPEG_PATH=ffmpeg                # audio-clip cutter for the evidence report (see Крок 1)
FFPROBE_PATH=ffprobe              # stereo/mono detection for multichannel STT (ships with ffmpeg)
AUDIO_CLIP_PAD_SEC=3
BACKFILL_LIMIT=30
JOB_TYPE=poll
POLL_WINDOW_MINUTES=20
SHARED_EXTENSIONS=901,902
MAX_PENDING_ATTEMPTS=20
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOOTSTRAP_CHAT_IDS=... # bootstrap: user ids seeded as directors (only Telegram id in env)
OPERATOR_ALIASES=
```

> Куди слати алерти/звіти ТА о котрій — більше НЕ в env, а в БД, кероване в боті: `/settings` → «Сповіщення про поломки» / «Щоденні звіти» / «Час звітів». На чистій БД списки отримувачів порожні; після старту зайдіть у бот і додайте їх (для групи-алертів — опція «числовий ID чату»). Час звітів до редагування = дефолт 13:00/19:30. Прибрані env-змінні: `TELEGRAM_CHAT_ID`, `BOT_REPORT_CHAT_ID`, `BOT_REPORT_TIMES`. `BOT_ALLOWED_CHAT_IDS` → `TELEGRAM_BOOTSTRAP_CHAT_IDS`.

> **Алерт про низький баланс ElevenLabs** іде тим самим отримувачам «Сповіщення про поломки». Щоб він працював, у самому ElevenLabs дай API-ключу дозвіл **`user_read`** (Developers → API Keys → права ключа), інакше бот один раз попередить, що не може читати баланс. Поріг — `ELEVENLABS_MIN_BALANCE_USD` (дефолт $2); долар оцінюється з кредитів за `ELEVENLABS_USD_PER_1000_CREDITS` — підкрутіть під суму, яку показує ваш дашборд.

> Якщо був період без коштів на ElevenLabs (дзвінки пішли через OpenAI, без діаризації/таймкодів) — після поповнення прожени `npm run retranscribe:last` (останні 7 дзвінків форсовано через ElevenLabs).

Транскрипція йде через **ElevenLabs STT (Scribe)** — транскрипція + розділення мовців в одному виклику, готовий діалог зберігається одразу. Для ~50 дзвінків/день потрібен план **Scale** (~$330/міс; STT = 330 кредитів/хв). Без `ELEVENLABS_API_KEY` (або якщо API впав) — автоматичний fallback на OpenAI-транскрипцію (без розділення мовців), дзвінок не губиться.

База знань бота потребує **pgvector** — `migrateKb()` створює розширення сам (`CREATE EXTENSION IF NOT EXISTS vector`). На локальному PG18 його треба спершу поставити пакетом (`sudo dnf install -y pgvector_18` або збірка з джерел) і перезапустити Postgres. Нема розширення → база знань просто вимкнеться, решта бота живе.

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

## Крок 7 — одноразовий беклог доказового звіту

Нові дзвінки одразу зберігають таймкоди (`segments`) і per-call аналіз (`behaviors`). Щоб доказовий звіт з аудіо працював і на вже наявних дзвінках, прожени беклог (останні 30 дзвінків кожного оператора-людини перетранскрибуються через ElevenLabs заради таймкодів + per-call map). Ідемпотентно — дзвінки, що вже мають `segments`, пропускаються.

```bash
cd ~/OBVCarService.Bot
npm run backfill:analysis        # BACKFILL_LIMIT (дефолт 30) керує глибиною
```

> Потребує `ELEVENLABS_API_KEY` + `OPENAI_API_KEY` (кредити) і живих записів у Binotel. Дзвінки без запису в Binotel пропускаються з попередженням.

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

VPS (постійний, бо бот живе 24/7) + змінна частина OpenAI + ElevenLabs (Scale). Postgres — локальний на тому ж VPS (без окремого хостингу). ffmpeg — безкоштовний.
