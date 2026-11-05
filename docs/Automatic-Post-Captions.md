# Automatic captions and hashtags

Every spoken script produces its own post metadata. The caption is the first sentence of the first spoken line, or the whole first line when it has no sentence-ending punctuation. The wording and punctuation are preserved. Hook labels are removed. An exceptionally long hook is shortened at a word boundary to at most 500 characters so there is space for hashtags.

Hashtags include #RealLoveTalk and #RelationshipAdvice, plus up to three matching topic tags. Matching considers the complete script and gives extra weight to the hook. Topics include communication, boundaries, trust, marriage, money, breakups, long-distance relationships, emotional support, conflict, respect, dating, commitment, appreciation and self-worth. Tags are deterministic; they are not live trend or ranking predictions.

The same rules run in the browser preview and on the server. Script and schedule edits immediately refresh the preview. Incoming ChatGPT captions or old manually saved captions cannot override the spoken hook. Facebook and TikTok use it as the caption; YouTube uses it in the description, keeping the video title separate. Hashtags are appended once with a blank line between caption and tags.

For handwritten scenes, quoted speech supplies the script. Visual-only scenes with no spoken words retain manually entered captions and tags. Platform selections are preserved. Publishing retries refresh unsent platforms and skip posts already accepted by Buffer.

Verification: npm run test:post-metadata and npm run test:content. Tests use temporary state, local browser fixtures and mocked upload/post services; no real videos are generated or posted.
