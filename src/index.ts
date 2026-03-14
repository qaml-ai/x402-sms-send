import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";
import { openapiFromMiddleware } from "x402-openapi";

const app = new Hono<{ Bindings: Env }>();

// E.164 phone number format: + followed by 1-15 digits
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const MAX_MESSAGE_LENGTH = 1600;

const SYSTEM_PROMPT = `You are a parameter extractor for an SMS sending service.
Extract the following from the user's message and return JSON:
- "to": the recipient phone number in E.164 format (e.g. +15551234567). (required)
- "message": the SMS message body to send. (required)

Return ONLY valid JSON, no explanation.
Examples:
- {"to": "+15551234567", "message": "Hello, this is a test message"}
- {"to": "+442071234567", "message": "Meeting at 3pm tomorrow"}`;

const ROUTES = {
  "POST /": {
    accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:8453", payTo: "0x0" as `0x${string}` }],
    description: "Send an SMS message via Twilio. Send {\"input\": \"your request\"}",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              input: { type: "string", description: "Describe the SMS to send, including the recipient phone number and message", required: true },
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
    "POST /": { ...ROUTES["POST /"], accepts: [{ ...ROUTES["POST /"].accepts[0], payTo: env.SERVER_ADDRESS as `0x${string}` }] },
  }))(c, next);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);

  const to = params.to as string | undefined;
  const message = params.message as string | undefined;

  // Validate 'to' field
  if (!to || typeof to !== "string") {
    return c.json({ error: "Could not extract recipient phone number from your input" }, 400);
  }
  if (!E164_REGEX.test(to)) {
    return c.json(
      { error: "Invalid phone number format. Must be E.164 (e.g. +15551234567)" },
      400
    );
  }

  // Validate 'message' field
  if (!message || typeof message !== "string") {
    return c.json({ error: "Could not extract message text from your input" }, 400);
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
    description: 'Send SMS messages via Twilio. Send POST / with {"input": "send hello to +15551234567"}',
    price: "$0.01 per request (Base mainnet)",
  });
});

export default app;
