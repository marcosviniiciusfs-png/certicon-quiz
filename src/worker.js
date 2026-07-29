const ALLOWED_INTERESTS = new Set(["Imóvel", "Carro", "Caminhão", "Maquinário"]);

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

function validSourceUrl(value, requestUrl) {
  try {
    const source = new URL(value);
    const request = new URL(requestUrl);
    return source.hostname === request.hostname || request.hostname === "localhost";
  } catch {
    return false;
  }
}

async function saveLead(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return json({ ok: false, error: "Content-Type inválido" }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 24_000) {
    return json({ ok: false, error: "Payload muito grande" }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  if (cleanText(body.website, 80)) {
    return json({ ok: true, stored: false });
  }

  const id = cleanText(body.id, 80);
  const leadName = cleanText(body.lead_name, 120);
  const whatsapp = cleanText(body.whatsapp, 30);
  const whatsappDigits = whatsapp.replace(/\D/g, "").slice(0, 13);
  const interest = cleanText(body.interest, 40);
  const sourceUrl = cleanText(body.source_url, 700);

  if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) {
    return json({ ok: false, error: "Identificador inválido" }, 400);
  }
  if (leadName.length < 2 || whatsappDigits.length < 10 || !ALLOWED_INTERESTS.has(interest)) {
    return json({ ok: false, error: "Dados obrigatórios inválidos" }, 400);
  }
  if (!validSourceUrl(sourceUrl, request.url)) {
    return json({ ok: false, error: "Origem inválida" }, 400);
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

  return json({ ok: true, stored: result.meta.changes > 0, duplicate: result.meta.changes === 0, id });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/leads") {
      if (request.method === "POST") {
        try {
          return await saveLead(request, env);
        } catch (error) {
          console.error("Falha ao armazenar lead no D1", error);
          return json({ ok: false, error: "Não foi possível armazenar o lead" }, 500);
        }
      }
      return json({ ok: false, error: "Método não permitido" }, 405, { Allow: "POST" });
    }

    return env.ASSETS.fetch(request);
  }
};
