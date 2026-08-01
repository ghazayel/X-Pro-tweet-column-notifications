// ==UserScript==
// @name         X Pro Column New-Tweet Notifier
// @namespace    xpro-notifier
// @version      1.9
// @description  Desktop popup notification whenever a new tweet appears in an X Pro (TweetDeck) column
// @match        https://pro.x.com/*
// @match        https://tweetdeck.twitter.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ghazayel/X-Pro-tweet-column-notifications/main/xpro-new-tweet-notifier.user.js
// @downloadURL  https://raw.githubusercontent.com/ghazayel/X-Pro-tweet-column-notifications/main/xpro-new-tweet-notifier.user.js
// ==/UserScript==

// ---------------------------------------------------------------------
// CHANGELOG
// 1.0  Initial version. Watches all columns, notifies on every new tweet.
// 1.1  Added floating settings panel (🔔 button) to pick which columns
//      to track, saved in localStorage. Defaulted to "all enabled".
// 1.2  Changed default so all columns start UNCHECKED — user must
//      opt in per column instead of opting out.
// 1.3  Fixed 🔔 button/panel not appearing on some pages: attached to
//      <html> instead of <body>, and forced position/z-index with
//      !important so page CSS (e.g. transforms breaking `fixed`
//      positioning) can't hide or mis-place it. Added a console log
//      of the button's bounding rect for easier debugging.
// 1.4  Actual root-cause fix for the invisible button: the z-index
//      style was set using the camelCase key "zIndex" with
//      style.setProperty(), which silently fails — setProperty()
//      requires kebab-case CSS property names ("z-index"). This left
//      z-index at its default "auto", so X Pro's own tweet content
//      was stacking on top of the button. Fixed by using "z-index".
// 1.5  Moved the 🔔 button/panel from bottom-right to top-right corner
//      for better visibility alongside the columns.
// 1.6  Added an experimental "Prevent tab throttling" toggle in the
//      panel. When enabled, plays a near-silent, very-low-frequency
//      audio tone via the Web Audio API, since browsers generally
//      exempt tabs actively playing audio from background timer
//      throttling. Off by default; requires one click/keypress on the
//      page to unlock audio playback (browser autoplay policy).
// 1.7  Increased startup delay from 3s to 15s before taking the
//      baseline snapshot of existing tweets, to give slower-loading
//      columns time to fully populate first — avoids treating tweets
//      that were still loading in as "new."
// 1.8  Fixed notifications never stopping / repeatedly firing for
//      already-seen tweets: column identity was based on DOM node +
//      index (a dataset attribute stashed on the column element).
//      Virtualized list re-renders can recreate that element, losing
//      the attribute and effectively resetting the "seen" tracking
//      for that column. Column identity is now based on the column's
//      title text instead, which persists across re-renders. Assumes
//      column titles are unique (typical setup).
// 1.9  Clicking a notification now scrolls straight to the original
//      tweet in its column (briefly highlighted) instead of just
//      focusing the tab. Keeps a capped-size map of recent notified
//      tweets' DOM elements; if X Pro's virtualized list has since
//      recycled that element (e.g. scrolled far past it), falls back
//      to just focusing the tab.
// ---------------------------------------------------------------------

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIG - if notifications stop working after an X update, open
  // DevTools (F12), right-click a tweet -> Inspect, and update these two
  // selectors to match whatever attributes X is currently using.
  // ---------------------------------------------------------------------
  const COLUMN_SELECTOR = '[data-testid="multi-column"] > div, section[role="region"]';
  const TWEET_SELECTOR  = 'article[data-testid="tweet"]';
  const STARTUP_DELAY_MS = 15000;  // wait for columns to finish initial load
  const DEBOUNCE_MS      = 500;    // wait for DOM to settle before re-scanning
  const STORAGE_KEY      = 'xproNotifierEnabledColumns';

  const seenTweets = new Map(); // columnId -> Set of tweet ids seen so far

  // Keep references to the DOM elements of tweets we've notified about, so a
  // notification click can scroll straight to the tweet instead of just
  // focusing the tab. Capped in size since X Pro can recycle/remove far
  // scrolled-past elements anyway (virtualized lists).
  const notifiedTweetElements = new Map(); // tweetId -> element
  const MAX_TRACKED_ELEMENTS = 200;

  function rememberTweetElement(id, el) {
    notifiedTweetElements.set(id, el);
    if (notifiedTweetElements.size > MAX_TRACKED_ELEMENTS) {
      const oldestKey = notifiedTweetElements.keys().next().value;
      notifiedTweetElements.delete(oldestKey);
    }
  }

  function goToTweet(id) {
    window.focus();
    const el = notifiedTweetElements.get(id);
    if (el && document.contains(el)) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const originalOutline = el.style.outline;
      el.style.outline = '2px solid #1d9bf0';
      setTimeout(() => { el.style.outline = originalOutline; }, 2000);
    } else {
      console.log('[XPro Notifier] Original tweet element no longer in the DOM (likely scrolled out / recycled).');
    }
  }

  // ---------------------------------------------------------------------
  // Which-columns-to-track persistence (keyed by column title, since that's
  // stable across reloads, unlike DOM index).
  // ---------------------------------------------------------------------
  function loadEnabledSet() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? new Set(JSON.parse(raw)) : null; // null = "not configured yet"
    } catch (e) {
      return null;
    }
  }

  function saveEnabledSet(set) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  }

  let enabledTitles = loadEnabledSet(); // Set of titles, or null if user hasn't set up yet

  // ---------------------------------------------------------------------
  // Experimental: silent audio "keep-alive" to discourage the browser from
  // throttling this tab when it's in the background. Browsers generally
  // exempt tabs actively playing audio from background timer throttling.
  // Off by default; toggled from the settings panel.
  // ---------------------------------------------------------------------
  const KEEPALIVE_KEY = 'xproNotifierKeepAlive';
  let keepAliveEnabled = localStorage.getItem(KEEPALIVE_KEY) === 'true';
  let audioCtx = null;
  let audioNodes = null;

  function startKeepAlive() {
    if (audioCtx) return; // already running
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.0001; // effectively silent, but "playing"
      oscillator.frequency.value = 20; // low, inaudible-ish frequency
      oscillator.connect(gain);
      gain.connect(audioCtx.destination);
      oscillator.start();
      audioNodes = { oscillator, gain };
      console.log('[XPro Notifier] Keep-alive audio started.');
    } catch (e) {
      console.warn('[XPro Notifier] Could not start keep-alive audio:', e);
    }
  }

  function stopKeepAlive() {
    if (audioNodes) {
      try { audioNodes.oscillator.stop(); } catch (e) {}
      audioNodes = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    console.log('[XPro Notifier] Keep-alive audio stopped.');
  }

  function setKeepAlive(enabled) {
    keepAliveEnabled = enabled;
    localStorage.setItem(KEEPALIVE_KEY, String(enabled));
    if (enabled) startKeepAlive();
    else stopKeepAlive();
  }

  // AudioContext requires a user gesture before it can produce sound in
  // most browsers. Arm a one-time listener so the very first click/keypress
  // anywhere on the page unlocks it, if the feature is enabled.
  function armAudioUnlock() {
    const unlock = () => {
      if (keepAliveEnabled) startKeepAlive();
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
  }

  function isColumnEnabled(title) {
    // Nothing is tracked until the user explicitly checks it in the panel.
    if (enabledTitles === null) return false;
    return enabledTitles.has(title);
  }

  function getTweetId(article) {
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const m = link.href.match(/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function getColumnTitle(col, fallback) {
    const header = col.querySelector('[data-testid="column-header"], h2, [role="heading"]');
    return header ? header.textContent.trim() : fallback;
  }

  function notify(title, body, tweetId) {
    if (Notification.permission === 'granted') {
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => {
        if (tweetId) goToTweet(tweetId);
        else window.focus();
      };
    }
  }

  function getColumnKey(col, fallbackIdx) {
    // Column title is a far more stable identity than DOM position/node
    // identity, since virtualized lists can recreate column wrapper nodes
    // (and therefore lose any dataset attribute we'd stashed on them),
    // which was causing already-seen tweets to be re-tracked as new.
    // NOTE: assumes column titles are unique, which holds for typical
    // X Pro / TweetDeck setups (each column usually has a distinct name).
    return getColumnTitle(col, `Column ${fallbackIdx + 1}`);
  }

  // First pass: just record what's already there, don't notify
  // (otherwise you'd get a flood of notifications the moment the script loads).
  function baseline() {
    document.querySelectorAll(COLUMN_SELECTOR).forEach((col, idx) => {
      const colId = getColumnKey(col, idx);
      const seen = seenTweets.get(colId) || new Set();
      col.querySelectorAll(TWEET_SELECTOR).forEach((t) => {
        const id = getTweetId(t);
        if (id) seen.add(id);
      });
      seenTweets.set(colId, seen);
    });
  }

  function scanForNewTweets() {
    document.querySelectorAll(COLUMN_SELECTOR).forEach((col, idx) => {
      const colId = getColumnKey(col, idx);

      if (!seenTweets.has(colId)) {
        // Genuinely new column (e.g. user just added it) - baseline it silently.
        const seen = new Set();
        col.querySelectorAll(TWEET_SELECTOR).forEach((t) => {
          const id = getTweetId(t);
          if (id) seen.add(id);
        });
        seenTweets.set(colId, seen);
        return;
      }

      const seen = seenTweets.get(colId);
      const title = colId; // colId IS the title now

      col.querySelectorAll(TWEET_SELECTOR).forEach((t) => {
        const id = getTweetId(t);
        if (!id || seen.has(id)) return;
        seen.add(id);

        if (!isColumnEnabled(title)) return; // user unchecked this column

        const authorEl = t.querySelector('[data-testid="User-Name"]');
        const textEl = t.querySelector('[data-testid="tweetText"]');
        const author = authorEl ? authorEl.textContent.trim().split('\n')[0] : 'New tweet';
        const text = textEl ? textEl.textContent.trim().slice(0, 140) : '';

        rememberTweetElement(id, t);
        notify(`${title} — ${author}`, text, id);
      });
    });
  }

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanForNewTweets, DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------
  // Settings panel: a floating 🔔 button that opens a checklist of the
  // columns currently on screen, so the user can pick which ones matter.
  // ---------------------------------------------------------------------
  function currentColumnTitles() {
    const titles = [];
    document.querySelectorAll(COLUMN_SELECTOR).forEach((col, idx) => {
      titles.push(getColumnTitle(col, `Column ${idx + 1}`));
    });
    // de-dupe while preserving order
    return [...new Set(titles)];
  }

  function forceStyle(el, styles) {
    Object.entries(styles).forEach(([prop, value]) => {
      el.style.setProperty(prop, value, 'important');
    });
  }

  function buildPanel() {
    const btn = document.createElement('div');
    btn.id = 'xpro-notifier-btn';
    btn.textContent = '🔔';
    forceStyle(btn, {
      position: 'fixed', top: '20px', right: '20px', 'z-index': '2147483647',
      width: '44px', height: '44px', 'border-radius': '50%',
      background: '#1d9bf0', color: '#fff', display: 'flex',
      'align-items': 'center', 'justify-content': 'center', 'font-size': '20px',
      cursor: 'pointer', 'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
    });

    const panel = document.createElement('div');
    panel.id = 'xpro-notifier-panel';
    forceStyle(panel, {
      position: 'fixed', top: '72px', right: '20px', 'z-index': '2147483647',
      width: '280px', 'max-height': '400px', 'overflow-y': 'auto',
      background: '#15202b', color: '#fff', border: '1px solid #38444d',
      'border-radius': '8px', padding: '12px', 'font-family': 'sans-serif',
      'font-size': '14px', display: 'none', 'box-shadow': '0 4px 16px rgba(0,0,0,0.4)',
    });

    function renderPanel() {
      const titles = currentColumnTitles();
      // First time ever running: start with nothing selected.
      if (enabledTitles === null) {
        enabledTitles = new Set();
        saveEnabledSet(enabledTitles);
      }

      panel.innerHTML = `
        <div style="font-weight:bold; margin-bottom:8px;">Track which columns?</div>
        <div id="xpro-notifier-list"></div>
        <hr style="border-color:#38444d; margin:10px 0;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="xpro-keepalive-toggle">
          <span>Prevent tab throttling (experimental, plays silent audio)</span>
        </label>
        <div style="display:flex; gap:8px; margin-top:10px;">
          <button id="xpro-refresh" style="flex:1; padding:6px; cursor:pointer;">↻ Refresh list</button>
          <button id="xpro-close" style="flex:1; padding:6px; cursor:pointer;">Close</button>
        </div>
      `;

      const list = panel.querySelector('#xpro-notifier-list');
      if (titles.length === 0) {
        list.innerHTML = '<div style="opacity:0.7;">No columns detected yet. Try Refresh.</div>';
      } else {
        titles.forEach((title) => {
          const row = document.createElement('label');
          Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', cursor: 'pointer' });
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = enabledTitles.has(title);
          cb.addEventListener('change', () => {
            if (cb.checked) enabledTitles.add(title);
            else enabledTitles.delete(title);
            saveEnabledSet(enabledTitles);
          });
          const span = document.createElement('span');
          span.textContent = title;
          row.appendChild(cb);
          row.appendChild(span);
          list.appendChild(row);
        });
      }

      const keepAliveBox = panel.querySelector('#xpro-keepalive-toggle');
      keepAliveBox.checked = keepAliveEnabled;
      keepAliveBox.addEventListener('change', () => setKeepAlive(keepAliveBox.checked));

      panel.querySelector('#xpro-refresh').addEventListener('click', renderPanel);
      panel.querySelector('#xpro-close').addEventListener('click', () => {
        panel.style.setProperty('display', 'none', 'important');
      });
    }

    btn.addEventListener('click', () => {
      const isOpen = panel.style.display === 'block';
      panel.style.setProperty('display', isOpen ? 'none' : 'block', 'important');
      if (!isOpen) renderPanel();
    });

    document.documentElement.appendChild(btn);
    document.documentElement.appendChild(panel);

    console.log('[XPro Notifier] Button rect:', btn.getBoundingClientRect());
  }

  function init() {
    if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }

    baseline();
    buildPanel();
    armAudioUnlock();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[XPro Notifier] Watching', seenTweets.size, 'column(s) for new tweets.');
  }

  window.addEventListener('load', () => setTimeout(init, STARTUP_DELAY_MS));
})();
