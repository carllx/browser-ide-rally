// Architecture audit artifact: assertions reproduce known defects at be4f02c.
// This is not an acceptance suite; corrected code is expected to invalidate these assertions.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const {GenerationStore} = await import(root+'/src/tampermonkey/generation-store.js');
const {CompletionResolver} = await import(root+'/src/tampermonkey/completion-resolver.js');
const {MetricsCollector} = await import(root+'/src/tampermonkey/metrics.js');
const {NetworkDetector} = await import(root+'/src/tampermonkey/network-detector.js');
const {DomDetector} = await import(root+'/src/tampermonkey/dom-detector.js');
const {PrimaryClassifier} = await import(root+'/src/tampermonkey/primary-classifier.js');
const {EventBus} = await import(root+'/src/tampermonkey/event-bus.js');
const pause = ms=>new Promise(r=>setTimeout(r,ms));
function setup() {
 const store=new GenerationStore(), metrics=new MetricsCollector(), bus=new EventBus('review');
 bus.bc?.close(); bus.bc=null;
 bus.on('any_event',e=>metrics.recordEvent(e));
 const resolver=new CompletionResolver(bus,store,metrics);
 const net=new NetworkDetector(store,resolver,metrics);
 return {store,metrics,bus,resolver,net};
}
const wire=frames=>new Response(frames.map(f=>'data: '+(typeof f==='string'?f:JSON.stringify(f))+'\n\n').join(''));
const msg=(cid,mid)=>({conversation_id:cid,message:{id:mid,author:{role:'assistant'}}});
{
 const s=setup();
 await s.net.inspectStream(wire([msg('conv-A','assistant-A'),'[DONE]']));
 await pause(450);
 const session=s.store.getActiveSession(); session.stopSeenForGeneration=true;
 const dom=Object.create(DomDetector.prototype); Object.assign(dom,{store:s.store,resolver:s.resolver,findStopControl:()=>null});
 dom.handleMutations();
 assert.equal(session.evidenceConfidence,'network_only');
 await s.net.inspectStream(wire([msg('conv-B','assistant-B'),'[DONE]']));
 await pause(450);
 assert.equal(s.store.getAllSessions().length,1);
 assert.equal(s.bus.getPublicEvents().filter(e=>e.event==='response.completed').length,1);
 console.log('REPRO 1: late DOM ignored; second distinct generation swallowed; stored identity='+session.conversationId+'/'+session.messageId);
}
{
 const s=setup();
 await s.net.inspectStream(wire([{conversation_id:'conv-A'},{message:{id:'assistant-A',author:{role:'assistant'}}},'[DONE]']));
 await pause(450);
 assert.equal(s.store.getAllSessions()[0].conversationId,null);
 console.log('REPRO 2: conversation_id from earlier chunk lost at primary admission');
}
{
 const bad=PrimaryClassifier.extractAssistantMessageId({p:'/tool/id',v:'tool-id-12345678901234567890'});
 assert.ok(bad);
 const classification=PrimaryClassifier.evaluateStreamClass({hasConversationId:true,assistantMessageId:null,meaningfulDeltaCount:2,totalChunksCount:2});
 console.log('REPRO 3: tool patch accepted as assistant ID; arbitrary v strings can admit '+classification);
}
{
 const s=setup();
 for(let i=0;i<6;i++)s.metrics.recordEvent({event:'response.completed',confidence:'dom_only'});
 s.metrics.recordEvent({event:'response.interrupted'});
 const report=s.metrics.getReport(s.store,s.bus,'test','review');
 assert.equal(report.gate_status.pass_normal_gate,true);
 assert.equal(report.gate_status.generic_interruption_status,'VALIDATED_IN_SESSION');
 console.log('REPRO 4: six unverified synthetic completions PASS gate; emitted interruption self-validates');
}
{
 const s=setup(); const session=s.store.createSession('conv-A');
 session.domUiCompleted=true; session.userStopActionSeen=true;
 s.resolver.onDomUiCompleted(session);
 await pause(450);
 s.resolver.onStreamClosedWithoutDone(session);
 assert.equal(session.terminalEventType,'response.completed');
 console.log('REPRO 5: Stop + DOM disappearance >400ms before reader closure becomes completed');
}
{
 const s=setup();
 await s.net.inspectStream(wire([{type:'stream_handoff'},{p:'/conversation_id',v:'conv-A'},{p:'/message/id',v:'assistant-12345678901234567890'},'[DONE]']));
 assert.equal(s.store.getAllSessions().length,0);
 assert.equal(s.metrics.counters.auxiliary_streams_ignored,1);
 console.log('REPRO 6: unsupported compact/handoff stream silently counted as auxiliary');
}
