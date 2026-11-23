# Autopilot

Autopilot finds source videos, cuts them into vertical clips, writes the publishing copy, and either keeps the clips for review or schedules them through Zernio. Open **Autopilot**, create a profile, and press **Start**.

## Start a Hindi stand-up campaign

1. Open **Autopilot → New autopilot → Use Hindi stand-up preset**. It starts with a single review run, one 5–25 minute source, and up to two 30–60 second clips with Roman Hinglish captions. It ranks eligible uploads even when a small channel has no usable median.
2. Add your own or licensed creator channels. Leave **YouTube searches** blank to run within those channels. For broader research, try `Hindi stand up comedy` or `Hindi crowd work India` with **Keep for review**, and verify rights before using the results. A channel listed as a source and a channel linked as a publishing destination serve different purposes.
3. Use **Test CLI** to confirm the generation and SEO CLI can answer. Run once and check the joke’s setup and punchline, the captions, and the framing in the Library. The on-screen hook should give the viewer a reason to stay without giving away the punchline.
4. In **Publishing**, connect your destination YouTube channel through Zernio. Edit the Autopilot profile, choose **Schedule posts**, explicitly select the destination, and set **Run → Every day**. Start with one slot at **19:00** if the computer is on India time. Leave 2PixelHack running for new clips to be made. Zernio handles posts it has already accepted.

## What one run does

| Step | What happens | Rules it follows |
|---|---|---|
| 1. Find | Reads the latest 30 uploads of each listed channel and checks up to 24 matching search results across queries. Estimates performance against each channel's median. **Breakout uploads only** requires 1.5× the median. **All eligible uploads, ranked** can also use lower-ranked uploads and uploads from small channels that lack a median. Both modes apply source length, age, availability, and processed-video filters. | `yt-viral` |
| 2. Plan | Picks the top videos for this run (Videos per run) and logs why: "4.61× its channel median". | |
| 3. Cut | Runs the normal generation job for each pick. Highlight selection prefers moments that open on a complete thought, contain a turn (setup and punchline), and end on a strong line. The profile's niche goes into every prompt. | `yt-shorts` |
| 4. Package | The SEO CLI writes the title, a 2–4 word on-screen hook, the search query the clip should win, the description, tags and X post. The engine checks the title length (60 characters), all-caps words, vague words, a filler opening, the hook length and the hook repeating the title, and that most of the query's words appear in the title or first sentence. Any failed check earns one rewrite; the second answer is kept either way. | `yt-package`, `yt-seo` |
| 5. Render | With **Show the hook on screen** on, the hook is burned in at the top for the first 2.5 seconds. | `yt-shorts` |
| 6. Publish | **Keep for review** leaves the clips in the Library. **Schedule posts** gives each clip the next free posting time at least 20 minutes ahead and sends it to Zernio with a `scheduledFor` time, so Zernio posts it even when 2PixelHack is closed. | |

