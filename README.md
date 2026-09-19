# Шкільне радіо 37: адмін-доступ

## Структура
- index.html: сайт
- netlify/functions/api.mjs: сервер (новини, голосування, вхід адміна)
- package.json: залежність @netlify/blobs (спільне сховище)

## Налаштування
1. Задеплой папку на Netlify через GitHub або Netlify CLI (`netlify deploy --prod`).
2. Netlify → Site configuration → Environment variables → додай
   ADMIN_PASSWORD = довгий пароль, який знаєш тільки ти.
3. Зроби Deploy ще раз, щоб змінна почала працювати.
4. Відкрий сайт → «Адмін» → введи пароль.
