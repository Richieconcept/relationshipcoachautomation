# relationshipcoachautomation

Manual script-to-video generation, editing and social publishing through Google Flow, FFmpeg, Cloudinary and Buffer.

Paste your script in the studio and choose Generate & Publish. Scheduled automation starts disabled. Successfully published project media is deleted locally after every selected platform confirms publication; brand assets and small job records are retained.

## Render deployment

The repository includes a Dockerfile with Chromium and FFmpeg and a free Render Blueprint (render.yaml). Deploy the main branch as a Docker web service; health check: /health. No paid service is configured. The hosted controls have no dashboard login, as requested; anyone who can reach the service can use them. Do not treat the URL as a secret or enable live publishing credentials on an unrestricted public test service.

**Google login is not included in a Git push.** Browser profiles, credentials, generated media, logs and local job/script state are excluded from Git and the Docker build. The current Google login helper is for the Windows computer. A cloud browser needs its own supported login/session setup before Google Flow generation can work. Free Render storage resets on sleep/restart/redeploy; this Blueprint is a dashboard/runtime test, not a verified persistent production worker. See [hosting readiness](docs/Hosting-Readiness.md).

Configure any publishing credentials privately in Render's environment settings; never add .env or Google cookies to GitHub. Brand presenter, music, logo and fonts are included as project assets. Changes uploaded through the dashboard require durable storage to survive a redeploy.

## Manual scripts and weekly entry

Open http://localhost:3000/content.html to paste one script or up to 21 dated scripts for seven days. Save & schedule starts production two hours before each slot; Create now queues the filled slots immediately. Manual scripts are the default; ChatGPT login is not required. Transient scene failures retry until success, backing off from ten to sixty seconds. The Windows worker task keeps the server available. Posting stays off. See [manual workflow](docs/Manual-Script-Workflow.md).

# Google Flow Video Automation

## ChatGPT Project content automation

Open **Content schedule** from the video studio, or visit `http://localhost:3000/content.html`.
This integration uses the ChatGPT website through Chrome and your existing Project context; it does not use the OpenAI API or require an OpenAI API key.

1. Save your ChatGPT Project URL (or a conversation URL within that Project).
2. Click **Open ChatGPT Login**, sign in manually, confirm access to the Project, then close that Chrome window. This uses its own profile at `browser-profiles/chatgpt-content/`, separate from Flow. Keep ChatGPT's interface in English for the browser controls.
3. Choose one planned date/slot and click **Fetch scripts only**. Inspect the saved script and post metadata. If needed, use **Edit script and post details** to correct the extracted response.
4. Click **Create video** to send that saved script through the existing splitter, Flow scene queue, and editor. Saved brand presenter, global instructions, logo, music and captions are reused. Existing video jobs are reused and can be resumed after interruption.
5. Choose publishing destinations and enable automatic publishing if wanted, then enable daily automation. Settings are saved on this computer; no `.env` change is needed. Automation and publishing start disabled.

The default preparation time is **18:00 Africa/Lagos**. The scheduler prepares the following date's **morning (06:00), afternoon (12:00), and evening (20:00)** videos sequentially. The date and slot must already exist in your weekly Project plan. The request asks ChatGPT to retrieve that item and return a JSON object containing `date`, `slot`, `title`, `script`, `caption`, and `hashtags`, or `CONTENT_NOT_PLANNED`. This is the retrieval format; the weekly content-planning prompt can be drafted separately.

Responses with the wrong date/slot, malformed JSON, missing metadata, or missing planned content are held for review. The complete response is saved before production. **Request script again** explicitly makes another ChatGPT request; it never creates a second video for a slot with an existing job. **Fetch scripts only** never creates videos or publishes posts.

Automatic publishing destinations and permission are captured when production starts. Both the global automation and automatic publishing switches must still be on when the slot is due. Disabling automation pauses future preparation and scheduled publishing; already-running script/video jobs finish. Changing destinations affects future production, not existing slots.

