// api/telegram-webhook.js
// Ye file Telegram ke "Webhook" se call hoti hai — jab bhi aap bot ko koi
// message bhejte ho, Telegram turant is URL ko hit karta hai (cron ki zaroorat
// nahi hai, ye instant hai).
//
// SUPPORTED MESSAGE (on-demand latest history):
//   /h                 -> latest 1 history
//   /h 5               -> latest 5 history
//   /h 10              -> latest 10 history (maximum)
//
// SUPPORTED MESSAGE (Reminder page: Add / Edit / Delete):
//    /add Name | DD/MM/YYYY | Price | AlertDays | countdown
//   /add Dish TV | 09/09/2026 | 400 | 15 | countdown
//     (last part "countdown"/"count" optional — na diya to "countdown" default)
//
//    /edit Name | DD/MM/YYYY | Price | AlertDays | countdown
//   /edit Dish TV | 10/09/2026 | 450 | 10 | countdown
//     (found by current Name — name itself is not changed)
//
//   /delete Name
//     -> bot poochega "Pakka delete karna hai?" — confirm karne ke liye
//        agla message sirf "yes" bhejo (2 minute ke andar), warna cancel.
//
// SUPPORTED MESSAGE (History page: Delete):
//   /hd
//     -> bot poori History-page list bhejta hai (real completed entries +
//        abhi-tak-0-baar-complete-hui active countdown/count reminders bhi,
//        bilkul waisa hi jaisa website ke History page par "List - N" count
//        mein dikhta hai), taaki aap dekh kar decide kar sako.
//   /hd Name
//   /hd Gas cylinder
//     -> bot poochega confirmation ("Are you sure...?") — confirm karne ke
//        liye agla message sirf "yes" bhejo (2 minute ke andar), warna cancel.
//     -> "yes" karne par website ke apne "Delete History Lists" feature jaisa
//        hi hota hai: us list ki saari history snapshots hat jaati hain AUR
//        wo History page se hamesha ke liye hide ho jaati hai (chahe wo
//        active reminder ho jiski abhi tak koi history na bani ho).
//
// SUPPORTED MESSAGE (Show all commands):
//   /cm
//     -> bot replies with the full list of every supported command.
//
// SUPPORTED MESSAGE (Reminder page: list all):
//   /rp
//     -> bot shows every current reminder list (name only), with date/time header.
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

// Replicates the website's exact History-page grouping (index.html
// renderDeleteHistoryListsList / getHistoryListCount): one group per
// reminderId — built from real historyLists snapshots, PLUS a "0 hist"
// placeholder group for every active countdown/count reminder that hasn't
// completed even once yet. Groups hidden via historyPageHiddenIds or
// hiddenListIds are excluded, same as the website.
function buildHistoryGroups(historyLists, reminderLists, historyPageHiddenIds, hiddenListIds) {
  const groups = {};
  (historyLists || []).forEach(h => {
    if (!h.reminderId) return;
    if (!groups[h.reminderId]) {
      groups[h.reminderId] = { id: h.reminderId, listName: h.listName, count: 0 };
    }
    groups[h.reminderId].count += 1;
    groups[h.reminderId].listName = h.listName;
  });
  (reminderLists || []).forEach(r => {
    if (r.counter !== "countdown" && r.counter !== "count") return;
    if (!groups[r.id]) {
      groups[r.id] = { id: r.id, listName: r.listName, count: 0 };
    } else {
      groups[r.id].listName = r.listName;
    }
  });
  const hiddenA = historyPageHiddenIds || [];
  const hiddenB = hiddenListIds || [];
  return Object.values(groups).filter(g => !hiddenA.includes(g.id) && !hiddenB.includes(g.id));
}

function findHistoryGroupsByName(groups, name) {
  const target = String(name || "").trim().toLowerCase();
  return (groups || []).filter(g => String(g.listName || "").trim().toLowerCase() === target);
}

