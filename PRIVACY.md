# Privacy Policy — On-Call Toolkit for TaskCall

_Last updated: 2026-06-29_

**On-Call Toolkit for TaskCall does not collect, store, transmit, or sell any personal or usage data.**

## What the extension does
The extension runs entirely inside your own logged-in TaskCall browser tab. When you view, override, or edit an on-call schedule, it reads and writes that data **directly to your own TaskCall account, through your existing TaskCall session** — exactly as the TaskCall web app itself does. Nothing passes through any server operated by the extension or its author.

## Data collection
- **None.** The extension has no analytics, no telemetry, no tracking, and no remote logging.
- It requests **no browser permissions** beyond running a content script on `*.taskcallapp.com`. It does **not** use storage, cookies, history, identity, your other tabs, or any external network destination.
- It loads **no remote code**. All logic ships inside the extension package and runs locally.

## Data handling
- The only data the extension touches is **your TaskCall on-call configuration** (schedules, rotations, overrides), which it reads from and writes back to **your TaskCall account** using **your** authenticated session. That data never leaves TaskCall's own domain.
- The extension keeps **no copy** of anything after the tab is closed — except a routine-export JSON file that **you** choose to download to your own disk (a local backup you initiate; it is never transmitted anywhere).

## Third parties
- The extension shares data with **no third parties**. It communicates only with the TaskCall application you are already logged into.

## Contact
Questions about this policy can be directed to the maintainer listed in the project README.
