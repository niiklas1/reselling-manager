# Gmail shipping import

The Reselling Manager searches Gmail on demand for parcel dispatch, handover, delivery and pickup notifications, extracts tracking links, deduplicates repeated updates and suggests the matching inventory product.

## Google setup

1. Enable the Gmail API in the Google Cloud project.
2. Configure the OAuth consent screen / Google Auth Platform. For personal use, keep the app in Testing and add the Gmail account as a test user.
3. Create an OAuth client of type Web application.
4. Add the exact deployed application origin shown in Reselling Manager → Settings → Gmail-Versandimport to Authorized JavaScript origins. Do not add a path or trailing slash.
5. Copy the OAuth Client ID (ending in .apps.googleusercontent.com) into Reselling Manager. Do not paste a Client Secret.

The application uses Google's browser token flow and the read-only scope https://www.googleapis.com/auth/gmail.readonly. It does not request permission to send, delete, or modify email.

## Search and extraction

- Gmail is searched only after a user action. The selected 30/90/180/365-day window is used.
- The original English/German shipping query remains. A second supplemental query adds dispatch handover, carrier pickup, ready-for-pickup and last-mile phrases. Results are merged and deduplicated before message bodies are fetched.
- Gmail pagination uses nextPageToken; the messages API returns message IDs/thread IDs and supports page sizes up to 500. The app deliberately retrieves messages in small batches to avoid making excessive concurrent requests.
- A message is not accepted just because it contains the word "delivery" or an unrelated promotional link. The parser looks for concrete dispatch/tracking language and a link that resembles a tracking endpoint or a clearly labelled order/shipment action.
- HTML links are evaluated with their nearby button/card text as context. This helps with retailer emails where the link itself is an opaque redirect or says "View order" instead of "Tracking".
- Gmail social, spam and trash messages are ignored. Bulk/promotional mail is rejected unless it contains strong shipment evidence such as a tracking number.
- Tracking links are checked for HTTPS, unsafe hosts and carrier-domain lookalikes. International recognition includes common postal/courier providers such as Royal Mail, USPS, Canada Post, Australia Post, Austrian Post, Swiss Post, Correos, Poste Italiane, Cainiao, YunExpress, 4PX and others.
- Repeated notifications for the same tracking number are deduplicated. The newest useful message for a parcel is retained.
- Tracking data already attached to a product is excluded from new candidates.

## Three-model AI matching

The optional setting "KI-Produktabgleich aktivieren (3-Modelle-Ensemble)" is off by default.

When enabled, the Cloudflare Worker performs a staged match:

1. **BAAI BGE-M3** creates multilingual embeddings and retrieves plausible product candidates.
2. **Google EmbeddingGemma 2** independently embeds the same email/product set. Agreement between both embedding models is an additional signal.
3. **BAAI BGE-Reranker-base** compares the original email excerpt directly with the shortlist of product descriptions. This is a cross-encoder reranking step, not just another cosine-similarity score.

The final score combines reranker relevance, both embedding similarities, distinctive word overlap and purchase/sale timing. A product is suggested only when evidence and the lead over the next candidate pass conservative thresholds. The numeric match score is a ranking score, not a calibrated probability. If model outputs disagree or are weak, the app deliberately leaves the product unassigned.

The retailer/sender domain is only a secondary retrieval clue. The direct reranker query is the email content itself; a sender brand alone is not sufficient to prove which product was shipped.

Cloudflare documents all three models as hosted by Workers AI with zero data retention. Current published input pricing is approximately:
- BGE-M3: $0.0118 per million input tokens.
- EmbeddingGemma 2: $0.0017 per million input tokens.
- BGE-Reranker-base: $0.00311 per million input tokens.

Actual cost depends on the number of candidate messages and product records sent for a search.

## Learning from confirmed matches

When you manually confirm a product assignment, the app checks whether the subject contains distinctive words that also occur in the chosen product name. If it finds a useful combination, it stores a small local rule containing only:

- The sender domain.
- Incoming/outgoing direction.
- Distinctive overlapping subject words.
- The product ID and confirmation date.

The rule is stored only in this browser's localStorage. It does not store the email body, full sender address, message ID, tracking URL or tracking number. In a future search, it can suggest the same product for a similar subject from the same domain. It requires meaningful subject overlap and does not use a sender domain alone. These local rules are bounded to 100 entries.

## Privacy and manual confirmation

- Without the optional AI setting, message parsing and local matching stay in the browser.
- With AI enabled, only minimized subject/body excerpts, sender domain and basic product metadata (name, category, platform, dates and status) are sent to the same-origin Cloudflare Worker and Workers AI. Email addresses, phone numbers, addresses and URLs are stripped where possible.
- Receipt files, images, product prices and the entire mailbox are not sent to the AI endpoint.
- The short-lived Gmail access token is forwarded to the Worker only to verify the current Gmail session with Google's profile endpoint. It is not persisted, logged or added to backups.
- Embeddings and AI text excerpts are not stored by this app. Cloudflare documents the models as zero-data-retention.
- Gmail remains read-only. A tracking URL is not attached and an existing product tracking field is not overwritten without explicit user action.
- AI suggestions and local learning suggestions still require the user to select/confirm the product by pressing "Übernehmen".

## Limitations

A 100% correct match cannot be guaranteed when the email contains no product name, no unique order reference and only a generic retailer or carrier message. In those cases, the app should abstain rather than guess. A user-approved local sender/subject rule can improve future matches when the subject has distinctive item wording.

This remains an on-demand workflow. It does not scan Gmail while the website is closed. Background scanning requires a separate authenticated backend, a server-side OAuth authorization-code flow, encrypted refresh-token storage, and a protected cloud product database. A Cloudflare Cron Trigger could then schedule sync jobs. A long-lived Gmail refresh token must not be placed in frontend storage.
