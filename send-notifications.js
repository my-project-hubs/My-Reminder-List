const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://my-tracker-d4776-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();

function parseEventDateString(str) {
  if (!str) return null;
  const parts = str.split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

function getTodayMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

const ALERT_THRESHOLD_DAYS_DEFAULT = 15;
let ALERT_THRESHOLD_DAYS = ALERT_THRESHOLD_DAYS_DEFAULT;
let CYLINDER_THRESHOLD_VALUE = 3.0;

function getCylinderThresholdParts() {
  const months = Math.floor(CYLINDER_THRESHOLD_VALUE);
  const days = Math.round((CYLINDER_THRESHOLD_VALUE - months) * 100);
  return { months, days };
}

function computeIsAlert(rawName, rawDate, rawType) {
  const eventDate = parseEventDateString(rawDate);
  if (!eventDate) return null;
  const today = getTodayMidnight();
  const name = rawName || "";
  const type = (rawType || "countdown").toLowerCase();

  if (type === "elapsed") {
    const elapsedDays = Math.max(0, Math.round((today - eventDate) / 86400000));
    const months = Math.floor(elapsedDays / 30);
    const days = elapsedDays % 30;
    const { months: thMonths, days: thDays } = getCylinderThresholdParts();
    let isAlert = false;
    if (months > thMonths) isAlert = true;
    else if (months === thMonths) isAlert = days >= thDays;
    return { name, isAlert, countdownText: `${months}m ${days}d used` };
  }

  const diffDays = Math.round((eventDate - today) / 86400000);
  if (diffDays < 0) {
    return { name, isAlert: true, countdownText: "Expired" };
  }
  const isAlert = diffDays <= ALERT_THRESHOLD_DAYS;
  return { name, isAlert, countdownText: `${diffDays} day(s) left` };
}

async function main() {
  const settingsSnap = await db.ref("settings").once("value");
  const settings = settingsSnap.val() || {};
  console.log("Settings fetched:", JSON.stringify(settings));
  if (settings.thresholds && typeof settings.thresholds.cylinder === "number") {
    CYLINDER_THRESHOLD_VALUE = settings.thresholds.cylinder;
  }
  if (settings.thresholds && typeof settings.thresholds.days === "number") {
    ALERT_THRESHOLD_DAYS = settings.thresholds.days;
  }

  const eventsSnap = await db.ref("remindersData/events").once("value");
  const rawEvents = eventsSnap.val() || [];
  const eventsArray = Array.isArray(rawEvents) ? rawEvents : Object.values(rawEvents);
  console.log("Raw events fetched:", JSON.stringify(eventsArray));
  console.log("ALERT_THRESHOLD_DAYS:", ALERT_THRESHOLD_DAYS);

  const alerts = eventsArray
    .map((ev) => computeIsAlert(ev.name, ev.date, ev.type))
    .filter((e) => e && e.isAlert);
  console.log("Computed alerts:", JSON.stringify(alerts));

  if (alerts.length === 0) {
    console.log("No alerts today. Nothing to send.");
    return;
  }

  const tokensSnap = await db.ref("notificationTokens").once("value");
  const tokensObj = tokensSnap.val() || {};
  const tokens = Object.keys(tokensObj);

  if (tokens.length === 0) {
    console.log("No notification tokens saved. Nothing to send.");
    return;
  }

  const title = alerts.length === 1 ? alerts[0].name : `${alerts.length} Reminders Need Attention`;
  const body = alerts.map((a) => `${a.name}: ${a.countdownText}`).join(" | ");

  const message = {
    notification: { title, body },
    tokens: tokens
  };

  const response = await admin.messaging().sendEachForMulticast(message);
  console.log(`Sent: ${response.successCount}, Failed: ${response.failureCount}`);

  response.responses.forEach((resp, idx) => {
    if (!resp.success) {
      console.log("Failed token:", tokens[idx], resp.error && resp.error.message);
    }
  });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
  
