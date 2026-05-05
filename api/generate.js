module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { account, contact, dynamicNotes } = req.body;

  try {
    // ── Step 1: Notizie rilevanti con web search ────────────────────────────
    const newsResponse = await callAnthropic({ model: 'claude-sonnet-4-5',
      system: 'Sei un ricercatore specializzato in customer experience e marketing digitale. Rispondi SOLO con JSON valido, zero testo extra.',
      prompt: `Cerca notizie e informazioni recenti su ${account.name} (${account.website}) focalizzandoti su:
- Strategie di customer experience, CX, customer engagement
- Iniziative CRM, marketing automation, omnicanalità
- Lanci di app, programmi loyalty, digital transformation
- Customer centricity, personalizzazione, retention
- Qualsiasi notizia rilevante degli ultimi 6-12 mesi

Settore: ${account.industry}
Note interne: ${account.notes || 'nessuna'}
Note dinamiche: ${dynamicNotes || 'nessuna'}

Rispondi con:
{
  "headline_news": "notizia più rilevante trovata (1-2 frasi, concreta)",
  "cx_initiative": "iniziativa CX/CRM/engagement specifica se trovata",
  "sector_challenge": "sfida principale di customer engagement tipica di questo settore",
  "hook": "il fatto più specifico e recente da usare come apertura — deve essere concreto, non generico. Se non trovi notizie recenti, usa una sfida settoriale specifica",
  "pain_point": "pain point operativo specifico che probabilmente stanno affrontando legato a engagement/CRM/retention"
}`,
      useWebSearch: true
    });

    const news = safeJSON(newsResponse.text);
    const newsCost = newsResponse.cost;

    // ── Step 2: Analisi profilo contatto ───────────────────────────────────
    const hasProfile = contact.linkedinText && contact.linkedinText.trim().length > 20;

    let profile = {
      seniority: 'unknown',
      useLei: false,
      relevantExperience: '',
      recentActivity: '',
      personalHook: ''
    };
    let profileCost = 0;

    if (hasProfile) {
      const profileResponse = await callAnthropic({ model: 'claude-sonnet-4-5',
        system: 'Sei un esperto di sales intelligence. Rispondi SOLO con JSON valido, zero testo extra.',
        prompt: `Analizza questo profilo LinkedIn e estrai le informazioni rilevanti per un outbound sales B2B.

Nome: ${contact.name}
Ruolo attuale: ${contact.title}
Azienda: ${account.name}

TESTO PROFILO:
${contact.linkedinText}

Estrai:
1. Anni di esperienza totali (stima dalla carriera)
2. Se ha 15+ anni di esperienza professionale complessiva → usare il "Lei" formale
3. Esperienze più rilevanti per il tema customer engagement / CRM / marketing digitale
4. Post o attività recenti rilevanti (se presenti nel testo)
5. Un elemento personale del profilo che potrei usare per personalizzare l'apertura dell'email

Rispondi con:
{
  "years_experience": 12,
  "use_lei": false,
  "relevant_experience": "breve sintesi delle esperienze più rilevanti per CRM/engagement",
  "recent_activity": "post o attività recente rilevante se trovata, altrimenti null",
  "personal_hook": "elemento specifico del profilo da usare nell'hook (es. ha guidato il replatforming CRM in azienda X, ha scritto di omnicanalità, ecc.)"
}`,
        useWebSearch: false
      });

      profile = safeJSON(profileResponse.text);
      profile.useLei = profile.use_lei || profile.years_experience >= 15;
      profileCost = profileResponse.cost;
    }

    // ── Step 3: Sequenza 2 email ────────────────────────────────────────────
    const competitor = account.competitor || null;
    const competitorBlock = competitor
      ? `\nCONTESTO COMPETITOR: l'azienda usa già ${competitor}. Non menzionarlo esplicitamente nella email 1. Nella email 2 puoi fare leva sulle limitazioni strutturali di ${competitor} senza attaccarlo direttamente.`
      : '';

    const formalityNote = profile.useLei
      ? 'USA IL "LEI" formale per tutto — questo contatto ha seniority elevata (15+ anni di esperienza).'
      : 'Usa il "tu" — tono diretto e professionale.';

    const profileContext = hasProfile
      ? `
PROFILO CONTATTO:
- Esperienza rilevante: ${profile.relevant_experience || 'non disponibile'}
- Attività recente: ${profile.recent_activity || 'nessuna trovata'}
- Hook personale: ${profile.personal_hook || 'non disponibile'}`
      : '';

    const emailResponse = await callAnthropic({ model: 'claude-sonnet-4-5-20250514',
      system: `Sei un BDR di Braze (www.braze.com) specializzato in outbound B2B per il mercato italiano. Braze è una Customer Engagement Platform (CEP) che permette ai brand di orchestrare comunicazioni personalizzate cross-canale (push, email, in-app, SMS, WhatsApp) in real-time basate sul comportamento degli utenti.

${formalityNote}

REGOLE GENERALI:
- Tono: diretto, umano, mai commerciale o entusiasta
- Vietato: "soluzione", "piattaforma leader", "innovativo", "best-in-class", "sinergie"
- Non iniziare MAI con "Mi chiamo" o "Lavoro per"
- Ogni email max 120-140 parole nel corpo
- Le due email devono essere coerenti tra loro — la email 2 fa riferimento alla email 1${competitorBlock}`,

      prompt: `Scrivi una sequenza di 2 email outbound per:

DESTINATARIO: ${contact.name}, ${contact.title} @ ${account.name}
SETTORE: ${account.industry}
SITO: ${account.website}
NOTE ACCOUNT: ${account.notes || 'nessuna'}
NOTE DINAMICHE: ${dynamicNotes || 'nessuna'}

CONTESTO MERCATO:
- Notizia/hook principale: ${news.hook || news.headline_news || 'considera il settore'}
- Iniziativa CX/CRM: ${news.cx_initiative || 'non disponibile'}
- Pain point settoriale: ${news.pain_point || news.sector_challenge || 'engagement e retention digitale'}
${profileContext}

---

EMAIL 1 — obiettivo: incuriosire, agganciare verso la email 2. NON rivelare la soluzione.

Struttura obbligatoria (4 paragrafi):
1. HOOK PERSONALIZZATO: basato sul ruolo, attività azienda, insights forniti. Dimostra che hai fatto ricerca.
2. PAIN POINT SETTORIALE: problema ricorrente nel settore che probabilmente sta affrontando.
3. TEASER BRAZE: UNA SOLA frase che indica che Braze può aiutare, senza spiegare come. Il "come" è nella email 2.
4. CTA SOFT: nessuna richiesta di appuntamento. Es: "Questo risuona con le vostre priorità attuali?" oppure "Fa parte della vostra roadmap per quest'anno?"

---

EMAIL 2 — obiettivo: concretizzare. Fa riferimento alla email 1.

Struttura obbligatoria (4 paragrafi):
1. AGGANCIO EMAIL 1: riferimento naturale alla precedente, ricrea il contesto in una frase.
2. SOLUZIONE BRAZE: spiega concretamente come Braze risolve il pain point della email 1. Sii specifico: approccio, differenziatore, caso d'uso se pertinente.
3. PROVA SOCIALE: una frase di credibilità — cliente simile, dato di settore, o risultato misurabile con Braze.
4. CTA DIRETTO: proponi un incontro in modo leggero. Es: "Avrebbe senso confrontarci 20 minuti su questo?" oppure "Le va se le mando qualche materiale su come lo facciamo concretamente?"

---

Formato output ESATTO (rispetta i separatori):

EMAIL_1_OGGETTO: [oggetto — max 8 parole, no punti interrogativi]
EMAIL_1_BODY:
[corpo email 1]
---EMAIL_2---
EMAIL_2_OGGETTO: [oggetto — max 8 parole, no punti interrogativi]
EMAIL_2_BODY:
[corpo email 2]`,
      useWebSearch: false
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
        hook: news.hook || news.headline_news || '',
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callAnthropic({ system, prompt, useWebSearch = false, model = 'claude-haiku-4-5-20251001' }) {
  const body = {
    model: model,
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: prompt }]
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${err}`);
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
