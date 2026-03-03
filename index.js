export default {
  // 1. DE UURLIJKSE CRON JOB (Automatisch)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.processHourlySync(env));
  },

  // De kernlogica voor het ophalen en doorsturen
  async processHourlySync(env) {
    try {
      // 1A. Token Ophalen bij ThisWorkz
      const tokenUrl = 'https://lemur-2.cloud-iam.com/auth/realms/thisworkz/protocol/openid-connect/token';
      const tokenParams = new URLSearchParams();
      tokenParams.append('grant_type', 'client_credentials');
      tokenParams.append('client_id', env.THISWORKZ_CLIENT_ID);
      tokenParams.append('client_secret', env.THISWORKZ_CLIENT_SECRET);

      const tokenRes = await fetch(tokenUrl, { method: 'POST', body: tokenParams });
      if (!tokenRes.ok) throw new Error("Kon geen token ophalen");
      const tokenData = await tokenRes.json();
      const token = tokenData.access_token;

      // 1B. Opportunities Ophalen
      const opsUrl = 'https://matching.thisworkz.online/api/opportunities?page=0&size=50&status=NEW&sort=deadlineDate%2Cdesc';
      const opsRes = await fetch(opsUrl, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      });
      const opsData = await opsRes.json();
      const items = opsData.content || [];

      // 1C. Opslaan in D1 database (Nieuwe toevoegen, bestaande negeren)
      const insertOp = env.DB.prepare(`
        INSERT OR IGNORE INTO opportunities (id, title, description, source, location, deadline)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const desc = item.description || "Geen beschrijving"; 
        await insertOp.bind(item.remoteId, item.title, desc, item.source, item.location, item.deadlineDate).run();
      }

      // 1D. Selecteer items die nog NIET naar Make.com zijn gestuurd (max 10 tegelijk om overbelasting te voorkomen)
      const pendingQuery = await env.DB.prepare(`SELECT * FROM opportunities WHERE processed_for_ai = 0 LIMIT 10`).all();
      
      if (pendingQuery.results && pendingQuery.results.length > 0) {
        for (const pending of pendingQuery.results) {
          // Stuur naar de Make.com Webhook
          const makeRes = await fetch(env.MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pending)
          });
          
          // Markeer in de database als verzonden als Make.com succesvol antwoordt
          if (makeRes.ok) {
            await env.DB.prepare(`UPDATE opportunities SET processed_for_ai = 1 WHERE id = ?`).bind(pending.id).run();
          }
        }
      }
      return { success: true, processed: pendingQuery.results ? pendingQuery.results.length : 0 };
    } catch (error) {
      console.error("Fout tijdens sync:", error);
      return { success: false, error: error.message };
    }
  },

  // 2. DE HTTP API (Voor Frontend, Make.com én handmatig testen)
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // CORS headers zodat je frontend (HTML) erbij kan
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Pre-flight request voor browsers
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- TEST ROUTE: Forceer een handmatige synchronisatie ---
    if (request.method === 'GET' && url.pathname === '/api/force-sync') {
      const result = await this.processHourlySync(env);
      if (result.success) {
        return new Response(`Handmatige sync succesvol uitgevoerd! ${result.processed} nieuwe items naar Make.com gestuurd.`, { headers: corsHeaders });
      } else {
        return new Response(`Fout bij sync: ${result.error}`, { status: 500, headers: corsHeaders });
      }
    }

    // --- A. Frontend route: Haal alle data op voor het dashboard ---
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

    // --- B. Make.com route: Ontvang de AI-analyse terug ---
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

    // --- C. Frontend route: Verwijder een item ---
    if (request.method === 'DELETE' && url.pathname === '/api/opportunities') {
      const id = url.searchParams.get('id');
      await env.DB.prepare(`DELETE FROM assessments WHERE opportunity_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM opportunities WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ deleted: true }), { headers: corsHeaders });
    }

    // Fallback voor onbekende URLs
    return new Response('API Endpoint niet gevonden', { status: 404, headers: corsHeaders });
  }
};
