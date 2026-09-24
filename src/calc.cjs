// PP calculation on top of the official osu!lazer difficulty/performance calculators
// (@tosuapp/lazer-calculator-prebuilt is an AOT build of ppy/osu rulesets).
const fs = require('node:fs');
const { PlayBeatmap, OsuHitResult } = require('@tosuapp/lazer-calculator-prebuilt');

const MODE_NAMES = ['osu', 'taiko', 'fruits', 'mania'];

// Hit result "demotion" ladders per ruleset. Each step moves one judgement from `from` to `to`,
// lowering accuracy monotonically. Accuracy targets are reached by binary searching the step count.
const LADDERS = {
    0: [['greats', 'oks'], ['oks', 'mehs']],
    1: [['greats', 'oks']],
    2: [['smallTickHits', 'smallTickMisses']],
    3: [['perfects', 'greats', 0.5], ['greats', 'goods'], ['goods', 'oks'], ['oks', 'mehs']]
};

// Timing-based judgements per ruleset (catch has none): [score field, hit result] from best to worst.
const TIMED = {
    0: [['greats', 'Great'], ['oks', 'Ok'], ['mehs', 'Meh']],
    1: [['greats', 'Great'], ['oks', 'Ok']],
    3: [['perfects', 'Perfect'], ['greats', 'Great'], ['goods', 'Good'], ['oks', 'Ok'], ['mehs', 'Meh']]
};

// How hit results are generated from accuracy: 'ladder' (fewest downgrades) or 'laplace' (hit error
// model). Checked against official pp of real scores: mania needs the hit error model because its pp
// tells PERFECT and GREAT apart even where accuracy doesn't; other rulesets match best with the ladder.
const DEFAULT_DISTRIBUTION = { 0: 'ladder', 1: 'ladder', 2: 'ladder', 3: 'laplace' };

// Judgement that absorbs misses first.
const MISS_SOURCE = { 0: 'greats', 1: 'greats', 2: 'greats', 3: 'perfects' };

let beatmapCache = null; // { path, mtime, content, base }
const beatmapPerMode = new Map(); // mode -> PlayBeatmap (converted)
const diffCache = new Map(); // key -> { beatmap, attrs, data, maxScore, difficulty }
// PlayBeatmap objects are shared between cache entries; applyMods() mutates them, so track what's applied.
const appliedMods = new WeakMap(); // PlayBeatmap -> key