The rules come from the [YouTube agent skills](https://github.com/jakeschincariol/youtube-agent-skill) by Jake Schincariol (MIT). The skills are written for a person in a chat, so the engine rewrites them as prompt rules and deterministic checks (`engine/playbook.py`, `engine/finder.py`). They work with every supported CLI and never stop to ask a question.

## Profile settings

| Setting | Meaning |
|---|---|
| Name, Niche | The niche (for example "Hindi stand-up comedy") is added to every prompt. |
| Channels | One per line: `@handle`, a channel link, `/channel/UC…`, `/c/…` or `/user/…`. Up to 20. |
| YouTube searches | One per line, up to 10. Each search result is ranked against its own channel's median. |
| Videos per run | 1–5. |
| Shortest video, Longest video, Uploaded within, Video selection | The source length and upload age control what gets considered. The selection mode controls how strict the performance filter is. |
| Clips per video, Clip length, Subtitles, Framing, Spoken language | The same options as Generate. |
| Hook | Burns the on-screen hook into the first 2.5 seconds. |
| Generation CLI, SEO CLI | Installed CLIs, as in Settings. |
| New clips | Keep for review, or Schedule posts with a publishing profile, platforms and up to 8 daily posting times. |
| Run | Once, every 6 hours, every 12 hours or every day. |

## Behaviour worth knowing

- **Nothing asks for confirmation.** Start means the profile runs, cuts and (when scheduling) posts on its own.
- **Progress appears during research, download, transcription and highlight selection.** Autopilot uses a faster single-pass decoder with the same multilingual Whisper model and sends shorter sections of the transcript to the AI. Long recordings still require more local CPU time. **Run now** starts an enabled profile before its next scheduled run. **Stop** cancels discovery or the running generation job. An in-flight Zernio submission may complete after Stop.
- **Finished videos are skipped.** The next run can retry a video interrupted during generation and recover clips that reached the Library. If 2PixelHack closed while booking a clip, it resumes using the saved destination and can reuse the saved slot. An unavailable source is skipped. Network and CLI failures leave the video eligible for a later run.
- **Autopilots sharing a Zernio destination share posting times.** Scheduling stays within the next seven days. A disconnected or changed destination is reported before clipping begins. Accepted or unconfirmed submissions keep their booking for that destination, and the activity log directs you to the clip.
- **Autopilot runs while 2PixelHack is open.** Closing the window asks first, then pauses Autopilot. Profiles that were on resume when 2PixelHack opens again, starting with any run that came due while it was closed. Posts already scheduled in Zernio are not affected.
- **Rights.** Only clip videos you are allowed to use: your own channel, creators who gave you permission, or official clipping programmes. Reposting other people's videos can lead to copyright claims, strikes and demonetisation.

## Add performance learning

The current build uses fixed discovery and clipping rules. It can run and schedule by itself, while channel analytics and automatic adjustment still need to be built.

| Stage | How it should work |
|---|---|
| Match each Short to its metrics | Save the source video and timestamps, campaign, cut and caption settings, Zernio receipt, YouTube video ID, and publish time. Confirm the post reached YouTube before measuring. |
| Audit past Shorts | Connect the owned channel for read-only YouTube Analytics and import historical Shorts. Collect views and engagement from Zernio where available. Use YouTube's engaged views, average percentage viewed, and audience retention curves to see whether viewers leave before the setup or punchline. Compare posts at the same age and group similar lengths and topics. |
| Improve the next batch | Test one change at a time, such as opening on the crowd question versus the comic's first line. Collect metrics at 24 hours and seven days, and keep the current settings until several comparable Shorts show a consistent improvement. Save the old settings and each decision so the campaign can revert a change. |
| Revisit an existing Short | Improve a title or description in place if the packaging is weak. If the cut itself needs work, use the authorized original recording to make a distinct edit and queue it as a new experiment. Keep the existing upload and its performance history. |

[Zernio YouTube publishing and analytics](https://docs.zernio.com/platforms/youtube) · [YouTube Analytics channel reports](https://developers.google.com/youtube/analytics/channel_reports) · [YouTube metadata updates](https://developers.google.com/youtube/data/reference/rest/v3/videos/update) · [YouTube monetization guidance](https://support.google.com/youtube/answer/2490020)

For research, generation, or analytics to run when the computer is asleep, move those jobs to an always-on worker. The desktop runner needs the app open and the computer awake. Zernio continues handling confirmed scheduled posts.

## How it fits together

```
renderer views/autopilot.js ── window.studio.autopilot* ──▶ main/automation.js
                                                               │
              ┌──────────────────────┬─────────────────────────┼──────────────────────┐
              ▼                      ▼                         ▼                      ▼
autoclipper.py --find-videos   generation queue          library.listClips()   publishing.publishClip
   (engine/finder.py)          (autoclipper.py job)       (clips by jobId)      (automated, scheduleDate)
```

`main/automation.js` owns the run loop, timers and history. Its dependencies are injected, so `desktop/test/autopilot.test.js` exercises the full loop without Electron, Python or the network. The main process pushes a snapshot to the renderer on the `studio:autopilot` channel whenever the state changes.

| IPC method | Purpose |
|---|---|
| `autopilotList()` | Profiles with their live state and recent activity |
| `autopilotSave(profile)` | Create or update a profile. The main process validates every field. |
| `autopilotStart(id)`, `autopilotStop(id)` | Turn a profile on (runs now) or off (cancels a running job) |
| `autopilotRemove(id)` | Stop and delete a profile and its history |

Profiles, run history, booked posting times and the last 200 activity entries per profile are stored in `<userData>/autopilot.json`.

## Repair and verification plan

1. Pin the selected Zernio accounts. Verify that reordering accounts and reconnecting a profile leave the chosen destination stable, and an unavailable destination stops the run before rendering.
2. Check provider status before releasing a booking or resubmitting a clip. Cover partial acceptance, duplicate recovery, payment delays, shared destinations, and the seven-day cap with simulated Zernio responses.
3. Run `node --test desktop/test/*.test.js`, the engine suite, and the renderer build. Verify that Jobs distinguishes an AI timeout from a YouTube failure and the clipped count reflects actual output.
4. In a separate app profile, apply **Use Hindi stand-up preset**, add a test source or search, and choose **Once** and **Keep for review**. Check discovery, transcription, generation, and playback in the Library, including the captions and publishing copy.
