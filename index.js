export default {
  // 1. DE UURLIJKSE CRON JOB
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.processHourlySync(env));
  },

  async processHourlySync(env) {
    // 1A. Token Ophalen
    const tokenUrl = 'https://lemur-2.cloud-iam.com/auth/realms/thisworkz/protocol/openid-connect/token';
    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'client_credentials');
    tokenParams.append('client_id', env.THISWORKZ_CLIENT_ID);
    tokenParams.append('client_secret', env.THISWORKZ_CLIENT_SECRET);

    const tokenRes = await fetch(tokenUrl, { method: 'POST', body: tokenParams });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    // 1B. Opportunities Ophalen
    const opsUrl = 'https://matching.thisworkz.online/api/opportunities?page=0&size=50&status=NEW&sort=deadlineDate%2Cdesc';
    const opsRes = await fetch(opsUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    const opsData = await opsRes.json();
    const items = opsData.content || [];

    // 1C. Opslaan in D1 (Duplicaten worden genegeerd door de Primary Key)
    const insertOp = env.DB.prepare(`
      INSERT OR IGNORE INTO opportunities (id, title, description, source, location, deadline)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      // Voorkom fouten bij ontbrekende beschrijving
      const desc = item.description || "Geen beschrijving"; 
      await insertOp.bind(item.remoteId, item.title, desc, item.source, item.location, item.deadlineDate).run();
    }

    // 1D. Selecteer ongeverwerkte items om naar Make.com te sturen
    const pendingQuery = await env.DB.prepare(`SELECT * FROM opportunities WHERE processed_for_ai = 0 LIMIT 10`).all();
    
    if (pendingQuery.results && pendingQuery.results.length > 0) {
      for (const pending of pendingQuery.results) {
        // Stuur naar de Make.com Webhook
        await fetch(env.MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pending)
        });
        
        // Markeer als verzonden
        await env.DB.prepare(`UPDATE opportunities SET processed_for_ai = 1 WHERE id = ?`).bind(pending.id).run();
      }
    }
  },

  // 2. DE HTTP API (Voor Frontend en Make.com)
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // A. Haal alle geanalyseerde items op voor het dashboard
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

    // B. Ontvang de AI-analyse van Make.com
    if (request.method === 'POST' && url.pathname === '/api/save-assessment') {
      const body = await request.json();
      
      const insertAss = env.DB.prepare(`
        INSERT OR REPLACE INTO assessments 
        (opportunity_id, is_relevant, match_status, klant, eindklant, broker, contactpersoon, contact_email, contact_telefoon, tarief, uren, startdatum, samenvatting, kandidaten_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      await insertAss.bind(
        body.opportunity_id, // Zorg dat Make dit veld meestuurt!
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
    }

    // C. Verwijder een item (Frontend)
    if (request.method === 'DELETE' && url.pathname === '/api/opportunities') {
      const id = url.searchParams.get('id');
      await env.DB.prepare(`DELETE FROM assessments WHERE opportunity_id = ?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM opportunities WHERE id = ?`).bind(id).run();
      return new Response(JSON.stringify({ deleted: true }), { headers: corsHeaders });
    }

    return new Response('Not Found', { status: 404 });
  }
};
