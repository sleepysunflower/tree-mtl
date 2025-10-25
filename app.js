document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // ---------------- Data URLs ----------------
  const URLS = {
    trees:   'https://pub-853864c73d334eac8a44f5923b069c11.r2.dev/trees.geojson',
    fellings:'https://pub-853864c73d334eac8a44f5923b069c11.r2.dev/fellings.geojson',
    nbhd:    'https://pub-853864c73d334eac8a44f5923b069c11.r2.dev/nbhd_stats.geojson'
  };

  // ------------- Helpers -------------
  function flattenPoints(fc) {
    if (!fc || !fc.features) return { type:'FeatureCollection', features: [] };
    const out = [];
    for (const f of fc.features) {
      const g = f && f.geometry;
      if (!g) continue;
      if (g.type === 'Point') {
        const [x,y] = g.coordinates || [];
        if (isFinite(x)&&isFinite(y)) out.push(f);
      } else if (g.type === 'MultiPoint') {
        for (const c of g.coordinates || []) {
          if (!Array.isArray(c)) continue;
          const [x,y]=c; if (!isFinite(x)||!isFinite(y)) continue;
          out.push({ type:'Feature', properties:{...(f.properties||{})}, geometry:{type:'Point', coordinates:[x,y]}});
        }
      }
    }
    return { type:'FeatureCollection', features: out };
  }

    // ----- Loader overlay controller -----
  const loaderEl = document.getElementById('map-loader');
  const loaderBar = document.querySelector('#map-loader .loader-bar');
  const loaderPct = document.getElementById('loader-percent');
  const loaderFile = document.getElementById('loader-file');

  let TOTAL_BYTES = 0;   // sum of content-lengths we discover
  let LOADED_BYTES = 0;  // bytes read across all files

  const loader = {
    show() { if (loaderEl) loaderEl.hidden = false; },
    hide() { if (loaderEl) loaderEl.hidden = true; },
    update(percent, fileLabel='') {
      if (!loaderEl) return;
      if (typeof percent === 'number' && isFinite(percent)) {
        const p = Math.max(0, Math.min(100, Math.round(percent)));
        loaderBar.style.width = p + '%';
        loaderPct.textContent = p + '%';
      }
      loaderFile.textContent = fileLabel ? `· ${fileLabel}` : '';
    },
    indeterminate(fileLabel='') {
      // when total size unknown, pulse the bar subtly
      loaderBar.style.width = '35%';
      loaderBar.style.transition = 'width .8s ease-in-out';
      requestAnimationFrame(()=>{
        loaderBar.style.width = '65%';
      });
      loaderFile.textContent = fileLabel ? `· ${fileLabel}` : '';
    }
  };

    async function preload(url, name){
    try{
      loader.show();
      loader.update(0, name);

      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);

      const total = Number(res.headers.get('content-length')) || 0;
      if (total > 0) TOTAL_BYTES += total;

      // If streaming not available, fall back to normal .json()
      if (!res.body || !res.body.getReader) {
        loader.indeterminate(name);
        const gj = await res.json();
        // treat as "finished" chunk for aggregate if we knew total
        if (total > 0) {
          LOADED_BYTES += total;
          const pct = TOTAL_BYTES ? (LOADED_BYTES / TOTAL_BYTES) * 100 : 100;
          loader.update(pct, name);
        }
        return gj;
      }

      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;

        // Aggregate progress across all files
        let pct = 0;
        if (TOTAL_BYTES > 0) {
          // Temporarily count this file's received bytes toward the total
          const tempLoaded = LOADED_BYTES + received;
          pct = (tempLoaded / TOTAL_BYTES) * 100;
          loader.update(pct, name);
        } else {
          // No totals yet -> gentle indeterminate hint
          loader.indeterminate(name);
        }
      }

      // finalize this file
      LOADED_BYTES += received;

      const blob = new Blob(chunks, { type: 'application/json' });
      const text = await blob.text();
      return JSON.parse(text);
    }catch(e){
      console.error('[load-error]', name, e);
      return null;
    }
  }


  function boundsFromPoints(fc){
    if (!fc?.features?.length) return null;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const f of fc.features){
      const g=f.geometry; if (!g || g.type!=='Point') continue;
      const [x,y]=g.coordinates; if (!isFinite(x)||!isFinite(y)) continue;
      if (x<minX)minX=x; if (y<minY)minY=y; if (x>maxX)maxX=x; if (y>maxY)maxY=y;
    }
    if (!isFinite(minX)) return null;
    return [[minX,minY],[maxX,maxY]];
  }

  // ------------- Load data -------------
  const [rawTrees, rawFell, rawNbhd] = await Promise.all([
    preload(URLS.trees, 'trees'),
    preload(URLS.fellings, 'fellings'),
    preload(URLS.nbhd, 'nbhd')
  ]);
  loader.hide();
  // Keep originals for client-side filtering
  const treesAll = flattenPoints(rawTrees || {type:'FeatureCollection',features:[]});
  const fellAll  = flattenPoints(rawFell  || {type:'FeatureCollection',features:[]});
  // Mutable currently-displayed FeatureCollections
  let treesFC = treesAll;
  let fellFC  = fellAll;
  let activeSpecies = null;

  // ---------------- Map init ----------------
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        // Pale basemap
        'basemap': {
          type: 'raster',
          tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution:
            '© OpenStreetMap © CARTO'
        }
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
    },
    center: [-73.60, 45.52],
    zoom: 10.5
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'top-left');

  // ---- Styling helpers: livability legend ----
  function setLegend(metric){
    const el = $('legend');
    if (!el) return;
    const lang = $('lang-select')?.value || 'en';
    const t = (en, fr) => (lang === 'fr' ? fr : en);
    const palettes = {
      heat: ['#4575b4', '#91bfdb', '#ffffbf', '#fdae61', '#d73027'],
      pm25: ['#edf8fb', '#b3cde3', '#8c96c6', '#8856a7', '#810f7c'],
      laeq: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
      la50: ['#f7fcfd', '#ccece6', '#66c2a4', '#238b45', '#00441b']
    };
    const colors = palettes[metric] || palettes.heat;
    el.innerHTML = '<div class="legend-swatch">' + colors.map(c => '<span style="background:' + c + '"></span>').join('') + '</div>';

    const lowLabel = $('legend-label-low');
    const highLabel = $('legend-label-high');
    if (lowLabel) lowLabel.textContent = t('Low', 'Faible');
    if (highLabel) highLabel.textContent = t('High', '\u00C9lev\u00E9');
  }

  function applyLang(lang){
    $('app-title').textContent = lang === 'fr' ? 'Arbre MTL' : 'Tree MTL';
    $('lbl-planted').textContent = lang === 'fr' ? 'Année de plantation' : 'Planted year';
    $('lbl-felled').textContent  = lang === 'fr' ? 'Année d\'abattage' : 'Felled year';
    $('lbl-show-alive').textContent = lang === 'fr' ? 'Afficher arbres vivants' : 'Show alive trees';
    $('lbl-show-fell').textContent  = lang === 'fr' ? 'Afficher arbres abattus' : 'Show felled trees';
    $('lbl-overlay').textContent    = lang === 'fr' ? 'Habitabilité par quartier' : 'Livability by neighborhood';
    $('tt-tree').textContent = lang === 'fr' ? 'Explorateur d’arbres' : 'Tree Explorer';
    $('tt-life').textContent = lang === 'fr' ? 'Vie de la forêt' : 'Forest Life';
    $('life-planted-l').textContent = lang === 'fr' ? 'Plantés dans la période' : 'Planted in range';
    $('life-felled-l').textContent  = lang === 'fr' ? 'Abattus dans la période' : 'Felled in range';
    $('life-top-planted').textContent = lang === 'fr' ? 'Espèces le plus plantées' : 'Top planted species';
    $('life-top-felled').textContent  = lang === 'fr' ? 'Espèces le plus abattues' : 'Top felled species';
    // Footer & modals
    $('btn-attrib').textContent  = lang === 'fr' ? 'Sources' : 'Sources';
    $('btn-feedback').textContent= lang === 'fr' ? 'Commentaire' : 'Feedback';
    $('btn-nearme').textContent  = lang === 'fr' ? 'Trouver des arbres près de moi' : 'Find trees near me';
    const fbTitle = $('fb-title'); if (fbTitle) fbTitle.textContent = lang==='fr' ? 'Commentaire' : 'Feedback';
    // Feedback labels
    const txt = (id,en,fr)=>{ const el=$(id); if(el) el.textContent=(lang==='fr'?fr:en); };
    txt('fb-lbl-type','Type','Type');
    txt('fb-lbl-location','Location','Emplacement');
    txt('fb-lbl-species','Species','Espèce');
    txt('fb-lbl-issue','Issue type','Type de problème');
    txt('fb-lbl-photo','Photo','Photo');
    txt('fb-lbl-desc','Description','Description');
    txt('fb-lbl-contact','Contact','Contact');
    const fbPick = $('fb-pick'); if (fbPick) fbPick.textContent = lang==='fr' ? (picking? 'Cliquez sur la carte…' : 'Choisir sur la carte') : (picking? 'Click map…':'Pick on map');
    const fbCancel=$('fb-cancel'); if (fbCancel) fbCancel.textContent = lang==='fr' ? 'Annuler' : 'Cancel';
    const fbSubmit=$('fb-submit'); if (fbSubmit) fbSubmit.textContent = lang==='fr' ? 'Envoyer' : 'Submit';
    const resetBtn = $('btn-reset-species'); if (resetBtn) resetBtn.textContent = lang==='fr' ? 'Reinitialiser la selection' : 'Reset selection';
    const allSpeciesBtn = $('btn-all-species'); if (allSpeciesBtn) allSpeciesBtn.textContent = lang==='fr' ? 'Voir toutes les especes' : 'See all species';
    const speciesHeaderTitle = document.querySelector('.species-header .title');
    if (speciesHeaderTitle) speciesHeaderTitle.textContent = lang === 'fr' ? 'Toutes les especes' : 'All Species';
    const speciesCloseBtn = document.querySelector('.species-close');
    if (speciesCloseBtn) speciesCloseBtn.setAttribute('aria-label', lang === 'fr' ? 'Fermer la liste' : 'Close list');
    const overlayMetric = $('overlay-metric');
    if (overlayMetric) {
      overlayMetric.options[0].text = lang === 'fr' ? 'Chaleur (1–5)' : 'Heat (1–5)';
      overlayMetric.options[1].text = 'Noise LAeq (dB)';
      overlayMetric.options[2].text = 'Noise LA50 (dB)';
      overlayMetric.options[3].text = 'PM2.5 (µg/m³)';
    }
    // Refresh legend language
    const metricVal = $('overlay-metric')?.value || 'heat';
    setLegend(metricVal);
    updateLegendEdgeLabels($('chk-overlay')?.checked ?? false);
  }

  // ---------------- Map layers ----------------
  map.on('load', () => {
    // NBHD underlay
    const nbhdInit = rawNbhd ? JSON.parse(JSON.stringify(rawNbhd)) : null;
    if (nbhdInit) { nbhdInit.features.forEach(f => { f.properties.metric = 'heat'; }); }

    map.addSource('nbhd', { type:'geojson', data: nbhdInit || URLS.nbhd });

    map.addLayer({
      id: 'nbhd-fill',
      type: 'fill',
      source: 'nbhd',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'case',
          ['==',['get','metric'],'pm25'],
            ['interpolate',['linear'], ['coalesce',['get','pm25_ugm3'], 0],
              0,  '#edf8fb', 5,  '#b3cde3', 10, '#8c96c6', 15, '#8856a7', 20, '#810f7c'
            ],
          ['==',['get','metric'],'laeq'],
            ['interpolate',['linear'], ['coalesce',['get','laeq_db'], 0],
              40, '#f7fbff', 50, '#c6dbef', 55, '#6baed6', 60, '#2171b5', 65, '#08306b'
            ],
          ['==',['get','metric'],'la50'],
            ['interpolate',['linear'], ['coalesce',['get','la50_db'], 0],
              40, '#f7fcfd', 50, '#ccece6', 55, '#66c2a4', 60, '#238b45', 65, '#00441b'
            ],
          // heat 5-class
          ['step', ['coalesce',['get','heat_class_mean'], 0],
            '#4575b4', 1.5, '#91bfdb', 2.5, '#ffffbf', 3.5, '#fdae61', 4.5, '#d73027'
          ]
        ],
        'fill-opacity': 0.35,
        'fill-outline-color': '#666'
      }
    });
    map.addLayer({
      id: 'nbhd-line',
      type: 'line',
      source: 'nbhd',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#555', 'line-width': 0.8 }
    });

    // Trees sources
    map.addSource('trees',   { type:'geojson', data: treesFC, cluster:true, clusterRadius:48, clusterMaxZoom:12 });
    map.addSource('fellings',{ type:'geojson', data: fellFC,  cluster:true, clusterRadius:48, clusterMaxZoom:12 });

    // Alive clusters
    map.addLayer({
      id: 'trees-clusters',
      type: 'circle',
      source: 'trees',
      filter: ['has','point_count'],
      paint: {
        'circle-color': 'rgba(34,139,34,0.78)',
        'circle-radius': ['step',['get','point_count'], 14, 50, 18, 100, 24, 500, 32],
        'circle-stroke-color': '#1e5e1e',
        'circle-stroke-width': 1
      }
    });
    map.addLayer({
      id: 'trees-count',
      type: 'symbol',
      source: 'trees',
      filter: ['has','point_count'],
      layout: {
        'text-field': ['get','point_count'],
        'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
        'text-size': 11
      },
      paint: { 'text-color':'#fff', 'text-halo-color':'#1e5e1e', 'text-halo-width':1 }
    });

    // Alive points
    map.addLayer({
      id: 'trees-points',
      type: 'circle',
      source: 'trees',
      filter: ['!',['has','point_count']],
      paint: {
        'circle-color': 'rgba(34,139,34,0.38)',
        'circle-radius': ['interpolate',['linear'],['zoom'], 10,2.2, 14,3.6, 16,5],
        'circle-stroke-color': '#228B22',
        'circle-stroke-width': 0.6
      }
    });

    // Felled clusters (hidden by default)
    map.addLayer({
      id: 'fellings-clusters',
      type: 'circle',
      source: 'fellings',
      filter: ['has','point_count'],
      layout:{ visibility:'none' },
      paint: {
        'circle-color': 'rgba(187,42,52,0.78)',
        'circle-radius': ['step',['get','point_count'], 14, 50, 18, 100, 24, 500, 32],
        'circle-stroke-color': '#7e1f27',
        'circle-stroke-width': 1
      }
    });
    map.addLayer({
      id: 'fellings-count',
      type: 'symbol',
      source: 'fellings',
      filter: ['has','point_count'],
      layout: {
        'text-field': ['get','point_count'],
        'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
        'text-size': 11,
        'visibility': 'none'
      },
      paint: { 'text-color':'#fff', 'text-halo-color':'#7e1f27', 'text-halo-width':1 }
    });

    // Felled points (hidden by default)
    map.addLayer({
      id: 'fellings-points',
      type: 'circle',
      source: 'fellings',
      filter: ['!',['has','point_count']],
      layout:{ visibility:'none' },
      paint: {
        'circle-color': 'rgba(187,42,52,0.38)',
        'circle-radius': ['interpolate',['linear'],['zoom'], 10,2.2, 14,3.6, 16,5],
        'circle-stroke-color': '#BB2A34',
        'circle-stroke-width': 0.6
      }
    });

    // Highlight layer
    map.addSource('highlight', { type:'geojson', data:{type:'FeatureCollection', features:[]} });
    map.addLayer({
      id:'highlight',
      type:'circle',
      source:'highlight',
      paint:{
        'circle-color':'#ffff00',
        'circle-opacity':0.8,
        'circle-radius':6,
        'circle-stroke-color':'#000',
        'circle-stroke-width':1
      }
    });

    // Interactions
    map.on('click','trees-points', (e)=> handleTreeClick(e, 'alive'));
    map.on('click','fellings-points', (e)=> handleTreeClick(e, 'fell'));
    // Zoom into clusters on click
    map.on('click','trees-clusters', (e)=> zoomIntoCluster(e, 'trees'));
    map.on('click','fellings-clusters', (e)=> zoomIntoCluster(e, 'fellings'));
    map.on('click','nbhd-fill', (e)=> handleNbhdClick(e));

    ['trees-points','fellings-points','nbhd-fill'].forEach(l=>{
      map.on('mouseenter', l, ()=> {
        if (!picking) map.getCanvas().style.cursor='pointer';
      });
      map.on('mouseleave', l, ()=> {
        if (!picking) map.getCanvas().style.cursor='';
      });
    });
    ['trees-clusters','fellings-clusters'].forEach(l=>{
      map.on('mouseenter', l, ()=> {
        if (!picking) map.getCanvas().style.cursor='pointer';
      });
      map.on('mouseleave', l, ()=> {
        if (!picking) map.getCanvas().style.cursor='';
      });
    });

    // Fit to trees on first load
    const b = boundsFromPoints(treesFC);
    if (b) { try { map.fitBounds(b, { padding: 40, animate:false }); } catch(_){} }
  });

  // ---------------- Visibility toggles ----------------
  function setVisibility(id, on){
    if (!map.getLayer(id)) return;
    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  $('chk-show-alive').addEventListener('change', (e)=>{
    const on = e.target.checked;
    setVisibility('trees-clusters', on);
    setVisibility('trees-count', on);
    setVisibility('trees-points', on);
  });
  $('chk-show-fell').addEventListener('change', (e)=>{
    const on = e.target.checked;
    setVisibility('fellings-clusters', on);
    setVisibility('fellings-count', on);
    setVisibility('fellings-points', on);
  });

  function updateLegendEdgeLabels(on){
    const low = $('legend-label-low');
    const high = $('legend-label-high');
    if (low) low.hidden = !on;
    if (high) high.hidden = !on;
  }

  // ---------------- Overlay metric & legend ----------------
  function setNbhdMetric(metric){
    const src = map.getSource('nbhd');
    if (!src) return;
    const fresh = rawNbhd ? JSON.parse(JSON.stringify(rawNbhd)) : null;
    if (fresh) fresh.features.forEach(f=> f.properties.metric = metric);
    src.setData(fresh || URLS.nbhd);
  }
  $('chk-overlay').addEventListener('change', (e)=>{
    const on = e.target.checked;
    setVisibility('nbhd-fill', on);
    setVisibility('nbhd-line', on);
    $('legend').hidden = !on;
    updateLegendEdgeLabels(on);
    if (on) {
      const metric = $('overlay-metric').value;
      setLegend(metric); setNbhdMetric(metric);
    }
  });
  $('overlay-metric').addEventListener('change', (e)=>{
    const metric = e.target.value;
    setLegend(metric); setNbhdMetric(metric);
    const overlayOn = $('chk-overlay')?.checked ?? false;
    updateLegendEdgeLabels(overlayOn);
  });
  setLegend('heat'); $('legend').hidden = true;
  updateLegendEdgeLabels(false);

  // ---------------- Sliders (dual handles, seamless) ----------------
  function updateYearRange(kind){
    const minEl = $(`${kind}-year-min`);
    const maxEl = $(`${kind}-year-max`);
    if (!minEl || !maxEl) return;

    const min = +minEl.min, max = +maxEl.max;
    let v1 = +minEl.value, v2 = +maxEl.value;
    if (v1 > v2) { v1 = v2; minEl.value = String(v1); }

    // Ensure min <= max
    if (v1 < min) { v1 = min; minEl.value = String(v1); }
    if (v2 > max) { v2 = max; maxEl.value = String(v2); }
    // Apply map filters + recompute sidebar stats (cheap client aggregation)
    applyYearFilters();
    computeForestLifeStats();
  }
  ['plant','fell'].forEach(kind=>{
    const minEl = $(`${kind}-year-min`);
    const maxEl = $(`${kind}-year-max`);
    minEl.addEventListener('input', ()=> updateYearRange(kind));
    maxEl.addEventListener('input', ()=> updateYearRange(kind));
    minEl.addEventListener('blur', ()=> updateYearRange(kind));
    maxEl.addEventListener('blur', ()=> updateYearRange(kind));
  });

  // ---------------- Tree/NBHD Click handlers ----------------
  function handleTreeClick(e, kind){
    const f = e.features && e.features[0]; if (!f) return;
    // highlight
    const src = map.getSource('highlight');
    src.setData({ type:'FeatureCollection', features: [{ type:'Feature', geometry:f.geometry, properties:{} }] });

    // sidebar to Tree Explorer
    switchTab('tree');

    // fill card
    const p = f.properties || {};
    const card = $('tree-card');
    card.classList.remove('muted');
    card.classList.remove('species-card');
    card.innerHTML = renderTreeCard(p, kind);

    // species filter button
    const btn = document.getElementById('btn-species-filter');
    if (btn) btn.addEventListener('click', ()=>{
      const sig = p.sigle || p.sp_sigle;
      if (!sig) return;
      filterSpecies(sig);
    });
  }

  function renderTreeCard(p, kind){
    // Multi-language small headers
    const lang = $('lang-select').value;
    const labels = (en, fr)=> (lang === 'fr' ? fr : en);

    // alive vs fell fields
    const title = (kind==='alive')
      ? (p.tree_name || p.essence_ang || p.essence_fr || 'Tree')
      : (p.sp_essence_ang || p.sp_essence_fr || 'Felled tree');

    const plantYear  = p.plant_year || '—';
    const dbh        = p.dhp || '—';
    const fellYear   = p.removal_year || (p.removal_date ? String(p.removal_date).slice(0,4) : '—');
    const addr       = p.address || p.rue || p.arrond_nom || '';

    const origin   = p.origin || '—';
    const growth   = p.growth || '—';
    const habitat  = p.habitat || '—';
    const funfact  = p.fun_fact || '—';

    const aliveInfo = `
      <dl class="kv">
        <dt>${labels('Planted','Planté')}</dt><dd>${plantYear}</dd>
        <dt>${labels('Diameter at breast height','Diamètre à hauteur de poitrine')}</dt><dd>${dbh}</dd>
        <dt>${labels('Origin','Origine')}</dt><dd>${origin}</dd>
        <dt>${labels('Growth','Croissance')}</dt><dd>${growth}</dd>
        <dt>${labels('Habitat','Habitat')}</dt><dd>${habitat}</dd>
        <dt>${labels('Fun fact','Le saviez-vous ?')}</dt><dd>${funfact}</dd>
      </dl>`;

    const fellInfo = `
      <dl class="kv">
        <dt>${labels('Felled','Abattu')}</dt><dd>${fellYear}</dd>
        <dt>${labels('Species','Espèce')}</dt><dd>${p.sp_essence_ang || p.sp_essence_fr || '—'}</dd>
      </dl>`;

    return `
      <div class="title">${title}</div>
      <div class="sub">${addr}</div>
      ${kind==='alive' ? aliveInfo : fellInfo}
      <button class="pill small" id="btn-species-filter">${labels('This species in the city','Cette espèce dans la ville')}</button>
    `;
  }

  function handleNbhdClick(e){
    const f = e.features && e.features[0]; if (!f) return;
    const p = f.properties || {};
    const ll = e.lngLat;
    const lang = $('lang-select').value;
    const t = (en, fr)=> (lang==='fr'?fr:en);
    // highlight by putting polygon border bolder? (simple popup for now)
    let aliveTxt = 'N/A';
    if (p.tree_count != null) aliveTxt = (+p.tree_count < 50) ? t('No data','Pas de données') : String(p.tree_count);

    const html = `
      <div class="card">
        <div class="title">${p.nbhd_name || t('Neighborhood','Quartier')}</div>
        <div class="kv">
          <dt>${t('Alive trees','Arbres vivants')}</dt><dd>${aliveTxt}</dd>
          <dt>${t('Heat','Chaleur')}</dt><dd>${t('Class','Classe')} ${p.heat_class_mean ?? 'N/A'}</dd>
          <dt>${t('Noise LAeq','Bruit LAeq')}</dt><dd>${p.laeq_db ?? 'N/A'} dB</dd>
          <dt>${t('Noise LA50','Bruit LA50')}</dt><dd>${p.la50_db ?? 'N/A'} dB</dd>
          <dt>PM2.5</dt><dd>${p.pm25_ugm3 ?? 'N/A'} µg/m³</dd>
        </div>
      </div>
    `;
    new maplibregl.Popup({ closeOnMove:true }).setLngLat(ll).setHTML(html).addTo(map);
  }

  // ---------------- Species filter (simple visual filter) ----------------
  function updateSpeciesListUI(){
    document.querySelectorAll('.species-item').forEach(item => {
      item.classList.toggle('is-active', !!activeSpecies && item.dataset.sigle === activeSpecies);
    });
  }

  function closeSpeciesList(){
    const card = $('tree-card');
    if (!card) return;
    card.classList.add('muted');
    card.classList.remove('species-card');
    card.innerHTML = '<p id="tree-empty">Click a tree on the map to see details.</p>';
  }

  function filterSpecies(sigle){
    activeSpecies = sigle;
    updateSpeciesListUI();
    if (map.getLayer('trees-points')){
      map.setFilter('trees-points', ['all', ['!',['has','point_count']], ['==', ['get','sigle'], sigle]]);
    }
    if (map.getLayer('fellings-points')){
      map.setFilter('fellings-points', ['all', ['!',['has','point_count']], ['==', ['get','sp_sigle'], sigle]]);
    }
  }

  function resetSpeciesFilter(){
    activeSpecies = null;
    updateSpeciesListUI();
    if (map.getLayer('trees-points')){
      map.setFilter('trees-points', ['!',['has','point_count']]);
    }
    if (map.getLayer('fellings-points')){
      map.setFilter('fellings-points', ['!',['has','point_count']]);
    }
    // Clear highlight and card
    const hl = map.getSource('highlight');
    if (hl) hl.setData({ type:'FeatureCollection', features:[] });
    closeSpeciesList();
  }

  function showAllSpecies(){
    const lang = $('lang-select').value;
    const speciesSet = new Set();

    for (const f of treesAll.features){
      const sigle = f.properties?.sigle;
      if (sigle) speciesSet.add(sigle);
    }

    for (const f of fellAll.features){
      const sigle = f.properties?.sp_sigle;
      if (sigle) speciesSet.add(sigle);
    }

    const speciesMap = new Map();
    for (const sigle of speciesSet){
      let name = sigle;
      for (const f of treesAll.features){
        if (f.properties?.sigle === sigle) {
          name = lang === 'fr' ? (f.properties?.essence_fr || f.properties?.essence_ang || sigle) : (f.properties?.essence_ang || f.properties?.essence_fr || sigle);
          break;
        }
      }
      if (name === sigle) {
        for (const f of fellAll.features){
          if (f.properties?.sp_sigle === sigle) {
            name = lang === 'fr' ? (f.properties?.sp_essence_fr || f.properties?.sp_essence_ang || sigle) : (f.properties?.sp_essence_ang || f.properties?.sp_essence_fr || sigle);
            break;
          }
        }
      }
      speciesMap.set(sigle, name);
    }

    const sortedSpecies = Array.from(speciesMap.entries()).sort((a,b) => a[1].localeCompare(b[1]));
    const card = $('tree-card');
    if (!card) return;
    card.classList.remove('muted');
    card.classList.add('species-card');
    card.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'species-header';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = lang === 'fr' ? 'Toutes les especes' : 'All Species';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'species-close';
    closeBtn.setAttribute('aria-label', lang === 'fr' ? 'Fermer la liste' : 'Close list');
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', closeSpeciesList);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const list = document.createElement('div');
    list.className = 'species-list';
    sortedSpecies.forEach(([sigle, name]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'species-item';
      item.dataset.sigle = sigle;
      item.textContent = name;
      item.addEventListener('click', () => {
        filterSpecies(sigle);
      });
      list.appendChild(item);
    });

    card.appendChild(list);
    list.scrollTop = 0;
    updateSpeciesListUI();
  }

  function zoomIntoCluster(e, sourceId){
    const features = map.queryRenderedFeatures(e.point, { layers: [sourceId + '-clusters'] });
    if (!features.length) return;
    const clusterId = features[0].properties.cluster_id;
    const source = map.getSource(sourceId);
    if (!source || !source.getClusterExpansionZoom) return;
    source.getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      map.easeTo({ center: features[0].geometry.coordinates, zoom });
    });
  }

  // ---------------- Sidebar Tabs ----------------
  function switchTab(which){
    document.querySelectorAll('.tab').forEach(b=>{
      b.classList.toggle('active', b.dataset.tab === which);
    });
    document.querySelectorAll('.pane').forEach(p=>{
      p.classList.toggle('active', p.id === ('pane-' + which));
    });
  }
  $('tab-tree').addEventListener('click', ()=> switchTab('tree'));
  $('tab-life').addEventListener('click', ()=> { switchTab('life'); computeForestLifeStats(); });
  const btnReset = document.getElementById('btn-reset-species');
  if (btnReset) btnReset.addEventListener('click', resetSpeciesFilter);
  const btnAllSpecies = document.getElementById('btn-all-species');
  if (btnAllSpecies) btnAllSpecies.addEventListener('click', showAllSpecies);

  // ---------------- Sidebar Collapse ----------------
  const sidebar = $('sidebar');
  const toggle  = $('sidebar-toggle');
  toggle.addEventListener('click', ()=>{
    const c = sidebar.classList.toggle('collapsed');
    toggle.textContent = c ? '«' : '»';
  });

  // ---------------- Forest Life Stats (client-side aggregate) ----------------
  function computeForestLifeStats(){
    const pMin = +$('plant-year-min').value;
    const pMax = +$('plant-year-max').value;
    const fMin = +$('fell-year-min').value;
    const fMax = +$('fell-year-max').value;

    // planted count in range
    let planted = 0;
    const plantedSpecies = {};
    for (const f of treesAll.features){
      const y = +(f.properties?.plant_year || NaN);
      if (!isFinite(y)) continue;
      if (y >= pMin && y <= pMax) {
        planted++;
        const s = f.properties?.sigle || 'Unknown';
        plantedSpecies[s] = (plantedSpecies[s]||0)+1;
      }
    }
    // felled count in range
    let felled = 0;
    const felledSpecies = {};
    for (const f of fellAll.features){
      const y = +(f.properties?.removal_year || (String(f.properties?.removal_date||'').slice(0,4)));
      if (!isFinite(y)) continue;
      if (y >= fMin && y <= fMax) {
        felled++;
        const s = f.properties?.sp_sigle || 'Unknown';
        felledSpecies[s] = (felledSpecies[s]||0)+1;
      }
    }

    $('life-planted-k').textContent = planted.toLocaleString();
    $('life-felled-k').textContent  = felled.toLocaleString();
    renderTopList('top-planted', plantedSpecies);
    renderTopList('top-felled',  felledSpecies);
  }
  function renderTopList(id, dict){
    const ul = $(id); ul.innerHTML='';
    const top = Object.entries(dict).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const lang = $('lang-select').value;
    for (const [sigle, count] of top){
      const li = document.createElement('li');
      // Find the species name from the data
      let speciesName = sigle;
      for (const f of treesAll.features){
        if (f.properties?.sigle === sigle) {
          speciesName = lang === 'fr' ? (f.properties?.essence_fr || f.properties?.essence_ang || sigle) : (f.properties?.essence_ang || f.properties?.essence_fr || sigle);
          break;
        }
      }
      // For felled trees, check fellAll
      if (speciesName === sigle) {
        for (const f of fellAll.features){
          if (f.properties?.sp_sigle === sigle) {
            speciesName = lang === 'fr' ? (f.properties?.sp_essence_fr || f.properties?.sp_essence_ang || sigle) : (f.properties?.sp_essence_ang || f.properties?.sp_essence_fr || sigle);
            break;
          }
        }
      }
      li.textContent = `${speciesName}: ${count.toLocaleString()}`;
      li.style.fontFamily = "'Inter', sans-serif";
      li.style.fontSize = "12px";
      li.style.color = "var(--gray-9)";
      ul.appendChild(li);
    }
  }

  // ---------------- Footer actions ----------------
  function openModal(id){ $(id).removeAttribute('hidden'); }
  function closeModal(el){ el.closest('.modal').setAttribute('hidden',''); }
  $('btn-attrib').addEventListener('click', ()=> openModal('modal-attrib'));
  $('btn-feedback').addEventListener('click', ()=> openModal('modal-feedback'));
  $('btn-nearme').addEventListener('click', async ()=>{
    if (!navigator.geolocation) return alert('Geolocation not supported.');
    navigator.geolocation.getCurrentPosition((pos)=>{
      map.flyTo({ center:[pos.coords.longitude, pos.coords.latitude], zoom:14 });
    }, ()=> alert('Could not get location.'));
  });
  document.querySelectorAll('[data-close]').forEach(btn=> btn.addEventListener('click', (e)=> closeModal(e.target)));

  // Feedback dynamic form & map-pick
  const fbType = $('fb-type');
  const fbSpeciesWrap = $('fb-species-wrap');
  const fbIssueWrap   = $('fb-issue-wrap');
  fbType.addEventListener('change', ()=>{
    const v = fbType.value;
    fbSpeciesWrap.hidden = v !== 'missing';
    fbIssueWrap.hidden   = v !== 'issue';
  });

  let picking = false;
  $('fb-pick').addEventListener('click', ()=>{
    picking = !picking;
    const lang = $('lang-select').value;
    $('fb-pick').textContent = picking ? (lang==='fr'?'Cliquez sur la carte…':'Click map…') : (lang==='fr'?'Choisir sur la carte':'Pick on map');
    // Force crosshair cursor while picking
    if (picking) {
      map.getCanvas().style.cursor = 'crosshair';
      map.getCanvas().style.pointerEvents = 'auto';
      // Temporarily hide modal while picking so map receives clicks
      $('modal-feedback').setAttribute('data-temp-open','1');
      $('modal-feedback').setAttribute('hidden','');
    } else {
      map.getCanvas().style.cursor = '';
      if ($('modal-feedback').getAttribute('data-temp-open')==='1') {
        $('modal-feedback').removeAttribute('hidden');
        $('modal-feedback').removeAttribute('data-temp-open');
      }
    }
  });
  map.on('click', (e)=>{
    if (!picking) return;
    const {lng,lat} = e.lngLat;
    $('fb-location').value = `${lng.toFixed(6)}, ${lat.toFixed(6)}`;
    picking = false;
    const lang = $('lang-select').value;
    $('fb-pick').textContent = lang==='fr'?'Choisir sur la carte':'Pick on map';
    map.getCanvas().style.cursor = '';
    // Restore modal after picking
    if ($('modal-feedback').getAttribute('data-temp-open')==='1'){
      $('modal-feedback').removeAttribute('hidden');
      $('modal-feedback').removeAttribute('data-temp-open');
    }
  });

  $('fb-cancel').addEventListener('click', ()=> $('modal-feedback').setAttribute('hidden',''));
  $('fb-submit').addEventListener('click', ()=>{
    const type = $('fb-type').value;
    const loc  = $('fb-location').value.trim();
    const desc = $('fb-desc').value.trim();
    // Minimal validation
    const lang = $('lang-select').value;
    if (!loc) return alert(lang==='fr' ? 'Veuillez fournir un emplacement.' : 'Please provide a location.');
    if ((type==='incorrect'||type==='other') && !desc) return alert(lang==='fr' ? 'Veuillez décrire le problème.' : 'Please describe the issue.');
    alert(lang==='fr' ? 'Merci pour votre commentaire ! (Stocké localement pour l’instant)' : 'Thanks for your feedback! (Stored locally for now)');
    $('modal-feedback').setAttribute('hidden','');
  });

  // ---------------- Language ----------------
  $('lang-select').addEventListener('change', (e)=> applyLang(e.target.value));
  applyLang('en');

  // ---------------- Year filtering (update sources for accurate clustering) ----------------
  function applyYearFilters(){
    const pMin = +$('plant-year-min').value;
    const pMax = +$('plant-year-max').value;
    const fMin = +$('fell-year-min').value;
    const fMax = +$('fell-year-max').value;

    // Filter features by year
    const treesFilt = treesAll.features.filter(f=>{
      const y = +(f.properties?.plant_year || NaN);
      return isFinite(y) ? (y>=pMin && y<=pMax) : false;
    });
    const fellFilt = fellAll.features.filter(f=>{
      const y = +(f.properties?.removal_year || (String(f.properties?.removal_date||'').slice(0,4)));
      return isFinite(y) ? (y>=fMin && y<=fMax) : false;
    });
    treesFC = { type:'FeatureCollection', features: treesFilt };
    fellFC  = { type:'FeatureCollection', features: fellFilt };

    // Update sources to recompute clusters
    const treesSrc = map.getSource('trees');
    const fellSrc  = map.getSource('fellings');
    if (treesSrc) treesSrc.setData(treesFC);
    if (fellSrc)  fellSrc.setData(fellFC);
  }

  // ---------------- Attribution from CSV ----------------
  async function loadAttribution(){
    try{
      const res = await fetch('./dataset_sum.csv');
      if (!res.ok) return;
      const text = await res.text();
      const rows = text.trim().split(/\r?\n/).map(r=>r.split(','));
      if (rows.length<=1) return;
      const [header,...data] = rows;
      const body = $('attrib-body'); if (!body) return;
      const ul = document.createElement('ul');
      ul.className = 'bullets';
      data.forEach(cells=>{
        const li = document.createElement('li');
        li.textContent = cells.join(' — ');
        ul.appendChild(li);
      });
      body.innerHTML = '';
      body.appendChild(ul);
    }catch(_){ /* ignore */ }
  }
  loadAttribution();
});