function buildHistoryGroupListMessage(groups) {
  if (!groups.length) {
    return "History page is empty — no lists found.";
  }

  // Current IST date + time (message aane ke time ka)
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const get = (type) => dateParts.find(p => p.type === type)?.value || "";
  const dateLine = `Today - ${get("day")}/${get("month")}/${get("year")} (${get("weekday")})`;

  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const hour = timeParts.find(p => p.type === "hour")?.value || "";
  const minute = timeParts.find(p => p.type === "minute")?.value || "";
  const dayPeriod = timeParts.find(p => p.type === "dayPeriod")?.value || "";
  const timeLine = `${hour}:${minute} ${dayPeriod}`;

  // Divider sirf is message ke liye thoda lamba (double nahi)
  const longDivider = "_".repeat(CARD_WIDTH + 12);

  const lines = [
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    dateLine,
    "",
    timeLine,
    "",
    "History page",
    "",
    `Today List - ${groups.length}`,
    "",
    "",
    longDivider,
    "",
    "",
  ];
  groups.forEach(g => {
    lines.push(`${g.listName || "Untitled"} — ${g.count} hist`);
    lines.push("");
  });
  lines.push(BLANK_PAD_LINE);
  lines.push(BLANK_PAD_LINE);
  lines.push(BLANK_PAD_LINE);
  lines.push(longDivider);
  lines.push("");
  lines.push("If you want to delete any of these lines, then add the line you want to delete with this ( /hd name ) command, leaving a space, and send it.");
  return lines.join("\n");
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

// ===== Firestore WRITE helper (Add/Edit/Delete ke liye) =====
// fieldsMap = { fieldName: "jsonString" } -> field ko update karta hai.
// fieldsMap = { fieldName: undefined }    -> field ko document se DELETE karta hai
//                                            (Firestore updateMask semantics).
async function patchDocFields(fieldsMap) {
  const keys = Object.keys(fieldsMap);
  const maskParams = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIRESTORE_DOC_PATH}?${maskParams}`;
  const fields = {};
  keys.forEach(k => {
    if (fieldsMap[k] !== undefined) {
      fields[k] = { stringValue: fieldsMap[k] };
    }
  });
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Firestore write failed: ${res.status} ${errText}`);
  }
  return res.json();
}

function genId(prefix) {
  const raw = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  return prefix ? prefix + raw : raw;
}

// "Name | DD/MM/YYYY | Price | AlertDays | counter(optional)" -> parsed fields
function parseReminderFieldParts(parts) {
  if (!parts || parts.length < 4) {
    return { error: "Wrong format. Correct format:\n/add Name | DD/MM/YYYY | Price | AlertDays | countdown" };
  }
  const [listNameRaw, dateRaw, priceRaw, alertRaw, counterRaw] = parts;
  const listName = String(listNameRaw || "").trim();
  if (!listName) return { error: "List Name cannot be empty." };

  const targetDate = String(dateRaw || "").trim();
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(targetDate)) {
    return { error: "Wrong date format. Send it as DD/MM/YYYY (e.g. 09/09/2026)." };
  }

  const price = parseFloat(priceRaw);
  if (isNaN(price) || price <= 0) {
    return { error: "Price must be a valid number greater than 0." };
  }

  const alertDaysNum = parseInt(alertRaw, 10);
  if (isNaN(alertDaysNum) || alertDaysNum < 0) {
    return { error: "Alert Days must be a valid number (0 or more)." };
  }

  const counter = (counterRaw && String(counterRaw).trim().toLowerCase() === "count") ? "count" : "countdown";

  return { data: { listName, targetDate, price, alertPage: String(alertDaysNum), counter } };
}

function findReminderByName(reminderLists, name) {
  const target = String(name || "").trim().toLowerCase();
  return (reminderLists || []).find(r => String(r.listName || "").trim().toLowerCase() === target);
}

function buildHistorySnapshotEntry(entry) {
  return {
    id: genId("h_"),
    reminderId: entry.id,
    listName: entry.listName,
    targetDate: entry.targetDate,
    price: entry.price,
    alertPage: entry.alertPage,
    counter: entry.counter,
    itemType: null,
    created: Date.now(),
  };
}

