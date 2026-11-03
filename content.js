// Content Script for Facebook UI Assistant (manual helper + "Add Group" button)
// v1.3 - text is inserted exactly once; no stacked fallback strategies.
// (Auto queue posting lives in background.js.)

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function visible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
}

function bodyText() {
  return (document.body?.innerText || "").slice(0, 12000);
}

// Look for the post's opening text in the feed, waiting a few seconds for Facebook to render it
async function waitForPostInFeed(text) {
  const sample = norm(text).slice(0, 40);
  if (!sample) return false;
  for (let i = 0; i < 16; i++) {
    const found = [...document.querySelectorAll('[role="article"]')].some((a) => norm(a.innerText).includes(sample));
    if (found) return true;
    await wait(300);
  }
  return false;
}

// Facebook toasts that mean the post was throttled or blocked
function facebookError() {
  const text = (document.body?.innerText || "").slice(0, 15000);
  if (/retried too early|you're posting too frequently|posting too fast|slow down/i.test(text)) {
    return "Rate limit: 'Retried too early' — Facebook needs more time between posts. Increase delay to 120s+.";
  }
  if (/something went wrong|restore post/i.test(text)) {
    return "Facebook error: 'Something went wrong' — anti-spam triggered. Increase delay to 90s+ and try again.";
  }
  if (/temporarily blocked|action is blocked|try again later|you can't use this feature/i.test(text)) {
    return "Account temporarily blocked by Facebook anti-spam. Wait 15-30 minutes before retrying.";
  }
  return null;
}

function groupTitle() {
  const pick = (sel) => [...document.querySelectorAll(sel)]
    .filter(visible)
    .map((x) => (x.innerText || "").trim())
    .find(Boolean);
  const raw = pick("h1") || pick("[role='main'] [role='heading']") || document.title;
  return (raw || "").replace(/\s*\|\s*Facebook$/i, "").replace(/^\(\d+\)\s*/, "").trim();
}

function norm(str) {
  return (str || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Last pointer position we dispatched, so each move starts where the previous one ended
let pointer = { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) };

// Move the pointer along a curved, slightly jittery path instead of teleporting onto the target
async function moveMouseTo(x, y) {
  const sx = pointer.x;
  const sy = pointer.y;
  // control point off the straight line so the path bends the way a hand does
  const cx = (sx + x) / 2 + (Math.random() - 0.5) * 240;
  const cy = (sy + y) / 2 + (Math.random() - 0.5) * 240;
  const steps = rand(12, 24);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t); // slow start and stop
    const px = (1 - ease) ** 2 * sx + 2 * (1 - ease) * ease * cx + ease ** 2 * x;
    const py = (1 - ease) ** 2 * sy + 2 * (1 - ease) * ease * cy + ease ** 2 * y;
    const clientX = Math.min(window.innerWidth - 1, Math.max(0, px + (Math.random() - 0.5) * 3));
    const clientY = Math.min(window.innerHeight - 1, Math.max(0, py + (Math.random() - 0.5) * 3));
    const under = document.elementFromPoint(clientX, clientY) || document.body;
    under.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window, clientX, clientY }));
    await wait(rand(8, 28));
  }
  pointer = { x, y };
}

// Idle moment: wander the cursor to random spots on screen for a random short time
async function idleWander(maxMs = 1200) {
  const end = Date.now() + rand(300, maxMs);
  while (Date.now() < end) {
    await moveMouseTo(rand(40, window.innerWidth - 40), rand(40, window.innerHeight - 40));
    await wait(rand(150, 500));
  }
}

async function simulatePress(el) {
  if (!el) return;
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width * (0.25 + Math.random() * 0.5);
  const y = rect.top + rect.height * (0.25 + Math.random() * 0.5);
  await moveMouseTo(x, y);
  await wait(rand(60, 220)); // brief hover before the click, like a person
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

  el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, isPrimary: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...opts, button: 0, buttons: 1 }));
  el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", { ...opts, isPrimary: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...opts, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...opts, button: 0 }));
  // no extra el.click(): it double-activated buttons
}

function composerDialog() {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
  return dialogs.find((d) => {
    if (d.closest('[data-pagelet="ChatTab"]') || d.matches('[data-pagelet="ChatTab"]')) return false;
    const txt = (d.innerText || "").toLowerCase();
    return Boolean(d.querySelector('[contenteditable="true"]')) || txt.includes("share now") || txt.includes("say something");
  }) || null;
}

