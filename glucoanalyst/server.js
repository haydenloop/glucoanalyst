require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

console.log('ENV CHECK:', {
  hasClientId: !!process.env.DEXCOM_CLIENT_ID,
  hasClientSecret: !!process.env.DEXCOM_CLIENT_SECRET,
  hasRedirectUri: !!process.env.DEXCOM_REDIRECT_URI,
  hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
  port: process.env.PORT
});

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder' });
const TOKENS_FILE = path.join('/tmp', 'tokens.json');

let tokens = {};
if (fs.existsSync(TOKENS_FILE)) {
  try {
    tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    console.log('Loaded saved Dexcom tokens ✓');
  } catch (e) { tokens = {}; }
}

function renderPage(content) {
  const template = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  return template.replace('PAGE_CONTENT', content);
}

function getDateRangeLabel() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

app.get('/auth/login', (req, res) => {
  const authUrl = `https://sandbox-api.dexcom.com/v2/oauth2/login?` +
    `client_id=${process.env.DEXCOM_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.DEXCOM_REDIRECT_URI)}` +
    `&response_type=code&scope=offline_access`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await axios.post(
      'https://sandbox-api.dexcom.com/v2/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DEXCOM_CLIENT_ID,
        client_secret: process.env.DEXCOM_CLIENT_SECRET,
        code, grant_type: 'authorization_code',
        redirect_uri: process.env.DEXCOM_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens = response.data;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    console.log('Dexcom tokens saved ✓');
    res.redirect('/');
  } catch (err) { res.send('Auth failed: ' + err.message); }
});

