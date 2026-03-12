import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";

const app = new Hono<{ Bindings: Env }>();

// E.164 phone number format: + followed by 1-15 digits
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const MAX_MESSAGE_LENGTH = 1600;

// OpenAPI spec — must be before paymentMiddleware
app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 SMS Send Service",
      description: "Send SMS messages via Twilio. Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://sms.camelai.io" }],
  },
}));

// x402 payment gate on POST /send
app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "POST /send": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Send an SMS message via Twilio",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                to: {
                  type: "string",
                  description:
                    "Recipient phone number in E.164 format (e.g. +15551234567)",
                  required: true,
                },
                message: {
                  type: "string",
                  description:
                    "SMS message body (max 1600 characters)",
                  required: true,
                },
              },
            },
          },
        },
      },
    })
  )
);

app.post("/send", describeRoute({
  description: "Send an SMS message via Twilio. Requires x402 payment ($0.01).",
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["to", "message"],
          properties: {
            to: { type: "string", description: "Recipient phone number in E.164 format (e.g. +15551234567)" },
            message: { type: "string", description: "SMS message body (max 1600 characters)" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "SMS sent successfully", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Invalid request body" },
    402: { description: "Payment required" },
    502: { description: "Twilio API error" },
  },
}), async (c) => {
  const body = await c.req.json<{ to?: string; message?: string }>();

  // Validate 'to' field
  if (!body.to || typeof body.to !== "string") {
    return c.json({ error: "Missing required field: 'to'" }, 400);
  }
  if (!E164_REGEX.test(body.to)) {
    return c.json(
      {
        error:
          "Invalid phone number format. Must be E.164 (e.g. +15551234567)",
      },
      400
    );
  }

  // Validate 'message' field
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "Missing required field: 'message'" }, 400);
  }
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return c.json(
      {
        error: `Message too long. Maximum ${MAX_MESSAGE_LENGTH} characters, got ${body.message.length}`,
      },
      400
    );
  }

  // Call Twilio REST API
  const accountSid = c.env.TWILIO_ACCOUNT_SID;
  const authToken = c.env.TWILIO_AUTH_TOKEN;
  const fromNumber = c.env.TWILIO_PHONE_NUMBER;

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const params = new URLSearchParams();
  params.set("To", body.to);
  params.set("From", fromNumber);
  params.set("Body", body.message);

  const twilioResponse = await fetch(twilioUrl, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + btoa(`${accountSid}:${authToken}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!twilioResponse.ok) {
    const errorBody = await twilioResponse.text();
    return c.json(
      { error: "Twilio API error", status: twilioResponse.status, detail: errorBody },
      502
    );
  }

  const result = await twilioResponse.json<{
    sid: string;
    status: string;
    to: string;
    from: string;
  }>();

  return c.json({
    sid: result.sid,
    status: result.status,
    to: result.to,
    from: result.from,
  });
});

// Health check
app.get("/", describeRoute({
  description: "Health check and service info.",
  responses: {
    200: { description: "Service info", content: { "application/json": { schema: { type: "object" } } } },
  },
}), (c) => {
  return c.json({
    service: "x402-sms-send",
    description: "Send SMS messages via Twilio. Pay per message.",
    endpoint: "POST /send",
    price: "$0.01 per request (Base mainnet)",
  });
});

export default app;
