// Сервер для «Шкільного радіо 37».
// Читати новини та голосувати може кожен, а публікувати, видаляти й керувати голосуванням — тільки адмін.
// Пароль адміна зберігається в змінній середовища ADMIN_PASSWORD (Netlify → Site configuration → Environment variables).

import { getStore } from "@netlify/blobs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const CATEGORIES = ["Школа", "Оголошення", "Події", "8 клас"];

// Скільки голосів дозволено з однієї мережі за одне голосування.
// У школі багато учнів сидять на одному Wi-Fi (для сайту це одна адреса), тому ліміт великий:
// він зупиняє скрипти-накрутку, але не заважає чесним учням.
const MAX_VOTES_PER_NETWORK = 40;

const DEFAULT_POLL = {
  question: "Які шкільні активності вам подобаються найбільше?",
  options: ["Спортивні заходи", "Творчі конкурси", "Квести та ігри", "Тематичні дні"],
};

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

const EVENT_SEED = [
  { id: "eseed-1", title: "Спортивний день", when: "П'ятниця", body: "Спортивна форма та готовність активно рухатися." },
  { id: "eseed-2", title: "Шкільні події", when: "Незабаром", body: "Нові події з'являтимуться тут." },
  { id: "eseed-3", title: "Учнівські ініціативи", when: "Протягом року", body: "Пропонуйте ідеї через шкільне радіо." },
];

// ---------- Фото ----------
const IMG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_IMG_BYTES = 3 * 1024 * 1024; // сайт стискає фото до ~0,3-1 МБ, це запас

// Тип визначаємо за першими байтами файлу, а не за тим, що написав відправник.
// Так у сховище не потрапить нічого, крім справжніх фото (наприклад, не проскочить HTML чи SVG зі скриптом).
function detectImageType(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const tag = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (b.length >= 12 && tag(0, 4) === "RIFF" && tag(8, 4) === "WEBP") return "image/webp";
  return null;
}
const cleanImgId = (v) => (typeof v === "string" && IMG_ID.test(v) ? v : null);

// ---------- Відео (посилання) ----------
// Відео зберігаємо не файлом, а посиланням (YouTube, Vimeo або пряме .mp4/.webm/.ogg) —
// це працює без важкого завантаження файлів і не перевантажує сховище.
function cleanVideoUrl(v) {
  const s = String(v || "").trim().slice(0, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return s;
  } catch {
    return null;
  }
}

// ---------- Анонімка: приклади постів від учнів ----------
// Приклад надіслати може будь-хто, без пароля. Побачити список, редагувати,
// опублікувати чи видалити приклад може тільки адмін.
const SUB_MAX_PER_HOUR = 8; // проти спам-скриптів; чесним учням цього вистачає з запасом

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
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

function getCookie(req, name) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ---------- Голосування: допоміжні функції ----------
async function loadPoll(store) {
  const saved = await store.get("poll", { type: "json" });
  if (saved) return saved;
  // Голосування ще не змінювали: беремо стандартне (і голоси зі старої версії сайту, якщо були)
  const legacy = (await store.get("votes", { type: "json" })) || {};
  return { id: "default", question: DEFAULT_POLL.question, options: [...DEFAULT_POLL.options], votes: legacy };
}

const publicPoll = (p) => ({ id: p.id, question: p.question, options: p.options, votes: p.votes });

// Нове голосування або скидання: новий id означає, що всі можуть проголосувати знову
async function saveNewPoll(store, { question, options }) {
  const poll = { id: String(Date.now()), question, options, votes: {} };
  await store.setJSON("poll", poll);
  const { blobs } = await store.list({ prefix: "ipvotes:" });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
  return poll;
}

