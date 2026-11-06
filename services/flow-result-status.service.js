import { FlowAutomationError } from '../src/flow.js';

// Read only the selected scene's status, never unrelated older tiles or prompt text.
export function flowTileFailure(tile) {
  const status = String(tile.statusText || '').replace(/\s+/g, ' ').trim();
  let error;
  if (/we noticed some unusual activity|unusual activity.*(?:help center|browser extensions)/i.test(status)) {
    error = new FlowAutomationError('FLOW_UNUSUAL_ACTIVITY', 'Flow blocked this scene for unusual activity. Open Flow manually and resolve its warning before resuming. Automatic resubmission is disabled.');
  } else if (/violat(?:e|es|ed|ion).*polic|against.*polic|policy violation|safety (?:polic|guideline|filter|reason)|blocked.*(?:policy|safety)|prompt (?:was )?rejected|content (?:was )?blocked/i.test(status)) {
    error = new FlowAutomationError('GENERATION_REJECTED', 'Flow rejected this scene under its content policy. Revise the script before retrying; later videos can continue.');
  } else if (/failed to generate|generation failed|could not generate|video failed|(?:^|\s)(?:warning\s*)?failed(?:\s|$)/i.test(status)) {
    error = new FlowAutomationError('GENERATION_FAILED', 'Flow confirmed that this scene failed to generate.');
  }
  if (error) {
    error.confirmedSceneFailure = true;
    error.providerMessage = status;
  }
  return error || null;
}

export function generationFailureDetails(code, providerMessage = null) {
  const guidance = {
    GENERATION_REJECTED: { title: 'Script rejected by Flow', nextAction: 'Edit the script for the failed scene and submit the revised script. This scene will not retry automatically.', scriptNeedsRevision: true },
    FLOW_UNUSUAL_ACTIVITY: { title: 'Google account needs attention', nextAction: 'Open Flow in the affected Google account and resolve the unusual activity warning, then resume. Changing the script is not required for this warning.', scriptNeedsRevision: false },
    SCENE_RETRY_EXHAUSTED: { title: 'Scene recovery limit reached', nextAction: 'Browser recovery and replacement attempts have stopped. Review the last failure before resuming; completed scenes are kept.', scriptNeedsRevision: false },
    GOOGLE_LOGIN_REQUIRED: { title: 'Google sign-in required', nextAction: 'Sign in to the affected Google account, then resume.', scriptNeedsRevision: false },
    INSUFFICIENT_CREDITS: { title: 'Account has insufficient credits', nextAction: 'Check account credits or select another available configured account.', scriptNeedsRevision: false },
    FLOW_DAILY_LIMIT_REACHED: { title: 'Account daily limit reached', nextAction: 'Wait for the account limit to reset or select an available configured account where permitted.', scriptNeedsRevision: false },
    NETWORK_ERROR: { title: 'Network connection failed', nextAction: 'Check the internet connection. This scene will retry automatically while its production window remains open.', scriptNeedsRevision: false }
  }[code];
  return guidance ? { code, ...guidance, providerMessage } : null;
}
