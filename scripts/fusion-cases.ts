import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScoreAttribution, buildMatchPoints, runFuzzyPipeline, BpsReport } from '../src/services/bps';
import { CvMatchLog, TimelineScoutingData } from '../src/types';
import { buildAllTeamMetrics } from '../src/utils/teamMetrics';
import { fake } from './fusion-fakes';
import { saveTimeline, pushTimelines, fetchTimelines, getTimelines,
  saveCvLog, pushCvLogs, fetchCvLogs, getCvLogs, fetchLocalWorkerLogs, cvLogToJson, parseCvJson } from '../src/services/bpsStore';
const local = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (k: string) => local.get(k) ?? null,
  setItem: (k: string, v: string) => local.set(k, v), removeItem: (k: string) => local.delete(k) },
  window: { dispatchEvent() {} } });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
const tl = (team: number, spans: number[][] = []): TimelineScoutingData => ({ id: 't'+team,
  matchKey: 'test_qm1', teamKey: 'frc'+team, scouter: 'Scout '+team, alliance: 'blue', position: team,
  segments: spans.map(([start, end]) => ({ action: 'shoot', start, end })),
  climb: 'none', confidence: 'high', timestamp: 1000 });
const log = (samples: number[][]): CvMatchLog => ({ matchKey:'test_qm1', eventKey:'test', source:'test', createdAt:1000,
  samples: samples.map(([sec, db]) => ({sec, db, dr:0, blue:0, red:0, phase: sec<=20?'auto':'teleop', videoSec:5000+sec})) });
const report = (rates = [2,1,1]): BpsReport => ({ results:[], byTeam:Object.fromEntries(rates.map((r,i)=>['frc'+(i+1),
  { teamKey:'frc'+(i+1), bps:r, autoBps:r, teleopBps:r, windows:1, scoringSeconds:10,passSeconds:0,passedFuel:0,passedFuelPerMatch:0 }])),
  windows:[{ matchKey:'test_qm1', alliance:'blue',start:0,length:160,phase:'teleop',teams:['frc1','frc2','frc3'],score:10,weight:1 }],
  lambda:0,timeShifts:{},diagnostics:{matches:1,teams:3,windowCount:1,orphanScore:0,droppedWindows:0} });
