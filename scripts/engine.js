// engine.js — 從 index.html 原封不動移植過來的「純運算」部分
// （不含任何 DOM / UI 程式碼），負責算出 SMC Entry / The Hunt Entry / smoc Devour
// 三套系統目前最新的訊號。跟前端 index.html 裡的邏輯必須保持一致 ——
// 如果之後在前端調整了這幾個函式的規則，這裡也要跟著改，不然背景推播跟
// 網頁上看到的訊號會兜不起來。

// Binance 官方有 fapi.binance.com / fapi1 / fapi2 三個對外網址（互為備援）。
// Cloudflare Workers 的對外 IP 常被 fapi.binance.com 的防護系統直接擋掉（403），
// 依序嘗試備援網址，任何一個能通就用那個。
const API_HOSTS = [
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi.binance.com',
];
const KLINES_PATH = '/fapi/v1/klines';

export async function fetchJSON(url) {
  const bust = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${bust}_=${Date.now()}`, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function fetchKlines(symbol, interval, limit) {
  let lastErr = null;
  for (const host of API_HOSTS) {
    try {
      const json = await fetchJSON(`${host}${KLINES_PATH}?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!Array.isArray(json)) throw new Error('unexpected kline response shape');
      const parsed = json.map(row => ({
        t: +row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], v: +row[5],
      }));
      parsed.sort((a, b) => a.t - b.t);
      return parsed;
    } catch (e) {
      lastErr = e;
      // 這個網址失敗，換下一個試試看
    }
  }
  throw lastErr;
}

