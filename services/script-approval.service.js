import {createHash} from 'node:crypto';
export function scriptApprovalHash(item){return createHash('sha256').update(JSON.stringify([item.date,item.slot,item.title,item.script])).digest('hex');}
export function assertApprovedScript(item){if(item.plannerManaged&&(item.approval?.status!=='owner_approved_script'||item.approval.contentHash!==scriptApprovalHash(item)))throw Object.assign(new Error('This script needs approval before video production.'),{code:'SCRIPT_APPROVAL_REQUIRED'});}
