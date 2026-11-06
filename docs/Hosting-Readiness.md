# Hosting readiness

Reviewed 5 November 2026. Deployment has not started.

## Recommended first architecture

Use a Windows VPS with a desktop session for this version. The app currently launches installed Chrome, stores persistent per-account profiles, edits videos with FFmpeg, and saves jobs and scripts on disk. Its manual Chrome login helper uses Windows executable paths. A Linux deployment would need changes to login and desktop access.

Run the dashboard and worker on the same machine initially. Access the dashboard through Remote Desktop at http://localhost:3000 while remote web access is being prepared. Do not expose port 3000 directly to the public internet: the application has no dashboard sign-in, and content controls intentionally accept only loopback requests. An authenticated HTTPS reverse proxy or private access layer needs to be designed and tested before external dashboard access.

## Current implementation considerations

- Install Node.js compatible with the locked dependencies, Chrome, and FFmpeg/FFprobe with the caption filters used by the editor. Install dependencies with npm ci.
- Use a dedicated Windows user for the automation. The existing worker task requires an awake, signed-in desktop session; it is not an unattended boot service. Validate behavior after RDP disconnect and reboot before relying on the schedule.
- Sign in to Google accounts on the server. Do not assume that browser sessions copied from the desktop will work on a different machine.
- Preserve brand/, downloads/, uploads/, tmp/jobs/, tmp/flow-scenes/, tmp/content/, relevant planner state, and configured state locations. Keep credentials and browser profiles out of public deployment archives and source control.
- Existing job records and checkpoint names depend on absolute local paths. Keep the original local system as the historical source initially; validate migration separately before resuming old jobs on a different path.
- Keep automatic scheduling and publishing paused during migration. Verify a neutral generate-only job, download, editing, tab cleanup, restart recovery, and then the approved channel destination.
- Add disk retention and backups for generated media and job state.

## Affordable hosting shortlist

Prices checked 5 November 2026. These are provider-advertised prices; no server has been ordered or performance-tested.

| Provider | Windows plan | Advertised price | Assessment |
| --- | --- | --- | --- |
| InterServer | 2 CPU cores, 8 GB RAM, 160 GB SSD | US$20/month, monthly billing | Provisional budget choice for the current system. Confirm activated Windows licensing and the final total before paying. |
| InterServer | 1 CPU core, 4 GB RAM, 80 GB SSD | US$10/month, monthly billing | Lower-cost light test option; less headroom for Chrome and FFmpeg. |
| VPS Mart | 4 CPU cores, 8 GB RAM, 140 GB SSD | From US$14.99/month displayed | Windows licence included. The pricing page says the initial display uses a 24-month term. Its comparison table also shows US$18.99; obtain the exact 1-month total and renewal terms before comparing. |
| Hostnali Nigeria | 4 vCPU, 8 GB RAM, 100 GB SSD | NGN52,250/month | Windows licence included and naira billing. Ask for the monthly setup fee and selected server location; the provider excludes VPS from its money-back guarantee. |

My provisional recommendation is InterServer's 8 GB Windows plan, bought for one month first. This recommendation is based on the current application's Chrome session, persistent storage, and FFmpeg requirements, not a benchmark of the provider. Validate one full run and remote-session behavior before adding the second automation.

VPS Mart is an alternative worth checking, but the price shown by a long-term selector must not be treated as a month-to-month quote. Hostnali is an option if naira payment is preferred. Some cheaper hosts require the customer to supply a Windows licence; for example By-Hoster's EUR8/month offer explicitly excludes it.

AWS Lightsail remains a higher-cost alternative: its public-IPv4 Windows 8 GB plan is US$74/month.

Provider sources:
- InterServer Windows plans: https://www.interserver.net/vps/windows-vps.html
- VPS Mart specifications and licensing: https://www.vps-mart.com/windows-vps
- VPS Mart billing-term disclosure: https://www.vps-mart.com/pricing/monthly
- Hostnali Windows plans and terms: https://hostnali.ng/hosting/windows-vps/
- By-Hoster licensing exclusion: https://by-hoster.net/en/cheap-windows-vps
- AWS comparison: https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html

## Second YouTube automation

Keep its scripts, channel credentials, job state, browser profiles, and publishing destinations separate from this application. Choose its final hosting layout after its video source, processing steps, volume, and scheduling requirements are supplied. Independent application folders and workers can share a suitably sized host, but must not use the same Chrome profile concurrently.

## Decisions needed

Monthly budget, details of the second workflow, preferred private/RDP versus browser dashboard access, and a selected hosting account. No paid server should be created until its exact plan and cost have been approved.

## Manual operation and video retention (5 November 2026)