// core structure + FVG engine — 跟 index.html 的 runEngine 完全一樣
export function runEngine(candles, opts) {
  const swingLen = opts.swingLen ?? 50;
  const internalLen = opts.internalLen ?? 5;
  const maxZones = opts.maxZones ?? 5;
  const autoThreshold = opts.autoThreshold ?? true;
  const entryUseThreshold = opts.entryUseThreshold ?? false;
  const n = candles.length;
  const highs = candles.map(c => c.h), lows = candles.map(c => c.l),
        closes = candles.map(c => c.c), opens = candles.map(c => c.o);

  function highestWindow(i, size) { let m = -Infinity; for (let j = Math.max(0, i - size + 1); j <= i; j++) m = Math.max(m, highs[j]); return m; }
  function lowestWindow(i, size) { let m = Infinity; for (let j = Math.max(0, i - size + 1); j <= i; j++) m = Math.min(m, lows[j]); return m; }

  function legSeries(size) {
    const leg = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      leg[i] = leg[i - 1];
      if (i - size >= 0) {
        const newHigh = highs[i - size] > highestWindow(i, size);
        const newLow = lows[i - size] < lowestWindow(i, size);
        if (newHigh) leg[i] = 0; else if (newLow) leg[i] = 1;
      }
    }
    return leg;
  }

  const swingLeg = legSeries(swingLen);
  const intLeg = legSeries(Math.min(internalLen, Math.max(2, n - 1)));

  let swingHigh = null, swingLow = null, highCrossed = false, lowCrossed = false;
  let intHigh = null, intLow = null, intHighCrossed = false, intLowCrossed = false;
  let unifiedBias = 0;
  let cyberLongArmed = false, cyberShortArmed = false;
  let bullConfirmed = false, bearConfirmed = false, bullConfirmedBottom = null, bearConfirmedTop = null;
  let entryBullZones = [], entryBearZones = [];
  let cumAbsDelta = 0;
  const events = [];

  for (let i = 1; i < n; i++) {
    const newLegSwing = swingLeg[i] !== swingLeg[i - 1];
    const newLegInt = intLeg[i] !== intLeg[i - 1];

    if (newLegSwing) {
      if (swingLeg[i] === 1 && i - swingLen >= 0) { swingLow = lows[i - swingLen]; lowCrossed = false; }
      else if (i - swingLen >= 0) { swingHigh = highs[i - swingLen]; highCrossed = false; }
    }
    if (newLegInt) {
      const iLen = Math.min(internalLen, Math.max(2, n - 1));
      if (intLeg[i] === 1 && i - iLen >= 0) { intLow = lows[i - iLen]; intLowCrossed = false; }
      else if (i - iLen >= 0) { intHigh = highs[i - iLen]; intHighCrossed = false; }
    }

    const bullBreak = swingHigh != null && !highCrossed && closes[i - 1] <= swingHigh && closes[i] > swingHigh;
    const bearBreak = swingLow != null && !lowCrossed && closes[i - 1] >= swingLow && closes[i] < swingLow;
    if (bullBreak) highCrossed = true;
    if (bearBreak) lowCrossed = true;

    const intBullBreak = intHigh != null && !intHighCrossed && closes[i - 1] <= intHigh && closes[i] > intHigh;
    const intBearBreak = intLow != null && !intLowCrossed && closes[i - 1] >= intLow && closes[i] < intLow;
    if (intBullBreak) intHighCrossed = true;
    if (intBearBreak) intLowCrossed = true;

    const newBullStruct = bullBreak || intBullBreak;
    const newBearStruct = bearBreak || intBearBreak;

    if (newBullStruct) {
      unifiedBias = 1; cyberLongArmed = true; cyberShortArmed = false;
      bullConfirmed = false; bullConfirmedBottom = null; entryBullZones = [];
    }
    if (newBearStruct) {
      unifiedBias = -1; cyberShortArmed = true; cyberLongArmed = false;
      bearConfirmed = false; bearConfirmedTop = null; entryBearZones = [];
    }

    if (i >= 2 && opens[i - 1] !== 0) {
      const deltaPct = (closes[i - 1] - opens[i - 1]) / (opens[i - 1] * 100);
      cumAbsDelta += Math.abs(deltaPct);
      const displayThreshold = autoThreshold ? (cumAbsDelta / i * 2) : 0;
      const entryThreshold = entryUseThreshold ? displayThreshold : 0;
      const bullFvg = lows[i] > highs[i - 2] && closes[i - 1] > highs[i - 2] && deltaPct > entryThreshold;
      const bearFvg = highs[i] < lows[i - 2] && closes[i - 1] < lows[i - 2] && -deltaPct > entryThreshold;
      if (bullFvg) {
        entryBullZones.unshift({ top: lows[i], bottom: highs[i - 2], createdBar: i, touched: false });
        if (entryBullZones.length > maxZones) entryBullZones.pop();
      }
      if (bearFvg) {
        entryBearZones.unshift({ top: lows[i - 2], bottom: highs[i], createdBar: i, touched: false });
        if (entryBearZones.length > maxZones) entryBearZones.pop();
      }
    }

    const bodyHigh = Math.max(opens[i], closes[i]);
    const bodyLow = Math.min(opens[i], closes[i]);
    let entryLongHit = false, entryLongBottom = null;
    for (const z of entryBullZones) {
      const wickTouch = z.createdBar !== i && highs[i] >= z.bottom && lows[i] <= z.top;
      const bodyThroughBoth = bodyLow <= z.bottom && bodyHigh >= z.top;
      if (wickTouch) z.touched = true;
      if (wickTouch && !bodyThroughBoth) { entryLongHit = true; if (entryLongBottom == null) entryLongBottom = z.bottom; }
    }
    let entryShortHit = false, entryShortTop = null;
    for (const z of entryBearZones) {
      const wickTouch = z.createdBar !== i && highs[i] >= z.bottom && lows[i] <= z.top;
      const bodyThroughBoth = bodyLow <= z.bottom && bodyHigh >= z.top;
      if (wickTouch) z.touched = true;
      if (wickTouch && !bodyThroughBoth) { entryShortHit = true; if (entryShortTop == null) entryShortTop = z.top; }
    }

    const bullJustConfirmed = entryLongHit && !bullConfirmed;
    const bearJustConfirmed = entryShortHit && !bearConfirmed;
    if (entryLongHit) { bullConfirmed = true; if (bullJustConfirmed) bullConfirmedBottom = entryLongBottom; }
    if (entryShortHit) { bearConfirmed = true; if (bearJustConfirmed) bearConfirmedTop = entryShortTop; }

    if (bullConfirmed && bullConfirmedBottom != null && closes[i] < bullConfirmedBottom) {
      bullConfirmed = false; bullConfirmedBottom = null;
      entryBullZones = entryBullZones.filter(z => !z.touched);
    }
    if (bearConfirmed && bearConfirmedTop != null && closes[i] > bearConfirmedTop) {
      bearConfirmed = false; bearConfirmedTop = null;
      entryBearZones = entryBearZones.filter(z => !z.touched);
    }
    entryBullZones = entryBullZones.filter(z => closes[i] >= z.bottom);
    entryBearZones = entryBearZones.filter(z => closes[i] <= z.top);

    if (cyberLongArmed && unifiedBias === 1 && entryLongHit) {
      events.push({ index: i, time: candles[i].t, type: 'LONG', price: candles[i].c });
      cyberLongArmed = false;
    }
    if (cyberShortArmed && unifiedBias === -1 && entryShortHit) {
      events.push({ index: i, time: candles[i].t, type: 'SHORT', price: candles[i].c });
      cyberShortArmed = false;
    }
  }

  return { events };
}