function formatReminderConfirmMessage(heading, entry) {
  const topBlock = [
    heading,
    "",
    `Name: ${entry.listName}`,
    `Target Date: ${entry.targetDate}`,
    `Price: ₹${entry.price}`,
    `Alert Page: ${entry.alertPage}`,
    `Type: ${entry.counter === "count" ? "Count" : "Countdown"}`,
  ].join("\n");

  const spacer = "\n".repeat(6); // 5-6 blank lines in between
  const bottomSpacer = "\n" + "⠀\n".repeat(6); // same blank space at the bottom (blank-char lines so Telegram doesn't trim them)

  return topBlock + spacer + formatReminderCardMessage(entry) + bottomSpacer;
}

// Website ke Reminder-page card ("X . Day Left" / "X . Days") jaisa hi text banata hai.
function computeDayLeftText(entry) {
  const target = parseDMY(entry.targetDate);
  if (!target) return "-- . Day Left";
  const today = istCalendarDate(Date.now());
  if (entry.counter === "count") {
    const elapsed = Math.max(0, daysBetween(target, today));
    if (elapsed <= 30) return `${elapsed} . Days`;
    const months = Math.floor((elapsed - 1) / 30);
    const days = ((elapsed - 1) % 30) + 1;
    return `${months} . Months - ${days} . Days`;
  }
  const dayVal = daysBetween(today, target) + 1; // aaj ka din aur target date, dono count
  return dayVal <= 0 ? "Expire" : `${dayVal} . Day Left`;
}

function formatReminderCardMessage(entry) {
  return `New Reminder List\n\n${entry.listName}\n\n${computeDayLeftText(entry)}\n\n${entry.targetDate}`;
}

// ---- Command parsers ----
function parseAddCommand(text) {
  const m = String(text || "").trim().match(/^\/add\s+(.+)$/is);
  if (!m) return null;
  return m[1].split("|").map(s => s.trim());
}

function parseEditCommand(text) {
  const m = String(text || "").trim().match(/^\/edit\s+(.+)$/is);
  if (!m) return null;
  return m[1].split("|").map(s => s.trim());
}

function parseDeleteCommand(text) {
  const m = String(text || "").trim().match(/^\/delete\s+(.+)$/is);
  if (!m) return null;
  return m[1].trim();
}

function isYesConfirm(text) {
  return /^yes$/i.test(String(text || "").trim());
}

// ===== /cm -> lists every supported command =====
function isCommandListRequest(text) {
  return /^\/cm$/i.test(String(text || "").trim());
}

function buildCommandListMessage() {
  // Current IST date + time (message aane ke time ka)
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const get = (type) => dateParts.find(p => p.type === type)?.value || "";
  const dateLine = `Today - ${get("day")}/${get("month")}/${get("year")} (${get("weekday")})`;

  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const hour = timeParts.find(p => p.type === "hour")?.value || "";
  const minute = timeParts.find(p => p.type === "minute")?.value || "";
  const dayPeriod = timeParts.find(p => p.type === "dayPeriod")?.value || "";
  const timeLine = `${hour}:${minute} ${dayPeriod}`;

  // Divider left se right tak (double nahi)
  const longDivider = "_".repeat(CARD_WIDTH + 12);

  return [
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    dateLine,
    "",
    timeLine,
    "",
    "All Command list",
    "",
    longDivider,
    "",
    "Reminder page:",
    "",
    "/add Name | DD/MM/YYYY | Price | AlertDays | countdown",
    "",
    "/edit Name | DD/MM/YYYY | Price | AlertDays | countdown",
    "",
    "/delete Name",
    "",
    "/rp — show all reminder lists",
    "",
    longDivider,
    "",
    "History page:",
    "",
    "/hd — delete",
    "",
    "/h 1 to /h 10 — latest history",
    "",
    longDivider,
    "",
    "Other:",
    "",
    "/cm  (shows this command list)",
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
  ].join("\n");
}

