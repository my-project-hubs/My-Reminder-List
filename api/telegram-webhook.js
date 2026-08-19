// api/telegram-webhook.js
// Ye file Telegram ke "Webhook" se call hoti hai — jab bhi aap bot ko koi
// message bhejte ho, Telegram turant is URL ko hit karta hai (cron ki zaroorat
// nahi hai, ye instant hai).
//
// SUPPORTED MESSAGES:
//   /h                 -> latest 1 history
//   /h 5               -> latest 5 history
//   /h 10              -> latest 10 history (maximum)
//   h 3                -> (slash ke bina bhi chalega)
//   Kuch bhi aur (jaise "Mobile Recharge 25 tareek ko jodo") -> AI Agent
//   samajh kar add/edit/delete ka SUGGESTION deta hai, aap "haan"/"nahi"
//   bolkar confirm/cancel karte ho. Bina confirm kiye kabhi kuch nahi hota.
//
// SAFETY NET:
//   - Delete kabhi turant permanent nahi hota — item "trashItems" mein chala
//     jaata hai (Trash), website se wahan se restore kiya ja sakta hai.
//   - Edit se pehle purana data "editHistory" mein save ho jaata hai, wahan
//     se undo kiya ja sakta hai.
//
// ONE-TIME SETUP (isko ek baar apne browser mein khol dena, bas):
//   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<aapka-vercel-domain>/api/telegram-webhook&secret_token=<MY_SECRET_KEY>

const FIREBASE_PROJECT_ID = "life-tracker-3a3a8";
const FIRESTORE_DOC_PATH = "reminderApp/mainData";
const GEMINI_MODEL = "gemini-2.0-flash";
const PENDING_ACTION_EXPIRY_MS = 10 * 60 * 1000; // 10 minute mein confirm na kiya to expire
const MAX_TRASH_ITEMS = 200;
const MAX_EDIT_HISTORY = 200;

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

// Ek saath kai fields ko ek hi PATCH call mein likh do (JSON string ke roop mein).
async function writeMainDataFields(fieldsObj) {
  const keys = Object.keys(fieldsObj);
  const maskParams = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIRESTORE_DOC_PATH}?${maskParams}`;
  const fields = {};
  keys.forEach(k => {
    fields[k] = { stringValue: JSON.stringify(fieldsObj[k]) };
  });
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Firestore write failed: ${res.status}`);
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

// "/h", "h", "/h 5", "h10" — sab match ho jayenge.
function parseHistoryCommand(text) {
  const m = String(text || "").trim().match(/^\/?h\s*(\d{1,2})?\s*$/i);
  if (!m) return null;
  let n = parseInt(m[1], 10);
  if (isNaN(n) || n < 1) n = 1;
  if (n > 10) n = 10;
  return n;
}

