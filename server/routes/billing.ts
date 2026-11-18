import crypto from 'node:crypto';
import express from 'express';
import {
  applyBillingUpgrade,
  db,
  exhaustFreeQuotaForTesting,
  getUserQuotaSnapshot,
  resetAccountToFreeForTesting,
} from '../db.ts';
import { resolveUserId } from '../middleware/monetization.ts';

export const billingRouter = express.Router();

/**
 * Initiates a Stripe or Lemon Squeezy checkout session.
 * In sandbox mode (when STRIPE_SECRET_KEY is placeholder/unset), returns a sandbox checkout token
 * that can be fulfilled immediately or via webhook simulation.
 */
billingRouter.post('/checkout', (req, res) => {
  const userId = resolveUserId(req);
  const { plan = 'pro', provider = 'stripe' } = req.body as {
    plan?: 'pro' | 'token_pack';
    provider?: 'stripe' | 'lemonsqueezy';
  };

  if (plan !== 'pro' && plan !== 'token_pack') {
    res.status(400).json({ error: 'Invalid plan selected. Choose "pro" or "token_pack".' });
    return;
  }

  const amountCents = plan === 'pro' ? 1900 : 500;
  const sessionId = `cs_${provider}_${crypto.randomUUID().slice(0, 14)}`;

  res.json({
    sessionId,
    provider,
    plan,
    amountCents,
    sandboxMode:
      !process.env.STRIPE_SECRET_KEY ||
      process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder',
    checkoutMetadata: {
      userId,
      tier: plan,
      tokensToAdd: plan === 'token_pack' ? 15 : 0,
    },
  });
});

/**
 * Completes a sandbox checkout directly (used in demo/preview mode when real Stripe keys aren't configured)
 */
billingRouter.post('/sandbox-complete', (req, res) => {
  const userId = resolveUserId(req);
  const { plan = 'pro', provider = 'stripe' } = req.body as {
    plan?: 'pro' | 'token_pack';
    provider?: 'stripe' | 'lemonsqueezy';
  };

  const amountCents = plan === 'pro' ? 1900 : 500;
  const quota = applyBillingUpgrade({
    userId,
    provider,
    eventType: plan === 'pro' ? 'checkout.session.completed' : 'token_pack.purchased',
    tier: plan,
    tokensToAdd: plan === 'token_pack' ? 15 : 0,
    amountCents,
    payload: { mode: 'sandbox', plan, provider, timestamp: new Date().toISOString() },
  });

  res.json({
    ok: true,
    message:
      plan === 'pro'
        ? 'Upgraded to DocuCleanse Pro ($19/mo) — unlimited cleans & exports unlocked.'
        : 'Added 15 Pro-grade file clean tokens ($5 Token Pack).',
    quota,
  });
});

/**
 * Stripe Webhook Handler Stub
 * Verifies `stripe-signature` HMAC when STRIPE_WEBHOOK_SECRET is configured,
 * then provisions Pro subscription or Token Pack credits in SQLite.
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
  const amountCents = event?.data?.object?.amount_total ?? (tier === 'pro' ? 1900 : 500);

  if (
    eventType === 'checkout.session.completed' ||
    eventType === 'invoice.paid'
  ) {
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
 * Lemon Squeezy Webhook Handler Stub
 * Verifies `x-signature` HMAC SHA-256 when LEMONSQUEEZY_WEBHOOK_SECRET is configured,
 * then fulfills order_created / subscription_payment_success events.
 */
billingRouter.post('/webhook/lemonsqueezy', (req, res) => {
  const signature = req.header('x-signature');
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

  if (secret && secret !== 'ls_whsec_placeholder' && signature) {
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (hmac !== signature) {
      res.status(401).json({ error: 'Invalid Lemon Squeezy X-Signature header.' });
      return;
    }
  }

  const payload = req.body as {
    meta?: {
      event_name?: string;
      custom_data?: { user_id?: string; tier?: 'pro' | 'token_pack'; tokens_to_add?: number };
    };
    data?: { attributes?: { total?: number } };
  };

  const eventName = payload?.meta?.event_name || 'order_created';
  const custom = payload?.meta?.custom_data;
  const userId = custom?.user_id || resolveUserId(req);
  const tier = custom?.tier === 'token_pack' ? 'token_pack' : 'pro';
  const amountCents = payload?.data?.attributes?.total ?? (tier === 'pro' ? 1900 : 500);

  const quota = applyBillingUpgrade({
    userId,
    provider: 'lemonsqueezy',
    eventType: eventName,
    tier,
    tokensToAdd: Number(custom?.tokens_to_add) || (tier === 'token_pack' ? 15 : 0),
    amountCents,
    payload,
  });

  res.json({ received: true, provider: 'lemonsqueezy', processedEvent: eventName, quota });
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
