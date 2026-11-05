# Manual script workflow

Open /content.html (Weekly Scripts). Choose the first day, then paste complete spoken scripts into any of the 28 slots. Titles are optional; the opening line supplies a title when omitted. Blank slots are skipped. The opening hook supplies the caption and topic hashtags are generated automatically.

Save & schedule stores the entries and enables production at the scheduled generation time. Create now explicitly queues every filled editable slot in the displayed week, including later dates. Create video on a saved card starts just that slot. Active slots and slots with existing videos cannot be overwritten. Resume recovers existing failed/interrupted jobs.

Manual input is the default and does not need a ChatGPT Project, login, browser session or API key. Missing slots are never invented or fetched. Your exact stored script goes through the existing splitter, scene queue, generator and editor. Final videos are available from each card; Open video progress opens the studio for that job. Automatic posting is optional for manual scripts. Enable it in Automatic posting after verifying the Buffer connection and selecting destinations.

Enable automatic production only when ready for provider work. Leave the server and computer running, with the generation provider signed in. Saved scripts are picked up when their generation start time arrives in Africa/Lagos. This change removes the ChatGPT browser dependency; generation-provider availability and any manual checks still affect video creation. Forced shutdowns interrupt active work; recover existing jobs instead of duplicating them.

## Scheduled production and recovery

Save & schedule enables production. The default lead is 120 minutes, giving 04:00, 10:00 and 18:00 generation starts for 06:00, 12:00 and 20:00 Africa/Lagos slots. The server checks every five seconds; starts can be delayed by queued provider work. A script added after its generation start can still run before its content slot; a missed content slot is held for a manual run. Create now queues filled slots immediately. Saving or queueing is not a promise that the provider will finish before the content time.

Transient scene failures wait 10 seconds before retrying within MAX_SCENE_RETRIES. Failed transient jobs and eligible process-interrupted jobs can recover automatically on the same job, up to three scheduler recovery passes. Completed clips are checked and reused. Login, security challenges, exhausted credits, operator stops and ambiguous results require attention. Recovery never guesses between multiple videos or blindly resubmits an uncertain Generate click. Retry deadlines and recovery counters are persisted.

On Windows, scripts/install-worker-task.ps1 registers RealLoveTalk-VideoWorker at sign-in and once per minute. It invokes scripts/service-watchdog.js in a hidden worker, which checks the local server and starts it only when its port is free. It does not start a second server on an occupied port. The task uses the signed-in user with limited privileges. The computer must remain awake and logged in for browser generation; it cannot create video while powered off or asleep. To remove it: Unregister-ScheduledTask -TaskName RealLoveTalk-VideoWorker -Confirm:$false.

## Studio layout and pacing

Content studio now uses expandable days and script slots. Open a slot to edit its exact words; collapsing it preserves the input and browser draft. Production library rows, spoken scripts, captions/tags and diagnostic details expand separately. The default library shows the selected week; All dates exposes earlier content. Filters show in-progress, ready or attention items. Video studio shares the same navigation and design, with collapsible saved-slot, scene, editing, posting, brand and account sections.

Automatic pacing estimates active speech rate from the script and detected speech segments, compares at least three reliable clips and gently accelerates slower scenes. The normal limit is 1.20x with a hard ceiling of 1.25x. It shortens long silence separately and uses pitch-preserving audio tempo adjustment while changing video timestamps together. Captions are timed to the edited clips. Clips still substantially slower after the safe adjustment are flagged in the pacing report for review. This is a speech-rate estimate, not transcription or verification that all scripted words were spoken. Changes apply to future edits; completed videos are not rebuilt automatically.

## Missing scene replacement and isolated failures

When an existing result cannot be relocated, the worker checks the loaded original Flow project repeatedly for at least 20 seconds. If the composer is available, no verification or unusual-activity block is present, and no generation is still pending, it marks the result missing. The scene queue waits 10 seconds, then generates a fresh replacement with the same prompt/settings. Existing valid clips are reused. Checkpoint history and a maximum of three replacements per scene persist across restarts. Ambiguous multiple results, changed inputs and inaccessible projects are separate cases and are not treated as confirmed missing results.

Policy-rejected scenes hold that video for script revision without automatic prompt rewriting. Other queued or scheduled videos continue. Scheduled jobs carry their content-slot time as a generation deadline; once it passes, no further scene generation is submitted and the item becomes Slot skipped. A late manual Resume explicitly clears that deadline, allowing the owner to finish it on demand. Publishing is controlled separately in Automatic posting.


## Automatic posting

Open Automatic posting in either studio, refresh the Buffer connection, select the exact connected channels, and enable Publish new videos automatically. Save posting settings verifies the Buffer key, channel ownership and connection status, and video-hosting configuration before activation. A replacement BUFFER_API_KEY in .env is loaded when refreshing the connection.

With automatic posting enabled, Video studio offers Create & publish. Content studio Create now sends each new video after editing; Save & schedule generates two hours ahead and sends at its 6 am, noon or 8 pm Lagos slot. Captions use the opening hook and relevant hashtags. Existing finished previews do not opt in retroactively. Posting can be paused independently of generation. Accepted Buffer post IDs are retained on retry so successful platforms are not resubmitted. The UI distinguishes sending to Buffer from its final delivery to a social platform.


AI-generated scripts now use the separate Drafts & review screen at /planner.html. Approval is required before scheduled production. See AI-Planner-Workflow.md for revisions, batch approvals, four configurable posting times and Gemini quota recovery.
