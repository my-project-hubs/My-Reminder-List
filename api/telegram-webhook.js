// api/telegram-webhook.js
// Ye file Telegram ke "Webhook" se call hoti hai — jab bhi aap bot ko koi
// message bhejte ho, Telegram turant is URL ko hit karta hai (cron ki zaroorat
// nahi hai, ye instant hai).
//
// SUPPORTED MESSAGE (on-demand latest history):
//   /h                 -> latest 1 history
//   /h 5               -> latest 5 history
//   /h 10              -> latest 10 history (maximum)
//   h 3                -> (slash ke bina bhi chalega)
//
// ONE-TIME SETUP (isko ek baar apne browser mein khol dena, bas):
//   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<aapka-vercel-domain>/api/telegram-webhook
//   <BOT_TOKEN> ki jagah apna asli bot token daalo, aur <aapka-vercel-domain>
//   ki jagah apni website ka vercel URL (jaise https://mysite.vercel.app)

const FIREBASE_PROJECT_ID = "life-tracker-3a3a8";
const FIRESTORE_DOC_PATH = "reminderApp/mainData";

const CARD_WIDTH = 24;
const BLANK_PAD_LINE = "⠀";
const DIVIDER_LINE = "_".repeat(CARD_WIDTH + 6);
const FULL_WIDTH = DIVIDER_LINE.length;

function centerText(text, width) {
  const t = String(text || "");
  if (t.length >= width) return t;
  const leftPad = Math.floor((width - t.length) / 2);
  return " ".repeat(Math.max(0, leftPad)) + t;
}

function rightText(text, width) {
  const t = String(text || "");
  if (t.length >= width) return t;
  const leftPad = width - t.length;
  return " ".repeat(Math.max(0, leftPad)) + t;
}

function cleanTargetDate(td) {
  return String(td || "--").replace(/[()]/g, "").trim();
}