function utcDayId(ts) { return Math.floor(ts / 86400000); }
function utcHour(ts) { return new Date(ts).getUTCHours(); }
function slotOf(ts, htfHours) { return Math.floor(utcHour(ts) / htfHours) + 1; }

// 跟 index.html 的 structureBreaks 完全一樣
export function structureBreaks(candles, swingLen, internalLen) {
  const n = candles.length;
  const highs = candles.map(c => c.h), lows = candles.map(c => c.l), closes = candles.map(c => c.c);
  function highestWindow(i, size) { let m = -Infinity; for (let j = Math.max(0, i - size + 1); j <= i; j++) m = Math.max(m, highs[j]); return m; }
  function lowestWindow(i, size) { let m = Infinity; for (let j = Math.max(0, i - size + 1); j <= i; j++) m = Math.min(m, lows[j]); return m; }
  function legSeries(size) {
    const leg = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      leg[i] = leg[i - 1];
      if (i - size >= 0) {
        const newHigh = highs[i - size] > highestWindow(i, size);
        const newLow = lows[i - size] < lowestWindow(i, size);
        if (newHigh) leg[i] = 0; else if (newLow) leg[i] = 1;
      }
    }
    return leg;
  }
  const swingLeg = legSeries(swingLen);
  const iLenFixed = Math.min(internalLen, Math.max(2, n - 1));
  const intLeg = legSeries(iLenFixed);

  let swingHigh = null, swingLow = null, highCrossed = false, lowCrossed = false;
  let intHigh = null, intLow = null, intHighCrossed = false, intLowCrossed = false;
  const bullBreakAt = new Array(n).fill(false);
  const bearBreakAt = new Array(n).fill(false);

  for (let i = 1; i < n; i++) {
    const newLegSwing = swingLeg[i] !== swingLeg[i - 1];
    const newLegInt = intLeg[i] !== intLeg[i - 1];
    if (newLegSwing) {
      if (swingLeg[i] === 1 && i - swingLen >= 0) { swingLow = lows[i - swingLen]; lowCrossed = false; }
      else if (i - swingLen >= 0) { swingHigh = highs[i - swingLen]; highCrossed = false; }
    }
    if (newLegInt) {
      if (intLeg[i] === 1 && i - iLenFixed >= 0) { intLow = lows[i - iLenFixed]; intLowCrossed = false; }
      else if (i - iLenFixed >= 0) { intHigh = highs[i - iLenFixed]; intHighCrossed = false; }
    }
    const bullBreak = swingHigh != null && !highCrossed && closes[i - 1] <= swingHigh && closes[i] > swingHigh;
    const bearBreak = swingLow != null && !lowCrossed && closes[i - 1] >= swingLow && closes[i] < swingLow;
    if (bullBreak) highCrossed = true;
    if (bearBreak) lowCrossed = true;
    const intBullBreak = intHigh != null && !intHighCrossed && closes[i - 1] <= intHigh && closes[i] > intHigh;
    const intBearBreak = intLow != null && !intLowCrossed && closes[i - 1] >= intLow && closes[i] < intLow;
    if (intBullBreak) intHighCrossed = true;
    if (intBearBreak) intLowCrossed = true;
    bullBreakAt[i] = bullBreak || intBullBreak;
    bearBreakAt[i] = bearBreak || intBearBreak;
  }
  return {
    bullBreakAt, bearBreakAt,
    current: {
      swingHigh: highCrossed ? null : swingHigh,
      swingLow: lowCrossed ? null : swingLow,
      internalHigh: intHighCrossed ? null : intHigh,
      internalLow: intLowCrossed ? null : intLow,
    },
  };
}

