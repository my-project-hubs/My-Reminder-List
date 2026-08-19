// api/verify-password.js
// Password ko SERVER PAR check karta hai (SITE_PASSWORD env variable se).
// Lockout bhi SERVER PAR (Firestore mein) ek hi GLOBAL record ke roop mein
// store hota hai — kisi IP ya browser se bandha nahi hai. Isliye:
//   - Browser ka data/localStorage/cookies clear karne se kabhi bypass nahi hota
//   - IP badalne (mobile data, naya wifi) se bhi kabhi bypass nahi hota
// Trade-off: lock poori website ke liye ek saath lagta hai — agar khud hi
// 3 baar galat password daal diya to khud ko bhi 24 ghante wait karna padega.

const FIREBASE_PROJECT_ID = "life-tracker-3a3a8";
const LOCK_DOC_PATH = "reminderApp/loginAttempts";
const MAX_ATTEMPTS = 3;
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 ghante

async function fetchLockDoc() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${LOCK_DOC_PATH}`;
  const res = await fetch(url);
  if (res.status === 404) return { count: 0, lockUntil: 0 }; // pehli baar — doc abhi bana hi nahi
  if (!res.ok) throw new Error(`Firestore fetch failed: ${res.status}`);
  const data = await res.json();
  const count = parseInt(data?.fields?.count?.integerValue || "0", 10);
  const lockUntil = parseInt(data?.fields?.lockUntil?.integerValue || "0", 10);
  return { count, lockUntil };
}

async function writeLockDoc(count, lockUntil) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${LOCK_DOC_PATH}?updateMask.fieldPaths=count&updateMask.fieldPaths=lockUntil`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        count: { integerValue: String(count) },
        lockUntil: { integerValue: String(lockUntil) },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore write failed: ${res.status}`);
}

export default async function handler(req, res) {
  try {
    const ownerPassword = process.env.SITE_PASSWORD;
    const guestPassword = process.env.GUEST_PASSWORD;
    if (!ownerPassword) {
      console.error("SITE_PASSWORD env variable set nahi hai");
      return res.status(500).json({ ok: false, error: "Server not configured" });
    }

    let { count, lockUntil } = await fetchLockDoc();
    const now = Date.now();

    // GET: sirf status check karo — koi attempt count nahi hoti.
    if (req.method === "GET") {
      if (lockUntil && now < lockUntil) {
        return res.status(200).json({ ok: false, locked: true, lockUntil });
      }
      return res.status(200).json({ ok: false, locked: false });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // Abhi lock hai — password sahi ho ya galat, andar nahi jaane do.
    if (lockUntil && now < lockUntil) {
      return res.status(403).json({ ok: false, locked: true, lockUntil });
    }

    // Purana lock khatam ho chuka hai to fresh start.
    if (lockUntil && now >= lockUntil) {
      count = 0;
      lockUntil = 0;
    }

    const { password } = req.body || {};

    // Owner password — poora access.
    if (password && password === ownerPassword) {
      if (count !== 0 || lockUntil !== 0) {
        await writeLockDoc(0, 0);
      }
      return res.status(200).json({ ok: true, role: "owner" });
    }

    // Guest password — sirf limited access.
    if (guestPassword && password && password === guestPassword) {
      if (count !== 0 || lockUntil !== 0) {
        await writeLockDoc(0, 0);
      }
      return res.status(200).json({ ok: true, role: "guest" });
    }

    // Galat password — global counter badhao.
    count = (count || 0) + 1;
    let justLocked = false;
    if (count >= MAX_ATTEMPTS) {
      lockUntil = now + LOCK_DURATION_MS;
      count = 0;
      justLocked = true;
    }
    await writeLockDoc(count, lockUntil);

    if (justLocked) {
      return res.status(403).json({ ok: false, locked: true, lockUntil });
    }
    return res.status(401).json({ ok: false, remaining: MAX_ATTEMPTS - count });
  } catch (err) {
    console.error("verify-password error:", err);
    return res.status(500).json({ ok: false });
  }
}
