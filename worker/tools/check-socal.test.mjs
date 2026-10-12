import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { MatchClock, ScoreGate, parseTimerText, MATCH_LEN, detectScoreRegions, readFrame } from '../src/core.mjs';
import { liveFrames, retryDelay } from '../src/sources.mjs';
import { frames } from '../src/ffmpeg.mjs';
import { RingBuffer, GapLog, assembleAndProcess } from '../src/live.mjs';
import { eventQuads } from '../src/layouts.mjs';
import { createPool } from '../src/ocr.mjs';
import { supabaseHeaders } from '../src/supabase.mjs';

const read = (value, confidence = 96) => ({value, confidence, text: String(value ?? '')});
test('timer parsing rejects impossible values', () => {
  for (const [text, expected] of [['020',20],['220',140],['059',59],['00',0],['260',null],['999',null],['abc',null]]) assert.equal(parseTimerText(text),expected);
});
test('clock freezes before a ticking match, aligns start, transitions, and corroborates end', () => {
  const c = new MatchClock();
  c.feed(20,100); c.feed(20,101); assert.equal(c.state.started,false);
  c.feed(19,102); assert.equal(c.greenFlagAt,101);
  c.feed(0,121); c.feed(140,124); assert.equal(c.state.phase,'auto');
  c.feed(139,125); assert.equal(c.state.phase,'teleop');
  assert.equal(c.elapsedAt(125),24);
  c.feed(2,262); c.feed(1,263); c.feed(0,264); assert.equal(c.state.ended,false);
  c.feed(0,265); assert.equal(c.state.ended,true); assert.equal(c.elapsedAt(270),MATCH_LEN);
});
test('phase changes require consistent distinct frames; invalid times cannot poison clock', () => {
  const c=new MatchClock(); c.feed(20,10);c.feed(19,11);
  c.feed(100,12);c.feed(140,13);assert.equal(c.state.phase,'auto');
  c.feed(139,13); assert.equal(c.state.phase,'auto');
  c.feed(NaN,14);c.feed(138,15); assert.equal(c.state.phase,'auto');
  c.feed(137,16);assert.equal(c.state.phase,'teleop');
});
test('score resync needs consecutive high confidence evidence', () => {
  const g=new ScoreGate(10);
  for(let i=0;i<5;i++)g.feed(read(500,1)); assert.equal(g.value,10);
  g.feed(read(200));g.feed(read(null));g.feed(read(201));g.feed(read(202)); assert.equal(g.value,10);
  g.feed(read(203));assert.equal(g.value,203);
  for(const v of [NaN,Infinity,1.5,-1,2])g.feed(read(v)); assert.equal(g.value,203);
});
test('YouTube media positions ignore delivery latency and include the whole reconnect gap', async () => {
  let attempt=0;const gaps=[];const retries=[];const controller=new AbortController();
  async function* attemptSource(){
    if(attempt++===0){yield {at:100};await delay(15);yield {at:101};throw new Error('disconnect');}
    yield {at:100};yield {at:101};yield {at:108};yield {at:109};
  }
  const seen=[];
  for await(const f of liveFrames('https://youtube.com/watch?v=test',{format:{},attemptSource,signal:controller.signal,retryDelay:async()=>{},onGap:g=>gaps.push(g),onReconnecting:r=>retries.push(r)})){
    seen.push(f.at);if(seen.length===4)controller.abort();
  }
  assert.deepEqual(seen,[100,101,108,109]);assert.deepEqual(gaps,[{start:101,seconds:7}]);assert.equal(retries[0].afterMs,1000);
});
test('failures back off and abort without a frame', async () => {
  const controller=new AbortController();const waits=[];
  async function* attemptSource(){throw new Error('offline');}
  for await (const f of liveFrames('https://youtube.com/watch?v=test',{format:{},attemptSource,signal:controller.signal,retryDelay:async ms=>{waits.push(ms);if(waits.length===4)controller.abort();}})) assert.fail('unexpected frame');
  assert.deepEqual(waits,[1000,2000,4000,8000]);
  const c=new AbortController();const p=retryDelay(30000,c.signal);c.abort();await p;
});

