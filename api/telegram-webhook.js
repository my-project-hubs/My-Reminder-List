// api/telegram-webhook.js

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

// Helper function: Animated Custom Emoji tag generate karne ke liye
function createAnimatedEmoji(emojiId, fallbackEmoji = "🚨") {
  return `<tg-emoji emoji-id="${emojiId}">${fallbackEmoji}</tg-emoji>`;
}

async function sendTelegramMessage(botToken, chatId, text) {
  const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const tgRes = await fetch(tgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML" // Animation & Formatting support enabled
    }),
  });
  return tgRes.json();
}

function parseHistoryCommand(text) {
  const m = String(text || "").trim().match(/^\/?history\s*(\d{1,2})?\s*$/i);
  if (!m) return null;
  let n = parseInt(m[1], 10);
  if (isNaN(n) || n < 1) n = 1;
  if (n > 10) n = 10;
  return n;
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

function buildHistoryMessage(entries, requestedCount, reminderById) {
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
    if (h.itemType === "notes") {
      const liveItem = reminderById && reminderById[h.reminderId];
      const noteText = String(h.notes || (liveItem && liveItem.notes) || "").trim();
      lines.push(centerText("Notes", CARD_WIDTH));
      lines.push(BLANK_PAD_LINE);
      lines.push(`Title - ${h.listName || "Untitled"}`);
      lines.push(BLANK_PAD_LINE);
      if (noteText) {
        const noteLines = noteText.split("\n");
        lines.push(`Notes - ${noteLines[0]}`);
        for (let i = 1; i < noteLines.length; i++) lines.push(noteLines[i]);
        lines.push(BLANK_PAD_LINE);
      }
      lines.push(centerText(cleanTargetDate(h.targetDate), FULL_WIDTH));
      lines.push(BLANK_PAD_LINE);
    } else {
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
    }
  });
  lines.push(DIVIDER_LINE);
  lines.push(BLANK_PAD_LINE);
  return lines.join("\n");
}

export default async function handler(req, res) {
  try {
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

    if (!message || !message.chat || !message.text) {
      return res.status(200).json({ ok: true });
    }

    if (String(message.chat.id) !== CHAT_ID) {
      return res.status(200).json({ ok: true });
    }

    const requestedCount = parseHistoryCommand(message.text);
    if (requestedCount === null) {
      return res.status(200).json({ ok: true });
    }

    const docData = await fetchDocData();
    const historyLists = readJsonField(docData, "historyLists", []);
    const reminderLists = readJsonField(docData, "reminderLists", []);
    const reminderById = {};
    reminderLists.forEach(r => { if (r && r.id) reminderById[r.id] = r; });

    const sorted = [...historyLists].sort((a, b) => (b.created || 0) - (a.created || 0));
    const top = sorted.slice(0, requestedCount);

    const msgText = buildHistoryMessage(top, requestedCount, reminderById);
    const tgData = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, msgText);

    return res.status(200).json({ ok: true, sent: !!tgData.ok, count: top.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
    }
  
