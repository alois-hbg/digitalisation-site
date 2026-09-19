// Netlify Function — servie sur /api/contact via le redirect de netlify.toml.
// Même logique que api/contact.js (la version Vercel), adaptée au format
// classique des Netlify Functions (event/handler au lieu de req/res).
//
// Variables d'environnement à définir dans Netlify
// (Site configuration → Environment variables) :
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

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: JSON.stringify({ error: 'Méthode non autorisée.' }) };
  }

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (rateLimited(ip)) {
    return json(429, { error: 'Trop de demandes. Réessayez plus tard.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Requête invalide.' });
  }
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'Requête invalide.' });
  }

  // Pot de miel : on répond 200 pour ne pas renseigner le robot.
  if (clean(body.site_web, 100) !== '') return json(200, { ok: true });

  // Délai minimal de remplissage côté serveur.
  const ts = parseInt(body.ts, 10);
  if (!Number.isFinite(ts) || Date.now() - ts < 3000 || Date.now() - ts > 6 * 60 * 60 * 1000) {
    return json(400, { error: 'Formulaire expiré. Rechargez la page.' });
  }

  const data = {
    nom: clean(body.nom, 80),
    clinique: clean(body.clinique, 100),
    email: clean(body.email, 120),
    telephone: clean(body.telephone, 20),
    praticiens: clean(body.praticiens, 10),
    message: clean(body.message, 1200),
  };

  if (data.nom.length < 2) return json(422, { error: 'Nom manquant.' });
  if (data.clinique.length < 2) return json(422, { error: 'Établissement manquant.' });
  if (!isEmail(data.email)) return json(422, { error: 'E-mail invalide.' });
  if (!['1', '2-4', '5+'].includes(data.praticiens)) {
    return json(422, { error: 'Taille d’équipe invalide.' });
  }
  if (body.consentement !== true) return json(422, { error: 'Consentement requis.' });
  if (data.telephone && !/^[+0-9\s().-]{8,20}$/.test(data.telephone)) {
    return json(422, { error: 'Téléphone invalide.' });
  }
  if (SPAM.test(data.message) || SPAM.test(data.nom)) {
    return json(200, { ok: true }); // absorbé silencieusement
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY absent');
    return json(500, { error: 'Service indisponible.' });
  }

  const to = process.env.CONTACT_TO_EMAIL || 'vialia.contact@gmail.com';
  const from = process.env.CONTACT_FROM_EMAIL || 'Vialia <onboarding@resend.dev>';
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const html = `
    <h2>Nouvelle demande de démo — ${esc(data.clinique)}</h2>
    <p><strong>Nom :</strong> ${esc(data.nom)}</p>
    <p><strong>Établissement :</strong> ${esc(data.clinique)}</p>
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
    return json(502, { error: 'Envoi impossible pour le moment.' });
  }

  return json(200, { ok: true });
};