At posting time, the local scheduler submits the ready video through Cloudinary and Buffer with per-job **shareNow**, independent of the studio's `BUFFER_POST_MODE`. This initiates delivery at the slot; upload time and Buffer/platform processing can delay public visibility. The scheduler checks every 15 seconds. It does not guarantee second-accurate publication. A video more than 15 minutes late is held as `missed`, rather than posting an old backlog. The existing studio's Generate & Publish behavior is unchanged.

Keep this computer awake and one instance of the Node server running, with Chrome, FFmpeg, Flow access, and the configured publishing services available. If the server returns after 18:00 it queues any untouched slots for tomorrow; it does not automatically regenerate failed or interrupted work. Uncertain script submissions or publishing after a restart require review. A `published` job means Buffer accepted the posts; check Buffer for actual delivery or any platform-specific approval.

State and scripts live in `tmp/content/state.json` (excluded from Git). Jobs retain `contentSlotId` to reconnect saved work after a restart. Do not delete browser profiles or state as a way to retry a slot. The content API is limited to loopback clients and rejects cross-origin controls. Browser UI changes, login challenges, and usage limits can require manual attention. The live Project connection requires a signed-in browser test; fixture tests do not verify access to your account.

Checks: `npm run test:content` for scheduler/API/recovery logic; `npm run test:content-browser` for local browser fixtures and the control page. These tests use isolated state and do not call ChatGPT, Flow, Cloudinary or Buffer.

Local Phase 1 proof-of-concept for automating Google Flow video generation through a real browser session.

The app exposes a small Express API, opens or reuses Chrome through Playwright, submits one Flow generation at a time, watches for success or failure, downloads the generated video, and serves the saved file locally.

## Prerequisites

- Node.js 20 or newer
- Google Chrome recommended
- A Google account with access to Google Flow
- A local machine where a visible browser can open during development

## Install

```bash
npm install
npx playwright install
```

Playwright will use installed Chrome first. If Chrome is not available, it falls back to bundled Chromium.

On Windows PowerShell, if `npm` is blocked by the execution policy, use `npm.cmd` instead:

```bash
npm.cmd install
npm.cmd run dev
```

## Environment

Copy or edit `.env`:

```bash
PORT=3000
FLOW_URL=https://labs.google/fx/tools/flow
FLOW_PROJECT_URL=
HEADLESS=false
CHROMIUM_SANDBOX=true
FLOW_ACCOUNT=
FLOW_ACCOUNTS=
BROWSER_PROFILES_DIR=./browser-profiles
DOWNLOAD_DIR=./downloads/videos
UPLOAD_DIR=./uploads/references
SCREENSHOT_DIR=./screenshots
BROWSER_PROFILE_DIR=./browser-profile
GENERATION_TIMEOUT_MS=900000
FLOW_GENERATION_RETRIES=20
FLOW_GENERATION_RETRY_DELAY_MS=60000
POLL_INTERVAL_MS=5000
FLOW_DEFAULT_ASPECT_RATIO=9:16

# Multi-scene projects
PROJECT_DOWNLOAD_DIR=./downloads/projects
MAX_SCENE_RETRIES=2
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
NORMALIZE_VIDEO=true
OUTPUT_VIDEO_CODEC=libx264
OUTPUT_AUDIO_CODEC=aac
OUTPUT_FPS=30
```

Set `FLOW_PROJECT_URL` if you want the automation to open a specific Flow project or generation page.

Leave `FLOW_ACCOUNT` empty to use the original `browser-profile/` session. Set it to a named account, such as `account-1`, to use `browser-profiles/account-1/`.

## First Google Login

Do not automate Google login. If Google says the Playwright browser is not secure, use the normal Chrome login helper:

```bash
npm run login:chrome
```

Chrome opens with the same persistent profile in `browser-profile/`. Sign in manually, confirm Flow loads, then close that Chrome window before running automation.

