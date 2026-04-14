# Gmail Setup Guide

Connect your Gmail inbox to Kayzo so supplier and subcontractor emails are processed automatically.

**What you'll need:**
- A Google account (the Gmail you want to connect)
- About 15 minutes
- Access to your kayzo.json config file (your Kayzo rep will help)

---

## How it works

When an email arrives in your Gmail inbox, Google sends a notification to Kayzo. Kayzo reads the email, classifies it (supplier quote, invoice, sub update, etc.), and either logs it or creates an approval item for you — depending on your preferences.

You don't need to check email manually. Kayzo handles the inbox and surfaces what needs your attention.

---

## Step 1 — Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. At the top, click the project dropdown → **New Project**
3. Name it something like `Kayzo` → click **Create**
4. Make sure the new project is selected in the dropdown at the top

> **Screenshot description:** The Google Cloud Console header shows a project dropdown. Click it to see "New Project" in the top right of the modal.

---

## Step 2 — Enable the APIs

1. In the left sidebar, go to **APIs & Services** → **Library**
2. Search for `Gmail API` → click it → click **Enable**
3. Go back to the Library, search for `Cloud Pub/Sub API` → click it → click **Enable**

> **Screenshot description:** The API Library search box shows results for "Gmail API". Click the result card, then click the blue Enable button.

---

## Step 3 — Create a Pub/Sub Topic

This is the channel that Gmail uses to send notifications to Kayzo.

1. In the left sidebar, go to **Pub/Sub** → **Topics**
2. Click **Create Topic**
3. Topic ID: `kayzo-{your-slug}-gmail` (replace `{your-slug}` with your customer slug, e.g. `kayzo-acme-gmail`)
4. Leave other settings as default → click **Create**
5. Copy the full **Topic name** — it looks like:
   ```
   projects/your-project-id/topics/kayzo-acme-gmail
   ```
   You'll need this in Step 6.

> **Screenshot description:** The Topics page shows a list of topics. Click "Create Topic" at the top. The Topic ID field is the short name you type.

---

## Step 4 — Create a Push Subscription

This tells Google to push notifications to Kayzo's webhook URL.

1. On the Topics page, click on your new topic
2. Click **Create Subscription**
3. Subscription ID: `kayzo-{your-slug}-gmail-push`
4. Delivery type: **Push**
5. Endpoint URL: your Kayzo rep will give you this — it looks like:
   ```
   https://api.kayzo.ai/api/{your-slug}/webhook/gmail?token={your-hook-token}
   ```
6. Leave all other settings as default → click **Create**

> **Screenshot description:** The Create Subscription form has a "Delivery type" toggle. Select Push and a new field appears for the Endpoint URL.

---

## Step 5 — Grant Gmail Permission to Publish

Gmail needs permission to publish to your Pub/Sub topic.

1. Go back to **Pub/Sub** → **Topics** → click your topic
2. Click **Permissions** (or the **Add Principal** button in the right panel)
3. New principal: `gmail-api-push@system.gserviceaccount.com`
4. Role: **Pub/Sub Publisher**
5. Click **Save**

> **Screenshot description:** The Permissions tab shows a list of principals. Click "Add Principal", type the Gmail service account email, and select the Publisher role from the dropdown.

---

## Step 6 — Add Your Gmail Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `Kayzo Gmail`
5. Under **Authorized redirect URIs**, add the redirect URI your Kayzo rep provides
6. Click **Create** → download the credentials JSON

Send this file to your Kayzo rep. They will add it to your gateway config.

---

## Step 7 — Update Your kayzo.json

Your Kayzo rep will update your `kayzo.json` with:

```json
"hooks": {
  "enabled": true,
  "gmail": {
    "account": "you@yourdomain.com",
    "topic": "projects/your-project-id/topics/kayzo-acme-gmail"
  }
}
```

The two values to fill in:
- **`account`** — the Gmail address you want Kayzo to monitor
- **`topic`** — the full topic name you copied in Step 3

After updating the file, restart your Kayzo gateway.

---

## Step 8 — Authorize Gmail Access

The first time Kayzo starts after enabling Gmail, it will log a URL like:

```
[gmail] Visit this URL to authorize Gmail access:
https://accounts.google.com/o/oauth2/auth?...
```

Open that URL in a browser, sign in with the Gmail account you're connecting, and grant access. You only need to do this once.

---

## What to expect after setup

- **New supplier email arrives** → Kayzo classifies it, extracts items/pricing, creates an approval item if action is needed
- **Sub sends a schedule update** → Kayzo logs it and flags anything that needs your response
- **Invoice arrives** → Kayzo flags it for your review with vendor, amount, and due date
- **Routine confirmation** → Kayzo logs it and moves on

Gmail watch auto-renews every 12 hours. If Kayzo is offline for more than 7 days, you may need to re-authorize.

---

## Troubleshooting

**Emails aren't being processed**
- Check that `hooks.enabled` is `true` in your kayzo.json
- Confirm the `account` and `topic` fields are filled in
- Check gateway logs: `pm2 logs kayzo-{slug}`

**Authorization expired**
- Restart the gateway — it will print a new auth URL if re-authorization is needed

**Wrong emails being processed**
- By default Kayzo watches your full INBOX
- To narrow to a specific label, set `hooks.gmail.label` in your config (e.g. `"Kayzo"`)
