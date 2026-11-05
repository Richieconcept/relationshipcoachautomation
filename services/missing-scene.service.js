// A loaded original project must show a stable absence before replacement is allowed.
export class MissingSceneTracker {
 constructor({minimumMs=20000,minimumChecks=3}={}){this.minimumMs=minimumMs;this.minimumChecks=minimumChecks;this.since=null;this.checks=0;}
 reset(){this.since=null;this.checks=0;}
 observe({now=Date.now(),projectUrl,expectedProjectUrl,composerReady,blocked=false,tiles=[]}){
  let sameProject=false;
  try{const current=new URL(projectUrl),expected=new URL(expectedProjectUrl);sameProject=current.origin===expected.origin&&current.pathname.replace(/\/$/,'')===expected.pathname.replace(/\/$/,'');}catch{}
  const pending=tiles.some(tile=>tile.pending === true || /\b\d{1,3}\s*%|\b(?:queued|rendering|generating)\b/i.test(tile.statusText||tile.text||''));
  if(!sameProject||!composerReady||blocked||pending){this.since=null;this.checks=0;return false;}
  this.since??=now;this.checks++;
  return this.checks>=this.minimumChecks&&now-this.since>=this.minimumMs;
 }
}
