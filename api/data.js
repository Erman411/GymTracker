// Cloud copy of the tracker's data, stored in Upstash Redis (connected through the Vercel dashboard).
// GET returns {updatedAt, data}; PUT saves it. Every request needs the sync code (SYNC_KEY) in x-sync-key.
const crypto = require('crypto');
const MAIN = 'gymtracker:data';

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const pass = process.env.SYNC_KEY;
  if (!url || !token || !pass) return res.status(503).json({ error: 'not-configured' });
  if (!same(req.headers['x-sync-key'] || '', pass)) return res.status(401).json({ error: 'wrong-code' });

  const redis = async (cmd) => {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  };

  try {
    const raw = await redis(['GET', MAIN]);
    const stored = raw ? JSON.parse(raw) : null;

    if (req.method === 'GET') return res.status(200).json(stored);

    if (req.method === 'PUT' || req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || typeof body.updatedAt !== 'number' || !body.data || !Array.isArray(body.data.history)) {
        return res.status(400).json({ error: 'bad-data' });
      }
      // never let an older copy overwrite a newer one
      if (stored && stored.updatedAt > body.updatedAt) return res.status(409).json(stored);
      const value = JSON.stringify({ updatedAt: body.updatedAt, data: body.data });
      await redis(['SET', MAIN, value]);
      // one safety snapshot per day, kept for 30 days
      const day = new Date().toISOString().slice(0, 10);
      await redis(['SET', 'gymtracker:backup:' + day, value, 'EX', 60 * 60 * 24 * 30]);
      return res.status(200).json({ ok: true, updatedAt: body.updatedAt });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: 'storage' });
  }
};