const syntheticPool={async *ordered(source){for await (const f of source)yield f.read;}};
function observation(at,t0){
  const elapsed=at-t0;
  const rem=elapsed<0?20:elapsed<=20?20-elapsed:elapsed<23?0:Math.max(0,163-elapsed);
  return {at,read:{at,overlayPresent:true,blueRaw:read(elapsed<0?600:Math.min(100,Math.max(0,elapsed))),redRaw:read(elapsed<0?700:Math.min(80,Math.max(0,elapsed))),timer:{remaining:rem,text:String(rem),confidence:96}}};
}
test('two match windows preserve shared stream, timestamps, and reset pregame scores',async()=>{
  let closed=false;
  async function* input(){try {for(let at=80;at<700;at++)yield observation(at,at<400?100:450);}finally{closed=true;}}
  const source=input(),ring=new RingBuffer(40),gaps=new GapLog();
  for(const t0 of [100,450]){
    for(;;){const {value:f}=await source.next();ring.push(f);if(f.at>=t0+2)break;}
    const result=await assembleAndProcess({source,ring,gaps,t0,windowFrom:t0-20,windowTo:t0+238,pool:syntheticPool,quads:{},log:()=>{}});
    assert.notEqual(result,'gap');assert.equal(closed,false);
    assert.equal(result.samples.at(-1).blue,100);assert.equal(result.samples.at(-1).red,80);
    const s=result.samples.find(s=>s.sec===50);assert.equal(s.videoSec,t0+50);
    assert.equal(result.diagnostics.greenFlagAt,t0);assert.ok(result.teamShots.length>=3);
  }
  await source.return();assert.equal(closed,true);
});
test('gap inside an active match rejects the entire window without closing shared source',async()=>{
  const gaps=new GapLog();let closed=false;
  async function* input(){try{for(let at=100;at<350;at++){if(at===120){gaps.record({start:119,seconds:8});at=127;}yield observation(at,100);}}finally{closed=true;}}
  const source=input();const result=await assembleAndProcess({source,ring:new RingBuffer(40),gaps,t0:100,windowFrom:80,windowTo:338,pool:syntheticPool,quads:{},log:()=>{}});
  assert.equal(result,'gap');assert.equal(closed,false);await source.return();
});
test('truncated or cancelled windows cannot produce successful matches',async()=>{
  async function* input(){for(let at=100;at<130;at++)yield observation(at,100);}
  const opts={ring:new RingBuffer(40),gaps:new GapLog(),t0:100,windowFrom:80,windowTo:338,pool:syntheticPool,quads:{},log:()=>{}};
  assert.equal(await assembleAndProcess({...opts,source:input()}),'gap');
  const c=new AbortController();c.abort();assert.equal(await assembleAndProcess({...opts,source:input(),signal:c.signal}),'aborted');
});
test('ffmpeg media timestamps survive slow consumers and start at their actual offset',async()=>{
  // A tiny generated stream with a deliberately nonzero presentation time.
  const input=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=32x32:r=1:d=4','-vf','setpts=PTS+123/TB','-c:v','mpeg2video','-f','mpegts','-']);
  const {Readable}=await import('node:stream');const times=[];
  for await(const f of frames('-',{stdin:Readable.from(input),width:32,height:32,preservePts:true})){times.push(f.at);await delay(10);}
  assert.equal(times.length,4);assert.ok(times[0]>=123);assert.deepEqual(times.map(t=>t-times[0]),[0,1,2,3]);
});
test('ffmpeg cancellation works while blocked waiting for input',async()=>{
  const {PassThrough}=await import('node:stream');const stdin=new PassThrough(),c=new AbortController();
  const timer=setTimeout(()=>c.abort(),100);
  try{for await(const f of frames('-',{stdin,width:32,height:32,signal:c.signal}))assert.fail('unexpected frame');}finally{clearTimeout(timer);stdin.destroy();}
});
test('modern publishable keys are not sent as JWTs',()=>{
  assert.deepEqual(supabaseHeaders('sb_publishable_test'),{apikey:'sb_publishable_test'});
  assert.equal(supabaseHeaders('legacy.jwt.value').Authorization,'Bearer legacy.jwt.value');
});
test('real SoCal scoreboard: correct alliance orientation, zero scores, 0:20',async()=>{
  const data=execFileSync('ffmpeg',['-v','error','-i','worker/tools/fixtures/socal-pregame.png','-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:12e6});
  const frame={data,width:1920,height:1080};const q=detectScoreRegions(frame);assert.ok(q);assert.ok(q.red[0].x<q.blue[0].x);
  const pool=await createPool(1);try{const r=await pool.run(w=>readFrame(w,frame,q.blue,q.red,q.timer,new ScoreGate(),new ScoreGate()));assert.equal(r.overlayPresent,true);assert.equal(r.blueRaw.value,0);assert.equal(r.redRaw.value,0);assert.equal(r.timer.remaining,20);}finally{await pool.terminate();}
});

test('real SoCal teleop totals and timer at 1080p and 720p',async()=>{
  const pool=await createPool(1);
  try {
    for(const width of [1920,1280]) {
      const height=width*9/16;
      const data=execFileSync('ffmpeg',['-v','error','-i','worker/tools/fixtures/socal-teleop.png','-vf','scale='+width+':'+height,'-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:12e6});
      const frame={data,width,height},q=eventQuads('2026cass');
      const r=await pool.run(w=>readFrame(w,frame,q.blue,q.red,q.timer,new ScoreGate(),new ScoreGate()));
      assert.equal(r.overlayPresent,true);assert.equal(r.blueRaw.value,188);assert.equal(r.redRaw.value,147);assert.equal(r.timer.remaining,101);
    }
  } finally {await pool.terminate();}
});
test('ring retains the current fractional-PTS frame in preroll',()=>{
  const ring=new RingBuffer(40);ring.push({at:100.533});ring.push({at:101.533});
  assert.deepEqual(ring.slice(100,101.533).map(f=>f.at),[100.533,101.533]);assert.equal(ring.oldestAt(),100.533);
});
test('raw decoder does not manufacture observations across a timestamp gap',async()=>{
  const input=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=32x32:r=1:d=4','-vf','setpts=PTS+gte(N\\,2)*8/TB','-c:v','mpeg2video','-f','mpegts','-']);
  const {Readable}=await import('node:stream');const times=[];
  for await(const f of frames('-',{stdin:Readable.from(input),width:32,height:32,preservePts:true}))times.push(f.at);
  assert.equal(times.length,4);assert.ok(times[2]-times[1]>=8);
});
