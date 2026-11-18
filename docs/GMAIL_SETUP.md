# Gmail shipping import setup

The Reselling Manager can scan Gmail on demand for shipping confirmation messages and let you attach their tracking links to individual products.

## What this integration does

- Uses Google's browser-based OAuth token flow and the official Gmail API.
- Requests only `https://www.googleapis.com/auth/gmail.readonly`.
- Searches up to the 100 newest matching messages in the selected 30/90/180/365-day window.
- Extracts HTTPS tracking links, carrier names for known carrier domains, and clearly labelled tracking numbers.
- Processes message content in the browser. The message body is not sent to this Worker or to an AI service.
- Keeps the short-lived access token in component memory only. It is not put in localStorage, IndexedDB, a cookie, or the application backup.
- Requires a user click before scanning and another explicit confirmation before attaching a result to a product.
- Leaves ambiguous product matches unassigned, and asks before replacing an existing tracking link.

This first version is an on-demand import. It does not run while the website is closed, and it does not continuously poll Gmail.

## Google Cloud setup

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a Google Cloud project (or select a dedicated project for this application).
3. In **APIs & Services → Library**, enable the **Gmail API**.
4. Configure the OAuth consent screen / Google Auth Platform:
   - Set the app name and support contact.
   - For personal testing, keep the app in **Testing** and add the Gmail account you will use as a test user.
   - Request only the Gmail read-only scope used by this integration.
5. Under **Clients**, create an OAuth client with application type **Web application**.
6. Add the exact deployed application origin shown in Reselling Manager → Settings → Gmail shipping import to **Authorized JavaScript origins**. Do not add a path or trailing slash. For local development, also add `http://localhost:5173` if you use Vite's default development server.
7. Copy the OAuth **Client ID** (the value ending in `.apps.googleusercontent.com`) into Reselling Manager → Settings → Gmail shipping import.

The browser token flow does not use a client secret or a redirect URI. Never paste a client secret into the website or commit it to this repository.

Google may require additional verification before an OAuth app using Gmail restricted scopes can be made generally available. For a personal/testing app, use the supported testing configuration and check the OAuth consent screen's current status in Google Cloud.

## Use

1. Open **Settings → Gmail-Versandimport**.
2. Choose the time window to search.
3. Select **Gmail verbinden & suchen** and approve the read-only permission in Google's consent window.
4. Review every candidate: email subject, sender, carrier, tracking link and any suggested product.
5. Pick the matching product and direction (incoming purchase or outgoing sale), then select **Übernehmen**.

A suggestion is not treated as a confirmed match. The app avoids suggesting an automatic product assignment when multiple inventory units match equally. You can still choose the right unit manually.

If Google access expires, connect again. Use **Trennen** to revoke the current browser token grant.

## Data and privacy

- The imported tracking fields are stored with the product in the browser's existing local product storage.
- Gmail message content and OAuth tokens are not added to the application's PDF backup.
- The public Google OAuth Client ID is stored locally so you do not have to re-enter it on this device.
- Clearing this browser's site data also clears local products, tracking links and the saved Client ID. Keep using the application's backup feature for product and receipt backups.

## Future background synchronization

Automatic syncing when the application is closed requires a separate architecture: authenticated user identity, a server-side OAuth authorization-code flow, securely stored and encrypted refresh tokens, and a protected server-side product data store. Scheduled syncing can then be added with a Cloudflare Worker Cron Trigger. Gmail push notifications are optional and require Google Cloud Pub/Sub plus a renewable Gmail mailbox watch. Do not add a refresh token to browser storage or expose it to frontend JavaScript.