After the session is saved, test Playwright reuse:

```bash
npm run test:browser
```

If authentication expires later, the API returns `GOOGLE_LOGIN_REQUIRED` and saves a screenshot. Run `npm run login:chrome` again to refresh the saved session.

## Multiple Google Accounts

Use one browser profile per Google account. Login is still manual, but the saved session can be reused by the scheduler.

Open Chrome for a specific account:

```bash
npm run login:account -- account-1
npm run login:account -- account-2
```

You can also do this from the local frontend. Open `http://localhost:3000`, use the **Accounts** panel, type an account ID like `account-1`, and click **Open Login**.

Sign into a different Google account in each opened Chrome window, confirm Flow works, then close Chrome before running automation.

Choose the active account in `.env`:

```bash
FLOW_ACCOUNT=account-1
```

Or enable automatic rotation:

```bash
FLOW_ACCOUNT=
FLOW_ACCOUNTS=account-1,account-2,account-3
```

With `FLOW_ACCOUNTS` set, each job picks the first available account. If an account returns `FLOW_DAILY_LIMIT_REACHED` or `GOOGLE_LOGIN_REQUIRED`, the app closes that browser profile, marks the account unavailable in memory, and retries the same job with the next available account. Daily-limit accounts are made available again automatically on the next calendar day while the server is running.

If Flow returns a normal generation failure, such as “this video failed to generate,” the app retries the same job before marking it failed. Network/connectivity errors are also treated as temporary and retried after the same delay. Configure this with `FLOW_GENERATION_RETRIES` and `FLOW_GENERATION_RETRY_DELAY_MS`.

Named account profiles are stored under:

```text
browser-profiles/account-1/
browser-profiles/account-2/
```

Check in-memory account state:

```bash
GET http://localhost:3000/api/videos/accounts
```

When Flow reports a daily or quota limit, the API returns `FLOW_DAILY_LIMIT_REACHED` and marks that account as `daily_limit_reached` in memory. The daily reset is handled by Google; restart the app or use a different `FLOW_ACCOUNT` after the reset.

## Start Server

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## API Testing

Health:

```bash
GET http://localhost:3000/health
```

Expected:

```json
{
  "status": "ok"
}
```

Start a generation:

```bash
POST http://localhost:3000/api/videos/generate
Content-Type: application/json

{
  "prompt": "Create a realistic Nigerian female presenter speaking naturally to camera in a vertical social media video.",
  "aspectRatio": "9:16"
}
```

Expected:

```json
{
  "success": true,
  "jobId": "vid_172000001",
  "status": "queued"
}
```

Poll status:

```bash
GET http://localhost:3000/api/videos/jobs/JOB_ID
```

Completed jobs return:

```json
{
  "success": true,
  "jobId": "vid_172000001",
  "status": "completed",
  "message": "Video generation completed.",
  "videoUrl": "/downloads/videos/vid_172000001.mp4"
}
```

List jobs:

```bash
GET http://localhost:3000/api/videos/jobs
```

## Reference Image Upload

Send `multipart/form-data` to `POST /api/videos/generate`:

- `prompt`
- `aspectRatio`
- `referenceImage`

Uploaded images are stored in `uploads/references/`.

In Flow, the automation clicks the composer **+** (Add ingredients), then **Upload media**, waits for Flow to finish processing the image (usually 30-60s), clicks **Add to prompt**, and confirms the image chip appears in the composer before continuing.

## Multi-Scene Projects

One request can hold any number of scenes. Scenes are generated one at a time in Flow, each clip is checked with ffprobe, then FFmpeg normalizes the clips and joins them in the submitted order into one MP4.

FFmpeg and ffprobe are required. Check them with:

```bash
npm run check:ffmpeg
GET http://localhost:3000/api/videos/system-check
```

Start a project (JSON, or `multipart/form-data` with `scenes` as a JSON string plus an optional `referenceImage` file):

