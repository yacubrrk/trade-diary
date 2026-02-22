# Деплой в Railway (самый простой путь)

Ниже шаги максимально просто, без сложного сервера.

## Что уже должно быть

- У тебя есть папка проекта: `app`
- Локально проект уже запускается на `http://localhost:8000`

## Шаг 1. Залей проект в GitHub

Railway берет код из GitHub.

1. Открой [https://github.com](https://github.com)
2. Создай новый репозиторий (кнопка **New repository**)
3. Назови, например: `trade-diary`
4. В VS Code в терминале (в папке `app`) выполни команды:

```bash
git init
git add .
git commit -m "first deploy"
git branch -M main
git remote add origin https://github.com/ТВОЙ_ЛОГИН/trade-diary.git
git push -u origin main
```

Если репозиторий уже есть, просто сделай `git add . && git commit && git push`.

## Шаг 2. Создай проект в Railway

1. Открой [https://railway.app](https://railway.app)
2. Нажми **Start a New Project**
3. Нажми **Deploy from GitHub repo**
4. Выбери свой репозиторий `trade-diary`
5. Если Railway спросит **Root Directory**, укажи:

`app`

(Если репозиторий уже открыт сразу из папки `app`, Root Directory не нужен.)

## Шаг 3. Добавь переменные окружения

В Railway открой сервис -> **Variables** и добавь:

- `PORT` = `8000`
- `BYBIT_API_KEY` = твой ключ
- `BYBIT_API_SECRET` = твой секрет
- `BYBIT_RECV_WINDOW` = `5000`
- `BYBIT_BASE_URL` = `https://api.bybit.com`

## Шаг 4. Добавь диск для SQLite (важно)

Чтобы база не пропала после перезапуска:

1. В сервисе Railway открой **Volumes**
2. Нажми **Add Volume**
3. Mount path поставь:

`/app/data`

Именно туда приложение сохраняет файл базы `trades.db`.

## Шаг 5. Проверь запуск

1. Открой вкладку **Deployments**
2. Дождись статуса **Success**
3. Нажми **Generate Domain** (если домен еще не создан)
4. Открой URL вида `https://....up.railway.app`

Проверка API:
- `https://ТВОЙ_ДОМЕН/api/health`

Должно показать JSON с `ok: true`.

## Шаг 6. Подключи Telegram Mini App

1. В Telegram открой `@BotFather`
2. Создай бота: `/newbot`
3. Добавь кнопку Web App (Mini App)
4. Вставь URL Railway:

`https://ТВОЙ_ДОМЕН`

5. Открой бота и нажми кнопку приложения.

## Важно

- Для Bybit API используй ключ **только чтение (Read-Only)**.
- Не давай ключу права вывода средств.
