module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { account, contact, dynamicNotes } = req.body;

  try {
    // ── Step 1: Contesto e notizie (senza web search) ──────────────────────
    const newsResponse = await callAnthropic({
      model: 'claude-haiku-4-5-20251001',
      system: 'Sei un esperto di customer engagement e CRM nel mercato italiano. Rispondi SOLO con JSON valido, zero testo extra.',
      prompt: `Basandoti sulle tue conoscenze, fornisci contesto rilevante per un outbound sales su Braze per questa azienda.

Azienda: ${account.name} (${account.website})
Settore: ${account.industry}
Note interne: ${account.notes || 'nessuna'}
Note dinamiche: ${dynamicNotes || 'nessuna'}

Fornisci:
1. Sfide tipiche di customer engagement per questo settore in Italia
2. Un hook specifico basato su quello che sai dell'azienda o del settore
3. Il pain point operativo più probabile legato a CRM/retention/engagement

Rispondi con:
{
  "hook": "fatto o osservazione specifica sull'azienda o settore da usare come apertura — concreto",
  "sector_challenge": "sfida principale di customer engagement tipica di questo settore",
  "pain_point": "pain point operativo specifico che probabilmente stanno affrontando"
}`
    });

    const news = safeJSON(newsResponse.text);
    const newsCost = newsResponse.cost;

    // ── Step 2: Analisi profilo contatto ───────────────────────────────────
    const hasProfile = contact.linkedinText && contact.linkedinText.trim().length > 20;

    let profile = {
      useLei: false,
      years_experience: null,
      relevant_experience: '',
      personal_hook: ''
    };
    let profileCost = 0;

    if (hasProfile) {
      const profileResponse = await callAnthropic({
        model: 'claude-haiku-4-5-20251001',
        system: 'Sei un esperto di sales intelligence. Rispondi SOLO con JSON valido, zero testo extra.',
        prompt: `Analizza questo profilo LinkedIn per un outbound B2B.

Nome: ${contact.name}
Ruolo: ${contact.title}
Azienda: ${account.name}

PROFILO:
${contact.linkedinText}

Rispondi con:
{
  "years_experience": 12,
  "use_lei": false,
  "relevant_experience": "sintesi esperienze rilevanti per CRM/engagement",
  "personal_hook": "elemento specifico del profilo da usare nell'hook"
}`
      });

      profile = safeJSON(profileResponse.text);
      profile.useLei = profile.use_lei || (profile.years_experience >= 15);
      profileCost = profileResponse.cost;
    }

    // ── Step 3: Sequenza 2 email ────────────────────────────────────────────
    const competitor = account.competitor || null;
    const competitorBlock = competitor
      ? `\nCOMPETITOR: l'azienda usa già ${competitor}. Nella email 1 non menzionarlo. Nella email 2 fai leva sulle sue limitazioni strutturali senza attaccarlo direttamente.`
      : '';

    const formalityNote = profile.useLei
      ? 'USA IL "LEI" formale — questo contatto ha 15+ anni di esperienza.'
      : 'Usa il "tu" — tono diretto e professionale.';

    const profileContext = hasProfile
      ? `\nPROFILO CONTATTO:\n- Esperienza rilevante: ${profile.relevant_experience || 'non disponibile'}\n- Hook personale: ${profile.personal_hook || 'non disponibile'}`
      : '';

    const emailResponse = await callAnthropic({
      model: 'claude-sonnet-4-5',
      system: `Sei un BDR di Braze (www.braze.com) specializzato in outbound B2B per il mercato italiano. Braze è una Customer Engagement Platform che permette ai brand di orchestrare comunicazioni personalizzate cross-canale (push, email, in-app, SMS, WhatsApp) in real-time basate sul comportamento degli utenti.

${formalityNote}

REGOLE:
- Tono diretto, umano, mai commerciale o entusiasta
- Vietato: "soluzione", "piattaforma leader", "innovativo", "best-in-class", "sinergie"
- Non iniziare MAI con "Mi chiamo" o "Lavoro per"
- Corpo email max 120-140 parole
- Le due email devono essere coerenti — la email 2 fa riferimento alla email 1${competitorBlock}`,

      prompt: `Scrivi una sequenza di 2 email outbound per:

DESTINATARIO: ${contact.name}, ${contact.title} @ ${account.name}
SETTORE: ${account.industry}
NOTE ACCOUNT: ${account.notes || 'nessuna'}
NOTE DINAMICHE: ${dynamicNotes || 'nessuna'}

CONTESTO:
- Hook: ${news.hook || 'considera il settore'}
- Pain point: ${news.pain_point || news.sector_challenge || 'engagement e retention digitale'}
${profileContext}

---

EMAIL 1 — obiettivo: incuriosire, agganciare verso la email 2. NON rivelare la soluzione.

Struttura (4 paragrafi):
1. HOOK PERSONALIZZATO: basato su ruolo, azienda, insights. Dimostra ricerca fatta.
2. PAIN POINT SETTORIALE: problema ricorrente nel settore che probabilmente affronta.
3. TEASER BRAZE: UNA SOLA frase che indica che Braze può aiutare, senza spiegare come.
4. CTA SOFT: no appuntamento. Es: "Questo risuona con le vostre priorità attuali?" o "Fa parte della vostra roadmap per quest'anno?"

---

EMAIL 2 — obiettivo: concretizzare. Fa riferimento alla email 1.

Struttura (4 paragrafi):
1. AGGANCIO EMAIL 1: riferimento naturale alla precedente in una frase.
2. SOLUZIONE BRAZE: come Braze risolve il pain point della email 1. Specifico: approccio, differenziatore, caso d'uso.
3. PROVA SOCIALE: cliente simile, dato di settore, o risultato misurabile con Braze.
4. CTA DIRETTO: proponi incontro in modo leggero. Es: "Avrebbe senso confrontarci 20 minuti?" o "Le va se le mando qualche materiale su come lo facciamo?"

---

Formato output ESATTO:

EMAIL_1_OGGETTO: [max 8 parole, no punti interrogativi]
EMAIL_1_BODY:
[corpo email 1]
---EMAIL_2---
EMAIL_2_OGGETTO: [max 8 parole, no punti interrogativi]
EMAIL_2_BODY:
[corpo email 2]`
    });

    const emailCost = emailResponse.cost;
    const totalCost = newsCost + profileCost + emailCost;

    // Parse output
    const raw = emailResponse.text;
    const e1ObjMatch = raw.match(/EMAIL_1_OGGETTO:\s*(.+)/);
    const e1BodyMatch = raw.match(/EMAIL_1_BODY:\n([\s\S]+?)---EMAIL_2---/);
    const e2ObjMatch = raw.match(/EMAIL_2_OGGETTO:\s*(.+)/);
    const e2BodyMatch = raw.match(/EMAIL_2_BODY:\n([\s\S]+)$/);

    res.json({
      email1: {
        subject: e1ObjMatch ? e1ObjMatch[1].trim() : '',
        body: e1BodyMatch ? e1BodyMatch[1].trim() : ''
      },
      email2: {
        subject: e2ObjMatch ? e2ObjMatch[1].trim() : '',
        body: e2BodyMatch ? e2BodyMatch[1].trim() : ''
      },
      context: {
        hook: news.hook || '',
        pain_point: news.pain_point || news.sector_challenge || '',
        use_lei: profile.useLei || false,
        years_exp: profile.years_experience || null,
        personal_hook: profile.personal_hook || null
      },
      cost: totalCost
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

async function callAnthropic({ model, system, prompt }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic error: ${err}`);
  }

  const data = await response.json();
  const text = data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
  const cost = ((data.usage?.input_tokens || 0) * 3 + (data.usage?.output_tokens || 0) * 15) / 1_000_000;

  return { text, cost };
}

function safeJSON(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return {};
  }
}
