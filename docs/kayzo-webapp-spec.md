# Kayzo Web App -- Cursor Build Spec

## What we are building

A purpose-built React web app at app.kayzo.ai that is the primary interface for contractors using Kayzo. It replaces the built-in OpenClaw WebChat entirely. Contractors log in, chat with Kayzo, manage their approval queue, set preferences, and generate bids -- all from one clean interface designed for someone on a job site.

This is a separate project from the Kayzo backend. It is deployed on Vercel and communicates with the backend via the gateway router at api.kayzo.ai.

---

## Tech stack

- Framework: Next.js 14 (App Router)
- Styling: Tailwind CSS
- Auth: Supabase Auth (email + password)
- Real-time: WebSocket connection to customer's gateway via api.kayzo.ai/ws/{slug}
- State: Zustand for client state
- Deployment: Vercel (free tier handles MVP traffic easily)
- Domain: app.kayzo.ai (CNAME to Vercel)

---

## How it connects to the backend

1. Contractor logs in via Supabase Auth (email + password)
2. Web app fetches their customer record from Supabase including gateway_type and gateway_url
3. Web app determines the WebSocket URL:
   - If gateway_type = 'cloud': connect to wss://api.kayzo.ai/ws/{slug}
   - If gateway_type = 'local' and gateway_url is set: connect to {gateway_url}/ws with Supabase JWT
   - If gateway_type = 'local' and gateway_url is null: show a setup pending screen
4. The gateway router (cloud) or the local gateway directly validates the JWT and handles the connection
5. All chat messages, tool events, and lifecycle events flow through this WebSocket
6. Preferences are read and written via REST to https://api.kayzo.ai/api/preferences/{slug} (cloud) or directly to the local gateway (local)

---

## The four screens

### Screen 1 -- Chat (primary screen, default on load)

This is the main working screen. A full-height chat interface between the contractor and Kayzo.

Layout:
- Top bar: Kayzo logo left, contractor name right, notification bell showing pending approval count
- Message list: fills the screen, scrollable, newest at bottom
- Input bar pinned to bottom: text input + send button + attachment button (for photos)

Message types to render:
- Contractor messages: right-aligned, their text, timestamp
- Kayzo text messages: left-aligned, Kayzo avatar, markdown rendered (bold, lists, tables for bids)
- Kayzo approval requests: left-aligned, rendered as a card (see approval card below)
- Kayzo thinking indicator: animated dots while the gateway is processing
- System messages: centered, gray, small text (e.g. "Gmail connected" or "Preferences updated")

Approval card (rendered inline in chat):
- Title: what the action is (e.g. "Purchase order -- Pacific Coast Lumber")
- Details: line items, total, or commitment details
- Category badge: small pill showing ordering / scheduling / email / flagging
- Two buttons: Approve (green) and Decline (red)
- Small link below: "Change how I handle these" -> opens preferences drawer to that category
- After approval or decline: card updates to show the outcome, buttons disappear

Bid output rendering:
When Kayzo generates a bid, render it as a formatted card with:
- Job name and date
- Line-item table: description, quantity, unit, unit price, total
- Subtotal, markup percentage, grand total
- A "Copy to clipboard" button and a "Download PDF" button
- The contractor can tap edit to adjust line items before sharing

Photo/file support:
- Attachment button opens file picker
- Supports image upload (contractor photos of measurements, whiteboards, blueprints)
- Images display inline in the chat
- Kayzo receives the image and can read measurements or extract information from it

### Screen 2 -- Approval queue

A dedicated screen showing all pending approvals in one place. Accessible from the notification bell badge.

Layout:
- Header: "Approvals ({count})"
- Filter tabs: All / Ordering / Scheduling / Email / Flagging
- List of approval cards (same card component as in chat)
- Empty state: "No pending approvals. Kayzo is on top of it."

Each card shows:
- Same content as the inline approval card in chat
- A timestamp showing how long it has been waiting
- The original message or email that triggered it (collapsed, expandable)

Batch actions:
- Select multiple items and approve or decline all at once
- Useful when the contractor has been offline and has a backlog

### Screen 3 -- Preferences

Where contractors control how agentic Kayzo is. Accessible from the settings icon or from the "Change how I handle these" link on approval cards.

Layout:
- Header: "Preferences"
- Four sections, one per category
- Each section has a title, a short plain-language description, and the controls

Ordering section:
- Title: "Material orders and purchase orders"
- Description: "When Kayzo wants to order materials or send a PO, should it always ask first?"
- Toggle row: Always ask / Auto-approve under $ / Always act
- If "Auto-approve under $" is selected, show a dollar input field
- Current threshold shown: "$500 -- orders under this amount will go through automatically"

Scheduling section:
- Title: "Scheduling commitments"
- Description: "When Kayzo wants to confirm or change a commitment with a sub, should it always ask first?"
- Toggle row: Always ask / Always act

Email replies section:
- Title: "Supplier and sub email replies"
- Description: "When Kayzo wants to reply to a routine email on your behalf, should it always ask first?"
- Toggle row: Always ask / Always act

Flagging section:
- Title: "Urgent alerts"
- Description: "Kayzo will always notify you immediately about safety issues, missed deliveries, and overdue invoices. This cannot be turned off."
- Static text, no controls -- just reassurance

Bid markup section:
- Title: "Default bid markup"
- Description: "What percentage markup do you apply to material and labor costs when generating bids?"
- Number input: shows current percentage, updates on blur

Save behavior:
- Changes save automatically on blur or toggle change
- Show a small "Saved" confirmation toast
- POST to https://api.kayzo.ai/api/preferences/{slug} on every change

### Screen 4 -- Activity log

