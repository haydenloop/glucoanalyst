require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOKENS_FILE = 'tokens.json';

let tokens = {};
if (fs.existsSync(TOKENS_FILE)) {
  try {
    tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    console.log('Loaded saved Dexcom tokens ✓');
  } catch (e) {
    tokens = {};
  }
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

app.get('/auth/login', (req, res) => {
  const authUrl = `https://sandbox-api.dexcom.com/v2/oauth2/login?` +
    `client_id=${process.env.DEXCOM_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.DEXCOM_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=offline_access`;
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
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.DEXCOM_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens = response.data;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    console.log('Dexcom tokens saved ✓');
    res.redirect('/');
  } catch (err) {
    res.send('Auth failed: ' + err.message);
  }
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
    console.log('Tokens refreshed ✓');
    return response.data;
  } catch (e) {
    return null;
  }
}

async function getGlucoseData() {
  try {
    const refreshed = await refreshIfNeeded();
    if (refreshed) tokens = refreshed;
  } catch (e) {
    console.log('Token refresh failed:', e.message);
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const fmt = (d) => d.toISOString().split('.')[0];

  const response = await axios.get(
    `https://sandbox-api.dexcom.com/v3/users/self/egvs`,
    {
      params: { startDate: fmt(start), endDate: fmt(end) },
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }
  );

  const readings = response.data.egvs || response.data.records || response.data || [];
  console.log(`Fetched ${readings.length} glucose readings ✓`);
  return readings;
}

function parseAnalysis(text) {
  const sections = {};
  const weekMatch = text.match(/\*\*WEEK IN ONE SENTENCE\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const scoreMatch = text.match(/\*\*YOUR SCORE:\s*(\d+)\/100\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const bestMatch = text.match(/\*\*BEST MOMENT\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const watchMatch = text.match(/\*\*WATCH THIS\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);
  const varMatch = text.match(/\*\*MOST VARIABLE WINDOW\*\*\s*\n([\s\S]*?)(?=\*\*|$)/);

  sections.week = weekMatch ? weekMatch[1].trim() : '';
  sections.score = scoreMatch ? parseInt(scoreMatch[1]) : 50;
  sections.scoreDesc = scoreMatch ? scoreMatch[2].trim() : '';
  sections.best = bestMatch ? bestMatch[1].trim() : '';
  sections.watch = watchMatch ? watchMatch[1].trim() : '';
  sections.variable = varMatch ? varMatch[1].trim() : '';
  return sections;
}

async function analyseWithAI(readings) {
  const summary = readings.map(r =>
    `${r.displayTime}: ${r.value} mg/dL (${r.trend})`
  ).join('\n');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a personal diabetes analyst for a Type 1 diabetic.

Here are their CGM readings from the last 7 days:
${summary}

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
        <div class="logo-mark">📊</div>
        <h1 class="app-name">Gluco<em>Analyst</em></h1>
        <p class="app-tagline">Your personal AI diabetes trend analyst. Connect your Dexcom and get plain-English insights from your glucose data.</p>
        <a href="/auth/login" class="connect-btn">
          <span>📡</span> Connect Dexcom
        </a>
        <p class="privacy-note">🔒 Your data stays on your device. HIPAA-safe OAuth connection.</p>
        <div class="features-row">
          <div class="feature-card">
            <div class="feature-icon">🎯</div>
            <div class="feature-title">Weekly Score</div>
            <div class="feature-desc">Get a 0–100 stability score every week</div>
          </div>
          <div class="feature-card">
            <div class="feature-icon">🔍</div>
            <div class="feature-title">Pattern Analysis</div>
            <div class="feature-desc">AI spots recurring trends in your data</div>
          </div>
          <div class="feature-card">
            <div class="feature-icon">💬</div>
            <div class="feature-title">Plain English</div>
            <div class="feature-desc">No jargon. Just clear, useful insights</div>
          </div>
        </div>
      </div>
    `;
    return res.send(renderPage(content));
  }

  const content = `
    <div class="home-page">
      <div class="top-bar">
        <div class="top-bar-name">Gluco<em>Analyst</em></div>
        <div class="status-pill">
          <div class="status-dot"></div>
          DEXCOM CONNECTED
        </div>
      </div>
      <a href="/analyse" class="analyse-btn">
        🔬 Analyse My Last 7 Days
      </a>
      <div class="section-label">About This Analysis</div>
      <div class="info-grid">
        <div class="info-card">
          <div class="info-card-label">Data Range</div>
          <div class="info-card-value" style="font-size:18px">${getDateRangeLabel()}</div>
          <div class="info-card-sub">Last 7 days of CGM readings</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">AI Model</div>
          <div class="info-card-value" style="font-size:18px">Claude</div>
          <div class="info-card-sub">Sonnet 4.6 · Pattern analysis</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Reading Frequency</div>
          <div class="info-card-value" style="font-size:18px">5 min</div>
          <div class="info-card-sub">~2,016 readings per week</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Device</div>
          <div class="info-card-value" style="font-size:18px">G7</div>
          <div class="info-card-sub">Dexcom CGM system</div>
        </div>
      </div>
      <p style="font-size:12px;color:var(--muted);text-align:center;line-height:1.6;margin-top:8px">
        Analysis takes ~20 seconds. No medical advice is given.<br>
        Always consult your care team for treatment decisions.
      </p>
    </div>
  `;
  res.send(renderPage(content));
});

app.get('/analyse', async (req, res) => {
  const loadingContent = `
    <div class="loading-page">
      <div class="loading-icon">🔬</div>
      <div class="loading-title">Analysing your week</div>
      <div class="loading-sub">Fetching your CGM data and running AI analysis…</div>
      <div class="loading-bar-wrap">
        <div class="loading-bar"></div>
      </div>
      <div class="loading-steps">
        <div class="loading-step">Connecting to Dexcom…</div>
        <div class="loading-step">Fetching glucose readings…</div>
        <div class="loading-step">Running AI analysis…</div>
        <div class="loading-step">Building your report…</div>
      </div>
    </div>
    <script>
      setTimeout(() => { window.location.href = '/results'; }, 1000);
    </script>
  `;
  res.send(renderPage(loadingContent));
});

app.get('/results', async (req, res) => {
  try {
    const readings = await getGlucoseData();
    const rawAnalysis = await analyseWithAI(readings);
    const s = parseAnalysis(rawAnalysis);
    const dateRange = getDateRangeLabel();

    const scoreColor = s.score >= 70
      ? 'var(--accent)'
      : s.score >= 50
        ? 'var(--accent2)'
        : 'var(--accent3)';

    const scoreLabel = s.score >= 70
      ? 'Good Week'
      : s.score >= 50
        ? 'Mixed Week'
        : 'Tough Week';

    const content = `
      <div class="results-page">
        <div class="results-header">
          <div class="results-title">Your Week in <em>Review</em></div>
          <div class="results-date">${dateRange}</div>
        </div>
        <div class="score-card">
          <div class="score-ring-wrap">
            <svg viewBox="0 0 80 80" width="80" height="80">
              <circle class="score-ring-bg" cx="40" cy="40" r="32"/>
              <circle class="score-ring-fill" cx="40" cy="40" r="32"
                style="stroke:${scoreColor}"/>
            </svg>
            <div class="score-number">
              <div class="score-num" style="color:${scoreColor}">${s.score}</div>
              <div class="score-denom">/ 100</div>
            </div>
          </div>
          <div class="score-meta">
            <div class="score-headline">${scoreLabel}</div>
            <div class="score-summary">${s.week}</div>
          </div>
        </div>
        <div class="section-label" style="margin-top:8px">This Week's Insights</div>
        <div class="insight-card positive" style="animation-delay:0.1s">
          <div class="insight-type">✦ Best Moment</div>
          <div class="insight-text">${s.best}</div>
        </div>
        <div class="insight-card warning" style="animation-delay:0.2s">
          <div class="insight-type">⚠ Watch This</div>
          <div class="insight-text">${s.watch}</div>
        </div>
        <div class="insight-card info" style="animation-delay:0.3s">
          <div class="insight-type">↕ Most Variable Window</div>
          <div class="insight-text">${s.variable}</div>
        </div>
        ${s.scoreDesc ? `
        <div class="insight-card alert" style="animation-delay:0.4s">
          <div class="insight-type">📊 Score Breakdown</div>
          <div class="insight-text">${s.scoreDesc}</div>
        </div>` : ''}
        <a href="/" class="run-again-btn">← Run New Analysis</a>
        <p style="font-size:11px;color:var(--muted);text-align:center;line-height:1.6;margin-top:16px">
          For informational purposes only. Not a substitute for medical advice.
        </p>
      </div>
    `;
    res.send(renderPage(content));
  } catch (err) {
    console.error(err);
    const errorContent = `
      <div class="connect-page">
        <div class="logo-mark">⚠️</div>
        <h2 style="font-family:'DM Serif Display',serif;margin-bottom:12px">Something went wrong</h2>
        <p style="color:var(--muted);font-size:14px;margin-bottom:24px">${err.message}</p>
        <a href="/" class="connect-btn">← Try Again</a>
      </div>
    `;
    res.send(renderPage(errorContent));
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GlucoAnalyst running on port ${PORT}`);
});