function findComposer() {
  const pagelet = document.querySelector('[data-pagelet*="InlineComposer"], [data-pagelet*="Composer"]');
  if (pagelet) {
    const btn = pagelet.querySelector('[role="button"], div[tabindex="0"]') || pagelet;
    if (visible(btn)) return btn;
  }

  const sels = [
    '[aria-label="Create a post"]',
    '[aria-label="Create a public post"]',
    '[aria-label="Write something..."]',
    '[aria-label*="Write something" i]',
    '[aria-label*="What\'s on your mind" i]'
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && visible(el) && !el.closest('[role="article"]')) return el;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const val = node.nodeValue?.trim() || "";
    if (/^(Write something|What['’]s on your mind|Create a public post|Create a post)/i.test(val)) {
      const parent = node.parentElement;
      if (parent && visible(parent) && !parent.closest('[role="article"]')) {
        return parent.closest('[role="button"]') || parent.closest('div[tabindex="0"]') || parent;
      }
    }
  }
  return null;
}

function findPostEditor() {
  const dialog = composerDialog();
  if (!dialog) return null;
  const editors = [...dialog.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea')].filter(visible);
  return editors.find((el) => {
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    return !label.includes("comment") && !label.includes("search");
  }) || editors[0] || null;
}

function findPostButton() {
  const dialog = composerDialog();
  if (!dialog) return null;
  const buttons = [...dialog.querySelectorAll('button, [role="button"], div[role="button"]')].filter(visible);
  return buttons.find((b) => {
    const txt = (b.innerText || b.getAttribute("aria-label") || "").trim();
    return /^(Post|Publish|Publicar|Publier|Share now)$/i.test(txt) &&
      b.getAttribute("aria-disabled") !== "true" && !b.disabled;
  }) || null;
}

// ---- Insert text ONCE, word by word, then WAIT for Lexical to catch up ----
async function setEditorText(el, text) {
  await simulatePress(el);
  await wait(rand(200, 400));
  el.focus();

  // caret must be inside the editor or execCommand inserts nothing
  const placeCaret = () => {
    el.focus();
    const target = el.querySelector("p") || el;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  placeCaret();

  const read = () => norm(el.innerText || el.value || el.textContent || "");
  const sample = norm(text).slice(0, 25);
  const count = () => {
    if (!sample) return 0;
    const hay = read();
    let c = 0, i = 0;
    while ((i = hay.indexOf(sample, i)) !== -1) { c++; i += sample.length; }
    return c;
  };
  const clear = () => {
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
  };
  const settle = async (ms) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (count() >= 1) return true;
      await wait(150);
    }
    return count() >= 1;
  };
  const typeAll = async () => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let li = 0; li < lines.length; li++) {
      if (li > 0) { document.execCommand("insertParagraph", false, null); await wait(rand(120, 350)); }
      for (const chunk of lines[li].split(/(\s+)/).filter((c) => c !== "")) {
        document.execCommand("insertText", false, chunk);
        await wait(rand(35, 150));
        if (Math.random() < 0.06) await wait(rand(350, 1100));
      }
    }
  };

  if (read()) { clear(); await wait(300); }

  // Paste carries line breaks into the editor as written. Typing word by word
  // turned the paragraphs into one run-on block, so typing is only the fallback.
  const pasteText = () => {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
    } catch (_) {}
  };
  // innerText shows a newline between paragraphs, so a missing one means the breaks were lost
  const lineBreaksKept = () => !text.includes("\n") || (el.innerText || "").includes("\n");
  const insertOnce = async () => {
    await wait(rand(400, 900));
    pasteText();
    if ((await settle(3000)) && lineBreaksKept()) return true;
    clear();
    await wait(300);
    await typeAll();
    return await settle(3000);
  };

  let ok = await insertOnce();
  if (ok && !lineBreaksKept()) {
    throw new Error("Text was inserted but line breaks were lost (the editor shows one paragraph).");
  }
  if (!ok) {
    // Diagnostics so the activity log shows why the editor ignored the text
    throw new Error(
      `Editor did not accept the text. hasFocus=${document.hasFocus()}, ` +
      `activeIsEditor=${document.activeElement === el}, ` +
      `label="${el.getAttribute("aria-label") || ""}", editorLength=${read().length}`
    );
  }

  if (count() > 1) {
    clear();
    await wait(400);
    await insertOnce();
    await settle(3000);
    if (count() > 1) { clear(); throw new Error("Text was duplicated in editor; cleared."); }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!location.hostname.includes("facebook.com")) throw new Error("This is not a Facebook page.");

    if (msg.action === "PING") return { pong: true };

    if (msg.action === "INSPECT") {
      const title = groupTitle();
      const isGroup = /facebook\.com\/groups\//i.test(location.href);
      return {
        message: `Page: ${title}\nURL: ${location.href}\nLooks like group page: ${isGroup}\nComposer visible: ${!!findComposer()}`,
        title, url: location.href, isGroup
      };
    }

    if (msg.action === "FILL") {
      const text = String(msg.postText || "").trim();
      if (!text) throw new Error("Post text is empty.");

      window.scrollTo(0, 0);
      await wait(rand(500, 900));
      await idleWander(1500);

      let dialog = composerDialog();
      if (!dialog) {
        let composer = findComposer();
        if (!composer) {
          window.scrollBy(0, 400);
          await wait(rand(600, 900));
          composer = findComposer();
        }
        if (composer) {
          await simulatePress(composer);
          for (let i = 0; i < 25 && !dialog; i++) {
            await wait(300);
            dialog = composerDialog();
          }
        }
      }
      if (!dialog) throw new Error("Could not open the post composer dialog (composer not found — are you a member of this group?).");

      let editor = findPostEditor();
      for (let i = 0; i < 15 && !editor; i++) {
        await wait(300);
        editor = findPostEditor();
      }
      if (!editor) throw new Error("Post editor not found inside dialog.");

      await setEditorText(editor, text);
      await wait(rand(500, 900));

      return { success: true, groupTitle: groupTitle(), message: "Composer opened and text filled. Review, then click Publish." };
    }

    if (msg.action === "PUBLISH") {
      if (!composerDialog()) throw new Error("No open composer dialog found. Use step 2 (Fill) first.");

      let button = findPostButton();
      for (let i = 0; i < 20 && !button; i++) {
        await wait(300);
        button = findPostButton();
      }
      if (!button) throw new Error("Post button not found or still disabled.");

      await idleWander(800);
      await simulatePress(button);
      await wait(rand(1500, 2500));

      // A click is not proof of a post: Facebook closes the composer once it accepts the post
      let closed = false;
      for (let i = 0; i < 40 && !closed; i++) {
        await wait(250);
        closed = !composerDialog();
      }

      const fbError = facebookError();
      if (fbError) return { success: false, error: fbError };

      // Not a retryable message on purpose (see isRetryable in background.js): the post may already be live
      if (!closed) {
        return { success: false, error: "Clicked Post but the composer did not close, so the post is not confirmed. Check the group before retrying." };
      }

      const isPending = /pending approval|awaiting approval|submitted for approval/i.test(bodyText());
      const visibleInFeed = await waitForPostInFeed(msg.postText);
      return {
        success: true,
        groupTitle: groupTitle(),
        pendingApproval: isPending,
        visibleInFeed,
        message: isPending
          ? "Submitted for group admin approval."
          : visibleInFeed
            ? "Published and visible in the group feed."
            : "Composer closed, but the post is not visible in the feed yet. Verify in the group."
      };
    }

    throw new Error("Unknown action: " + msg.action);
  })().then(sendResponse).catch((e) => sendResponse({ error: e.message, message: "Error: " + e.message }));
  return true;
});

