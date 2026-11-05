import fs from 'node:fs/promises';
import path from 'node:path';
import {config} from '../src/config.js';
export async function buildPlannerSystem(profile=''){
 const editorial=await fs.readFile(path.join(config.brandDir,'scriptwriter-instructions.md'),'utf8');
 return editorial+'\n\nADDITIONAL OWNER GUIDANCE\n'+profile;
}
