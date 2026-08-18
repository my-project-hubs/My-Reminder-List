// api/notify.js
// Ye file cron-job.org se baar-baar call hogi (recommend: har 1 minute mein).

const FIREBASE_PROJECT_ID = "life-tracker-3a3a8";
const FIRESTORE_DOC_PATH = "reminderApp/mainData";

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

// 15 din se kam wale par LEFT side Siren Emoji lagane ka function
function formatDayLeftText(r, dayVal) {
  let text = "";
  if (dayVal === null || isNaN(dayVal)) {
    text = r.counter === "count" ? "-- . Months - -- . Days" : "-- . Day Left";
  } else if (r.counter === "count") {
    const elapsed = Math.max(0, dayVal);
    if (elapsed <= 30) text = `${elapsed} . Days`;
    else {
      const targetForCount = parseDMY(r.targetDate);
      const { months, days } = targetForCount
        ? calendarMonthsDaysBetween(targetForCount, new Date())
        : { months: Math.floor((elapsed - 1) / 30), days: ((elapsed - 1) % 30) + 1 };
      text = `${months} . Months - ${days} . Days`;
    }
  } else {
    text = dayVal <= 0 ? "Expire" : `${dayVal} . Day Left`;
  }

  // AGAR 15 DIN SE KAM HAIN (YA EXPIRE HAI), TO SIRF LEFT SIDE SIREN ADD KARO
  // Agar aapke paas Telegram Premium Animated Emoji ID hai, to niche wali line me ID daal sakte hain
  const CUSTOM_EMOJI_ID = ""; // Example: "5368324170671202286"
  const sirenEmoji = CUSTOM_EMOJI_ID 
    ? `<tg-emoji emoji-id="${CUSTOM_EMOJI_ID}">🚨</tg-emoji>` 
    : "🚨";

  if (dayVal !== null && !isNaN(dayVal) && r.counter !== "count" && dayVal < 15) {
    return `${sirenEmoji} ${text}`;
  }

  return text;
}

function currentISTTimeString() {
  const now = new Date();
  return now.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function minutesSinceMidnight(hhmm) {
  const [h, m] = (hhmm || "").split(":").map((n) => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

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

const ONE_HOUR_MS = 60 * 60 * 1000;

async function processDelayedHistoryNotify(docData, BOT_TOKEN, CHAT_ID) {
  const historyLists = readJsonField(docData, "historyLists", []);
  const hasNotifiedField = !!(docData?.fields?.historyNotifiedIds);
  const notifiedIds = readJsonField(docData, "historyNotifiedIds", []);

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

  const stillExistingIds = new Set(historyLists.map((h) => h.id));
  const updatedNotified = [...notifiedIds.filter((id) => stillExistingIds.has(id)), ...due.map((h) => h.id)];
  await writeFirestoreField("historyNotifiedIds", updatedNotified);

  return { baselined: false, sent: due.length };
}

const CARD_WIDTH = 24;
const BLANK_PAD_LINE = "⠀";

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
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML"
    }),
  });
  return tgRes.json();
}

const DIVIDER_LINE = "_".repeat(CARD_WIDTH + 6);
const FULL_WIDTH = DIVIDER_LINE.length;

function cleanTargetDate(td) {
  return String(td || "--").replace(/[()]/g, "").trim();
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
  matched.forEach(({ r, text }, idx) => {
    if (idx !== 0) {
      lines.push(DIVIDER_LINE);
      lines.push(BLANK_PAD_LINE);
    }
    lines.push(centerText(r.listName || "Untitled", CARD_WIDTH));
    lines.push(BLANK_PAD_LINE);
    lines.push(centerText(text, FULL_WIDTH));
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

    function sortByDayVal(matched) {
      matched.sort((a, b) => {
        const av = (a.dayVal === null || isNaN(a.dayVal)) ? Infinity : a.dayVal;
        const bv = (b.dayVal === null || isNaN(b.dayVal)) ? Infinity : b.dayVal;
        return av - bv;
      });
      return matched;
    }

    function buildMatchesForMode(mode) {
      const matched = [];
      for (const r of lists) {
        const on = mode === "alert" ? r.notifyAlertOn : r.notifyReminderOn;
        if (!on) continue;

        const perDay = parseInt(mode === "alert" ? r.notifyAlertPerDay : r.notifyReminderPerDay, 10) || 0;
        if (perDay <= 0) continue;

        const times = mode === "alert" ? r.notifyAlertTimes : r.notifyReminderTimes;
        if (!hasMatchingTimeNow(times, nowHHMM)) continue;

        const dayVal = computeDayValue(r, today);
        if (mode === "alert" && !isAlertTriggered(r, dayVal)) continue;

        matched.push({ r, text: formatDayLeftText(r, dayVal), dayVal });
      }
      return sortByDayVal(matched);
    }

    // SIRF REMINDER PAGE KA MESSAGE BHEJNA HAI
    const reminderMatches = buildMatchesForMode("reminder");

    const results = [];
    if (reminderMatches.length > 0) {
      const message = buildCombinedMessage(reminderMatches, "Reminder Page");
      const tgData = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, message);
      results.push({
        pageMode: "Reminder Page",
        matchedCount: reminderMatches.length,
        sent: !!tgData.ok,
        lists: reminderMatches.map((m) => m.r.listName),
        error: tgData.ok ? undefined : tgData,
      });
    }

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
    
