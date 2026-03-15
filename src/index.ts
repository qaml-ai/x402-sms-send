import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { openapiFromMiddleware } from "x402-openapi";

const app = new Hono<{ Bindings: Env }>();

// E.164 phone number format: + followed by 1-15 digits
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const MAX_MESSAGE_LENGTH = 1600;

const ROUTES = {
  "POST /": {
    accepts: [
      { scheme: "exact", price: "$0.01", network: "eip155:8453", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.01", network: "eip155:137", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.01", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Send an SMS message via Twilio. Send {\"to\": \"+15551234567\", \"message\": \"Hello\"}",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              to: { type: "string", description: "Recipient phone number in E.164 format (e.g. +15551234567)", required: true },
              message: { type: "string", description: "The SMS message body to send", required: true },
            },
          },
          output: { type: "json" },
        },
        schema: {
          properties: {
            input: {
              properties: { method: { type: "string", enum: ["POST"] } },
              required: ["method"],
            },
          },
        },
      },
    },
  },
};

app.use(stripeApiKeyMiddleware({ serviceName: "sms-send" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: ROUTES["POST /"].accepts.map((a: any) => ({ ...a, payTo: a.network.startsWith("solana") ? a.payTo : env.SERVER_ADDRESS as `0x${string}` })) },
  }))(c, next);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ to?: string; message?: string }>();
  if (!body?.to) {
    return c.json({ error: "Missing 'to' field. Provide a phone number in E.164 format (e.g. +15551234567)" }, 400);
  }
  if (!body?.message) {
    return c.json({ error: "Missing 'message' field" }, 400);
  }

  const to = body.to.trim();
  if (!E164_REGEX.test(to)) {
    return c.json(
      { error: "Invalid phone number format. Must be E.164 (e.g. +15551234567)" },
      400
    );
  }

  const message = body.message.trim();
  if (!message) {
    return c.json({ error: "Message cannot be empty" }, 400);
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return c.json(
      { error: `Message too long. Maximum ${MAX_MESSAGE_LENGTH} characters, got ${message.length}` },
      400
    );
  }

  // Call Twilio REST API
  const accountSid = c.env.TWILIO_ACCOUNT_SID;
  const authToken = c.env.TWILIO_AUTH_TOKEN;
  const fromNumber = c.env.TWILIO_PHONE_NUMBER;

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const twilioParams = new URLSearchParams();
  twilioParams.set("To", to);
  twilioParams.set("From", fromNumber);
  twilioParams.set("Body", message);

  const twilioResponse = await fetch(twilioUrl, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: twilioParams.toString(),
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

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 SMS Send", "sms.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-sms-send",
    description: 'Send SMS messages via Twilio. Send POST / with {"to": "+15551234567", "message": "Hello"}',
    price: "$0.01 per request (Base mainnet)",
  });
});

export default app;