async function refreshIfNeeded() {
  if (!tokens.refresh_token) return null;
  try {
    const response = await axios.post(
      'https://sandbox-api.dexcom.com/v2/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DEXCOM_CLIENT_ID,
        client_secret: process.env.DEXCOM_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (e) { return null; }
}

async function getGlucoseData() {
  try {
    const refreshed = await refreshIfNeeded();
    if (refreshed) tokens = refreshed;
  } catch (e) { console.log('Token refresh failed:', e.message); }
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const fmt = (d) => d.toISOString().split('.')[0];
  const response = await axios.get(
    'https://sandbox-api.dexcom.com/v3/users/self/egvs',
    {
      params: { startDate: fmt(start), endDate: fmt(end) },
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }
  );
  const readings = response.data.egvs || response.data.records || response.data || [];
  console.log(`Fetched ${readings.length} readings ✓`);
  return readings;
}

function calcTimeInRange(readings) {
  if (!readings.length) return 0;
  return Math.round(readings.filter(r => r.value >= 70 && r.value <= 180).length / readings.length * 100);
}

function getBestDayData(readings) {
  const byDay = {};
  readings.forEach(r => {
    const day = r.displayTime.split('T')[0];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(r);
  });
  let bestDay = null, bestTIR = -1;
  Object.entries(byDay).forEach(([day, rs]) => {
    const tir = calcTimeInRange(rs);
    if (tir > bestTIR) { bestTIR = tir; bestDay = day; }
  });
  if (!bestDay) return null;
  const rs = byDay[bestDay];
  const avg = Math.round(rs.reduce((a,b) => a + b.value, 0) / rs.length);
  const peak = Math.max(...rs.map(r => r.value));
  const date = new Date(bestDay + 'T12:00:00');
  const label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return { readings: rs, tir: bestTIR, avg, peak, label };
}

function getReadingsForHourWindow(readings, startHour, endHour) {
  return readings.filter(r => {
    const h = new Date(r.displayTime).getHours();
    if (startHour <= endHour) return h >= startHour && h < endHour;
    return h >= startHour || h < endHour;
  }).slice(-48);
}

function buildSparkline(readings, color, showTarget) {
  if (!readings || readings.length < 2) return '';
  const times = readings.map(r => new Date(r.displayTime));
  const minV = 40, maxV = 280, W = 320, H = 56, pad = 4;
  const scaleY = (v) => H - pad - ((v - minV) / (maxV - minV)) * (H - pad * 2);
  const minT = Math.min(...times.map(t => t.getTime()));
  const maxT = Math.max(...times.map(t => t.getTime()));
  const scaleX = (t) => ((t.getTime() - minT) / (maxT - minT || 1)) * (W - pad * 2) + pad;
  const points = readings.map(r => ({ x: scaleX(new Date(r.displayTime)), y: scaleY(r.value) }));
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const cpx = (points[i-1].x + points[i].x) / 2;
    d += ` C ${cpx} ${points[i-1].y}, ${cpx} ${points[i].y}, ${points[i].x} ${points[i].y}`;
  }
  const areaD = d + ` L ${points[points.length-1].x} ${H} L ${points[0].x} ${H} Z`;
  const fmtTime = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const targetTop = scaleY(180), targetBot = scaleY(70);
  const targetBand = showTarget ? `
    <rect x="${pad}" y="${targetTop}" width="${W-pad*2}" height="${targetBot-targetTop}" fill="rgba(45,106,79,0.06)" rx="2"/>
    <line x1="${pad}" y1="${targetTop}" x2="${W-pad}" y2="${targetTop}" stroke="rgba(45,106,79,0.2)" stroke-width="0.5" stroke-dasharray="3,3"/>
    <line x1="${pad}" y1="${targetBot}" x2="${W-pad}" y2="${targetBot}" stroke="rgba(45,106,79,0.2)" stroke-width="0.5" stroke-dasharray="3,3"/>` : '';
  const gradId = `g${Math.random().toString(36).substr(2,6)}`;
  return `<div class="sparkline-wrap">
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${targetBand}
      <path d="${areaD}" fill="url(#${gradId})"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="sparkline-times"><span>${fmtTime(times[0])}</span><span>${fmtTime(times[times.length-1])}</span></div>
  </div>`;
}

function getMostVariableReadings(readings) {
  const byHour = {};
  readings.forEach(r => {
    const h = new Date(r.displayTime).getHours();
    if (!byHour[h]) byHour[h] = [];
    byHour[h].push(r.value);
  });
  let worstHour = 18, worstVariance = 0;
  Object.entries(byHour).forEach(([h, vals]) => {
    const mean = vals.reduce((a,b) => a+b, 0) / vals.length;
    const variance = vals.reduce((a,b) => a + Math.pow(b-mean,2), 0) / vals.length;
    if (variance > worstVariance) { worstVariance = variance; worstHour = parseInt(h); }
  });
  return getReadingsForHourWindow(readings, worstHour, (worstHour + 4) % 24);
}

function parseAnalysis(text) {
  const s = {};
  const w = text.match(/\*\*WEEK IN ONE SENTENCE\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const sc = text.match(/\*\*YOUR SCORE:\s*(\d+)\/100\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const b = text.match(/\*\*BEST MOMENT\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const wt = text.match(/\*\*WATCH THIS\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const v = text.match(/\*\*MOST VARIABLE WINDOW\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  s.week = w ? w[1].trim() : '';
  s.score = sc ? parseInt(sc[1]) : 50;
  s.scoreDesc = sc ? sc[2].trim() : '';
  s.best = b ? b[1].trim() : '';
  s.watch = wt ? wt[1].trim() : '';
  s.variable = v ? v[1].trim() : '';
  return s;
}

async function analyseWithAI(readings) {
  const tir = calcTimeInRange(readings);
  const summary = readings.map(r => `${r.displayTime}: ${r.value} mg/dL (${r.trend})`).join('\n');
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a personal diabetes analyst for a Type 1 diabetic.

Here are their CGM readings from the last 7 days:
${summary}

Their calculated time in range (70-180 mg/dL) is ${tir}%.

Respond in this exact format, keep every section to 1-2 lines maximum:

**WEEK IN ONE SENTENCE**
One sentence only. How was the week overall?

**YOUR SCORE: X/100**
Give a score based on time in range and stability.

**BEST MOMENT**
One specific time/day that looked great and why. One sentence.

**WATCH THIS**
The single most important pattern to be aware of. One sentence.

**MOST VARIABLE WINDOW**
The one time window that showed the most swings. One sentence.

Keep the entire response under 150 words. Plain English. No bullet sub-lists. No medical advice.`
    }]
  });
  return message.content[0].text;
}

app.get('/', (req, res) => {
  if (!tokens.access_token) {
    const content = `
      <div class="connect-page">
        <div class="brand-row"><div class="brand-dot"></div><div class="brand-wordmark">GlucoAnalyst</div></div>
        <h1 class="hero-headline">Your glucose data,<br><em>finally explained.</em></h1>
        <p class="hero-sub">Connect your Dexcom CGM and get a plain-English AI analysis of your patterns — every week.</p>
        <a href="/auth/login" class="connect-btn">Connect Dexcom →</a>
        <p class="privacy-note">🔒 Secure OAuth connection. Your data never leaves your device unencrypted.</p>
        <div class="rule"></div>
        <div class="features-row">
          <div class="feature-item"><div class="feature-num">7</div><div class="feature-title">Days analysed</div><div class="feature-desc">Every 5-min reading reviewed</div></div>
          <div class="feature-item"><div class="feature-num">AI</div><div class="feature-title">Pattern detection</div><div class="feature-desc">Spots trends you'd never see</div></div>
          <div class="feature-item"><div class="feature-num">0</div><div class="feature-title">Medical jargon</div><div class="feature-desc">Plain English. Always.</div></div>
        </div>
      </div>`;
    return res.send(renderPage(content));
  }
  const content = `
    <div class="home-page">
      <div class="top-bar">
        <div class="top-wordmark"><div style="width:8px;height:8px;background:#2d6a4f;border-radius:50%;flex-shrink:0"></div>GlucoAnalyst</div>
        <div class="connected-badge"><div class="connected-dot"></div>Dexcom connected</div>
      </div>
      <h1 class="home-headline">${getGreeting()}.<br><em>Ready for your analysis?</em></h1>
      <p class="home-sub">Your last 7 days of CGM data is ready to be analysed. Takes about 20 seconds.</p>
      <a href="/analyse" class="analyse-btn">
        <div><div class="analyse-btn-label">Analyse my last 7 days</div><div class="analyse-btn-sub">${getDateRangeLabel()} · ~2,016 readings</div></div>
        <div class="analyse-btn-arrow">→</div>
      </a>
      <div class="meta-grid">
        <div class="meta-cell"><div class="meta-label">Device</div><div class="meta-value">Dexcom G7</div><div class="meta-sub">CGM system</div></div>
        <div class="meta-cell"><div class="meta-label">AI Model</div><div class="meta-value">Claude</div><div class="meta-sub">Sonnet 4.6</div></div>
        <div class="meta-cell"><div class="meta-label">Frequency</div><div class="meta-value">5 min</div><div class="meta-sub">Per reading</div></div>
        <div class="meta-cell"><div class="meta-label">Period</div><div class="meta-value">7 days</div><div class="meta-sub">${getDateRangeLabel()}</div></div>
      </div>
    </div>`;
  res.send(renderPage(content));
});

app.get('/analyse', (req, res) => {
  const content = `
    <div class="loading-page">
      <div class="loading-wordmark"><div style="width:6px;height:6px;background:#2d6a4f;border-radius:50%"></div>GlucoAnalyst</div>
      <h2 class="loading-headline">Analysing your<br><em>week in review.</em></h2>
      <p class="loading-sub">Fetching readings and running AI analysis…</p>
      <div class="progress-track"><div class="progress-fill"></div></div>
      <div class="loading-steps">
        <div class="loading-step">Connecting to Dexcom</div>
        <div class="loading-step">Fetching glucose readings</div>
        <div class="loading-step">Running AI analysis</div>
        <div class="loading-step">Building your report</div>
      </div>
    </div>
    <script>setTimeout(() => { window.location.href = '/results'; }, 1000);</script>`;
  res.send(renderPage(content));
});

app.get('/results', async (req, res) => {
  try {
    const readings = await getGlucoseData();
    const rawAnalysis = await analyseWithAI(readings);
    const s = parseAnalysis(rawAnalysis);
    const dateRange = getDateRangeLabel();
    const tir = calcTimeInRange(readings);
    const tirColor = tir >= 70 ? '#2d6a4f' : tir >= 50 ? '#b45309' : '#9f1239';
    const bestDay = getBestDayData(readings);
    const bestDayGraph = bestDay ? buildSparkline(bestDay.readings, '#2d6a4f', true) : '';
    const overnightReadings = getReadingsForHourWindow(readings, 22, 6);
    const variableReadings = getMostVariableReadings(readings);
    const watchGraph = buildSparkline(overnightReadings, '#b45309', true);
    const variableGraph = buildSparkline(variableReadings, '#1e40af', false);
    const scoreColor = s.score >= 70 ? '#2d6a4f' : s.score >= 50 ? '#b45309' : '#9f1239';
    const scoreLabel = s.score >= 70 ? '<em>Good</em> week' : s.score >= 50 ? '<em>Mixed</em> week' : '<em>Tough</em> week';
    const content = `
      <div class="results-page">
        <div class="results-topbar">
          <a href="/" class="back-link">← Back</a>
          <span class="results-badge">${dateRange}</span>
        </div>
        <h1 class="results-headline">Your week<br>in <em>review.</em></h1>
        <div class="score-tir-row">
          <div class="score-block">
            <div class="score-ring-wrap">
              <svg viewBox="0 0 80 80" width="80" height="80">
                <circle class="score-ring-bg" cx="40" cy="40" r="34"/>
                <circle class="score-ring-fill" cx="40" cy="40" r="34" style="stroke:${scoreColor}"/>
              </svg>
              <div class="score-center">
                <div class="score-num" style="color:${scoreColor}">${s.score}</div>
                <div class="score-denom">/ 100</div>
              </div>
            </div>
            <div class="score-right">
              <div class="score-label">${scoreLabel}</div>
              <div class="score-desc">${s.week}</div>
            </div>
          </div>
          <div class="tir-block">
            <div class="tir-header">
              <span class="tir-label">Time in Range</span>
              <span class="tir-num" style="color:${tirColor}">${tir}%</span>
            </div>
            <div class="tir-track"><div class="tir-fill" style="width:${tir}%;background:${tirColor}"></div></div>
            <div class="tir-legend"><span>0%</span><span>Target: 70%+</span><span>100%</span></div>
            <div class="tir-breakdown">
              <div class="tir-breakdown-item"><div class="tir-bd-dot" style="background:#2d6a4f"></div><span>In range (70–180)</span><strong>${tir}%</strong></div>
              <div class="tir-breakdown-item"><div class="tir-bd-dot" style="background:#b45309"></div><span>Above range</span><strong>${Math.round(readings.filter(r=>r.value>180).length/readings.length*100)}%</strong></div>
              <div class="tir-breakdown-item"><div class="tir-bd-dot" style="background:#9f1239"></div><span>Below range</span><strong>${Math.round(readings.filter(r=>r.value<70).length/readings.length*100)}%</strong></div>
            </div>
          </div>
        </div>
        ${bestDay ? `
        <div class="best-day-block">
          <div class="best-day-header">
            <div>
              <div class="insights-heading" style="margin:0 0 2px">Best day this week</div>
              <div class="best-day-date">${bestDay.label}</div>
            </div>
            <div class="best-day-stats">
              <div class="bd-stat"><div class="bd-stat-val" style="color:#2d6a4f">${bestDay.tir}%</div><div class="bd-stat-lbl">Time in range</div></div>
              <div class="bd-stat"><div class="bd-stat-val">${bestDay.avg}</div><div class="bd-stat-lbl">Avg mg/dL</div></div>
              <div class="bd-stat"><div class="bd-stat-val">${bestDay.peak}</div><div class="bd-stat-lbl">Peak</div></div>
            </div>
          </div>
          ${bestDayGraph}
        </div>` : ''}
        <div class="insights-heading">This week's insights</div>
        <div class="insight-card positive"><div class="insight-type">Best moment</div><div class="insight-text">${s.best}</div></div>
        <div class="insight-card warning"><div class="insight-type">Watch this</div><div class="insight-text">${s.watch}</div>${watchGraph}</div>
        <div class="insight-card info"><div class="insight-type">Most variable window</div><div class="insight-text">${s.variable}</div>${variableGraph}</div>
        ${s.scoreDesc ? `<div class="insight-card alert"><div class="insight-type">Score breakdown</div><div class="insight-text">${s.scoreDesc}</div></div>` : ''}
        <div class="bottom-area">
          <a href="/" class="run-again-btn">← Run new analysis</a>
          <p class="disclaimer">For informational purposes only. Not a substitute for medical advice.</p>
        </div>
      </div>`;
    res.send(renderPage(content));
  } catch (err) {
    console.error(err);
    res.send(renderPage(`
      <div class="connect-page">
        <div class="brand-row"><div class="brand-dot"></div><div class="brand-wordmark">GlucoAnalyst</div></div>
        <h2 style="font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:400;margin-bottom:12px">Something went wrong.</h2>
        <p style="color:var(--muted);font-size:14px;margin-bottom:32px;font-weight:300">${err.message}</p>
        <a href="/" class="connect-btn">← Try again</a>
      </div>`));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`GlucoAnalyst running on port ${PORT}`);
});
