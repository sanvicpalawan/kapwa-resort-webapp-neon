import { requireStaff } from "../_shared/auth";
import {
  callModelVision,
  resolveModelConfig,
  ModelUnavailableError,
} from "../_shared/modelGateway";
import { serviceClient } from "../_shared/db";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
export default {
  async fetch(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Staff-only endpoint. The gateway cannot verify the opaque publishable key,
  // so authorization happens here. Inert until STAFF_JWT_SECRET is configured.
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const { image_base64 } = await req.json();
    if (!image_base64) {
      return new Response(JSON.stringify({ error: "No image provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Receipt extraction is vision work: resolve the "receipts" role through the
    // shared gateway (SCAN_RECEIPT_MODEL secret → vision-capable default) instead
    // of a provider-specific key.
    const supabase = await serviceClient();
    const config = await resolveModelConfig(supabase, "receipts", { maxTokens: 900 });

    const systemPrompt = `You are a receipt/invoice OCR extraction assistant for Philippine businesses. 
Extract the following fields from the receipt or invoice image and return ONLY valid JSON (no markdown, no backticks):

{
  "supplier_name": "string or null",
  "supplier_tin": "string or null (format: XXX-XXX-XXX-XXX)",
  "vat_status": "VAT | Non-VAT | VAT-Exempt | Zero-Rated",
  "invoice_number": "string or null",
  "official_receipt_number": "string or null", 
  "date": "YYYY-MM-DD or null",
  "total_amount": number or null,
  "vatable_sale": number or null,
  "vat_amount": number or null,
  "vat_exempt_amount": number or null,
  "zero_rated_amount": number or null,
  "description": "brief description of items/services or null",
  "confidence": "high | medium | low"
}

Rules:
- If you see a TIN number, the vat_status is likely "VAT"
- Philippine VAT is 12% inclusive. If total is given and VAT breakdown missing: vat_amount = total / 1.12 * 0.12, vatable_sale = total - vat_amount
- For Non-VAT receipts: vat_amount = 0, vatable_sale = total_amount
- For VAT-Exempt: vat_exempt_amount = total_amount, vat_amount = 0
- For Zero-Rated: zero_rated_amount = total_amount, vat_amount = 0
- Look for "SI#", "Sales Invoice", "OR#", "Official Receipt" labels
- Date format should be YYYY-MM-DD
- Amounts should be plain numbers without currency symbols
- If a field cannot be determined, use null
- Return ONLY the JSON object, nothing else`;

    let rawContent: string;
    try {
      rawContent = await callModelVision(config, {
        system: systemPrompt,
        text: "Extract all receipt/invoice data from this image. Return only JSON.",
        imageUrl: image_base64,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // OpenRouter surfaces rate limits and exhausted credits as 429/402 — keep
      // the operator-friendly copy for those two.
      if (message.includes(" 429:")) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (message.includes(" 402:")) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add credits to continue." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (error instanceof ModelUnavailableError) {
        return new Response(
          JSON.stringify({ error: "No vision model configured. Set OPENROUTER_API_KEY." }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw error;
    }

    // Parse the JSON from the AI response (strip markdown fences if present)
    let cleaned = rawContent.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    let extracted;
    try {
      extracted = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse AI response:", cleaned);
      return new Response(
        JSON.stringify({ error: "Could not parse receipt data. Please try a clearer image.", raw: cleaned }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ success: true, data: extracted }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("scan-receipt error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  },
};