const PENDING_DELETE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ===== /rp -> show all current reminder lists =====
function isReminderListRequest(text) {
  return /^\/rp$/i.test(String(text || "").trim());
}

function buildReminderListMessage(reminderLists) {
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const get = (type) => dateParts.find(p => p.type === type)?.value || "";
  const dateLine = `Today - ${get("day")}/${get("month")}/${get("year")} (${get("weekday")})`;

  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const hour = timeParts.find(p => p.type === "hour")?.value || "";
  const minute = timeParts.find(p => p.type === "minute")?.value || "";
  const dayPeriod = timeParts.find(p => p.type === "dayPeriod")?.value || "";
  const timeLine = `${hour}:${minute} ${dayPeriod}`;

  const longDivider = "_".repeat(CARD_WIDTH + 12);

  const lines = [
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    BLANK_PAD_LINE,
    dateLine,
    "",
    timeLine,
    "",
    "Reminder page",
    "",
    `Total List - ${(reminderLists || []).length}`,
    "",
    "",
    longDivider,
    "",
    "",
  ];

  if (!reminderLists || !reminderLists.length) {
    lines.push("No reminders found.");
    lines.push("");
  } else {
    reminderLists.forEach(r => {
      lines.push(r.listName || "Untitled");
      lines.push("");
    });
  }

  lines.push(BLANK_PAD_LINE);
  lines.push(BLANK_PAD_LINE);
  lines.push(BLANK_PAD_LINE);
  return lines.join("\n");
}

// "/hd Name" -> Name
function parseDeleteHistoryCommand(text) {
  const m = String(text || "").trim().match(/^\/hd\s+(.+)$/is);
  if (!m) return null;
  return m[1].trim();
}

