# eBay integration setup

The Reselling Manager eBay integration uses eBay OAuth 2.0, the GraphQL Listing API, and the Sell Fulfillment API. The eBay login happens on eBay's own domain. The app stores only an encrypted refresh token; it never stores an eBay password.

## 1. Create an eBay Developer application

1. Sign in at https://developer.ebay.com/my/keys.
2. Create or select a **Production** keyset.
3. Complete eBay's production keyset compliance step for marketplace account deletion/closure notifications if prompted.
4. Open **User Tokens** for the Production keyset and create a RuName.
5. Set both the accepted and declined URLs to:

   `https://feature-google-auth-cloud-sync-reselling-manager.j6c2njff5r.workers.dev/api/ebay/callback`

6. Save the generated RuName. You need the Production App ID (Client ID), Cert ID (Client Secret), and RuName.

The eBay developer application must allow these OAuth user scopes:

- `https://api.ebay.com/oauth/api_scope/sell.listing.read`
- `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`

The eBay app's Production keyset and RuName must be used together. Sandbox credentials cannot authorize production account data.

## 2. Add Cloudflare Worker secrets

Set these values as Worker secrets for the **reselling-manager** Worker (and for the preview Worker too, if Cloudflare keeps preview secrets separate):

- `SUPABASE_PUBLISHABLE_KEY`: the Supabase project's publishable key.
- `SUPABASE_SECRET_KEY`: the Supabase project's server-only secret key. Never expose it in browser code or Git.
- `EBAY_CLIENT_ID`: the eBay Production App ID.
- `EBAY_CLIENT_SECRET`: the eBay Production Cert ID.
- `EBAY_RU_NAME`: the generated Production RuName.
- `EBAY_TOKEN_ENCRYPTION_KEY`: a randomly generated, Base64-encoded 32-byte key.

Generate the encryption key on a trusted machine with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Add each secret using Cloudflare's Worker settings or Wrangler:

```bash
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY --name reselling-manager
npx wrangler secret put SUPABASE_SECRET_KEY --name reselling-manager
npx wrangler secret put EBAY_CLIENT_ID --name reselling-manager
npx wrangler secret put EBAY_CLIENT_SECRET --name reselling-manager
npx wrangler secret put EBAY_RU_NAME --name reselling-manager
npx wrangler secret put EBAY_TOKEN_ENCRYPTION_KEY --name reselling-manager
```

Do not put any of these values in source files, GitHub, or the browser. The Supabase secret key bypasses row-level security and must remain server-only.

## 3. Connect and test

1. Open the Reselling Manager and sign in.
2. Go to **Einstellungen → Integrationen → eBay → Mit eBay verbinden**.
3. Sign in at eBay and approve the requested read permissions.
4. Return to the Reselling Manager, select **Jetzt synchronisieren**, and check the imported offers and recent paid orders.

The current implementation synchronizes on demand and has a six-hour Cloudflare Cron schedule. It imports active, ended, and scheduled listings, plus orders returned by the Fulfillment API. The initial order import covers the most recent 90 days. The current listing search reads the first result page for each listing state and caps the combined import at 100 offers; full pagination is a follow-up improvement.

Imported eBay listings and orders are stored in dedicated tables and shown in the eBay integration panel. They are not yet automatically converted into inventory products or matched to existing product records. Order imports cover completed checkout; eBay's Fulfillment API does not return checkout orders that are still pending payment.

## 4. Production cutover

The callback URL above is the feature preview URL. Before the feature is merged or deployed under a different Worker hostname, update the eBay RuName's accepted and declined URLs to the final production callback URL and confirm the matching RuName/Worker secrets are configured for that environment.
