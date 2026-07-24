import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type LeadPayload = {
  lead_name: string;
  whatsapp: string;
  whatsapp_digits?: string;
  interest?: string;
  has_down_payment?: string;
  down_payment_value?: number;
  monthly_payment_value?: number;
  purchase_timeline?: string;
  source_url?: string;
  landing_domain?: string;
  user_agent?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  fbp?: string;
  fbc?: string;
  meta_event_id?: string;
  raw_answers?: Record<string, unknown>;
};

async function sha256(value: string) {
  const data = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function appendIfPresent(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  params.set(key, String(value));
}

const DEFAULT_LEADS_WEBHOOK_URL = "https://webhook.simulead.com.br/webhook/7f7cb08b-6b82-4f56-9756-b6be8dd7b8d5";

async function sendLeadWebhook(payload: LeadPayload, whatsappDigits: string, metaEventId: string) {
  const webhookUrl = Deno.env.get("LEADS_WEBHOOK_URL") || DEFAULT_LEADS_WEBHOOK_URL;

  const url = new URL(webhookUrl);
  const params = url.searchParams;
  const answers = payload.raw_answers || {};

  appendIfPresent(params, "event", "qualified_lead");
  appendIfPresent(params, "lead_name", payload.lead_name);
  appendIfPresent(params, "whatsapp", payload.whatsapp);
  appendIfPresent(params, "whatsapp_digits", whatsappDigits);
  appendIfPresent(params, "interest", payload.interest);
  appendIfPresent(params, "requested_credit_value", answers.valorCredito);
  appendIfPresent(params, "requested_credit_range", answers.valorCreditoLabel);
  appendIfPresent(params, "has_down_payment", payload.has_down_payment);
  appendIfPresent(params, "down_payment_value", payload.down_payment_value);
  appendIfPresent(params, "down_payment_range", answers.valorEntradaFaixa);
  appendIfPresent(params, "valor_entrada", payload.down_payment_value);
  appendIfPresent(params, "faixa_entrada", answers.valorEntradaFaixa);
  appendIfPresent(params, "monthly_payment_value", payload.monthly_payment_value);
  appendIfPresent(params, "purchase_timeline", payload.purchase_timeline);
  appendIfPresent(params, "source_url", payload.source_url);
  appendIfPresent(params, "landing_domain", payload.landing_domain);
  appendIfPresent(params, "meta_event_id", metaEventId);
  appendIfPresent(params, "utm_source", payload.utm_source);
  appendIfPresent(params, "utm_medium", payload.utm_medium);
  appendIfPresent(params, "utm_campaign", payload.utm_campaign);
  appendIfPresent(params, "utm_content", payload.utm_content);
  appendIfPresent(params, "utm_term", payload.utm_term);
  appendIfPresent(params, "fbclid", payload.fbclid);
  appendIfPresent(params, "created_at", new Date().toISOString());

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "User-Agent": "quiz-hurtzcompany/1.0" },
  });

  return {
    configured: true,
    sent: response.ok,
    status: response.status,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json() as LeadPayload;
    const whatsappDigits = String(payload.whatsapp_digits || payload.whatsapp || "").replace(/\D/g, "");

    if (!payload.lead_name || payload.lead_name.trim().length < 2 || whatsappDigits.length < 10) {
      return new Response(JSON.stringify({ error: "Invalid lead payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const metaEventId = payload.meta_event_id || crypto.randomUUID();
    const leadRow = {
      ...payload,
      qualified: true,
      status: "qualified",
      whatsapp_digits: whatsappDigits,
      meta_event_id: metaEventId,
      raw_answers: payload.raw_answers || {},
    };

    const { data: inserted, error: insertError } = await supabase
      .from("quiz_leads")
      .upsert(leadRow, { onConflict: "meta_event_id" })
      .select("id, meta_event_id")
      .single();

    if (insertError) throw insertError;

    let webhookResult = { configured: false, sent: false } as {
      configured: boolean;
      sent: boolean;
      status?: number;
      error?: string;
    };

    try {
      webhookResult = await sendLeadWebhook(payload, whatsappDigits, metaEventId);
    } catch (webhookError) {
      webhookResult = {
        configured: true,
        sent: false,
        error: String(webhookError?.message || webhookError),
      };
    }

    const pixelId = Deno.env.get("META_PIXEL_ID");
    const accessToken = Deno.env.get("META_ACCESS_TOKEN");

    if (pixelId && accessToken) {
      const event = {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: metaEventId,
        action_source: "website",
        event_source_url: payload.source_url,
        user_data: {
          ph: [await sha256(whatsappDigits)],
          fn: payload.lead_name ? [await sha256(payload.lead_name.split(" ")[0] || payload.lead_name)] : undefined,
          client_user_agent: payload.user_agent || req.headers.get("user-agent") || undefined,
          client_ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
          fbp: payload.fbp || undefined,
          fbc: payload.fbc || undefined,
        },
        custom_data: {
          content_name: "Quiz Hurtz Company",
          interest: payload.interest,
          has_down_payment: payload.has_down_payment,
          down_payment_value: payload.down_payment_value,
          down_payment_range: payload.raw_answers?.valorEntradaFaixa,
          monthly_payment_value: payload.monthly_payment_value,
          purchase_timeline: payload.purchase_timeline,
          requested_credit_value: payload.raw_answers?.valorCredito,
          requested_credit_range: payload.raw_answers?.valorCreditoLabel,
        },
      };

      const response = await fetch(`https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${accessToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [event] }),
      });
      const metaResult = await response.json();

      await supabase
        .from("quiz_leads")
        .update({
          meta_conversion_sent: response.ok,
          meta_conversion_response: metaResult,
          meta_conversion_error: response.ok ? null : JSON.stringify(metaResult),
        })
        .eq("id", inserted.id);
    }

    return new Response(JSON.stringify({
      ok: true,
      id: inserted.id,
      meta_event_id: inserted.meta_event_id,
      webhook_sent: webhookResult.sent,
      webhook_status: webhookResult.status,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error?.message || error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
