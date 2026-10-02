export const normaliseMerchant=(merchant:string):string=>merchant.normalize('NFKD')
  .replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
export const merchantsMatch=(left:string,right:string,allowTruncation:boolean):boolean=>{
  const a=normaliseMerchant(left).replace(/\s+/g,''),b=normaliseMerchant(right).replace(/\s+/g,'');
  return a===b || allowTruncation && Math.min(a.length,b.length)>=8 && (a.startsWith(b)||b.startsWith(a));
};
const foreignStopWords=new Set(['THE','STORE','STORES','SHOP','SHOPS','TO','LAS','VEG','VEGAS']);
export const foreignMerchantsMatch=(left:string,right:string):boolean=>{
  if(merchantsMatch(left,right,true))return true;
  const tokens=(value:string)=>new Set(normaliseMerchant(value).split(' ').filter(t=>t.length>=2 && !foreignStopWords.has(t)));
  const a=tokens(left),b=tokens(right);if(!a.size||!b.size)return false;
  const common=[...a].filter(t=>b.has(t)).length;return common>=2 && common/Math.min(a.size,b.size)>=2/3;
};
export const financialCalendarDay=(value:string):string=>{
  const time=new Date(value);if(!Number.isFinite(time.getTime()))throw new Error('Invalid reconciliation timestamp');
  const parts=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'America/Chihuahua'}).formatToParts(time);
  const part=(type:string)=>parts.find(p=>p.type===type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
