export default {
  // 1. DE UURLIJKSE CRON JOB (Automatisch)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.processHourlySync(env));
  },

  // De kernlogica voor het ophalen en doorsturen
  async processHourlySync(env) {
    try {
      // 0. Check of de secrets bestaan
      if (!env.THISWORKZ_CLIENT_ID || !env.THISWORKZ_CLIENT_SECRET) {
         throw new Error("Cloudflare Secrets missen! Stel THISWORKZ_CLIENT_ID en THISWORKZ_CLIENT_SECRET in.");
      }

      // 1A. Token Ophalen bij ThisWorkz
      const tokenUrl = 'https://lemur-2.cloud-iam.com/auth/realms/thisworkz/protocol/openid-connect/token';
      const tokenParams = new URLSearchParams();
      tokenParams.append('grant_type', 'client_credentials');
      tokenParams.append('client_id', env.THISWORKZ_CLIENT_ID);
      tokenParams.append('client_secret', env.THISWORKZ_CLIENT_SECRET);

      const tokenRes = await fetch(tokenUrl, { method: 'POST', body: tokenParams });
      if (!tokenRes.ok) {
        throw new Error(`Token fout (HTTP ${tokenRes.status}): ${await tokenRes.text()}`);
      }
      
      const tokenData = await tokenRes.json();
      const token = tokenData.access_token;

      // 1B. Opportunities Ophalen (met anti-cache en User-Agent)
      const timestamp = new Date().getTime(); // Voorkomt dat Cloudflare het antwoord onthoudt
      const opsUrl = `https://matching.thisworkz.online/api/opportunities?page=0&size=50&status=NEW&sort=deadlineDate%2Cdesc&_nocache=${timestamp}`;
      
      const opsRes = await fetch(opsUrl, {
        headers: { 
          'Authorization': `Bearer ${token}`, 
          'Accept': 'application/json',
          'User-Agent': 'CloudShapers-Integration/1.0'
        },
        cf: { cacheTtl: 0 } // Vertel Cloudflare specifiek om dit niet te cachen
      });
      
      if (!opsRes.ok) {
        throw new Error(`Data fout (HTTP ${opsRes.status}): ${await opsRes.text()}`);
      }

      const opsData = await opsRes.json();
      
      // 1C. HET PROBLEEM IS HIER OPGEGOST: Data zit in 'items', niet in 'content'
      let items = [];
      if (opsData && Array.isArray(opsData.items)) {
          items = opsData.items;     // <-- Hier zat de data!
      } else if (opsData && Array.isArray(opsData.content)) {
          items = opsData.content;   // Fallback voor de zekerheid
      } else if (Array.isArray(opsData)) {
          items = opsData;
      }

      // Als we écht 0 items hebben, breek dan af
      if (items.length === 0) {
          return { success: true, api_count: 0, sent_count: 0, raw_data: opsData };
      }

      // 1D. Opslaan in D1 database (Nieuwe toevoegen, bestaande negeren op basis van ID)
      const insertOp = env.DB.prepare(`
        INSERT OR IGNORE INTO opportunities (id, title, description, source, location, deadline)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const desc = item.description || "Geen beschrijving"; 
        const loc = item.location || null; 
        await insertOp.bind(item.remoteId, item.title, desc, item.source, loc, item.deadlineDate).run();
      }

      // 1E. Selecteer items die nog NIET naar Make.com zijn gestuurd (max 10 per keer om timeouts te voorkomen)
      const pendingQuery = await env.DB.prepare(`SELECT * FROM opportunities WHERE processed_for_ai = 0 LIMIT 10`).all();
      let sentCount = 0;

      if (pendingQuery.results && pendingQuery.results.length > 0) {
        for (const pending of pendingQuery.results) {
          // Stuur naar de Make.com Webhook
          const makeRes = await fetch(env.MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pending)
          });
          
          // Markeer in de database als verzonden als Make.com succesvol (HTTP 200) antwoordt
          if (makeRes.ok) {
            await env.DB.prepare(`UPDATE opportunities SET processed_for_ai = 1 WHERE id = ?`).bind(pending.id).run();
            sentCount++;
          }
        }
      }
      
      return { success: true, api_count: items.length, sent_count: sentCount };
    } catch (error) {
      console.error("Fout tijdens sync:", error);
      return { success: false, error: error.message };
    }
  },

  // 2. DE HTTP API (Voor Frontend, Make.com én handmatig testen)
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // --- TEST ROUTES ---
    if (request.method === 'GET' && url.pathname === '/api/reset-test') {
      await env.DB.prepare(`UPDATE opportunities SET processed_for_ai = 0`).run();
      return new Response("Alles gereset! Alle database items staan weer klaar om naar Make.com gestuurd te worden. Ga naar /api/force-sync om te testen.", { headers: corsHeaders });
    }

    if (request.method === 'GET' && url.pathname === '/api/force-sync') {
      const result = await this.processHourlySync(env);
      if (result.success) {
        let msg = `DIAGNOSE RAPPORT:\n----------------\n1. Vacatures gevonden via API: ${result.api_count}\n2. Succesvol naar Make.com gestuurd: ${result.sent_count}\n`;
        
        if (result.api_count === 0 && result.raw_data) {
            msg += `\nLET OP: Er zijn 0 items gevonden. Dit is de exacte (ruwe) data die de ThisWorkz server teruggaf:\n`;
            msg += JSON.stringify(result.raw_data, null, 2);
        }
        return new Response(msg, { headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
      } else {
        return new Response(`Fout bij sync: ${result.error}`, { status: 500, headers: corsHeaders });
      }
    }

    // --- FRONTEND ROUTE: HAAL DASHBOARD DATA OP ---
    if (request.method === 'GET' && url.pathname === '/api/opportunities') {
      const query = `
        SELECT o.id, o.title as rol, o.location as locatie, o.deadline, o.datum, o.source as api_source,
               a.is_relevant, a.match_status, a.klant, a.eindklant, a.broker, a.contactpersoon, 
               a.contact_email, a.contact_telefoon, a.tarief, a.uren, a.startdatum, a.samenvatting, a.kandidaten_json
        FROM opportunities o
        INNER JOIN assessments a ON o.id = a.opportunity_id
        ORDER BY o.datum DESC
      `;
      const { results } = await env.DB.prepare(query).all();
      return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // --- MAKE.COM ROUTE: ONTVANG DATA TERUG VAN CLAUDE ---
    if (request.method === 'POST' && url.pathname === '/api/save-assessment') {
      try {
        const body = await request.json();
        const insertAss = env.DB.prepare(`
          INSERT OR REPLACE INTO assessments 
          (opportunity_id, is_relevant, match_status, klant, eindklant, broker, contactpersoon, contact_email, contact_telefoon, tarief, uren, startdatum, samenvatting, kandidaten_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        await insertAss.bind(
          body.opportunity_id, 
          body.relevant ? 1 : 0, 
          body.match, 
          body.klant, 
          body.eindklant, 
          body.broker, 
          body.contactpersoon,
          body.contact_email, 
          body.contact_telefoon, 
          body.tarief, 
          body.uren, 
          body.startdatum, 
          body.samenvatting, 
          JSON.stringify(body.kandidaten)
        ).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      }
    }

    // --- FRONTEND ROUTE: VERWIJDER ITEM ---
    if (request.method === 'DELETE' && url.pathname === '/api/opportunities') {
      const id = url.searchParams.get('id');
      await env.DB.prepare(`DELETE FROM assessments WHERE opportunity_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM opportunities WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ deleted: true }), { headers: corsHeaders });
    }

    return new Response('API Endpoint niet gevonden', { status: 404, headers: corsHeaders });
  }
};
