# Kayzo Web App -- Individual Cursor Prompts

Separate project from the backend. This is a Next.js app deployed on Vercel at app.kayzo.app.

Before starting: the backend must be running and the gateway router at api.kayzo.app must be working. These prompts assume Prompt 6 (gateway router) from the backend prompts is complete and tested.

---

## PROMPT 1 -- Project setup

Create a new Next.js 14 project with App Router, Tailwind CSS, and Supabase.

1. Create the project:
   npx create-next-app@latest kayzo-app --typescript --tailwind --app --src-dir --import-alias "@/*"

2. Install dependencies:
   npm install @supabase/supabase-js @supabase/ssr zustand

3. Set up Supabase client:
   - Create src/lib/supabase/client.ts -- browser client using createBrowserClient
   - Create src/lib/supabase/server.ts -- server client using createServerClient for Server Components
   - Create src/middleware.ts -- Supabase Auth session refresh middleware (follow Supabase Next.js docs exactly)

4. Set up environment variables in .env.local:
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   NEXT_PUBLIC_GATEWAY_WS_URL=wss://api.kayzo.app
   NEXT_PUBLIC_GATEWAY_API_URL=https://api.kayzo.app

5. Create src/lib/types.ts with TypeScript interfaces for:
   - Customer: { id, email, name, slug, subscriptionStatus, subscriptionTier, freeAccount, gatewayType: 'cloud' | 'local', gatewayUrl: string | null }
   - Preferences: { ordering: { mode, threshold }, scheduling: { mode }, emailReplies: { mode }, flagging: { mode }, bidMarkup: number }
   - ChatMessage: { id, role: 'user' | 'assistant' | 'system', content, timestamp, type: 'text' | 'approval' | 'bid' | 'thinking' }
   - ApprovalItem: { id, title, details, category: 'ordering' | 'scheduling' | 'email_replies' | 'flagging', amount?: number, status: 'pending' | 'approved' | 'declined' }
   - BidLineItem: { description, quantity, unit, unitPrice, total }
   - Bid: { jobName, date, lineItems: BidLineItem[], subtotal, markupPercent, markupAmount, grandTotal }

6. Set up Zustand store at src/store/index.ts with:
   - messages: ChatMessage[]
   - approvals: ApprovalItem[]
   - preferences: Preferences | null
   - connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'setup_pending'
   - customer: Customer | null
   - Actions: addMessage, updateApproval, setPreferences, setConnectionStatus, setCustomer

7. Run npm run dev and confirm the dev server starts with no errors.

---

## PROMPT 2 -- Auth flow

Build the login screen and auth infrastructure.

1. Create src/app/login/page.tsx -- the login screen:

   Layout: full viewport, centered card, Kayzo logo at top
   Card contains:
   - "Sign in to Kayzo" heading
   - Email input (type email, autocomplete email)
   - Password input (type password, autocomplete current-password)
   - "Sign in" button (full width, loading state while authenticating)
   - "Forgot password?" link below the button
   - Error message area (shows Supabase auth errors in plain language)

   No sign up link. Contractors are invited -- they receive a "set your password" email.

2. Create the sign in server action at src/app/login/actions.ts:
   - Uses Supabase server client
   - Calls supabase.auth.signInWithPassword({ email, password })
   - On success: redirect to /
   - On failure: return error message

3. Create src/app/auth/callback/route.ts -- handles Supabase Auth callback (password reset, invite links):
   - Exchange code for session
   - Redirect to / on success

4. Create src/app/auth/reset-password/page.tsx -- password reset form:
   - Shown after contractor clicks the "set your password" link in their welcome email
   - New password + confirm password inputs
   - Calls supabase.auth.updateUser({ password })
   - Redirects to / on success

