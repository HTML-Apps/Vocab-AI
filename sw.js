// /api/scan.js  –  Vercel Serverless Function (Node.js)
// LIVE-MODUS (mit Master-Key-Ausnahme für Entwickler)

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API-Key fehlt.' });

  // ── 1. LIZENZSCHLÜSSEL PRÜFEN ────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Lizenzschlüssel fehlt. Bitte in den Einstellungen eingeben.' });
  }
  const licenseKey = authHeader.split(' ')[1].trim();

  // ── 1.5 DIE MASTER-KEY WHITELIST (DEIN BYPASS) ────────────────────────
  // Füge hier die Schlüssel für dich und deine Geschwister ein
  const masterKeys = ['H-TEST', 'E-TEST', 'M-TEST', 'J-TEST'];
  const isMasterKey = masterKeys.includes(licenseKey);

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  try {
    let scansLeft = "Unlimited"; // Standard für Master-Keys

    // Nur reguläre Schlüssel über Lemon Squeezy / Upstash prüfen
    if (!isMasterKey) {
      if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Datenbank-Konfigurationsfehler.' });

      // A: In Upstash (Redis) nachschauen
      const getRes = await fetch(`${kvUrl}/get/license:${licenseKey}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const getData = await getRes.json();
      scansLeft = getData.result !== null ? parseInt(getData.result, 10) : null;

      // B: Wenn neu -> Lemon Squeezy Validierung
      if (scansLeft === null) {
        const lsResponse = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ license_key: licenseKey })
        });
        
        const lsData = await lsResponse.json();
        if (!lsData.valid) {
          return res.status(403).json({ error: 'Ungültiger oder abgelaufener Lizenzschlüssel.' });
        }

        // Gültig! 200 Scans in Upstash speichern
        scansLeft = 200;
        await fetch(`${kvUrl}/set/license:${licenseKey}/${scansLeft}`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
      }

      // C: Prüfen ob Scans übrig sind
      if (scansLeft <= 0) {
        return res.status(402).json({ error: 'Deine 200 Scans sind aufgebraucht.' });
      }
    }

    // ── 3. REQUEST-BODY LESEN (BILD) ──────────────────────────────────
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Kein Bild übermittelt.' });
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

    // ── 4. OPENAI API-AUFRUF ──────────────────────────────────────────
    // (Dein bestehender OpenAI Code hier)
    const systemPrompt = 'Du bist ein Daten-Extraktor. Analysiere das Bild... (Dein Prompt)'; // Kürze halber zusammengefasst
    
    // ... [Hier fügst du deinen OpenAI Fetch-Call aus der alten Datei exakt so wieder ein] ...
    const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
       // ...
    });
    
    if (!openAIResponse.ok) return res.status(502).json({ error: `OpenAI API Fehler: ${openAIResponse.status}` });
    const openAIData = await openAIResponse.json();
    const rawContent = openAIData.choices?.[0]?.message?.content || '[]';
    
    const cleaned = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let vocabPairs;
    try {
      vocabPairs = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(422).json({ error: 'Ungültiges JSON.', raw: rawContent });
    }

    // ── 5. SCAN ABZIEHEN (NUR FÜR NORMALE USER) ─────────────
    if (!isMasterKey) {
      const decrRes = await fetch(`${kvUrl}/decr/license:${licenseKey}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const decrData = await decrRes.json();
      scansLeft = decrData.result; 
    }

    // ── 6. ANTWORT ANS FRONTEND ───────────────────────────────
    return res.status(200).json({ 
      pairs: vocabPairs,
      remaining_scans: scansLeft 
    });

  } catch (err) {
    console.error('Fehler:', err);
    return res.status(500).json({ error: 'Interner Serverfehler.' });
  }
}
