> Current workflow: manual scripts are now the default. Use Weekly Scripts at /content.html. The ChatGPT retrieval workflow below is retained as a legacy reference; it is not used in manual mode. See Manual-Script-Workflow.md.

# Approved planning conversation workflow

Configure a ChatGPT Project URL and the original planning conversation URL in Content Schedule. Keep planning and explicitly approving complete scripts in that conversation. Each approval must identify the publication date and morning, afternoon or evening slot. Approving a topic alone does not approve a finished script. Partial days and partial weeks are supported.

At the configured preparation hour (currently 18:00 Africa/Lagos), enabled automation prepares tomorrow's three slots. Existing saved scripts are reused. For missing scripts, the browser opens the configured planning conversation and asks for the latest exact approved script for that date and slot. The prompt explicitly accepts owner approvals made in the conversation; an uploaded Project Source is optional on this route. The browser verifies the Project and exact conversation identity before sending. Changed Project slugs are allowed when the Project ID is unchanged.

The response must contain JSON with date, slot, title, script, caption and hashtags. Wrong dates/slots and invalid or missing scripts stop production. The system derives the caption and hashtags from the script, stores the result locally, then starts generation and editing. With automatic publishing enabled, ready videos are sent at 06:00, 12:00 and 20:00 Africa/Lagos. A posting window missed by more than 15 minutes is held for review. Missing/ambiguous content is held rather than invented; approve tomorrow's scripts before preparation and inspect any Content Schedule error. Re-request after correcting an approval if it was previously not found.

No weekly JSON export or file upload is required when the planning conversation is configured. If a new planning conversation is used, update its source link once. A public share link is a snapshot and is not a live automation source. Keep the computer, server and dedicated signed-in ChatGPT browser session available. ChatGPT may fail to retrieve a record; exact JSON validation does not independently prove semantic approval, so clear dated approvals matter.

Manual JSON import remains optional. Existing saved scripts and video jobs are preserved when the source configuration changes. This integration reads chat context at retrieval time; it does not change ChatGPT account memory or guarantee access to every chat in a Project.

Configured source: https://chatgpt.com/g/g-p-6ae6091482d88191b65efd1c2a0ddda1/c/6ae6d73a-d144-83ea-adc8-a7929b0d9048

Configured on November 1, 2026 (Africa/Lagos). The source link was observed in the Project chat list. Local scheduler and browser-fixture tests passed; this change was not tested by sending a live ChatGPT message. No Project file was uploaded.

Automatic handoff: with automation enabled, script-ready items for upcoming slots today or tomorrow enter the production queue on the next scheduler tick (every 15 seconds), even before the daily retrieval hour. Explicit Fetch scripts only requests persist a preview hold and do not enter production until the operator chooses Create video or Prepare videos. Later dates remain saved until the daily production horizon reaches them. Past slots and interrupted jobs are held for review. Development work does not enable live automation or submit provider requests.

## One-click development run

On the main Video Studio page, choose a date and slot under Start video from ChatGPT, then click Start Video. This explicit action works while daily automation is paused. For a slot without a video job, it always requests a fresh approved script from the configured planning conversation, archives any previous saved script, validates the reply, splits it and runs generation and editing. It forces generate-only for that run and never enables Buffer posting. The main progress panel shows scene generation, editing and the final video player/download link. Reloading reconnects to the same slot/job instead of starting another request. An existing completed or interrupted job is displayed rather than duplicated.

Provider diagnostics: the previous live Flow scene reported Failed / unusual activity in its saved tile. The detector now surfaces FLOW_UNUSUAL_ACTIVITY immediately and stops automatic retries. Resolve Flow's warning manually before testing live generation. No automated bypass or additional live generation was used to verify this feature; local browser tests use mocked providers.

Human verification: when ChatGPT displays a human-verification challenge, automation pauses and brings its existing Chrome window forward. Complete the check manually in that window. The same request then continues; the checkbox is never clicked by automation, and a previously sent prompt is not resent. The tool waits up to ten minutes across verification pauses per request. Unfinished checks become a reviewable error, preserving whether a prompt had already been sent. Restarting during verification requires review. This browser-based integration cannot guarantee unattended operation when human verification is requested.

Login and script requests now share one persistent Playwright Chrome context. Leave the login window open after signing in. Reopening Login reuses it; it does not switch to a separately launched Chrome process. Normal server shutdown closes the owned ChatGPT context to flush session data. A forced termination or power loss can still leave a crash warning. This does not bypass or guarantee removal of human verification.