5. Update src/middleware.ts to:
   - Refresh the Supabase session on every request
   - If no session and the route is not /login or /auth/*, redirect to /login
   - If session exists and route is /login, redirect to /

6. Create src/app/layout.tsx as the root layout with:
   - Tailwind base styles
   - Viewport meta tag for mobile: width=device-width, initial-scale=1, viewport-fit=cover
   - Body background: neutral gray

7. Add a check after login: fetch the customer record from Supabase. If gateway_type = 'local' and gateway_url is null, redirect to /setup-pending instead of /.

8. Create src/app/setup-pending/page.tsx:
   - Shows a friendly "Your device is being set up" message
   - "Check again" button that re-fetches the customer record
   - If gateway_url is now set, redirect to /
   - If still null, stay on the page

9. Test the full auth flow:
   - Navigate to app -- confirm redirect to /login
   - Sign in with a cloud test user -- confirm redirect to /
   - Sign in with a local test user that has gateway_url = null -- confirm redirect to /setup-pending
   - Update gateway_url in Supabase for that user, tap "Check again" -- confirm redirect to /
   - Sign out -- confirm redirect back to /login

---

## PROMPT 3 -- WebSocket connection layer

Build the gateway connection manager. This is the most critical infrastructure in the app.

Create src/lib/gateway/connection.ts:

The GatewayConnection class manages the WebSocket lifecycle:

constructor(slug: string, jwt: string, onMessage: (event: GatewayEvent) => void, onStatusChange: (status: ConnectionStatus) => void)

connect():
1. Determine the WebSocket URL based on customer.gatewayType:
   - If 'cloud': use ${NEXT_PUBLIC_GATEWAY_WS_URL}/ws/${slug}
   - If 'local' and gatewayUrl is set: use ${customer.gatewayUrl}/ws (the local gateway's WebSocket endpoint)
   - If 'local' and gatewayUrl is null: do not connect, set connectionStatus to 'setup_pending', return early
2. Include JWT as query param: ?token=${jwt} or as a header if the router supports it
3. On open: send the OpenClaw connect frame (read OpenClaw WebSocket protocol docs at https://docs.openclaw.ai/gateway/protocol to get the exact connect frame format)
4. On message: parse JSON, call onMessage with typed event
5. On close: set status to reconnecting, schedule reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
6. On error: log error, trigger reconnect

disconnect(): close the WebSocket cleanly

send(method: string, params: object): id: string
  Generate a UUID as the request id
  Send { type: "req", id, method, params }
  Return the id

GatewayEvent types to handle:
- assistant delta: { type: "event", event: "agent", payload: { stream: "assistant", delta: string } }
- tool event: { type: "event", event: "agent", payload: { stream: "tool", ... } }
- lifecycle end: { type: "event", event: "agent", payload: { stream: "lifecycle", phase: "end" } }
- response: { type: "res", id, ok, payload?, error? }

Create src/lib/gateway/useGateway.ts -- a React hook:

useGateway() returns { send, connectionStatus, pendingRequests }

The hook:
1. Gets the current Supabase session (JWT) and customer slug from the store
2. Creates and maintains a GatewayConnection instance
3. Handles incoming events:
   - Accumulates assistant deltas into a streaming message in the store
   - Finalizes the message on lifecycle end
   - Parses approval payloads and adds to approvals in the store
   - Parses bid payloads and adds as bid message type in the store
4. Updates connectionStatus in the store on every status change
5. Reconnects automatically if the JWT expires and is refreshed

Test by:
1. Logging in as a provisioned test customer
2. Verifying the WebSocket connects in the browser dev tools Network tab
3. Sending a test message and confirming the response streams back

---

## PROMPT 4 -- Chat screen

Build the primary chat interface. This is the main screen of the app.

Create src/app/(dashboard)/page.tsx as the default route -- the chat screen.

Create src/components/chat/ChatScreen.tsx:

Layout (full viewport, no scrolling on the outer container):
- Top bar (fixed height ~56px): Kayzo wordmark left, ConnectionStatus indicator center, contractor name + approval bell right
- Message list (flex-1, overflow-y-auto): fills remaining height
- Input bar (fixed height ~72px, pinned to bottom): text input + send + attachment

ConnectionStatus indicator:
- Green dot + "Connected" when connected
- Amber dot + "Reconnecting..." when reconnecting
- Red dot + "Disconnected" with retry button when failed

Create src/components/chat/MessageList.tsx:
- Renders list of ChatMessage objects from the store
- Auto-scrolls to bottom on new messages
- Shows a scroll-to-bottom button if the user has scrolled up

Create src/components/chat/Message.tsx -- renders a single message based on type:

type: 'text' and role: 'user'
  - Right-aligned bubble, Tailwind: bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2
  - Timestamp below, small gray text

type: 'text' and role: 'assistant'
  - Left-aligned, no bubble background, text renders as markdown
  - Use a lightweight markdown renderer (react-markdown with remark-gfm for tables)
  - Tables rendered for bid line items if present in markdown

type: 'thinking'
  - Left-aligned, three animated dots

type: 'approval'
  - Renders ApprovalCard component (built in Prompt 5)

type: 'bid'
  - Renders BidCard component (built in Prompt 6)

type: 'system'
  - Centered, small gray italic text

Create src/components/chat/ChatInput.tsx:
- Textarea (not input) so it expands with content, max 4 lines
- Send button: disabled when empty or when connectionStatus is not connected
- Attachment button: opens file picker, accepts image/*
- On send: call gateway.send('agent', { message: text }), clear input, add optimistic user message to store
- On file select: convert to base64, send as part of message with image attachment
- Keyboard: Enter sends, Shift+Enter adds new line

On mobile:
- Use dvh (dynamic viewport height) for the full height so the input stays above the keyboard
- The message list shrinks when the keyboard opens

---

## PROMPT 5 -- Approval cards and queue screen

Build the approval system UI.

Create src/components/approvals/ApprovalCard.tsx:

The card renders an approval request inline in chat and in the queue screen.

Layout:
  - Subtle border, rounded corners, white background card
  - Top row: category badge (pill) left, timestamp right
  - Title: bold, what the action is ("Purchase order -- Pacific Coast Lumber")
  - Details section: the full context -- line items if ordering, schedule details if scheduling
  - Amount row if applicable: "Total: $1,240.00" in bold
  - Pending state: Approve button (green) and Decline button (red/outline), full width
  - "Change how I handle these" link below buttons -- opens preferences drawer to that category
  - Approved state: green checkmark + "Approved by you" + timestamp, buttons replaced
  - Declined state: gray x + "Declined" + timestamp, buttons replaced

Category badges:
  - ordering: amber background "Orders"
  - scheduling: blue background "Scheduling"
  - email_replies: purple background "Email"
  - flagging: red background "Urgent"

On approve: call gateway.send('approvals.approve', { approvalId }) and update approval status in store
On decline: call gateway.send('approvals.decline', { approvalId }) and update approval status in store

Create src/app/(dashboard)/approvals/page.tsx -- the approval queue screen:

Header: "Approvals" + count badge showing pending count
Filter tabs: All / Orders / Scheduling / Email / Urgent
Sorted by: oldest first (been waiting longest shown at top)
Each item: ApprovalCard in full-width layout
Empty state: centered message "No pending approvals" with a checkmark icon

Create the approval bell in the top bar:
- Shows count of pending approvals as a badge
- Links to /approvals

---

## PROMPT 6 -- Bid generation UI

Build the bid rendering and editing experience.

Create src/components/bids/BidCard.tsx:

When the agent generates a bid, it arrives as a structured message. Parse the bid JSON from the message content and render:

Header:
  - Job name and date
  - Small "Edit" toggle button top right

Line item table (when not editing):
  - Columns: Description, Qty, Unit, Unit Price, Total
  - Each row: a single material or labor line item
  - Subtotal row at the bottom
  - Markup row: "Markup (20%): $X,XXX"
  - Grand total row in bold

Line item table (when editing):
  - Each cell becomes an inline input on click
  - Quantity, unit price are number inputs
  - Description is a text input
  - Total column auto-calculates as user types
  - Grand total updates in real time
  - "Add line item" button at the bottom of the table
  - Delete icon on each row

Action buttons below the table:
  - "Copy as text" -- copies a plain text version of the bid to clipboard
  - "Download PDF" -- generates a simple PDF (use jspdf or a similar lightweight library)
  - "Send via email" -- opens a compose modal with the bid as the body

Create src/components/bids/ComposeBidEmail.tsx -- modal that opens when "Send via email" is clicked:
  - To: field (email input)
  - Subject: pre-filled as "Bid for {job name}"
  - Body: the bid formatted as clean text
  - Send button -- calls an API route that sends the email via Supabase or a simple email service
  - For MVP, just open the device's mail client with a mailto: link pre-filled

---

## PROMPT 7 -- Preferences screen

Build the preferences screen where contractors control Kayzo's autonomy.

Create src/app/(dashboard)/preferences/page.tsx.

On mount: fetch current preferences from https://api.kayzo.app/api/preferences/{slug} and populate the form.

Layout: single scrollable page with four sections.

ORDERING SECTION:
  Title: "Material orders and purchase orders"
  Description: "When Kayzo wants to place an order or send a PO, how much should it do on its own?"

  Three-option selector (styled as a segmented control or radio cards):
  - "Always ask me first" (always_ask)
  - "Auto-approve small orders" (threshold) -- shows dollar input when selected
  - "Handle everything automatically" (always_act)

  If threshold selected:
  - Dollar input: "Auto-approve orders under: $[___]"
  - Current setting shown: "Orders under $500 go through automatically"

SCHEDULING SECTION:
  Title: "Scheduling commitments"
  Description: "When Kayzo wants to confirm or change a scheduling commitment with a sub"
  Two-option selector: "Always ask me first" / "Handle automatically"

EMAIL REPLIES SECTION:
  Title: "Email replies"
  Description: "When Kayzo wants to reply to a routine supplier or sub email on your behalf"
  Two-option selector: "Always ask me first" / "Handle automatically"

FLAGGING SECTION:
  Title: "Urgent alerts"
  Description: "Kayzo always notifies you immediately about safety issues, missed deliveries, and overdue invoices. This keeps you informed no matter what."
  Static info card, no controls -- reassuring, not a setting

BID MARKUP SECTION:
  Title: "Default bid markup"
  Description: "Percentage added to material and labor costs when generating bids for customers"
  Number input with % suffix
  Range: 0-100

SAVE BEHAVIOR:
  - Save button at the bottom -- or auto-save on change with a "Saved" toast
  - On save: PATCH to https://api.kayzo.app/api/preferences/{slug}
  - Show validation errors inline if mode values are invalid

PREFERENCES DRAWER (from approval cards):
  - When contractor taps "Change how I handle these" on an approval card, open a slide-in drawer
  - The drawer shows only the section relevant to that approval's category
  - Same controls as the full preferences page
  - Changes save immediately

---

## PROMPT 8 -- Onboarding modal

Build the first-login preferences setup flow.

Create src/components/onboarding/OnboardingModal.tsx.

Show this modal on first login if localStorage does not have a 'kayzo_onboarding_complete' key.

The modal is a full-screen overlay with a card in the center. Four screens with a step indicator (1 of 4, 2 of 4, etc.) and a progress bar.

Screen 1 -- Ordering:
  Heading: "When Kayzo wants to place a material order..."
  Sub: "Should it always check with you first, or automatically handle small orders?"
  Two large radio cards:
  - "Always ask me first" -- selected by default
  - "Auto-approve orders under: $[___]" -- shows dollar input when selected
  Next button

Screen 2 -- Scheduling:
  Heading: "Scheduling commitments with your subs"
  Sub: "When Kayzo wants to confirm or change a date with a subcontractor"
  Two radio cards: "Always ask first" / "Kayzo handles it"
  Back button + Next button

Screen 3 -- Email replies:
  Heading: "Routine email replies"
  Sub: "When Kayzo wants to reply to a supplier or sub on your behalf"
  Two radio cards: "Always ask first" / "Kayzo handles it"
  Back button + Next button

Screen 4 -- Summary and confirmation:
  Heading: "Your settings"
  Summary of choices in plain language
  Small note: "You can change these anytime from the Preferences screen"
  "Get started" button

On "Get started":
  - PATCH preferences to api.kayzo.app/api/preferences/{slug} with their choices
  - Set localStorage key 'kayzo_onboarding_complete' = true
  - Close modal, show the chat screen

---

## PROMPT 9 -- Activity log screen

Build the read-only history of everything Kayzo has done.

Create src/app/(dashboard)/activity/page.tsx.

On mount: fetch activity from the gateway via the WebSocket or a REST endpoint. Read OpenClaw's session history API at https://docs.openclaw.ai/concepts/session-tool to understand how to fetch past events.

Layout:
  Header: "Activity"
  Filters: date range picker (last 7 days default) and category filter dropdown
  List: chronological events, newest at top

Each event item:
  - Icon (category-based: order icon, calendar icon, email icon, alert icon)
  - Timestamp: "Today 2:34 PM" or "Yesterday" or full date
  - Description: "Processed supplier email from Pacific Coast Lumber"
  - Category badge (same pills as approval cards)
  - Expandable: tap to see full context of what happened and what Kayzo did

Empty state: "No activity yet. Kayzo will log everything it does here."

---

## PROMPT 10 -- Navigation and layout

Wire all four screens together with navigation.

Create src/app/(dashboard)/layout.tsx -- the authenticated app layout:

Desktop layout (md and above):
  - Left sidebar (240px fixed): Kayzo logo at top, nav links, user info at bottom
  - Main content area: fills remaining space

Mobile layout:
  - No sidebar
  - Bottom nav bar with four icons: Chat, Approvals (with badge), Preferences, Activity
  - Content fills full screen above the nav bar

Nav items:
  - Chat (home icon) -> /
  - Approvals (checkmark icon) -> /approvals -- shows badge with pending count
  - Preferences (sliders icon) -> /preferences
  - Activity (clock icon) -> /activity

User info (shown in sidebar on desktop, accessible via avatar tap on mobile):
  - Contractor name
  - "Sign out" button that calls supabase.auth.signOut() and redirects to /login

Create src/components/layout/ConnectionBanner.tsx:
  - Shows at the top of the content area only when connectionStatus is reconnecting or failed
  - "Reconnecting to Kayzo..." with spinner when reconnecting
  - "Unable to connect" with retry button when failed
  - Do not show for setup_pending -- that state has its own full-page UI

---

## PROMPT 11 -- Mobile polish

The app must feel native on a phone. Contractors use it from job sites.

1. Fix viewport height:
   - Set html and body to height: 100dvh (dynamic viewport height)
   - The chat screen container uses dvh so the input bar stays above the keyboard
   - Test on iOS Safari specifically -- keyboard handling is different from Android

2. Touch targets:
   - Audit every button, link, and interactive element
   - Minimum 44x44px touch target for everything
   - Approve and Decline buttons on approval cards should be especially easy to tap with one thumb

3. Bid table on mobile:
   - The line item table must scroll horizontally if it overflows
   - Wrap the table in a div with overflow-x: auto
   - Pinch to zoom should work on the table

4. Photo upload from camera:
   - The attachment button input should have accept="image/*" and capture="environment" 
   - This opens the camera directly on mobile rather than the photo library
   - Test that photos sent from the camera arrive correctly at the gateway

5. Approval cards on mobile:
   - The approve and decline buttons should be large enough to tap with a thumb while standing
   - Minimum height 52px, full width in mobile layout

6. Pull to refresh:
   - On the approvals screen, pull down to re-fetch pending approvals

7. Offline state:
   - When the device loses network, show a clear banner "No internet connection"
   - Queue outgoing messages and send when reconnected
   - Show a "Message queued" indicator on messages sent while offline

---

## PROMPT 12 -- Deployment and end-to-end test

Deploy to Vercel and run a full end-to-end test.

DEPLOYMENT:
1. Create a new Vercel project connected to the web app GitHub repo
2. Set environment variables in Vercel dashboard:
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   NEXT_PUBLIC_GATEWAY_WS_URL=wss://api.kayzo.app
   NEXT_PUBLIC_GATEWAY_API_URL=https://api.kayzo.app
3. Set custom domain: app.kayzo.app (CNAME to cname.vercel-dns.com)
4. Add app.kayzo.app to Supabase allowed redirect URLs in Auth settings
5. Deploy and confirm the build succeeds

END TO END TEST (requires a provisioned test customer on the backend):

AUTH:
[ ] Navigate to https://app.kayzo.app -- confirm redirect to login
[ ] Sign in with test customer credentials -- confirm redirect to chat
[ ] Refresh the page -- confirm still logged in (session persists)

CONNECTION (CLOUD CUSTOMER):
[ ] Chat screen shows green "Connected" indicator
[ ] Browser dev tools Network tab shows WebSocket connection to wss://api.kayzo.app/ws/testuser
[ ] Disconnect network, confirm "Reconnecting..." banner appears
[ ] Reconnect network, confirm reconnection and banner disappears

CONNECTION (LOCAL CUSTOMER - SETUP PENDING):
[ ] Log in as a local customer with gateway_url = null
[ ] Confirm redirect to /setup-pending page (not the chat screen)
[ ] Confirm "Check again" button is present
[ ] Set gateway_url in Supabase to a test value
[ ] Tap "Check again" -- confirm redirect to the chat screen
[ ] Confirm the WebSocket connects to the gateway_url value, not api.kayzo.app

CHAT:
[ ] Send a text message -- confirm it appears right-aligned immediately (optimistic)
[ ] Confirm Kayzo response streams in character by character
[ ] Send: "I need a bid for a 2400 sq ft house, standard framing and drywall" -- confirm construction-aware response

APPROVALS:
[ ] Trigger an approval by asking Kayzo to place an order above the threshold
[ ] Confirm approval card appears inline in chat with correct category badge
[ ] Confirm approval count badge appears on the nav
[ ] Navigate to /approvals -- confirm item is in the queue
[ ] Approve the item -- confirm status updates in both chat and queue
[ ] Confirm "Change how I handle these" link opens preferences drawer to ordering section

PREFERENCES:
[ ] Navigate to /preferences -- confirm current preferences load correctly
[ ] Change ordering mode to threshold with $300 limit
[ ] Confirm PATCH request fires and "Saved" toast appears
[ ] Wait 60 seconds, confirm backend refreshed preferences (check preferences-context.md on VPS)

BID GENERATION:
[ ] Send: "Generate a bid for replacing the roof on a 1500 sq ft house, standard shingles"
[ ] Confirm bid card renders with line items and total
[ ] Tap a line item -- confirm it becomes editable inline
[ ] Change a quantity -- confirm totals update in real time
[ ] Download PDF -- confirm PDF generates and downloads
[ ] Copy as text -- confirm clipboard receives formatted bid text

ONBOARDING (requires clearing localStorage):
[ ] Open app in incognito / clear localStorage
[ ] Log in -- confirm onboarding modal appears
[ ] Complete all four screens
[ ] Confirm preferences PATCH fires with chosen values
[ ] Confirm modal closes and chat screen shows

MOBILE:
[ ] Open app on a real phone
[ ] Confirm bottom nav bar shows (no sidebar on mobile)
[ ] Open keyboard -- confirm input bar stays visible above keyboard
[ ] Take a photo with the attachment button -- confirm it sends to the gateway

Report each checkbox result. Fix all failures.

---

## Notes on using these prompts

This is a separate project from the backend. Create a new directory and new Git repo for the web app.

The backend must be running with the gateway router working before building the web app past Prompt 2. The WebSocket connection (Prompt 3) is the core dependency -- get it working before building any UI on top of it.

Read the OpenClaw WebSocket protocol docs at https://docs.openclaw.ai/gateway/protocol before Prompt 3. The exact format of the connect frame and event messages is critical to get right.

Prompts 3 through 6 should be built in strict order -- the connection layer must work before the chat screen, and the chat screen must work before the approval cards.
