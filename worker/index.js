// =============================================================================
// LORE — Cloudflare Worker
// Proxies all AI calls so API keys never touch the browser.
// Also handles server-side Firebase Admin operations that cannot run
// client-side — specifically, setting custom claims on user accounts.
//
// Routes:
//   mode: 'classify'       → Gemini Flash-Lite (temp 0.2, tokens 1024)
//   mode: 'generate'       → Gemini Flash (temp 0.7, tokens 4096)
//   mode: 'setClaims'      → Firebase Admin SDK — sets orgId + role claims on a uid
//   mode: 'parseDocument'  → Gemini Flash vision — converts a base64 file to plain text.
//                            Accepts PDF (digital and scanned) and images (JPEG, PNG, WEBP).
//                            DOCX is handled separately via XML extraction before this call.
//                            Body: { mode, fileBase64, mimeType, fileName }
//                            Returns: { ok: true, text, pageCount? } or { ok: false, error }
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
        // Route: ping — lightweight wake call used before setClaims to avoid
        // cold-start timeouts. Returns immediately with { ok: true }.
        // ---------------------------------------------------------------------------
        if (mode === 'ping') {
            return json({ ok: true }, 200, corsHeaders);
        }

        // ---------------------------------------------------------------------------
        // Route: deleteAuthUser
        // Deletes a Firebase Auth user by UID using the Admin REST API.
        // Requires ADMIN_SECRET — prevents arbitrary account deletion.
        // Used by the admin Reset flow so that the Worker's service account
        // credentials handle the deletion rather than the client-side API key,
        // which cannot look up or delete accounts it did not create.
        // ---------------------------------------------------------------------------
        if (mode === 'deleteAuthUser') {
            return handleDeleteAuthUser(body, env, corsHeaders);
        }

        // ---------------------------------------------------------------------------
        // Route: lookupUidByEmail
        // Returns the Firebase Auth UID for an email address using the Admin REST API.
        // Requires ADMIN_SECRET. Used by the admin Reset flow to find orphaned
        // Auth accounts that have no matching Firestore user document.
        // ---------------------------------------------------------------------------
        if (mode === 'lookupUidByEmail') {
            return handleLookupUidByEmail(body, env, corsHeaders);
        }

        // ---------------------------------------------------------------------------
        // Route: redeemInviteClaims
        // Called by auth.js immediately after a new user accepts an invite and their
        // Firebase Auth account is created client-side. The Worker reads the invite
        // document from Firestore using the service account token, validates orgId
        // and role, then sets claims on the new account.
        //
        // No ADMIN_SECRET required — the invite document is the trust mechanism.
        // The Worker verifies the invite exists and is not redeemed before setting
        // anything. Body: { uid, inviteId }
        // ---------------------------------------------------------------------------
        if (mode === 'redeemInviteClaims') {
            return handleRedeemInviteClaims(body, env, corsHeaders);
        }

        // ---------------------------------------------------------------------------
        // Route: parseDocument
        // Converts a base64-encoded file to clean plain text using Gemini's
        // native document and vision understanding.
        //
        // AI fallback chain (both within this Worker):
        //   1. gemini-2.5-flash     — primary model, best quality
        //   2. gemini-2.5-flash-lite — fallback on 429 or 500, separate endpoint
        //      so a demand spike on Flash is less likely to affect Flash Lite
        //
        // If both AI models fail, the Worker returns { ok: false, error: 'AI_BUSY' }
        // and dashboard.js attempts local in-browser parsing as a further fallback.
        //
        // Supported MIME types:
        //   application/pdf         — digital PDFs and scanned PDFs (via vision)
        //   image/jpeg              — scanned pages, photos of documents
        //   image/png               — scanned pages, screenshots
        //   image/webp              — scanned pages
        //   text/plain              — plain text files (no AI call needed — decoded directly)
        //
        // DOCX is not sent here — dashboard.js extracts DOCX XML client-side
        // and sends the resulting plain text through the normal paste flow.
        //
        // Body: { mode, fileBase64, mimeType, fileName }
        // Returns: { ok: true, text } or { ok: false, error, unsupported? }
        // ---------------------------------------------------------------------------
        if (mode === 'parseDocument') {
            return handleParseDocument(body, env, corsHeaders);
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
// deleteAuthUser handler
// Deletes a Firebase Auth user by UID using the Admin REST API.
// The service account token gives the Worker the authority to delete any account
// in the project — this is intentionally gated behind ADMIN_SECRET.
// =============================================================================
async function handleDeleteAuthUser(body, env, corsHeaders) {
    const { uid, adminSecret } = body;

    if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
        return json({ error: 'Unauthorised' }, 403, corsHeaders);
    }
    if (!uid) {
        return json({ error: 'uid is required' }, 400, corsHeaders);
    }

    try {
        const accessToken = await getServiceAccountToken(env);
        const url = `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:delete`;

        const res = await fetch(url, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({ localId: uid }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            // USER_NOT_FOUND is not a real error for a delete — the goal state is achieved
            if (err.error?.message === 'USER_NOT_FOUND') {
                return json({ ok: true, uid, notFound: true }, 200, corsHeaders);
            }
            console.error('LORE Worker: deleteAuthUser failed:', err);
            return json({ error: 'Failed to delete user', detail: err }, 500, corsHeaders);
        }

        return json({ ok: true, uid }, 200, corsHeaders);

    } catch (err) {
        console.error('LORE Worker: deleteAuthUser error:', err.message);
        return json({ error: err.message }, 500, corsHeaders);
    }
}

// =============================================================================
// lookupUidByEmail handler
// Returns the Firebase Auth UID for a given email using the Admin REST API.
// Returns { ok: true, uid } if found, { ok: true, uid: null } if not found.
// Used by the admin Reset flow to find orphaned Auth accounts.
// =============================================================================
async function handleLookupUidByEmail(body, env, corsHeaders) {
    const { email, adminSecret } = body;

    if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
        return json({ error: 'Unauthorised' }, 403, corsHeaders);
    }
    if (!email) {
        return json({ error: 'email is required' }, 400, corsHeaders);
    }

    try {
        const accessToken = await getServiceAccountToken(env);
        const url = `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`;

        const res = await fetch(url, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({ email: [email] }),
        });

        const data = await res.json();
        const uid  = data.users?.[0]?.localId ?? null;
        return json({ ok: true, uid }, 200, corsHeaders);

    } catch (err) {
        console.error('LORE Worker: lookupUidByEmail error:', err.message);
        return json({ error: err.message }, 500, corsHeaders);
    }
}