const near = (a:number,b:number) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);
test('isolated score changes map to shooting robot at match time, not video time',()=>{
  const a = buildScoreAttribution([tl(1,[[1,5]]),tl(2,[[10,15]]),tl(3)], [log([[3,9],[13,4]])],report());
  near(a.byRobot['test_qm1|frc1'].auto,9); near(a.byRobot['test_qm1|frc2'].auto,4);
  assert.deepEqual(a.samples.map(s=>s.sec),[3,13]);
});
test('red timelines use red deltas and never take the blue score',()=>{
  const ts=[tl(1,[[1,5]]),tl(2),tl(3)].map(t=>({...t,alliance:'red' as const}));
  const l=log([[3,99]]);l.samples[0].dr=7;
  const a=buildScoreAttribution(ts,[l],report());
  near(a.byRobot['test_qm1|frc1'].auto,7);assert.equal(a.samples[0].alliance,'red');
});
test('overlapping shooters split observed points using nonnegative fitted rates',()=>{
  const a=buildScoreAttribution([tl(1,[[10,15]]),tl(2,[[10,15]]),tl(3)],[log([[13,9]])],report());
  near(a.samples[0].teams.frc1,6);near(a.samples[0].teams.frc2,3);assert.equal(a.samples[0].ambiguous,true);
});
test('delayed scoreboard update still follows the recent shooter',()=>{
  const a=buildScoreAttribution([tl(1,[[1,5]]),tl(2),tl(3)],[log([[6,7]])],report());
  near(a.samples[0].teams.frc1,7);
});
test('delayed auto points remain auto through the scoring delay; teleop begins at 23',()=>{
  const a=buildScoreAttribution([tl(1,[[18,20],[23,28]]),tl(2),tl(3)],[log([[21,5],[25,7]])],report());
  near(a.byRobot['test_qm1|frc1'].auto,5);near(a.byRobot['test_qm1|frc1'].teleop,7);
});
test('unexplained score stays unassigned; no Gaussian tail invents a scorer',()=>{
  const a=buildScoreAttribution([tl(1,[[1,5]]),tl(2),tl(3)],[log([[90,30]])],report());
  near(a.samples[0].unassigned,30);assert.deepEqual(a.samples[0].teams,{});
});
test('missing or early-ended scouts do not inflate their teammates',()=>{
  for(const ts of [[tl(1,[[1,5]])],[tl(1,[[1,5]]),tl(2),{...tl(3),endedEarly:true}]]) {
    const a=buildScoreAttribution(ts,[log([[3,9]])],report());
    assert.equal(a.samples[0].reason,'incomplete scouting');assert.deepEqual(a.byRobot,{});
  }
});
test('wrong roster, wrong match and flagged captures cannot silently fuse',()=>{
  const ts=[tl(1,[[1,5]]),tl(2),tl(3)];
  assert.equal(buildScoreAttribution(ts,[{...log([[3,9]]),matchKey:'other_qm1'}],report()).samples.length,0);
  assert.equal(buildScoreAttribution(ts,[{...log([[3,9]]),flagged:true}],report()).samples.length,0);
  const matches:any=[{key:'test_qm1',alliances:{blue:{team_keys:['frc7','frc8','frc9']}}}];
  assert.deepEqual(buildScoreAttribution(ts,[log([[3,9]])],report(),matches).byRobot,{});
});
test('rejected/nonfinite/negative deltas never enter attribution',()=>{
  const l=log([[3,9],[4,-3],[5,NaN],[6,Infinity]]);l.samples[0].blueAccepted=false;
  assert.equal(buildScoreAttribution([tl(1,[[1,10]]),tl(2),tl(3)],[l],report()).samples.length,0);
});
test('per-scout alignment corrections apply before matching',()=>{
  const r=report();r.timeShifts.t1=4;
  const a=buildScoreAttribution([tl(1,[[1,3]]),tl(2),tl(3)],[log([[7,5]])],r);
  near(a.samples[0].teams.frc1,5);
});
test('every delta is conserved and confidence/latest dedup prevents double counting',()=>{
  const ts=[tl(1,[[1,5]]),{...tl(1,[[50,60]]),id:'old',confidence:'low' as const},tl(2,[[10,15]]),tl(3)];
  const a=buildScoreAttribution(ts,[log([[3,9],[13,4],[90,30]])],report());
  for(const s of a.samples) near(Object.values(s.teams).reduce((x,y)=>x+y,0)+s.unassigned,s.observed);
  near(a.byAlliance['test_qm1|blue'].observed,43);near(a.byAlliance['test_qm1|blue'].unassigned,30);
});
test('workspace uses observed allocations, not rate multiplied by duration',()=>{
  const ts=[tl(1,[[1,5]]),tl(2),tl(3)],r=report();r.attribution=buildScoreAttribution(ts,[log([[3,9]])],r);
  const p=buildMatchPoints(ts,r);assert.equal(p['test_qm1|frc1'].auto,9);
  assert.equal(p['test_qm1|frc1'].source,'scoreboard');
  const metrics=buildAllTeamMetrics([],['frc1','frc2','frc3'],[],ts,r,p);
  assert.equal(metrics[0].mean,9);
});
test('TBA anchoring cannot redistribute orphan points; robot climb added separately',()=>{
  const ts=[tl(1,[[1,5]]),tl(2),tl(3)],r=report();r.attribution=buildScoreAttribution(ts,[log([[3,9],[90,30]])],r);
  const p=buildMatchPoints(ts,r,{'test_qm1|blue':39},{test_qm1:{frc1:{auto:0,endgame:10}}});
  assert.equal(p['test_qm1|frc1'].nonClimb,9);assert.equal(p['test_qm1|frc1'].total,19);
});
test('fuzzy solver fits complete coverage and waits for incomplete coverage',()=>{
  const ts=[tl(1,[[1,5]]),tl(2),tl(3)],l=log([[2,2],[3,2],[4,2],[5,2]]);
  assert.ok(runFuzzyPipeline(ts,[l]).byTeam.frc1.bps>0);
  assert.equal(runFuzzyPipeline(ts.slice(0,1),[l]).windows.length,0);
});
function reset(){ local.clear();navigator.onLine=false;fake.request=async()=>({data:[],error:null}); }
function deferred(){ let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve}; }
test('offline timeline saves retry, and a second save during upload remains queued',async()=>{
  reset();saveTimeline(tl(1));navigator.onLine=true;
  const d=deferred();fake.request=()=>d.promise;
  const uploading=pushTimelines();saveTimeline(tl(2));d.resolve({error:null});await uploading;
  assert.deepEqual(JSON.parse(local.get('frc-bps-pending-timelines')!),['t2']);
  fake.request=async()=>({error:null});await pushTimelines();
  assert.deepEqual(JSON.parse(local.get('frc-bps-pending-timelines')!),[]);
});
test('editing the same timeline during upload cannot acknowledge its newer version',async()=>{
  reset();saveTimeline(tl(1));navigator.onLine=true;const d=deferred();fake.request=()=>d.promise;
  const uploading=pushTimelines();saveTimeline({...tl(1,[[1,5]]),timestamp:2000});d.resolve({error:null});await uploading;
  assert.deepEqual(JSON.parse(local.get('frc-bps-pending-timelines')!),['t1']);
});
test('cloud outage retains pending CV logs for retry',async()=>{
  reset();saveCvLog(log([[3,9]]));navigator.onLine=true;fake.request=async()=>({error:new Error('offline fixture')});
  assert.ok((await pushCvLogs()).error);assert.deepEqual(JSON.parse(local.get('frc-bps-pending-cv')!),['test_qm1']);
});
test('pull pagination loads a full event and preserves local-only rows',async()=>{
  reset();saveTimeline({...tl(99),matchKey:'other_qm1'});let calls=0;
  fake.request=async(r)=>{ calls++;return {data:r.from===0?Array.from({length:1000},(_,i)=>({id:'r'+i,match_key:'test_qm1',team_key:'frc1',timestamp:new Date(1000).toISOString()})):[{id:'last',match_key:'test_qm2',team_key:'frc2'}],error:null}; };
  await fetchTimelines('test');assert.equal(calls,2);assert.equal(getTimelines().length,1002);
  fake.request=async()=>({data:[],error:null});await fetchTimelines('test');assert.equal(getTimelines().length,1002);
});
test('cloud pull keeps unsynced local versions and worker local-only captures',async()=>{
  reset();saveTimeline(tl(1,[[1,5]]));saveCvLog(log([[3,9]]));
  fake.request=async(r)=>({data:r.table==='timeline_records'?[{id:'t1',match_key:'test_qm1',payload:{segments:[]}}]:[],error:null});
  await fetchTimelines('test');await fetchCvLogs('test');assert.equal(getTimelines()[0].segments.length,1);assert.equal(getCvLogs().length,1);
});
test('local worker logs join without cloud; unidentified captures are ignored',async()=>{
  reset();const l={...log([[3,9]]),quality:{score:0.9,flagged:false,reasons:[],signals:{}},video:{url:'https://example.test/video',timeBase:'youtube',greenFlagAt:5000}};
  const original=globalThis.fetch;
  globalThis.fetch=async(input:any)=>new Response(JSON.stringify(String(input).endsWith('/api/state')?{rows:[
    {match_key:'test_qm1',local_file:'capture.json',updated_at:new Date(2000).toISOString()},
    {match_key:'',local_file:'unidentified.json'}]}:l),{status:200});
  try {
    const rows=await fetchLocalWorkerLogs('test');assert.equal(rows.length,1);assert.equal(rows[0].samples[0].db,9);
    assert.equal(rows[0].video?.greenFlagAt,5000);
    assert.equal(parseCvJson(cvLogToJson(rows[0])).quality?.score,0.9);
  } finally { globalThis.fetch=original; }
});

test('simultaneous CV edit and upload preserves the new pending version',async()=>{
  reset();saveCvLog(log([[3,9]]));navigator.onLine=true;
  const d=deferred();fake.request=()=>d.promise;
  const uploading=pushCvLogs();saveCvLog(log([[3,12]]));d.resolve({error:null});await uploading;
  assert.deepEqual(JSON.parse(local.get('frc-bps-pending-cv')!),['test_qm1']);
});

test('offline asset cache never intercepts live worker APIs or log downloads',async()=>{
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const handlers: Record<string, (e:any)=>void> = {};
  runInNewContext(readFileSync('public/sw.js','utf8'), {
    URL, self: { location:{origin:'http://test'}, addEventListener:(name:string,fn:any)=>handlers[name]=fn },
  });
  let intercepted=0;
  for(const path of ['/api/state','/api/logs/capture.json','/logs/capture.json']) {
    handlers.fetch({request:{method:'GET',url:'http://test'+path},respondWith:()=>intercepted++});
  }
  assert.equal(intercepted,0);
});
