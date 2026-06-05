// /api/scan.js  –  Vercel Serverless Function (Node.js)
// BYPASS-MODUS AKTIV: Lizenzprüfung ist temporär ausgesetzt.
// Empfängt ein Base64-Bild, ruft OpenAI gpt-4o-mini auf 
// und gibt ein JSON-Array mit Vokabelpaaren zurück.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb', // Max. Bildgröße nach Komprimierung
    },
  },
};

export default async function handler(req, res) {
  // ── CORS-Header (wichtig für lokale Entwicklung) ──────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── API-Key aus Umgebungsvariable ─────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY ist nicht gesetzt!');
    return res.status(500).json({ error: 'Server-Konfigurationsfehler: API-Key fehlt.' });
  }

  try {
    // ── BYPASS AKTIVIERT: LIZENZPRÜFUNG TEMPORÄR AUSGESETZT ────────────
    // Wir ignorieren Upstash und Lemon Squeezy hier komplett.

    // ── 3. REQUEST-BODY LESEN (BILD) ──────────────────────────────────
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Kein Bild übermittelt.' });
    }
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

    // ── 4. OPENAI API-AUFRUF ──────────────────────────────────────────
    const systemPrompt =
      'Du bist ein Daten-Extraktor. Analysiere das Bild dieser Vokabelseite. ' +
      'Ignoriere Trennlinien, Seitenzahlen und Lautschrift in Klammern. ' +
      'Extrahiere die Wortpaare. Die Sprache kann variieren (oft Englisch/Deutsch, ' +
      'Spanisch/Deutsch, Jura-Begriffe etc.). Erkenne die Sprachen logisch. ' +
      'Gib das Ergebnis AUSSCHLIESSLICH als gültiges JSON-Array zurück. ' +
      'Format: [{"front": "apple", "back": "Apfel"}, ...]. ' +
      'Kein erklärender Text, keine Markdown-Blöcke, nur das reine JSON-Array.';

    const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Data}`,
                  detail: 'high',
                },
              },
              { type: 'text', text: 'Extrahiere alle Vokabelpaare aus diesem Bild als JSON-Array.' },
            ],
          },
        ],
      }),
    });

    if (!openAIResponse.ok) {
      const errorBody = await openAIResponse.text();
      console.error('OpenAI API Fehler:', openAIResponse.status, errorBody);
      return res.status(502).json({ error: `OpenAI API Fehler: ${openAIResponse.status}` });
    }

    const openAIData = await openAIResponse.json();
    const rawContent = openAIData.choices?.[0]?.message?.content || '[]';

    // JSON parsen
    const cleaned = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let vocabPairs;
    try {
      vocabPairs = JSON.parse(cleaned);
      if (!Array.isArray(vocabPairs)) throw new Error('Keine Array-Antwort');
    } catch (parseErr) {
      console.error('JSON-Parse-Fehler:', parseErr, 'Raw:', rawContent);
      return res.status(422).json({ error: 'Die KI hat kein gültiges JSON zurückgegeben.', raw: rawContent });
    }

    // ── 6. ERFOLG: ANTWORT ANS FRONTEND ───────────────────────────────
    // Im Bypass-Modus geben wir einfach einen Dummy-Wert für remaining_scans zurück
    return res.status(200).json({ 
      pairs: vocabPairs,
      remaining_scans: "Bypass Mode" 
    });

  } catch (err) {
    console.error('Unerwarteter Fehler:', err);
    return res.status(500).json({ error: 'Interner Serverfehler.' });
  }
}