```bash
POST http://localhost:3000/api/videos/generate-project
Content-Type: application/json

{
  "title": "Delmatic Fire Pump Advert",
  "aspectRatio": "9:16",
  "globalInstructions": "Same presenter, same face, same clothing, natural Nigerian voice, no background music.",
  "scenes": [
    { "scene": 1, "prompt": "Scene one prompt..." },
    { "scene": 2, "prompt": "Scene two prompt..." }
  ]
}
```

The response returns at once with `jobId` and `totalScenes`. Poll `GET /api/videos/jobs/JOB_ID` for `completedScenes`, `currentScene`, `progressPercent`, per-scene status and, when done, `finalVideoUrl`.

How it behaves:

- Each Flow prompt is `globalInstructions` + a blank line + the scene prompt. The reference image is uploaded for every scene.
- Temporary scene failures retry until success with `RETRY_SCENE_UNTIL_SUCCESS=true` (default), backing off from 10 to 60 seconds. Set it to `false` to use `MAX_SCENE_RETRIES`. Valid completed clips are kept; missing clips are recovered or regenerated. Scheduled jobs stop at their publishing deadline.
- Rejected prompts, missing credits and no available account stop the project immediately rather than retrying.
- The scene queue owns retries for multi-scene jobs, including network and browser failures; it does not nest another generation retry loop.
- Clips are normalized to 1080x1920 (9:16) or 1920x1080 (16:9). They are scaled and padded, never stretched, at `OUTPUT_FPS` (default 30), H.264 + AAC 48 kHz stereo, with loudness levelled across scenes.
- Only one Flow job runs at a time. Projects submitted while another is running wait in line.

Files per project:

```text
downloads/projects/JOB_ID/raw/scene_001.mp4 ...        clips as downloaded from Flow
downloads/projects/JOB_ID/normalized/scene_001.mp4 ... re-encoded clips
downloads/projects/JOB_ID/final/JOB_ID_final.mp4       assembled video
screenshots/JOB_ID_scene_003_attempt_02_error.png      failure screenshots
```

Clips that fail validation are kept as `scene_003_attempt_01_invalid.mp4` for debugging. Nothing is deleted automatically. `cleanupProjectFiles(jobId)` in `services/project-files.service.js` is ready for the publishing phase, but it must only be called after publishing is confirmed.

Jobs are kept in memory, so restarting the server (including `npm run dev` restarting after a code change) stops a running project.

## Script Mode, Brand and Editing

### Script mode

Choose **Script: scenes made automatically** and paste exactly what the presenter says. The script is split into scenes as you type (`POST /api/videos/split-script` returns the same preview):

- Each scene is one Flow clip of 4s, 6s, 8s or 10s (`FLOW_DURATIONS`), the shortest its words fit in. A clip holds `(length - SCRIPT_SPEECH_MARGIN_SECONDS) x SCRIPT_WORDS_PER_SECOND` words: 6, 11, 16 and 21 by default.
- The plan keeps total clip time and the number of scenes low. It cuts at full stops where it can, at a comma, colon or dash if needed, and between words only as a last resort.
- The automation selects each scene's length in Flow's settings before generating it.
- After download, the silence after the presenter's last word is trimmed (`TRIM_TRAILING_SILENCE`), so scenes join without dead air.
- Each scene's Flow prompt is your Global Instructions plus `SCRIPT_SCENE_TEMPLATE` with the scene's words, so the presenter says that line.

API: send `script` instead of `scenes` to `POST /api/videos/generate-project`.

### Brand

The **Brand** panel saves three files in `brand/`, used for every new video:

The storyboard/presenter is uploaded only when the exact image is missing from Flow's asset picker. Later scenes reattach that saved asset (or keep it when already attached) and stay in the same Flow project. Image content determines the asset name, so replacing the presenter uploads a new version. Switching Chrome accounts uses that account's own assets and uploads if needed. The last project URL for each account is saved in `tmp/flow-workspaces.json` for reuse after restarting; an explicit `FLOW_PROJECT_URL` takes priority. Music and logo remain local and are applied during editing, not uploaded to Flow.

