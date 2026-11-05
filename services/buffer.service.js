import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { PublishingError } from '../src/publishing-error.js';

// Buffer GraphQL API (https://developers.buffer.com). One endpoint, POST only, Bearer API key.
// Schema used here (checked against the published reference):
//   createPost(input: CreatePostInput!): PostActionSuccess { post } | MutationError { message }
//   CreatePostInput: channelId, text, schedulingType, mode, saveToDraft, assets[{ video: { url } }],
//                    metadata { facebook { type } | tiktok { isAiGenerated } | youtube { title, categoryId, ... } }

export const SUPPORTED_PLATFORMS = ['facebook', 'tiktok', 'youtube'];

const POST_MODES = ['addToQueue', 'shareNow', 'shareNext', 'draft'];
const CHANNEL_CACHE_MS = 5 * 60 * 1000;

const CHANNEL_ENV_NAMES = {
  facebook: 'BUFFER_FACEBOOK_CHANNEL_ID',
  tiktok: 'BUFFER_TIKTOK_CHANNEL_ID',
  youtube: 'BUFFER_YOUTUBE_CHANNEL_ID'
};

export function assertBufferConfigured() {
  if (!config.buffer.apiKey) {
    throw new PublishingError(
      'BUFFER_CONFIG_MISSING',
      'Buffer is not configured. Create an API key at https://publish.buffer.com/settings/api, set BUFFER_API_KEY in .env and restart the server.'
    );
  }
  if (!POST_MODES.includes(config.buffer.postMode)) {
    throw new PublishingError(
      'BUFFER_CONFIG_MISSING',
      `BUFFER_POST_MODE must be one of ${POST_MODES.join(', ')} (got "${config.buffer.postMode}").`
    );
  }
}

export function channelIdFor(platform) {
  return config.buffer.channelIds[platform] || '';
}

function graphQlErrorToPublishingError(error, httpStatus, fallbackCode) {
  const code = error?.extensions?.code;
  const message = error?.message || `HTTP ${httpStatus}`;

  if (httpStatus === 401 || ['UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN'].includes(code)) {
    return new PublishingError('BUFFER_AUTH_FAILED', `Buffer rejected the API key (${message}). Check BUFFER_API_KEY.`);
  }
  if (httpStatus === 429 || code === 'RATE_LIMIT_EXCEEDED') {
    const window = error?.extensions?.window ? ` (${error.extensions.window} window)` : '';
    return new PublishingError('BUFFER_RATE_LIMITED', `Buffer rate limit reached${window}. Try again later.`);
  }
  if (code === 'NOT_FOUND') {
    return new PublishingError('BUFFER_CHANNEL_NOT_FOUND', `Buffer could not find the requested resource: ${message}`);
  }
  return new PublishingError(fallbackCode, `Buffer API error${code ? ` (${code})` : ''}: ${message}`);
}

async function bufferRequest(query, variables = {}, { fallbackCode = 'BUFFER_POST_FAILED' } = {}) {
  assertBufferConfigured();

  let response;
  try {
    response = await fetch(config.buffer.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.buffer.apiKey}`
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    throw new PublishingError(fallbackCode, `Could not reach Buffer: ${error.message}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new PublishingError(fallbackCode, `Buffer returned an unreadable response (HTTP ${response.status}).`);
  }

  // Buffer documents HTTP 200 for every outcome, but rejects bad keys with 401 in practice; handle both.
  if (body?.errors?.length) {
    throw graphQlErrorToPublishingError(body.errors[0], response.status, fallbackCode);
  }
  if (!response.ok) {
    throw graphQlErrorToPublishingError(null, response.status, fallbackCode);
  }

  return body.data;
}

const ORGANIZATIONS_QUERY = `query Organizations {
  account {
    organizations { id name }
  }
}`;

const CHANNELS_QUERY = `query Channels($input: ChannelsInput!) {
  channels(input: $input) {
    id
    name
    displayName
    service
    type
    isDisconnected
    isLocked
    isQueuePaused
  }
}`;

let channelCache = null;

// All channels across every organization on the account, in a readable shape. No secrets included.
export async function listChannels({ refresh = false } = {}) {
  if (!refresh && channelCache && Date.now() - channelCache.fetchedAt < CHANNEL_CACHE_MS) {
    return channelCache.channels;
  }

  const data = await bufferRequest(ORGANIZATIONS_QUERY, {}, { fallbackCode: 'BUFFER_REQUEST_FAILED' });
  const organizations = data?.account?.organizations || [];
  const channels = [];

  for (const organization of organizations) {
    const result = await bufferRequest(CHANNELS_QUERY, { input: { organizationId: organization.id } }, { fallbackCode: 'BUFFER_REQUEST_FAILED' });
    for (const channel of result?.channels || []) {
      channels.push({
        id: channel.id,
        platform: channel.service,
        name: channel.displayName || channel.name,
        handle: channel.name,
        type: channel.type,
        organizationId: organization.id,
        organizationName: organization.name,
        isDisconnected: channel.isDisconnected,
        isLocked: channel.isLocked,
        isQueuePaused: channel.isQueuePaused
      });
    }
  }

  channelCache = { fetchedAt: Date.now(), channels };
  return channels;
}