// 跟 index.html 的 runHuntEngine 完全一樣
export function runHuntEngine(ltfCandles, htfHours) {
  const n = ltfCandles.length;
  const maxSlot = htfHours === 4 ? 5 : 23;

  const htfGroups = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const c = ltfCandles[i];
    const slot = slotOf(c.t, htfHours);
    const dayId = utcDayId(c.t);
    const isNewSlot = !cur || slot !== cur.slot || dayId !== cur.dayId;
    if (isNewSlot) {
      if (cur) htfGroups.push(cur);
      cur = { slot, dayId, o: c.o, h: c.h, l: c.l, c: c.c, startIdx: i };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
  }
  if (cur) htfGroups.push(cur);

  const patternEvents = [];
  for (let g = 1; g < htfGroups.length - 1; g++) {
    const prev = htfGroups[g - 1], curr = htfGroups[g];
    if (curr.dayId !== prev.dayId) continue;
    if (curr.slot !== prev.slot + 1 || curr.slot > maxSlot) continue;

    const longPattern = prev.c < prev.o && curr.c > curr.o && curr.l < prev.l;
    const shortPattern = prev.c > prev.o && curr.c < curr.o && curr.h > prev.h;
    if (!longPattern && !shortPattern) continue;

    patternEvents.push({ index: htfGroups[g + 1].startIdx, dir: longPattern ? 1 : -1 });
  }

  const { bullBreakAt, bearBreakAt } = structureBreaks(ltfCandles, 50, 5);
  const events = [];
  let currentDir = 0;
  let armed = false;
  let lastDayId = null;
  let pIdx = 0;

  for (let k = 0; k < n; k++) {
    while (pIdx < patternEvents.length && patternEvents[pIdx].index <= k) {
      currentDir = patternEvents[pIdx].dir;
      armed = true;
      pIdx++;
    }

    const dayId = utcDayId(ltfCandles[k].t);
    if (lastDayId !== null && dayId !== lastDayId && armed) {
      currentDir = 0;
      armed = false;
    }
    lastDayId = dayId;

    if (armed) {
      const matched = currentDir === 1 ? bullBreakAt[k] : bearBreakAt[k];
      if (matched) {
        armed = false;
        if (k + 1 < n) {
          events.push({
            index: k + 1,
            time: ltfCandles[k + 1].t,
            type: currentDir === 1 ? 'HUNT_LONG' : 'HUNT_SHORT',
            price: ltfCandles[k + 1].c,
          });
        }
      }
    }
  }

  return { events };
}

// 跟 index.html 的 runDevourPair 完全一樣
export function runDevourPair(htfCandles, ltfCandles, thresholdPct = 0) {
  const nHtf = htfCandles.length;
  const zones = [];
  for (let i = 2; i < nHtf; i++) {
    const c0 = htfCandles[i - 2], c1 = htfCandles[i - 1], c2 = htfCandles[i];
    const bullGap = c2.l > c0.h && c1.c > c0.h && ((c2.l - c0.h) / c0.h) > thresholdPct;
    const bearGap = c2.h < c0.l && c1.c < c0.l && ((c0.l - c2.h) / c2.h) > thresholdPct;
    if (bullGap) {
      zones.push({ top: c2.l, bottom: c0.h, isbull: true, createdTime: c2.t, mitigated: false, confirmed: false });
    }
    if (bearGap) {
      zones.push({ top: c0.l, bottom: c2.h, isbull: false, createdTime: c2.t, mitigated: false, confirmed: false });
    }
  }

  const events = [];
  const m = ltfCandles.length;
  let zonePtr = 0;
  const activeZones = [];
  const intervalMs = m >= 2 ? (ltfCandles[1].t - ltfCandles[0].t) : 0;
  const now = Date.now();

  for (let k = 0; k < m; k++) {
    const bar = ltfCandles[k];
    while (zonePtr < zones.length && zones[zonePtr].createdTime <= bar.t) {
      activeZones.push(zones[zonePtr]);
      zonePtr++;
    }
    for (let zi = activeZones.length - 1; zi >= 0; zi--) {
      const z = activeZones[zi];
      if (z.mitigated || z.confirmed) continue;

      const touchedNow = bar.l <= z.top && bar.h >= z.bottom;
      if (touchedNow && k + 1 < m) {
        const next = ltfCandles[k + 1];
        const nextClosed = intervalMs > 0 ? (next.t + intervalMs) <= now : true;
        if (nextClosed) {
          const bullEngulf = bar.c < bar.o && next.c > bar.o;
          const bearEngulf = bar.c > bar.o && next.c < bar.o;
          if (z.isbull && bullEngulf) {
            events.push({ time: next.t, type: 'DEVOUR_LONG', price: next.c, zoneTop: z.top, zoneBottom: z.bottom, touchedAt: bar.t, zoneCreatedAt: z.createdTime });
            z.confirmed = true;
          } else if (!z.isbull && bearEngulf) {
            events.push({ time: next.t, type: 'DEVOUR_SHORT', price: next.c, zoneTop: z.top, zoneBottom: z.bottom, touchedAt: bar.t, zoneCreatedAt: z.createdTime });
            z.confirmed = true;
          }
        }
      }

      if (z.isbull) {
        if (bar.c < z.bottom) z.mitigated = true;
      } else {
        if (bar.c > z.top) z.mitigated = true;
      }
    }
  }

  return { events };
}

