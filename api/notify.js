// api/notify.js
// Ye file cron-job.org se baar-baar call hogi (recommend: har 1 minute mein).
// Ye Firestore se reminder list padhta hai, jo lists "Alert" mein hain unhi ko
// dekhta hai, aur un mein se jinka koi "notify time" abhi (IST) match karta hai
// unhe Telegram pe alag-alag message bhejta hai.

const FIREBASE_PROJECT_ID = "life-tracker-3a3a8";
const FIRESTORE_DOC_PATH = "reminderApp/mainData";

// Cron kitni der mein chalta hai (minutes). 0 = exact-minute match — website ka
// time-picker sirf HH:MM (minute-level) precision deta hai, isse zyada tight
// karne ka koi fayda nahi, isliye ye sabse chhota practical tolerance hai.
const CRON_INTERVAL_MINUTES = 0;

function parseDMY(str) {
  const parts = (str || "").split("/");
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

function calendarMonthsDaysBetween(startDate, endDate) {
  if (!startDate || !endDate) return { months: 0, days: 0 };
  const y1 = startDate.getFullYear(), m1 = startDate.getMonth(), d1 = startDate.getDate();
  const y2 = endDate.getFullYear(), m2 = endDate.getMonth(), d2 = endDate.getDate();
  let months = (y2 - y1) * 12 + (m2 - m1);
  let days = d2 - d1;
  if (days < 0) {
    months -= 1;
    const prevMonthLastDay = new Date(y2, m2, 0).getDate();
    days += prevMonthLastDay;
  }
  if (months < 0) {
    months = 0;
    days = Math.max(0, days);
  }
  return { months, days };
}

function computeDayValue(r, today) {
  const target = parseDMY(r.targetDate);
  if (!target) return null;
  if (r.counter === "count") {
    return daysBetween(target, today);
  }
  return daysBetween(today, target);
}

// Same logic as website's isAlertTriggered() — list "Alert" mein hai ya nahi.
function isAlertTriggered(r, dayVal) {
  if (dayVal === null || isNaN(dayVal)) return false;
  const alertPageNum = parseInt(r.alertPage, 10);
  if (isNaN(alertPageNum)) return false;
  if (r.counter === "count") {
    return dayVal >= alertPageNum;
  }
  if (dayVal < -5) return false;
  return dayVal <= alertPageNum;
}

function formatDayLeftText(r, dayVal) {
  if (dayVal === null || isNaN(dayVal)) {
    return r.counter === "count" ? "-- . Months - -- . Days" : "-- . Day Left";
  }
  if (r.counter === "count") {
    const elapsed = Math.max(0, dayVal);
    if (elapsed <= 30) return `${elapsed} . Days`;
    const targetForCount = parseDMY(r.targetDate);
    const { months, days } = targetForCount
      ? calendarMonthsDaysBetween(targetForCount, new Date())
      : { months: Math.floor((elapsed - 1) / 30), days: ((elapsed - 1) % 30) + 1 };
    return `${months} . Months - ${days} . Days`;
  }
  return dayVal <= 0 ? "Expire" : `${dayVal} . Day Left`;
}

// Current time in IST as "HH:MM" (Vercel server clock is UTC, so convert).
function currentISTTimeString() {
  const now = new Date();
  return now.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }); // "HH:MM"
}

function minutesSinceMidnight(hhmm) {
  const [h, m] = (hhmm || "").split(":").map((n) => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Kya koi notifyTime abhi (tolerance window ke andar) match karta hai.
function hasMatchingTimeNow(notifyTimes, nowHHMM) {
  const nowMin = minutesSinceMidnight(nowHHMM);
  if (nowMin === null || !Array.isArray(notifyTimes)) return false;
  return notifyTimes.some((t) => {
    const tMin = minutesSinceMidnight(t);
    if (tMin === null) return false;
    return Math.abs(tMin - nowMin) <= CRON_INTERVAL_MINUTES;
  });
}

async function fetchReminderLists() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIRESTORE_DOC_PATH}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore fetch failed: ${res.status}`);
  const data = await res.json();
  const raw = data?.fields?.reminderLists?.stringValue;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

// Card ki width (characters mein) — centering isi ke hisaab se hoti hai.
const CARD_WIDTH = 24;
// Braille blank character — dikhta khaali hai, lekin Telegram "asli" blank lines
// ki tarah usse hata (trim) nahi karta, isliye upar-neeche padding ke liye kaam aata hai.
const BLANK_PAD_LINE = "⠀";

// Text ko (approx) beech mein laane ke liye left side spaces jodta hai.
// Telegram ka font monospace nahi hai, isliye ye perfect-center nahi, roughly-center hoga.
function centerText(text, width) {
  const t = String(text || "");
  if (t.length >= width) return t;
  const leftPad = Math.floor((width - t.length) / 2);
  return " ".repeat(Math.max(0, leftPad)) + t;
}

function buildMessageForList(r, dayVal) {
  const text = formatDayLeftText(r, dayVal);
  const dateStr = new Date().toLocaleDateString("en-GB");
  const lines = [
    BLANK_PAD_LINE,
    centerText(`TODAY — ${dateStr}`, CARD_WIDTH),
    BLANK_PAD_LINE,
    centerText(r.listName || "Untitled", CARD_WIDTH),
    BLANK_PAD_LINE,
    centerText(text, CARD_WIDTH),
    BLANK_PAD_LINE,
    centerText(`(${r.targetDate || "--"})`, CARD_WIDTH),
    BLANK_PAD_LINE,
  ];
  return lines.join("\n");
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

export default async function handler(req, res) {
  try {
    const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
    const CHAT_ID = (process.env.CHAT_ID || "").trim();
    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, error: "BOT_TOKEN or CHAT_ID missing in environment variables" });
    }

    const lists = await fetchReminderLists();
    const today = new Date();
    const nowHHMM = currentISTTimeString();

    const results = [];
    for (const r of lists) {
      const dayVal = computeDayValue(r, today);
      if (!isAlertTriggered(r, dayVal)) continue; // list abhi Alert mein nahi hai

      const perDay = parseInt(r.notifyMessagesPerDay, 10) || 0;
      if (perDay <= 0) continue; // is list ke liye notification set hi nahi hai
      if (!hasMatchingTimeNow(r.notifyTimes, nowHHMM)) continue; // abhi iska time nahi hai

      const message = buildMessageForList(r, dayVal);
      const tgData = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, message);
      results.push({ list: r.listName, sent: !!tgData.ok, error: tgData.ok ? undefined : tgData });
    }

    return res.status(200).json({
      ok: true,
      checkedAtIST: nowHHMM,
      sentCount: results.filter((r) => r.sent).length,
      results,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
