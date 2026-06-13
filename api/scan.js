// /api/scan.js  –  Vercel Serverless Function (Node.js)
//
// Env vars required:
//   OPENAI_API_KEY           – OpenAI API key
//   UPSTASH_REDIS_REST_URL   – e.g. https://xxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN – Upstash REST token
//   KV_REST_API_URL          – Upstash KV URL  (für Lizenz-Keys)
//   KV_REST_API_TOKEN        – Upstash KV token (für Lizenz-Keys)
//   SECRET_MASTER_KEY        – Dein eigener Test-Key (unbegrenzte Scans)

// ── Vercel Body-Size-Limit (wichtig für Base64-Bilder!) ────────────────────
export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

const FREE_TRIAL_LIMIT = 5;

// ── System-Prompt für OpenAI ───────────────────────────────────────────────
// WICHTIG: Hier wurde das Format auf ein JSON-Objekt mit dem Key "flashcards" umgestellt.
const SYSTEM_PROMPT = `Du bist ein präziser Daten-Extraktor und didaktischer Lern-Assistent für Studenten (insbesondere Medizin, Jura und MINT).
Analysiere das hochgeladene Bild. Dies kann eine Tabelle, eine Liste, ein Vorlesungsskript, ein Fließtext oder ein Buchauszug sein.
Ignoriere rein dekorative Elemente, Trennlinien, Icons, Seitenzahlen und irrelevante Randnotizen.

Deine Aufgabe ist es, die wichtigsten Konzepte, Definitionen und Fakten aus dem Bild zu extrahieren und in sinnvolle Lernkarten (Flashcards) umzuwandeln. Gehe dabei wie folgt vor:

Bei Vokabeln/Tabellen: Extrahiere die direkten Paare (Begriff und Übersetzung/Erklärung).

Bei Skripten/Fließtext: Synthetisiere die Kerninformationen. Formuliere aus Absätzen selbstständig klare Frage-Antwort-Paare oder Begriff-Erklärung-Paare.

Didaktik: Brich zu lange oder komplexe Themen in mehrere, gut verdauliche und präzise Lernkarten auf. Vermeide extrem lange Texte auf der Rückseite.

Rückgabe-Parameter:

"front": Das Konzept, die Fragestellung, das Ursprungswort oder der Fachbegriff (inkl. eventueller Abkürzungen).

"back": Die präzise Erklärung, Definition oder die Antwort.

Gib das Ergebnis AUSSCHLIESSLICH als gültiges JSON-Objekt zurück, das ein Array namens "flashcards" enthält. Achte darauf, Anführungszeichen im Text korrekt zu escapen.
Format: { "flashcards": [{"front": "Begriff oder Frage", "back": "Erklärung oder Antwort"}] }`;

