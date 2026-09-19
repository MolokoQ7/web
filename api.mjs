// Сервер для «Шкільного радіо 37».
// Читати новини та голосувати може кожен, а публікувати й видаляти — тільки адмін.
// Пароль адміна зберігається в змінній середовища ADMIN_PASSWORD (Netlify → Site configuration → Environment variables).

import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const CATEGORIES = ["Школа", "Оголошення", "Події", "8 клас"];
const POLL_OPTIONS = 4; // має збігатися з кількістю варіантів у index.html

const SEED = [
  {
    id: "seed-2",
    title: "Новий шкільний сезон розпочато",
    cat: "Оголошення",
    body: "Слідкуйте за оновленнями радіо, щоб не пропустити важливу інформацію.",
    date: "16.09.2026",
  },
  {
    id: "seed-1",
    title: "Ласкаво просимо до «Шкільного радіо 37»!",
    cat: "Школа",
    body: "Тут ви знайдете важливі новини, оголошення, події та голосування.",
    date: "16.09.2026",
  },
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// Порівняння паролів без витоку інформації через час відповіді
function passwordOk(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false; // якщо пароль не задано, адмін-доступ вимкнено
  const given = req.headers.get("x-admin-password") || "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export default async (req) => {
  const store = getStore("radio37");
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const method = req.method;

  // ---------- Вхід адміна ----------
  if (path === "/api/login" && method === "POST") {
    return passwordOk(req) ? json({ ok: true }) : json({ error: "Невірний пароль" }, 401);
  }

  // ---------- Новини ----------
  if (path === "/api/news" && method === "GET") {
    const { blobs } = await store.list({ prefix: "news:" });
    if (blobs.length === 0) return json(SEED);
    const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    items.sort((x, y) => (x.id < y.id ? 1 : -1)); // нові зверху
    return json(items);
  }

  if (path === "/api/news" && method === "POST") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const body = await readBody(req);
    const title = String(body?.title || "").trim().slice(0, 150);
    const text = String(body?.body || "").trim().slice(0, 5000);
    const cat = CATEGORIES.includes(body?.cat) ? body.cat : CATEGORIES[0];
    if (!title || !text) return json({ error: "Заповни заголовок і текст" }, 400);

    const id = String(Date.now()).padStart(15, "0");
    const item = {
      id,
      title,
      cat,
      body: text,
      date: new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" }),
    };
    await store.setJSON(`news:${id}`, item);
    return json(item, 201);
  }

  if (path.startsWith("/api/news/") && method === "DELETE") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const id = decodeURIComponent(path.slice("/api/news/".length));
    if (!/^\d{15}$/.test(id)) return json({ error: "Цю новину видалити не можна" }, 400);
    await store.delete(`news:${id}`);
    return json({ ok: true });
  }

  // ---------- Голосування ----------
  if (path === "/api/poll" && method === "GET") {
    const votes = (await store.get("votes", { type: "json" })) || {};
    return json(votes);
  }

  if (path === "/api/poll" && method === "POST") {
    const body = await readBody(req);
    const i = Number(body?.i);
    if (!Number.isInteger(i) || i < 0 || i >= POLL_OPTIONS) return json({ error: "Невірний варіант" }, 400);
    const votes = (await store.get("votes", { type: "json" })) || {};
    votes[i] = (votes[i] || 0) + 1;
    await store.setJSON("votes", votes);
    return json(votes);
  }

  return json({ error: "Не знайдено" }, 404);
};
