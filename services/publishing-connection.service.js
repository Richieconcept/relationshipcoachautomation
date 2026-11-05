import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {config} from '../src/config.js';
import {listChannels,verifyChannels,SUPPORTED_PLATFORMS} from './buffer.service.js';
import {assertCloudinaryConfigured,cloudinaryConfigMissing} from './cloudinary.service.js';

// The local operator can replace the key in .env and reconnect without exposing it to the UI.
async function reloadKey(){try{const values=dotenv.parse(await fs.readFile(path.join(config.rootDir,'.env')));if(values.BUFFER_API_KEY)config.buffer.apiKey=values.BUFFER_API_KEY;}catch(error){if(error.code!=='ENOENT')throw error;}}
export function restorePublishingChannels(settings){if(settings.bufferChannelIds)config.buffer.channelIds={...config.buffer.channelIds,...settings.bufferChannelIds};}
export async function publishingConnection(settings){
 await reloadKey();
 const result={connected:false,autoPublish:settings.autoPublish,platforms:settings.platforms,channelIds:{...config.buffer.channelIds},cloudinaryReady:cloudinaryConfigMissing().length===0,channels:[]};
 try{result.channels=await listChannels({refresh:true});result.connected=true;}catch(error){result.error=error.code;result.message=error.message;}
 return result;
}
export async function configureAutomaticPublishing(store,input){
 if(typeof input.autoPublish!=='boolean')throw Error('Choose whether automatic posting is on or off.');
 if(!input.autoPublish)return store.settings({autoPublish:false});
 if(!Array.isArray(input.platforms)||!input.platforms.length||input.platforms.some(p=>!SUPPORTED_PLATFORMS.includes(p)))throw Error('Choose at least one supported destination.');
 const channels={...config.buffer.channelIds};
 if(input.channelIds){for(const platform of input.platforms){const id=input.channelIds[platform];if(typeof id!=='string'||!id.trim()||id.length>200)throw Error('Choose a Buffer channel for '+platform+'.');channels[platform]=id.trim();}}
 await reloadKey();assertCloudinaryConfigured();
 await listChannels({refresh:true});await verifyChannels(input.platforms,{channelIds:channels});
 const result=store.settings({autoPublish:true,platforms:input.platforms,bufferChannelIds:channels});config.buffer.channelIds=channels;return result;
}
