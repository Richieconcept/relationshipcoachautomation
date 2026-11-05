// TEST 3: authenticate with Buffer and list connected channels (copy the IDs into .env).
// Usage: npm run buffer:channels
import { channelIdFor, listChannels, SUPPORTED_PLATFORMS } from '../services/buffer.service.js';

try {
  const channels = await listChannels({ refresh: true });
  if (channels.length === 0) {
    console.log('Authenticated, but no channels are connected to this Buffer account.');
  }
  for (const channel of channels) {
    const flags = [channel.isDisconnected && 'DISCONNECTED', channel.isLocked && 'LOCKED', channel.isQueuePaused && 'queue paused'].filter(Boolean);
    console.log(`${channel.platform.padEnd(10)} ${channel.id}  ${channel.name} (${channel.type}, ${channel.organizationName})${flags.length ? '  [' + flags.join(', ') + ']' : ''}`);
  }
  console.log('');
  for (const platform of SUPPORTED_PLATFORMS) {
    const id = channelIdFor(platform);
    const match = channels.find((channel) => channel.id === id);
    const state = !id ? 'not set' : !match ? 'NOT FOUND in Buffer' : match.platform !== platform ? `WRONG: that is a ${match.platform} channel` : `OK (${match.name})`;
    console.log(`BUFFER_${platform.toUpperCase()}_CHANNEL_ID: ${state}`);
  }
} catch (error) {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