async function fetchDocData() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIRESTORE_DOC_PATH}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore fetch failed: ${res.status}`);
  return res.json();
}

function readJsonField(docData, fieldName, fallback) {
  const raw = docData?.fields?.[fieldName]?.stringValue;
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function sendTelegramMessage(botToken, chatId, text) {
  const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const tgRes = await fetch(tgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return tgRes.json();
}

// Sirf "/h <number>" (1 se 10) chalega — number COMPULSORY hai.
// Bina slash ka "h", "h 5" ya bina number ka akela "/h" ab reply nahi karega.
function parseHistoryCommand(text) {
  const m = String(text || "").trim().match(/^\/h\s+(\d{1,2})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (isNaN(n) || n < 1 || n > 10) return null;
  return n;
}

// ===== Neeche wale helpers website ke History card (index.html) ki EXACT
// same calculation/format ko IST timezone mein replicate karte hain, taaki
// Telegram ka message hu-bahu website ke card jaisa hi dikhe. =====

function parseDMY(str) {
  const parts = String(str || "").split("/");
  if (parts.length !== 3) return null;
  const d = parseInt(parts[0], 10), m = parseInt(parts[1], 10), y = parseInt(parts[2], 10);
  if (!d || !m || !y) return null;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

function daysBetween(a, b) {
  const msPerDay = 86400000;
  const aMid = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bMid = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bMid - aMid) / msPerDay);
}

// ms (absolute timestamp) -> calendar Y/M/D jaisa IST mein dikhega
// (server kisi bhi timezone mein chal raha ho, phir bhi sahi IST din milega).
function istDateParts(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function istCalendarDate(ms) {
  const p = istDateParts(ms);
  return new Date(p.y, p.m - 1, p.d);
}

function formatDMY(dt) {
  if (!dt || isNaN(dt.getTime())) return "--";
  const d = String(dt.getDate()).padStart(2, "0");
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const y = dt.getFullYear();
  return `${d}/${m}/${y}`;
}

// Website ke openHistoryDetail() jaisa status (ACTIVE/UPCOMING/EXPIRED) —
// har reminderId ke group ke andar hi decide hota hai, isliye poori
// historyLists (sirf display hone wali top-N nahi) yahan use hoti hai.
function computeStatusMap(historyLists) {
  const groups = {};
  historyLists.forEach(h => {
    const key = h.reminderId || h.id;
    if (!groups[key]) groups[key] = [];
    groups[key].push(h);
  });

  const today = istCalendarDate(Date.now());
  const statusById = {};

  Object.values(groups).forEach(group => {
    const sorted = [...group].sort((a, b) => (b.created || 0) - (a.created || 0));

    const notExpired = sorted
      .filter(r => r.counter !== "count")
      .map(r => ({ r, end: parseDMY(r.targetDate) }))
      .filter(x => x.end && daysBetween(today, x.end) >= 0)
      .sort((a, b) => a.end - b.end);
    const activeId = notExpired.length ? notExpired[0].r.id : null;
    const upcomingMap = {};
    notExpired.forEach(x => { upcomingMap[x.r.id] = (x.r.id === activeId) ? "active" : "upcoming"; });

    sorted.forEach((r, i) => {
      const isCount = r.counter === "count";
      statusById[r.id] = isCount ? (i === 0 ? "active" : "expired") : (upcomingMap[r.id] || "expired");
    });
  });

  return statusById;
}

// Ek entry ka poora card-block, EXACT website History card jaisa:
// STATUS / start -> end date / "X days - ₹Y" / "Daily Cost ₹Z" / timestamp
// (Notes item ke liye price/daily-cost nahi hote, website jaisa hi).
function buildEntryCardLines(h, status) {
  const startDate = h.created ? istCalendarDate(h.created) : null;
  const endDate = parseDMY(h.targetDate);
  const isCount = h.counter === "count";
  let totalDays = null;
  if (startDate && endDate) {
    const span = daysBetween(startDate, endDate);
    totalDays = isCount ? span : (span + 1);
  }
  const price = (h.price !== undefined && h.price !== null) ? h.price : 0;
  const dailyCost = (totalDays && totalDays > 0) ? (price / totalDays) : price;
  const statusLabel = status === "upcoming" ? "UPCOMING" : (status === "active" ? "ACTIVE" : "EXPIRED");
  const dateRange = `${startDate ? formatDMY(startDate) : "--"} -> ${endDate ? formatDMY(endDate) : cleanTargetDate(h.targetDate)}`;

  const lines = [];
  lines.push(centerText(h.listName || "Untitled", CARD_WIDTH));
  if (h.itemType === "notes") lines.push(centerText("( Notice )", CARD_WIDTH));
  lines.push(BLANK_PAD_LINE);
  lines.push(centerText(statusLabel, FULL_WIDTH));
  lines.push(BLANK_PAD_LINE);
  lines.push(centerText(dateRange, FULL_WIDTH));
  lines.push(BLANK_PAD_LINE);
  if (h.itemType === "notes") {
    lines.push(centerText(`${(totalDays !== null && !isNaN(totalDays)) ? totalDays : "--"} days`, FULL_WIDTH));
  } else {
    lines.push(centerText(`${(totalDays !== null && !isNaN(totalDays)) ? totalDays : "--"} days - ₹${price}`, FULL_WIDTH));
    lines.push(BLANK_PAD_LINE);
    lines.push(centerText(`Daily Cost ₹${isFinite(dailyCost) ? dailyCost.toFixed(2) : "--"}`, FULL_WIDTH));
  }
  return lines;
}

function buildHistoryMessage(entries, requestedCount, allHistoryLists) {
  const statusById = computeStatusMap(allHistoryLists);

  const lines = [
    BLANK_PAD_LINE,
    centerText("Latest History", CARD_WIDTH),
    BLANK_PAD_LINE,
    centerText(`Showing - ${entries.length} / ${requestedCount}`, CARD_WIDTH),
    BLANK_PAD_LINE,
    DIVIDER_LINE,
    BLANK_PAD_LINE,
  ];
  if (entries.length === 0) {
    lines.push(centerText("Koi History Nahi Mili", FULL_WIDTH));
    lines.push(BLANK_PAD_LINE);
  }
  entries.forEach((h, idx) => {
    if (idx !== 0) {
      lines.push(DIVIDER_LINE);
      lines.push(BLANK_PAD_LINE);
    }
    const status = statusById[h.id] || "expired";
    lines.push(...buildEntryCardLines(h, status));
    lines.push(BLANK_PAD_LINE);
  });
  lines.push(DIVIDER_LINE);
  lines.push(BLANK_PAD_LINE);
  return lines.join("\n");
}

export default async function handler(req, res) {
  try {
    // Secret-key check: Telegram ka "secret_token" webhook feature header
    // "X-Telegram-Bot-Api-Secret-Token" mein bhejta hai (setWebhook call mein
    // secret_token=... pass karke set hota hai). Manual test ke liye ?key=...
    // query string se bhi diya ja sakta hai.
    const MY_SECRET_KEY = (process.env.MY_SECRET_KEY || "").trim();
    const providedKey = String(
      req.headers["x-telegram-bot-api-secret-token"] || req.query?.key || ""
    ).trim();
    if (!MY_SECRET_KEY || providedKey !== MY_SECRET_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Telegram sirf POST bhejta hai. Browser mein khol kar test karne ke liye
    // GET par ek chhota status dikha dete hain.
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, info: "Telegram webhook is live." });
    }

    const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
    const CHAT_ID = (process.env.CHAT_ID || "").trim();
    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, error: "BOT_TOKEN or CHAT_ID missing in environment variables" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const message = (body && (body.message || body.edited_message)) || null;

    // Koi message hi nahi (kisi aur tarah ka Telegram update) — chup-chaap 200 bhej do.
    if (!message || !message.chat || !message.text) {
      return res.status(200).json({ ok: true });
    }

    // Security: sirf apne khud ke chat se aaya command hi process karo.
    if (String(message.chat.id) !== CHAT_ID) {
      return res.status(200).json({ ok: true });
    }

    const requestedCount = parseHistoryCommand(message.text);
    if (requestedCount === null) {
      // History command nahi hai — kuch reply nahi karte, chup rehte hain.
      return res.status(200).json({ ok: true });
    }

    const docData = await fetchDocData();
    const historyLists = readJsonField(docData, "historyLists", []);

    const sorted = [...historyLists].sort((a, b) => (b.created || 0) - (a.created || 0));
    const top = sorted.slice(0, requestedCount);

    const msgText = buildHistoryMessage(top, requestedCount, historyLists);
    const tgData = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, msgText);

    return res.status(200).json({ ok: true, sent: !!tgData.ok, count: top.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
