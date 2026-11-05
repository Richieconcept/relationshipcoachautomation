// Duration options in the Flow settings menu ("4s", "6 s", "8 sec"...). Exact-text matches come first because
// the settings chip ("Video · 360p · 10s · x1") also contains the current duration and must not be taken for an option.
function durationSelectors(seconds) {
  // Spaces, not \s: backslashes do not survive inside the quoted :text-matches() argument.
  const exact = `^ *${seconds} *(s|sec|secs|seconds) *$`;
  return [
    `[role="radio"]:text-matches("${exact}", "i")`,
    `[role="option"]:text-matches("${exact}", "i")`,
    `button:text-matches("${exact}", "i")`,
    `[role="button"]:text-matches("${exact}", "i")`,
    `text=/${exact}/i`,
    `button:has-text("${seconds}s")`,
    `[role="button"]:has-text("${seconds}s")`
  ];
}

export const FLOW_SELECTORS = {
  loginIndicators: [
    'input[type="email"]',
    // Whole-text match only: a prompt like "modern design in Abuja" must not look like a login wall.
    'text=/^\\s*sign in\\s*$/i',
    'text=/use your google account/i'
  ],
  promptInputCandidates: [
    '[contenteditable="true"][role="textbox"]',
    'textarea[aria-label*="prompt" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea:not([name^="g-recaptcha-response"])',
    '[contenteditable="true"][aria-label*="prompt" i]',
    '[contenteditable="true"]'
  ],
  newProjectButtonCandidates: [
    'button:has-text("New project")',
    'div[role="button"]:has-text("New project")',
    'text=/New project/i'
  ],
  generateButtonCandidates: [
    'button[aria-label="Start generation"]',
    'button[aria-label="Generate"]',
    'button[type="submit"]:has(mat-icon:text-is("arrow_forward"))',
    'button[type="submit"]:has(i:text-is("arrow_forward"))',
    'button:text-is("Generate")',
    'button[aria-label*="generate" i]',
    '[role="button"][aria-label*="generate" i]'
  ],
  // Composer "+" opens an asset picker panel; uploads happen from inside it.
  addIngredientsButtonCandidates: [
    'button[aria-label="Add ingredients to the prompt box"]',
    'button[aria-label*="add ingredients" i]',
    '[role="button"][aria-label*="add ingredients" i]'
  ],
  uploadMediaButtonCandidates: [
    '[role="button"]:has-text("Upload media")',
    'button:has-text("Upload media")'
  ],
  addToPromptButtonCandidates: [
    'button:has-text("Add to prompt")',
    '[role="button"]:has-text("Add to prompt")'
  ],
  assetPreviewTitle: '.footer-title',
  ingredientChip: 'button[aria-label="Ingredient"]',
  uploadInput: 'input[type="file"]',
  settingOpeners: {
    model: [
      'button:has-text("Nano Banana")',
      '[role="button"]:has-text("Nano Banana")',
      'button:has-text("Omni")',
      '[role="button"]:has-text("Omni")',
      'button:has-text("Veo")',
      '[role="button"]:has-text("Veo")',
      'text=/Nano\\s*Banana/i'
    ],
    settings: [
      'button[aria-label="Settings trigger"]',
      'button:has-text("9:16")',
      '[role="button"]:has-text("9:16")',
      'button:has-text("16:9")',
      '[role="button"]:has-text("16:9")',
      'button:has-text("360p")',
      '[role="button"]:has-text("360p")',
      'button:has-text("10s")',
      '[role="button"]:has-text("10s")'
    ],
    outputCount: [
      'button:has-text("x2")',
      '[role="button"]:has-text("x2")',
      'button:has-text("x1")',
      '[role="button"]:has-text("x1")',
      'text=/x\\s*2/i',
      'text=/x\\s*1/i'
    ]
  },
  videoModeCandidates: [
    'flow-toggles[aria-label="Mode"] button[role="radio"]:has-text("Video")',
    'button:text-is("Video")',
    '[role="button"]:text-is("Video")',
    'text=/^\\s*Video\\s*$/i'
  ],
  modelDropdownCandidates: [
    'button:has-text("Nano Banana 2")',
    '[role="button"]:has-text("Nano Banana 2")',
    'button:has-text("Nano Banana")',
    '[role="button"]:has-text("Nano Banana")',
    'button:has-text("Omni")',
    '[role="button"]:has-text("Omni")',
    'button:has-text("Veo")',
    '[role="button"]:has-text("Veo")',
    'text=/Nano\\s*Banana\\s*2/i',
    'text=/Nano\\s*Banana/i'
  ],
  // Project media grid: generated videos and uploaded images use different tile components.
  videoTile: 'flow-video-tile',
  videoTileMedia: 'video',
  downloadButtonCandidates: [
    'button:has-text("Download")',
    'a:has-text("Download")',
    '[role="button"]:has-text("Download")',
    'button[aria-label*="download" i]',
    '[role="button"][aria-label*="download" i]',
    'a[aria-label*="download" i]'
  ],
  downloadQualityCandidates: [
    'button:has-text("360p")',
    '[role="button"]:has-text("360p")',
    'text=/360p\\s*Original\\s*size/i',
    'text=/360p/i'
  ],
  // Regex sources matched (case-insensitive) against short visible text on the page.
  errorTextPatterns: [
    'insufficient credits',
    'not enough credits',
    'more credits',
    'out of credits',
    'daily limit',
    'limit reached',
    'generation limit',
    'usage limit',
    'quota',
    'try again tomorrow',
    'come back tomorrow',
    'reached.*limit',
    'too many',
    'maximum',
    'failed',
    'could not generate',
    'try again',
    'rejected',
    'policy'
  ],
  // Text inside these never counts as an error: the composer and tile footers echo the user's prompt.
  errorTextIgnoreContainers: [
    'textarea',
    'input',
    '[contenteditable="true"]',
    'flow-tile-hover-footer',
    '.footer-title',
    '.cdk-visually-hidden'
  ],
  aspectRatioCandidates: {
    '9:16': [
      'button:has-text("9:16")',
      '[role="button"]:has-text("9:16")',
      'text=/9:16/',
      'button:has-text("Portrait")',
      '[role="button"]:has-text("Portrait")'
    ],
    '16:9': [
      'button:has-text("16:9")',
      '[role="button"]:has-text("16:9")',
      'text=/16:9/',
      'button:has-text("Landscape")',
      '[role="button"]:has-text("Landscape")'
    ]
  },
  modelCandidates: {
    'Omni 1.1 Flash': [
      'button:has-text("Omni 1.1 Flash")',
      '[role="button"]:has-text("Omni 1.1 Flash")',
      'text=/Omni\\s*1\\.1\\s*Flash/i',
      'button:has-text("Omni 1.1")',
      '[role="button"]:has-text("Omni 1.1")',
      'text=/Omni\\s*1\\.1/i',
      'button:has-text("Omni")',
      '[role="button"]:has-text("Omni")',
      'text=/Omni/i'
    ]
  },
  resolutionCandidates: {
    '360p': [
      'button:has-text("360p")',
      '[role="button"]:has-text("360p")',
      'text=/360p/i'
    ]
  },
  durationCandidates: {
    '4s': durationSelectors(4),
    '6s': durationSelectors(6),
    '8s': durationSelectors(8),
    '10s': durationSelectors(10)
  },
  outputCountCandidates: {
    '1': [
      'button:has-text("x1")',
      '[role="button"]:has-text("x1")',
      'button:has-text("1")',
      '[role="button"]:has-text("1")',
      'text=/x\\s*1/i'
    ]
  }
};

export class FlowAutomationError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'FlowAutomationError';
    this.code = code;
    this.cause = cause;
  }
}
