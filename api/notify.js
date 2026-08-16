// api/notify.js
// Ye file cron-job.org se call hogi. Ye Firestore se reminder list padhta hai,
// "Days Left" calculate karta hai (bilkul website jaisa formula), aur Telegram
// pe poori list bhej deta hai.

const FIREBASE_PROJECT_ID = "life-tracker-3a3a8";
const FIRESTORE_DOC_PATH = "reminderApp/mainData";

// ---- Date helpers ----
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

                                                                                                                        // ---- Firestore REST read ----
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

                                                                                                                                                  function buildTelegramMessage(lists) {
                                                                                                                                                    const today = new Date();
                                                                                                                                                      const dateStr = today.toLocaleDateString("en-GB");
                                                                                                                                                        let msg = `📋 Reminder List — ${dateStr}\n\n`;
                                                                                                                                                          if (!lists.length) {
                                                                                                                                                              msg += "Koi reminder nahi mila.";
                                                                                                                                                                  return msg;
                                                                                                                                                                    }
                                                                                                                                                                      lists.forEach((r) => {
                                                                                                                                                                          const dayVal = computeDayValue(r, today);
                                                                                                                                                                              const text = formatDayLeftText(r, dayVal);
                                                                                                                                                                                  msg += `• ${r.listName || "Untitled"}\n  ${text} (${r.targetDate || "--"})\n\n`;
                                                                                                                                                                                    });
                                                                                                                                                                                      return msg.trim();
                                                                                                                                                                                      }

                                                                                                                                                                                      export default async function handler(req, res) {
                                                                                                                                                                                        try {
                                                                                                                                                                                            const BOT_TOKEN = process.env.BOT_TOKEN;
                                                                                                                                                                                                const CHAT_ID = process.env.CHAT_ID;
                                                                                                                                                                                                    if (!BOT_TOKEN || !CHAT_ID) {
                                                                                                                                                                                                          return res.status(500).json({ ok: false, error: "BOT_TOKEN or CHAT_ID missing in environment variables" });
                                                                                                                                                                                                              }

                                                                                                                                                                                                                  const lists = await fetchReminderLists();
                                                                                                                                                                                                                      const message = buildTelegramMessage(lists);

                                                                                                                                                                                                                          const tgUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
                                                                                                                                                                                                                              const tgRes = await fetch(tgUrl, {
                                                                                                                                                                                                                                    method: "POST",
                                                                                                                                                                                                                                          headers: { "Content-Type": "application/json" },
                                                                                                                                                                                                                                                body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                        const tgData = await tgRes.json();

                                                                                                                                                                                                                                                            if (!tgData.ok) {
                                                                                                                                                                                                                                                                  return res.status(500).json({ ok: false, error: tgData });
                                                                                                                                                                                                                                                                      }

                                                                                                                                                                                                                                                                          return res.status(200).json({ ok: true });
                                                                                                                                                                                                                                                                            } catch (err) {
                                                                                                                                                                                                                                                                                return res.status(500).json({ ok: false, error: String(err) });
                                                                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                                                                  }

                                                                                                                                                                                                                                                        