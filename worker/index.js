// =============================================================================
// LORE — Cloudflare Worker
// Proxies all AI calls so API keys never touch the browser.
// Also handles server-side Firebase Admin operations that cannot run
// client-side — specifically, setting custom claims on user accounts.
//
// Routes:
//   mode: 'classify'   → Gemini Flash-Lite (temp 0.2, tokens 1024)
//   mode: 'generate'   → Gemini Flash (temp 0.7, tokens 4096)
//   mode: 'setClaims'  → Firebase Admin SDK — sets orgId + role claims on a uid
//
// Environment variables (set in Wrangler / Cloudflare dashboard — never in source):
//   GEMINI_API_KEY       — Gemini API key
//   GROQ_API_KEY         — Groq fallback key
//   FIREBASE_PROJECT_ID  — Firebase project ID (lore-platform-hu247)
//   FIREBASE_CLIENT_EMAIL — Firebase service account email
//   FIREBASE_PRIVATE_KEY  — Firebase service account private key (PEM, newlines as \n)
//   ADMIN_SECRET         — A secret string you set — compared against requests
//                          to setClaims to prevent unauthorised claim-setting.
//                          Set this in Wrangler secrets:
//                            wrangler secret put ADMIN_SECRET
//                          Then use the same value in provision.html.
//                          Never put it in source code.
// =============================================================================