function isYes(text) {
  return /^(haan|han|ha|yes|y|ok|okay|confirm|kar do|karo)\s*$/i.test(String(text || "").trim());
}
function isNo(text) {
  return /^(nahi|nahin|na|no|n|cancel|rehne do|mat karo)\s*$/i.test(String(text || "").trim());
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
      lines.push(centerText("( Notice )", CARD_WIDTH));
      lines.push(BLANK_PAD_LINE);
      lines.push(`Title - ${h.listName || "Untitled"}`);
      lines.push(BLANK_PAD_LINE);
      if (noteText) {
        const noteLines = noteText.split("\n");
        lines.push(`Notice - ${noteLines[0]}`);
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

// ============== AI AGENT ==============

async function askGemini(apiKey, userMessage, reminderLists) {
  const simplified = reminderLists.map(r => ({
    id: r.id,
    listName: r.listName,
    targetDate: r.targetDate,
    price: r.price,
  }));

  const systemPrompt = `Tum ek reminder app ke AI assistant ho. User Hindi/Hinglish mein message bhejega jisme wo apne reminders mein add/edit/delete karna chahega.
Neeche current reminders ki list JSON mein di gayi hai. User ke message ko samjho aur SIRF neeche diye JSON format mein jawab do, koi extra text nahi:

{
  "action": "add" | "edit" | "delete" | "clarify" | "unknown",
  "target_id": "<matching reminder ka id, ya null agar add/unknown/clarify>",
  "listName": "<naya/updated naam, sirf add/edit ke liye>",
  "targetDate": "<naya/updated date, sirf add/edit ke liye, jo bhi format user ne diya wahi rakho>",
  "price": <naya/updated price number, sirf add/edit ke liye, ya null agar nahi bataya>,
  "confirmation_message": "<Hinglish mein 1-2 line jisme exactly bataya ho kya hone wala hai, user ko confirm karne ke liye — 'haan' ya 'nahi' bolne ko kaho>",
  "clarification_message": "<agar action clarify hai to yahan poocho ki kaunsa specific item, options bhi list karo>"
}

Rules:
- Agar delete/edit ke liye kaunsa item match karta hai ye clearly pata nahi chal raha (jaise 2+ similar naam), action ko "clarify" rakho aur clarification_message mein saare matching options list karo.
- Agar user ka message reminder se related hi nahi lagta, action ko "unknown" rakho.
- targetDate ka format waisa hi rakho jaisa user ne bola (free text theek hai).
- Sirf JSON return karo, kuch aur text nahi.

Current reminders: ${JSON.stringify(simplified)}
User message: ${userMessage}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini call failed: ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini se khaali jawab aaya");
  return JSON.parse(text);
}

function applyPendingAction(action, reminderLists, trashItems, editHistory) {
  const now = Date.now();
  let newReminderLists = [...reminderLists];
  let newTrashItems = [...trashItems];
  let newEditHistory = [...editHistory];
  let doneMsg = "";

  if (action.action === "add") {
    const newEntry = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 7),
      listName: action.listName || "Untitled",
      targetDate: action.targetDate || "",
      price: action.price || null,
      created: now,
    };
    newReminderLists.push(newEntry);
    doneMsg = `Naya reminder add ho gaya — "${newEntry.listName}"`;
  } else if (action.action === "edit") {
    const idx = newReminderLists.findIndex(r => r.id === action.target_id);
    if (idx === -1) {
      doneMsg = "Ye item ab list mein nahi mila (shayad pehle hi delete ho chuka).";
    } else {
      newEditHistory.push({
        reminderId: action.target_id,
        previousData: { ...newReminderLists[idx] },
        editedAt: now,
      });
      if (newEditHistory.length > MAX_EDIT_HISTORY) newEditHistory = newEditHistory.slice(-MAX_EDIT_HISTORY);
      newReminderLists[idx] = {
        ...newReminderLists[idx],
        listName: action.listName || newReminderLists[idx].listName,
        targetDate: action.targetDate || newReminderLists[idx].targetDate,
        price: action.price !== null && action.price !== undefined ? action.price : newReminderLists[idx].price,
      };
      doneMsg = `Edit ho gaya — "${newReminderLists[idx].listName}"`;
    }
  } else if (action.action === "delete") {
    const idx = newReminderLists.findIndex(r => r.id === action.target_id);
    if (idx === -1) {
      doneMsg = "Ye item ab list mein nahi mila (shayad pehle hi delete ho chuka).";
    } else {
      const removed = newReminderLists.splice(idx, 1)[0];
      newTrashItems.push({ ...removed, deletedAt: now });
      if (newTrashItems.length > MAX_TRASH_ITEMS) newTrashItems = newTrashItems.slice(-MAX_TRASH_ITEMS);
      doneMsg = `Delete ho gaya (Trash mein bhej diya) — "${removed.listName}". Website ke Trash section se restore kar sakte ho.`;
    }
  }

  return { newReminderLists, newTrashItems, newEditHistory, doneMsg };
}

export default async function handler(req, res) {
  try {
    const MY_SECRET_KEY = (process.env.MY_SECRET_KEY || "").trim();
    const providedKey = String(
      req.headers["x-telegram-bot-api-secret-token"] || req.query?.key || ""
    ).trim();
    if (!MY_SECRET_KEY || providedKey !== MY_SECRET_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, info: "Telegram webhook is live." });
    }

    const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
    const CHAT_ID = (process.env.CHAT_ID || "").trim();
    const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
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

    const text = message.text;
    const requestedCount = parseHistoryCommand(text);

    const docData = await fetchDocData();
    const historyLists = readJsonField(docData, "historyLists", []);
    const reminderLists = readJsonField(docData, "reminderLists", []);
    const trashItems = readJsonField(docData, "trashItems", []);
    const editHistory = readJsonField(docData, "editHistory", []);
    const pendingAiAction = readJsonField(docData, "pendingAiAction", null);

    // 1) History command — jaisa pehle se tha.
    if (requestedCount !== null) {
      const reminderById = {};
      reminderLists.forEach(r => { if (r && r.id) reminderById[r.id] = r; });
      const sorted = [...historyLists].sort((a, b) => (b.created || 0) - (a.created || 0));
      const top = sorted.slice(0, requestedCount);
      const msgText = buildHistoryMessage(top, requestedCount, reminderById);
      const tgData = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, msgText);
      return res.status(200).json({ ok: true, sent: !!tgData.ok, count: top.length });
    }

    // 2) Ek pending AI action confirm/cancel hone ka intezaar kar raha hai.
    if (pendingAiAction && (Date.now() - pendingAiAction.createdAt) < PENDING_ACTION_EXPIRY_MS) {
      if (isYes(text)) {
        const { newReminderLists, newTrashItems, newEditHistory, doneMsg } =
          applyPendingAction(pendingAiAction, reminderLists, trashItems, editHistory);
        await writeMainDataFields({
          reminderLists: newReminderLists,
          trashItems: newTrashItems,
          editHistory: newEditHistory,
          pendingAiAction: null,
        });
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID, "✅ " + doneMsg);
        return res.status(200).json({ ok: true });
      }
      if (isNo(text)) {
        await writeMainDataFields({ pendingAiAction: null });
        await sendTelegramMessage(BOT_TOKEN, CHAT_ID, "❌ Cancel kar diya, kuch nahi badla.");
        return res.status(200).json({ ok: true });
      }
      // Kuch aur likha — purana pending cancel karke naye command jaisa treat karenge (neeche).
    }

    // 3) Naya AI command — agar Gemini key set hi nahi hai to chup rehte hain.
    if (!GEMINI_API_KEY) {
      return res.status(200).json({ ok: true });
    }

    let aiAction;
    try {
      aiAction = await askGemini(GEMINI_API_KEY, text, reminderLists);
    } catch (e) {
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, "AI se abhi jawab nahi mil paya, thodi der baad try karein.");
      return res.status(200).json({ ok: true });
    }

    if (!aiAction || aiAction.action === "unknown") {
      // Reminder se related nahi lagta — chup rehte hain.
      return res.status(200).json({ ok: true });
    }

    if (aiAction.action === "clarify") {
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, aiAction.clarification_message || "Thoda aur clearly bataiye kaunsa item.");
      return res.status(200).json({ ok: true });
    }

    // add/edit/delete — pehle confirm mangte hain, turant nahi karte.
    await writeMainDataFields({
      pendingAiAction: { ...aiAction, createdAt: Date.now() },
    });
    await sendTelegramMessage(
      BOT_TOKEN,
      CHAT_ID,
      (aiAction.confirmation_message || "Kya ye karna hai?") + "\n\n(haan / nahi likh kar batayein)"
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