// ============================================================
// Floating "+ Add Group" button (runs on every group page)
// ============================================================
(function injectAddGroupButton() {
  if (window.__fbApAddGroupInit) return; // content.js can be injected twice (manifest + popup fallback)
  window.__fbApAddGroupInit = true;

  const isGroupPath = () => /\/groups\/[^/?#]+/i.test(location.pathname);

  function extractGroupInfo() {
    const match = location.pathname.match(/\/groups\/([^/?#]+)/i);
    const id = match ? match[1] : null;
    if (!id) return null;

    let name = "";
    const h1 = document.querySelector("h1");
    if (h1 && h1.innerText) {
      name = h1.innerText.trim().replace(/\s*\|\s*Facebook$/i, "").replace(/^\(\d+\)\s*/, "").trim();
    }
    if (!name || name.length < 2) name = id;
    return { id, name, url: `https://www.facebook.com/groups/${id}` };
  }

  const DEFAULT_BG = "linear-gradient(135deg, rgba(108,155,255,0.92), rgba(124,92,255,0.92))";

  const btn = document.createElement("button");
  btn.id = "fb-ap-add-group-btn";
  btn.textContent = "+ Add Group";
  btn.title = "Add this group to Auto Poster library";
  Object.assign(btn.style, {
    position: "fixed", bottom: "28px", right: "28px", zIndex: "2147483647",
    padding: "12px 18px", borderRadius: "14px", border: "1px solid rgba(255,255,255,0.25)",
    background: DEFAULT_BG, color: "#fff",
    fontFamily: "system-ui, -apple-system, sans-serif", fontSize: "13px", fontWeight: "650",
    cursor: "pointer", boxShadow: "0 8px 28px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2)",
    backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
    transition: "transform 0.2s ease, box-shadow 0.2s ease", letterSpacing: "0.01em"
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "translateY(-3px) scale(1.03)";
    btn.style.boxShadow = "0 12px 32px rgba(108,155,255,0.45)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "";
    btn.style.boxShadow = "0 8px 28px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2)";
  });

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const info = extractGroupInfo(); // re-read on every click (SPA navigation safe)
    if (!info) {
      btn.textContent = "✗ Not a group";
      setTimeout(() => { btn.textContent = "+ Add Group"; }, 1800);
      return;
    }

    btn.textContent = "Saving…";
    try {
      const res = await chrome.runtime.sendMessage({ action: "ADD_GROUP", group: info });
      if (res?.ok) {
        btn.textContent = res.already ? "✓ Already added" : "✓ Added!";
        btn.style.background = "linear-gradient(135deg, #34d399, #10b981)";
      } else {
        btn.textContent = "✗ Failed";
      }
    } catch (_) {
      btn.textContent = "✗ Error";
    }
    setTimeout(() => {
      btn.textContent = "+ Add Group";
      btn.style.background = DEFAULT_BG;
    }, 2200);
  });

  // Facebook is an SPA: show/hide the button as the URL changes
  function sync() {
    const mounted = document.getElementById("fb-ap-add-group-btn");
    if (isGroupPath()) {
      if (!mounted && document.body) document.body.appendChild(btn);
    } else if (mounted) {
      mounted.remove();
    }
  }
  sync();
  setInterval(sync, 1200);
})();