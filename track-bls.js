const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const ACT_LABELS = {
  'GATE-OUT': 'SaÃ­da do depÃ³sito',
  'GATE-IN': 'Gate-in no terminal',
  'LOAD': 'Carregado no navio',
  'DISCHARG': 'Descarregado',
  'CONTAINER ARRIVAL': 'Chegada ao terminal',
  'CONTAINER DEPARTURE': 'Partida do navio',
};

function parseTrackingData(data) {
  const ct = data.containers && data.containers[0];
  if (!ct) return null;

  const etaIso = ct.eta_final_delivery ? ct.eta_final_delivery.substring(0, 10) : '';
  const eta = etaIso ? etaIso.split('-').reverse().join('/') : '';

  let vessel = '', lastEvent = '', lastEventPlace = '', lastEventTime = '';

  if (ct.locations) {
    const allAct = [];
    ct.locations.forEach(loc =>
      (loc.events || []).forEach(ev => {
        if (ev.event_time_type === 'ACTUAL')
          allAct.push({ ...ev, place: loc.city || loc.terminal || '' });
      })
    );
    allAct.sort((a, b) => new Date(b.event_time) - new Date(a.event_time));
    if (allAct.length) {
      const last = allAct[0];
      lastEvent = ACT_LABELS[last.activity] || last.activity;
      lastEventPlace = last.place;
      lastEventTime = last.event_time
        ? new Date(last.event_time).toLocaleDateString('pt-BR')
        : '';
    }
    const vesselEv = allAct.find(
      ev => ev.vessel_name && (ev.activity === 'LOAD' || ev.activity === 'CONTAINER DEPARTURE')
    );
    if (vesselEv) vessel = vesselEv.vessel_name;
  }

  return {
    eta,
    etaIso,
    container: ct.container_num || '',
    vessel,
    lastEvent,
    lastEventPlace,
    lastEventTime,
    from: data.origin ? `${data.origin.city}, ${data.origin.country}` : '',
    to: data.destination ? `${data.destination.city}, ${data.destination.country}` : '',
    updatedAt: new Date().toISOString(),
  };
}

async function trackBL(bl) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
  });
  const page = await context.newPage();

  let trackingData = null;

  try {
    // Carrega a home da Maersk para obter cookies e passar pelo Akamai
    await page.goto('https://www.maersk.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Aguarda Akamai JS rodar e gerar os tokens
    await page.waitForTimeout(4000);

    // Faz o fetch da API de dentro do Chrome (TLS fingerprint real + cookies Akamai)
    const json = await page.evaluate(async (blNum) => {
      try {
        const r = await fetch(
          `https://api.maersk.com/synergy/tracking/${blNum}?operator=MAEU`,
          {
            headers: {
              'consumer-key': 'UtMm6JCDcGTnMGErNGvS2B98kt1Wl25H',
              'api-version': 'v2',
              'Accept': 'application/json',
            },
          }
        );
        if (!r.ok) return null;
        return await r.json();
      } catch (e) {
        return null;
      }
    }, bl);

    if (json) trackingData = parseTrackingData(json);
  } catch (e) {
    console.log(`  Erro ao rastrear BL ${bl}: ${e.message}`);
  }

  await browser.close();
  return trackingData;
}

async function main() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Iniciando rastreamento automÃ¡tico de BLs...`);

  // LÃª o estado atual do Supabase
  const { data: row, error } = await sb
    .from('app_state')
    .select('data')
    .eq('id', 1)
    .single();

  if (error || !row) {
    console.error('Erro ao ler app_state:', error);
    process.exit(1);
  }

  const state = row.data;
  const processes = state.processes || [];

  // Filtra processos com BL e armador Maersk
  const toTrack = processes.filter(
    p => p.bl && p.armador && p.armador.toLowerCase().includes('maersk')
  );

  if (toTrack.length === 0) {
    console.log('Nenhum processo com BL Maersk encontrado.');
    return;
  }

  console.log(`Encontrados ${toTrack.length} processo(s) para rastrear.`);

  let updated = 0;

  for (const proc of toTrack) {
    console.log(`  Rastreando BL ${proc.bl} (${proc.nome || proc.id})...`);
    const tracking = await trackBL(proc.bl.trim());

    if (tracking) {
      proc.tracking = tracking;
      updated++;
      console.log(`  âœ“ ETA: ${tracking.eta || 'nÃ£o disponÃ­vel'} | Evento: ${tracking.lastEvent || '-'}`);
    } else {
      console.log(`  âœ— Sem dados de rastreamento para ${proc.bl}`);
    }

    // Intervalo entre BLs para nÃ£o sobrecarregar
    await new Promise(r => setTimeout(r, 4000));
  }

  if (updated > 0) {
    const { error: saveError } = await sb
      .from('app_state')
      .update({ data: state, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (saveError) {
      console.error('Erro ao salvar no Supabase:', saveError);
      process.exit(1);
    }
    console.log(`\nâœ… ${updated} processo(s) atualizado(s) no Supabase.`);
  } else {
    console.log('\nNenhum dado novo para salvar.');
  }
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
