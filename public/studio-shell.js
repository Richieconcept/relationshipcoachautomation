function revealAnchor(){if(!location.hash)return;const target=document.getElementById(location.hash.slice(1));if(target?.tagName==='DETAILS')target.open=true;}window.addEventListener('hashchange',revealAnchor);revealAnchor();

import './publishing-controls.js';

const navigation=document.querySelector('.studio-nav');if(navigation){const planner=document.createElement('a');planner.href='/planner.html';planner.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l3 3m6 6 3 3M6 18l3-3m6-6 3-3"/><circle cx="12" cy="12" r="4"/></svg>AI planner';if(location.pathname==='/planner.html'){navigation.querySelector('[aria-current]')?.removeAttribute('aria-current');planner.setAttribute('aria-current','page');}navigation.prepend(planner);}
