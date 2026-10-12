import assert from 'node:assert/strict';
import { editAllianceSeat } from '../src/services/allianceBoard';
import { emptyBoard, PicklistService } from '../src/services/picklistService';
import { deriveCaptains, runDraft, declineScenario } from '../src/components/picklist/allianceModel';
import { saveSession, readSession, clearSession } from '../src/services/session';
import { comparisonText } from '../src/services/teamComparison';
import { buildAllTeamMetrics } from '../src/utils/teamMetrics';

let count = 0;
function test(name: string, fn: () => void) { fn(); count++; console.log('PASS ' + name); }
const ranked = Array.from({length:40},(_,i)=>i+1);
const ctx = {metricsFor:()=>undefined,ptsPerSecond:0,hasBps:false};
test('drafting a lower captain promotes the remaining captains',()=>{
  const board = editAllianceSeat(emptyBoard(),ranked,0,1,2);
  assert.deepEqual(deriveCaptains(board,ranked),[1,3,4,5,6,7,8,9]);
});
test('same captain edit preserves all picks',()=>{
  const board=emptyBoard();board[0]={captain:1,picks:[10,11]};
  assert.deepEqual(editAllianceSeat(board,ranked,0,0,1),board);
});
test('second pick cannot silently occupy first seat or duplicate captain',()=>{
  const board=emptyBoard();
  assert.equal(editAllianceSeat(board,ranked,0,2,10),board);
  assert.equal(editAllianceSeat(board,ranked,0,1,1),board);
});
test('moving teams between alliances leaves no duplicates',()=>{
  const board=emptyBoard();board[0]={captain:1,picks:[10,11]};board[1]={captain:2,picks:[]};
  const next=editAllianceSeat(board,ranked,1,1,10);
  assert.deepEqual(next[0],{captain:1,picks:[11]});
  assert.deepEqual(next[1],{captain:2,picks:[10]});
});
test('editing one pick to another already in same alliance swaps seats',()=>{
  const board=emptyBoard();board[0]={captain:1,picks:[10,11]};
  assert.deepEqual(editAllianceSeat(board,ranked,0,2,10)[0],{captain:1,picks:[11,10]});
});
test('accept simulation seats provisional captain only once',()=>{
  const {rosters}=runDraft(emptyBoard(),ranked,5,ctx,{poseSlot:1,poseFree:true});
  assert.equal(rosters.flat().length,new Set(rosters.flat()).size);
  assert.equal(rosters[0].includes(5),true);
  assert.equal(rosters.every((r)=>r.length===3),true);
});
test('partial draft completes first round before second round',()=>{
  const board=emptyBoard();board[0]={captain:1,picks:[10]};
  const {rosters}=runDraft(board,ranked,40,ctx,{poseFree:true});
  assert.equal(rosters[1][1],3);
  assert.equal(rosters[0][1],10);
});
test('decline bars invitations but allows captaincy',()=>{
  assert.equal(declineScenario(1,emptyBoard(),ranked,5,ctx)?.asCaptain,true);
  assert.equal(declineScenario(1,emptyBoard(),ranked,40,ctx),null);
});
const local=new Map<string,string>();
Object.assign(globalThis,{
  localStorage:{getItem:(k:string)=>local.get(k)??null,setItem:(k:string,v:string)=>local.set(k,v),removeItem:(k:string)=>local.delete(k)},
  window:{dispatchEvent:()=>{}},CustomEvent:class {},
});
test('board undo history persists and is bounded',()=>{
  const history=Array.from({length:120},()=>emptyBoard());
  PicklistService.setHistory(history);
  assert.equal(PicklistService.getHistory().length,100);
  PicklistService.setBoard(history[0]);
  assert.deepEqual(PicklistService.getBoard(),emptyBoard());
});
let cookie='';
Object.defineProperty(globalThis,'document',{value:{
  get cookie(){return cookie;},
  set cookie(v:string){cookie=v.includes('Max-Age=0')?'':v.split(';')[0];},
}});
test('admin/scout session restores and logout clears identity',()=>{
  for(const isAdmin of [true,false]){
    const u={username:'Test',alliance:'blue' as const,position:2 as const,isAdmin};
    saveSession(u);assert.deepEqual(readSession(),u);
    clearSession();assert.equal(readSession(),null);
  }
  cookie='frc-session-v1=%bad';assert.equal(readSession(),null);
  cookie='frc-session-v1='+encodeURIComponent('{}');assert.equal(readSession(),null);
});
const rows:any[]=[{id:'a',matchKey:'test_qm1',teamKey:'frc10',scouter:'Test',auto:{fuel:5},teleop:{offence:{fuel:10}},matchClimbed:'didnt_climb',timestamp:1}];
const teams=buildAllTeamMetrics(rows,['frc10','frc11'],[]);
test('existing scouting records produce metrics without CV',()=>{
  assert.equal(teams[0].hasData,true);assert.equal(teams[0].mean,15);assert.equal(teams[0].source,'legacy');
});
test('comparison distinguishes unknown data from zero',()=>{
  const text=comparisonText(teams);
  assert.match(text,/Team 10/);assert.match(text,/Average: 15.0/);
  assert.match(text,/Team 11/);assert.match(text,/No scoring data/);
});
console.log(count+' workspace/session checks passed.');