// =============================================================================
// setClaims handler
// Uses the Firebase Admin SDK's REST API (Identity Toolkit) to set custom
// claims. The Worker does not use the Node Admin SDK — it uses the REST API
// directly with a service account JWT, which works in any JS runtime.
// =============================================================================
// =============================================================================
// redeemInviteClaims handler
// Reads the invite document from Firestore server-side using the service
// account token, extracts orgId and role, and sets claims on the new user.
// This is the correct pattern for invite redemption — no admin secret is
// needed because the invite document itself is the access control mechanism.
// The Worker verifies the invite exists before setting anything.
// =============================================================================
async function handleRedeemInviteClaims(body, env, corsHeaders) {
    const { uid, inviteId } = body;

    if (!uid || !inviteId) {
        return json({ error: 'uid and inviteId are required' }, 400, corsHeaders);
    }

    try {
        const accessToken = await getServiceAccountToken(env);

        // Step 1: Read the invite document from Firestore using the Admin REST API.
        // The Firestore REST API returns fields in typed format, e.g.
        // { "orgId": { "stringValue": "acme" }, "role": { "stringValue": "employee" } }
        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/invites/${inviteId}`;
        const docRes = await fetch(firestoreUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
        });

        if (docRes.status === 404) {
            return json({ error: 'Invite not found' }, 404, corsHeaders);
        }
        if (!docRes.ok) {
            return json({ error: 'Could not read invite document' }, 500, corsHeaders);
        }

        const doc    = await docRes.json();
        const fields = doc.fields;
        if (!fields) {
            return json({ error: 'Invite document is empty' }, 400, corsHeaders);
        }

        const orgId   = fields.orgId?.stringValue;
        const role    = fields.role?.stringValue;
        const redeemed = fields.redeemed?.booleanValue ?? false;

        if (!orgId || !role) {
            return json({ error: 'Invite missing orgId or role' }, 400, corsHeaders);
        }
        if (redeemed) {
            return json({ error: 'Invite already redeemed' }, 409, corsHeaders);
        }
        if (!['employee', 'reviewer'].includes(role)) {
            return json({ error: 'Invalid role on invite' }, 400, corsHeaders);
        }

        // Step 2: Set custom claims on the new Firebase Auth account.
        // Uses the same pattern as handleSetClaims.
        const claimsPayload = JSON.stringify({ [orgId]: true, orgId, role });
        const claimsUrl = `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`;

        const claimsRes = await fetch(claimsUrl, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                localId:          uid,
                customAttributes: claimsPayload,
            }),
        });

        if (!claimsRes.ok) {
            const err = await claimsRes.json().catch(() => ({}));
            console.error('LORE Worker: redeemInviteClaims — claims update failed:', err);
            return json({ error: 'Failed to set claims', detail: err }, 500, corsHeaders);
        }

        console.log('LORE Worker: redeemInviteClaims — claims set. uid:', uid, 'orgId:', orgId, 'role:', role);

        // Step 3: Mark the invite as redeemed in Firestore using the service account
        // token. This replaces the client-side updateDoc in auth.js which failed
        // silently because the newly created user lacked permission to write to
        // the top-level invites/ collection before their claims had propagated.
        const redeemUrl  = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/invites/${inviteId}`;
        const redeemBody = {
            fields: {
                redeemed:   { booleanValue: true },
                redeemedAt: { timestampValue: new Date().toISOString() },
                redeemedBy: { stringValue: uid },
            },
        };
        try {
            const redeemRes = await fetch(
                `${redeemUrl}?updateMask.fieldPaths=redeemed&updateMask.fieldPaths=redeemedAt&updateMask.fieldPaths=redeemedBy`,
                {
                    method:  'PATCH',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type':  'application/json',
                    },
                    body: JSON.stringify(redeemBody),
                }
            );
            if (!redeemRes.ok) {
                const redeemErr = await redeemRes.json().catch(() => ({}));
                console.error('LORE Worker: redeemInviteClaims — invite redeem write failed:', redeemErr);
            } else {
                console.log('LORE Worker: redeemInviteClaims — invite marked as redeemed. inviteId:', inviteId);
            }
        } catch (redeemErr) {
            console.error('LORE Worker: redeemInviteClaims — invite redeem write threw:', redeemErr.message);
        }

        // Step 4: Write the user document to organisations/{orgId}/users/{uid}.
        // Done here — not client-side — because the service account token has
        // unconditional Firestore write authority, avoiding the security rules
        // block that caused the client-side write to fail silently.
        // Fields sourced from the invite document (already read above in Step 1).
        // displayName prefers the value stored on the invite document (set by the
        // Manager) and falls back to body.name for invites generated before
        // displayName was added to the invite document schema.
        const email     = fields.email?.stringValue     ?? '';
        const roleTitle = fields.roleTitle?.stringValue ?? '';
        const seniority = fields.seniority?.stringValue ?? 'mid';
        const displayName = (fields.displayName?.stringValue || body.name || '').trim();

        const userDocUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/organisations/${orgId}/users/${uid}`;
        const userDocBody = {
            fields: {
                displayName:     { stringValue: displayName },
                email:           { stringValue: email },
                role:            { stringValue: role },
                roleTitle:       { stringValue: roleTitle },
                seniority:       { stringValue: seniority },
                assignedDomains: { arrayValue: { values: [] } },
                createdAt:       { timestampValue: new Date().toISOString() },
            },
        };

        try {
            const userDocRes = await fetch(userDocUrl, {
                method:  'PATCH',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type':  'application/json',
                },
                body: JSON.stringify(userDocBody),
            });
            if (!userDocRes.ok) {
                const userDocErr = await userDocRes.json().catch(() => ({}));
                // Non-fatal — claims are set, the user can sign in. Log the failure
                // so it is visible in Worker logs, but do not block the response.
                console.error('LORE Worker: redeemInviteClaims — user document write failed:', userDocErr);
            } else {
                console.log('LORE Worker: redeemInviteClaims — user document written. uid:', uid, 'orgId:', orgId);
            }
        } catch (userDocErr) {
            // Non-fatal — same reasoning as above.
            console.error('LORE Worker: redeemInviteClaims — user document write threw:', userDocErr.message);
        }

        return json({ ok: true, uid, orgId, role }, 200, corsHeaders);

    } catch (err) {
        console.error('LORE Worker: redeemInviteClaims error:', err.message);
        return json({ error: err.message }, 500, corsHeaders);
    }
}

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
// parseDocument handler
// Converts a base64-encoded file to plain text using Gemini's native document
// and vision understanding. No third-party libraries — Gemini handles PDF
// structure, multi-column layouts, tables, and scanned pages natively.
//
// AI fallback chain:
//   1. gemini-2.5-flash      — primary, best quality
//   2. gemini-2.5-flash-lite — fallback on 429 or 500. Separate endpoint so
//      a demand spike on Flash is unlikely to affect Flash Lite simultaneously.
//
// If both fail, returns { ok: false, error: 'AI_BUSY' } so dashboard.js can
// attempt in-browser local parsing as a further fallback.
//
// Plain text files bypass both models — decoded directly with no AI cost.
//
// Size limit: Gemini inline data accepts files up to ~20MB base64-encoded.
// Files larger than this should be rejected before the Worker call is made —
// see dashboard.js _validateFile().
// =============================================================================
async function handleParseDocument(body, env, corsHeaders) {
    const { fileBase64, mimeType, fileName } = body;

    if (!fileBase64 || !mimeType) {
        return json({ ok: false, error: 'fileBase64 and mimeType are required' }, 400, corsHeaders);
    }

    // Supported MIME types for Gemini vision/document parsing.
    // DOCX (application/vnd.openxmlformats-officedocument.wordprocessingml.document)
    // is not listed here — it is handled client-side via XML extraction in dashboard.js.
    const SUPPORTED_TYPES = [
        'application/pdf',
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'text/plain',
    ];

    if (!SUPPORTED_TYPES.includes(mimeType)) {
        return json({
            ok:          false,
            error:       `File type '${mimeType}' is not supported for parsing.`,
            unsupported: true,
        }, 400, corsHeaders);
    }

    // Plain text — decode directly, no AI call needed.
    // atob works on base64 strings; TextDecoder handles non-ASCII characters correctly.
    if (mimeType === 'text/plain') {
        try {
            const bytes = Uint8Array.from(atob(fileBase64), c => c.charCodeAt(0));
            const text  = new TextDecoder('utf-8').decode(bytes);
            console.log('LORE Worker: parseDocument — plain text decoded, length:', text.length);
            return json({ ok: true, text, mimeType }, 200, corsHeaders);
        } catch (err) {
            console.error('LORE Worker: parseDocument — plain text decode failed:', err.message);
            return json({ ok: false, error: 'Could not decode text file.' }, 500, corsHeaders);
        }
    }

    // PDF and image types — try Gemini Flash first, then Flash Lite as fallback.
    console.log('LORE Worker: parseDocument — sending to Gemini. mimeType:', mimeType, 'fileName:', fileName ?? 'unknown');

    const parseResult = await tryGeminiParse(fileBase64, mimeType, fileName, env.GEMINI_API_KEY);

    if (!parseResult.ok) {
        // Both models failed — return AI_BUSY so the browser knows to attempt
        // local in-browser parsing rather than showing a generic error.
        console.error('LORE Worker: parseDocument — all AI models failed. Returning AI_BUSY.');
        return json({ ok: false, error: 'AI_BUSY' }, 503, corsHeaders);
    }

    console.log('LORE Worker: parseDocument — success. text length:', parseResult.text.length, 'partial:', parseResult.partial ?? false, 'model:', parseResult.model);
    return json(parseResult, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// tryGeminiParse — uploads the file to the Gemini File API, then calls
// generateContent referencing the uploaded file URI.
//
// Why File API instead of inline base64:
//   Google explicitly recommends the File API for PDF parsing. Inline base64
//   works for images but is less reliable for PDFs in practice — the File API
//   path uses a different internal processing pipeline that handles PDF
//   structure, text layers, and multi-page documents more consistently.
//   Files are stored temporarily (48 hours) and do not count against token
//   input limits — only the generateContent call does.
//
// Flow:
//   1. Upload file bytes to generativelanguage.googleapis.com/upload/v1beta/files
//      → receive a file URI
//   2. Call generateContent with the file URI as a fileData part
//   3. On 429 or 500, retry with gemini-2.5-flash-lite
//   4. Delete the uploaded file after use (best-effort, non-fatal if it fails)
//
// Returns { ok: true, text, partial?, model } or { ok: false, error }.
// ---------------------------------------------------------------------------
async function tryGeminiParse(fileBase64, mimeType, fileName, apiKey) {
    const systemPrompt = `You are a document transcription assistant.
Your job is to extract and return the complete text content of the document provided.
Rules:
- Transcribe everything — do not summarise, paraphrase, or omit any content.
- Preserve the logical structure: headings, bullet points, numbered lists, table content.
- For tables, transcribe row by row with clear separation between cells.
- If a page is a cover page or contains only a logo or image with no text, write "[Image page — no text content]".
- If text is partially illegible due to scan quality, transcribe what you can and mark unclear sections with [illegible].
- Do not add commentary, preamble, or any text that was not in the original document.
- Return plain text only — no markdown formatting, no asterisks, no backticks.`;

    const prompt = `Transcribe the complete text content of this document. Return plain text only.`;

    // Step 1: Upload the file to the Gemini File API.
    // Convert base64 back to raw bytes for the multipart upload.
    let fileUri  = null;
    let uploadedFileName = null; // The File API's internal resource name — used for deletion

    try {
        const fileBytes = Uint8Array.from(atob(fileBase64), c => c.charCodeAt(0));
        const numBytes  = fileBytes.length;

        // Multipart upload — metadata part + binary part separated by a boundary.
        // The File API accepts application/octet-stream as the upload content type
        // and stores the file with the declared mimeType for Gemini to read.
        const boundary = '----LoreFileBoundary';
        const metadataPart = JSON.stringify({ file: { displayName: fileName ?? 'document' } });

        // Build the multipart body manually — no FormData in Workers
        const encoder   = new TextEncoder();
        const metaBytes = encoder.encode(
            `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metadataPart}\r\n` +
            `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
        );
        const closing   = encoder.encode(`\r\n--${boundary}--`);

        // Concatenate: metadata + file bytes + closing boundary
        const body = new Uint8Array(metaBytes.length + numBytes + closing.length);
        body.set(metaBytes, 0);
        body.set(fileBytes, metaBytes.length);
        body.set(closing,   metaBytes.length + numBytes);

        const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`;

        console.log('LORE Worker: tryGeminiParse — uploading file to File API. size:', numBytes, 'bytes, mimeType:', mimeType);

        const uploadRes = await fetch(uploadUrl, {
            method:  'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'X-Goog-Upload-Protocol': 'multipart',
            },
            body,
        });

        if (!uploadRes.ok) {
            const err = await uploadRes.json().catch(() => ({}));
            console.error('LORE Worker: tryGeminiParse — File API upload failed:', uploadRes.status, err);
            return { ok: false, error: 'FILE_UPLOAD_FAILED' };
        }

        const uploadData     = await uploadRes.json();
        fileUri              = uploadData.file?.uri ?? null;
        uploadedFileName     = uploadData.file?.name ?? null; // e.g. "files/abc123"

        if (!fileUri) {
            console.error('LORE Worker: tryGeminiParse — File API returned no URI.');
            return { ok: false, error: 'FILE_UPLOAD_FAILED' };
        }

        console.log('LORE Worker: tryGeminiParse — file uploaded. URI:', fileUri);

    } catch (err) {
        console.error('LORE Worker: tryGeminiParse — File API upload threw:', err.message);
        return { ok: false, error: 'FILE_UPLOAD_FAILED' };
    }

    // Step 2: Call generateContent with the uploaded file URI.
    // Try gemini-2.5-flash first, fall back to gemini-2.5-flash-lite on 429/500.
    // [TUNING TARGET] Add or reorder models here if the available Gemini lineup changes.
    const models = [
        'gemini-2.5-flash',      // Primary — best quality for document vision
        'gemini-2.5-flash-lite', // Fallback — separate endpoint, lighter demand
    ];

    let parseResult = { ok: false, error: 'ALL_MODELS_FAILED' };

    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const requestBody = {
            contents: [
                {
                    role:  'user',
                    parts: [
                        // Reference the uploaded file by URI — File API path
                        {
                            fileData: {
                                mimeType: mimeType,
                                fileUri:  fileUri,
                            },
                        },
                        // Text prompt follows the file part
                        { text: prompt },
                    ],
                },
            ],
            systemInstruction: {
                parts: [{ text: systemPrompt }],
            },
            generationConfig: {
                // High token limit — long documents need room to be transcribed in full.
                // [TUNING TARGET] Reduce if Worker costs become a concern.
                maxOutputTokens: 8192,
                // Temperature 0 — transcription should be deterministic, not creative.
                temperature: 0,
            },
        };

        console.log(`LORE Worker: tryGeminiParse — calling generateContent. model: ${model}`);

        try {
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(requestBody),
            });

            // 429 and 500 are transient — try the next model in the chain.
            // Any other non-OK status (400, 403) is a permanent error — stop immediately.
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                if (res.status === 429 || res.status === 500) {
                    console.warn(`LORE Worker: tryGeminiParse — model ${model} returned ${res.status}, trying next.`);
                    continue;
                }
                console.error(`LORE Worker: tryGeminiParse — model ${model} permanent error:`, res.status, err);
                parseResult = { ok: false, error: err.error?.message ?? 'GEMINI_ERROR' };
                break;
            }

            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

            if (!text || text.trim().length === 0) {
                // Empty response — treat as transient and try the next model
                console.warn(`LORE Worker: tryGeminiParse — model ${model} returned empty text.`);
                continue;
            }

            // finishReason check — RECITATION or SAFETY means the model refused.
            // Return what we have with a partial flag rather than failing entirely.
            const finishReason = data.candidates?.[0]?.finishReason;
            const partial      = finishReason === 'MAX_TOKENS';

            if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
                console.warn(`LORE Worker: tryGeminiParse — model ${model} finishReason: ${finishReason}`);
                parseResult = { ok: true, text, partial: true, finishReason, model };
                break;
            }

            if (partial) {
                console.warn(`LORE Worker: tryGeminiParse — model ${model} hit MAX_TOKENS. Partial content returned.`);
            }

            parseResult = { ok: true, text, partial, model };
            break;

        } catch (err) {
            // Network-level failure — try the next model
            console.warn(`LORE Worker: tryGeminiParse — model ${model} network error: ${err.message}`);
            continue;
        }
    }

    // Step 3: Delete the uploaded file — best-effort, non-fatal.
    // Files auto-expire after 48 hours anyway, but explicit deletion is good practice
    // and avoids accumulating files in the account during heavy use.
    if (uploadedFileName) {
        const deleteUrl = `https://generativelanguage.googleapis.com/v1beta/${uploadedFileName}?key=${apiKey}`;
        fetch(deleteUrl, { method: 'DELETE' }).catch(err => {
            console.warn('LORE Worker: tryGeminiParse — file deletion failed (non-fatal):', err.message);
        });
    }

    return parseResult;
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