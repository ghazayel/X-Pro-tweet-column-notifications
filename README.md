# X Pro Tweet Column Notifications

A userscript that adds desktop popup notifications to **X Pro** (formerly TweetDeck) whenever a new tweet appears in a column you choose to track — a feature X Pro currently lacks natively.

## Features

- 🔔 Native desktop notifications (via the browser's Notification API) when a new tweet lands in a tracked column
- ✅ Pick exactly which columns to track from a simple checklist panel — nothing is tracked by default
- 🔊 Uses your OS's default notification sound
- 🔄 Auto-updating via Tampermonkey, once installed from this repo

## Requirements

- A userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari) or a similar alternative like Violentmonkey
- [X Pro](https://pro.x.com) (`pro.x.com`) — this does not work on the regular X/Twitter timeline

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Click this link to install the script: [xpro-new-tweet-notifier.user.js](https://raw.githubusercontent.com/ghazayel/X-Pro-tweet-column-notifications/main/xpro-new-tweet-notifier.user.js)
3. Tampermonkey will show an install prompt — click **Install**.
4. Open [pro.x.com](https://pro.x.com). When your browser asks for notification permission, click **Allow**.

Because the script includes `@updateURL`/`@downloadURL` pointing at this repo, Tampermonkey will automatically check for and apply updates.

## Usage

1. Wait a few seconds after X Pro loads — a small **🔔** button will appear in the bottom-right corner of the page.
2. Click it to open the column picker.
3. Check the boxes next to any columns you want notifications for. Everything starts unchecked.
4. Use **↻ Refresh list** if you've added, removed, or renamed columns since opening the panel.

Your selections are saved in your browser's local storage — nothing is sent anywhere.

## How it works

The script uses a `MutationObserver` to watch the page for newly rendered tweets inside each column, tracks which tweet IDs it has already seen, and fires a `Notification` for any new one in a column you've enabled.

## Troubleshooting

X periodically changes the internal structure of its web app. If notifications stop appearing:

1. Open DevTools (F12) on X Pro and inspect a tweet element.
2. Check whether the `data-testid` attributes referenced in the script (`tweet`, `multi-column`, `column-header`, etc.) still match what you see.
3. Update the `COLUMN_SELECTOR` / `TWEET_SELECTOR` constants near the top of the script accordingly.

Pull requests to fix broken selectors are welcome.

## Disclaimer

This is an unofficial, community-made script. It only reads tweets already rendered in your own logged-in browser session — it does not scrape or call X's API, log in on your behalf, or send your data anywhere. That said, it is not affiliated with or endorsed by X Corp, and you use it at your own discretion.

## License

MIT — see [LICENSE](LICENSE).
