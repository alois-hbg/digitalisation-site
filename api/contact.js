// POST /api/contact
// Tourne côté serveur (Vercel Functions). Aucune clé n'est exposée au
// navigateur : le front n'appelle que cette route, qui envoie ensuite
// l'e-mail via l'API Resend (https://resend.com).
//
// Variables d'environnement à définir dans Vercel :
//   RESEND_API_KEY      clé API Resend (Dashboard → API Keys)
//   CONTACT_TO_EMAIL    boîte mail qui reçoit les demandes (défaut ci-dessous)
//   CONTACT_FROM_EMAIL  expéditeur affiché ; tant qu'aucun domaine n'est
//                       vérifié dans Resend, garder "onboarding@resend.dev"

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 3;                    // 3 demandes par IP et par fenêtre
const hits = new Map();                      // mémoire d'instance, best effort

function rateLimited(ip) {
  const now = Date.now();
  const bucket = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  bucket.push(now);
  hits.set(ip, bucket);
  if (hits.size > 5000) hits.clear();
  return bucket.length > RATE_LIMIT_MAX;
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v);
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// Refus des contenus typiques de spam de formulaire
const SPAM = /(https?:\/\/|\[url=|\bviagra\b|\bcasino\b|\bseo services\b|\bcrypto\b)/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Trop de demandes. Réessayez plus tard.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Requête invalide.' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Requête invalide.' });
  }

  // Pot de miel : on répond 200 pour ne pas renseigner le robot.
  if (clean(body.site_web, 100) !== '') return res.status(200).json({ ok: true });

  // Délai minimal de remplissage côté serveur.
  const ts = parseInt(body.ts, 10);
  if (!Number.isFinite(ts) || Date.now() - ts < 3000 || Date.now() - ts > 6 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Formulaire expiré. Rechargez la page.' });
  }

  const data = {
    nom: clean(body.nom, 80),
    clinique: clean(body.clinique, 100),
    email: clean(body.email, 120),
    telephone: clean(body.telephone, 20),
    praticiens: clean(body.praticiens, 10),
    message: clean(body.message, 1200),
  };

  if (data.nom.length < 2) return res.status(422).json({ error: 'Nom manquant.' });
  if (data.clinique.length < 2) return res.status(422).json({ error: 'Clinique manquante.' });
  if (!isEmail(data.email)) return res.status(422).json({ error: 'E-mail invalide.' });
  if (!['1', '2-4', '5+'].includes(data.praticiens)) {
    return res.status(422).json({ error: 'Taille d’équipe invalide.' });
  }
  if (body.consentement !== true) return res.status(422).json({ error: 'Consentement requis.' });
  if (data.telephone && !/^[+0-9\s().-]{8,20}$/.test(data.telephone)) {
    return res.status(422).json({ error: 'Téléphone invalide.' });
  }
  if (SPAM.test(data.message) || SPAM.test(data.nom)) {
    return res.status(200).json({ ok: true }); // absorbé silencieusement
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY absent');
    return res.status(500).json({ error: 'Service indisponible.' });
  }

  const to = process.env.CONTACT_TO_EMAIL || 'vialia.contact@gmail.com';
  const from = process.env.CONTACT_FROM_EMAIL || 'Vialia <onboarding@resend.dev>';
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const html = `
    <h2>Nouvelle demande de démo — ${esc(data.clinique)}</h2>
    <p><strong>Nom :</strong> ${esc(data.nom)}</p>
    <p><strong>Clinique :</strong> ${esc(data.clinique)}</p>
    <p><strong>E-mail :</strong> ${esc(data.email)}</p>
    <p><strong>Téléphone :</strong> ${esc(data.telephone || '—')}</p>
    <p><strong>Taille de l'équipe :</strong> ${esc(data.praticiens)}</p>
    <p><strong>Message :</strong><br>${esc(data.message).replace(/\n/g, '<br>')}</p>
    <p><small>Reçu le ${new Date().toLocaleString('fr-FR')} — consentement horodaté le ${new Date(ts).toLocaleString('fr-FR')}</small></p>
  `;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to,
        reply_to: data.email,
        subject: `Nouvelle demande de démo — ${data.clinique}`,
        html,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error('resend ' + r.status);
  } catch (e) {
    console.error('Envoi Resend en échec', e);
    return res.status(502).json({ error: 'Envoi impossible pour le moment.' });
  }

  return res.status(200).json({ ok: true });
}
