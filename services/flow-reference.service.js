import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Content names prevent a replaced presenter.jpg from selecting an older upload.
export async function referenceAsset(filePath) {
  const buffer = await fs.readFile(filePath);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extension];
  return { name: `storyboard-${hash}${extension}`, mimeType: mimeType || 'application/octet-stream', buffer };
}

// State is scoped to a Page (and therefore a Chrome account), never shared across accounts.
export class FlowReferenceSession {
  pages = new WeakMap();

  rememberProject(page) {
    const previous = this.pages.get(page);
    if (previous?.url === page.url()) return;
    this.pages.set(page, { url: page.url(), reference: null });
  }

  canReuseProject(page) {
    return this.pages.get(page)?.url === page.url() && !page.isClosed();
  }

  async ensure(page, asset, operations) {
    this.rememberProject(page);
    const state = this.pages.get(page);
    if (state.reference === asset.name && await operations.isAttached()) return 'attached';
    // Clear only references owned by this automation. Never silently mix two storyboards.
    await operations.clearAttachments();
    if (await operations.selectExisting(asset.name)) {
      state.reference = asset.name;
      return 'reused';
    }
    await operations.upload(asset);
    state.reference = asset.name;
    return 'uploaded';
  }
}
