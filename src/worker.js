const ALLOWED_INTERESTS = new Set(["Imóvel", "Carro", "Caminhão", "Maquinário"]);
const ALLOWED_ORIGINS = new Set([
  "https://certiconquiz.simulead.com.br",
  "http://certiconquiz.simulead.com.br",
  "https://certicon-quiz.hurtz-assistente.workers.dev",
  "http://localhost:8090",
  "http://127.0.0.1:8090"
]);
const ALLOWED_SOURCE_HOSTS = new Set([
  "certiconquiz.simulead.com.br",
  "certicon-quiz.hurtz-assistente.workers.dev",
  "localhost",
  "127.0.0.1"
]);

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

function cleanText(value, maxLength = 255) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function cleanInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function normalizeForHash(value) {
  return cleanText(value, 180)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function crmInterest(value) {
  const normalized = cleanText(value, 40)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const types = {
    IMOVEL: "IMOVEL",
    CARRO: "CARRO",
    CAMINHAO: "CAMINHAO",
    MAQUINARIO: "MAQUINARIO"
  };
  return types[normalized] || normalized;
}

function crmPayload(payload) {
  return {
    nome: payload.leadName,
    telefone: payload.whatsappDigits,
    tipo: crmInterest(payload.interest),
    entrada: payload.downPaymentRange,
    credito: payload.requestedCreditRange
  };
}

async function sendCrmLead(env, payload) {
  if (!env.CRM_AUTH_TOKEN || !env.CRM_WEBHOOK_URL) {
    const message = "CRM credentials are not configured";
    await env.DB.prepare(`
      UPDATE leads
      SET crm_status = 'not_configured',
          crm_attempts = crm_attempts + 1,
          crm_last_attempt_at = CURRENT_TIMESTAMP,
          crm_last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND crm_status != 'sent'
    `).bind(message, payload.id).run();
    return { status: "not_configured" };
  }

  try {
    const response = await fetch(env.CRM_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CRM_AUTH_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(crmPayload(payload))
    });
    const responseText = (await response.text()).slice(0, 4000);
    let externalId = null;
    try {
      const parsed = JSON.parse(responseText);
      externalId = cleanText(
        parsed?.id || parsed?.lead_id || parsed?.data?.id || parsed?.data?.lead_id,
        255
      ) || null;
    } catch {
      // A resposta do CRM pode não ser JSON.
    }
    const status = response.ok ? "sent" : "failed";

    await env.DB.prepare(`
      UPDATE leads
      SET crm_status = ?,
          crm_attempts = crm_attempts + 1,
          crm_last_attempt_at = CURRENT_TIMESTAMP,
          crm_last_error = ?,
          crm_external_id = COALESCE(?, crm_external_id),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND crm_status != 'sent'
    `).bind(
      status,
      response.ok ? null : `${response.status}: ${responseText}`,
      externalId,
      payload.id
    ).run();

    return { status };
  } catch (error) {
    const message = cleanText(error?.message || error, 1000);
    await env.DB.prepare(`
      UPDATE leads
      SET crm_status = 'failed',
          crm_attempts = crm_attempts + 1,
          crm_last_attempt_at = CURRENT_TIMESTAMP,
          crm_last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND crm_status != 'sent'
    `).bind(message, payload.id).run();
    return { status: "failed" };
  }
}

function payloadFromLead(row) {
  return {
    id: row.id,
    leadName: row.lead_name,
    whatsappDigits: row.whatsapp_digits,
    interest: row.interest,
    downPaymentRange: row.down_payment_range || "",
    requestedCreditRange: row.requested_credit_range || ""
  };
}

async function retryPendingCrmLeads(env) {
  const { results = [] } = await env.DB.prepare(`
    SELECT id, lead_name, whatsapp_digits, interest,
           down_payment_range, requested_credit_range
    FROM leads
    WHERE crm_status IN ('pending', 'failed', 'not_configured')
      AND crm_attempts < 12
      AND (
        crm_last_attempt_at IS NULL
        OR datetime(crm_last_attempt_at) <= datetime('now', '-5 minutes')
      )
    ORDER BY created_at ASC
    LIMIT 25
  `).all();

  for (const row of results) {
    await sendCrmLead(env, payloadFromLead(row));
  }
}

