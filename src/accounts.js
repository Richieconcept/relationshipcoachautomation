import path from 'node:path';
import { config } from './config.js';

const accountStatuses = new Map();

function dateKey(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

export function getActiveAccountId() {
  return config.flowAccount || 'default';
}

export function getConfiguredAccountIds() {
  const accountIds = config.flowAccounts.length > 0
    ? config.flowAccounts
    : [getActiveAccountId()];

  return Array.from(new Set(accountIds));
}

export function getAvailableAccountId(excludedAccountIds = new Set()) {
  return getConfiguredAccountIds().find((accountId) => {
    if (excludedAccountIds.has(accountId)) {
      return false;
    }

    return getAccountStatus(accountId).status === 'available';
  }) || null;
}

export function getAccountProfileDir(accountId = getActiveAccountId()) {
  if (!accountId || accountId === 'default') {
    return config.browserProfileDir;
  }

  return path.join(config.browserProfilesDir, accountId);
}

export function getAccountStatus(accountId = getActiveAccountId()) {
  const status = accountStatuses.get(accountId);
  if (['daily_limit_reached', 'out_of_credits'].includes(status?.status) && status.updatedAt && dateKey(status.updatedAt) !== dateKey()) {
    return markAccountAvailable(accountId, 'Daily limit reset window has passed.');
  }

  return status || {
    accountId,
    status: 'available',
    message: 'Account is available.',
    updatedAt: null
  };
}

export function setAccountStatus(accountId, status, message) {
  const nextStatus = {
    accountId,
    status,
    message,
    updatedAt: new Date().toISOString()
  };

  accountStatuses.set(accountId, nextStatus);
  return nextStatus;
}

export function markAccountAvailable(accountId, message = 'Account is available.') {
  return setAccountStatus(accountId, 'available', message);
}

export function listAccountStatuses() {
  return getConfiguredAccountIds().map((accountId) => getAccountStatus(accountId));
}