A read-only history of everything Kayzo has done. Accessible from a history icon in the nav.

Layout:
- Header: "Activity"
- Filter: date range picker and category filter
- Chronological list of events

Each event shows:
- Timestamp
- What Kayzo did: "Processed supplier email from Pacific Coast Lumber", "Generated bid for Henderson job", "Placed order -- 500 studs approved by contractor"
- Category icon
- Expandable detail: the full context of what happened

---

## Auth flow

### Setup pending screen (local customer with no gateway_url)

If a local customer logs in before their Tailscale URL has been configured in Supabase, show this screen instead of the chat:

- Kayzo logo
- Heading: "Your device is being set up"
- Body: "Kayzo is being installed on your dedicated device. You will receive an email when it is ready. This usually takes less than 24 hours."
- A "Check again" button that re-fetches their customer record from Supabase
- If gateway_url has been set since they last checked, redirect to the chat screen

### Login screen (unauthenticated state)

Simple centered card:
- Kayzo logo
- Email input
- Password input
- Sign in button
- "Forgot password?" link (Supabase handles password reset email)
- No sign up link -- contractors are provisioned manually, they receive a welcome email with a link to set their password

### First login

When a contractor is provisioned, the script creates a Supabase Auth user and sends them a "set your password" email via Supabase's invite flow. They click the link, set a password, and land on the web app already authenticated.

### Session persistence

Supabase Auth handles JWT refresh automatically. The WebSocket reconnects automatically if the connection drops. Contractors should never be unexpectedly logged out.

---

## Onboarding flow (first login only)

After first login, before showing the main chat screen, show the preferences onboarding sequence as a modal overlay -- four screens, one per category, with a progress indicator. The same questions Kayzo asks in chat, but in a cleaner structured UI.

Screen 1: "When Kayzo wants to place a material order, should it always ask you first?"
  - Two options: "Always ask" (selected by default) / "Auto-approve small orders"
  - If auto-approve: show dollar input

Screen 2: "Scheduling commitments with your subs?"
  - Two options: "Always ask" / "Kayzo handles it"

Screen 3: "Routine email replies on your behalf?"
  - Two options: "Always ask" / "Kayzo handles it"

Screen 4: Summary screen
  - Shows their choices in plain language
  - "These are your settings. You can change them anytime from Preferences."
  - "Get started" button

On completion, POST preferences to api.kayzo.ai/api/preferences/{slug} and mark onboarding complete in localStorage.

---

## Bid generation UX

When a contractor types a bid request ("I need a bid for a 2,400 sq ft house, 4 bed 3 bath, standard framing and drywall"):

1. Kayzo responds with clarifying questions if needed (material grade, region, timeline)
2. Kayzo generates the bid and sends it as a structured message
3. The web app renders it as a bid card with full line-item table
4. Contractor can:
   - Tap any line item to edit quantity, unit price, or description inline
   - Add or remove line items
   - Adjust the markup percentage
   - The total updates in real time as they edit
5. "Copy" button copies a plain text version to clipboard
6. "Download PDF" generates a simple PDF of the bid
7. "Send to customer" opens a compose window to email the bid directly

---

## Real-time connection management

The WebSocket connection is the core of the app. Handle it carefully:

Connection states:
- Connecting: show a subtle indicator in the top bar
- Connected: normal state, no indicator
- Reconnecting: show "Reconnecting..." banner, disable send button
- Failed: show "Unable to connect" with a retry button

Message handling:
- All messages from the gateway come as JSON events following the OpenClaw WebSocket protocol
- Parse agent stream events (assistant deltas, tool events, lifecycle events)
- Stream assistant text character by character as it arrives for a natural typing feel
- Render approval cards when the agent produces a structured approval payload
- Buffer rapid events and render smoothly

---

## Mobile experience

The web app must feel native on a phone. Contractors will use it from job sites.

Requirements:
- Full viewport height on mobile, no browser chrome overflow
- Input bar stays above the keyboard when keyboard is open (use dvh units)
- Touch targets minimum 44px
- Approval cards easy to tap approve/decline with one thumb
- Bid tables scroll horizontally if too wide for the screen
- Photo upload works from camera roll and directly from camera

---

## Deployment

Vercel deployment:
- Connect GitHub repo to Vercel
- Set environment variables in Vercel dashboard:
  NEXT_PUBLIC_SUPABASE_URL=
  NEXT_PUBLIC_SUPABASE_ANON_KEY=
  NEXT_PUBLIC_GATEWAY_URL=wss://api.kayzo.ai
  NEXT_PUBLIC_API_URL=https://api.kayzo.ai

DNS:
- CNAME: app.kayzo.ai -> cname.vercel-dns.com

---

## Build order

1. Set up Next.js project with Tailwind and Supabase client
2. Build auth -- login screen, Supabase Auth integration, session persistence
3. Build WebSocket connection layer -- connect to gateway, parse events, handle reconnection
4. Build chat screen -- message rendering, streaming text, input bar, attachment support
5. Build approval cards -- inline in chat and standalone queue screen
6. Build preferences screen -- all four categories with auto-save
7. Build onboarding modal -- four screens, preferences POST on completion
8. Build bid rendering -- line-item table, inline editing, totals, copy and PDF
9. Build activity log screen
10. Mobile polish -- viewport, keyboard, touch targets
11. Deploy to Vercel -- connect domain, set env vars, test end to end

---

## What is explicitly out of scope for web app MVP

- Native iOS or Android app
- Local customer setup UI (handled manually via provisioning scripts for now)
- Push notifications (browser notifications are acceptable)
- Multi-user / team views
- Self-serve signup and payment flow
- Dark mode
- Bid history and search
- Customer-facing bid portal (contractor sends bids manually)