export default async (req, context) => {
  // "strong" = після запису дані одразу видно всім (за замовчуванням Netlify Blobs може оновлюватись із затримкою до хвилини)
  const store = getStore({ name: "radio37", consistency: "strong" });
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const method = req.method;

  // ---------- Вхід адміна ----------
  if (path === "/api/login" && method === "POST") {
    return passwordOk(req) ? json({ ok: true }) : json({ error: "Невірний пароль" }, 401);
  }

  // ---------- Новини ----------
  if (path === "/api/news" && method === "GET") {
    const { blobs } = await store.list({ prefix: "news:" });
    const items = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    items.sort((x, y) => (x.id < y.id ? 1 : -1)); // нові зверху
    // Стартові новини показуємо внизу, доки адмін їх не видалить
    const hidden = (await store.get("hidden-seeds", { type: "json" })) || [];
    const seeds = SEED.filter((n) => !hidden.includes(n.id));
    return json([...items, ...seeds]);
  }

  if (path === "/api/news" && method === "POST") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const body = await readBody(req);
    const title = String(body?.title || "").trim().slice(0, 150);
    const text = String(body?.body || "").trim().slice(0, 5000);
    const cat = CATEGORIES.includes(body?.cat) ? body.cat : CATEGORIES[0];
    if (!title || !text) return json({ error: "Заповни заголовок і текст" }, 400);
    const img = cleanImgId(body?.img);
    const video = cleanVideoUrl(body?.video);

    const id = String(Date.now()).padStart(15, "0");
    const item = {
      id,
      title,
      cat,
      body: text,
      date: new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" }),
      ...(img && { img }),
      ...(video && { video }),
    };
    await store.setJSON(`news:${id}`, item);
    return json(item, 201);
  }

  if (path.startsWith("/api/news/") && method === "DELETE") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const id = decodeURIComponent(path.slice("/api/news/".length));
    // Стартові новини не лежать у сховищі, тому їх просто позначаємо як приховані
    if (SEED.some((n) => n.id === id)) {
      const hidden = (await store.get("hidden-seeds", { type: "json" })) || [];
      if (!hidden.includes(id)) hidden.push(id);
      await store.setJSON("hidden-seeds", hidden);
      return json({ ok: true });
    }
    if (!/^\d{15}$/.test(id)) return json({ error: "Новину не знайдено" }, 400);
    const old = await store.get(`news:${id}`, { type: "json" });
    if (cleanImgId(old?.img)) await store.delete(`img:${old.img}`);
    await store.delete(`news:${id}`);
    return json({ ok: true });
  }

  // ---------- Фото ----------
  // Завантаження: тільки адмін. Тіло запиту = сам файл.
  if (path === "/api/upload" && method === "POST") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "Файл порожній" }, 400);
    if (buf.byteLength > MAX_IMG_BYTES) return json({ error: "Фото завелике (максимум 3 МБ)" }, 413);
    if (!detectImageType(buf)) return json({ error: "Це не схоже на фото (потрібен JPEG, PNG або WebP)" }, 400);
    const id = randomUUID();
    await store.set(`img:${id}`, buf);
    return json({ id }, 201);
  }

  // Показ фото: публічно. id випадковий і ніколи не повторюється, тому фото можна кешувати надовго.
  if (path.startsWith("/api/img/") && method === "GET") {
    const id = path.slice("/api/img/".length);
    if (!IMG_ID.test(id)) return json({ error: "Не знайдено" }, 404);
    const buf = await store.get(`img:${id}`, { type: "arrayBuffer" });
    const type = buf && detectImageType(buf);
    if (!type) return json({ error: "Не знайдено" }, 404);
    return new Response(buf, {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // ---------- Події ----------
  if (path === "/api/events" && method === "GET") {
    const { blobs } = await store.list({ prefix: "event:" });
    const items = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    items.sort((x, y) => (x.id < y.id ? 1 : -1)); // нові зверху
    // Стартові події показуємо внизу, доки адмін їх не видалить
    const hidden = (await store.get("hidden-event-seeds", { type: "json" })) || [];
    const seeds = EVENT_SEED.filter((e) => !hidden.includes(e.id));
    return json([...items, ...seeds]);
  }

  if (path === "/api/events" && method === "POST") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const body = await readBody(req);
    const title = String(body?.title || "").trim().slice(0, 100);
    const when = String(body?.when || "").trim().slice(0, 40);
    const text = String(body?.body || "").trim().slice(0, 500);
    if (!title) return json({ error: "Впиши назву події" }, 400);
    const img = cleanImgId(body?.img);
    const video = cleanVideoUrl(body?.video);

    const id = String(Date.now()).padStart(15, "0");
    const item = { id, title, when, body: text, ...(img && { img }), ...(video && { video }) };
    await store.setJSON(`event:${id}`, item);
    return json(item, 201);
  }

  if (path.startsWith("/api/events/") && method === "DELETE") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const id = decodeURIComponent(path.slice("/api/events/".length));
    if (EVENT_SEED.some((e) => e.id === id)) {
      const hidden = (await store.get("hidden-event-seeds", { type: "json" })) || [];
      if (!hidden.includes(id)) hidden.push(id);
      await store.setJSON("hidden-event-seeds", hidden);
      return json({ ok: true });
    }
    if (!/^\d{15}$/.test(id)) return json({ error: "Подію не знайдено" }, 400);
    const old = await store.get(`event:${id}`, { type: "json" });
    if (cleanImgId(old?.img)) await store.delete(`img:${old.img}`);
    await store.delete(`event:${id}`);
    return json({ ok: true });
  }

  // ---------- Голосування ----------
  // Публічне: поточне голосування + чи голосував уже цей браузер (за cookie, яку ставить сервер)
  if (path === "/api/poll" && method === "GET") {
    const poll = await loadPoll(store);
    return json({ poll: publicPoll(poll), voted: getCookie(req, "r37v") === poll.id });
  }

  // Публічне: віддати голос
  if (path === "/api/poll" && method === "POST") {
    const body = await readBody(req);
    const poll = await loadPoll(store);

    if (body?.pollId !== poll.id) {
      return json({ error: "Голосування щойно оновили. Онови сторінку й спробуй ще раз." }, 409);
    }
    const i = Number(body?.i);
    if (!Number.isInteger(i) || i < 0 || i >= poll.options.length) return json({ error: "Невірний варіант" }, 400);

    // 1) Cookie від сервера. Її не можна прибрати, просто очистивши дані сайту в localStorage
    if (getCookie(req, "r37v") === poll.id) {
      return json({ error: "Ти вже голосував(-ла) в цьому голосуванні." }, 409);
    }

    // 2) Обмеження за мережею (зберігається лише хеш адреси, а не сама адреса)
    const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
    const ipHash = createHash("sha256").update(`${poll.id}|${ip}`).digest("hex").slice(0, 16);
    const ipKey = `ipvotes:${poll.id}`;
    const ipVotes = (await store.get(ipKey, { type: "json" })) || {};
    if ((ipVotes[ipHash] || 0) >= MAX_VOTES_PER_NETWORK) {
      return json({ error: "З цієї мережі вже надто багато голосів." }, 429);
    }

    poll.votes[i] = (poll.votes[i] || 0) + 1;
    ipVotes[ipHash] = (ipVotes[ipHash] || 0) + 1;
    await store.setJSON("poll", poll);
    await store.setJSON(ipKey, ipVotes);

    const cookie = `r37v=${poll.id}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
    return json({ poll: publicPoll(poll), voted: true }, 200, { "set-cookie": cookie });
  }

  // Адмін: нове питання й варіанти (результати обнуляються)
  if (path === "/api/poll" && method === "PUT") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const body = await readBody(req);
    const question = String(body?.question || "").trim().slice(0, 200);
    const options = Array.isArray(body?.options)
      ? body.options.map((o) => String(o).trim().slice(0, 80)).filter(Boolean)
      : [];
    if (!question) return json({ error: "Впиши питання" }, 400);
    if (options.length < 2 || options.length > 6) return json({ error: "Потрібно від 2 до 6 варіантів" }, 400);
    const poll = await saveNewPoll(store, { question, options });
    return json({ poll: publicPoll(poll), voted: false });
  }

  // Адмін: скинути результати (питання й варіанти лишаються, усі можуть проголосувати знову)
  if (path === "/api/poll/reset" && method === "POST") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const current = await loadPoll(store);
    const poll = await saveNewPoll(store, { question: current.question, options: current.options });
    return json({ poll: publicPoll(poll), voted: false });
  }

  // ---------- Анонімка ----------
  // Публічне: будь-хто надсилає приклад поста (без пароля, без імені)
  if (path === "/api/submissions" && method === "POST") {
    const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
    const ipHash = createHash("sha256").update(`sub|${ip}`).digest("hex").slice(0, 16);
    const rateKey = `subrate:${ipHash}`;
    const now = Date.now();
    const hits = ((await store.get(rateKey, { type: "json" })) || []).filter((t) => now - t < 3600_000);
    if (hits.length >= SUB_MAX_PER_HOUR) {
      return json({ error: "Забагато прикладів з цієї мережі. Спробуй пізніше." }, 429);
    }

    const body = await readBody(req);
    const title = String(body?.title || "").trim().slice(0, 150);
    const text = String(body?.body || "").trim().slice(0, 5000);
    const cat = CATEGORIES.includes(body?.cat) ? body.cat : CATEGORIES[0];
    const video = cleanVideoUrl(body?.video);
    if (!title || !text) return json({ error: "Заповни заголовок і текст" }, 400);

    const id = String(now).padStart(15, "0") + "-" + randomUUID().slice(0, 8);
    const item = { id, title, cat, body: text, ...(video && { video }), createdAt: now };
    await store.setJSON(`sub:${id}`, item);
    hits.push(now);
    await store.setJSON(rateKey, hits);
    return json({ ok: true }, 201);
  }

  // Адмін: список надісланих прикладів
  if (path === "/api/submissions" && method === "GET") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const { blobs } = await store.list({ prefix: "sub:" });
    const items = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    items.sort((x, y) => (x.id < y.id ? 1 : -1)); // нові зверху
    return json(items);
  }

  // Адмін: редагувати приклад перед публікацією
  if (path.startsWith("/api/submissions/") && !path.endsWith("/publish") && method === "PUT") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const id = decodeURIComponent(path.slice("/api/submissions/".length));
    const existing = await store.get(`sub:${id}`, { type: "json" });
    if (!existing) return json({ error: "Приклад не знайдено" }, 404);
    const body = await readBody(req);
    const title = String(body?.title ?? existing.title).trim().slice(0, 150);
    const text = String(body?.body ?? existing.body).trim().slice(0, 5000);
    const cat = CATEGORIES.includes(body?.cat) ? body.cat : existing.cat;
    const video = body?.video !== undefined ? cleanVideoUrl(body.video) : existing.video || null;
    if (!title || !text) return json({ error: "Заповни заголовок і текст" }, 400);
    const updated = { ...existing, title, body: text, cat, ...(video ? { video } : {}) };
    if (!video) delete updated.video;
    await store.setJSON(`sub:${id}`, updated);
    return json(updated);
  }

  // Адмін: видалити приклад
  if (path.startsWith("/api/submissions/") && !path.endsWith("/publish") && method === "DELETE") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const id = decodeURIComponent(path.slice("/api/submissions/".length));
    await store.delete(`sub:${id}`);
    return json({ ok: true });
  }

  // Адмін: опублікувати приклад як звичайну новину
  if (path.endsWith("/publish") && path.startsWith("/api/submissions/") && method === "POST") {
    if (!passwordOk(req)) return json({ error: "Немає доступу" }, 401);
    const id = decodeURIComponent(path.slice("/api/submissions/".length, -"/publish".length));
    const sub = await store.get(`sub:${id}`, { type: "json" });
    if (!sub) return json({ error: "Приклад не знайдено" }, 404);
    const newsId = String(Date.now()).padStart(15, "0");
    const item = {
      id: newsId,
      title: sub.title,
      cat: sub.cat,
      body: sub.body,
      date: new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" }),
      ...(sub.video && { video: sub.video }),
    };
    await store.setJSON(`news:${newsId}`, item);
    await store.delete(`sub:${id}`);
    return json(item, 201);
  }

  return json({ error: "Не знайдено" }, 404);
};