export default {
    async fetch(request, env) {
        // CORS — allow requests from the GitHub Pages origin and localhost for dev
        const origin = request.headers.get('Origin') ?? '';
        const allowedOrigins = [
            'https://lore-platform.github.io',
            'http://localhost',
            'http://127.0.0.1',
        ];
        const corsOrigin = allowedOrigins.some(o => origin.startsWith(o)) ? origin : allowedOrigins[0];

        const corsHeaders = {
            'Access-Control-Allow-Origin':  corsOrigin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        if (request.method !== 'POST') {
            return new Response(JSON.stringify({ error: 'Method not allowed' }), {
                status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const { mode } = body;

        // ---------------------------------------------------------------------------
        // Route: setClaims
        // Sets Firebase custom claims (orgId, role) on a user account.
        // Requires ADMIN_SECRET to match — prevents anyone who finds this endpoint
        // from setting claims on arbitrary accounts.
        //
        // The ADMIN_SECRET lives in Wrangler environment secrets — it is never in
        // source code or the GitHub repo. You set it once with:
        //   wrangler secret put ADMIN_SECRET
        // and use the same value in provision.html's runtime config.
        // ---------------------------------------------------------------------------
        if (mode === 'setClaims') {
            return handleSetClaims(body, env, corsHeaders);
        }

        // ---------------------------------------------------------------------------
        // Routes: classify and generate — AI proxy
        // ---------------------------------------------------------------------------
        if (mode === 'classify' || mode === 'generate') {
            return handleAI(body, env, corsHeaders);
        }

        return new Response(JSON.stringify({ error: 'Unknown mode' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
};

// =============================================================================
// setClaims handler
// Uses the Firebase Admin SDK's REST API (Identity Toolkit) to set custom
// claims. The Worker does not use the Node Admin SDK — it uses the REST API
// directly with a service account JWT, which works in any JS runtime.
// =============================================================================
async function handleSetClaims(body, env, corsHeaders) {
    const { uid, orgId, role, adminSecret } = body;

    // Validate the admin secret
    if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
        return json({ error: 'Unauthorised' }, 403, corsHeaders);
    }

    if (!uid || !orgId || !role) {
        return json({ error: 'uid, orgId, and role are required' }, 400, corsHeaders);
    }

    if (!['manager', 'employee', 'reviewer'].includes(role)) {
        return json({ error: 'role must be manager, employee, or reviewer' }, 400, corsHeaders);
    }

    try {
        // Step 1: Get a Google OAuth2 access token using the service account.
        // This is the standard service account JWT flow for Google APIs.
        const accessToken = await getServiceAccountToken(env);

        // Step 2: Call the Firebase Auth REST API to set custom claims.
        // The endpoint is part of the Firebase Auth Admin REST API.
        const claimsPayload = JSON.stringify({ [orgId]: true, orgId, role });
        const url = `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`;

        const res = await fetch(url, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                localId:      uid,
                customAttributes: claimsPayload,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.error('LORE Worker: Firebase claims update failed:', err);
            return json({ error: 'Failed to set claims', detail: err }, 500, corsHeaders);
        }

        return json({ ok: true, uid, orgId, role }, 200, corsHeaders);

    } catch (err) {
        console.error('LORE Worker: setClaims error:', err.message);
        return json({ error: err.message }, 500, corsHeaders);
    }
}

// ---------------------------------------------------------------------------
// Mint a short-lived Google OAuth2 access token from a service account.
// Uses the standard JWT Bearer flow — no external libraries needed.
// The service account credentials come from Wrangler environment secrets.
// ---------------------------------------------------------------------------
async function getServiceAccountToken(env) {
    const now     = Math.floor(Date.now() / 1000);
    const expiry  = now + 3600;

    const header  = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss:   env.FIREBASE_CLIENT_EMAIL,
        sub:   env.FIREBASE_CLIENT_EMAIL,
        aud:   'https://oauth2.googleapis.com/token',
        iat:   now,
        exp:   expiry,
        scope: 'https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform',
    };

    const b64Header  = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const b64Payload = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const sigInput   = `${b64Header}.${b64Payload}`;

    // Import the private key — it is stored as a PEM string in the Wrangler secret.
    // Newlines in the PEM must be stored as literal \n in the secret value.
    const privateKeyPem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        pemToArrayBuffer(privateKeyPem),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        privateKey,
        new TextEncoder().encode(sigInput)
    );

    const b64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const jwt = `${sigInput}.${b64Sig}`;

    // Exchange the JWT for an access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
        throw new Error('Could not obtain service account access token: ' + JSON.stringify(tokenData));
    }

    return tokenData.access_token;
}

// ---------------------------------------------------------------------------
// Convert a PEM-encoded private key to an ArrayBuffer for Web Crypto.
// ---------------------------------------------------------------------------
function pemToArrayBuffer(pem) {
    const base64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s/g, '');
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const view   = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buffer;
}

// =============================================================================
// AI proxy handler — unchanged from original
// =============================================================================
async function handleAI(body, env, corsHeaders) {
    const { mode, prompt, systemPrompt } = body;

    // Model routing — do not change these strings
    const isClassify = mode === 'classify';
    const model      = isClassify ? 'gemini-2.5-flash-lite' : 'gemini-2.5-flash';
    const temp       = isClassify ? 0.2 : 0.7;
    const maxTokens  = isClassify ? 1024 : 4096;

    // Try Gemini first
    const geminiResult = await tryGemini(prompt, systemPrompt, model, temp, maxTokens, env.GEMINI_API_KEY);
    if (geminiResult.ok) {
        return json(geminiResult, 200, corsHeaders);
    }

    // Quota or error — try Groq fallback
    console.warn('LORE Worker: Gemini failed, trying Groq fallback. Reason:', geminiResult.error);
    const groqResult = await tryGroq(prompt, systemPrompt, env.GROQ_API_KEY);
    if (groqResult.ok) {
        return json(groqResult, 200, corsHeaders);
    }

    // Both failed
    console.error('LORE Worker: Both AI providers failed.');
    return json({ ok: false, error: 'AI_UNAVAILABLE', quota: true }, 503, corsHeaders);
}

async function tryGemini(prompt, systemPrompt, model, temp, maxTokens, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const contents = [];
    if (systemPrompt) {
        contents.push({ role: 'user',  parts: [{ text: systemPrompt }] });
        contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
    }
    contents.push({ role: 'user', parts: [{ text: prompt }] });

    try {
        const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                contents,
                generationConfig: { temperature: temp, maxOutputTokens: maxTokens },
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const quota = res.status === 429;
            return { ok: false, error: err.error?.message ?? 'GEMINI_ERROR', quota };
        }

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return { ok: true, text };

    } catch (err) {
        return { ok: false, error: err.message, quota: false };
    }
}

async function tryGroq(prompt, systemPrompt, apiKey) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                model:      'llama-3.3-70b-versatile',
                messages,
                max_tokens: 4096,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { ok: false, error: err.error?.message ?? 'GROQ_ERROR', quota: false };
        }

        const data = await res.json();
        const text = data.choices?.[0]?.message?.content ?? '';
        return { ok: true, text };

    } catch (err) {
        return { ok: false, error: err.message, quota: false };
    }
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------
function json(data, status, corsHeaders) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}