Run `npm run test:flow-controls` for the local regression checks. Run `npm run inspect:flow -- --reference` to verify storyboard attachment, reattachment, and project reload in your saved Chrome account without generating a video. The first run may upload the storyboard if the project does not contain its content-named asset yet.

To generate and monitor one scene from a saved project, run `node scripts/monitor-flow.js PROJECT_ID SCENE_NUMBER`. This uses the normal Flow generation allowance, saves the clip and a status/timing report under that project's `checks/` directory, and does not publish it. It uses the current brand presenter and the prompt saved in `project.json`.

### Interrupted jobs and download recovery

Use **Resume Existing Job** on a failed or interrupted job, or `POST /api/videos/jobs/JOB_ID/resume`. This keeps the same job and scene identities. Submitting the form again creates a separate new job.

New jobs are saved under `tmp/jobs/`; scene checkpoints are saved under `tmp/flow-scenes/`. Keep these folders to preserve recovery across restarts. An unfinished job is restored as **Interrupted**, ready to resume. Publishing interruptions are kept separate and are not automatically reposted.

For each scene, recovery checks these states in order:

| State | Action |
| --- | --- |
| Valid local video | Reuse it; no browser generation |
| Generated in Flow, download incomplete | Return to the original account/project and download that saved result |
| Still generating | Wait for the existing scene |
| Interrupted/uncertain Generate click | Search the saved project; do not submit again |
| Explicit failure on the identified scene | Allow the scene retry policy to generate again |
| Missing/ambiguous result, changed inputs, or damaged checkpoint | Stop for inspection without a replacement generation |

Downloads use a temporary file and are validated before becoming the final scene file. After `MAX_DOWNLOAD_RECOVERY_ATTEMPTS` (default 3) unsuccessful downloads or corrupt files, the checkpoint schedules regeneration of that scene. Download counts and replacement history survive restarts, and replacement retries no longer stop after three attempts. Recovery uses the saved video's thumbnail/source identity and the original prompt when needed; it does not simply take the newest video. An account limit during download recovery cannot move an already-submitted scene to a different account and generate it again. Scenes never submitted can still use normal account rotation.

These checkpoints cover work started with this version. Older videos without a checkpoint cannot always be identified automatically. Run `npm run test:recovery` for the local failure/restart checks. `node scripts/check-flow-recovery.js PROJECT_ID SCENE_NUMBER` can verify an existing uniquely matching scene through a simulated download interruption without submitting a generation.

Flow failures save an error screenshot and a matching `_diagnostics.json` file in `screenshots/`, with visible button states and failed HTTP endpoint/status information. These diagnostics exclude request bodies, credentials and URL query strings. A submission with no confirmed start stops for inspection instead of blindly submitting again.

| File | Used for |
| --- | --- |
| Presenter image | Reference image for every scene (a reference image uploaded with a project overrides it) |
| Logo | Overlay in the corner (`LOGO_POSITION`), transparent PNG recommended |
| Background music | Mixed under the voice, looped if shorter than the video |

### Editing

New videos use large white Bangers captions with a black outline. Each spoken word bounces up to 140% scale, settles at 118%, and stays bright green until the next word; surrounding words stay white. Automatic sizing is 124 at 1080x1920, with captions placed at 20% of the video height above the bottom edge. The static font and its OFL license are bundled in `brand/fonts/` so rendering does not depend on installed system fonts. Font, size, and both colors can be overridden with the `CAPTION_*` settings in `.env`; `CAPTION_ANIMATION=false` disables the word bounce.

