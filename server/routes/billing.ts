import crypto from 'node:crypto';
import express from 'express';
import {
  applyBillingUpgrade,
  applySubscriptionCanceled,
  db,
  exhaustFreeQuotaForTesting,
  getUserQuotaSnapshot,
  recordBillingAuditEvent,
  resetAccountToFreeForTesting,
} from '../db.ts';
import { resolveUserId } from '../middleware/monetization.ts';

export const billingRouter = express.Router();

function resolveValidPaddlePriceId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (trimmed && /^pri_[a-z0-9]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

const PADDLE_PRO_PRICE_ID = resolveValidPaddlePriceId(
  process.env.VITE_PADDLE_PRO_PRICE_ID,
  'pri_01m7r5t4g1487ktfj68gzrs431'
);
const PADDLE_TOKEN_PACK_PRICE_ID = resolveValidPaddlePriceId(
  process.env.VITE_PADDLE_TOKEN_PACK_PRICE_ID,
  'pri_01m7s0y3v873p7gxwr0v1ggc6c'
);

function isConfiguredSecret(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/placeholder|your_server_api_key/i.test(trimmed);
}

/**
 * Verifies Paddle Billing `paddle-signature` header (`ts=<unix>;h1=<hmac_sha256_hex>`)
 * using HMAC SHA-256 over `${ts}:${rawBody}` with PADDLE_WEBHOOK_SECRET_KEY.
 */
function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secretKey: string
): boolean {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(';').map((segment) => {
      const [k, ...rest] = segment.trim().split('=');
      return [k, rest.join('=')];
    })
  );

  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const signedPayload = `${ts}:${rawBody}`;
  const expectedHex = crypto
    .createHmac('sha256', secretKey)
    .update(signedPayload, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const receivedBuf = Buffer.from(h1, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

function resolveCheckoutUrl(req: express.Request): string | undefined {
  const candidates = [
    process.env.PADDLE_CHECKOUT_URL,
    req.get('origin'),
    process.env.APP_URL,
    req.get('x-forwarded-host')
      ? `${req.get('x-forwarded-proto') || 'https'}://${req.get('x-forwarded-host')}`
      : undefined,
    req.get('host') ? `${req.protocol}://${req.get('host')}` : undefined,
  ];

  let httpFallback: string | undefined;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed || /^MY_APP_URL$/i.test(trimmed)) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:') {
        return parsed.origin;
      }
      if (parsed.protocol === 'http:' && !httpFallback) {
        httpFallback = parsed.origin;
      }
    } catch {
      // Ignore malformed URL candidate
    }
  }
  return httpFallback;
}

/**
 * Initiates a Paddle or Stripe checkout session.
 * When PADDLE_API_KEY is configured, creates a Paddle transaction server-side so client-side
 * checkout receives a verified transactionId (and catches 403/domain/price errors cleanly).
 * Otherwise returns sandbox checkout metadata for seamless local testing.
 */
