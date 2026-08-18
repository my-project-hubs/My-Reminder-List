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

async function fetchFirestoreDoc() {
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

// Ek field ko Firestore mein likh do (sirf usi field ko — updateMask ki wajah
// se document ke baaki fields chhue tak nahi jaate).
async function writeFirestoreField(fieldName, value) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIRESTORE_DOC_PATH}?updateMask.fieldPaths=${fieldName}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [fieldName]: { stringValue: JSON.stringify(value) } } }),
  });
  if (!res.ok) throw new Error(`Firestore write failed: ${res.status}`);
  return res.json();
}

async function fetchReminderLists(docData) {
  return readJsonField(docData, "reminderLists", []);
}

function formatEntryTimeIST(ms) {
  const d = new Date(ms);
  const dateStr = d.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
  const timeStr = d.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${dateStr}  ${timeStr}`;
}

// Nayi History banne ke 1 ghante baad Telegram par batana hai.
// "historyNotifiedIds" field mein woh entries track hoti hain jinka message
// bhej diya gaya hai — taaki dobara wahi entry na bheji jaaye.
const ONE_HOUR_MS = 60 * 60 * 1000;

async function processDelayedHistoryNotify(docData, BOT_TOKEN, CHAT_ID) {
  const historyLists = readJsonField(docData, "historyLists", []);
  const hasNotifiedField = !!(docData?.fields?.historyNotifiedIds);
  const notifiedIds = readJsonField(docData, "historyNotifiedIds", []);

  // Pehli baar chal raha hai (field abhi tak Firestore mein bana hi nahi) —
  // is waqt maujood saari purani entries ko "already notified" maan lo,
  // taaki deploy hote hi ek saath sabka message na phat jaaye. Sirf ab ke
  // baad banne wali NAYI history hi 1-ghante-baad notify hogi.
  if (!hasNotifiedField) {
    const baselineIds = historyLists.map((h) => h.id);
    await writeFirestoreField("historyNotifiedIds", baselineIds);
    return { baselined: true, sent: 0 };
  }

  const now = Date.now();
  const notifiedSet = new Set(notifiedIds);
  const due = historyLists.filter(
    (h) => h && h.id && !notifiedSet.has(h.id) && (now - (h.created || 0)) >= ONE_HOUR_MS
  );

  if (due.length === 0) {
    return { baselined: false, sent: 0 };
  }

  const lines = [
    BLANK_PAD_LINE,
    centerText("New History", CARD_WIDTH),
    BLANK_PAD_LINE,
    centerText(`Total - ${due.length}`, CARD_WIDTH),
    BLANK_PAD_LINE,
    DIVIDER_LINE,
    BLANK_PAD_LINE,
  ];
  due.forEach((h, idx) => {
    if (idx !== 0) {
      lines.push(DIVIDER_LINE);
      lines.push(BLANK_PAD_LINE);
    }
    lines.push(centerText(h.listName || "Untitled", CARD_WIDTH));
    lines.push(BLANK_PAD_LINE);
    lines.push(centerText(cleanTargetDate(h.targetDate), FULL_WIDTH));
    if (h.price !== undefined && h.price !== null && h.price !== "") {
      lines.push(BLANK_PAD_LINE);
      lines.push(centerText(`₹ ${h.price}`, FULL_WIDTH));
    }
    lines.push(BLANK_PAD_LINE);
    lines.push(centerText(`Added - ${formatEntryTimeIST(h.created)}`, FULL_WIDTH));
    lines.push(BLANK_PAD_LINE);
  });
  lines.push(DIVIDER_LINE);
  lines.push(BLANK_PAD_LINE);

  await sendTelegramMessage(BOT_TOKEN, CHAT_ID, lines.join("\n"));

  // notified list ko update karo: jo abhi bheja + jo pehle se bheja hua tha
  // (aur history mein ab bhi maujood hai — delete ho chuki purani ids hata do
  // taaki list hamesha ke liye badhti na jaaye).
  const stillExistingIds = new Set(historyLists.map((h) => h.id));
  const updatedNotified = [...notifiedIds.filter((id) => stillExistingIds.has(id)), ...due.map((h) => h.id)];
  await writeFirestoreField("historyNotifiedIds", updatedNotified);

  return { baselined: false, sent: due.length };
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



async function sendTelegramMessage(botToken, chatId, text) {
  const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const tgRes = await fetch(tgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return tgRes.json();
}

const DIVIDER_LINE = "_".repeat(CARD_WIDTH + 6);
// Day-left aur target-date lines ko poore card ki width (divider jitni chauda)
// ke hisaab se center karna hai — list-name ka centering (CARD_WIDTH) waisa hi
// rehne diya hai, sirf yeh dono line poora center mein aayengi.
const FULL_WIDTH = DIVIDER_LINE.length;

// Target date sirf "DD/MM/YYYY" dikhna chahiye — agar kahin se bhi "()"
// (ya extra spaces) saath aa jaaye to yahan clean kar dete hain.
function cleanTargetDate(td) {
  return String(td || "--").replace(/[()]/g, "").trim();
}

// Reminder Page ke liye: sirf countdown-type list (counter !== "count"),
// jiska dayVal 1 se 15 ke beech ho (15 din ya usse kam baaki), unhi ke aage
// ek red dot lagana hai — 15 se zyada baaki ho to bilkul nahi aana chahiye.
function shouldShowRedDot(r, dayVal) {
  return (
    r.counter !== "count" &&
    dayVal !== null &&
    !isNaN(dayVal) &&
    dayVal > 0 &&
    dayVal <= 15
  );
}

function buildCombinedMessage(matched, pageMode) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
  const weekdayShort = now.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", weekday: "short" });
  const lines = [
    BLANK_PAD_LINE,
    centerText(`Today - ${dateStr} (${weekdayShort})`, CARD_WIDTH),
    BLANK_PAD_LINE,
    centerText(pageMode, CARD_WIDTH),
    BLANK_PAD_LINE,
    centerText(`Total List - ${matched.length}`, CARD_WIDTH),
    BLANK_PAD_LINE,
    DIVIDER_LINE,
    BLANK_PAD_LINE,
  ];
  matched.forEach(({ r, text, dayVal }, idx) => {
    if (idx !== 0) {
      lines.push(DIVIDER_LINE);
      lines.push(BLANK_PAD_LINE);
    }
    lines.push(centerText(r.listName || "Untitled", CARD_WIDTH));
    lines.push(BLANK_PAD_LINE);
    const showDot = pageMode === "Reminder Page" && shouldShowRedDot(r, dayVal);
    if (showDot) {
      // "Day Left" text apni purani (center wali) jagah par hi rahega —
      // sirf dot ko list-name ke left-margin (jahan uska pehla letter
      // shuru hota hai) wale column mein alag se daal rahe hain, text
      // ki position bilkul nahi badal rahe.
      const base = centerText(text, FULL_WIDTH); // purana centered string
      const nameLeftPad = Math.max(0, Math.floor((CARD_WIDTH - String(r.listName || "Untitled").length) / 2));
      const dot = "🔴";
      if (base.length > nameLeftPad + dot.length) {
        lines.push(base.slice(0, nameLeftPad) + dot + base.slice(nameLeftPad + dot.length));
      } else {
        lines.push(dot + " " + base.replace(/^\s+/, ""));
      }
    } else {
      lines.push(centerText(text, FULL_WIDTH));
    }
    lines.push(BLANK_PAD_LINE);
    lines.push(centerText(cleanTargetDate(r.targetDate), FULL_WIDTH));
    lines.push(BLANK_PAD_LINE);
  });
  lines.push(DIVIDER_LINE);
  lines.push(BLANK_PAD_LINE);
  return lines.join("\n");
}


export default async function handler(req, res) {
  try {
    const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
    const CHAT_ID = (process.env.CHAT_ID || "").trim();
    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, error: "BOT_TOKEN or CHAT_ID missing in environment variables" });
    }

    const docData = await fetchFirestoreDoc();
    const lists = await fetchReminderLists(docData);
    const today = new Date();
    const nowHHMM = currentISTTimeString();

    // Kam se kam din baaki wali list sabse upar, aur jyada din baaki wali
    // sabse niche — dayVal ke hisaab se chhote se bade order mein sort.
    // Jinka date hi valid nahi (dayVal null/NaN), unhe sabse neeche daal dete hain.
    function sortByDayVal(matched) {
      matched.sort((a, b) => {
        const av = (a.dayVal === null || isNaN(a.dayVal)) ? Infinity : a.dayVal;
        const bv = (b.dayVal === null || isNaN(b.dayVal)) ? Infinity : b.dayVal;
        return av - bv;
      });
      return matched;
    }

    // Alert Page aur Reminder Page ab apna-apna independent ON/OFF, MSG/DAY
    // aur Times rakhte hain (Notification Settings mein set kiya hua) —
    // dono ek dusre se bilkul alag check hote hain, isliye dono ka apna
    // schedule chal sakta hai bina ek dusre ko overwrite/block kiye.
    function buildMatchesForMode(mode) {
      const matched = [];
      for (const r of lists) {
        const on = mode === "alert" ? r.notifyAlertOn : r.notifyReminderOn;
        if (!on) continue; // is list ke group mein yeh mode hi ON nahi hai

        const perDay = parseInt(mode === "alert" ? r.notifyAlertPerDay : r.notifyReminderPerDay, 10) || 0;
        if (perDay <= 0) continue; // is mode ke liye notification set hi nahi hai

        const times = mode === "alert" ? r.notifyAlertTimes : r.notifyReminderTimes;
        if (!hasMatchingTimeNow(times, nowHHMM)) continue; // abhi iska time nahi hai

        const dayVal = computeDayValue(r, today);
        // Alert Page: sirf jinka "day left" alert-condition trigger ho rahi hai.
        // Reminder Page: saari lists (alert-condition ignore karke).
        if (mode === "alert" && !isAlertTriggered(r, dayVal)) continue;

        matched.push({ r, text: formatDayLeftText(r, dayVal), dayVal });
      }
      return sortByDayVal(matched);
    }

    const alertMatches = buildMatchesForMode("alert");
    const reminderMatches = buildMatchesForMode("reminder");

    const results = [];
    for (const [pageMode, matched] of [
      ["Alert Page", alertMatches],
      ["Reminder Page", reminderMatches],
    ]) {
      if (matched.length === 0) continue;
      const message = buildCombinedMessage(matched, pageMode);
      const tgData = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, message);
      results.push({
        pageMode,
        matchedCount: matched.length,
        sent: !!tgData.ok,
        lists: matched.map((m) => m.r.listName),
        error: tgData.ok ? undefined : tgData,
      });
    }

    // Feature 2: nayi History bane ke 1 ghante baad alag se batana (Alert/Reminder
    // ke schedule se bilkul independent — yeh sirf "elapsed time" dekhta hai).
    const historyNotifyResult = await processDelayedHistoryNotify(docData, BOT_TOKEN, CHAT_ID);

    return res.status(200).json({
      ok: true,
      checkedAtIST: nowHHMM,
      results,
      historyDelayedNotify: historyNotifyResult,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
