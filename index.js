export default {
  // 1. DE UURLIJKSE CRON JOB (Automatisch)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.processHourlySync(env));
  },

  // De kernlogica voor het ophalen en doorsturen
  async processHourlySync(env) {
    try {
      if (!env.THISWORKZ_CLIENT_ID || !env.THISWORKZ_CLIENT_SECRET) {
         throw new Error("Cloudflare Secrets missen! Stel THISWORKZ_CLIENT_ID en THISWORKZ_CLIENT_SECRET in.");
      }

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

      const timestamp = new Date().getTime();
      const opsUrl = `https://matching.thisworkz.online/api/opportunities?page=0&size=50&status=NEW&sort=deadlineDate%2Cdesc&_nocache=${timestamp}`;
      
      const opsRes = await fetch(opsUrl, {
        headers: { 
          'Authorization': `Bearer ${token}`, 
          'Accept': 'application/json',
          'User-Agent': 'CloudShapers-Integration/1.0'
        },
        cf: { cacheTtl: 0 }
      });
      
      if (!opsRes.ok) {
        throw new Error(`Data fout (HTTP ${opsRes.status}): ${await opsRes.text()}`);
      }

      const opsData = await opsRes.json();
      
      let items = [];
      if (opsData && Array.isArray(opsData.items)) {
          items = opsData.items;
      } else if (opsData && Array.isArray(opsData.content)) {
          items = opsData.content;
      } else if (Array.isArray(opsData)) {
          items = opsData;
      }

      if (items.length === 0) {
          return { success: true, api_count: 0, sent_count: 0, raw_data: opsData };
      }

      const insertOp = env.DB.prepare(`
        INSERT OR IGNORE INTO opportunities (id, title, description, source, location, deadline)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const desc = item.description || "Geen beschrijving"; 
        const loc = item.location || null; 
        await insertOp.bind(item.remoteId, item.title, desc, item.source, loc, item.deadlineDate).run();
      }

      const pendingQuery = await env.DB.prepare(`SELECT * FROM opportunities WHERE processed_for_ai = 0 LIMIT 10`).all();
      let sentCount = 0;

      if (pendingQuery.results && pendingQuery.results.length > 0) {
        for (const pending of pendingQuery.results) {
          const makeRes = await fetch(env.MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pending)
          });
          
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

  // 2. DE HTTP API (Beveiligd)
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // CORS Headers: Sta toe dat de frontend (en Make.com) de API mogen bereiken
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // Tip: Maak dit specifieker (bijv. 'https://jouwdashboard.nl') voor productie
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key', // x-api-key toegevoegd voor autorisatie
    };

    // Preflight request voor CORS altijd doorlaten
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // --- BEVEILIGING: API KEY CHECK ---
    // Controleer op een sleutel in de headers OF in de URL parameters
    const providedKey = request.headers.get('x-api-key') || url.searchParams.get('key');
    
    if (!env.API_SECRET) {
       return new Response('Configuratiefout: API_SECRET is niet ingesteld in Cloudflare.', { status: 500, headers: corsHeaders });
    }

    if (providedKey !== env.API_SECRET) {
       return new Response('Toegang geweigerd: Ongeldige of ontbrekende API sleutel.', { status: 401, headers: corsHeaders });
    }
    // ----------------------------------

    // Vanaf hier zijn alleen geautoriseerde verzoeken toegestaan

    // --- TEST ROUTES ---
    if (request.method === 'GET' && url.pathname === '/api/reset-test') {
      await env.DB.prepare(`UPDATE opportunities SET processed_for_ai = 0`).run();
      return new Response("Alles gereset! Alle database items staan weer klaar om naar Make.com gestuurd te worden.", { headers: corsHeaders });
    }

    if (request.method === 'GET' && url.pathname === '/api/force-sync') {
      const result = await this.processHourlySync(env);
      if (result.success) {
        let msg = `DIAGNOSE RAPPORT:\n----------------\n1. Vacatures gevonden via API: ${result.api_count}\n2. Succesvol naar Make.com gestuurd: ${result.sent_count}\n`;
        if (result.api_count === 0 && result.raw_data) {
            msg += `\nLET OP: Er zijn 0 items gevonden. Ruwe data:\n${JSON.stringify(result.raw_data, null, 2)}`;
        }
        return new Response(msg, { headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
      } else {
        return new Response(`Fout bij sync: ${result.error}`, { status: 500, headers: corsHeaders });
      }
    }

    // --- FRONTEND ROUTE ---
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

    // --- MAKE.COM ROUTE ---
    if (request.method === 'POST' && url.pathname === '/api/save-assessment') {
      try {
        const body = await request.json();
        const insertAss = env.DB.prepare(`
          INSERT OR REPLACE INTO assessments 
          (opportunity_id, is_relevant, match_status, klant, eindklant, broker, contactpersoon, contact_email, contact_telefoon, tarief, uren, startdatum, samenvatting, kandidaten_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        await insertAss.bind(
          body.opportunity_id, body.relevant ? 1 : 0, body.match, body.klant, body.eindklant, 
          body.broker, body.contactpersoon, body.contact_email, body.contact_telefoon, 
          body.tarief, body.uren, body.startdatum, body.samenvatting, JSON.stringify(body.kandidaten)
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
