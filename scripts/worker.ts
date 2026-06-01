import "dotenv/config";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

// ── Env ───────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing env variable: ${key}`);
  return value;
}

const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");
const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const GOOGLE_CLIENT_EMAIL = requireEnv("GOOGLE_CLIENT_EMAIL");
const GOOGLE_PRIVATE_KEY = requireEnv("GOOGLE_PRIVATE_KEY").replace(
  /\\n/g,
  "\n",
);
const GOOGLE_SHEET_ID = requireEnv("GOOGLE_SHEET_ID");
const GOOGLE_SHEET_TAB = process.env.GOOGLE_SHEET_TAB?.trim() ?? "Sheet1";

// ── Clients ───────────────────────────────────────────────────────────────────

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2026-05-27.dahlia",
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const sheetsAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

// ── Helpers ───────────────────────────────────────────────────────────────────

type CellValue = string | number | boolean | null;

function toDate(unix: number | null | undefined): string | null {
  if (unix == null) return null;
  const d = new Date(unix * 1000);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${month}/${day}/${year} ${hh}:${mm}:${ss}`;
}

function toDollars(cents: number | null | undefined): number | null {
  if (cents == null) return null;
  return cents / 100;
}

function strId(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object" && "id" in (val as object))
    return (val as { id: string }).id;
  return null;
}

// ── Row builder ───────────────────────────────────────────────────────────────

async function buildRow(event: Stripe.Event): Promise<CellValue[]> {
  let pi: Stripe.PaymentIntent | null = null;
  let charge: Stripe.Charge | null = null;
  let balanceTxn: Stripe.BalanceTransaction | null = null;
  let customer: Stripe.Customer | null = null;
  let refund: Stripe.Refund | null = null;

  if (
    event.type === "payment_intent.succeeded" ||
    event.type === "payment_intent.payment_failed"
  ) {
    pi = event.data.object as Stripe.PaymentIntent;

    const chargeId = strId(pi.latest_charge);
    if (chargeId) {
      charge = await stripe.charges.retrieve(chargeId);
    }
  } else if (event.type === "charge.refunded") {
    charge = event.data.object as Stripe.Charge;

    const piId = strId(charge.payment_intent);
    if (piId) {
      pi = await stripe.paymentIntents.retrieve(piId);
    }
  }

  if (charge) {
    const btId = strId(charge.balance_transaction);
    if (btId) {
      balanceTxn = await stripe.balanceTransactions.retrieve(btId);
    }

    if (charge.refunds?.data?.length) {
      refund = charge.refunds.data[0];
    }
  }

  const customerId = strId(pi?.customer ?? charge?.customer);
  if (customerId) {
    const retrieved = await stripe.customers.retrieve(customerId);
    if (!("deleted" in retrieved)) {
      customer = retrieved as Stripe.Customer;
    }
  }

  const taxFeeDetail =
    balanceTxn?.fee_details?.find((f) => f.type === "tax") ?? null;

  // Row in EXACT column order matching the sheet headers
  return [
    pi?.id ?? charge?.id ?? null, // id
    toDate(charge?.created ?? pi?.created), // Created date (UTC)
    toDollars(pi?.amount ?? charge?.amount), // Amount
    toDollars(charge?.amount_refunded), // Amount Refunded
    (pi?.currency ?? charge?.currency ?? "").toUpperCase() || null, // Currency
    charge?.captured ?? null, // Captured
    toDollars(balanceTxn?.amount), // Converted Amount
    toDollars(refund?.amount), // Converted Amount Refunded
    balanceTxn?.currency?.toUpperCase() ?? null, // Converted Currency
    (pi?.last_payment_error as { decline_code?: string } | null)
      ?.decline_code ?? null, // Decline Reason
    pi?.description ?? charge?.description ?? null, // Description
    toDollars(balanceTxn?.fee), // Fee
    toDate(refund?.created), // Refunded date (UTC)
    charge?.statement_descriptor ?? null, // Statement Descriptor
    pi?.status ?? charge?.status ?? null, // Status
    pi?.last_payment_error?.message ?? null, // Seller Message
    toDollars(taxFeeDetail?.amount), // Taxes On Fee
    strId(
      charge?.payment_method ??
        (pi?.last_payment_error as { payment_method?: unknown } | null)
          ?.payment_method,
    ), // Card ID
    customerId ?? null, // Customer ID
    customer?.description ?? null, // Customer Description
    customer?.email ?? null, // Customer Email
    strId((pi as unknown as Record<string, unknown>)?.invoice), // Invoice ID
    strId(charge?.transfer), // Transfer
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("=".repeat(60));
  console.log("[worker] Starting run:", new Date().toISOString());
  console.log("[worker] Config:");
  console.log("  SUPABASE_URL    :", SUPABASE_URL);
  console.log("  SHEET_ID        :", GOOGLE_SHEET_ID);
  console.log("  SHEET_TAB       :", GOOGLE_SHEET_TAB);
  console.log("  CLIENT_EMAIL    :", GOOGLE_CLIENT_EMAIL);
  console.log(
    "  PRIVATE_KEY set :",
    GOOGLE_PRIVATE_KEY.length > 50 ? "yes" : "NO - check env",
  );
  console.log("=".repeat(60));

  // Step 1 - check total rows in table (all, not just unprocessed)
  const { count: totalCount, error: countError } = await supabase
    .from("stripe_events")
    .select("*", { count: "exact", head: true });

  if (countError) {
    console.error(
      "[worker] Could not count stripe_events table:",
      JSON.stringify(countError, null, 2),
    );
    console.error(
      "[worker] This likely means the table does not exist or RLS is blocking access.",
    );
    process.exit(1);
  }
  console.log(`[worker] Total rows in stripe_events: ${totalCount ?? 0}`);

  if ((totalCount ?? 0) === 0) {
    console.log(
      "[worker] Table is empty - no Stripe webhooks have been received yet.",
    );
    console.log(
      "[worker] Send a test payment through Stripe to populate the table.",
    );
    return;
  }

  // Step 2 - fetch unprocessed
  const { data: records, error } = await supabase
    .from("stripe_events")
    .select("*")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error(
      "[worker] Failed to fetch unprocessed events:",
      JSON.stringify(error, null, 2),
    );
    process.exit(1);
  }

  if (!records?.length) {
    console.log(
      `[worker] All ${totalCount} row(s) are already processed = true. Nothing to do.`,
    );
    return;
  }

  console.log(
    `[worker] Found ${records.length} unprocessed event(s) to process.`,
  );

  for (const record of records) {
    const { id, stripe_event_id, type, payload } = record;
    console.log("-".repeat(60));
    console.log(
      `[worker] Processing: ${type} | stripe_event_id: ${stripe_event_id} | db id: ${id}`,
    );

    try {
      const event = payload as Stripe.Event;

      console.log(`[worker]   Building row from Stripe data...`);
      const row = await buildRow(event);
      console.log(
        `[worker]   Row built (${row.length} columns):`,
        JSON.stringify(row),
      );

      console.log(`[worker]   Writing to sheet "${GOOGLE_SHEET_TAB}"...`);

      // Get the sheet ID (gid) needed for insertDimension
      const sheetMeta = await sheets.spreadsheets.get({
        spreadsheetId: GOOGLE_SHEET_ID,
      });
      const sheetObj = sheetMeta.data.sheets?.find(
        (s) => s.properties?.title === GOOGLE_SHEET_TAB,
      );
      const sheetGid = sheetObj?.properties?.sheetId ?? 0;

      // Insert a blank row at index 1 (row 2), then clear its formatting
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: sheetGid,
                  dimension: "ROWS",
                  startIndex: 1,
                  endIndex: 2,
                },
                inheritFromBefore: false,
              },
            },
            {
              repeatCell: {
                range: {
                  sheetId: sheetGid,
                  startRowIndex: 1,
                  endRowIndex: 2,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 1, blue: 1 },
                    textFormat: {
                      bold: false,
                      italic: false,
                      fontSize: 10,
                      foregroundColor: { red: 0, green: 0, blue: 0 },
                    },
                    horizontalAlignment: "LEFT",
                    verticalAlignment: "BOTTOM",
                  },
                },
                fields:
                  "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
              },
            },
          ],
        },
      });

      // Write the row data into the newly inserted row 2
      const writeResult = await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${GOOGLE_SHEET_TAB}!A2`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      const appendResult = writeResult;
      console.log(
        `[worker]   Sheet write result: ${appendResult.data.updatedRange} - ${appendResult.data.updatedCells} cell(s) written`,
      );

      const { error: updateError } = await supabase
        .from("stripe_events")
        .update({ processed: true })
        .eq("id", id);

      if (updateError) {
        console.error(
          `[worker]   Failed to mark processed in Supabase:`,
          JSON.stringify(updateError, null, 2),
        );
      } else {
        console.log(`[worker]   Marked processed = true in Supabase. Done.`);
      }
    } catch (err) {
      console.error(`[worker]   ERROR on ${stripe_event_id}:`);
      if (err instanceof Error) {
        console.error(`    message: ${err.message}`);
        console.error(`    stack:   ${err.stack}`);
      } else {
        console.error(`    raw:`, err);
      }
    }
  }

  console.log("=".repeat(60));
  console.log("[worker] Finished.");
}

run().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
