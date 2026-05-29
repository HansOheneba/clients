import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-05-27.dahlia",
});

const HANDLED_EVENTS: Stripe.Event.Type[] = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
];

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  if (!HANDLED_EVENTS.includes(event.type)) {
    return NextResponse.json({ received: true });
  }

  const { error } = await supabaseAdmin.from("stripe_events").insert({
    stripe_event_id: event.id,
    type: event.type,
    payload: event,
    processed: false,
  });

  // Ignore duplicate events - unique constraint violation on stripe_event_id
  if (error && error.code !== "23505") {
    console.error("[stripe/webhook] Failed to store event:", error);
    return NextResponse.json(
      { error: "Failed to store event" },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