billingRouter.post('/checkout', async (req, res) => {
  const userId = resolveUserId(req);
  const { plan = 'pro', provider = 'paddle' } = req.body as {
    plan?: 'pro' | 'token_pack';
    provider?: 'stripe' | 'paddle';
  };

  if (plan !== 'pro' && plan !== 'token_pack') {
    res.status(400).json({ error: 'Invalid plan selected. Choose "pro" or "token_pack".' });
    return;
  }

  const amountCents = plan === 'pro' ? 4000 : 500;
  const sessionId = `cs_${provider}_${crypto.randomUUID().slice(0, 14)}`;
  const priceId = plan === 'pro' ? PADDLE_PRO_PRICE_ID : PADDLE_TOKEN_PACK_PRICE_ID;
  const checkoutUrl = resolveCheckoutUrl(req);

  let transactionId: string | undefined;
  let canOpenPaddleOverlay = false;
  let paddleFallbackReason: string | undefined;
  let paddleErrorCode: string | undefined;

  if (provider === 'paddle' && isConfiguredSecret(process.env.PADDLE_API_KEY)) {
    const apiKey = process.env.PADDLE_API_KEY!.trim();
    const isLiveKey =
      apiKey.startsWith('pdl_live_') ||
      (!apiKey.startsWith('pdl_sdbx_') && process.env.VITE_PADDLE_ENV === 'production');
    const paddleApiBase = isLiveKey
      ? 'https://api.paddle.com'
      : 'https://sandbox-api.paddle.com';

    const createPaddleTransaction = async (includeCheckoutUrl: boolean) => {
      const payload: Record<string, unknown> = {
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: {
          userId,
          plan,
        },
      };
      if (includeCheckoutUrl && checkoutUrl) {
        payload.checkout = { url: checkoutUrl };
      }
      return fetch(`${paddleApiBase}/transactions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    };

    try {
      let paddleRes = await createPaddleTransaction(Boolean(checkoutUrl));

      if (!paddleRes.ok && checkoutUrl) {
        const firstErr = (await paddleRes.clone().json().catch(() => null)) as {
          error?: { code?: string; detail?: string };
        } | null;

        if (firstErr?.error?.code === 'transaction_default_checkout_url_not_set' && !isLiveKey) {
          // Attempt to auto-configure the Sandbox Default Payment Link if API key permits it
          try {
            const patchRes = await fetch(`${paddleApiBase}/settings/checkout-url`, {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ default_url: checkoutUrl }),
            });
            if (patchRes.ok) {
              const retryAfterPatch = await createPaddleTransaction(true);
              if (retryAfterPatch.ok) {
                paddleRes = retryAfterPatch;
              }
            }
          } catch {
            // Fall through to structured fallback response if key lacks checkout_settings.write scope
          }
        } else if (
          firstErr?.error?.code &&
          firstErr.error.code !== 'transaction_default_checkout_url_not_set'
        ) {
          // If explicit checkout.url is rejected (e.g. unapproved domain), retry with account default link
          const retryRes = await createPaddleTransaction(false);
          if (retryRes.ok) {
            paddleRes = retryRes;
          }
        }
      }

      if (paddleRes.ok) {
        const paddleJson = (await paddleRes.json()) as { data?: { id?: string } };
        if (paddleJson?.data?.id) {
          transactionId = paddleJson.data.id;
          canOpenPaddleOverlay = true;
        }
      } else {
        const errPayload = (await paddleRes.json().catch(() => null)) as {
          error?: { code?: string; detail?: string };
        } | null;
        paddleErrorCode = errPayload?.error?.code;
        paddleFallbackReason =
          errPayload?.error?.detail ||
          `Paddle API returned HTTP ${paddleRes.status} (${errPayload?.error?.code || 'forbidden'}).`;
      }
    } catch (err) {
      paddleFallbackReason =
        err instanceof Error ? err.message : 'Unable to reach Paddle Billing API.';
    }
  }

  res.json({
    sessionId,
    provider,
    plan,
    priceId: provider === 'paddle' ? priceId : undefined,
    transactionId,
    canOpenPaddleOverlay,
    paddleFallbackReason,
    paddleErrorCode,
    suggestedCheckoutUrl: checkoutUrl,
    amountCents,
    sandboxMode:
      provider === 'paddle'
        ? (process.env.VITE_PADDLE_ENV || 'sandbox') !== 'production' ||
          !isConfiguredSecret(process.env.PADDLE_API_KEY)
        : !isConfiguredSecret(process.env.STRIPE_SECRET_KEY),
    checkoutMetadata: {
      userId,
      tier: plan,
      priceId: provider === 'paddle' ? priceId : undefined,
      tokensToAdd: plan === 'token_pack' ? 15 : 0,
    },
  });
});

/**
 * Completes a sandbox checkout directly (used in local preview/test mode)
 */
billingRouter.post('/sandbox-complete', (req, res) => {
  const userId = resolveUserId(req);
  const { plan = 'pro', provider = 'paddle' } = req.body as {
    plan?: 'pro' | 'token_pack';
    provider?: 'stripe' | 'paddle';
  };

  const amountCents = plan === 'pro' ? 4000 : 500;
  const eventType =
    provider === 'paddle'
      ? plan === 'pro'
        ? 'subscription.activated'
        : 'transaction.completed'
      : plan === 'pro'
      ? 'checkout.session.completed'
      : 'token_pack.purchased';

  const quota = applyBillingUpgrade({
    userId,
    provider,
    eventType,
    tier: plan,
    tokensToAdd: plan === 'token_pack' ? 15 : 0,
    amountCents,
    payload: { mode: 'sandbox', plan, provider, timestamp: new Date().toISOString() },
  });

  res.json({
    ok: true,
    message:
      plan === 'pro'
        ? `Upgraded to DocuCleanse Pro ($40/mo) via ${provider === 'paddle' ? 'Paddle' : 'Stripe'} — unlimited cleans & exports unlocked.`
        : `Added 15 Pro-grade file clean tokens ($5 Token Pack) via ${provider === 'paddle' ? 'Paddle' : 'Stripe'}.`,
    quota,
  });
});

/**
 * Paddle Billing Webhook Handler
 * Receives express.raw({ type: 'application/json' }) from server.ts for HMAC SHA-256 verification.
 * Handles:
 * - subscription.created / subscription.activated -> users.plan = 'pro'
 * - transaction.completed / transaction.paid -> token pack (+15 tokens) or pro fulfillment
 * - subscription.canceled -> reverts users.plan = 'free'
 */
billingRouter.post('/webhook/paddle', (req, res) => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : typeof req.body === 'string'
    ? req.body
    : JSON.stringify(req.body ?? {});

  const secretKey = process.env.PADDLE_WEBHOOK_SECRET_KEY;
  const signatureHeader = req.header('paddle-signature');

  if (secretKey && secretKey !== 'pdl_ntfset_placeholder') {
    if (!verifyPaddleSignature(rawBody, signatureHeader, secretKey)) {
      res.status(401).json({ error: 'Invalid Paddle-Signature HMAC SHA-256 verification.' });
      return;
    }
  }

  let event: {
    event_type?: string;
    data?: {
      custom_data?: {
        userId?: string;
        user_id?: string;
        plan?: string;
        tier?: string;
        tokensToAdd?: number;
      };
      details?: { totals?: { total?: string | number } };
      items?: Array<{ price?: { id?: string } }>;
    };
  };

  try {
    event = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    res.status(400).json({ error: 'Malformed JSON body in Paddle webhook.' });
    return;
  }

  const eventType = event?.event_type || 'subscription.activated';
  const custom = event?.data?.custom_data;
  const userId = custom?.userId || custom?.user_id || resolveUserId(req);

  const requestedPlan = custom?.plan || custom?.tier;
  const isTokenPack =
    requestedPlan === 'token_pack' ||
    Boolean(
      event?.data?.items?.some(
        (item) => item.price?.id === PADDLE_TOKEN_PACK_PRICE_ID
      )
    );

  const rawTotal = event?.data?.details?.totals?.total;
  const parsedTotal =
    rawTotal !== undefined && rawTotal !== null && !Number.isNaN(Number(rawTotal))
      ? Number(rawTotal)
      : isTokenPack
      ? 500
      : 4000;

  if (eventType === 'subscription.created' || eventType === 'subscription.activated') {
    const quota = applyBillingUpgrade({
      userId,
      provider: 'paddle',
      eventType,
      tier: 'pro',
      amountCents: parsedTotal,
      payload: event,
    });
    res.json({ received: true, provider: 'paddle', processedEvent: eventType, quota });
    return;
  }

  if (eventType === 'transaction.completed' || eventType === 'transaction.paid') {
    const tier = isTokenPack ? 'token_pack' : 'pro';
    const quota = applyBillingUpgrade({
      userId,
      provider: 'paddle',
      eventType,
      tier,
      tokensToAdd: tier === 'token_pack' ? Number(custom?.tokensToAdd) || 15 : 0,
      amountCents: parsedTotal,
      payload: event,
    });
    res.json({ received: true, provider: 'paddle', processedEvent: eventType, quota });
    return;
  }

  if (eventType === 'subscription.canceled') {
    const quota = applySubscriptionCanceled({
      userId,
      provider: 'paddle',
      eventType,
      payload: event,
    });
    res.json({ received: true, provider: 'paddle', processedEvent: eventType, quota });
    return;
  }

  // Record unhandled Paddle events into billing_events audit table
  recordBillingAuditEvent({
    userId,
    provider: 'paddle',
    eventType,
    planGranted: 'audit_only',
    amountCents: 0,
    payload: event,
  });

  res.json({ received: true, provider: 'paddle', ignored: true, eventType });
});

/**
 * Stripe Webhook Handler Stub
 */
billingRouter.post('/webhook/stripe', (req, res) => {
  const sig = req.header('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (
    webhookSecret &&
    webhookSecret !== 'whsec_placeholder' &&
    sig &&
    !sig.startsWith('t=')
  ) {
    res.status(400).json({ error: 'Invalid Stripe webhook signature format.' });
    return;
  }

  const event = req.body as {
    type?: string;
    data?: {
      object?: {
        metadata?: { userId?: string; tier?: 'pro' | 'token_pack'; tokensToAdd?: number };
        amount_total?: number;
      };
    };
  };

  const eventType = event?.type || 'checkout.session.completed';
  const meta = event?.data?.object?.metadata;
  const userId = meta?.userId || resolveUserId(req);
  const tier = meta?.tier === 'token_pack' ? 'token_pack' : 'pro';
  const amountCents = event?.data?.object?.amount_total ?? (tier === 'pro' ? 4000 : 500);

  if (eventType === 'checkout.session.completed' || eventType === 'invoice.paid') {
    const quota = applyBillingUpgrade({
      userId,
      provider: 'stripe',
      eventType,
      tier,
      tokensToAdd: Number(meta?.tokensToAdd) || (tier === 'token_pack' ? 15 : 0),
      amountCents,
      payload: event,
    });

    res.json({ received: true, provider: 'stripe', processedEvent: eventType, quota });
    return;
  }

  res.json({ received: true, ignored: true, eventType });
});

/**
 * Billing event audit log + sandbox testing controls (reset to Free / simulate exhausted quota)
 */
billingRouter.get('/status', (req, res) => {
  const userId = resolveUserId(req);
  const quota = getUserQuotaSnapshot(userId);
  const events = db
    .prepare(
      `SELECT id, provider, event_type, plan_granted, amount_cents, created_at
       FROM billing_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 15`
    )
    .all(userId);

  res.json({ quota, events });
});

billingRouter.post('/demo-state', (req, res) => {
  const userId = resolveUserId(req);
  const { mode } = req.body as { mode: 'reset_free' | 'exhaust_free' };

  if (mode === 'exhaust_free') {
    const quota = exhaustFreeQuotaForTesting(userId);
    res.json({ ok: true, quota });
    return;
  }

  const quota = resetAccountToFreeForTesting(userId);
  res.json({ ok: true, quota });
});