// Reminder names are unique, but History groups (see buildHistoryGroups below)
// are keyed by reminderId — findHistoryGroupsByName does the name lookup now.

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
    lines.push(centerText("No History Found", FULL_WIDTH));
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

    const text = message.text;

    // ===== /cm (lists all supported commands) =====
    if (isCommandListRequest(text)) {
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, buildCommandListMessage());
      return res.status(200).json({ ok: true });
    }

    // ===== /rp (show all current reminder lists) =====
    if (isReminderListRequest(text)) {
      const docData = await fetchDocData();
      const reminderLists = readJsonField(docData, "reminderLists", []);
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, buildReminderListMessage(reminderLists));
      return res.status(200).json({ ok: true });
    }

    // =====  /add Name | DD/MM/YYYY | Price | AlertDays | countdown =====
    const addParts = parseAddCommand(text);
    if (addParts) {
      const parsed = parseReminderFieldParts(addParts);
      if (parsed.error) {
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID, parsed.error);
        return res.status(200).json({ ok: true });
      }
      const docData = await fetchDocData();
      const reminderLists = readJsonField(docData, "reminderLists", []);
      const historyLists = readJsonField(docData, "historyLists", []);

      if (findReminderByName(reminderLists, parsed.data.listName)) {
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
          `A list named "${parsed.data.listName}" already exists. Use a different name, or use /edit.`);
        return res.status(200).json({ ok: true });
      }

      const newEntry = { id: genId(), ...parsed.data, created: Date.now() };
      reminderLists.push(newEntry);
      historyLists.push(buildHistorySnapshotEntry(newEntry));

      await patchDocFields({
        reminderLists: JSON.stringify(reminderLists),
        historyLists: JSON.stringify(historyLists),
      });

      await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
        formatReminderConfirmMessage("✅ Reminder Added", newEntry));
      return res.status(200).json({ ok: true });
    }

    // ===== /edit Name | DD/MM/YYYY | Price | AlertDays | countdown =====
    const editParts = parseEditCommand(text);
    if (editParts) {
      if (!editParts.length || !editParts[0]) {
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
          "Wrong format. Correct format:\n/edit Name | DD/MM/YYYY | Price | AlertDays | countdown");
        return res.status(200).json({ ok: true });
      }
      const searchName = editParts[0];
      const docData = await fetchDocData();
      const reminderLists = readJsonField(docData, "reminderLists", []);
      const historyLists = readJsonField(docData, "historyLists", []);

      const existing = findReminderByName(reminderLists, searchName);
      if (!existing) {
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
          `No list found named "${searchName}". Please check the name.`);
        return res.status(200).json({ ok: true });
      }

      const parsed = parseReminderFieldParts([existing.listName, ...editParts.slice(1)]);
      if (parsed.error) {
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID, parsed.error);
        return res.status(200).json({ ok: true });
      }

      const targetDateChanged = existing.targetDate !== parsed.data.targetDate;
      const idx = reminderLists.findIndex(r => r.id === existing.id);
      const updatedEntry = { ...existing, ...parsed.data };
      reminderLists[idx] = updatedEntry;

      if (targetDateChanged && (updatedEntry.counter === "countdown" || updatedEntry.counter === "count")) {
        historyLists.push(buildHistorySnapshotEntry(updatedEntry));
      }

      await patchDocFields({
        reminderLists: JSON.stringify(reminderLists),
        historyLists: JSON.stringify(historyLists),
      });

      await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
        formatReminderConfirmMessage("✅ Reminder Updated", updatedEntry));
      return res.status(200).json({ ok: true });
    }

    // ===== /delete Name (asks for confirmation first) =====
    const deleteName = parseDeleteCommand(text);
    if (deleteName) {
      const docData = await fetchDocData();
      const reminderLists = readJsonField(docData, "reminderLists", []);
      const existing = findReminderByName(reminderLists, deleteName);
      if (!existing) {
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
          `No list found named "${deleteName}". Please check the name.`);
        return res.status(200).json({ ok: true });
      }

      await patchDocFields({
        pendingDelete: JSON.stringify({ id: existing.id, listName: existing.listName, requestedAt: Date.now() }),
      });

      await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
        `⚠️ Are you sure you want to delete "${existing.listName}"?\nTo confirm, reply with just "yes" (within 2 minutes), otherwise this will be cancelled.`);
      return res.status(200).json({ ok: true });
    }

    // ===== "/hd" alone (no name) -> show the full History-page list first =====
    if (/^\/hd$/i.test(String(text || "").trim())) {
      const docData = await fetchDocData();
      const historyLists = readJsonField(docData, "historyLists", []);
      const reminderLists = readJsonField(docData, "reminderLists", []);
      const historyPageHiddenIds = readJsonField(docData, "historyPageHiddenIds", []);
      const hiddenListIds = readJsonField(docData, "hiddenListIds", []);
      const groups = buildHistoryGroups(historyLists, reminderLists, historyPageHiddenIds, hiddenListIds);
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, buildHistoryGroupListMessage(groups));
      return res.status(200).json({ ok: true });
    }

    // ===== "/hd Name" (History page — asks for confirmation first) =====
    const deleteHistoryName = parseDeleteHistoryCommand(text);
    if (deleteHistoryName) {
      const docData = await fetchDocData();
      const historyLists = readJsonField(docData, "historyLists", []);
      const reminderLists = readJsonField(docData, "reminderLists", []);
      const historyPageHiddenIds = readJsonField(docData, "historyPageHiddenIds", []);
      const hiddenListIds = readJsonField(docData, "hiddenListIds", []);
      const groups = buildHistoryGroups(historyLists, reminderLists, historyPageHiddenIds, hiddenListIds);
      const matches = findHistoryGroupsByName(groups, deleteHistoryName);

      if (!matches.length) {
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
          `No list found named "${deleteHistoryName}" on the History page. Please check the name (send /hd to see the full list).`);
        return res.status(200).json({ ok: true });
      }

      await patchDocFields({
        pendingHistoryDelete: JSON.stringify({
          ids: matches.map(g => g.id), // reminderId(s) — same key the website groups by
          listName: deleteHistoryName,
          requestedAt: Date.now(),
        }),
      });

      await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
        `⚠️ Are you sure you want to delete "${deleteHistoryName}" from the History page?\nTo confirm, reply with just "yes" (within 2 minutes), otherwise this will be cancelled.`);
      return res.status(200).json({ ok: true });
    }

    // ===== "yes" -> confirms a pending delete (Reminder page OR History page) =====
    if (isYesConfirm(text)) {
      const docData = await fetchDocData();
      const pending = readJsonField(docData, "pendingDelete", null);
      const pendingHistory = readJsonField(docData, "pendingHistoryDelete", null);

      if (!pending && !pendingHistory) {
        // No pending delete — stay silent.
        return res.status(200).json({ ok: true });
      }

      // Reminder-page delete → soft-delete into reminderTrash
      if (pending) {
        if (Date.now() - (pending.requestedAt || 0) > PENDING_DELETE_TIMEOUT_MS) {
          await patchDocFields({ pendingDelete: undefined });
          await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
            "The confirmation window (2 minutes) has expired. Please send /delete Name again.");
          return res.status(200).json({ ok: true });
        }

        const reminderLists = readJsonField(docData, "reminderLists", []);
        const reminderTrash = readJsonField(docData, "reminderTrash", []);
        const toMove = reminderLists.find(r => r.id === pending.id);
        const filtered = reminderLists.filter(r => r.id !== pending.id);
        if (toMove) {
          reminderTrash.push({ ...toMove, deletedAt: Date.now() });
        }

        await patchDocFields({
          reminderLists: JSON.stringify(filtered),
          reminderTrash: JSON.stringify(reminderTrash),
          pendingDelete: undefined,
        });

        await sendTelegramMessage(BOT_TOKEN, CHAT_ID, `🗑️ Moved to Recycle Bin: ${pending.listName}`);
        return res.status(200).json({ ok: true });
      }

      // History-page delete → soft-delete into historyTrash
      if (Date.now() - (pendingHistory.requestedAt || 0) > PENDING_DELETE_TIMEOUT_MS) {
        await patchDocFields({ pendingHistoryDelete: undefined });
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
          "The confirmation window (2 minutes) has expired. Please send /hd Name again.");
        return res.status(200).json({ ok: true });
      }

      const historyLists = readJsonField(docData, "historyLists", []);
      const historyPageHiddenIds = readJsonField(docData, "historyPageHiddenIds", []);
      const historyTrash = readJsonField(docData, "historyTrash", []);
      const idsToRemove = new Set(pendingHistory.ids || []);

      const snapshots = historyLists.filter(h => idsToRemove.has(h.reminderId));
      const now = Date.now();
      idsToRemove.forEach(rid => {
        const related = snapshots.filter(h => h.reminderId === rid);
        const listName = (related[0] && related[0].listName) || pendingHistory.listName || 'Untitled';
        historyTrash.push({
          id: rid,
          listName,
          snapshots: related,
          deletedAt: now,
        });
      });

      const filteredHistory = historyLists.filter(h => !idsToRemove.has(h.reminderId));
      const updatedHiddenIds = [...historyPageHiddenIds];
      idsToRemove.forEach(id => {
        if (!updatedHiddenIds.includes(id)) updatedHiddenIds.push(id);
      });

      await patchDocFields({
        historyLists: JSON.stringify(filteredHistory),
        historyPageHiddenIds: JSON.stringify(updatedHiddenIds),
        historyTrash: JSON.stringify(historyTrash),
        pendingHistoryDelete: undefined,
      });

      await sendTelegramMessage(BOT_TOKEN, CHAT_ID,
        `🗑️ Moved to Recycle Bin: ${pendingHistory.listName}`);
      return res.status(200).json({ ok: true });
    }

    // ===== /h (latest history view) =====
    const requestedCount = parseHistoryCommand(text);
    if (requestedCount === null) {
      // No supported command matched — stay silent.
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