/**
 * Check, before any Flow credits are spent, that each enabled platform has a configured channel ID
 * that exists in Buffer, belongs to that platform, and can post. Returns warnings (e.g. paused queue).
 */
export async function verifyChannels(platforms, {channelIds=config.buffer.channelIds} = {}) {
  const selectedId = platform => channelIds[platform] || '';
  assertBufferConfigured();

  const missing = platforms.filter((platform) => !selectedId(platform));
  if (missing.length > 0) {
    throw new PublishingError(
      'BUFFER_CHANNEL_NOT_FOUND',
      `No Buffer channel ID configured for ${missing.join(', ')}. Set ${missing.map((p) => CHANNEL_ENV_NAMES[p]).join(', ')} in .env (find IDs at GET /api/buffer/channels).`
    );
  }

  const channels = await listChannels();
  const warnings = [];

  for (const platform of platforms) {
    const channelId = selectedId(platform);
    const channel = channels.find((item) => item.id === channelId);
    if (!channel) {
      throw new PublishingError(
        'BUFFER_CHANNEL_NOT_FOUND',
        `${CHANNEL_ENV_NAMES[platform]} does not match any channel in your Buffer account. Check GET /api/buffer/channels.`
      );
    }
    if (channel.platform !== platform) {
      throw new PublishingError(
        'BUFFER_CHANNEL_NOT_FOUND',
        `${CHANNEL_ENV_NAMES[platform]} points to a ${channel.platform} channel ("${channel.name}"), not ${platform}.`
      );
    }
    if (channel.isDisconnected || channel.isLocked) {
      throw new PublishingError(
        'BUFFER_CHANNEL_NOT_FOUND',
        `The Buffer ${platform} channel "${channel.name}" is ${channel.isDisconnected ? 'disconnected' : 'locked'}. Reconnect it in Buffer.`
      );
    }
    if (channel.isQueuePaused) {
      warnings.push(`The Buffer ${platform} queue for "${channel.name}" is paused; posts will wait until it is resumed.`);
    }
  }

  return { channels, warnings };
}

const CREATE_POST_MUTATION = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess {
      post { id status dueAt externalLink }
    }
    ... on MutationError {
      message
    }
  }
}`;

// Buffer post status -> our platform status.
function platformStatusFromBuffer(bufferStatus, mode) {
  switch (bufferStatus) {
    case 'sent':
      return 'published';
    case 'sending':
      return 'publishing';
    case 'scheduled':
      return mode === 'addToQueue' || mode === 'shareNext' ? 'queued' : 'scheduled';
    case 'draft':
      return 'draft';
    case 'needs_approval':
      return 'pending';
    case 'error':
      return 'failed';
    default:
      return 'queued';
  }
}

/**
 * Create one video post on one Buffer channel. Shared by every platform; the platform-specific part
 * is only `metadata`, which Buffer nests under the platform key (metadata.facebook / .tiktok / .youtube).
 */
export async function createVideoPost({ channelId, videoUrl, text, platform, platformOptions = {}, postMode }) {
  if (!channelId) {
    throw new PublishingError('BUFFER_CHANNEL_NOT_FOUND', `No Buffer channel ID configured for ${platform}.`);
  }

  const mode = postMode || config.buffer.postMode;
  const input = {
    channelId,
    text,
    schedulingType: 'automatic',
    mode: mode === 'draft' ? 'addToQueue' : mode,
    assets: [{ video: { url: videoUrl } }]
  };
  if (mode === 'draft') {
    input.saveToDraft = true;
  }
  if (platformOptions.metadata && Object.keys(platformOptions.metadata).length > 0) {
    input.metadata = { [platform]: platformOptions.metadata };
  }

  logger.info(`Buffer: creating ${platform} post`, { channelId, mode, textLength: text?.length || 0 });
  const data = await bufferRequest(CREATE_POST_MUTATION, { input }, { fallbackCode: 'BUFFER_POST_FAILED' });
  const result = data?.createPost;

  if (!result?.post) {
    throw new PublishingError('BUFFER_POST_FAILED', `Buffer did not accept the ${platform} post: ${result?.message || 'no reason given'}`);
  }

  const status = platformStatusFromBuffer(result.post.status, mode);
  logger.info(`Buffer: ${platform} post created`, { postId: result.post.id, bufferStatus: result.post.status, dueAt: result.post.dueAt });

  return {
    postId: result.post.id,
    status,
    bufferStatus: result.post.status,
    dueAt: result.post.dueAt || null,
    externalLink: result.post.externalLink || null
  };
}

// Read-only confirmation: an accepted/queued post is not proof of publication.
export async function getVideoPost(postId, { postMode = config.buffer.postMode } = {}) {
  const data = await bufferRequest(`query GetPost($input: PostInput!) {
    post(input: $input) { id status dueAt externalLink }
  }`, { input: { id: postId } }, { fallbackCode: 'BUFFER_STATUS_FAILED' });
  const post = data?.post;
  if (!post || post.id !== postId) throw new PublishingError('BUFFER_STATUS_FAILED', 'Buffer did not return the requested post.');
  return { postId: post.id, status: platformStatusFromBuffer(post.status, postMode),
    bufferStatus: post.status, dueAt: post.dueAt || null, externalLink: post.externalLink || null };
}
