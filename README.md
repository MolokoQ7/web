# Шкільне радіо 37

## Анонімка
Форма на сайті створює **нову** заявку через `POST /api/submissions`. Сервер генерує унікальний ID, зберігає заявку в Netlify Blobs, а адмін може її переглянути, відредагувати, опублікувати або видалити.

## Структура
- `index.html` — сайт і форма анонімки
- `netlify/functions/api.mjs` — серверний API
- `package.json` — залежність Netlify Blobs
- `netlify.toml` — підключення serverless function

## Netlify
1. Завантаж усю цю папку/репозиторій у Netlify.
2. У Environment variables додай `ADMIN_PASSWORD`.
3. Зроби новий deploy.

Не клади `api.mjs` просто в корінь: він має бути саме в `netlify/functions/api.mjs`.