function smcHuntSignalLabel(sig, isHunt) {
  const isLong = sig.type.includes('LONG');
  return isHunt
    ? (isLong ? '🏹 獵殺做多' : '🏹 獵殺做空')
    : (isLong ? '▲ 做多訊號' : '▼ 做空訊號');
}

function devourShortLabel(sig) {
  return sig.type === 'DEVOUR_LONG' ? '📈 看漲吞噬訊號' : '📉 看跌吞噬訊號';
}

export function sigFingerprint(sig) {
  return sig ? `${sig.type}:${sig.time}` : '_';
}

// 跟 index.html 的 buildCategories 完全一樣 —— 判斷「有沒有新訊號」的比對單位
export function buildCategories(d) {
  const smcLine = (tf, sig) => sig ? `${tf} ${smcHuntSignalLabel(sig, false)}` : null;
  const huntLine = (tf, sig) => sig ? `${tf} ${smcHuntSignalLabel(sig, true)}` : null;
  const devourLine = (tf, sig) => sig ? `${tf} ${devourShortLabel(sig)}` : null;

  return [
    {
      name: 'SMC Entry',
      sigs: [d.last15Signal, d.last5Signal],
      lines: [smcLine('15m', d.last15Signal), smcLine('5m', d.last5Signal)].filter(Boolean),
    },
    {
      name: 'The Hunt Entry',
      sigs: [d.last15Hunt, d.last5Hunt],
      lines: [huntLine('15m', d.last15Hunt), huntLine('5m', d.last5Hunt)].filter(Boolean),
    },
    {
      name: 'smoc Devour',
      sigs: [d.last4hDevour, d.last1hDevour, d.last15m5mDevour],
      lines: [
        devourLine('4H', d.last4hDevour),
        devourLine('1H', d.last1hDevour),
        devourLine('15m/5m', d.last15m5mDevour),
      ].filter(Boolean),
    },
  ];
}

// 只算「三套通知系統」需要的最新訊號，不算卡片上其他顯示用的東西（燈號、評分等），
// 保持後端運算量最小。
export async function loadSignalSnapshot(symbol) {
  const [k15, k5, k1h, k4h] = await Promise.all([
    fetchKlines(symbol, '15m', 1000),
    fetchKlines(symbol, '5m', 1000),
    fetchKlines(symbol, '1h', 500),
    fetchKlines(symbol, '4h', 500),
  ]);

  const eng15 = runEngine(k15, { swingLen: 50, internalLen: 5, maxZones: 5 });
  const eng5 = runEngine(k5, { swingLen: 50, internalLen: 5, maxZones: 5 });
  const last15Signal = eng15.events[eng15.events.length - 1] || null;
  const last5Signal = eng5.events[eng5.events.length - 1] || null;

  const hunt15 = runHuntEngine(k15, 4);
  const hunt5 = runHuntEngine(k5, 1);
  const last15Hunt = hunt15.events[hunt15.events.length - 1] || null;
  const last5Hunt = hunt5.events[hunt5.events.length - 1] || null;

  const devour4h = runDevourPair(k4h, k4h);
  const devour1h = runDevourPair(k1h, k1h);
  const devour15m5m = runDevourPair(k15, k5);
  const last4hDevour = devour4h.events[devour4h.events.length - 1] || null;
  const last1hDevour = devour1h.events[devour1h.events.length - 1] || null;
  const last15m5mDevour = devour15m5m.events[devour15m5m.events.length - 1] || null;

  return {
    symbol,
    last15Signal, last5Signal,
    last15Hunt, last5Hunt,
    last4hDevour, last1hDevour, last15m5mDevour,
  };
}