function loadBeatmap(filePath) {
    const stat = fs.statSync(filePath);
    if (beatmapCache && beatmapCache.path === filePath && beatmapCache.mtime === stat.mtimeMs) {
        return beatmapCache;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    beatmapCache = { path: filePath, mtime: stat.mtimeMs, content, base: PlayBeatmap.parse(content) };
    beatmapPerMode.clear();
    diffCache.clear();
    return beatmapCache;
}

function beatmapForMode(mode) {
    const base = beatmapCache.base;
    if (mode == null || mode === base.mode) return base;
    if (beatmapPerMode.has(mode)) return beatmapPerMode.get(mode);

    // Only osu!standard maps can be converted to other rulesets.
    const converted = base.mode === 0 ? base.convert(mode) : undefined;
    const result = converted || base;
    beatmapPerMode.set(mode, result);
    return result;
}

function toLazerMods(mods) {
    return (mods || []).map((m) => ({
        acronym: String(m.acronym).toUpperCase(),
        settings: new Map(Object.entries(m.settings || {}))
    }));
}

function modsKey(mods) {
    return JSON.stringify(
        (mods || []).map((m) => [m.acronym, m.settings || {}]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    );
}

function prepare(filePath, mode, mods) {
    loadBeatmap(filePath);
    const beatmap = beatmapForMode(mode);
    const key = `${beatmap.mode}|${modsKey(mods)}`;

    const cached = diffCache.get(key);
    if (cached) {
        if (appliedMods.get(beatmap) !== key) {
            beatmap.applyMods(toLazerMods(mods));
            appliedMods.set(beatmap, key);
        }
        return cached;
    }

    beatmap.applyMods(toLazerMods(mods));
    appliedMods.set(beatmap, key);
    const gradual = beatmap.createGradualDifficulty();
    gradual.skipToEnd();
    const attrs = gradual.createDifficultyAttrs();
    const data = attrs.getData();

    const maxScore = { ...beatmap.createScore(1.0), maxCombo: data.maxCombo };
    const entry = {
        beatmap,
        ladder: effectiveLadder(beatmap, maxScore),
        windows: hitWindows(beatmap),
        attrs,
        data,
        maxScore,
        difficulty: beatmap.getBeatmapDifficulty(),
        original: beatmap.getOriginalBeatmapDifficulty()
    };

    if (diffCache.size > 32) diffCache.clear();
    diffCache.set(key, entry);
    return entry;
}

function hitWindows(beatmap) {
    const windows = {};
    for (const [result, ms] of beatmap.createHitWindows().allAvailableWindows()) {
        windows[OsuHitResult[result]] = ms;
    }
    return windows;
}

/**
 * Judgement counts of a player whose hit errors follow `model` with scale `sigma` ms,
 * using the beatmap's real hit windows. Returns null if the ruleset has no timing judgements.
 */
// P(|error| <= w) for hit error models with scale `s`. Real hit errors are heavy-tailed, which a
// Laplace distribution fits far better than a normal one.
const ERROR_MODELS = {
    laplace: (w, s) => 1 - Math.exp(-w / s)
};

function timedCounts(entry, hits, sigma, model) {
    const slots = TIMED[entry.beatmap.mode];
    if (!slots || slots.some(([, r]) => !entry.windows[r])) return null;
    const errorCdf = ERROR_MODELS[model];
    const cdf = (w) => errorCdf(w, sigma);
    const last = cdf(entry.windows[slots[slots.length - 1][1]]);

    // Fractions conditioned on the note being hit (misses are given separately).
    let prev = 0;
    const parts = slots.map(([field, result]) => {
        const c = cdf(entry.windows[result]);
        const frac = (c - prev) / last;
        prev = c;
        return { field, exact: frac * hits };
    });

    // Largest remainder rounding so counts sum to `hits`.
    let total = 0;
    for (const p of parts) {
        p.count = Math.floor(p.exact);
        total += p.count;
    }
    parts
        .slice()
        .sort((a, b) => b.exact - b.count - (a.exact - a.count))
        .slice(0, hits - total)
        .forEach((p) => p.count++);
    return parts;
}

/** Score for `target` accuracy by searching the hit error deviation; null if not applicable. */
function timedScore(entry, base, hitsPool, target, model) {
    const { beatmap } = entry;
    const build = (sigma) => {
        const parts = timedCounts(entry, hitsPool, sigma, model);
        if (!parts) return null;
        const score = { ...base };
        for (const p of parts) score[p.field] = p.count;
        return score;
    };
    if (!build(1)) return null;

    let lo = 0.01;
    let hi = 1000;
    for (let i = 0; i < 60; i++) {
        const mid = Math.sqrt(lo * hi);
        if (beatmap.calculateAccuracy(build(mid)) > target) lo = mid;
        else hi = mid;
    }
    const a = build(lo);
    const b = build(hi);
    return Math.abs(beatmap.calculateAccuracy(a) - target) <= Math.abs(beatmap.calculateAccuracy(b) - target) ? a : b;
}

/**
 * Drop ladder stages that don't change accuracy for this beatmap + mods (e.g. perfect -> great
 * with Classic in mania, where both count as 300), rerouting the next stage to take from the
 * dropped stage's source instead.
 */
function effectiveLadder(beatmap, maxScore) {
    const ladder = [];
    let reroute = null; // [skippedFrom, skippedTo]
    for (const stage of LADDERS[beatmap.mode]) {
        let [from, to, fraction] = stage;
        if (reroute && from === reroute[1]) from = reroute[0];
        reroute = null;

        if (maxScore[from] > 0) {
            const probe = { ...maxScore };
            probe[from] -= 1;
            probe[to] += 1;
            if (beatmap.calculateAccuracy(probe) >= beatmap.calculateAccuracy(maxScore) - 1e-12) {
                reroute = [from, to];
                continue;
            }
        }
        ladder.push([from, to, fraction]);
    }
    return ladder;
}

// Apply `steps` demotions along the ruleset ladder to `base` (mutates a copy).
function demote(ladder, base, steps) {
    const score = { ...base };
    let left = steps;
    for (const [from, to, fraction] of ladder) {
        if (left <= 0) break;
        const available = fraction ? Math.floor(base[from] * fraction) : score[from];
        const n = Math.min(left, available);
        score[from] -= n;
        score[to] += n;
        left -= n;
    }
    return score;
}

function maxSteps(ladder, base) {
    // Upper bound of demotions: every ladder step can at most move all judgements once.
    let total = 0;
    let carry = 0;
    for (const [from, , fraction] of ladder) {
        const available = fraction ? Math.floor(base[from] * fraction) : base[from] + carry;
        total += available;
        carry = available;
    }
    return total;
}

function buildScore(entry, { accuracy, combo, misses, distribution }) {
    const { beatmap, maxScore } = entry;
    const mode = beatmap.mode;

    const source = MISS_SOURCE[mode];
    const missCount = Math.max(0, Math.min(Math.floor(misses || 0), maxScore[source]));

    const base = { ...maxScore };
    base[source] -= missCount;
    // Slider ends/ticks stay hit: lazer estimates slider breaks from combo instead.
    base.misses += missCount;

    const target = accuracy == null ? 1 : Math.max(0, Math.min(1, accuracy));

    const dist = distribution || DEFAULT_DISTRIBUTION[mode];
    const timed = dist in ERROR_MODELS ? timedScore(entry, base, maxScore[source] - missCount, target, dist) : null;
    if (timed) return finishScore(entry, timed, combo);

    const { ladder } = entry;
    const evalAcc = (steps) => beatmap.calculateAccuracy(demote(ladder, base, steps));

    let lo = 0;
    let hi = maxSteps(ladder, base);
    // Find the smallest step count whose accuracy is <= target.
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (evalAcc(mid) > target + 1e-12) lo = mid + 1;
        else hi = mid;
    }
    let steps = lo;
    if (steps > 0 && Math.abs(evalAcc(steps - 1) - target) < Math.abs(evalAcc(steps) - target)) {
        steps -= 1;
    }

    return finishScore(entry, demote(ladder, base, steps), combo);
}

function finishScore(entry, score, combo) {
    const { beatmap } = entry;
    const maxCombo = entry.data.maxCombo;
    score.maxCombo = combo == null ? maxCombo : Math.max(0, Math.min(Math.floor(combo), maxCombo));
    score.accuracy = beatmap.calculateAccuracy(score);
    score.isLegacyScore = false;
    score.totalScore = 0;
    return score;
}

function perf(entry, score) {
    return entry.beatmap.calculatePerformance(entry.attrs, score);
}

function round(n, digits = 2) {
    const p = 10 ** digits;
    return Math.round((n || 0) * p) / p;
}

/**
 * @param {{ path: string, mode?: number, mods?: {acronym: string, settings?: object}[],
 *           accuracy?: number, combo?: number, misses?: number }} req accuracy is 0..100
 */
function calculate(req) {
    const entry = prepare(req.path, req.mode, req.mods);
    const { beatmap, data, difficulty, original } = entry;

    const accuracy = req.accuracy == null ? 1 : req.accuracy / 100;
    const dist = req.distribution;
    const score = buildScore(entry, { accuracy, combo: req.combo, misses: req.misses, distribution: dist });
    const current = perf(entry, score);

    const fcScore = buildScore(entry, { accuracy, combo: null, misses: 0, distribution: dist });
    const fc = perf(entry, fcScore);

    const table = [100, 99, 98, 97, 95].map((acc) => ({
        acc,
        pp: round(perf(entry, buildScore(entry, { accuracy: acc / 100, combo: null, misses: 0, distribution: dist })).pp)
    }));

    return {
        mode: beatmap.mode,
        modeName: MODE_NAMES[beatmap.mode],
        stars: round(data.stars),
        maxCombo: data.maxCombo,
        objects: { circles: data.nCircles, sliders: data.nSliders, spinners: data.nSpinners },
        skills: {
            aim: round(data.aim),
            speed: round(data.speed),
            flashlight: round(data.flashlight),
            reading: round(data.reading),
            stamina: round(data.stamina),
            rhythm: round(data.rhythm),
            color: round(data.color)
        },
        difficulty: {
            ar: round(difficulty.approachRate),
            cs: round(difficulty.circleSize),
            od: round(difficulty.overallDifficulty),
            hp: round(difficulty.drainRate)
        },
        original: {
            ar: round(original.approachRate),
            cs: round(original.circleSize),
            od: round(original.overallDifficulty),
            hp: round(original.drainRate)
        },
        score: {
            accuracy: round(score.accuracy * 100, 2),
            combo: score.maxCombo,
            misses: score.misses,
            hits: {
                perfect: score.perfects,
                great: score.greats,
                good: score.goods,
                ok: score.oks,
                meh: score.mehs,
                miss: score.misses,
                sliderEnds: score.sliderEndHits,
                largeTicks: score.largeTickHits,
                smallTicks: score.smallTickHits,
                smallTickMisses: score.smallTickMisses
            }
        },
        pp: {
            total: round(current.pp),
            aim: round(current.aim),
            speed: round(current.speed),
            accuracy: round(current.accuracy),
            flashlight: round(current.flashlight),
            reading: round(current.reading),
            difficulty: round(current.ppDifficulty),
            effectiveMissCount: round(current.effectiveMissCount)
        },
        fcPP: round(fc.pp),
        fcAccuracy: round(fcScore.accuracy * 100),
        table
    };
}

module.exports = { calculate };
