# AI planner and script approval

Open http://localhost:3000/planner.html. Gemini creates drafts; only the operator can approve scripts.

## Workflow

1. Choose a starting date and generate one day (four scripts) or one week (28 scripts). Add focus topics or real-life situations if needed. The initial free-tier workflow uses evergreen topics and supplied notes, without live web research.
2. Open each draft to read the complete spoken words, title, word count, estimated duration, caption and hashtags. Save edits before approving. Regenerate only a selected script when needed.
3. Approve one script, selected scripts, a day, or the available week. Approval stores the exact script revision and a content fingerprint. Drafts never enter the production queue.
4. Approved scripts appear in Content studio. Scheduled generation begins two hours before each posting slot: splitter, serial Flow scene generation, pacing adjustment, editor, preview, then Buffer at the posting time if automatic posting is enabled.

Default Africa/Lagos slots: 06:00, 12:00, 16:00 and 20:00. Generation starts at 04:00, 10:00, 14:00 and 18:00 with a two-hour lead. Posting times can be changed under Brand guidance & posting times. Existing saved timestamps are preserved; new slots use the updated schedule.

## Editing and approval rules

- Editing an approved script before production withdraws approval. The new revision must be read and approved again.
- Requesting a rewrite also withdraws approval. A pending AI response cannot overwrite a newer manual edit or a started video.
- Once production is queued or a video job exists, the script is locked.
- Duplicate approvals reuse the existing approved revision and never submit another video.
- Bulk approval validates every selected revision first. A stale, incomplete, or past slot rejects the batch without approving the remaining scripts.
- Approval after the generation start but before posting is picked up on the next scheduler check. Past posting slots require rescheduling or explicit Approve & create now.
- Approve & create now is an explicit immediate production action, including for past slots. It may publish immediately if automatic posting is enabled.
- The manual script-entry buttons in Content studio are explicit approval actions. Slots managed by the AI planner must be edited and approved in Drafts & review.

## Gemini setup and usage

Store GEMINI_API_KEY in .env, never in frontend code. GEMINI_MODEL defaults to gemini-3.5-flash-lite and can be changed in .env. Check Gemini connection verifies model access; generation uses the Gemini REST API with structured JSON output and validates the response locally.

A complete week normally uses eight requests: one topic plan and seven daily script batches. A day normally uses two. Rewrites, errors and retries add requests. An application ceiling of 15 requests per Pacific day limits accidental repeated calls; this is not a promise about Google's account-specific quota. Token usage is recorded per run. No Search tool is enabled and no paid model fallback happens automatically.

Planning checkpoints are saved after topics and each completed script. On quota exhaustion, network failure, busy models or server restarts, completed drafts remain saved. Use Resume remaining drafts after access recovers; completed or owner-edited slots are preserved. A resumed request does not resubmit a video.

Brand guidance, drafts, revisions, request counts and run checkpoints live in tmp/content/state.json, alongside the approved content store. The previous content state was backed up in tmp/content/backups before deployment. No API key is returned in planner snapshots.

## Worker

The Windows task RealLoveTalk-VideoWorker checks the local server every minute and at sign-in. The internal scheduler checks every five seconds. The computer must remain awake, signed in and online; the task does not wake a powered-off computer. Unapproved drafts do not enable automatic production. Approval & schedule enables scheduled production for approved content.