Smart pacing detects silence in the raw dialogue clips before adding background music. It shortens long internal gaps, trims excess silence at the start/end, and keeps a small breathing space around speech. Short 0.08-second audio/video blends soften those cuts and scene joins. If speech detection fails or finds no speech, the clip is kept. Caption timing is recalculated on the edited clips and accounts for the overlaps. The report is saved as `pacing.json` in the project directory. This is audio-based detection, not semantic understanding or speech transcription.

Normal use only needs the script. The saved presenter, logo, music and global instructions are applied automatically. Open **Saved video defaults** to upload replacements or save revised instructions; these survive browser and server restarts. The initial saved instructions are migrated from the most recent existing project with global instructions. **Options for this video** provides temporary overrides; leaving instructions empty uses the saved default. API defaults: `GET /api/brand/defaults` and `PUT /api/brand/defaults` with `{ "globalInstructions": "..." }`.

Automatic scene pace matching compares estimated words per second of active speech against the project's median. With at least three reliable scenes, noticeably slower scenes can play up to 20% faster, preserving voice pitch. Short or unreliable scenes keep their speed; long pauses are handled separately. This estimates speaking pace from the script and audio activity, without transcribing speech. Captions are retimed after the speed adjustment. `pacing.json` records each scene's speed and reason. Configure `MATCH_SCENE_PACE`, `MAX_SCENE_SPEED` (default `1.20`, hard limit `1.25`), and `SCENE_PACE_TOLERANCE` (default `0.10`).

Use `npm run edit:project -- JOB_ID --rebuild` to apply the new pacing to saved raw clips without generating again. `npm run test:editor` checks silence trimming, blends, scene speed decisions, audio/video synchronization, pitch preservation, caption font selection and saved-default behavior.

After the scenes are joined, one FFmpeg pass adds (each can be switched off on the page, or with `editing: {"logo":false}` in the API):

- **Logo**: `LOGO_WIDTH_PERCENT` of the video width, at `LOGO_OPACITY`.
- **Background music**: loudness-levelled, then set to `MUSIC_VOLUME` under the voice. It ducks while the presenter talks (`MUSIC_DUCKING`) and fades in and out.
- **Captions**: burned in, a few words at a time, with the spoken word highlighted. Timing comes from the script plus FFmpeg silence detection on each clip (no speech recognition). If Flow changes the words, the captions still show the script. In hand-written scene mode, words in "quotes" are used as the spoken line.

Keep "No background music" in your Global Instructions so Flow does not add its own.

A missing logo or music file is not an error: the video is made without that step and the page says why. The unedited join is kept as `final/JOB_ID_joined.mp4` (the **Unedited version** link).

To re-run editing on a finished project without spending Flow credits (for example after changing caption settings):

```bash
npm run edit:project -- JOB_ID
npm run edit:project -- JOB_ID --no-music
npm run edit:project -- JOB_ID --script my-script.txt   # projects made before script mode
```

## Publishing: Cloudinary + Buffer

The page has two actions:

- **Generate Only**: generates the scenes, merges them and shows the final video. It never contacts Cloudinary or Buffer.
- **Generate & Publish**: does the same, then uploads the final MP4 to Cloudinary once and sends that public URL to Buffer, with separate text for each enabled platform (Facebook, TikTok, YouTube).

Captions, titles, descriptions and hashtags are all entered by hand. Hashtags can be typed as `#Business #Nigeria Technology`; they are cleaned into `["#Business", "#Nigeria", "#Technology"]` and kept separate from the caption until posting, when the text becomes `caption + blank line + hashtags`.

### 1. Cloudinary setup

1. Create a free account at https://cloudinary.com.
2. In the Cloudinary console, open **Settings > API Keys** and copy the cloud name, API key and API secret.
3. Put them in `.env`:

```bash
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_FOLDER=flow-social-automation
```

Videos are uploaded as `CLOUDINARY_FOLDER/JOB_ID` with `resource_type: video`, in 20 MB chunks. The returned `secure_url` is a plain public delivery URL, which Buffer needs: Buffer fetches the video when the post goes out, which may be hours later.

