# Gmail shipping import

The Reselling Manager searches Gmail on demand for actual shipping notifications, extracts usable tracking links and suggests matching inventory products.

## Google setup

1. Enable the Gmail API in the Google Cloud project.
2. Configure the OAuth consent screen / Google Auth Platform. For personal use, keep the app in Testing and add the Gmail account as a test user.
3. Create an OAuth client of type Web application.
4. Add the exact deployed application origin shown in Reselling Manager → Settings → Gmail-Versandimport to Authorized JavaScript origins. Do not add a path or trailing slash.
5. Copy the OAuth Client ID (ending in .apps.googleusercontent.com) into Reselling Manager. Do not paste a Client Secret.

The application uses Google's browser token flow and the read-only scope https://www.googleapis.com/auth/gmail.readonly. It does not request permission to send, delete, or modify email.

## Search and matching

- Gmail is searched only after a user action. The selected 30/90/180/365-day window is used.
- The query covers several common German and English dispatch phrases and paginates beyond the first 100 results (up to 300 messages per search).
- A message is not accepted just because it contains the word "delivery" or an unrelated promotional link. The parser looks for explicit dispatch/tracking language and a link that actually resembles a tracking endpoint.
- Gmail social, spam and trash messages are ignored. Bulk/promotional mail is rejected unless it contains strong shipment evidence such as a tracking number.
- Tracking links are checked for HTTPS, unsafe hosts and carrier-domain lookalikes. A message contributes only a small number of high-ranked tracking links.
- Repeated notifications for the same tracking number are deduplicated. The newest useful message for a parcel is retained.
- Local product matching uses distinctive words from the actual email content. Sender identity or a carrier name alone is not sufficient evidence to assign a product.
- Ambiguous matches remain unassigned. The user must review and explicitly apply every tracking link.

## Optional semantic AI matching

The setting "KI-Produktabgleich aktivieren (BGE-M3)" is off by default.

When enabled, the app sends only the following minimized information for the current on-demand matching operation to the same-origin Cloudflare Worker and Cloudflare Workers AI:

- A minimized subject/body excerpt, with detected email addresses, phone numbers, addresses and URLs stripped where possible.
- The sender's domain (not the sender's full email address).
- Product name, category, platform/store field, purchase/sale dates and status.

It does not send receipt files, images, product prices or the entire Gmail mailbox. The short-lived Gmail access token is passed to the Worker only so it can confirm that the request comes from a currently authorized Gmail session using the Gmail profile endpoint. The Worker does not store the token, email data or embeddings. Only the minimised matching text is passed to the BGE-M3 embedding model. Cloudflare lists BGE-M3 as multilingual and zero-data-retention.

The semantic model ranks products by meaning rather than exact word overlap. Its score is a similarity score, not a calibrated probability. A product is suggested only when the best result clears a threshold and has a clear lead over the next result. The user must still confirm the assignment.

This AI matching does not perform general Google searches or infer a product from a retailer name alone. For example, if a Universal Music email contains no Taylor Swift product reference, the model cannot safely prove that it belongs to a Taylor Swift product. Sender/brand-only guesses are deliberately not auto-assigned.

## Privacy and storage

- Without the optional AI setting, message parsing stays in the browser.
- Gmail access remains read-only. The access token stays in component memory and is not written to browser storage.
- Product and tracking details continue to be stored in the browser's local product storage.
- Gmail message content, AI excerpts and tokens are not added to the backup.
- Clearing this browser's site data also clears local products, tracking links and the saved OAuth Client ID.

## Background synchronization

This release remains on-demand: scanning and AI matching only run when the website is open and the user starts a search. It does not poll Gmail while the app is closed.

A true unattended background sync needs a separate authenticated backend, a server-side OAuth authorization-code flow, encrypted refresh-token storage, and a protected cloud database for the user's products. A Cloudflare Cron Trigger could then schedule sync jobs. That architecture is intentionally not added to this browser-local app because adding a long-lived Gmail refresh token to frontend storage would be unsafe.
