import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {config} from '../src/config.js';

export async function geminiConfiguration(){
 const values=dotenv.parse(await fs.readFile(path.join(config.rootDir,'.env'),'utf8').catch(()=>''));
 const apiKey=values.GEMINI_API_KEY||values.GOOGLE_API_KEY||process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||'';
 const model=values.GEMINI_MODEL||process.env.GEMINI_MODEL||'gemini-3.5-flash-lite';
 if(!/^gemini-[a-z0-9.-]+$/.test(model))throw new Error('Set a valid GEMINI_MODEL.');
 return{apiKey,model};
}
export async function checkGemini(){
 const {apiKey,model}=await geminiConfiguration();
 if(!apiKey)return{configured:false,model,message:'Add GEMINI_API_KEY to .env, then check the connection.'};
 const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model,{headers:{'x-goog-api-key':apiKey},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(response.status===400||response.status===401||response.status===403?'Gemini rejected the key or access to this model. Check GEMINI_API_KEY and GEMINI_MODEL.':'Gemini model is unavailable. Check GEMINI_MODEL and try again.');
 const data=await response.json();if(!data.supportedGenerationMethods?.includes('generateContent'))throw new Error('This model does not support script generation.');
 return{configured:true,model,message:'Gemini connected. Generated scripts will remain drafts until you approve them.'};
}
export async function generatePlannerJson({system,prompt,schema}){
 const {apiKey,model}=await geminiConfiguration();
 if(!apiKey)throw Object.assign(new Error('Add GEMINI_API_KEY to .env before generating drafts.'),{code:'GEMINI_KEY_MISSING'});
 let response;
 try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema,temperature:0.8,maxOutputTokens:8192}}),signal:AbortSignal.timeout(120000)});}catch{throw Object.assign(new Error('Gemini connection interrupted. Completed drafts are saved; resume to finish remaining slots.'),{code:'GEMINI_NETWORK_ERROR'});}
 if(response.status===429)throw Object.assign(new Error('Gemini quota reached. Completed drafts are saved. Resume when your quota is available.'),{code:'GEMINI_QUOTA_EXHAUSTED'});
 if(response.status===503)throw Object.assign(new Error('Gemini is busy right now. Completed drafts are saved; use Resume to continue later.'),{code:'GEMINI_BUSY'});
 if(!response.ok)throw Object.assign(new Error(response.status===400||response.status===401||response.status===403?'Gemini rejected the key, model, or request. Check the connection settings.':'Gemini could not complete this request. Completed drafts are saved; try resuming later.'),{code:'GEMINI_REQUEST_FAILED'});
 const data=await response.json();const candidate=data.candidates?.[0];
 if(candidate?.finishReason!=='STOP')throw Object.assign(new Error('Gemini returned an incomplete or blocked response. No draft was approved or submitted to video generation.'),{code:'GEMINI_INCOMPLETE_RESPONSE'});
 let result;try{result=JSON.parse(candidate.content.parts.filter(part=>!part.thought).map(part=>part.text||'').join(''));}catch{throw new Error('Gemini returned invalid JSON. Completed drafts are saved.');}
 return{data:result,model,usage:data.usageMetadata||{}};
}