### 2. Buffer setup

1. In Buffer, connect your Facebook Page, TikTok account and YouTube channel (**Channels > Connect**).
2. Create an API key at https://publish.buffer.com/settings/api.
3. Put it in `.env` and restart the server:

```bash
BUFFER_API_KEY=your_buffer_api_key
```

4. Find your channel IDs:

```bash
npm run buffer:channels
# or, with the server running:
GET http://localhost:3000/api/buffer/channels
```

5. Copy the IDs into `.env` and restart:

```bash
BUFFER_FACEBOOK_CHANNEL_ID=...
BUFFER_TIKTOK_CHANNEL_ID=...
BUFFER_YOUTUBE_CHANNEL_ID=...
```

Optional settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUFFER_POST_MODE` | `addToQueue` | `addToQueue` (next free slot in your Buffer schedule), `shareNow`, `shareNext`, or `draft` (saved in Buffer, never published; good for testing) |
| `BUFFER_FACEBOOK_POST_TYPE` | `auto` | `auto` = Reel for 9:16 videos up to 90 s, otherwise a normal video post; or force `reel` / `post` |
| `BUFFER_YOUTUBE_CATEGORY_ID` | `22` | Buffer requires a YouTube category (22 = People & Blogs, 27 = Education, 28 = Science & Technology) |
| `BUFFER_YOUTUBE_PRIVACY` | `public` | `public`, `unlisted` or `private` |
| `BUFFER_YOUTUBE_MADE_FOR_KIDS` | `false` | YouTube "made for kids" flag |
| `BUFFER_DISCLOSE_AI_GENERATED` | `true` | Marks TikTok and YouTube posts as AI-generated (Flow videos are) |

When you click Generate & Publish, the server first checks that Cloudinary and Buffer are configured and that each enabled platform's channel ID exists in Buffer, is connected, and belongs to that platform. It does this **before** any Flow generation, so a configuration mistake never wastes Flow credits.

### How each platform is posted (Buffer GraphQL `createPost`)

| Platform | Post text | Platform fields |
| --- | --- | --- |
| Facebook | caption + hashtags (max 5,000) | `metadata.facebook.type` = reel or post |
| TikTok | caption + hashtags (max 2,200 with a video) | `metadata.tiktok.isAiGenerated` |
| YouTube | description + hashtags (max 5,000) | `metadata.youtube.title` (required, max 100), `categoryId`, `privacy`, `madeForKids`, `isAiGenerated` |

Every post uses `schedulingType: automatic`, the video in `assets[{ video: { url } }]`, and one channel per request, as the Buffer API requires.

### Statuses

Project: `queued > generating > validating/normalizing/assembling > completed_generation > uploading_to_cloudinary > ready_to_publish > publishing > published`, or `partially_published` / `publishing_failed`.

Each platform: `disabled`, `pending`, `publishing`, `queued`, `scheduled`, `published`, `draft` or `failed`.

Platforms are independent. If TikTok fails, Facebook and YouTube still go out, the job ends `partially_published`, and **Retry Failed Platforms** (or `POST /api/videos/jobs/JOB_ID/publish`) re-sends only the failed platform. It reuses the same Cloudinary URL, without regenerating or re-uploading. The Cloudinary URL and the local final video are kept even if every platform fails.

Error codes: `CLOUDINARY_CONFIG_MISSING`, `CLOUDINARY_UPLOAD_FAILED`, `BUFFER_CONFIG_MISSING`, `BUFFER_AUTH_FAILED`, `BUFFER_CHANNEL_NOT_FOUND`, `BUFFER_POST_FAILED`, `BUFFER_RATE_LIMITED`, `FACEBOOK_POST_FAILED`, `TIKTOK_POST_FAILED`, `YOUTUBE_POST_FAILED`, `PUBLISHING_PARTIAL_FAILURE`. API keys and secrets are never logged or returned.

### Testing step by step

1. **Generate Only**: use the page as before; nothing is uploaded or posted.
2. **Cloudinary only**: `npm run test:cloudinary -- downloads/projects/JOB_ID/final/JOB_ID_final.mp4` prints the `secureUrl` and checks that it is public and serves video. Open it in a private browser window to watch it.
3. **Buffer connection**: `npm run buffer:channels` authenticates and lists channels, and says whether each `BUFFER_*_CHANNEL_ID` is correct.
4. **One Buffer post**: `npm run test:buffer -- --platform facebook --video-url SECURE_URL --text "Caption #Tag"`. This saves a **draft** in Buffer by default, so nothing goes live; check it in Buffer, then delete it. Add `--live` to use `BUFFER_POST_MODE` instead. For YouTube, add `--title "..."`.
5. **Full run**: enable one platform on the page and click Generate & Publish. Setting `BUFFER_POST_MODE=draft` first is a safe dry run. Then add the other platforms.

### Troubleshooting

- **`BUFFER_AUTH_FAILED`**: the API key is wrong or was revoked. Create a new one at https://publish.buffer.com/settings/api.
- **`BUFFER_CHANNEL_NOT_FOUND`**: the channel ID is missing, belongs to another platform, or the channel is disconnected or locked. Run `npm run buffer:channels`.
- **Posts queued but never published**: the channel's Buffer queue may be paused (you get a warning when submitting), or the channel has no posting schedule slots. Check in Buffer.
- **TikTok**: Buffer may handle some TikTok accounts with reminder notifications instead of automatic posting; this depends on the account and on Buffer. Check the post in Buffer if it does not go out.
- **`Failed to fetch ...` from Buffer**: the video URL was not public. Use the Cloudinary `secure_url`, not a dashboard link.
- **Buffer rate limits**: about 100 requests per 15 minutes and 250 per day, depending on plan. One project with three platforms uses roughly 5 requests.

## Frontend

The plain HTML test UI is served at:

```text
http://localhost:3000
```

It submits the prompt, polls the job endpoint, and shows the generated video when complete.

## Local Files

- Videos: `downloads/videos/`
- Screenshots: `screenshots/`
- Logs: `logs/app.log`
- Browser profile: `browser-profile/`
- Named browser profiles: `browser-profiles/ACCOUNT_ID/`

## Common Errors

- `GOOGLE_LOGIN_REQUIRED`: Sign in manually in the opened browser.
- `PROMPT_INPUT_NOT_FOUND`: Flow UI changed or the selector needs to be updated.
- `GENERATE_BUTTON_NOT_FOUND`: Flow UI changed or the selector needs to be updated.
- `FLOW_DAILY_LIMIT_REACHED`: Flow reported a daily/quota/usage limit. Use another authenticated browser profile or wait for the account reset.
- `INSUFFICIENT_CREDITS`: Flow reported no available credits.
- `GENERATION_REJECTED`: Flow rejected the prompt or reference image.
- `GENERATION_TIMEOUT`: Generation did not complete before `GENERATION_TIMEOUT_MS`.
- `NETWORK_ERROR`: Chrome, Playwright, or Flow could not reach the network. The app waits and retries while retry attempts remain.
- `DOWNLOAD_FAILED`: The download control was not found or no download event fired.

Full technical details are written to `logs/app.log`. Flow errors also save screenshots.

## Reset Browser Profile

Stop the server, delete `browser-profile/`, then run:

```bash
npm run login:chrome
```

Sign in again.

## Updating Flow Selectors

Selectors are centralized in `src/flow.js`.

If Google changes Flow:

1. Run `npm run test:browser`.
2. Inspect the live DOM.
3. Update `FLOW_SELECTORS`.
4. Test prompt insertion before testing full generation.

Avoid fixed screen coordinates. Prefer Playwright locators, labels, roles, ARIA attributes, visible text, and file inputs.
