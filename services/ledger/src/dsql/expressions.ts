import { canonicalJson } from './model.js';

type Item = Record<string, unknown>;
export type ExpressionInput = { ExpressionAttributeNames?: Record<string,string>; ExpressionAttributeValues?: Item };
const invalid = (): never => { const e = new Error('Unsupported Olbia storage expression.'); e.name='ValidationException'; throw e; };
export const pathFor = (name: string, input: ExpressionInput): string[] => name.split('.').map(part => {
  const value = part.startsWith('#') ? input.ExpressionAttributeNames?.[part] : part;
  if (!value || !/^[A-Za-z_][\w]*$/.test(value) || ['__proto__','prototype','constructor'].includes(value)) return invalid();
  return value;
});
const readPath = (item: Item | undefined, path: readonly string[]): unknown => path.reduce<unknown>((value,key) =>
  value && typeof value==='object' && Object.hasOwn(value,key) ? (value as Item)[key] : undefined,item);
const writePath = (item: Item, path: readonly string[], value: unknown, remove=false) => {
  let parent=item;
  for (const part of path.slice(0,-1)) {
    if (!parent[part] || typeof parent[part]!=='object' || Array.isArray(parent[part])) return invalid();
    parent=parent[part] as Item;
  }
  if (remove) delete parent[path.at(-1)!]; else parent[path.at(-1)!]=value;
};

// This grammar is deliberately limited to Olbia's checked-in conditions/updates.
// Parse all operands even when boolean evaluation could short circuit. Never eval input.
class Parser {
  private tokens: string[];
  private index=0;
  constructor(expression: string, private item: Item | undefined, private input: ExpressionInput) {
    const matcher= /\s*(<>|<=|>=|[=<>+(),]|:[\w]+|[#A-Za-z_][\w#]*(?:\.[#A-Za-z_][\w#]*)*)/gy;
    this.tokens=[]; let offset=0;
    while (offset<expression.trimEnd().length) { matcher.lastIndex=offset; const match=matcher.exec(expression); if (!match) invalid(); this.tokens.push(match![1]); offset=matcher.lastIndex; }
  }
  private peek() { return this.tokens[this.index]; }
  private take(expected?: string) { const value=this.tokens[this.index++]; if (!value || expected && value!==expected) invalid(); return value; }
  done() { if (this.index!==this.tokens.length) invalid(); }
  value(): unknown {
    let result=this.atom();
    if (this.peek()==='+') { this.take('+'); const right=this.atom(); if (typeof result!=='number' || typeof right!=='number') invalid(); result=(result as number)+(right as number); }
    return result;
  }
  private atom(): unknown {
    const token=this.take();
    if (token.startsWith(':')) { if (!Object.hasOwn(this.input.ExpressionAttributeValues??{},token)) invalid(); return this.input.ExpressionAttributeValues![token]; }
    if (this.peek()==='(') {
      this.take('('); const first=this.value();
      if (token==='attribute_exists' || token==='attribute_not_exists') { this.take(')'); return token==='attribute_exists' ? first!==undefined : first===undefined; }
      this.take(','); const second=this.value(); this.take(')');
      if (token==='if_not_exists') return first===undefined ? second : first;
      if (token==='list_append') { if (!Array.isArray(first) || !Array.isArray(second)) invalid(); return [...first as unknown[],...second as unknown[]]; }
      if (token==='begins_with') return typeof first==='string' && typeof second==='string' && first.startsWith(second);
      return invalid();
    }
    return readPath(this.item,pathFor(token,this.input));
  }
  condition(): boolean { let left=this.and(); while (this.peek()==='OR') { this.take(); const right=this.and(); left=left||right; } return left; }
  private and(): boolean { let left=this.predicate(); while (this.peek()==='AND') { this.take(); const right=this.predicate(); left=left&&right; } return left; }
  private predicate(): boolean {
    if (this.peek()==='(') { this.take(); const result=this.condition(); this.take(')'); return result; }
    const left=this.value(); const operator=this.peek();
    if (operator==='BETWEEN') { this.take(); const lower=this.value(); this.take('AND'); const upper=this.value(); return comparable(left,lower) && comparable(left,upper) && (left as string)>= (lower as string) && (left as string)<= (upper as string); }
    if (!['=','<>','<','>','<=','>='].includes(operator)) { if (typeof left!=='boolean') invalid(); return left as boolean; }
    this.take(); const right=this.value();
    if (left===undefined || right===undefined) return false;
    if (operator==='=') return canonicalJson(left)===canonicalJson(right);
    if (operator==='<>') return canonicalJson(left)!==canonicalJson(right);
    if (!comparable(left,right)) return false;
    if (operator==='<') return (left as string)<(right as string);
    if (operator==='>') return (left as string)>(right as string);
    if (operator==='<=') return (left as string)<=(right as string);
    return (left as string)>=(right as string);
  }
}
const comparable=(a:unknown,b:unknown) => typeof a===typeof b && (typeof a==='string' || typeof a==='number');
export const conditionMatches = (expression: string | undefined, item: Item | undefined, input: ExpressionInput): boolean => {
  if (!expression) return true;
  const parser=new Parser(expression,item,input); const result=parser.condition(); parser.done(); return result;
};
const splitAssignments=(expression:string):string[] => {
  const result:string[]=[]; let start=0,depth=0;
  for(let i=0;i<expression.length;i++) { if(expression[i]==='(') depth++; if(expression[i]===')') depth--; if(expression[i]===',' && depth===0) { result.push(expression.slice(start,i).trim());start=i+1; } }
  result.push(expression.slice(start).trim()); if(depth!==0 || result.some(x=>!x)) invalid(); return result;
};
export const updateItem = (expression: string, original: Item | undefined, key: Item, input: ExpressionInput): Item => {
  const next=structuredClone(original??key);
  const sections=[...expression.matchAll(/\b(SET|REMOVE|ADD|DELETE)\b/g)];
  if (!sections.length || expression.slice(0,sections[0].index).trim()) invalid();
  for (let i=0;i<sections.length;i++) {
    const section=sections[i]; const body=expression.slice(section.index!+section[0].length,sections[i+1]?.index).trim();
    if (!['SET','REMOVE'].includes(section[0])) invalid();
    for(const assignment of splitAssignments(body)) {
      if(section[0]==='REMOVE') { writePath(next,pathFor(assignment,input),undefined,true);continue; }
      const match=/^([^=]+)=(.+)$/.exec(assignment); if(!match) invalid();
      const parser=new Parser(match![2],original,input);const value=parser.value();parser.done();
      if(value===undefined) invalid(); writePath(next,pathFor(match![1].trim(),input),structuredClone(value));
    }
  }
  return next;
};
export const projectItem = (item: Item, expression: string | undefined, input: ExpressionInput): Item => {
  if(!expression) return structuredClone(item);
  const result:Item={};
  for(const name of expression.split(',')) { const path=pathFor(name.trim(),input);const value=readPath(item,path);if(value===undefined) continue; let parent=result;for(const part of path.slice(0,-1)) parent= (parent[part]??={}) as Item;parent[path.at(-1)!]=structuredClone(value); }
  return result;
};
