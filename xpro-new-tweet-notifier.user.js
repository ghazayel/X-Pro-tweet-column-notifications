// ==UserScript==
// @name         X Pro Column New-Tweet Notifier
// @namespace    xpro-notifier
// @version      1.4
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
  const STARTUP_DELAY_MS = 3000;   // wait for columns to finish initial load
  const DEBOUNCE_MS      = 500;    // wait for DOM to settle before re-scanning
  const STORAGE_KEY      = 'xproNotifierEnabledColumns';

  const seenTweets = new Map(); // columnId -> Set of tweet ids seen so far

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

  function notify(title, body) {
    if (Notification.permission === 'granted') {
      const n = new Notification(title, { body, silent: false });
      // Optional: clicking the notification focuses the X Pro tab
      n.onclick = () => window.focus();
    }
  }

  function getColumnId(col, idx) {
    if (!col.dataset.notifierId) col.dataset.notifierId = `col-${idx}`;
    return col.dataset.notifierId;
  }

  // First pass: just record what's already there, don't notify
  // (otherwise you'd get a flood of notifications the moment the script loads).
  function baseline() {
    document.querySelectorAll(COLUMN_SELECTOR).forEach((col, idx) => {
      const colId = getColumnId(col, idx);
      const seen = new Set();
      col.querySelectorAll(TWEET_SELECTOR).forEach((t) => {
        const id = getTweetId(t);
        if (id) seen.add(id);
      });
      seenTweets.set(colId, seen);
    });
  }

  function scanForNewTweets() {
    document.querySelectorAll(COLUMN_SELECTOR).forEach((col, idx) => {
      const colId = getColumnId(col, idx);

      if (!seenTweets.has(colId)) {
        // Newly appeared column (e.g. user just added it) - baseline it silently.
        const seen = new Set();
        col.querySelectorAll(TWEET_SELECTOR).forEach((t) => {
          const id = getTweetId(t);
          if (id) seen.add(id);
        });
        seenTweets.set(colId, seen);
        return;
      }

      const seen = seenTweets.get(colId);
      const title = getColumnTitle(col, 'X Pro column');

      col.querySelectorAll(TWEET_SELECTOR).forEach((t) => {
        const id = getTweetId(t);
        if (!id || seen.has(id)) return;
        seen.add(id);

        if (!isColumnEnabled(title)) return; // user unchecked this column

        const authorEl = t.querySelector('[data-testid="User-Name"]');
        const textEl = t.querySelector('[data-testid="tweetText"]');
        const author = authorEl ? authorEl.textContent.trim().split('\n')[0] : 'New tweet';
        const text = textEl ? textEl.textContent.trim().slice(0, 140) : '';

        notify(`${title} — ${author}`, text);
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
      position: 'fixed', bottom: '20px', right: '20px', 'z-index': '2147483647',
      width: '44px', height: '44px', 'border-radius': '50%',
      background: '#1d9bf0', color: '#fff', display: 'flex',
      'align-items': 'center', 'justify-content': 'center', 'font-size': '20px',
      cursor: 'pointer', 'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
    });

    const panel = document.createElement('div');
    panel.id = 'xpro-notifier-panel';
    forceStyle(panel, {
      position: 'fixed', bottom: '72px', right: '20px', 'z-index': '2147483647',
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

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[XPro Notifier] Watching', seenTweets.size, 'column(s) for new tweets.');
  }

  window.addEventListener('load', () => setTimeout(init, STARTUP_DELAY_MS));
})();
