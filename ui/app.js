'use strict';

// ---------- mod definitions (osu!lazer) ----------

const MODS = {
    EZ: { type: 'reduction', name: 'Easy' },
    NF: { type: 'reduction', name: 'No Fail' },
    HT: { type: 'reduction', name: 'Half Time', rate: [0.5, 0.99, 0.75] },
    DC: { type: 'reduction', name: 'Daycore', rate: [0.5, 0.99, 0.75] },
    HR: { type: 'increase', name: 'Hard Rock' },
    SD: { type: 'increase', name: 'Sudden Death' },
    PF: { type: 'increase', name: 'Perfect' },
    DT: { type: 'increase', name: 'Double Time', rate: [1.01, 2, 1.5] },
    NC: { type: 'increase', name: 'Nightcore', rate: [1.01, 2, 1.5] },
    HD: { type: 'increase', name: 'Hidden' },
    FI: { type: 'increase', name: 'Fade In' },
    FL: { type: 'increase', name: 'Flashlight' },
    BL: { type: 'increase', name: 'Blinds' },
    RX: { type: 'automation', name: 'Relax' },
    SO: { type: 'automation', name: 'Spun Out' },
    TD: { type: 'system', name: 'Touch Device' },
    CL: { type: 'conversion', name: 'Classic' }
};

const MODE_MODS = {
    0: ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'BL', 'RX', 'SO', 'TD', 'CL'],
    1: ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'RX', 'CL'],
    2: ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'RX', 'CL'],
    3: ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FI', 'FL', 'CL']
};

const INCOMPATIBLE = [
    ['EZ', 'HR'],
    ['HT', 'DC', 'DT', 'NC'],
    ['NF', 'SD', 'PF'],
    ['HD', 'FI'],
    ['RX', 'SD', 'PF']
];

const RULESET_NAMES = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];

// ---------- state ----------

const S = {
    cfg: null,
    preview: false,
    demoPath: null,
    connected: false,
    gameState: null,
    client: 'lazer',
    map: null,
    ruleset: 0,
    gameMods: [],
    gameRate: 1,
    gameModsKey: '',
    mods: new Map(),
    follow: true,
    accuracy: 100,
    combo: null, // null = full combo (max)
    misses: 0,
    maxCombo: 0,
    result: null,
    override: null,
    pinned: false, // always expanded
    expanded: false, // main process expands the pill on hover
    interaction: { locked: false, hovering: false, active: false },
    game: null, // game surface size when running inside the game
    dragging: null
};

const $ = (id) => document.getElementById(id);
const panel = $('panel');

// ---------- helpers ----------

