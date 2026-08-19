// api/verify-password.js
// Yeh function password ko SERVER PAR check karta hai — SITE_PASSWORD
// Vercel Environment Variables mein set hoga, kabhi bhi frontend code mein nahi.
// Isliye DevTools se code dekhkar bhi asli password pata nahi chal sakta.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { password } = req.body || {};
    const correctPassword = process.env.SITE_PASSWORD;

    if (!correctPassword) {
      // Agar env variable set hi nahi hai, to safety ke liye deny karo
      console.error('SITE_PASSWORD env variable set nahi hai');
      return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

    if (password && password === correctPassword) {
      return res.status(200).json({ ok: true });
    }

    return res.status(401).json({ ok: false });
  } catch (err) {
    console.error('verify-password error:', err);
    return res.status(500).json({ ok: false });
  }
}