async function sendMetaLead(request, env, body, payload) {
  const eventId = payload.id;
  const nameParts = payload.leadName.trim().split(/\s+/);
  const firstName = normalizeForHash(nameParts[0] || "");
  const lastName = normalizeForHash(nameParts.slice(1).join(""));
  const phoneWithCountry = payload.whatsappDigits.startsWith("55")
    ? payload.whatsappDigits
    : `55${payload.whatsappDigits}`;

  if (!env.META_ACCESS_TOKEN || !env.META_PIXEL_ID) {
    await env.DB.prepare(`
      UPDATE leads
      SET meta_event_id = ?, meta_capi_status = 'not_configured',
          meta_capi_attempts = meta_capi_attempts + 1,
          meta_capi_error = 'Meta credentials are not configured',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(eventId, payload.id).run();
    return { status: "not_configured" };
  }

  const userData = {
    ph: [await sha256(phoneWithCountry)],
    external_id: [await sha256(payload.id)],
    client_ip_address: request.headers.get("CF-Connecting-IP") || undefined,
    client_user_agent: cleanText(body.user_agent, 700) || request.headers.get("User-Agent") || undefined,
    fbp: cleanText(body.fbp, 255) || undefined,
    fbc: cleanText(body.fbc, 255) || undefined
  };
  if (firstName) userData.fn = [await sha256(firstName)];
  if (lastName) userData.ln = [await sha256(lastName)];

  const metaPayload = {
    data: [{
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: payload.sourceUrl,
      action_source: "website",
      user_data: userData,
      custom_data: {
        content_name: "Quiz Certicon",
        content_category: "credito",
        interest: payload.interest,
        requested_credit_value: payload.requestedCreditValue,
        down_payment_value: payload.downPaymentValue
      }
    }]
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.META_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(metaPayload)
    });
    const responseText = (await response.text()).slice(0, 4000);
    const status = response.ok ? "sent" : "failed";

    await env.DB.prepare(`
      UPDATE leads
      SET meta_event_id = ?, meta_capi_status = ?,
          meta_capi_attempts = meta_capi_attempts + 1,
          meta_capi_sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE meta_capi_sent_at END,
          meta_capi_response = ?, meta_capi_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      eventId,
      status,
      status,
      response.ok ? responseText : null,
      response.ok ? null : responseText,
      payload.id
    ).run();

    return { status };
  } catch (error) {
    const message = cleanText(error?.message || error, 1000);
    await env.DB.prepare(`
      UPDATE leads
      SET meta_event_id = ?, meta_capi_status = 'failed',
          meta_capi_attempts = meta_capi_attempts + 1,
          meta_capi_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(eventId, message, payload.id).run();
    return { status: "failed" };
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function apiJson(request, data, status = 200, extraHeaders = {}) {
  return json(data, status, { ...corsHeaders(request), ...extraHeaders });
}

function validSourceUrl(value) {
  try {
    const source = new URL(value);
    return ALLOWED_SOURCE_HOSTS.has(source.hostname);
  } catch {
    return false;
  }
}

async function saveLead(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return apiJson(request, { ok: false, error: "Content-Type inválido" }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 24_000) {
    return apiJson(request, { ok: false, error: "Payload muito grande" }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return apiJson(request, { ok: false, error: "JSON inválido" }, 400);
  }

  if (cleanText(body.website, 80)) {
    return apiJson(request, { ok: true, stored: false });
  }

  const id = cleanText(body.id, 80);
  const leadName = cleanText(body.lead_name, 120);
  const whatsapp = cleanText(body.whatsapp, 30);
  const whatsappDigits = whatsapp.replace(/\D/g, "").slice(0, 13);
  const interest = cleanText(body.interest, 40);
  const sourceUrl = cleanText(body.source_url, 700);

  if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) {
    return apiJson(request, { ok: false, error: "Identificador inválido" }, 400);
  }
  if (leadName.length < 2 || whatsappDigits.length < 10 || !ALLOWED_INTERESTS.has(interest)) {
    return apiJson(request, { ok: false, error: "Dados obrigatórios inválidos" }, 400);
  }
  if (!validSourceUrl(sourceUrl)) {
    return apiJson(request, { ok: false, error: "Origem inválida" }, 400);
  }

  const payload = {
    id,
    leadName,
    whatsapp,
    whatsappDigits,
    interest,
    downPaymentRange: cleanText(body.down_payment_range, 80),
    downPaymentValue: cleanInteger(body.down_payment_value),
    requestedCreditRange: cleanText(body.requested_credit_range, 80),
    requestedCreditValue: cleanInteger(body.requested_credit_value),
    sourceUrl,
    referrer: cleanText(body.referrer, 700),
    utmSource: cleanText(body.utm_source, 180),
    utmMedium: cleanText(body.utm_medium, 180),
    utmCampaign: cleanText(body.utm_campaign, 180),
    utmContent: cleanText(body.utm_content, 180),
    utmTerm: cleanText(body.utm_term, 180)
  };

  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO leads (
      id, lead_name, whatsapp, whatsapp_digits, interest,
      down_payment_range, down_payment_value,
      requested_credit_range, requested_credit_value,
      source_url, referrer,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    payload.id,
    payload.leadName,
    payload.whatsapp,
    payload.whatsappDigits,
    payload.interest,
    payload.downPaymentRange,
    payload.downPaymentValue,
    payload.requestedCreditRange,
    payload.requestedCreditValue,
    payload.sourceUrl,
    payload.referrer,
    payload.utmSource,
    payload.utmMedium,
    payload.utmCampaign,
    payload.utmContent,
    payload.utmTerm,
    JSON.stringify(body)
  ).run();

  let metaCapiStatus = "duplicate";
  let crmStatus = "duplicate";
  if (result.meta.changes > 0) {
    const [metaResult, crmResult] = await Promise.all([
      sendMetaLead(request, env, body, payload),
      sendCrmLead(env, payload)
    ]);
    metaCapiStatus = metaResult.status;
    crmStatus = crmResult.status;
  }

  return apiJson(request, {
    ok: true,
    stored: result.meta.changes > 0,
    duplicate: result.meta.changes === 0,
    meta_capi_status: metaCapiStatus,
    crm_status: crmStatus,
    id
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/leads") {
      const origin = request.headers.get("origin");
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ ok: false, error: "Origem não permitida" }, 403);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === "POST") {
        try {
          return await saveLead(request, env);
        } catch (error) {
          console.error("Falha ao armazenar lead no D1", error);
          return apiJson(request, { ok: false, error: "Não foi possível armazenar o lead" }, 500);
        }
      }
      return apiJson(request, { ok: false, error: "Método não permitido" }, 405, { Allow: "POST, OPTIONS" });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(retryPendingCrmLeads(env));
  }
};
