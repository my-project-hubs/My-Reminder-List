// api/verify-password.js
// Password ko SERVER PAR check karta hai (SITE_PASSWORD / GUEST_PASSWORD env
// variables se). Lockout (3 galat = 24 ghante) GLOBAL hai — Firestore mein
// ek hi record ke roop mein store hota hai, IP ya browser data clear karne se
// bypass nahi hota.
//
// TRUSTED DEVICE: jis bhi browser se ek baar sahi OWNER password diya jaata
// hai, us browser ka apna ek random deviceToken server par "trusted" list
// mein save ho jaata hai (Firestore). Us token ke saath aane wali request
// kabhi bhi lock check mein nahi phasti — yani apna phone (jahan se aap
// hamesha login karte hain) kabhi lock nahi hoga, chahe kitni bhi baar
// galat password try ho. Koi aur naya/anjaan device abhi bhi normal
// 3-galat/24-ghante wale global lock ke ander hi rahega.
// Dhyan rahe: agar trusted phone kisi aur ke haath lag jaaye, to wahan se
// bhi bina lock ke unlimited try ho sakti hai — isliye phone khud surakshit
// rakhna zaroori hai.

const FIREBASE_PROJECT_ID = "life-tracker-3a3a8";
const LOCK_DOC_PATH = "reminderApp/loginAttempts";
const TRUSTED_DOC_PATH = "reminderApp/trustedDevices";
const MAX_ATTEMPTS = 3;
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 ghante

async function fetchLockDoc() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${LOCK_DOC_PATH}`;
  const res = await fetch(url);
  if (res.status === 404) return { count: 0, lockUntil: 0 };
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

async function fetchTrustedTokens() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${TRUSTED_DOC_PATH}`;
  const res = await fetch(url);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Firestore fetch failed: ${res.status}`);
  const data = await res.json();
  const raw = data?.fields?.tokens?.stringValue;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function addTrustedToken(token) {
  const tokens = await fetchTrustedTokens();
  if (tokens.includes(token)) return;
  tokens.push(token);
  // Bahut zyada bade na ho jaaye isliye purane sabse pehle wale hata do.
  const trimmed = tokens.slice(-20);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${TRUSTED_DOC_PATH}?updateMask.fieldPaths=tokens`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { tokens: { stringValue: JSON.stringify(trimmed) } } }),
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

    const deviceToken = String(
      (req.body && req.body.deviceToken) || req.query?.deviceToken || ""
    ).trim();

    let isTrusted = false;
    if (deviceToken) {
      const trustedTokens = await fetchTrustedTokens();
      isTrusted = trustedTokens.includes(deviceToken);
    }

    // Trusted device ho to lock check hi skip — seedha aage badho.
    if (isTrusted) {
      if (req.method === "GET") {
        return res.status(200).json({ ok: false, locked: false, trusted: true });
      }
      if (req.method !== "POST") {
        return res.status(405).json({ ok: false, error: "Method not allowed" });
      }
      const { password } = req.body || {};
      if (password && password === ownerPassword) {
        return res.status(200).json({ ok: true, role: "owner" });
      }
      if (guestPassword && password && password === guestPassword) {
        return res.status(200).json({ ok: true, role: "guest" });
      }
      // Trusted device par galat password — bina lock ke, bas galat bata do.
      return res.status(401).json({ ok: false, trusted: true });
    }

    // Non-trusted device — normal global lock logic.
    let { count, lockUntil } = await fetchLockDoc();
    const now = Date.now();

    if (req.method === "GET") {
      if (lockUntil && now < lockUntil) {
        return res.status(200).json({ ok: false, locked: true, lockUntil });
      }
      return res.status(200).json({ ok: false, locked: false });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    if (lockUntil && now < lockUntil) {
      return res.status(403).json({ ok: false, locked: true, lockUntil });
    }

    if (lockUntil && now >= lockUntil) {
      count = 0;
      lockUntil = 0;
    }

    const { password } = req.body || {};

    if (password && password === ownerPassword) {
      if (count !== 0 || lockUntil !== 0) {
        await writeLockDoc(0, 0);
      }
      // Is device ko ab se trusted bana do (agla token bhi save karein).
      if (deviceToken) {
        await addTrustedToken(deviceToken);
      }
      return res.status(200).json({ ok: true, role: "owner" });
    }

    if (guestPassword && password && password === guestPassword) {
      if (count !== 0 || lockUntil !== 0) {
        await writeLockDoc(0, 0);
      }
      return res.status(200).json({ ok: true, role: "guest" });
    }

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