The current operating mode is manual scripts with automatic scheduling disabled. Paste a script in the main workspace and click Generate & Publish. The scheduler does not need to retrieve scripts from ChatGPT or run scheduled generation for this workflow. Manual Generate & Publish still uses the selected connected Buffer destinations.

After every selected platform reports the post as published (Buffer status sent), the application automatically removes that project's downloads/projects/<jobId> folder, including raw scenes, normalized clips, joined video, final edited video, captions and processing files. Presenter, logo, background music, scripts, settings and small job/post records remain. Cloudinary's uploaded copy is retained; this change clears local media only. Generate-only, failed, draft and queued videos remain until publication is confirmed. Failed file deletion is retried every minute while the server is running. Pending Buffer posts are checked on startup and every minute, independently of script scheduling. These checks never regenerate or submit another post.

This reduces disk use but does not complete a Render deployment. Render Free currently supplies 512 MB RAM and 0.1 CPU, sleeps after 15 minutes without inbound requests, and loses filesystem changes on sleep/restart/redeploy. Manual clicks remove the need for a daily scheduler, but an in-progress generation still needs a running worker. Brand assets, Google browser sessions and job/checkpoint state require durable storage or an external worker; Chrome/FFmpeg memory and Linux browser login support still require validation. Publication confirmation and cleanup resume when the server is awake, provided the job state survives.

Official Render references: https://render.com/docs/free and https://render.com/docs/compute-plans
Buffer confirmation schema: https://developers.buffer.com/reference.html (post query and PostInput).

## Repository deployment preparation

Dockerfile now installs Chromium, its Linux dependencies, FFmpeg and fonts. render.yaml specifies a free Docker web service with /health and manual scheduling defaults. ALLOW_REMOTE_CONTROLS and TRUST_PROXY are explicit hosted settings; no app login has been added at the owner's request. Hosted controls are public. The repository and image exclude credentials, Google profiles, generated media and runtime state. Brand assets are included.

This is not yet verified end to end on Render. A Git push does not migrate Google's Windows browser session. The Windows login helper has not been replaced by a cloud login workflow. The free Blueprint has no persistent disk. Do not enable live publishing on an unrestricted public test instance.

## Live Render test deployment — 6 November 2026

- Workspace: My Workspace (tea-cu3qg9a3esus73bks0tg).
- Service: relationshipcoachautomation (srv-dbml6mrm8hqs73aphfe0).
- Website: https://relationshipcoachautomation.onrender.com
- Dashboard: https://dashboard.render.com/web/srv-dbml6mrm8hqs73aphfe0
- Compute plan: free; region: Oregon; runtime: Docker; health check: /health. No paid plan, database or persistent disk was created.
- Initial deployed commit: a566d80b3cae3cf4cc2a43a39ffe52c79b1d88c1.
- Initial deploy: dep-dbml6n3m8hqs73aphg3g, confirmed live.

Verified against the live service: HTTP health response, studio HTML, manual script mode, automatic scheduling disabled, HTTPS same-origin content controls, blocked cross-origin content controls, saved global instructions, and matching SHA-256 hashes for presenter.jpg, music.mp3 and logo.png. Runtime logs confirm FFmpeg and FFprobe are available. Chromium installation passed during the Docker build; an authenticated Google generation was not run.

No Google browser session, Buffer/Cloudinary credentials, local job history or recovery checkpoints were migrated. This is a working hosted studio/runtime test, not a verified cloud generation-and-publishing workflow. Google login needs a supported cloud session workflow, and free Render runtime changes remain ephemeral. The dashboard has no app login, as requested.

Deployment used the official Render CLI v2.35.0 after the installed Render connection returned Unknown tool errors. CLI authorization was completed by the owner. The CLI binary and local authorization configuration are under ignored tmp/ paths; neither belongs in Git or the Docker image.

## Cloud connection setup — 6 November 2026

The service's private environment now contains the saved Cloudinary, Buffer and Gemini credentials plus portable editing/generation settings. Local Windows paths were excluded. The environment deployment reached live. Automatic scheduling remains disabled.

Private authenticated setup checks verify provider connections and Google readiness without creating a video or social post. Hosted Chrome can close before FFmpeg starts to reduce peak memory. Optional FLOW_SESSION_STATE supports a compressed Google/Flow session in Render's private environment; it is never served by an API, committed, or included in logs. It seeds only its matching account. Google can still expire the session or require verification.

Automatic approval review rejected the attempted Google session migration because explicit authorization to transmit those session credentials to Render had not yet been given. No Google cookies were transferred. The remaining transfer requires owner approval; this does not authorize bypassing Google verification, unusual-activity warnings or policy refusals.
