const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_FLASH_LITE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const allowedOrigin = env.ALLOWED_ORIGIN || '';

        const corsHeaders = {
            'Access-Control-Allow-Origin': allowedOrigin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405, headers: corsHeaders });
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const { mode, prompt, systemPrompt } = body;
        // mode: 'classify' or 'generate'

        const isClassify = mode === 'classify';
        const modelUrl = isClassify ? GEMINI_FLASH_LITE_URL : GEMINI_FLASH_URL;
        const maxTokens = isClassify ? 1024 : 4096;
        const temperature = isClassify ? 0.2 : 0.7;

        const geminiPayload = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
        };

        if (systemPrompt) {
            geminiPayload.systemInstruction = { parts: [{ text: systemPrompt }] };
        }

        // Try primary Gemini model
        try {
            const res = await fetch(`${modelUrl}?key=${env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(geminiPayload),
            });

            if (res.ok) {
                const data = await res.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                return new Response(JSON.stringify({ ok: true, text }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }

            // If quota hit, fall through to Groq
            if (res.status !== 429 && res.status !== 503) {
                const err = await res.text();
                console.warn('Gemini error:', res.status, err);
            }
        } catch (e) {
            console.warn('Gemini fetch failed:', e.message);
        }

        // Fallback — Groq (Llama 3.3 70B, OpenAI-compatible)
        try {
            const groqPayload = {
                model: 'llama-3.3-70b-versatile',
                messages: [
                    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                    { role: 'user', content: prompt },
                ],
                max_tokens: maxTokens,
                temperature,
            };

            const res = await fetch(GROQ_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${env.GROQ_API_KEY}`,
                },
                body: JSON.stringify(groqPayload),
            });

            if (res.ok) {
                const data = await res.json();
                const text = data.choices?.[0]?.message?.content || '';
                return new Response(JSON.stringify({ ok: true, text, fallback: true }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }

            const err = await res.text();
            console.warn('Groq error:', res.status, err);
        } catch (e) {
            console.warn('Groq fetch failed:', e.message);
        }

        // Both failed
        return new Response(JSON.stringify({ ok: false, error: 'AI unavailable', quota: true }), {
            status: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    },
};