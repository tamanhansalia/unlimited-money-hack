# Generation Setup Plan

Make `#/generate` the setup page for every new run. Pasting a valid link on the Library opens this page with the source filled in. Choose the clip timing, framing and subtitles here. **Generate clips** is the point at which the app queues a run.

## Current behavior

| Area | What the app does today |
| --- | --- |
| Entry points | The Library launches its own options dialog and then starts the job. The sidebar’s New clips action and a source’s Generate more action also lead to the Library. The dedicated Generate page already accepts links and files, selects a clip count and length, and shows the job queue. [Library](../desktop/src/renderer/views/library.js#L460), [Generate](../desktop/src/renderer/views/generate.js#L207), [New clips shortcut](../desktop/src/renderer/main.js#L60), [Generate more](../desktop/src/renderer/views/source.js#L401) |
| Timing | The `10–13 sec` preset means clip duration. The `30 sec` preset accepts 25–35 seconds. The model proposes transcript spans and Python checks their length, then the renderer adds up to 0.55 seconds of padding. A local FFmpeg test accepted a 13.00-second span and produced a 13.56-second MP4. [Presets](../desktop/src/renderer/core/generation-settings.js#L5), [Span validation](../engine/clip_ai.py#L270), [Rendering](../engine/autoclipper.py#L166) |
| Framing and subtitles | Every clip uses a center crop to 720×1280 and the same yellow subtitle style. The engine receives transcript segments with timestamps. A face or screen region needs its own analysis or a user-specified crop. [Transcription](../engine/autoclipper.py#L135), [Subtitle styles](../engine/autoclipper.py#L21), [Rendering](../engine/autoclipper.py#L166) |

## Setup page flow

1. **Source.** A valid paste or file selection on the Library opens Generate. A typed URL opens it on Enter or **Continue**. Invalid paste stays at the Library field with its validation message. Sidebar New clips, its keyboard shortcut and Generate more use the same route. Generate also works directly with its own source field and a **Change video** action. Generate more preloads the existing YouTube video or opens the file picker for a prior local source when the app needs access again.
2. **Source details.** Show title or filename, duration and detected orientation as they arrive. Open the page as soon as the link is valid and populate these details asynchronously. Reuse the existing title lookup. Add a metadata probe for duration, dimensions and rotation, using FFprobe for local files and source metadata for YouTube. A URL marked `/live/` can be a replay. Show an actionable status for active or upcoming streams, which the current engine can process once they end. Reset source-specific selections when the source changes and ignore late results from the previous probe. [Title lookup](../desktop/src/main/source-info.js#L77), [Stream eligibility](../engine/autoclipper.py#L88)
3. **Settings and preview.** Show **Clips**, **Framing** and **Subtitles** in that order. Keep the generation CLI, SEO CLI and spoken-language settings under **Advanced**. Show an output preview and a summary beside the form on wide windows, with the same sections in a single column on narrow windows. Editing a draft or navigating back leaves active jobs running.
4. **Submit.** Validate the source and configured controls. A temporary metadata failure offers **Retry** and can still allow automatic highlights with a valid link. Manual ranges require a known duration, and adjustable crops require actual source frames. Create one job per submit with a snapshot of its options. Keep per-job Stop, queued Cancel and View clips. **Use settings again** restores the submitted settings and allows review before queuing again. [Current job controls](../desktop/src/renderer/views/jobs.js)

## Clip timing

| Clip mode | Controls and behavior |
| --- | --- |
| **Auto highlights** | Choose Auto count or an upper limit of 1–10. Offer **Auto**, **15–30 sec**, **30–60 sec**, **1–2 min**, **2–5 min** and **Custom range**. Custom range accepts minimum and maximum clip durations in seconds. An exact-duration request can enter the same value in both fields when it yields an encodable duration. Auto keeps the current target of roughly 15–55 seconds and the existing 65-second cap, with shorter clips for short sources. |
| **Manual timestamps** | Enter one or more start and end pairs, up to ten, or set them on the source timeline when playback is available. Accept seconds, `MM:SS` and `HH:MM:SS`, with optional fractional seconds. Each pair makes one continuous clip and determines its length. Show the selected duration and the frame-aligned boundaries before submission. Validate that each range is positive, within the source, and free of overlaps. Adjacent ranges are valid. Hide the Auto clip count and duration controls here. |

Remove `10–13 sec` from the setup and Settings presets. Reset existing saved `10-13` preferences to Auto during migration. Carry the old `30` preference forward as a visible custom range of 25–35 seconds. Keep existing CLI preset IDs accepted for callers that pass them explicitly.

Make the engine resolve the final source interval once. Automatic candidates can use approved transcript or sentence boundaries and add padding within the requested bounds. Manual cuts use the submitted frame-aligned interval. Use the same resolved interval for FFmpeg, caption timing and `sourceStartSec`/`sourceEndSec`. Clamp subtitle events to the clip, rebase their timestamps, and verify the rendered video duration before installing it in the library. Test frame rounding and audio/container timing at the duration boundaries, including exact-duration requests.

Validate model suggestions in Python for every provider. A transcript window may yield zero valid candidates even when a fixed count was requested. Keep valid candidates across windows, filter duplicate or overlapping final intervals, and show the number found or a specific message when the requested duration is infeasible. Report a provider failure separately from a valid search with zero matches. Manual timestamps bypass model highlight selection. They still use the existing transcription and copy steps for the selected speech. For the first release, require a source with spoken audio and flag a manual range without usable speech so the user can adjust it.

## Source orientation and framing

Use **Source orientation** with **Auto-detect**, **Vertical** and **Horizontal**. Auto uses the displayed dimensions after rotation. Suggest Fill for a 9:16 source and Fit for wide or square footage. An override changes the starting suggestion. The frames are still read in their actual dimensions. Keep the output canvas at 9:16 for the current clip library.

| Framing option | Output |
| --- | --- |
| **Fit full frame** | Preserve the full camera or screen view. Fill unused canvas space with a background. Use this as the safe Auto fallback when a source cannot be framed reliably. |
| **Fill frame** | Fill the portrait canvas and let the user position the crop. A vertical source can usually use nearly all of the input frame. |
| **Camera + screen** | Let the user mark two regions in the same source frame, preview the stacked portrait layout, and flip the panel order. Store regions as normalized coordinates after rotation. Validate that each region has usable dimensions and lies inside the frame. |
| **Auto reframe** | Analyze sampled frames to follow the main face or keep both regions visible when detection is reliable. Smooth changes between frames and fall back to Fit full frame on low confidence. Show the suggested layout for the preview sample and allow an override before running. |

Keep this framing selection independent of how clip timestamps are chosen. The first camera-and-screen release uses fixed user-selected regions. Automated camera following and layout changes come after validating those controls with footage that includes corner webcams, screen-only sections and scene changes. Preview the actual compose and crop filters on a source frame or short sample. Fetch a YouTube frame or sample when the user requests it, and keep local preview access limited to files selected through the app.

## Subtitle presets

| Style | Appearance |
| --- | --- |
| **Classic Yellow** | Yellow with a dark outline. Default for continuity with current exports. |
| **Clean White** | White with a dark outline. |
| **Bold Box** | Bold white text on dark blocks for busy footage. |
| **Karaoke Mint** | Short white phrases with a mint highlight that follows the active word. |
| **Punch Pop** | Bold uppercase phrases that scale into place on each short beat. |
| **Spotlight Box** | One word at a time on a violet badge. |
| **Off** | Omit the subtitles and still generate SEO fields and source credit. |

1. Register the new style IDs in the shared preset file so Generate, restored jobs, Electron validation and the Python engine accept the same options. Keep Classic Yellow as the default.
2. Put caption layout, styles and animation in the ASS export renderer. Keep the existing Roman Hinglish text generation. Request Whisper word times for animated styles and use them when the displayed words match the spoken sequence. Distribute the caption over the segment when translation or romanization changes the words. Clamp every cue to the exported interval.
3. Add a visual picker and an on-demand playback sample in Generate. Build transparent stills and motion samples with FFmpeg and the bundled export font. Use the same placement in the preview and export, including Camera + screen. The sample text shows the style before transcription and can appear over a loaded source frame.
4. Verify the seven choices, animated timing, clipping boundaries, source credit with subtitles off, and preview/export agreement. Check the production renderer build and open the Generate page in Electron.

Rebuild the bundled subtitle samples with `python3 desktop/scripts/build-subtitle-previews.py` after changing the caption renderer, presets or fonts. The build script requires FFmpeg with libass and libvpx. [CapCut caption styles](https://www.capcut.com/resource/types-of-captions) [Short-form caption examples](https://getinstacap.com/styles)

## Implementation order

| Phase | Deliverable | Code areas |
| --- | --- | --- |
| 1 | Route every entry point to Generate and fix export duration for the existing presets. Keep source selection responsive and preserve job cancellation. Retire the Library generation dialog once its CLI and language controls are available in Generate. | `views/library.js`, `views/generate.js`, `views/source.js`, `renderer/main.js`, `engine/clip_ai.py`, `engine/autoclipper.py` |
| 2 | Add source metadata, the new duration choices and manual timestamps. Pass one validated options object from the renderer through preload and main to Python. Derive duration labels, validation and engine rules from a shared, packaged preset definition. | `core/generation-settings.js`, `core/jobs.js`, `core/api.js`, preload, main and engine arguments |
| 3 | Deliver Fit, Fill, Camera + screen, the subtitle presets and a preview that uses the export settings. Record resolved interval, layout and style in output metadata. Add any new engine modules and assets to the installer resources. | Generate UI, FFmpeg rendering, metadata and `desktop/package.json` |
| 4 | Add Auto reframe after testing camera and screen detection on representative sources. Stabilize layout decisions and check that preview and export agree. | Media analysis and FFmpeg rendering |

Keep editable source-specific settings in the draft and snapshot them per job, including layout and subtitle style. Save durable defaults through the existing Settings workflow. A queued job uses its snapshot even if the user changes the draft or defaults. Continue reading legacy clip metadata using the existing defaults for missing fields. [Generation settings](../desktop/src/renderer/core/generation-settings.js), [Job queue](../desktop/src/main/generation.js)

The job options carry the source reference, the two CLI choices, spoken language, clip mode, framing, and subtitle preset ID. Auto mode carries count and duration bounds. Manual mode carries explicit start and end pairs. Use integer milliseconds for the request and convert to frame boundaries in the engine. Validate the options in the UI for field feedback, in Electron main before enqueueing, and in Python against the downloaded or opened source before rendering.

## Release checks

- Paste a watch, Shorts, short or completed-stream link on the Library. Confirm the source opens in Generate and one explicit submit starts one job. Repeat for a local file, Generate more, the sidebar and its shortcut. Check invalid links, source changes mid-probe and back navigation.
- Render synthetic media at exact length bounds, including the 13-second regression, a 30-second custom duration and a source shorter than the requested minimum. Check measured video duration, source interval metadata and caption alignment at both clip edges. Verify valid AI candidates survive a window with zero duration matches.
- Render 9:16, 16:9, square and rotation-tagged inputs. Test Fit and Fill, a webcam-over-screen recording with both regions visible, and Auto reframe with missing or low-confidence detections. Compare the preview and the exported framing.
- Check all subtitle styles on bright and dark frames. Verify long lines, margins, source credit and SEO with subtitles off, and equivalent font rendering on macOS and a packaged Windows build.
- Queue three runs with different options. Edit the next draft, stop one running job, cancel a queued job and retry a finished or failed one. Check that settings stay isolated, artifacts from finished runs remain available, and each result links to its existing source group.
