// TEST 2: upload an existing MP4 to Cloudinary and confirm the public URL serves video.
// Usage: npm run test:cloudinary -- path/to/video.mp4
import path from 'node:path';
import { uploadVideo, verifyPublicVideoUrl } from '../services/cloudinary.service.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run test:cloudinary -- path/to/video.mp4');
  process.exit(1);
}

try {
  const publicId = `test_${path.basename(file, path.extname(file))}`;
  const result = await uploadVideo(path.resolve(file), { publicId });
  console.log(`publicId:  ${result.publicId}`);
  console.log(`secureUrl: ${result.secureUrl}`);

  const check = await verifyPublicVideoUrl(result.secureUrl);
  console.log(`public check: HTTP ${check.status}, ${check.contentType}, ${check.contentLength ?? '?'} bytes -> ${check.ok ? 'OK' : 'NOT PLAYABLE'}`);
  console.log('Open the secureUrl in a private browser window to watch it.');
  process.exitCode = check.ok ? 0 : 1;
} catch (error) {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
