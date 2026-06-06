// /api/scan.js  –  Vercel Serverless Function (Node.js)
// STRICT LIVE-MODUS (mit Master-Key-Ausnahme)

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

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Lizenzschlüssel fehlt im Header.' });
  }
  const licenseKey = authHeader.split(' ')[1].trim();

  // ── 1.5 DIE MASTER-KEY WHITELIST (SICHER ÜBER VERCEL) ──────────
  const isMasterKey = (licenseKey === process.env.SECRET_MASTER_KEY);

  console.log(`[API START] Key empfangen: "${licenseKey}". Ist Master-Key? ${isMasterKey}`);

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  try {
    let scansLeft = "Unlimited (Master Key)"; 

    if (!isMasterKey) {
      if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Datenbank-Konfigurationsfehler.' });

      // A: In Upstash (Redis) nachschauen
      const getRes = await fetch(`${kvUrl}/get/license:${licenseKey}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const getData = await getRes.json();
      scansLeft = getData.result !== null ? parseInt(getData.result, 10) : null;
      
      console.log(`[UPSTASH GET] Scans für "${licenseKey}": ${scansLeft}`);

      // B: Wenn neu (null) oder kaputt (NaN) -> Lemon Squeezy Validierung ERZWINGEN
      if (scansLeft === null || isNaN(scansLeft)) {
        console.log(`[LEMON SQUEEZY] Validiere neuen Key: "${licenseKey}"...`);
        
        const lsResponse = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ license_key: licenseKey })
        });
        
        const lsData = await lsResponse.json();
        console.log(`[LEMON SQUEEZY] Antwort für "${licenseKey}": Valid = ${lsData.valid}`);
        
        // HARTE BLOCKADE: Wenn nicht valid, sofort abbrechen!
        if (lsData.valid !== true) {
           console.warn(`[BLOCKIERT] Ungültiger Key: "${licenseKey}"`);
           return res.status(403).json({ error: 'Ungültiger oder abgelaufener Lizenzschlüssel.' });
        }

        // Gültig! 200 Scans speichern
        scansLeft = 200;
        await fetch(`${kvUrl}/set/license:${licenseKey}/${scansLeft}`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
        console.log(`[UPSTASH SET] 200 Scans für "${licenseKey}" gespeichert.`);
      }

      // C: Prüfen ob noch Scans übrig sind (und ob es überhaupt eine Zahl ist)
      if (typeof scansLeft !== 'number' || scansLeft <= 0) {
        console.warn(`[BLOCKIERT] Keine Scans mehr für "${licenseKey}"`);
        return res.status(402).json({ error: 'Deine Scans sind aufgebraucht.' });
      }
    }

    // --- BILD VERARBEITEN ---
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Kein Bild übermittelt.' });
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

    // --- OPENAI AUFRUFEN ---
    console.log(`[OPENAI] Sende Bild an OpenAI für Key: "${licenseKey}"...`);
    const systemPrompt = 'Du bist ein Daten-Extraktor. Analysiere das Bild dieser Vokabelseite. Ignoriere Trennlinien, Seitenzahlen und Lautschrift in Klammern. Extrahiere die Wortpaare. Die Sprache kann variieren (oft Englisch/Deutsch, Spanisch/Deutsch, Jura-Begriffe etc.). Erkenne die Sprachen logisch. Gib das Ergebnis AUSSCHLIESSLICH als gültiges JSON-Array zurück. Format: [{"front": "apple", "back": "Apfel"}, ...]. Kein erklärender Text, keine Markdown-Blöcke, nur das reine JSON-Array.';
    
    const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}`, detail: 'high' } }, { type: 'text', text: 'Extrahiere alle Vokabelpaare aus diesem Bild als JSON-Array.' }] }
        ],
      }),
    });
    
    if (!openAIResponse.ok) return res.status(502).json({ error: `OpenAI API Fehler: ${openAIResponse.status}` });
    const openAIData = await openAIResponse.json();
    const rawContent = openAIData.choices?.[0]?.message?.content || '[]';
    
    const cleaned = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let vocabPairs;
    try { vocabPairs = JSON.parse(cleaned); if (!Array.isArray(vocabPairs)) throw new Error(); } 
    catch (e) { return res.status(422).json({ error: 'Ungültiges JSON.', raw: rawContent }); }

    // --- SCAN ABZIEHEN ---
    if (!isMasterKey) {
      const decrRes = await fetch(`${kvUrl}/decr/license:${licenseKey}`, { headers: { Authorization: `Bearer ${kvToken}` } });
      const decrData = await decrRes.json();
      scansLeft = decrData.result; 
      console.log(`[UPSTASH DECR] Verbleibende Scans für "${licenseKey}": ${scansLeft}`);
    }

    console.log(`[API SUCCESS] Erfolg für Key: "${licenseKey}"`);
    return res.status(200).json({ pairs: vocabPairs, remaining_scans: scansLeft });

  } catch (err) {
    console.error('[FATAL ERROR]', err);
    return res.status(500).json({ error: 'Interner Serverfehler.' });
  }
}
