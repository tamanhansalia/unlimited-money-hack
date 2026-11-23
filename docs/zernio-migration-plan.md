# Replace Ayrshare with Zernio

Ayrshare no longer has a free plan (Premium starts at $149 a month, and the multi-profile features the app uses need the $299 Launch plan). Zernio connects the first two social accounts free, then charges $6 per account a month, with scheduling and analytics included. This plan replaces Ayrshare everywhere in 2PixelHack.

## What changes in the API

| | Ayrshare (before) | Zernio (after) |
|---|---|---|
| Base URL | `https://api.ayrshare.com/api` | `https://zernio.com/api/v1` |
| Auth | `Authorization: Bearer <key>` plus an optional `Profile-Key` header | `Authorization: Bearer sk_…`, no profile header |
| Verify a connection | `GET /user` → `activeSocialAccounts` | `GET /accounts?status=connected[&profileId=]` → `accounts[]` with `_id`, `platform`, `username`, `displayName` |
| Multiple brands | A Profile Key per Ayrshare User Profile | A Zernio profile (`GET /profiles`) holds one account per network; posts address an account by `accountId` |
| Upload a video | `POST /media/upload` or `GET /media/uploadUrl` | `POST /media/presign` → `PUT` the file to `uploadUrl` → use `publicUrl` |
| Create a post | `POST /post` with `post`, `platforms`, `mediaUrls` | `POST /posts` with `content`, `platforms: [{platform, accountId, platformSpecificData}]`, `mediaItems: [{type:'video', url}]` |
| Post now / later | omit or send `scheduleDate` | `publishNow: true` or `scheduledFor` (UTC ISO) |
| Duplicate protection | `idempotencyKey` field | `Idempotency-Key` header (24 hours) and a 24-hour content-hash `409` |
| YouTube title, tags | `youTubeOptions.title`, `youTubeOptions.tags` | `platformSpecificData.title`, `visibility`, `madeForKids`; top-level `tags` |
| Facebook vertical clip | feed video | `platformSpecificData.contentType: "reel"` for clips of 60 seconds or less |
| Instagram | video | a single video publishes as a Reel automatically |
| Errors | `status: "error"`, `message` | `{ error, type, code, param }`; `207` when a publish-now post failed on its platform |

Platforms stay the same four: YouTube, Instagram, Facebook and X. X posts through Zernio are billed from a prepaid balance (about $0.015 per post); the other three are free. TikTok needs per-creator privacy settings and two consent fields that TikTok requires the person to confirm, so it is a follow-up, not part of this change.

## Steps

| # | Step | Files |
|---|---|---|
| 1 | Rewrite the publishing client for Zernio with key redaction, profile and account discovery, presigned uploads, and one post per platform. Record the destination-based receipt and handle provider retries, duplicates, and terminal failures. | `desktop/src/main/publishing.js` |
| 2 | Keep the local profile registry. A profile stores the encrypted Zernio API key, an optional Zernio profile id and name, and the account id found for each platform. Profiles saved by the Ayrshare version keep their id and name (so Autopilot and the clip sheet still point at them) but are marked as needing a Zernio key; publishing with them asks for one. Remove the old Ayrshare-only import of `publishing-account.json` and `social_credentials.json`. | `desktop/src/main/publishing.js` |
| 3 | IPC: `addProfile(name, key, zernioProfileId)`, `updateProfileKeys(id, key, zernioProfileId)`, new `zernioProfiles(key)` for the profile picker. Allow opening `zernio.com` links; update quit and publish messages. | `desktop/src/main/index.js`, `desktop/src/preload/index.js`, `desktop/src/renderer/core/api.js`, `desktop/src/renderer/core/account.js` |
| 4 | UI: the profile dialog asks for a Zernio API key and offers the Zernio profiles that key can see. Publishing, the clip sheet and Autopilot say Zernio, link to the Zernio dashboard and explain how to fix a profile that still has an Ayrshare key. | `desktop/src/renderer/views/{connect,publishing,sheet,autopilot}.js` |
| 5 | Tests for discovery, redaction, upload, publish now, scheduling, partial-failure retry, duplicate handling and legacy profiles. | `desktop/test/publishing-profiles.test.js`, `desktop/test/autopilot.test.js` |
| 6 | Docs: README credentials section, architecture data table, Autopilot. | `README.md`, `docs/architecture.md`, `docs/autopilot.md` |
| 7 | Verify: unit tests, UI build, and a live check against the Zernio API with your key (account discovery first; a real post only when you say so). | |

## Your one-time setup

1. Sign up at [zernio.com](https://zernio.com) (free, no card).
2. Connect YouTube and Instagram (and Facebook or X if you want them) in the Zernio dashboard. For several YouTube channels, make one Zernio profile per channel.
3. Create an API key at [zernio.com/dashboard/api-keys](https://zernio.com/dashboard/api-keys).
4. In 2PixelHack open **Publishing → Add profile**, paste the key, pick the Zernio profile if you have several, and save.

## Later

- TikTok: read the creator's allowed privacy levels and show the consent checkboxes TikTok requires.
- Self-learning: Zernio's analytics endpoints (`GET /v1/analytics`, YouTube retention) supply the reach data the learning loop needs.

Sources: [Zernio migration guide](https://docs.zernio.com/resources/migrations/migrating-from-ayrshare.mdx), [Create post](https://docs.zernio.com/posts/create-post.mdx), [Presigned upload](https://docs.zernio.com/media/get-media-presigned-url.mdx), [List accounts](https://docs.zernio.com/accounts/list-accounts.mdx), [YouTube](https://docs.zernio.com/platforms/youtube.mdx), [Error handling](https://docs.zernio.com/guides/error-handling.mdx).
