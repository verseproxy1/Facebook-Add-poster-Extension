# Facebook Auto Poster & UI Assistant

A Chrome extension for preparing, automating, and scheduling posts to Facebook groups without manual intervention.

---

## What's New

1. **Multi-Group Auto Queue**: Paste a list of group URLs or IDs. The extension automatically navigates to each group, opens the composer, types the text using Facebook's rich text pipeline, clicks **Post**, and moves to the next group.
2. **Cron Scheduler**: Schedule repeated posting runs automatically (e.g. Every 30 mins, 1 hour, 6 hours, 24 hours) via the Chrome Alarms API in the background service worker.
3. **Background Execution**: The posting queue continues running smoothly in the background even if you close the extension popup.
4. **Anti-Spam Delay**: Customizable pause between groups (e.g. 15-30 seconds) to stay safe and avoid Facebook rate limiting.
5. **Activity Log**: Real-time status display and historical logs of every processed group with timestamps.
6. **Manual Single Group Mode**: Switch tabs anytime to inspect, fill, or manually review single posts on the active tab.

---

## Install & Setup

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this directory (`facebook-extension-agent`).
4. Pin the extension to your toolbar.
5. If already installed, click the **Reload (↻)** icon on the extension card whenever files are updated.

---

## How to Use

### Mode 1: Automated Queue & Cron Scheduling (Recommended)

1. Click the extension icon to open the popup.
2. Under **Post Content**, write the message you want to publish.
3. Under **Target Groups List**, paste your list of group URLs or IDs (one per line):
   ```text
   https://www.facebook.com/groups/123456789
   https://www.facebook.com/groups/my-local-community
   another-group-id
   ```
4. Configure **Delay (sec)** (default: 15s) to define how long to wait between each group.
5. (Optional) Under **Repeat (Cron)**, choose an interval (e.g., *Every 1 Hour*) if you want the posting queue to trigger automatically on a recurring schedule.
6. Click **▶ Start Auto-Posting**.
   - The background service worker takes over, navigates through the groups in order, types and submits each post.
   - You can close the popup and continue browsing; check progress on the extension badge or the live activity log inside the popup.

---

### Mode 2: Manual Single Group Helper

If you prefer to review posts step-by-step on a single tab:
1. Open the Facebook group in your current tab.
2. Switch to the **Manual Helper** tab in the popup.
3. Click **1. Inspect Active Tab**, then **2. Open Composer & Fill**, and **3. Publish Post**.

---

## Tips & Best Practices

- Make sure you are already logged in to Facebook in your browser.
- Ensure your account has joined and has posting permission in the target groups.
- Set a sensible delay (15-30+ seconds) between posts to comply with group guidelines and avoid account rate limits.
