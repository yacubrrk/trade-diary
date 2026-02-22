# Деплой на сервер (VPS) и подключение Telegram Mini App

Ниже инструкция для Ubuntu 22.04.

## 0) Что купить/подготовить

1. VPS (например: Hetzner, Timeweb, Selectel, DigitalOcean).
2. Домен (например: `mytradediary.ru`).
3. SSH доступ к серверу.

## 1) Зайти на сервер

С твоего компьютера:

```bash
ssh root@IP_СЕРВЕРА
```

## 2) Установить Docker

На сервере выполни:

```bash
apt update
apt install -y docker.io docker-compose-plugin
systemctl enable docker
systemctl start docker
```

Проверка:

```bash
docker --version
```

## 3) Загрузить проект на сервер

Вариант A (через git):

```bash
apt install -y git
git clone <URL_ТВОЕГО_РЕПО> trade-diary
cd trade-diary/app
```

Вариант B (через VS Code + upload) — если без git.

## 4) Создать .env

В папке `app`:

```bash
cp .env.example .env
nano .env
```

Заполни:

```env
PORT=8000
BYBIT_API_KEY=твой_ключ
BYBIT_API_SECRET=твой_секрет
BYBIT_RECV_WINDOW=5000
BYBIT_BASE_URL=https://api.bybit.com
```

Сохранить в nano:
- `Ctrl + O`, Enter, `Ctrl + X`

## 5) Запустить приложение в Docker

```bash
docker build -t trade-diary:latest .
docker run -d \
  --name trade-diary \
  --restart unless-stopped \
  -p 8000:8000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  trade-diary:latest
```

Проверка:

```bash
docker ps
curl -s http://127.0.0.1:8000/api/health
```

Должно вернуть `{"ok":true,...}`.

## 6) Открыть в браузере

Пока без HTTPS можно проверить:

- `http://IP_СЕРВЕРА:8000`

## 7) Сделать HTTPS (нужно для Telegram Mini App)

### 7.1 Установить Nginx + Certbot

```bash
apt install -y nginx certbot python3-certbot-nginx
```

### 7.2 Настроить DNS

В панели домена создай A-запись:
- `@` -> `IP_СЕРВЕРА`
- `www` -> `IP_СЕРВЕРА` (по желанию)

### 7.3 Конфиг Nginx

```bash
nano /etc/nginx/sites-available/trade-diary
```

Вставь (замени `mytradediary.ru`):

```nginx
server {
    server_name mytradediary.ru;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Включи сайт:

```bash
ln -s /etc/nginx/sites-available/trade-diary /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### 7.4 SSL сертификат

```bash
certbot --nginx -d mytradediary.ru
```

После этого сайт будет работать на:
- `https://mytradediary.ru`

## 8) Подключить Telegram Mini App

1. Открой `@BotFather`.
2. Создай бота: `/newbot`.
3. Добавь кнопку Mini App (Web App URL) и укажи:
   - `https://mytradediary.ru`
4. Открой своего бота в Telegram и нажми кнопку приложения.

## 9) Обновление приложения после изменений

В папке `app`:

```bash
docker stop trade-diary
docker rm trade-diary
docker build -t trade-diary:latest .
docker run -d \
  --name trade-diary \
  --restart unless-stopped \
  -p 8000:8000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  trade-diary:latest
```

## 10) Если что-то не работает

Логи приложения:

```bash
docker logs -n 200 trade-diary
```

Статус nginx:

```bash
systemctl status nginx
```