function fmt(n, digits = 0) {
    if (n == null || Number.isNaN(n)) return '–';
    return Number(n).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

const STAR_STOPS = [
    [0.1, '#4290fb'], [1.25, '#4fc0ff'], [2.0, '#4fffd5'], [2.5, '#7cff4f'], [3.3, '#f6f05c'],
    [4.2, '#ff8068'], [4.9, '#ff4e6f'], [5.8, '#c645b8'], [6.7, '#6563de'], [7.7, '#18158e'], [9.0, '#000000']
];

function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function starColor(sr) {
    if (sr < STAR_STOPS[0][0]) return '#aaaaaa';
    for (let i = 1; i < STAR_STOPS.length; i++) {
        const [s1, c1] = STAR_STOPS[i - 1];
        const [s2, c2] = STAR_STOPS[i];
        if (sr <= s2) {
            const t = (sr - s1) / (s2 - s1);
            const a = hexToRgb(c1);
            const b = hexToRgb(c2);
            return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`;
        }
    }
    return '#000000';
}

function setRangeFill(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const p = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 100;
    input.style.setProperty('--p', `${clamp(p, 0, 100)}%`);
}

function modsToArray() {
    return [...S.mods.entries()].map(([acronym, settings]) =>
        settings && Object.keys(settings).length ? { acronym, settings } : { acronym }
    );
}

function modsKey(list) {
    return JSON.stringify(
        (list || []).map((m) => [m.acronym, m.settings || {}]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    );
}

function currentRate() {
    for (const [acr, settings] of S.mods) {
        const def = MODS[acr];
        if (def?.rate) return Number(settings?.speed_change ?? def.rate[2]);
    }
    return 1;
}

// ---------- rendering ----------

function renderMods() {
    const list = MODE_MODS[S.ruleset] || MODE_MODS[0];
    const box = $('mods');
    box.innerHTML = '';
    for (const acr of list) {
        const def = MODS[acr];
        const b = document.createElement('button');
        b.className = `mod ${def.type}${S.mods.has(acr) ? ' on' : ''}`;
        b.textContent = acr;
        b.title = def.name;
        b.addEventListener('click', () => toggleMod(acr));
        box.appendChild(b);
    }

    // Mods from the game we don't have buttons for (e.g. DA, AC) — still used in calculation.
    const extra = [...S.mods.keys()].filter((a) => !list.includes(a));
    const extraBox = $('extraMods');
    extraBox.classList.toggle('hidden', extra.length === 0);
    extraBox.innerHTML = extra.length ? 'Ещё: ' : '';
    for (const acr of extra) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = acr;
        extraBox.appendChild(t);
    }

    const rateMod = [...S.mods.keys()].find((a) => MODS[a]?.rate);
    $('rateRow').classList.toggle('hidden', !rateMod);
    if (rateMod) {
        const [lo, hi, def] = MODS[rateMod].rate;
        const r = $('rate');
        r.min = lo;
        r.max = hi;
        r.value = S.mods.get(rateMod)?.speed_change ?? def;
        $('rateVal').textContent = `${Number(r.value).toFixed(2)}x`;
        setRangeFill(r);
    }
    $('follow').checked = S.follow;
    renderPill();
}

function renderMap() {
    const m = S.map;
    $('ruleset').textContent = RULESET_NAMES[S.ruleset] || 'osu!';
    $('dot').classList.toggle('off', !S.connected);
    if (!m) {
        $('mapTitle').textContent = S.connected ? 'Карта не выбрана' : 'Нет связи с tosu';
        $('mapSub').textContent = S.connected ? '' : `Жду tosu на ${S.cfg?.tosuHost || '127.0.0.1:24050'}…`;
        return;
    }
    $('mapTitle').textContent = `${m.artist} – ${m.title}`;
    $('mapTitle').title = $('mapTitle').textContent;
    $('mapSub').textContent = `[${m.version}] · ${m.mapper}`;
}

function renderStat(id, value, original) {
    const el = $(id);
    el.textContent = value == null ? '–' : fmt(value, value % 1 ? 1 : 0);
    el.classList.toggle('up', original != null && value > original + 0.01);
    el.classList.toggle('down', original != null && value < original - 0.01);
}

function renderResult() {
    const r = S.result;
    const err = $('error');
    if (!r || r.error) {
        $('pp').textContent = '–';
        $('ppSub').textContent = '';
        $('ppParts').innerHTML = '';
        $('ppTable').innerHTML = '';
        $('stars').textContent = '★ –';
        err.classList.toggle('hidden', !r?.error);
        err.textContent = r?.error || '';
        return;
    }
    err.classList.add('hidden');

    const stars = $('stars');
    stars.textContent = `★ ${fmt(r.stars, 2)}`;
    stars.style.background = starColor(r.stars);
    stars.style.color = r.stars >= 6.5 ? '#ffd966' : '#111';

    renderStat('stAR', r.difficulty.ar, r.original.ar);
    renderStat('stCS', r.difficulty.cs, r.original.cs);
    renderStat('stOD', r.difficulty.od, r.original.od);
    renderStat('stHP', r.difficulty.hp, r.original.hp);
    if (S.map?.bpm) {
        const bpm = (S.map.bpm / (S.gameRate || 1)) * currentRate();
        $('stBPM').textContent = fmt(bpm, 0);
        $('stBPM').classList.toggle('up', currentRate() > 1);
        $('stBPM').classList.toggle('down', currentRate() < 1);
    } else {
        $('stBPM').textContent = '–';
    }

    $('pp').textContent = fmt(r.pp.total, r.pp.total >= 1000 ? 0 : 1);

    const hits = r.score.hits;
    const hitText =
        r.mode === 3
            ? `${hits.perfect}/${hits.great}/${hits.good}/${hits.ok}/${hits.meh}/${hits.miss}`
            : r.mode === 2
              ? `${hits.great} фрукт · ${hits.smallTickMisses} пропущ. капель · ${hits.miss} мисс`
              : r.mode === 1
                ? `${hits.great} / ${hits.ok} / ${hits.miss}x`
                : `${hits.great} / ${hits.ok} / ${hits.meh} / ${hits.miss}x`;

    $('ppSub').innerHTML =
        `Если FC: <b>${fmt(r.fcPP, 1)}pp</b> · точность ${fmt(r.score.accuracy, 2)}% · ` +
        `<span title="Попадания">${hitText}</span>`;

    const parts = [];
    if (r.mode === 0) {
        parts.push(['aim', r.pp.aim], ['speed', r.pp.speed], ['acc', r.pp.accuracy]);
        if (r.pp.reading) parts.push(['reading', r.pp.reading]);
        if (r.pp.flashlight) parts.push(['fl', r.pp.flashlight]);
    } else if (r.mode === 1) {
        parts.push(['difficulty', r.pp.difficulty], ['acc', r.pp.accuracy]);
    } else if (r.mode === 3) {
        parts.push(['difficulty', r.pp.difficulty]);
    }
    $('ppParts').innerHTML = parts.map(([k, v]) => `<span>${k} <b>${fmt(v, 0)}</b></span>`).join('');

    $('ppTable').innerHTML = r.table
        .map((t) => `<div>${t.acc}%<b>${fmt(t.pp, 0)}</b></div>`)
        .join('');

    S.maxCombo = r.maxCombo;
    $('maxCombo').textContent = fmt(r.maxCombo);
    const comboVal = S.combo == null ? r.maxCombo : Math.min(S.combo, r.maxCombo);
    if (document.activeElement !== $('combo')) $('combo').value = comboVal;
    const cr = $('comboRange');
    cr.max = Math.max(1, r.maxCombo);
    cr.value = comboVal;
    setRangeFill(cr);
    $('fc').classList.toggle('on', S.combo == null);
}

function renderPill() {
    const r = S.result && !S.result.error ? S.result : null;
    $('pillDot').classList.toggle('off', !S.connected);
    const stars = $('pillStars');
    stars.textContent = r ? `★ ${fmt(r.stars, 2)}` : '★ –';
    stars.style.background = r ? starColor(r.stars) : '';
    stars.style.color = r && r.stars >= 6.5 ? '#ffd966' : '#111';
    const mods = [...S.mods.keys()];
    const rate = currentRate();
    $('pillMods').textContent = (mods.join('') || 'NM') + (rate !== 1 && ![1.5, 0.75].includes(rate) ? ` ${rate}x` : '');
    $('pillAcc').textContent = `${fmt(S.accuracy, S.accuracy % 1 ? 2 : 0)}%` + (S.misses ? ` · ${S.misses}x` : '');
    $('pillPP').textContent = r ? fmt(r.pp.total, 0) : '–';
}

function renderInputs() {
    if (document.activeElement !== $('acc')) $('acc').value = S.accuracy.toFixed(2);
    const ar = $('accRange');
    ar.value = clamp(S.accuracy, Number(ar.min), 100);
    setRangeFill(ar);
    for (const c of document.querySelectorAll('[data-acc]')) {
        c.classList.toggle('on', Math.abs(Number(c.dataset.acc) - S.accuracy) < 0.001);
    }
    if (document.activeElement !== $('misses')) $('misses').value = S.misses;
    renderPill();
}

function renderHint() {
    const cfg = S.cfg || {};
    const k = (s) => `<kbd>${String(s).replace(/Control/gi, 'Ctrl')}</kbd>`;
    let html;
    if (!S.connected && !S.demoPath) {
        html = `Нет связи с tosu (${cfg.tosuHost}). Запусти tosu — он сообщает, какая карта выбрана.`;
    } else if (S.preview) {
        html = 'Окно предпросмотра. В игре окно появляется само в меню выбора карты.';
    } else if (S.interaction.locked) {
        html = `Режим настройки: игра не получает ввод. ${k('Esc')}, ${k(cfg.hotkeyInteract)} или клик вне окна — выйти.`;
    } else if (cfg.hoverInteract && S.pinned) {
        html = `Наведи курсор, чтобы менять значения · булавка — сворачивать в плашку · ${k(cfg.hotkeyToggle)} — скрыть`;
    } else if (cfg.hoverInteract) {
        html = `Уведи курсор — окно свернётся в плашку · булавка — держать развёрнутым · ${k(cfg.hotkeyToggle)} — скрыть`;
    } else {
        html = `${k(cfg.hotkeyInteract)} — настроить · ${k(cfg.hotkeyToggle)} — скрыть`;
    }
    $('hint').innerHTML = html;
}

function renderAll() {
    renderPill();
    renderMap();
    renderMods();
    renderInputs();
    renderResult();
    renderHint();
    updateVisibility();
}

// ---------- panel placement / visibility ----------

// In the game the page lives in a panel-sized offscreen window that the main process positions;
// in the preview window the page places the panel itself.
function inGame() {
    return !S.preview && !!S.game;
}

function uiScale() {
    const height = inGame() ? S.game.height : 1080;
    return clamp(height / 1080, 0.6, 3) * (S.cfg?.panel?.scale || 1);
}

function placePanel() {
    const scale = uiScale();
    panel.style.transform = `scale(${scale})`;
    if (inGame()) {
        panel.style.left = '0px';
        panel.style.top = '0px';
        return;
    }
    const w = panel.offsetWidth * scale;
    const h = panel.offsetHeight * scale;
    const p = S.cfg.panel;
    p.x ??= 24;
    p.y ??= 160;
    p.x = clamp(p.x, 0, Math.max(0, window.innerWidth - w));
    p.y = clamp(p.y, 0, Math.max(0, window.innerHeight - h));
    panel.style.left = `${p.x}px`;
    panel.style.top = `${p.y}px`;
}

function isVisible() {
    if (S.override != null) return S.override;
    if (S.preview) return true;
    return S.connected && (S.cfg?.showStates || []).includes(S.gameState);
}

function isCompact() {
    if (S.previewCompact) return true; // dev: ?compact=1 in the preview window
    return inGame() && !S.pinned && !S.expanded;
}

let reportQueued = false;
let lastReport = '';
function reportPanel() {
    if (reportQueued) return;
    reportQueued = true;
    requestAnimationFrame(() => {
        reportQueued = false;
        const visible = !panel.classList.contains('hidden');
        const dpr = window.devicePixelRatio || 1;
        const r = panel.getBoundingClientRect();
        const report = {
            visible,
            expanded: !isCompact(),
            width: visible ? Math.ceil(r.width * dpr) : 0,
            height: visible ? Math.ceil(r.height * dpr) : 0
        };
        const key = JSON.stringify(report);
        if (key === lastReport) return;
        lastReport = key;
        window.ppApi.reportPanel(report);
    });
}

function updateVisibility() {
    const visible = isVisible();
    document.body.classList.toggle('ingame', inGame());
    panel.classList.toggle('hidden', !visible);
    panel.classList.toggle('compact', isCompact());
    panel.classList.toggle('active', S.preview || S.interaction.active);
    $('pin').classList.toggle('on', S.pinned);
    $('pin').title = S.pinned ? 'Открепить (сворачивать в плашку)' : 'Закрепить развёрнутым';
    if (visible) placePanel();
    reportPanel();
}

// ---------- actions ----------

function toggleMod(acr) {
    S.follow = false;
    if (S.mods.has(acr)) {
        S.mods.delete(acr);
    } else {
        for (const group of INCOMPATIBLE) {
            if (group.includes(acr)) for (const other of group) if (other !== acr) S.mods.delete(other);
        }
        const def = MODS[acr];
        S.mods.set(acr, def.rate ? { speed_change: def.rate[2] } : {});
    }
    renderMods();
    requestCalc();
}

function applyGameMods() {
    S.mods = new Map();
    for (const m of S.gameMods) {
        if (!m?.acronym) continue;
        S.mods.set(String(m.acronym).toUpperCase(), { ...(m.settings || {}) });
    }
}

function setAccuracy(v, fromSlider = false) {
    if (Number.isNaN(v)) return;
    S.accuracy = clamp(v, 0, 100);
    if (!fromSlider) renderInputs();
    else {
        $('acc').value = S.accuracy.toFixed(2);
        setRangeFill($('accRange'));
        for (const c of document.querySelectorAll('[data-acc]')) {
            c.classList.toggle('on', Math.abs(Number(c.dataset.acc) - S.accuracy) < 0.001);
        }
    }
    requestCalc();
}

function setCombo(v) {
    if (Number.isNaN(v)) return;
    const max = S.maxCombo || Infinity;
    S.combo = v >= max ? null : Math.max(0, Math.floor(v));
    requestCalc();
}

function setMisses(v) {
    if (Number.isNaN(v)) return;
    S.misses = Math.max(0, Math.floor(v));
    renderInputs();
    requestCalc();
}

let calcTimer = null;
let calcSeq = 0;
function requestCalc() {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(runCalc, 25);
}

async function runCalc() {
    const map = S.map;
    if (!map && !S.demoPath) return;

    const mods = modsToArray();
    if (S.client === 'stable' && !mods.some((m) => m.acronym === 'CL')) mods.push({ acronym: 'CL' });

    const seq = ++calcSeq;
    const res = await window.ppApi.calculate({
        songsFolder: map?.songsFolder,
        beatmapFile: map?.beatmapFile || S.demoPath,
        mode: S.ruleset,
        mods,
        accuracy: S.accuracy,
        combo: S.combo,
        misses: S.misses
    });
    if (seq !== calcSeq) return;
    S.result = res;
    renderResult();
    renderPill();
    updateVisibility();
}

// ---------- tosu connection ----------

// tosu data comes from the main process (tosu blocks websocket connections from file:// pages).
function onTosuState(state) {
    if (state.connected !== S.connected) {
        console.log(state.connected ? 'tosu connected' : 'tosu disconnected');
        S.connected = state.connected;
        renderAll();
    }
    if (state.data) onTosuData(state.data);
}

function connectTosu() {
    window.ppApi.onTosu(onTosuState);
    window.ppApi.getTosu().then(onTosuState);
}

function onTosuData(d) {
    if (!d || !d.beatmap) {
        if (d?.error && d.error !== S.lastTosuError) console.log('tosu:', (S.lastTosuError = d.error));
        return;
    }
    let changed = false;
    let recalc = false;

    const state = d.state?.number ?? null;
    if (state !== S.gameState) {
        console.log('game state', state, d.state?.name, 'client', d.client);
        S.gameState = state;
        S.override = null;
        changed = true;
    }

    S.client = d.client || S.client;

    const ruleset = d.settings?.mode?.number ?? d.beatmap?.mode?.number ?? 0;
    if (ruleset !== S.ruleset) {
        S.ruleset = ruleset;
        recalc = changed = true;
    }

    const b = d.beatmap;
    const beatmapFile = d.directPath?.beatmapFile || '';
    const key = `${b.checksum}|${beatmapFile}`;
    if (!S.map || S.map.key !== key) {
        S.map = {
            key,
            checksum: b.checksum,
            artist: b.artist,
            title: b.title,
            version: b.version,
            mapper: b.mapper,
            bpm: b.stats?.bpm?.common || 0,
            songsFolder: d.folders?.songs || '',
            beatmapFile
        };
        // New map: full combo, no misses; keep accuracy and mods.
        S.combo = null;
        S.misses = 0;
        recalc = changed = true;
    } else if (b.stats?.bpm?.common && b.stats.bpm.common !== S.map.bpm) {
        S.map.bpm = b.stats.bpm.common;
        changed = true;
    }

    const gameMods = d.play?.mods?.array || [];
    const gameKey = modsKey(gameMods);
    if (gameKey !== S.gameModsKey) {
        S.gameModsKey = gameKey;
        S.gameMods = gameMods;
        S.gameRate = d.play?.mods?.rate || 1;
        if (S.follow) {
            applyGameMods();
            recalc = true;
        }
        changed = true;
    }

    if (changed) renderAll();
    if (recalc) requestCalc();
}

// ---------- input wiring ----------

function wire() {
    $('pin').addEventListener('click', () => {
        S.pinned = !S.pinned;
        // Only the flag: in the game the position is owned by the main process.
        window.ppApi.savePanel({ pinned: S.pinned });
        window.ppApi.setPinned(S.pinned);
        renderHint();
        updateVisibility();
    });

    $('follow').addEventListener('change', (e) => {
        S.follow = e.target.checked;
        if (S.follow) {
            applyGameMods();
            requestCalc();
        }
        renderMods();
    });

    $('clearMods').addEventListener('click', () => {
        S.follow = false;
        S.mods.clear();
        renderMods();
        requestCalc();
    });

    $('rate').addEventListener('input', (e) => {
        const acr = [...S.mods.keys()].find((a) => MODS[a]?.rate);
        if (!acr) return;
        S.follow = false;
        $('follow').checked = false;
        S.mods.set(acr, { ...S.mods.get(acr), speed_change: Number(Number(e.target.value).toFixed(2)) });
        $('rateVal').textContent = `${Number(e.target.value).toFixed(2)}x`;
        setRangeFill(e.target);
        requestCalc();
    });

    $('acc').addEventListener('input', (e) => {
        const v = parseFloat(String(e.target.value).replace(',', '.'));
        if (!Number.isNaN(v)) {
            S.accuracy = clamp(v, 0, 100);
            requestCalc();
        }
    });
    $('acc').addEventListener('change', () => renderInputs());
    $('accRange').addEventListener('input', (e) => setAccuracy(Number(e.target.value), true));
    for (const c of document.querySelectorAll('[data-acc]')) {
        c.addEventListener('click', () => setAccuracy(Number(c.dataset.acc)));
    }

    $('combo').addEventListener('input', (e) => setCombo(parseInt(e.target.value, 10)));
    $('comboRange').addEventListener('input', (e) => {
        setCombo(Number(e.target.value));
        $('combo').value = e.target.value;
        setRangeFill(e.target);
        $('fc').classList.toggle('on', S.combo == null);
    });
    $('fc').addEventListener('click', () => {
        S.combo = null;
        requestCalc();
    });

    $('misses').addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        if (!Number.isNaN(v)) {
            S.misses = Math.max(0, v);
            requestCalc();
        }
    });
    $('missDec').addEventListener('click', () => setMisses(S.misses - 1));
    $('missInc').addEventListener('click', () => setMisses(S.misses + 1));

    // Mouse wheel over number fields / sliders nudges values.
    $('acc').addEventListener('wheel', (e) => setAccuracy(S.accuracy + (e.deltaY < 0 ? 0.1 : -0.1)), { passive: true });
    $('misses').addEventListener('wheel', (e) => setMisses(S.misses + (e.deltaY < 0 ? 1 : -1)), { passive: true });

    for (const input of document.querySelectorAll('input.num')) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.activeElement?.blur?.();
            if (S.interaction.locked) window.ppApi.setLocked(false);
        }
    });


    // Drag by header
    $('drag').addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        // In the game the main process moves the overlay texture itself.
        if (inGame()) return window.ppApi.dragStart();
        S.dragging = { sx: e.clientX, sy: e.clientY, x: S.cfg.panel.x, y: S.cfg.panel.y };
    });
    window.addEventListener('mousemove', (e) => {
        if (!S.dragging) return;
        S.cfg.panel.x = S.dragging.x + (e.clientX - S.dragging.sx);
        S.cfg.panel.y = S.dragging.y + (e.clientY - S.dragging.sy);
        placePanel();
    });
    window.addEventListener('mouseup', () => {
        if (!S.dragging) return;
        S.dragging = null;
        window.ppApi.savePanel(S.cfg.panel);
    });

    window.addEventListener('resize', () => updateVisibility());
    new ResizeObserver(() => reportPanel()).observe(panel);

    window.ppApi.onLayout(({ expanded }) => {
        S.expanded = expanded;
        if (!expanded) document.activeElement?.blur?.();
        updateVisibility();
    });

    window.ppApi.onGameSize((size) => {
        S.game = size;
        updateVisibility();
    });

    window.ppApi.onInteraction((state) => {
        S.interaction = state;
        if (!state.active) document.activeElement?.blur?.();
        renderHint();
        updateVisibility();
    });
    window.ppApi.onTogglePanel(() => {
        S.override = !isVisible();
        updateVisibility();
    });
    window.ppApi.onShowPanel(() => {
        S.override = true;
        updateVisibility();
    });
}

// ---------- boot ----------

(async function boot() {
    S.cfg = await window.ppApi.getConfig();
    const params = new URLSearchParams(location.search);
    S.preview = params.get('preview') === '1';
    S.demoPath = params.get('demo');
    S.previewCompact = params.get('compact') === '1';
    S.pinned = !!S.cfg.panel.pinned;
    S.game = S.preview ? null : await window.ppApi.getGameSize();
    document.body.classList.toggle('preview', S.preview);

    wire();
    renderAll();
    connectTosu();
    if (S.demoPath) {
        S.map = { key: 'demo', artist: 'Demo', title: S.demoPath.split(/[\\/]/).pop(), version: 'demo', mapper: '-', bpm: 0, beatmapFile: S.demoPath };
        renderAll();
        requestCalc();
    }
})();