// ── Upstash Redis: INCR (für Free-Trial IP-Zähler) ────────────────────────
async function redisIncr(key) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  const res = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Upstash INCR failed: ${res.status}`);
  const json = await res.json();
  return json.result; // number
}

// ── Upstash KV: GET/SET/DECR (für Lizenz-Key Scan-Konten) ─────────────────
async function kvGet(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res   = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`KV GET failed: ${res.status}`);
  const json = await res.json();
  return json.result; // string | null
}

async function kvSet(key, value) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  await fetch(`${url}/set/${key}/${value}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function kvDecr(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res   = await fetch(`${url}/decr/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`KV DECR failed: ${res.status}`);
  const json = await res.json();
  return json.result; // number
}

// ── IP-Adresse des Clients ermitteln ──────────────────────────────────────
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ── Lemon Squeezy Lizenz validieren ───────────────────────────────────────
async function validateLemonSqueezy(licenseKey) {
  const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ license_key: licenseKey }),
  });
  const data = await res.json();
  return data.valid === true;
}

// ── Haupt-Handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS (wichtig wenn PWA und API auf unterschiedlichen Domains laufen)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  // OpenAI-Key prüfen
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API-Key fehlt.' });

  // Authorization-Header auslesen
  const authHeader = req.headers['authorization'] || '';
  const licenseKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  // Modus bestimmen
  const isMasterKey   = licenseKey === process.env.SECRET_MASTER_KEY;
  const isFreeTrial   = !licenseKey || licenseKey === 'FREE_TRIAL';
  const isPaidLicense = !isMasterKey && !isFreeTrial;

  console.log(`[API START] Key: "${licenseKey}" | Master: ${isMasterKey} | FreeTrial: ${isFreeTrial}`);

  // Rückgabewerte für die Response
  let usageCurrent   = null; // Free-Trial: aktueller IP-Zählerstand
  let remainingScans = null; // Lizenz: verbleibende Scans (nach DECR)

  try {

    // ════════════════════════════════════════════════════════════════
    // A) FREE TRIAL – IP-basiertes Throttling via Redis INCR
    // ════════════════════════════════════════════════════════════════
    if (isFreeTrial) {
      const ip       = getClientIp(req);
      const redisKey = `free_trial_ip:${ip}`;
      const count    = await redisIncr(redisKey);

      console.log(`[FREE TRIAL] IP: ${ip} | Zähler: ${count}/${FREE_TRIAL_LIMIT}`);

      if (count > FREE_TRIAL_LIMIT) {
        return res.status(429).json({ error: 'LIMIT_REACHED' });
      }
      usageCurrent = count;
    }

    // ════════════════════════════════════════════════════════════════
    // B) PAID LICENSE – Lemon Squeezy + KV Scan-Konto
    // ════════════════════════════════════════════════════════════════
    if (isPaidLicense) {
      const kvUrl   = process.env.KV_REST_API_URL;
      const kvToken = process.env.KV_REST_API_TOKEN;
      if (!kvUrl || !kvToken) {
        return res.status(500).json({ error: 'Datenbank-Konfigurationsfehler.' });
      }

      // KV-Eintrag lesen
      const raw     = await kvGet(`license:${licenseKey}`);
      let scansLeft = raw !== null ? parseInt(raw, 10) : null;

      console.log(`[KV GET] Scans für "${licenseKey}": ${scansLeft}`);

      // Noch nicht bekannt → Lemon Squeezy validieren und 200 Scans anlegen
      if (scansLeft === null || isNaN(scansLeft)) {
        console.log(`[LEMON SQUEEZY] Validiere Key: "${licenseKey}"...`);
        const valid = await validateLemonSqueezy(licenseKey);

        if (!valid) {
          console.warn(`[BLOCKIERT] Ungültiger Key: "${licenseKey}"`);
          return res.status(403).json({ error: 'Ungültiger oder abgelaufener Lizenzschlüssel.' });
        }

        scansLeft = 200;
        await kvSet(`license:${licenseKey}`, scansLeft);
        console.log(`[KV SET] 200 Scans für "${licenseKey}" angelegt.`);
      }

      // Keine Scans mehr
      if (scansLeft <= 0) {
        console.warn(`[BLOCKIERT] Keine Scans mehr für "${licenseKey}"`);
        return res.status(402).json({ error: 'Deine Scans sind aufgebraucht.' });
      }
    }

    // ── Bild aus Request-Body holen ────────────────────────────────
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Kein Bild übermittelt.' });
    }
    const base64Data = image.includes(',') ? image.split(',')[1] : image;

    // ── OpenAI Vision aufrufen ─────────────────────────────────────
    console.log(`[OPENAI] Sende Bild für Key: "${licenseKey}"...`);

    const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      'gpt-4o-mini',
        max_tokens: 2048,
        response_format: { type: 'json_object' }, // <-- HIER IST DIE MAGIE
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type:      'image_url',
                image_url: { url: `data:image/jpeg;base64,${base64Data}`, detail: 'high' },
              },
              // <-- User Message angepasst, damit kein Konflikt entsteht
              { type: 'text', text: 'Extrahiere die wichtigsten Konzepte oder Vokabelpaare aus diesem Bild und antworte im geforderten JSON-Format.' },
            ],
          },
        ],
      }),
    });

    if (!openAIResponse.ok) {
      return res.status(502).json({ error: `OpenAI API Fehler: ${openAIResponse.status}` });
    }

    const openAIData = await openAIResponse.json();
    const rawContent = openAIData.choices?.[0]?.message?.content || '{}';

    // ── JSON parsen (Kein Regex-Cleaning mehr nötig!) ────────────────
    let pairs;
    try {
      const parsedData = JSON.parse(rawContent);
      pairs = parsedData.flashcards; // <-- Zugriff auf das Array im Objekt
      
      if (!Array.isArray(pairs)) {
        throw new Error('Fehlendes Array im "flashcards" Schlüssel');
      }
    } catch (parseError) {
      console.error('[PARSE ERROR]', parseError, 'Raw Content:', rawContent);
      return res.status(422).json({ error: 'Ungültiges JSON vom AI-Modell.', raw: rawContent });
    }

    // ── Scan abziehen (nur bei echten Lizenz-Keys) ─────────────────
    if (isPaidLicense) {
      remainingScans = await kvDecr(`license:${licenseKey}`);
      console.log(`[KV DECR] Verbleibende Scans für "${licenseKey}": ${remainingScans}`);
    }

    // ── Erfolg-Response ────────────────────────────────────────────
    console.log(`[API SUCCESS] Erfolg für Key: "${licenseKey}"`);

    const responsePayload = { pairs };

    // Free-Trial: Frontend bekommt echten IP-Zählerstand zum Synchronisieren
    if (usageCurrent !== null) {
      responsePayload.usage = { current: usageCurrent, limit: FREE_TRIAL_LIMIT };
    }

    // Lizenz: verbleibende Scans mitschicken
    if (remainingScans !== null) {
      responsePayload.remaining_scans = remainingScans;
    }

    return res.status(200).json(responsePayload);

  } catch (err) {
    console.error('[FATAL ERROR]', err);
    return res.status(500).json({ error: 'Interner Serverfehler.' });
  }
}
