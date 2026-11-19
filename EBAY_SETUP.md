# eBay integration setup

The Reselling Manager eBay integration uses eBay OAuth 2.0, the GraphQL Listing API, and the Sell Fulfillment API. The eBay login happens on eBay's own domain. The app stores only an encrypted refresh token; it never stores an eBay password.

## 1. Create or open the eBay Production keyset

1. Sign in at https://developer.ebay.com/my/keys.
2. Open **Application Keys** and choose the **Production** keyset for this Reselling Manager application. Do not use Sandbox credentials for your real seller account.
3. If eBay says the Production keyset is disabled, complete the marketplace account deletion/closure notifications compliance step shown in the developer portal.
4. Record the Production **App ID (Client ID)** and **Cert ID (Client Secret)**. Keep the Cert ID private; never paste it into chats, GitHub, or frontend settings.

eBay creates different credentials for Sandbox and Production. Use the Production App ID, Cert ID and RuName together. See the [official keyset guide](https://developer.ebay.com/develop/guides/sell/get-started-with-ebay-apis).

## 2. Create the Production RuName

1. On the Production keyset, open **User Tokens**.
2. Select **Get a Token from eBay via Your Application**. If no redirect URL exists, choose the link to add one.
3. Configure the RuName. Set both **Auth Accepted URL** and **Auth Declined URL** to this exact callback:
   `https://reselling-manager.j6c2njff5r.workers.dev/api/ebay/callback`
4. Save it and copy the generated **RuName** value.

Do not use the old feature-preview hostname. The application sends the RuName as eBay's `redirect_uri`; the accepted/declined URL configured inside the RuName must point to the production callback above. See [eBay OAuth authorization](https://developer.ebay.com/develop/guides/sell/authorization).

## 3. OAuth permissions used by the app

The app requests only these read scopes:

- `https://api.ebay.com/oauth/api_scope/sell.listing.read`
- `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`

They allow the current integration to read seller listings and completed order/fulfillment data. The integration does not currently create, edit, end, or relist offers.

## 4. Configure Cloudflare Worker secrets

Open Cloudflare → Workers & Pages → **reselling-manager** → Settings → Variables and Secrets. Add the following as **Secrets**, not plain-text variables:

- `SUPABASE_PUBLISHABLE_KEY`: the project's publishable key.
- `SUPABASE_SECRET_KEY`: the project's server-only secret key.
- `EBAY_CLIENT_ID`: Production App ID.
- `EBAY_CLIENT_SECRET`: Production Cert ID.
- `EBAY_RU_NAME`: the Production RuName.
- `EBAY_TOKEN_ENCRYPTION_KEY`: a randomly generated, Base64-encoded 32-byte key.

Generate the encryption key locally on a trusted computer with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Never put secret values in source files, GitHub, browser settings or this chat. The Supabase secret key bypasses row-level security and must remain server-only. The eBay Cert ID and encryption key must also remain private.

## 5. Connect and test

1. Open the production app: https://reselling-manager.j6c2njff5r.workers.dev
2. Sign in to the correct Reselling Manager account.
3. Go to **Einstellungen → Integrationen → eBay → Mit eBay verbinden**.
4. Sign in at eBay and approve the requested read permissions.
5. Return to the Reselling Manager and select **Jetzt synchronisieren**.

The Worker runs a scheduled synchronization every six hours and supports manual synchronization. It currently imports active, ended and scheduled listings and completed checkout orders from the preceding 90 days. Listing imports are presently capped at 100 offers because the implementation reads only the first result page for each listing state.

Imported offers and order line items are stored in dedicated tables and shown in the eBay integration panel. They are not yet automatically converted into inventory products or matched to existing product records. The current scopes are read-only; automatic delisting is not included.

## 6. Verify before relying on the integration

- Confirm the eBay status changes to **Verbunden**.
- Run a manual sync and compare the imported listings/orders against the eBay seller account.
- Confirm the last-sync timestamp and check any displayed error before assuming the import is complete.
- Test that another Reselling Manager account cannot see this account's imported eBay data.
